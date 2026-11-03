"""AI-generated lines, retelling, strict review scope, and progress aggregation."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class Model:
    def __init__(self):
        self.replies = []
        self.prompts = []
        self.before_reply = None

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        if self.before_reply:
            self.before_reply()
        reply = self.replies.pop(0)
        return {"text": json.dumps(reply, ensure_ascii=False), "thread_id": "line-thread"}


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def valid_draft(node_ids):
    ids = node_ids[:2]
    return {"lines": [{
        "name": "从数据到决策", "goal": "用数据支持决策", "node_ids": ids,
        "endpoint": "能比较方案并作出选择",
        "story": [{"node_id": node_id, "text": f"这一站解释 {node_id}"} for node_id in ids],
    }], "summary": "课程概述", "abilities": ["能够分析问题"]}


def test_ai_generation_preserves_user_lines_and_returns_unified_progress(session):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    user_line = client.post(base + "/lines", json={"name": "我自己的线", "node_ids": ids[2:]}).json()["lines"][0]
    current = store.course(course["id"])
    with store.edit(course["id"]) as (saved, _):
        saved["nodes"][0]["pieces"] = [
            {"id": "p1", "title": "定义"},
            {"id": "p2", "title": "方法"},
        ]
        saved["piece_checks"] = {
            "p1": {"result": "known", "at": "2026-11-03T00:00:00+00:00", "via": "check"},
            "p2": {"result": "unsure", "at": "2026-11-03T00:00:01+00:00", "via": "check"},
        }
    model.replies.append(valid_draft(ids))
    response = client.post(base + "/lines/generate")
    assert response.status_code == 200, response.text
    result = response.json()
    assert any(line["id"] == user_line["id"] and line["origin"] == "user" for line in result["lines"])
    generated = next(line for line in result["lines"] if line["origin"] == "ai")
    assert generated["progress"]["done"] == 1
    assert generated["progress"]["total"] == 3
    assert generated["progress"]["ratio"] == pytest.approx(1 / 3)
    assert generated["progress"]["nodes"] == {"done": 0, "total": 2, "ratio": 0}
    assert generated["progress"]["pieces"] == {"known": 1, "total": 2, "ratio": 0.5}
    assert result["progress"]["done"] == 1
    assert result["progress"]["total"] == 5
    assert result["progress"]["ratio"] == 0.2
    assert result["progress"]["pieces"] == {"known": 1, "total": 2, "ratio": 0.5}
    assert result["progress"]["nodes"] == {"known": 0, "done": 0, "total": 4, "ratio": 0}
    assert result["nodes"][0]["progress"] == {"known": 1, "total": 2, "ratio": 0.5, "done": False}
    assert result["nodes"][1]["progress"] == {"known": 0, "total": 1, "ratio": 0, "done": False}
    assert result["overview"]["summary"] == "课程概述"
    assert store.course(course["id"])["revision"] == result["revision"]
    assert current["revision"] < result["revision"]


@pytest.mark.parametrize("mutate", [
    lambda draft, ids: draft["lines"][0].update(node_ids=[ids[0], "unknown"]),
    lambda draft, ids: draft["lines"][0].update(name="   "),
    lambda draft, ids: draft["lines"][0].update(story=[]),
    lambda draft, ids: draft["lines"][0]["story"][0].update(text="  "),
    lambda draft, ids: draft["lines"][0].update(story=[{"node_id": ids[1], "text": "错序"}, draft["lines"][0]["story"][1]]),
])
def test_invalid_ai_line_results_are_rejected_atomically(session, mutate):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    before = store.course(course["id"])
    draft = valid_draft([node["id"] for node in course["nodes"]])
    mutate(draft, [node["id"] for node in course["nodes"]])
    model.replies.append(draft)
    response = client.post(base + "/lines/generate")
    assert response.status_code == 400
    assert store.course(course["id"]) == before


def test_generation_revision_conflict_keeps_newer_user_state_and_lines(session):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    user_line = client.post(base + "/lines", json={"name": "保留此线", "node_ids": ids[:2]}).json()["lines"][0]
    model.replies.append(valid_draft(ids))

    def concurrent_edit():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["personal_note"] = "并发保存的新笔记"

    model.before_reply = concurrent_edit
    response = client.post(base + "/lines/generate")
    assert response.status_code == 409
    saved = store.course(course["id"])
    assert saved["nodes"][0]["personal_note"] == "并发保存的新笔记"
    assert [line["id"] for line in saved["lines"]] == [user_line["id"]]
    assert "overview" not in saved


def test_strict_review_hides_course_lines_and_rejects_line_ai_without_calling_model(session):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    client.post(base + "/lines", json={"name": "全课程线", "node_ids": ids[:2]}).raise_for_status()
    with store.edit(course["id"]) as (current, _):
        current["materials"] = [{"id": "selected-pdf", "kind": "pdf", "name": "选中材料", "sha256": "x"}]
        current["nodes"][0]["sources"] = [dict(material_id="selected-pdf", page=1, quote="selected")]
        current["nodes"][1]["sources"] = [dict(material_id="other-pdf", page=1, quote="unselected")]
        current["nodes"][0]["pieces"] = [
            {"id": "selected-piece", "title": "选中块", "sources": [dict(material_id="selected-pdf", page=1)]},
            {"id": "excluded-piece", "title": "未选块", "sources": [dict(material_id="other-pdf", page=1)]},
        ]
        current["piece_checks"] = {
            "selected-piece": {"result": "known", "at": "2026-11-03T00:00:00+00:00", "via": "check"},
            "excluded-piece": {"result": "known", "at": "2026-11-03T00:00:01+00:00", "via": "check"},
        }
        current["review_scope"] = {"enabled": True, "material_ids": ["selected-pdf"], "ai_scope": "selected"}
    projected = client.get(base).json()
    assert projected["lines"] == []
    assert projected["progress"]["done"] == 1
    assert projected["progress"]["total"] == 1
    assert projected["progress"]["pieces"] == {"known": 1, "total": 1, "ratio": 1}
    assert projected["nodes"][0]["progress"] == {"known": 1, "total": 1, "ratio": 1, "done": True}
    assert "overview" not in projected
    before_prompts = list(model.prompts)
    assert client.post(base + "/lines/generate").status_code == 400
    assert client.post(base + f"/lines/{store.course(course['id'])['lines'][0]['id']}/retell", json={"text": "讲述"}).status_code == 400
    assert model.prompts == before_prompts


def test_retell_rejects_out_of_line_ai_nodes_and_does_not_save(session):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    line = client.post(base + "/lines", json={"name": "局部线", "node_ids": ids[:2]}).json()["lines"][0]
    before = store.course(course["id"])
    model.replies.append({"covered": [ids[2]], "missing": [], "feedback": "很好"})
    response = client.post(base + f"/lines/{line['id']}/retell", json={"text": "讲述"})
    assert response.status_code == 400
    assert store.course(course["id"]) == before


def test_valid_retell_is_saved_in_existing_record_shape(session):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    line = client.post(base + "/lines", json={"name": "局部线", "node_ids": ids[:2]}).json()["lines"][0]
    model.replies.append({"covered": [ids[0]], "missing": [{"node_id": ids[1], "note": "尚未解释两站间的联系"}], "feedback": "讲清了第一站，再补上两站之间的联系。"})
    response = client.post(base + f"/lines/{line['id']}/retell", json={"text": "我的串讲"})
    assert response.status_code == 200, response.text
    saved = store.course(course["id"])["lines"][0]["retells"][-1]
    assert saved["text"] == "我的串讲"
    assert saved["review"] == {"covered": [ids[0]], "missing": [{"node_id": ids[1], "note": "尚未解释两站间的联系"}], "feedback": "讲清了第一站，再补上两站之间的联系。"}


@pytest.mark.parametrize("protected_by", ["note", "retell"])
def test_regeneration_keeps_ai_lines_with_anchored_notes_or_retells(session, protected_by):
    client, store, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    model.replies.append(valid_draft(ids))
    first = client.post(base + "/lines/generate").json()
    protected = next(line for line in first["lines"] if line["origin"] == "ai")
    if protected_by == "note":
        note = client.post(base + "/notes", json={
            "title": "线路笔记", "node_ids": protected["node_ids"],
            "anchor": {"kind": "line", "id": protected["id"]},
        })
        assert note.status_code == 200, note.text
    else:
        model.replies.append({"covered": protected["node_ids"], "missing": [], "feedback": "串讲完整。"})
        client.post(base + f"/lines/{protected['id']}/retell", json={"text": "完整串讲"}).raise_for_status()
    model.replies.append(valid_draft(ids[1:]))
    regenerated = client.post(base + "/lines/generate")
    assert regenerated.status_code == 200, regenerated.text
    saved = store.course(course["id"])
    old_line = next(line for line in saved["lines"] if line["id"] == protected["id"])
    if protected_by == "note":
        assert any(note["anchor"] == {"kind": "line", "id": protected["id"]} for note in saved["notes"])
    else:
        assert old_line["retells"][0]["text"] == "完整串讲"
    assert len([line for line in saved["lines"] if line["origin"] == "ai"]) == 2



def test_ai_regeneration_does_not_duplicate_a_user_line(session):
    client, _, model, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    original = client.post(base + "/lines", json={"name": "自己的线", "node_ids": ids[:2]}).json()["lines"][0]
    model.replies.append(valid_draft(ids))
    response = client.post(base + "/lines/generate")
    assert response.status_code == 200
    assert [line["id"] for line in response.json()["lines"]] == [original["id"]]
