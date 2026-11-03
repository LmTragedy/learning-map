"""Bounded model output schema for saved lesson visuals."""

from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictFloat, StrictInt, StringConstraints, field_validator

from .schemas import Input

Coordinate = Annotated[StrictFloat | StrictInt, Field(ge=0, le=4096)]
ShapeId = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
DrawingText = Annotated[str, StringConstraints(max_length=240)]


class VisualRef(Input):
    material_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    page: StrictInt = Field(ge=1)
    quote: str = Field(max_length=2000)


class BoxElement(Input):
    id: ShapeId
    type: Literal["box", "cell"]
    x: Coordinate
    y: Coordinate
    width: Coordinate = Field(ge=1)
    height: Coordinate = Field(ge=1)
    text: DrawingText | None = None
    changed: StrictBool | None = None
    oldText: DrawingText | None = None


class TextElement(Input):
    id: ShapeId
    type: Literal["text"]
    x: Coordinate
    y: Coordinate
    text: DrawingText
    changed: StrictBool | None = None


class LineElement(Input):
    id: ShapeId
    type: Literal["arrow", "line"]
    x1: Coordinate
    y1: Coordinate
    x2: Coordinate
    y2: Coordinate
    label: DrawingText | None = None
    dashed: StrictBool | None = None
    changed: StrictBool | None = None


class PointElement(Input):
    id: ShapeId
    type: Literal["point"]
    x: Coordinate
    y: Coordinate
    label: DrawingText | None = None
    changed: StrictBool | None = None


DiagramElement = BoxElement | TextElement | LineElement | PointElement


class Diagram(Input):
    width: Coordinate = Field(ge=1)
    height: Coordinate = Field(ge=1)
    elements: list[DiagramElement] = Field(max_length=80)

    @field_validator("elements")
    @classmethod
    def unique_element_ids(cls, elements):
        ids = [element.id for element in elements]
        if len(ids) != len(set(ids)):
            raise ValueError("图形元素 id 必须唯一")
        return elements


class VisualStepDraft(Input):
    title: str = Field(min_length=1, max_length=180)
    changes: list[str] = Field(max_length=20)
    reason: str | None = Field(default=None, max_length=1000)
    diagram: Diagram | None = None
    page: StrictInt | None = Field(default=None, ge=1)
    quote: str | None = Field(default=None, max_length=2000)

    @field_validator("changes")
    @classmethod
    def bound_change_text(cls, changes):
        if any(len(change) > 500 for change in changes):
            raise ValueError("步骤说明不能超过 500 个字符")
        return changes


class LessonVisualDraft(Input):
    title: str = Field(min_length=1, max_length=180)
    kind: Literal["example", "figure", "process"]
    provenance: Literal["source", "redraw", "invented"]
    source: VisualRef | None = None
    body: str | None = Field(default=None, max_length=4000)
    explanation: str | None = Field(default=None, max_length=2000)
    diagram: Diagram | None = None
    steps: list[VisualStepDraft] = Field(default_factory=list, max_length=20)


class LessonVisualDrafts(Input):
    visuals: list[LessonVisualDraft] = Field(default_factory=list, max_length=12)
