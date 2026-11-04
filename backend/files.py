import hashlib
import shutil
import tempfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PyPdfError

from .documents import MAX_FILE_BYTES, MAX_PDF_PAGES, parse_document, render_page
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


MAX_SPLIT_PARTS = 10


def _pdf_parts(original):
    """Page ranges for a PDF longer than the parser's page limit; None when it fits (or cannot be read here)."""
    if original.suffix.lower() != ".pdf":
        return None
    try:
        reader = PdfReader(original, strict=True)
        if reader.is_encrypted:
            return None
        count = len(reader.pages)
    except (PyPdfError, OSError, ValueError):
        return None  # the parser reports the real problem
    if count <= MAX_PDF_PAGES:
        return None
    if count > MAX_PDF_PAGES * MAX_SPLIT_PARTS:
        raise ValueError(f"PDF 有 {count} 页，超过自动拆分上限 {MAX_PDF_PAGES * MAX_SPLIT_PARTS} 页；请先拆成几份再导入")
    return reader, [(start + 1, min(start + MAX_PDF_PAGES, count)) for start in range(0, count, MAX_PDF_PAGES)]


def _write_part(reader, first, last, target):
    writer = PdfWriter()
    for index in range(first - 1, last):
        writer.add_page(reader.pages[index])
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        writer.write(handle)


def import_uploads(store, course_id, uploads, options):
    if len(uploads) > 10:
        raise ValueError("一次最多导入 10 份材料")
    root = store.root / "courses" / course_id
    materials = []
    for upload in uploads:
        material_id = identity()
        directory = root / "materials" / material_id
        name = Path(upload.filename).name
        try:
            original, digest = copy_upload(upload, directory)
            split = _pdf_parts(original)
            if split is None:
                parsed = parse_document(original, directory / "pages", options["parser"])
                materials.append(dict(id=material_id, name=name, week=options["week"], sha256=digest,
                                      parser=options["parser"], **parsed))
                continue
            # A long PDF becomes one material per page range, each with its own copy; the user's file is untouched.
            reader, parts = split
            for first, last in parts:
                part_id = identity()
                part_dir = root / "materials" / part_id
                _write_part(reader, first, last, part_dir / "original.pdf")
                # Written PDFs carry fresh IDs; the source digest plus range is what makes a re-import a duplicate.
                part_digest = hashlib.sha256(f"{digest}:{first}-{last}".encode()).hexdigest()
                materials.append(dict(id=part_id, name=f"{name}（第 {first}–{last} 页）", week=options["week"],
                                      sha256=part_digest, parser=options["parser"], split_from=dict(name=name, first_page=first, last_page=last),
                                      **parse_document(part_dir / "original.pdf", part_dir / "pages", options["parser"])))
            _remove_material_dir(root, directory)
        except Exception:
            _remove_material_dir(root, directory)
            discard_materials(store, course_id, materials)
            raise
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


def course_material(course, material_id):
    """A material of the course itself (not a paper-answer attachment)."""
    for material in course["materials"]:
        if material["id"] == material_id:
            return material
    raise KeyError("材料不存在")


def reparse_original(store, course_id, material_id, parser):
    """Parse the saved original again; nothing on disk or in the course changes here."""
    original = material_original(store, course_id, material_id)
    with tempfile.TemporaryDirectory(dir=original.parent, prefix="reparse-") as scratch:
        return parse_document(original, Path(scratch), parser)


def apply_reparse(material, parsed, parser):
    """Swap in the new text, keeping id, file and page numbers so every cited page stays valid."""
    if parsed["kind"] != material["kind"] or len(parsed["pages"]) != len(material["pages"]):
        raise ValueError("重新解析得到的页数与原材料不一致，未替换")
    material.update(pages=parsed["pages"], warnings=parsed["warnings"], parser=parser)


def update_material_info(material, name=None, week=None):
    if name is not None:
        name = name.strip()
        if not name or "/" in name or "\\" in name or name in {".", ".."}:
            raise ValueError("文件名不能为空，也不能包含路径分隔符")
        material["name"] = name
    if week is not None:
        material["week"] = week.strip()


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
