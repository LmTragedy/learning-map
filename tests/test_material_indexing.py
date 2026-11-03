"""Indexing course pages once: verbatim key lines only, batches move forward, later prompts use the index."""

import json

import pytest
from fastapi.testclient import TestClient

from backend import material_indexing, node_links
from backend.app import create_app
from backend.learning import fully_indexed
from backend.page_index import page_index_entry


class Model:
    def __init__(self):
        self.replies, self.prompts = [], []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        return {"text": reply(prompt) if callable(reply) else json.dumps(reply, ensure_ascii=False), "thread_id": "t"}


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def index_reply(prompt, *, skip_first=False):
    """Index every page in the prompt, quoting its first line verbatim plus one invented line."""
    pages = json.loads(prompt.split("材料页：", 1)[1])
    return json.dumps({"pages": [
        dict(material_id=page["material_id"], page=page["page"], summary=f"摘要{page['page']}", terms=["键"],
             key_quotes=[page["text"].strip().splitlines()[0], "INVENTED QUOTE"])
        for page in pages[1 if skip_first else 0:]
    ]}, ensure_ascii=False)


def test_index_keeps_only_verbatim_key_lines_and_completes(session):
    client, store, model, course = session
    model.replies.append(index_reply)
    response = client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": 0})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["indexed"] == body["total"] > 0
    saved = store.course(course["id"])
    pages = [(page, page_index_entry(saved, material["id"], number, page["text"]))
             for material in saved["materials"] for number, page in enumerate(material["pages"], 1)
             if page["text"].strip()]
    assert all(entry["key_quotes"] == [page["text"].strip().splitlines()[0]] for page, entry in pages)
    assert all(entry["digest"].startswith("摘要") and entry["terms"] == ["键"] for _, entry in pages)
    assert fully_indexed(saved)


def test_pages_the_model_skips_still_advance_with_a_plain_digest(session):
    client, store, model, course = session
    model.replies.append(lambda prompt: index_reply(prompt, skip_first=True))
    body = client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": 0}).json()
    assert body["indexed"] == body["total"]
    saved = store.course(course["id"])
    material = saved["materials"][0]
    number, page = next((n, p) for n, p in enumerate(material["pages"], 1) if p["text"].strip())
    first = page_index_entry(saved, material["id"], number, page["text"])
    assert first["key_quotes"] == [] and first["terms"] == [] and first["digest"]


def test_stale_progress_is_refused_without_sending(session):
    client, _, model, course = session
    response = client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": 3})
    assert response.status_code == 409
    assert not model.prompts


def test_batches_split_long_materials(session, monkeypatch):
    client, store, model, course = session
    monkeypatch.setattr(material_indexing, "BATCH_CHARS", 1)
    total = material_indexing.index_progress(store.course(course["id"]))["total"]
    indexed = 0
    while indexed < total:
        model.replies.append(index_reply)
        indexed = client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": indexed}).json()["indexed"]
    assert len(model.prompts) == total


def test_links_add_other_nodes_key_lines_once_indexed(session):
    client, store, model, course = session
    saved = store.course(course["id"])
    node = saved["nodes"][0]
    assert "其他知识点的索引页" not in node_links._material(saved, node)
    model.replies.append(index_reply)
    client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": 0}).raise_for_status()
    saved = store.course(course["id"])
    assert "其他知识点的索引页" in node_links._material(saved, saved["nodes"][0])


def test_map_generation_saves_page_digests_without_touching_materials(session):
    client, store, model, course = session
    material = course["materials"][0]
    before = store.course(course["id"])["materials"]
    model.replies.append({
        "nodes": [{"key": "k", "title": "新知识", "summary": "新增", "week": "", "uncertain": True,
                   "sources": [{"material_id": material["id"], "page": 1, "quote": "x"}], "prerequisites": []}],
        "page_digests": [{"material_id": material["id"], "page": 1, "summary": "第一页讲键"}],
    })
    response = client.post(f"/api/courses/{course['id']}/generate")
    assert response.status_code == 200, response.text
    saved = store.course(course["id"])
    assert saved["materials"] == before
    entry = page_index_entry(saved, material["id"], 1, saved["materials"][0]["pages"][0]["text"])
    assert entry["digest"] == "第一页讲键"
