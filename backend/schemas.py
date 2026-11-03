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
    request_id: str | None = Field(default=None, min_length=16, max_length=80, pattern=r"^[a-zA-Z0-9-]+$")


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
    note_review_model: str = Field(default="gpt-6-luna", min_length=1, max_length=160)
    # Empty follows the learning model; a deepseek-* name sends goal extraction to DeepSeek.
    goal_model: str = Field(default="", max_length=160)
    # Write-only; an empty string removes the saved key (the environment variable still applies).
    deepseek_api_key: str = Field(default="", max_length=200, pattern=r"^[\x21-\x7e]*$")
    # Read-only flag from GET /api/settings; accepted so a settings round trip still saves.
    deepseek_key_set: bool | None = Field(default=None, exclude=True)
    reasoning_effort: Literal["low", "medium", "high"] = "medium"
    obsidian_vault: str = Field(default="", max_length=500)
    parser: Literal["basic", "docling"] = "basic"

    @model_validator(mode="after")
    def deepseek_only_for_checked_tasks(self):
        if self.model.strip().lower().startswith("deepseek"):
            raise ValueError("DeepSeek 只用于笔记检查和目标提取；学习对话模型请使用 Codex 模型")
        return self


class NoteWrite(Input):
    path: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=100000)


class Source(Input):
    material_id: str
    page: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=6000)


PieceKind = Literal["定义", "记号", "性质", "方法", "例子"]
Strength = Literal["required", "suggested", "extension"]


# Knowledge-bridge shapes the AI fills, both during map generation and when bridging older relationships.
class DraftPiece(Input):
    kind: PieceKind
    title: str = Field(min_length=1, max_length=160, pattern=r"\S")
    detail: str = Field(max_length=1000)
    sources: list[Source] = Field(default_factory=list, max_length=4)


class DraftBridge(Input):
    piece: DraftPiece
    step: str = Field(min_length=1, max_length=200, pattern=r"\S")
    how: str = Field(min_length=1, max_length=600, pattern=r"\S")
    if_missing: str = Field(max_length=600)
    strength: Strength
    check_question: str = Field(min_length=1, max_length=600, pattern=r"\S")
    check_answer: str = Field(min_length=1, max_length=1200, pattern=r"\S")
    sources: list[Source] = Field(default_factory=list, max_length=4)
    uncertain: bool = True


class NodeBridge(DraftBridge):
    """A bridge written while generating a map: `from_key` names one of the node's prerequisites."""
    from_key: str = Field(min_length=1, max_length=100)


class MapNode(Input):
    key: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=3000)
    week: str
    sources: list[Source] = Field(min_length=1, max_length=30)
    prerequisites: list[str] = Field(max_length=30)
    uncertain: bool
    pieces: list[DraftPiece] = Field(default_factory=list, max_length=6)
    steps: list[str] = Field(default_factory=list, max_length=8)
    bridges: list[NodeBridge] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def drop_repeated_prerequisites(self):
        # A node listed as its own prerequisite, or the same prerequisite twice, says nothing more.
        self.prerequisites = [key for key in dict.fromkeys(self.prerequisites) if key != self.key]
        return self


class MapRelation(Input):
    source: str = Field(min_length=1, max_length=100)
    target: str = Field(min_length=1, max_length=100)
    related_keys: list[str] = Field(default_factory=list, max_length=28)
    relation: Literal["前置知识", "帮助理解", "工具关系", "相似或对比", "归纳关系"]
    explanation: str = Field(min_length=1, max_length=3000)
    when_to_use: str = Field(min_length=1, max_length=2000)
    basis: str = Field(min_length=1, max_length=2000)
    evidence_kind: Literal["material_quote", "material_inference", "ai_inference"]
    sources: list[Source] = Field(default_factory=list, max_length=30)
    uncertain: bool
    forward_difficulty: str = Field(min_length=1, max_length=200)
    reverse_difficulty: str = Field(min_length=1, max_length=200)
    presentation: Literal["simple", "synthesis"] = "simple"
    synthesis_title: str = Field(default="", max_length=160)
    synthesis_summary: str = Field(default="", max_length=3000)
    bridges: list[DraftBridge] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def drop_repeated_endpoints(self):
        # related_keys lists nodes besides the two ends; the AI sometimes repeats the ends there too.
        self.related_keys = [key for key in dict.fromkeys(self.related_keys) if key not in (self.source, self.target)]
        return self

    @model_validator(mode="after")
    def evidence_and_synthesis(self):
        for name in ("explanation", "when_to_use", "basis", "forward_difficulty", "reverse_difficulty"):
            if not getattr(self, name).strip():
                raise ValueError(f"{name} 不能为空")
        # Without source pages a relation is the AI's own inference; label it so instead of dropping the map.
        if self.evidence_kind != "ai_inference" and not self.sources:
            self.evidence_kind, self.uncertain = "ai_inference", True
        # Without a title and content there is no synthesis node to make; keep it as a plain relation.
        if self.presentation == "synthesis" and (not self.synthesis_title.strip() or not self.synthesis_summary.strip()):
            self.presentation, self.synthesis_title, self.synthesis_summary = "simple", "", ""
        return self


class PageDigest(Input):
    material_id: str = Field(min_length=1, max_length=80)
    page: StrictInt = Field(ge=1)
    summary: str = Field(min_length=1, max_length=200)


class MapDraft(Input):
    nodes: list[MapNode] = Field(min_length=1, max_length=60)
    relations: list[MapRelation] = Field(default_factory=list, max_length=180)
    # One line per page with text; later map and goal prompts send these instead of whole pages.
    page_digests: list[PageDigest] = Field(default_factory=list, max_length=400)

    @model_validator(mode="after")
    def unique_keys(self):
        # A relation from a node to itself links nothing.
        self.relations = [relation for relation in self.relations if relation.source != relation.target]
        keys = [node.key for node in self.nodes]
        if len(set(keys)) != len(keys):
            raise ValueError("AI 返回了重复节点标识")
        for node in self.nodes:
            if any(parent not in keys or parent == node.key for parent in node.prerequisites):
                raise ValueError("AI 返回了无效的先修关系")
        relation_keys = set(keys)
        for relation in self.relations:
            endpoints = [relation.source, relation.target, *relation.related_keys]
            if (
                any(endpoint not in relation_keys for endpoint in endpoints)
                or len(set(endpoints)) != len(endpoints)
            ):
                raise ValueError("AI 返回了无效的关联节点")
        return self


class RelationPresentation(Input):
    presentation: Literal["simple", "synthesis"]
    revision: int = Field(ge=0)


class RelationConfirm(Input):
    revision: int = Field(ge=0)


class RelationEdit(Input):
    revision: int = Field(ge=0)
    relation: Literal["前置知识", "帮助理解", "工具关系", "相似或对比", "归纳关系"]
    explanation: str = Field(min_length=1, max_length=3000)
    when_to_use: str = Field(min_length=1, max_length=2000)
    basis: str = Field(min_length=1, max_length=2000)
    forward_difficulty: str = Field(min_length=1, max_length=200)
    reverse_difficulty: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def nonblank_text(self):
        for name in ("explanation", "when_to_use", "basis", "forward_difficulty", "reverse_difficulty"):
            if not getattr(self, name).strip():
                raise ValueError(f"{name} 不能为空")
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
    # Ids of incoming knowledge bridges the answer suggests are missing; only kept when the attempt failed.
    missing_bridges: list[str] = Field(default_factory=list, max_length=8)
    confirmed_points: list["ConfirmedPoint"] = Field(default_factory=list, max_length=30)
    disputed_points: list["DisputedPoint"] = Field(default_factory=list, max_length=30)


class ConfirmedPoint(Input):
    id: str = Field(min_length=1, max_length=100)
    point: str = Field(min_length=1, max_length=500)
    attempt_id: str = Field(default="", max_length=80)
    quote: str = Field(min_length=1, max_length=2000)


class DisputedPoint(Input):
    id: str = Field(min_length=1, max_length=100)
    attempt_id: str = Field(min_length=1, max_length=80)
    quote: str = Field(min_length=1, max_length=2000)
    reason: str = Field(min_length=1, max_length=500)


class RecallItem(Input):
    category: Literal["学习起点", "用户想法", "知识连接", "当前进展", "待继续", "AI推测"]
    content: str = Field(min_length=1, max_length=3000)
    evidence_ids: list[str] = Field(min_length=1, max_length=20)


class RecallSummary(Input):
    title: str = Field(min_length=1, max_length=200)
    items: list[RecallItem] = Field(min_length=1, max_length=20)
    uncertainties: list[str] = Field(max_length=20)
