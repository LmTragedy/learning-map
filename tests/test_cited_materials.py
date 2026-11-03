"""Backfill prompts carry only the pages their nodes and relations cite."""

import json

from backend.bridge_backfill import backfill_sources
from backend.learning import (
    cited_material_context,
    course_material_context,
    material_index,
    save_page_digests,
)


def course_fixture():
    return {
        "nodes": [
            {"id": "a", "sources": [{"material_id": "m1", "page": 2}]},
            {"id": "b", "sources": []},
            {"id": "c", "sources": [{"material_id": "m1", "page": 3}]},
        ],
        "edges": [{"id": "e", "source": "a", "target": "b", "sources": [{"material_id": "m2", "page": 1}]}],
        "materials": [
            {"id": "m1", "name": "One", "week": "1",
             "pages": [{"text": "p1"}, {"text": "p2"}, {"text": "p3"}]},
            {"id": "m2", "name": "Two", "week": "2", "pages": [{"text": "q1"}]},
        ],
    }


def test_backfill_context_keeps_only_cited_pages_in_course_order():
    course = course_fixture()
    sources = backfill_sources(course, course["edges"], ["b", "a"])
    pages = json.loads(cited_material_context(course, sources))
    assert [page["text"] for page in pages] == ["p2", "q1"]
    assert pages[0] | {"text": None} == dict(material_id="m1", name="One", week="1", text=None)


def test_uncited_batch_falls_back_to_the_whole_course():
    course = course_fixture()
    sources = backfill_sources(course, [], ["b"])
    assert cited_material_context(course, sources) == course_material_context(course)


def test_material_index_sends_digests_except_for_full_text_materials():
    course = course_fixture()
    course["materials"][0]["pages"][1]["digest"] = "Saved digest"
    pages = json.loads(material_index(course, {"m2"}))
    assert [page.get("digest") for page in pages[:3]] == ["p1", "Saved digest", "p3"]
    assert all("text" not in page for page in pages[:3])
    assert pages[3] == dict(material_id="m2", name="Two", week="2", page=1, text="q1", uncertain=False)


def test_page_digests_from_a_map_are_saved_and_unknown_pages_ignored():
    course = course_fixture()
    save_page_digests(course, [dict(material_id="m1", page=3, summary="Third page"),
                               dict(material_id="m1", page=9, summary="Missing"),
                               dict(material_id="gone", page=1, summary="Missing")])
    assert [page.get("digest") for page in course["materials"][0]["pages"]] == [None, None, "Third page"]
