from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .domain import find_node, project_course
from .store import Conflict, identity, timestamp


class NoteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(max_length=100000)
    expected: str = Field(max_length=100000)
    title: str | None = Field(default=None, max_length=200)


class NoteAnchor(BaseModel):
    """Where a note hangs besides its nodes: a knowledge bridge (relationship) or a main line."""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["bridge", "line"]
    id: str = Field(min_length=1, max_length=100)


class ExtraNoteInput(BaseModel):
    """A named note of its own, bound to knowledge nodes and optionally to a bridge or a line."""
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)
    node_ids: list[str] = Field(min_length=1, max_length=20)
    content: str = Field(default="", max_length=100000)
    anchor: NoteAnchor | None = None


class ExtraNoteUpdate(ExtraNoteInput):
    expected: str = Field(max_length=100000)


def _clean(request, course):
    title = request.title.strip()
    if not title:
        raise ValueError("笔记名称不能为空")
    node_ids = list(dict.fromkeys(request.node_ids))
    for node_id in node_ids:
        find_node(course, node_id)
    anchor = request.anchor
    if anchor and anchor.kind == "bridge" and not any(
        edge.get("id") == anchor.id and not edge.get("synthesis_link") for edge in course.get("edges", [])
    ):
        raise KeyError("笔记要挂的知识联系不存在")
    if anchor and anchor.kind == "line" and not any(line["id"] == anchor.id for line in course.get("lines", [])):
        raise KeyError("笔记要挂的主线不存在")
    return title, node_ids


NOTE_BACKUP = '笔记保存前自动备份'
NOTE_BACKUP_INTERVAL = timedelta(minutes=10)


def _note_backup(store, course, connection):
    """Autosave writes often; back up at most once per interval so other backups are not pruned away."""
    row = connection.execute(
        "SELECT reason, created_at FROM versions WHERE course_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (course['id'],),
    ).fetchone()
    if row and row[0] == NOTE_BACKUP:
        try:
            if datetime.fromisoformat(timestamp()) - datetime.fromisoformat(row[1]) < NOTE_BACKUP_INTERVAL:
                return
        except ValueError:
            pass
    store.snapshot(course, NOTE_BACKUP, connection)


def _note(course, note_id):
    for note in course.get("notes", []):
        if note["id"] == note_id:
            return note
    raise KeyError("笔记不存在")


def register_goals_notes(app, store):
    @app.put('/api/courses/{cid}/nodes/{nid}/personal-note')
    def save_personal_note(cid: str, nid: str, request: NoteInput):
        with store.edit(cid) as (course, connection):
            node = find_node(course, nid)
            if node.get('personal_note', '') != request.expected:
                raise Conflict('笔记已在其他位置修改；草稿已保留，请读取最新已保存版本并核对后再保存。')
            _note_backup(store, course, connection)
            node['personal_note'] = request.content
            if request.title is not None:
                node['personal_note_title'] = request.title.strip()
        return project_course(store.course(cid))

    @app.post('/api/courses/{cid}/notes')
    def create_note(cid: str, request: ExtraNoteInput):
        with store.edit(cid) as (course, connection):
            title, node_ids = _clean(request, course)
            store.snapshot(course, '新建笔记前自动备份', connection)
            now = timestamp()
            course.setdefault('notes', []).append(dict(
                id=identity(), title=title, node_ids=node_ids, content=request.content,
                created_at=now, updated_at=now,
                **({'anchor': request.anchor.model_dump()} if request.anchor else {}),
            ))
        return project_course(store.course(cid))

    @app.put('/api/courses/{cid}/notes/{note_id}')
    def update_note(cid: str, note_id: str, request: ExtraNoteUpdate):
        with store.edit(cid) as (course, connection):
            note = _note(course, note_id)
            if note['content'] != request.expected:
                raise Conflict('笔记已在其他位置修改；草稿已保留，请读取最新已保存版本并核对后再保存。')
            title, node_ids = _clean(request, course)
            _note_backup(store, course, connection)
            note.update(title=title, node_ids=node_ids, content=request.content, updated_at=timestamp())
            if request.anchor:
                note['anchor'] = request.anchor.model_dump()
        return project_course(store.course(cid))

    @app.delete('/api/courses/{cid}/notes/{note_id}')
    def delete_note(cid: str, note_id: str):
        with store.edit(cid) as (course, connection):
            note = _note(course, note_id)
            # The backup keeps the deleted note recoverable from version history.
            store.snapshot(course, '删除笔记前自动备份', connection)
            course['notes'].remove(note)
        return project_course(store.course(cid))
