"""User-reviewed relationship operations within the existing course aggregate."""

from .domain import project_course
from .relations import create_synthesis_node
from .schemas import RelationConfirm, RelationEdit, RelationPresentation


def _relation(course, relation_id):
    for edge in course.get("edges", []):
        if edge.get("id") == relation_id:
            canonical_id = edge.get("origin_relation_id") if edge.get("synthesis_link") else relation_id
            break
    else:
        raise KeyError("知识联系不存在")
    for edge in course.get("edges", []):
        if edge.get("id") == canonical_id:
            return edge
    raise KeyError("知识联系不存在")


def register_relation_routes(app, store):
    @app.post("/api/courses/{cid}/relations/{rid}/presentation")
    def set_presentation(cid: str, rid: str, request: RelationPresentation):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑知识联系前自动备份", connection)
            edge = _relation(course, rid)
            if request.presentation == "synthesis":
                create_synthesis_node(course, edge)
            edge["presentation"] = request.presentation
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/relations/{rid}/confirm")
    def confirm(cid: str, rid: str, request: RelationConfirm):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑知识联系前自动备份", connection)
            _relation(course, rid)["confirmed"] = True
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/relations/{rid}")
    def edit_relation(cid: str, rid: str, request: RelationEdit):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑知识联系前自动备份", connection)
            edge = _relation(course, rid)
            for key in (
                "relation", "explanation", "when_to_use", "basis", "forward_difficulty", "reverse_difficulty"
            ):
                edge[key] = getattr(request, key)
            edge["confirmed"] = False
        return project_course(store.course(cid))
