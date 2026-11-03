"""User-reviewed relationship operations within the existing course aggregate."""

from .bridges import BridgeEdit, CheckResult, PiecesEdit, record_check, set_bridges, set_pieces
from .domain import find_node, project_course
from .relations import create_synthesis_node
from .schemas import RelationConfirm, RelationEdit, RelationPresentation
from .store import timestamp


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
    @app.post("/api/courses/{cid}/nodes/{nid}/pieces/{pid}/check")
    def check_piece(cid: str, nid: str, pid: str, request: CheckResult):
        with store.edit(cid) as (course, _):
            node = find_node(course, nid)
            if not any(piece["id"] == pid for piece in node.get("pieces", [])):
                raise KeyError("知识块不存在")
            course.setdefault("piece_checks", {})[pid] = dict(
                result=request.result, at=timestamp(), via="check", answer=request.answer.strip(),
            )
        return project_course(store.course(cid))

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

    @app.put("/api/courses/{cid}/relations/{rid}/bridges")
    def edit_bridges(cid: str, rid: str, request: BridgeEdit):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑知识桥前自动备份", connection)
            set_bridges(course, _relation(course, rid)["id"], request.model_dump()["bridges"])
        return project_course(store.course(cid))

    @app.put("/api/courses/{cid}/nodes/{nid}/pieces")
    def edit_pieces(cid: str, nid: str, request: PiecesEdit):
        with store.edit(cid, expected=request.revision) as (course, connection):
            store.snapshot(course, "编辑知识块前自动备份", connection)
            payload = request.model_dump()
            set_pieces(course, find_node(course, nid), payload["pieces"], payload["steps"])
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/relations/{rid}/bridges/{bid}/check")
    def check_bridge(cid: str, rid: str, bid: str, request: CheckResult):
        # A self-check is a learning record, not an edit: no revision pin and no backup.
        with store.edit(cid) as (course, _):
            record_check(course, _relation(course, rid)["id"], bid, request.result, request.answer)
        return project_course(store.course(cid))
