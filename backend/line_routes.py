"""User edits of main lines; generation, retelling and the course overview are added alongside."""

from .domain import project_course
from .lines import LineEdit, LineInput, LineRevision, anchored_line_ids, find_line, new_line, save_line


def _deletable_line(course, line_id):
    line = find_line(course, line_id)
    if line_id in anchored_line_ids(course):
        raise ValueError("这条主线仍有锚点笔记，请先解绑笔记再删除")
    return line


def _register_line_writes(app, store):
    @app.post("/api/courses/{cid}/lines")
    def create_line(cid: str, request: LineInput):
        with store.edit(cid) as (course, connection):
            store.snapshot(course, "编辑主线前自动备份", connection)
            new_line(course, request.model_dump())
        return project_course(store.course(cid))

    @app.put("/api/courses/{cid}/lines/{lid}")
    def edit_line(cid: str, lid: str, request: LineEdit):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑主线前自动备份", connection)
            save_line(course, lid, request.model_dump())
        return project_course(store.course(cid))


def _register_line_deletion(app, store):
    @app.post("/api/courses/{cid}/lines/{lid}/delete")
    def delete_line(cid: str, lid: str, request: LineRevision):
        with store.edit(cid, expected=request.revision) as (course, connection):
            line = _deletable_line(course, lid)
            store.snapshot(course, "删除主线前自动备份", connection)
            course["lines"].remove(line)
        return project_course(store.course(cid))


def register_line_routes(app, store):
    _register_line_writes(app, store)
    _register_line_deletion(app, store)
