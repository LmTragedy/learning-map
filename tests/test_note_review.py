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


def test_autosave_during_ai_work_keeps_the_check_and_preserves_newer_user_state(review_session):
    client, store, model, course, url = review_session

    def autosave():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["personal_note"] = "newer saved note"

    model.during_request = autosave
    response = review(client, url, course, "old draft")
    assert response.status_code == 200
    assert store.course(course["id"])["nodes"][0]["personal_note"] == "newer saved note"
    # A stale revision from the client is fine too: the draft itself is what gets checked.
    model.during_request = None
    assert review(client, url, course, "old draft again").status_code == 200


@pytest.mark.parametrize("resume_via", ["recover", "same_request"])
@pytest.mark.parametrize("saved_node", [0, 1])
def test_received_reply_survives_unrelated_course_revision_without_regeneration(
        review_session, monkeypatch, resume_via, saved_node):
    client, store, model, course, url = review_session
    from backend import note_review

    original_anchor = note_review.anchored_suggestions
    attempts = 0

    def fail_once(*args):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary result processing failure")
        return original_anchor(*args)

    monkeypatch.setattr(note_review, "anchored_suggestions", fail_once)
    with pytest.raises(RuntimeError, match="temporary result processing failure"):
        review(client, url, course, "saved draft")
    assert len(model.prompts) == 1

    with store.edit(course["id"]) as (current, _):
        current["nodes"][saved_node]["personal_note"] = "newer autosaved note"

    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    task = next(task for task in tasks if task["kind"] == "note_review")
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["thread_id"] == "note-review-thread"

    if resume_via == "recover":
        response = client.post(f"/api/courses/{course['id']}/ai-tasks/{task['id']}/recover")
    else:
        response = review(client, url, course, "saved draft")
    assert response.status_code == 200, response.text
    assert len(model.prompts) == 1
    assert store.course(course["id"])["nodes"][saved_node]["personal_note"] == "newer autosaved note"


def test_received_reply_is_retained_when_review_scope_changes(review_session):
    client, store, model, course, url = review_session
    material_id = course["materials"][0]["id"]

    def change_scope():
        with store.edit(course["id"]) as (current, _):
            current["review_scope"] = dict(enabled=True, ai_scope="selected", material_ids=[material_id])

    model.during_request = change_scope
    response = review(client, url, course, "draft")
    assert response.status_code == 409
    assert len(model.prompts) == 1

    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    task = next(task for task in tasks if task["kind"] == "note_review")
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["thread_id"] == "note-review-thread"
    recovered = client.post(f"/api/courses/{course['id']}/ai-tasks/{task['id']}/recover")
    assert recovered.status_code == 409
    assert len(model.prompts) == 1
    retained = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert retained["raw_reply"]["thread_id"] == "note-review-thread"


def test_applied_review_receipt_does_not_replay_after_scope_changes(review_session):
    client, store, model, course, url = review_session
    content = "same draft"
    first = review(client, url, course, content)
    assert first.status_code == 200, first.text
    material_id = course["materials"][0]["id"]

    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = dict(enabled=True, ai_scope="selected", material_ids=[material_id])

    repeated = review(client, url, course, content)
    assert repeated.status_code == 409
    assert len(model.prompts) == 1


def test_applied_named_note_receipt_does_not_replay_after_note_is_deleted(review_session):
    client, store, model, course, url = review_session
    node_id = course["nodes"][0]["id"]
    created = client.post(
        f"/api/courses/{course['id']}/notes",
        json={"title": "Draft", "node_ids": [node_id], "content": "draft"},
    )
    assert created.status_code == 200, created.text
    note_id = created.json()["notes"][-1]["id"]
    request = dict(
        content="named draft", revision=store.course(course["id"])["revision"],
        request_id="named-review", note_id=note_id,
    )
    first = client.post(url, json=request)
    assert first.status_code == 200, first.text

    with store.edit(course["id"]) as (current, _):
        current["notes"] = [note for note in current["notes"] if note["id"] != note_id]

    repeated = client.post(url, json=request)
    assert repeated.status_code == 404
    assert len(model.prompts) == 1


@pytest.mark.parametrize("change", ["delete", "unbind"])
def test_named_note_deleted_or_unbound_during_review_is_rejected(review_session, change):
    client, store, model, course, url = review_session
    node_id = course["nodes"][0]["id"]
    created = client.post(
        f"/api/courses/{course['id']}/notes",
        json={"title": "Draft", "node_ids": [node_id], "content": "draft"},
    )
    assert created.status_code == 200, created.text
    note_id = created.json()["notes"][-1]["id"]

    def remove_or_unbind():
        with store.edit(course["id"]) as (current, _):
            if change == "delete":
                current["notes"] = [note for note in current["notes"] if note["id"] != note_id]
            else:
                next(note for note in current["notes"] if note["id"] == note_id)["node_ids"] = []

    model.during_request = remove_or_unbind
    response = client.post(url, json=dict(
        content="named draft", revision=store.course(course["id"])["revision"],
        request_id="named-review", note_id=note_id,
    ))
    assert response.status_code == 404
    assert len(model.prompts) == 1
    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    task = next(task for task in tasks if task["kind"] == "note_review")
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["thread_id"] == "note-review-thread"


def test_review_scope_change_during_ai_work_rejects_result(review_session):
    client, store, model, course, url = review_session
    material = course["materials"][0]["id"] if course.get("materials") else None
    if material is None:
        pytest.skip("sample course has no materials")

    def narrow_scope():
        with store.edit(course["id"]) as (current, _):
            current["review_scope"] = {**current.get("review_scope", {}), "enabled": True, "ai_scope": "selected", "material_ids": [material]}

    model.during_request = narrow_scope
    assert review(client, url, course, "old draft").status_code == 409


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


def test_note_settings_are_independent_and_changed_drafts_share_review_conversation(review_session):
    client, store, model, course, url = review_session
    response = client.post("/api/settings", json={"note_review_model": "gpt-6-luna"})
    assert response.json()["model"] == "gpt-6.1-terra"
    assert response.json()["reasoning_effort"] == "high"
    review(client, url, course, "first draft").raise_for_status()
    review(client, url, course, "first draft").raise_for_status()
    assert len(model.options) == 1  # Reopening the same completed check does not generate another turn.
    assert "笔记检查" in model.options[0]["conversation"].title
    review(client, url, course, "second draft").raise_for_status()
    assert model.options[-1]["thread_id"] == "note-review-thread"
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["personal_note"] = "restored or edited note"
    newer = store.course(course["id"])
    review(client, url, newer, "third draft").raise_for_status()
    assert model.options[-1]["thread_id"] == "note-review-thread"


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


@pytest.mark.parametrize("change", ["scope", "model"])
def test_review_metadata_rejects_old_context_and_accepts_a_new_receipt(review_session, change):
    from backend.review_scope import scope_key

    client, store, model, course, url = review_session
    request = dict(content="same draft", revision=course["revision"], request_id="initial-ui",
                   scope_key="course", model="gpt-6-luna")
    headers = {"X-AI-Request-ID": "note-metadata-initial"}
    assert client.post(url, json=request, headers=headers).status_code == 200
    if change == "scope":
        client.post(f"/api/courses/{course['id']}/review-scope", json=dict(
            enabled=True, ai_scope="selected", material_ids=[course["materials"][0]["id"]],
        )).raise_for_status()
    else:
        client.post("/api/settings", json={"note_review_model": "synthetic-other-model"}).raise_for_status()

    refused = client.post(url, json=request, headers={"X-AI-Request-ID": "note-metadata-stale"})
    assert refused.status_code == 409, refused.text
    assert len(model.prompts) == 1
    request.update(scope_key=scope_key(store.course(course["id"])),
                   model=store.settings()["note_review_model"], request_id="new-ui")
    headers = {"X-AI-Request-ID": "note-metadata-current"}
    current = client.post(url, json=request, headers=headers)
    assert current.status_code == 200, current.text
    assert current.json()["scope_key"] == request["scope_key"]
    assert current.json()["model"] == request["model"]
    repeated = client.post(url, json=request | {"revision": request["revision"] + 10}, headers=headers)
    assert repeated.status_code == 200, repeated.text
    assert len(model.prompts) == 2


def test_restoring_during_note_review_keeps_raw_reply_and_refuses_recovery(review_session):
    client, store, model, course, url = review_session
    base = f"/api/courses/{course['id']}"
    version = client.get(base + "/versions").json()[0]
    token = client.post(base + "/restore-preview", json={"version_id": version["id"]}).json()["token"]
    model.during_request = lambda: store.restore(course["id"], token)
    refused = review(client, url, course, "draft during restore")
    assert refused.status_code == 409, refused.text
    task = next(task for task in client.get(base + "/ai-tasks").json() if task["kind"] == "note_review")
    detail = client.get(base + f"/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["thread_id"] == "note-review-thread"
    assert client.post(base + f"/ai-tasks/{task['id']}/recover").status_code == 409
    assert len(model.prompts) == 1


def test_disabled_ai_can_read_a_saved_check_but_cannot_generate_a_new_one(review_session):
    client, _, model, course, url = review_session
    assert review(client, url, course, "already checked draft").status_code == 200
    client.post("/api/settings", json={"ai_enabled": False}).raise_for_status()
    cached = review(client, url, course, "already checked draft")
    assert cached.status_code == 200, cached.text
    refused = review(client, url, course, "new unchecked draft")
    assert refused.status_code == 400, refused.text
    assert len(model.prompts) == 1
