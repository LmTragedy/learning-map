"""Validate and enrich model generated lesson visuals against node sources."""

import hashlib
import json
from dataclasses import dataclass

from pydantic import ValidationError

from .lesson_visual_schema import LessonVisualDrafts, VisualRef
from .lesson_visuals import SourceProcess, _process_visual, _source_page, _source_visuals
from .review_scope import active_sources

MAX_VISUALS = 40


def _normalise(value):
    return " ".join(value.split())


def _parse_drafts(drafts):
    try:
        return LessonVisualDrafts(visuals=drafts).visuals
    except ValidationError as error:
        raise ValueError("小课视觉草稿不符合数据契约，原始结果已保留。") from error


def _visual_content_hash(visual):
    content = {key: value for key, value in visual.items() if key not in {"id", "number"}}
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _visual_key(visual):
    source = visual.get("source") or {}
    if visual.get("provenance") != "source" or visual.get("kind") == "process":
        return ("content", _visual_content_hash(visual))
    if visual.get("kind") == "figure":
        return ("source-figure", source.get("material_id"), source.get("page"))
    if visual.get("kind") == "example":
        return ("source-example", source.get("material_id"), source.get("page"), source.get("quote", ""))
    return ("content", _visual_content_hash(visual))


def _stable_id(visual):
    return "lesson-visual-" + _visual_content_hash(visual)[:24]


@dataclass(frozen=True)
class _VisualBuildContext:
    store: object
    course: dict
    allowed_pages: set[tuple[str, int]]
    image_pages: set[tuple[str, int]]

    def resolve(self, reference):
        page_key = (reference.material_id, reference.page)
        if page_key not in self.allowed_pages:
            raise ValueError("小课视觉引用了当前节点允许来源之外的材料页。")
        source, page, image = _source_page(
            self.store, self.course, reference.material_id, reference.page, reference.quote,
        )
        quote = reference.quote
        if quote and _normalise(quote) not in _normalise(page.get("text", "")):
            raise ValueError("小课视觉引文与允许来源页不匹配，原始结果已保留。")
        return source, page, image


def _build_invented_visual(draft):
    if draft.source is not None or any(step.page is not None or step.quote is not None for step in draft.steps):
        raise ValueError("AI 构造的视觉不能伪造材料页或原文引文。")
    if not (draft.body or draft.diagram or any(step.diagram for step in draft.steps)):
        raise ValueError("AI 构造的视觉需要正文或图形内容。")
    if draft.kind == "process":
        if len(draft.steps) < 2 or any(step.diagram is None for step in draft.steps):
            raise ValueError("AI 构造的过程图至少需要两个且每步都有图形。")
    elif draft.steps:
        raise ValueError("非过程视觉不能包含步骤。")
    return draft.model_dump(exclude_none=True)


def _build_source_visual(context, draft):
    reference = draft.source
    if reference is None:
        raise ValueError("原文视觉必须引用当前节点允许来源页。")
    source, _, image = context.resolve(reference)
    if draft.diagram is not None or any(step.diagram is not None for step in draft.steps):
        raise ValueError("原文视觉不接受模型重绘的图形。")
    if draft.kind == "process":
        if draft.body or draft.explanation or any(step.reason or step.changes for step in draft.steps):
            raise ValueError("原文过程图不能加入模型解释或改写的步骤内容。")
        pages = [step.page for step in draft.steps]
        if len(pages) < 2 or any(page is None for page in pages) or len(pages) != len(set(pages)):
            raise ValueError("原文过程图必须按顺序引用至少两个不同来源页。")
        if pages[0] != reference.page:
            raise ValueError("原文过程图来源必须与第一步来源页一致。")
        for step in draft.steps:
            context.resolve(VisualRef(material_id=reference.material_id, page=step.page, quote=step.quote or ""))
        return _process_visual(context.store, context.course, SourceProcess(
            title=draft.title, material_id=reference.material_id, pages=pages,
        ))
    if draft.steps:
        raise ValueError("非过程原文视觉不能包含步骤。")
    if draft.kind == "example":
        if not reference.quote.strip():
            raise ValueError("原文例子必须提供可核对的原文引文。")
        raw = draft.model_dump(exclude_none=True)
        raw["body"] = reference.quote
    else:
        if not image:
            raise ValueError("文本材料页不能标记为原页图像。")
        raw = draft.model_dump(exclude_none=True)
    raw["source"] = source
    return raw


def _build_redraw_visual(context, draft):
    reference = draft.source
    if reference is None:
        raise ValueError("重绘视觉必须引用当前节点允许来源页。")
    source, _, _ = context.resolve(reference)
    rendered_steps = []
    referenced_pages = {(reference.material_id, reference.page)}
    for step in draft.steps:
        step_page = step.page if step.page is not None else reference.page
        step_ref = VisualRef(material_id=reference.material_id, page=step_page, quote=step.quote or "")
        step_source, _, _ = context.resolve(step_ref)
        referenced_pages.add((reference.material_id, step_page))
        rendered_step = step.model_dump(exclude_none=True)
        rendered_step.update(page=step_page, matched=step_source["matched"], uncertain=step_source["uncertain"])
        rendered_steps.append(rendered_step)
    if not referenced_pages.issubset(context.image_pages):
        raise ValueError("重绘视觉只能引用实际提供给模型的原页图像。")
    if not (draft.diagram or any(step.diagram for step in draft.steps)):
        raise ValueError("重绘视觉必须包含受限图形。")
    if draft.kind == "process":
        if len(draft.steps) < 2 or any(step.diagram is None for step in draft.steps):
            raise ValueError("重绘过程图至少需要两个且每步都有图形。")
    elif draft.steps:
        raise ValueError("非过程重绘视觉不能包含步骤。")
    raw = draft.model_dump(exclude_none=True)
    raw["source"] = source
    raw["steps"] = rendered_steps
    return raw


def _build_visual(context, draft):
    if draft.provenance == "invented":
        return _build_invented_visual(draft)
    if draft.provenance == "source":
        return _build_source_visual(context, draft)
    return _build_redraw_visual(context, draft)


def build_generated_visuals(store, course, node, drafts, image_pages):
    """Build visuals, restricting redraws to original page images attached to the model request."""
    sources = active_sources(course, node)
    context = _VisualBuildContext(
        store=store,
        course=course,
        allowed_pages={(source["material_id"], source["page"]) for source in sources},
        image_pages=image_pages,
    )
    visuals = _source_visuals(store, course, {"sources": sources})
    visual_keys = {_visual_key(visual) for visual in visuals}
    for draft in _parse_drafts(drafts):
        visual = _build_visual(context, draft)
        visual_key = _visual_key(visual)
        if visual_key in visual_keys:
            continue
        visual["id"] = _stable_id(visual)
        visuals.append(visual)
        visual_keys.add(visual_key)
    if len(visuals) > MAX_VISUALS:
        raise ValueError("小课视觉超过 40 项，未静默丢弃内容。")
    for number, visual in enumerate(visuals, start=1):
        visual["number"] = number
    return visuals
