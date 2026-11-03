import json

import pytest
from fastapi.testclient import TestClient

from backend.ai import AIUnavailable
from backend.app import create_app


class ReviewModel:
    def __init__(self):
        self.prompts = []
        self.options = []
        self.configurations = []
        self.suggestions = []
        self.during_request = None

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        self.options.append(options)
        if self.during_request:
            self.during_request()
        return {"text": json.dumps({"suggestions": self.suggestions}), "thread_id": "note-review-thread"}


@pytest.fixture
def review_session(tmp_path):
    model = ReviewModel()

    def factory(settings):
        model.configurations.append(dict(settings))
        return model

    app = create_app(tmp_path / "data", factory)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True, "model": "gpt-6.1-terra", "reasoning_effort": "high"})
    url = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/personal-note/review"
    return client, app.state.store, model, course, url


def proposal(original, *, category="knowledge_logic", sources=None):
    return dict(category=category, original=original, replacement="局部修改", reason="请核对这句话。", sources=sources or [])


def review(client, url, course, content):
    return client.post(url, json={"content": content, "revision": course["revision"], "request_id": "review-request"})


def test_whole_note_review_has_verified_sources_without_mutating_notes_or_course(review_session):
    client, store, model, course, url = review_session
    material = course["materials"][0]
    quote = "A primary key uniquely identifies a row and cannot be null."
    model.suggestions = [
        proposal("A primary key may be null.", sources=[dict(material_id=material["id"], page=1, quote=quote)]),
        proposal("This relation have two rows.", category="english"),
        proposal("Normalization always makes queries faster."),
    ]
    content = "😀 A primary key may be null.\n" + "这是中间内容。" * 100 + "\nThis relation have two rows.\nNormalization always makes queries faster."
    before = store.course(course["id"])
    response = review(client, url, course, content)
    assert response.status_code == 200, response.text
    suggestions = response.json()["suggestions"]
    assert [entry["category"] for entry in suggestions] == ["knowledge_logic", "english", "uncertain"]
    assert suggestions[0]["from"] == 3  # Emoji occupies two browser UTF-16 units.
    assert suggestions[0]["sources"][0]["quote"] == quote
    assert suggestions[0]["sources"][0]["name"] == material["name"]
    assert json.dumps(content, ensure_ascii=False) in model.prompts[0]
    assert store.course(course["id"]) == before
    assert model.configurations[0]["model"] == "gpt-6-luna"
    assert model.configurations[0]["reasoning_effort"] == "medium"
    settings = store.settings()
    assert settings["model"] == "gpt-6.1-terra" and settings["reasoning_effort"] == "high"


def test_invalid_or_uncertain_citations_are_never_presented_as_verified_knowledge(review_session):
    client, store, model, course, url = review_session
    material = course["materials"][0]
    model.suggestions = [proposal("A false claim.", sources=[dict(material_id=material["id"], page=1, quote="invented quotation")])]
    response = review(client, url, course, "A false claim.")
    assert response.status_code == 200
    result = response.json()
    assert result["suggestions"][0]["category"] == "uncertain"
    assert result["suggestions"][0]["sources"] == []
    assert result["warnings"]
    with store.edit(course["id"]) as (current, _):
        current["materials"][0]["pages"][0]["uncertain"] = True
    course = store.course(course["id"])
    model.suggestions[0]["sources"][0]["quote"] = "A primary key uniquely identifies a row and cannot be null."
    uncertain = review(client, url, course, "A false claim.").json()["suggestions"][0]
    assert uncertain["category"] == "uncertain" and uncertain["sources"][0]["uncertain"] is True


@pytest.mark.parametrize(("content", "original"), [("repeated repeated", "repeated"), ("aaa", "aa"), ("real sentence", "invented sentence")])
def test_ambiguous_or_missing_original_cannot_be_applied(review_session, content, original):
    client, _, model, course, url = review_session
    model.suggestions = [proposal(original)]
    response = review(client, url, course, content)
    assert response.status_code == 200
    assert response.json()["suggestions"] == []
    assert response.json()["warnings"]


def test_course_change_during_ai_work_rejects_result_and_preserves_newer_user_state(review_session):
    client, store, model, course, url = review_session

    def change_course():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["personal_note"] = "newer saved note"

    model.during_request = change_course
    response = review(client, url, course, "old draft")
    assert response.status_code == 409
    assert store.course(course["id"])["nodes"][0]["personal_note"] == "newer saved note"


def test_disabled_or_failed_provider_preserves_note_and_allows_normal_save(review_session):
    client, store, model, course, url = review_session
    client.post("/api/settings", json={"ai_enabled": False})
    assert review(client, url, course, "my draft").status_code == 400
    assert not model.prompts
    client.post("/api/settings", json={"ai_enabled": True})

    def unavailable():
        raise AIUnavailable("provider unavailable")

    model.during_request = unavailable
    assert review(client, url, course, "my draft").status_code == 503
    saved = client.put(url.removesuffix("/review"), json={"content": "my draft", "expected": ""})
    assert saved.status_code == 200
    assert store.course(course["id"])["nodes"][0]["personal_note"] == "my draft"


def test_note_model_settings_are_independent_and_thread_reuse_respects_revision(review_session):
    client, store, model, course, url = review_session
    response = client.post("/api/settings", json={"note_review_model": "gpt-6-luna"})
    assert response.json()["model"] == "gpt-6.1-terra"
    assert response.json()["reasoning_effort"] == "high"
    review(client, url, course, "first draft").raise_for_status()
    review(client, url, course, "first draft").raise_for_status()
    assert model.options[1]["thread_id"] == "note-review-thread"
    assert "笔记检查" in model.options[1]["conversation"].title
    review(client, url, course, "second draft").raise_for_status()
    assert "thread_id" not in model.options[-1]
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["personal_note"] = "restored or edited note"
    newer = store.course(course["id"])
    review(client, url, newer, "third draft").raise_for_status()
    assert "thread_id" not in model.options[-1]


def test_strict_pdf_review_never_cites_or_receives_other_material_sources(review_session):
    client, store, model, course, url = review_session
    selected = course["materials"][0]
    with store.edit(course["id"]) as (current, _):
        current["materials"].append(dict(id="outside", name="outside.pdf", kind="pdf", week="", sha256="outside", pages=[dict(number=1, text="OUTSIDE_SECRET", uncertain=False)]))
        current["nodes"][0]["sources"].append(dict(material_id="outside", page=1, quote="OUTSIDE_SECRET"))
    base = f"/api/courses/{course['id']}"
    client.post(base + "/review-scope", json={"enabled": True, "material_ids": [selected["id"]], "ai_scope": "selected"}).raise_for_status()
    scoped = store.course(course["id"])
    model.suggestions = [proposal("Claim.", sources=[dict(material_id="outside", page=1, quote="OUTSIDE_SECRET")])]
    response = review(client, url, scoped, "Claim.")
    assert response.status_code == 200, response.text
    assert "OUTSIDE_SECRET" not in model.prompts[-1]
    assert response.json()["suggestions"][0]["sources"] == []
    assert response.json()["suggestions"][0]["category"] == "uncertain"


def test_named_notes_require_node_binding_and_keep_separate_review_threads(review_session):
    client, store, model, course, url = review_session
    base = f"/api/courses/{course['id']}/notes"
    first, second = course["nodes"][0]["id"], course["nodes"][1]["id"]
    for title, node in [("first", first), ("second", first), ("other node", second)]:
        response = client.post(base, json={"title": title, "node_ids": [node], "content": "same draft"})
        assert response.status_code == 200
    current = store.course(course["id"])
    notes = current["notes"]
    before = store.course(course["id"])
    for note in notes[:2]:
        response = client.post(url, json=dict(content="same draft", revision=current["revision"], request_id="named", note_id=note["id"]))
        assert response.status_code == 200, response.text
        assert response.json()["note_id"] == note["id"]
        assert "thread_id" not in model.options[-1]
    refused = client.post(url, json=dict(content="same draft", revision=current["revision"], request_id="named", note_id=notes[2]["id"]))
    assert refused.status_code == 404
    assert len(model.prompts) == 2
    assert store.course(course["id"]) == before
