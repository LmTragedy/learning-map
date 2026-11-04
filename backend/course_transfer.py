"""Course backup files (.zip) and the local recycle area: export, import as a new course, restore deleted."""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path, PurePosixPath

from .store import identity, timestamp

FORMAT = "learning-map-course"
VERSION = 1
MAX_IMPORT_BYTES = 1024 * 1024 * 1024  # uncompressed total; a course is mostly its PDFs
MAX_IMPORT_FILES = 20_000


def _course_dir(store, course_id) -> Path:
    return store.root / "courses" / course_id


def export_course(store, course_id) -> tuple[str, bytes]:
    """One zip: manifest, the course record, and every file under the course folder (materials, problem sets)."""
    course = store.course(course_id)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(
            dict(format=FORMAT, version=VERSION, exported_at=timestamp(), title=course["title"]), ensure_ascii=False))
        archive.writestr("course.json", json.dumps(course, ensure_ascii=False))
        root = _course_dir(store, course_id)
        if root.exists():
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    archive.write(path, "files/" + path.relative_to(root).as_posix())
    return course["title"], buffer.getvalue()


def _safe_member(name: str) -> PurePosixPath | None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError("备份文件里有不安全的路径，未导入")
    if path.parts[:1] != ("files",) or len(path.parts) < 2:
        return None
    return PurePosixPath(*path.parts[1:])


def _free_title(store, title: str, label: str = "导入") -> str:
    taken = {course["title"].casefold() for course in store.list_courses()}
    if title.casefold() not in taken:
        return title
    for number in range(2, 100):
        candidate = f"{title}（{label} {number}）" if number > 2 else f"{title}（{label}）"
        if candidate.casefold() not in taken:
            return candidate
    raise ValueError("同名课程太多，请先改名再导入")


def _fresh_course(course: dict, new_id: str, title: str) -> dict:
    """A copy that starts its own history: new id, revision 0, no links to Codex threads of the old machine."""
    course = dict(course, id=new_id, title=title, revision=0, imported_at=timestamp())
    for node in course.get("nodes", []):
        node["thread_id"] = None
        node["review_threads"] = {}
    return course


def import_course(store, data: bytes) -> dict:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("不是有效的课程备份文件（.zip）") from exc
    with archive:
        try:
            manifest = json.loads(archive.read("manifest.json"))
            course = json.loads(archive.read("course.json"))
        except (KeyError, ValueError) as exc:
            raise ValueError("备份文件缺少课程记录，可能不是本软件导出的") from exc
        if manifest.get("format") != FORMAT or not isinstance(manifest.get("version"), int) or manifest["version"] > VERSION:
            raise ValueError("备份文件格式不认识，可能来自更新版本的软件")
        if not isinstance(course, dict) or not isinstance(course.get("title"), str):
            raise ValueError("备份里的课程记录不完整")
        members = [(info, _safe_member(info.filename)) for info in archive.infolist() if not info.is_dir()]
        files = [(info, path) for info, path in members if path is not None]
        if len(files) > MAX_IMPORT_FILES or sum(info.file_size for info, _ in files) > MAX_IMPORT_BYTES:
            raise ValueError("备份文件过大，未导入")
        new_id = identity()
        root = _course_dir(store, new_id)
        try:
            for info, path in files:
                target = root.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as copied:
                    shutil.copyfileobj(source, copied)
            fresh = _fresh_course(course, new_id, _free_title(store, course["title"]))
            store.insert_course(fresh, "从备份文件导入")
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise
    return store.course(new_id)


def deleted_courses(store) -> list[dict]:
    return store.deleted_courses()


def restore_course(store, course_id) -> dict:
    return store.restore_deleted(course_id, lambda title: _free_title(store, title, "恢复"))
