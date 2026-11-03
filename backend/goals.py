from typing import Annotated, Literal

from pydantic import Field, model_validator

from .schemas import Input, Source
from .store import identity, timestamp


class Subgoal(Input):
    id: str = Field(default="", max_length=100)
    title: str = Field(min_length=1, max_length=200)
    done: bool = False
    # Optional knowledge node whose verification completes this subgoal automatically.
    node_id: str = Field(default="", max_length=100)
    # Projected on read; clients may echo it back, but it is never stored.
    auto_done: bool = Field(default=False, exclude=True)


class GoalInput(Input):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    kind: Literal["course", "personal"] = "course"
    status: Literal["todo", "doing", "done"] = "todo"
    node_ids: list[str] = Field(default_factory=list, max_length=100)
    subtasks: list[Subgoal] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def require_titles(self):
        self.title = self.title.strip()
        if not self.title or any(not task.title.strip() for task in self.subtasks):
            raise ValueError("目标和小目标名称不能为空")
        task_ids = [task.id for task in self.subtasks if task.id]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("小目标标识不能重复")
        return self


class GoalUpdate(GoalInput):
    revision: int = Field(ge=0)


class GoalCandidate(Input):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(max_length=4000)
    node_ids: list[str] = Field(max_length=100)
    subtasks: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=20)
    sources: list[Source] = Field(min_length=1, max_length=20)


class GoalDraft(Input):
    goals: list[GoalCandidate] = Field(max_length=20)


class GoalAccept(Input):
    token: str = Field(min_length=32, max_length=32)
    indices: list[int] = Field(min_length=1, max_length=20)


def goal_fields(request):
    fields = request.model_dump(exclude={"revision"})
    fields["node_ids"] = list(dict.fromkeys(fields["node_ids"]))
    for task in fields["subtasks"]:
        task.update(id=task["id"] or identity(), title=task["title"].strip())
    return fields


def new_goal(request, sources=None):
    return dict(id=identity(), created_at=timestamp(), sources=sources or [], **goal_fields(request))


def project_goals(course):
    nodes = {node["id"]: node for node in course["nodes"]}
    verified_ids = {nid for nid, node in nodes.items() if node["verification"] in {"ai_passed", "user_passed"}}
    for goal in course.get("goals", []):
        for task in goal.get("subtasks", []):
            task["auto_done"] = bool(task.get("node_id")) and task["node_id"] in verified_ids
        linked = [nodes[nid] for nid in goal["node_ids"] if nid in nodes]
        goal["progress"] = dict(
            linked=len(linked),
            studied=sum(node["status"] == "studied" for node in linked),
            mastered=sum(node["status"] == "mastered" for node in linked),
            verified=sum(node["verification"] in {"ai_passed", "user_passed"} for node in linked),
            review=sum(node["verification"] == "review" for node in linked),
            subtasks_done=sum(task["done"] or task["auto_done"] for task in goal.get("subtasks", [])),
            subtasks_total=len(goal.get("subtasks", [])),
        )
