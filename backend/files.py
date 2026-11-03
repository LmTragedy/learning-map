import hashlib
import shutil
from pathlib import Path

from .documents import MAX_FILE_BYTES, parse_document, render_page
from .store import identity

MAX_UPLOAD = MAX_FILE_BYTES  # one limit: a copy that passes here must also pass the parser
# What the app accepts is a product choice, narrower than what documents.py can parse.
# The answer picker (PracticePanel.tsx) lists the same suffixes; the material picker offers PDF first.
ALLOWED = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md"}


def copy_upload(upload, directory):
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in ALLOWED:
        raise ValueError("只支持 PDF、PNG、JPG、WebP、TXT 和 Markdown")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("original" + suffix)
    digest, total = hashlib.sha256(), 0
    with target.open("xb") as copied:
        while chunk := upload.file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD:
                raise ValueError(f"单个文件不能超过 {MAX_UPLOAD // (1024 * 1024)} MB")
            digest.update(chunk)
            copied.write(chunk)
    if total == 0:
        raise ValueError("无法导入空文件")
    return target, digest.hexdigest()


def import_uploads(store, course_id, uploads, options):
    if len(uploads) > 10:
        raise ValueError("一次最多导入 10 份材料")
    root = store.root / "courses" / course_id
    materials = []
    for upload in uploads:
        material_id = identity()
        directory = root / "materials" / material_id
        try:
            original, digest = copy_upload(upload, directory)
            parsed = parse_document(original, directory / "pages", options["parser"])
        except Exception:
            _remove_material_dir(root, directory)
            discard_materials(store, course_id, materials)
            raise
        materials.append(
            dict(
                id=material_id, name=Path(upload.filename).name, week=options["week"], sha256=digest, **parsed
            )
        )
    return materials


def _remove_material_dir(root, directory):
    if directory.resolve().is_relative_to(root.resolve()) and directory.exists():
        shutil.rmtree(directory, ignore_errors=True)


def discard_materials(store, course_id, materials):
    """Delete copies that were imported but never committed to the course (failure or duplicate)."""
    root = store.root / "courses" / course_id
    for material in materials:
        _remove_material_dir(root, root / "materials" / material["id"])


def material_by_id(course, material_id):
    candidates = list(course["materials"])
    for node in course["nodes"]:
        for attempt in node["attempts"]:
            candidates.extend(attempt.get("attachments", []))
    for material in candidates:
        if material["id"] == material_id:
            return material
    raise KeyError("材料不存在")


def material_original(store, course_id, material_id):
    directory = store.root / "courses" / course_id / "materials" / material_id
    matches = list(directory.glob("original.*"))
    if not matches:
        raise KeyError("材料副本不存在")
    return matches[0]


def material_page(store, course, material_id, page_number):
    material = material_by_id(course, material_id)
    if not 1 <= page_number <= len(material["pages"]):
        raise KeyError("页码不存在")
    original = material_original(store, course["id"], material_id)
    output = original.parent / "preview" / f"{page_number}.png"
    if not output.exists():
        output.parent.mkdir(exist_ok=True)
        render_page(original, page_number, output)
    return output


def answer_images(store, course, attachments):
    pages = [
        (material["id"], page["number"])
        for material in attachments
        if material["kind"] in {"pdf", "image"}
        for page in material["pages"]
    ]
    if len(pages) > 6:
        raise ValueError("一次纸上作答最多 6 页，以便逐页核对；未静默忽略其他页")
    # Attachments are not committed yet; resolve their immutable files directly.
    images = []
    for material_id, page_number in pages:
        original = material_original(store, course["id"], material_id)
        preview = original.parent / "preview" / f"{page_number}.png"
        preview.parent.mkdir(exist_ok=True)
        render_page(original, page_number, preview)
        images.append(preview)
    return images
