"""The AI reply contract for one node's teaching plan."""

from typing import Literal

from pydantic import Field

from ..schemas import Input

Depth = Literal["讲透", "简述"]
Axis = Literal["深度", "场景", "应用", "其他"]


class OwnedPoint(Input):
    piece: str = Field(max_length=200)
    point: str = Field(min_length=1, max_length=400)
    depth: Depth


class BorrowedPoint(Input):
    node_id: str = Field(min_length=1, max_length=100)
    what: str = Field(min_length=1, max_length=300)
    use: str = Field(max_length=300)


class DeferredPoint(Input):
    node_id: str = Field(min_length=1, max_length=100)
    what: str = Field(min_length=1, max_length=300)


class Distinction(Input):
    node_id: str = Field(min_length=1, max_length=100)
    shared: str = Field(min_length=1, max_length=200)
    axis: Axis
    difference: str = Field(min_length=1, max_length=400)


class PlanSource(Input):
    material_id: str = Field(min_length=1, max_length=100)
    page: int = Field(ge=1)
    quote: str = Field(max_length=600)


class PlanConflict(Input):
    node_ids: list[str] = Field(max_length=6)
    issue: str = Field(min_length=1, max_length=500)


class TeachingPlanDraft(Input):
    goal: str = Field(min_length=1, max_length=400)
    owns: list[OwnedPoint] = Field(min_length=1, max_length=16)
    borrows: list[BorrowedPoint] = Field(max_length=12)
    defers: list[DeferredPoint] = Field(max_length=12)
    distinctions: list[Distinction] = Field(max_length=12)
    sources: list[PlanSource] = Field(max_length=12)
    conflicts: list[PlanConflict] = Field(max_length=8)
    uncertain: bool
    note: str = Field(max_length=600)
