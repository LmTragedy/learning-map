"""Attach existing course sources to saved lessons without requesting model work."""

import copy
import hashlib
import json
from typing import Annotated

from pydantic import Field, StrictInt

from .ai_result_refs import _fingerprint, presented_result
from .domain import find_node
from .files import material_original
from .review_scope import require_review_record, strict_scope
from .schemas import Input
from .store import Conflict

MAX_VISUALS = 40


def _normalized(value):
    return " ".join(value.split())


class SourceProcess(Input):
    title: str = Field(min_length=1, max_length=180)
    material_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    pages: list[Annotated[StrictInt, Field(ge=1)]] = Field(min_length=2, max_length=20)


class RecoverVisuals(Input):
    revision: StrictInt = Field(ge=0)
    processes: list[SourceProcess] = Field(default_factory=list, max_length=5)


def _source_page(store, course, material_id, number, quote=""):
    material = next((m for m in course["materials"] if m["id"] == material_id), None)
    if material is None:
        raise ValueError("小课引用的材料已不存在，未接入例图。")
    if strict_scope(course) and material_id not in course["review_scope"]["material_ids"]:
        raise ValueError("例图引用了当前复习范围之外的材料。")
    if isinstance(number, bool) or not isinstance(number, int):
        raise ValueError("例图页码无效。")
    page = next((p for p in material["pages"] if p["number"] == number), None)
    if page is None:
        raise ValueError("小课引用的页码不存在，未接入例图。")
    image = material["kind"] in {"pdf", "image"}
    if image:
        material_original(store, course["id"], material_id)
    source = dict(material_id=material_id, material_name=material["name"], page=number,
                  matched=bool(quote.strip()) and _normalized(quote) in _normalized(page.get("text", "")),
                  uncertain=bool(page.get("uncertain", True)))
    if quote:
        source["quote"] = quote
    return source, page, image


def _visual_id(kind, source):
    encoded = json.dumps([kind, source], ensure_ascii=False, sort_keys=True)
    return "source-" + hashlib.sha256(encoded.encode()).hexdigest()[:24]


def _source_visuals(store, course, lesson):
    visuals, pages, quotes = [], set(), set()
    for ref in lesson.get("sources", []):
        quote = ref.get("quote", "")
        if not isinstance(quote, str) or len(quote) > 2000:
            raise ValueError("原文引文超出例图范围，未截断或改写原文。")
        source, _, image = _source_page(store, course, ref["material_id"], ref["page"], quote)
        page_key = (source["material_id"], source["page"])
        if quote.strip() and (*page_key, quote) not in quotes:
            visuals.append(dict(id=_visual_id("example", source), title=f"原文摘录 · 第 {source['page']} 页",
                                kind="example", provenance="source", source=source, body=quote))
            quotes.add((*page_key, quote))
        if image and page_key not in pages:
            visuals.append(dict(id=_visual_id("figure", page_key), title=f"原页图像 · 第 {source['page']} 页",
                                kind="figure", provenance="source", source=source))
            pages.add(page_key)
    return visuals


def _process_visual(store, course, process):
    if len(set(process.pages)) != len(process.pages):
        raise ValueError("原文逐页过程不能重复引用同一页。")
    steps, first_source = [], None
    for number in process.pages:
        source, page, image = _source_page(store, course, process.material_id, number)
        if not image:
            raise ValueError("原文过程图需要可显示原页的 PDF 或图片材料。")
        # These are existing page excerpts, not invented transitions or a model redraw.
        lines = [line.strip() for line in page.get("text", "").splitlines() if line.strip()]
        title = next((line for line in lines if len(line) <= 180), f"原页 · 第 {number} 页")
        quote = "\n".join(lines[:2])
        if len(quote) > 2000:
            quote = title
        source, _, _ = _source_page(store, course, process.material_id, number, quote)
        first_source = first_source or source
        steps.append(dict(title=title, page=number, quote=quote, changes=[],
                          matched=source["matched"], uncertain=source["uncertain"]))
    return dict(id=_visual_id("process", process.model_dump()), title=process.title, kind="process",
                provenance="source", source=first_source, steps=steps)


def _merged_visuals(store, course, lesson, request):
    existing = copy.deepcopy(lesson.get("visuals", []))
    if not isinstance(existing, list) or any(
        not isinstance(visual, dict) or not isinstance(visual.get("id"), str)
        or type(visual.get("number")) is not int or visual["number"] < 1
        for visual in existing
    ):
        raise ValueError("已保存的例图列表格式异常，原始结果未覆盖。")
    ids = {v["id"] for v in existing}
    number = max((v["number"] for v in existing), default=0)
    recovered = _source_visuals(store, course, lesson)
    recovered.extend(_process_visual(store, course, process) for process in request.processes)
    for visual in recovered:
        if visual["id"] not in ids:
            number += 1
            existing.append(visual | dict(number=number))
            ids.add(visual["id"])
    if len(existing) > MAX_VISUALS:
        raise ValueError("例图超过 40 项，未静默丢弃已有内容。")
    return existing


def _sync_receipts(connection, before, course, lesson):
    """Only extend receipts already verified against the unchanged original lesson."""
    for row in connection.execute("SELECT * FROM ai_tasks WHERE course_id=?", (course["id"],)).fetchall():
        body = json.loads(row["body"])
        task = body | {key: row[key] for key in ("id", "course_id", "kind", "target", "state")}
        reference = body.get("result_ref", {})
        if reference.get("kind") != "lesson" or reference.get("object_id") != lesson["id"]:
            continue
        if not presented_result(task, before).get("result_ref", {}).get("available"):
            continue
        body["result_object"] = copy.deepcopy(lesson)
        body["result_ref"]["fingerprint"] = _fingerprint("lesson", lesson)
        connection.execute("UPDATE ai_tasks SET body=? WHERE id=?", (json.dumps(body, ensure_ascii=False), row["id"]))


def recover_visuals(store, course_id, node_id, lesson_id, request):
    from .lessons import find_lesson

    course = store.course(course_id)
    if course["revision"] != request.revision:
        raise Conflict("课程已改变，请刷新后接入已有来源；原始内容未覆盖。")
    lesson = find_lesson(find_node(course, node_id), lesson_id)
    require_review_record(course, lesson)
    visuals = _merged_visuals(store, course, lesson, request)
    if visuals == lesson.get("visuals", []):
        return course
    with store.edit(course_id, expected=request.revision) as (current, connection):
        before = copy.deepcopy(current)
        target = find_lesson(find_node(current, node_id), lesson_id)
        store.snapshot(current, "接入小课原文和原图前自动备份", connection)
        target["visuals"] = visuals
        _sync_receipts(connection, before, current, target)
    return store.course(course_id)
