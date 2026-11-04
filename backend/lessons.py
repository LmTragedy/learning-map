"""Teach integration: application-owned records and immutable, isolated HTML lessons."""

import hashlib
import json
from typing import Literal

from pydantic import Field, ValidationError

from .ai_tasks import current_task_id, is_regenerating
from .conversation_labels import remember_conversation
from .domain import find_node
from .files import material_page
from .handoff import handoff
from .learning import LearningError, StructuredReply, node_context, structured
from .lesson_html import render_lesson
from .lesson_method import LESSON_CONTEXT_VERSION, LESSON_METHOD_V1, LESSON_METHODS
from .lesson_plan_context import VERSION_FIELD, context_version, lesson_plan_ref, plan_context
from .lesson_visual_generation import build_generated_visuals
from .lesson_visual_schema import LessonVisualDraft
from .review_scope import (
    active_records,
    active_sources,
    require_review_node,
    require_review_record,
    review_label,
    scope_key,
    strict_scope,
)
from .schemas import Input
from .store import identity, timestamp


class LessonRequest(Input):
    kind: Literal["initial", "supplement"] = "initial"
    focus: str = Field(default="", max_length=2000)
    request_id: str = Field(min_length=16, max_length=80, pattern=r"^[a-zA-Z0-9-]+$")


class LessonDraft(Input):
    title: str = Field(min_length=1, max_length=160)
    goal: str = Field(min_length=1, max_length=1000)
    html: str = Field(min_length=20, max_length=45000)
    check_question: str = Field(min_length=1, max_length=3000)
    check_answer: str = Field(min_length=1, max_length=5000)
    recap: str = Field(min_length=1, max_length=3000)
    # Defaults keep lessons saved before the hand-off fields existed valid.
    previous_recap: str = Field(default="", max_length=600)
    next_preview: str = Field(default="", max_length=600)


class VisualLessonDraft(LessonDraft):
    visuals: list[LessonVisualDraft] = Field(default_factory=list, max_length=12)


# The method texts live in lesson_method.py; LESSON_METHOD keeps the old name for version 1.
LESSON_METHOD = LESSON_METHOD_V1


def find_lesson(node, lesson_id):
    for lesson in node.get("lessons", []):
        if lesson["id"] == lesson_id:
            return lesson
    raise KeyError("小课不存在，可能已恢复到更早的课程版本。")


def _lesson_context(course, node, request, visual_pages=None, version=1):
    lessons = active_records(course, node.get("lessons", []))
    context_node = json.loads(node_context(course, node))
    strict = scope_key(course) != "course"
    context = dict(
        mission=dict(course=course["title"], node_goal=context_node["goal"] if strict else node["summary"]),
        node=context_node,
        actual_conversations=context_node.pop("actual_conversations"),
        assessment_evidence=context_node.pop("assessment_evidence"),
        previous_lessons=[
            {k: lesson[k] for k in ("title", "goal", "recap", "focus")}
            for lesson in lessons
        ],
        request=request.model_dump(exclude={"request_id"}),
    )
    context["checklist"] = _checklist(course, node)
    context["handoff"] = _handoff(course, node)
    if version >= 2:
        context.update(plan_context(course, node, lessons))
    if visual_pages is not None:
        context["source_pages"] = visual_pages
    encoded = json.dumps(context, ensure_ascii=False)
    if len(encoded) > 150000:
        raise LearningError("小课上下文过长，未生成。请先缩小节点来源或补充问题的范围。")
    return encoded


def _handoff(course, node):
    """The lessons just before and after this one, with the transition the links AI wrote, if any."""
    found = handoff(course, node)
    nodes = {item["id"]: item for item in course["nodes"]}

    def brief(side):
        other = nodes.get(found[side]) if found[side] else None
        return other and dict(title=other["title"], summary=other.get("summary", "")[:300], transition=found[f"{side}_text"])

    return dict(line=found["line_name"], previous=brief("prev"), next=brief("next"))


def _checklist(course, node):
    """The pieces and steps the map split this node into, so the lesson can cover each one."""
    pieces = node.get("pieces", [])
    if strict_scope(course):
        selected = set(course["review_scope"]["material_ids"])
        pieces = [piece for piece in pieces if piece.get("sources")
                  and all(source.get("material_id") in selected for source in piece["sources"])]
    return dict(
        pieces=[{key: piece[key] for key in ("kind", "title", "detail") if key in piece} for piece in pieces],
        steps=[step["title"] for step in node.get("steps", [])],
    )


def _visual_inputs(learning, course, node):
    pages, image_refs = _visual_page_manifest(course, node)
    images = [material_page(learning.store, course, material_id, page) for material_id, page in image_refs]
    return pages, images


def _visual_page_manifest(course, node):
    materials = {material["id"]: material for material in course["materials"]}
    pages, image_refs, seen = [], [], set()
    for source in active_sources(course, node):
        key = (source["material_id"], source["page"])
        if key in seen:
            continue
        seen.add(key)
        material = materials[key[0]]
        supplied = material["kind"] in {"pdf", "image"} and len(image_refs) < 6
        page = dict(material_id=key[0], page=key[1], material_name=material["name"], image_provided=supplied)
        if supplied:
            image_refs.append(key)
            page["image_index"] = len(image_refs)
        pages.append(page)
    return pages, image_refs


def _lesson_reply(learning, course, node, request, label, version):
    task_id = current_task_id()
    task = learning.tasks.get(task_id) if task_id else {}
    if task.get("raw_reply"):
        saved = task["request"]
        visual_contract = "visuals" in saved.get("schema", {}).get("properties", {})
        model = VisualLessonDraft if visual_contract else LessonDraft
        # Reuse the exact persisted request so upgrades cannot change the original turn's contract.
        raw = learning.ai().ask(saved["prompt"], schema=saved["schema"], conversation=label)
        try:
            draft = model.model_validate_json(raw["text"]).model_dump()
        except ValidationError as error:
            raise LearningError("小课原始结果不符合保存的数据契约，已保留原文，未重新生成。") from error
        return StructuredReply(payload=draft, thread_id=raw["thread_id"]), task.get("visual_image_pages", [])
    pages, images = _visual_inputs(learning, course, node)
    image_pages = [{key: page[key] for key in ("material_id", "page")} for page in pages if page["image_provided"]]
    if task_id:
        learning.tasks.update(task_id, visual_image_pages=image_pages)
    instructions, _ = _teach_instructions(version)
    # New lessons no longer ask for visuals: nothing shows them since the visual rail was removed.
    reply = structured(learning.ai(), instructions + "\n学习上下文：\n"
                       + _lesson_context(course, node, request, pages, version), LessonDraft,
                       {"conversation": label, "images": images})
    return reply, image_pages


def _teach_instructions(version=1):
    """The lesson method of a context version and its hash, saved with each lesson as the method version."""
    method = LESSON_METHODS[version]
    return method, hashlib.sha256(method.encode()).hexdigest()


def _task_version(learning):
    task_id = current_task_id()
    return context_version(learning.tasks.get(task_id).get("inputs")) if task_id else LESSON_CONTEXT_VERSION


def generate_lesson(learning, course_id, node_id, request):
    course = learning.store.course(course_id)
    lessons = active_records(course, find_node(course, node_id).get("lessons", []))
    if request.kind == "initial" and lessons and not is_regenerating():
        return course
    return learning.tasks.run(
        course_id,
        "lesson",
        node_id,
        request.model_dump() | {VERSION_FIELD: LESSON_CONTEXT_VERSION},
        lambda: _generate_lesson(learning, course_id, node_id, request),
        request_id=request.request_id,
    )


def _generate_lesson(learning, course_id, node_id, request):
    course = learning.tasks.input_course(course_id)
    node = find_node(course, node_id)
    require_review_node(course, node)
    lessons = active_records(course, node.get("lessons", []))
    if any(lesson["request_id"] == request.request_id for lesson in lessons):
        return course
    if request.kind == "initial" and lessons and not is_regenerating():
        return course
    if request.kind == "supplement" and (not lessons or not request.focus.strip()):
        raise LearningError("请先生成基础小课，再说明需要补充的具体问题。")
    if len(lessons) >= 20:
        raise LearningError("本节点已保存 20 节小课，请先复习已有内容或继续学习对话。")
    version = _task_version(learning)
    _, skill_hash = _teach_instructions(version)
    label = review_label(course, node, "Teach小课")
    reply, image_pages = _lesson_reply(learning, course, node, request, label, version)
    draft = reply.payload
    if "visuals" in draft:
        draft["visuals"] = build_generated_visuals(
            learning.store, course, node, draft["visuals"],
            image_pages={(page["material_id"], page["page"]) for page in image_pages},
        )
    materials = {material["id"]: material for material in course["materials"]}
    sources = [dict(name=materials[source["material_id"]]["name"], **source) for source in active_sources(course, node)]
    key = scope_key(course)
    lesson = dict(
        draft,
        html=render_lesson(draft, sources),
        id=identity(),
        created_at=timestamp(),
        read_at=None,
        kind=request.kind,
        focus=request.focus.strip(),
        request_id=request.request_id,
        sources=sources,
        teach_sha256=skill_hash,
        context_version=version,
        teaching_plan_ref=lesson_plan_ref(course, node, version),
        review_scope_key=key,
        material_ids=list(course.get("review_scope", {}).get("material_ids", [])) if key != "course" else [],
    )
    with learning.store.edit(course_id, task_id=current_task_id()) as (current, connection):
        learning.store.snapshot(current, "生成 Teach 小课前自动备份", connection)
        find_node(current, node_id).setdefault("lessons", []).append(lesson)
        remember_conversation(current, reply.thread_id, label, node_id)
    return learning.store.course(course_id)


def mark_lesson_read(store, course_id, node_id, lesson_id):
    with store.edit(course_id) as (course, _):
        lesson = find_lesson(find_node(course, node_id), lesson_id)
        require_review_record(course, lesson)
        if lesson["read_at"] is None:
            lesson["read_at"] = timestamp()
    return store.course(course_id)


def mark_lesson_unread(store, course_id, node_id, lesson_id):
    with store.edit(course_id) as (course, _):
        lesson = find_lesson(find_node(course, node_id), lesson_id)
        require_review_record(course, lesson)
        lesson["read_at"] = None
    return store.course(course_id)
