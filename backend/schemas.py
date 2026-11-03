from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateCourse(Input):
    title: str = Field(min_length=1, max_length=160)


class Mark(Input):
    status: Literal["new", "studied", "mastered"]


class Message(Input):
    message: str = Field(min_length=1, max_length=12000)


class ReviewScope(Input):
    enabled: bool
    material_ids: list[str] = Field(max_length=256)
    ai_scope: Literal["selected", "course"] = "selected"


class Resolve(Input):
    decision: Literal["pass", "supplement", "review"]


class Rating(Input):
    problem: StrictInt | None = Field(default=None, ge=0, le=4)
    mastery: StrictInt | None = Field(default=None, ge=0, le=4)
    comment: str = Field(default="", max_length=4000)
    skip: bool = False


class Token(Input):
    token: str = Field(min_length=32, max_length=32)


class RestorePreview(Input):
    version_id: str = Field(min_length=32, max_length=32)


class Settings(Input):
    ai_enabled: bool = False
    model: str = Field(default="", max_length=160)
    reasoning_effort: Literal["low", "medium", "high"] = "medium"
    obsidian_vault: str = Field(default="", max_length=500)
    parser: Literal["basic", "docling"] = "basic"


class NoteWrite(Input):
    path: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=100000)


class Source(Input):
    material_id: str
    page: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=6000)


class MapNode(Input):
    key: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=3000)
    week: str
    sources: list[Source] = Field(min_length=1, max_length=30)
    prerequisites: list[str] = Field(max_length=30)
    uncertain: bool


class MapDraft(Input):
    nodes: list[MapNode] = Field(min_length=1, max_length=60)

    @model_validator(mode="after")
    def unique_keys(self):
        keys = [node.key for node in self.nodes]
        if len(set(keys)) != len(keys):
            raise ValueError("AI 返回了重复节点标识")
        for node in self.nodes:
            if any(parent not in keys or parent == node.key for parent in node.prerequisites):
                raise ValueError("AI 返回了无效的先修关系")
        return self


class Question(Input):
    prompt: str = Field(min_length=1, max_length=6000)
    kind: Literal["解释", "案例", "变体", "组合"]
    rubric: str = Field(min_length=1, max_length=4000)


class Judgment(Input):
    outcome: Literal["passed", "failed", "uncertain"]
    reasoning: str = Field(min_length=1, max_length=6000)
    blockers: list[str] = Field(max_length=20)
    next_step: str = Field(min_length=1, max_length=4000)


class RecallItem(Input):
    category: Literal["学习起点", "用户想法", "知识连接", "当前进展", "待继续", "AI推测"]
    content: str = Field(min_length=1, max_length=3000)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)


class RecallSummary(Input):
    title: str = Field(min_length=1, max_length=200)
    items: list[RecallItem] = Field(min_length=1, max_length=20)
    uncertainties: list[str] = Field(max_length=20)
