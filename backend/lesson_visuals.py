"""Source-backed visual items built from saved course pages (used when old visual-era lesson receipts replay)."""

import hashlib
import json
from typing import Annotated

from pydantic import Field, StrictInt

from .files import material_original
from .review_scope import strict_scope
from .schemas import Input


def _normalized(value):
    return " ".join(value.split())


class SourceProcess(Input):
    title: str = Field(min_length=1, max_length=180)
    material_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    pages: list[Annotated[StrictInt, Field(ge=1)]] = Field(min_length=2, max_length=20)


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
