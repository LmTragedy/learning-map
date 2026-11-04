"""HTTP endpoints for preparing and removing a node's teaching plan."""

from pydantic import Field

from ..schemas import Input
from .planner import delete_plan, prepare_plan


class PlanRequest(Input):
    request_id: str | None = Field(default=None, min_length=16, max_length=80, pattern=r"^[a-zA-Z0-9-]+$")


class PlanDelete(Input):
    revision: int = Field(ge=0)


def register_teaching_plan_routes(app, store, learning):
    @app.post("/api/courses/{cid}/nodes/{nid}/teaching-plan")
    def prepare(cid: str, nid: str, request: PlanRequest):
        return prepare_plan(store, learning, cid, nid, request.request_id)

    @app.post("/api/courses/{cid}/nodes/{nid}/teaching-plan/delete")
    def remove(cid: str, nid: str, request: PlanDelete):
        return delete_plan(store, cid, nid, request.revision)
