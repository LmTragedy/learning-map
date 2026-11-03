"""Knowledge bridges: migrated reading of old relationships, AI filling, user edits and checks."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.relations import relations_for_node


class Model:
    def __init__(self):
        self.replies, self.prompts = [], []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        return {"text": reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False), "thread_id": "t"}


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def draft_bridge(piece="传递性", step="验证偏好能被表示", **overrides):
    return {"piece": {"kind": "性质", "title": piece, "detail": "x≿y 且 y≿z 则 x≿z", "sources": []},
            "step": step, "how": "逐条检查两条性质", "if_missing": "看不出循环偏好为何不能打分",
            "strength": "required", "check_question": "x≿y、y≿z 能推出什么？", "check_answer": "x≿z",
            "sources": [], "uncertain": True, **overrides}


def test_old_relationships_read_as_one_stable_required_bridge_without_rewriting(session):
    client, store, _, course = session
    edge = course["edges"][0]
    assert edge["kind"] == "用到"
    assert [bridge["strength"] for bridge in edge["bridges"]] == ["required"]
    assert edge["bridges"][0]["id"] == f"{edge['id']}:legacy"
    assert edge["bridges"][0]["legacy"] is True
    assert "bridges" not in store.course(course["id"])["edges"][0]
    assert client.get(f"/api/courses/{course['id']}").json()["edges"][0]["bridges"][0]["id"] == edge["bridges"][0]["id"]


def test_placeholder_explanations_never_reach_the_ai(session):
    client, store, model, course = session
    stored = store.course(course["id"])
    target = stored["nodes"][1]
    assert relations_for_node(stored, target) == []
    model.replies.append("好的")
    client.post(f"/api/courses/{course['id']}/nodes/{target['id']}/chat", json={"message": "这一步看不懂"})
    assert "旧版关系未记录" not in model.prompts[-1]


def test_backfill_writes_pieces_steps_and_bridges_and_keeps_progress(session):
    client, store, model, course = session
    client.post(f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/mark", json={"status": "studied"})
    course = client.get(f"/api/courses/{course['id']}").json()
    pending = [edge for edge in course["edges"] if edge["bridges"][0].get("legacy")]
    nodes = [{"id": node["id"], "pieces": [{"kind": "定义", "title": "关系", "detail": "元组的集合", "sources": []}],
              "steps": ["写出模式", "验证偏好能被表示"]} for node in course["nodes"]]
    model.replies.append({"nodes": nodes, "relations": [{"id": edge["id"], "bridges": [draft_bridge()]} for edge in pending]
                          + [{"id": "unknown", "bridges": [draft_bridge()]}]})
    response = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert response.status_code == 200, response.text
    updated = response.json()
    edge = next(item for item in updated["edges"] if item["id"] == pending[0]["id"])
    source = next(node for node in updated["nodes"] if node["id"] == edge["source"])
    target = next(node for node in updated["nodes"] if node["id"] == edge["target"])
    bridge = edge["bridges"][0]
    assert bridge["strength"] == "required" and bridge["check"]["answer"] == "x≿z"
    assert bridge["from_piece"] in {piece["id"] for piece in source["pieces"]}
    assert any(piece["title"] == "传递性" for piece in source["pieces"])
    assert bridge["to_step"] in {step["id"] for step in target["steps"]}
    assert edge["explanation"].startswith("用到了什么：性质·传递性")
    assert [n["prerequisites"] for n in updated["nodes"]] == [n["prerequisites"] for n in course["nodes"]]
    assert updated["nodes"][0]["status"] == "studied"
    assert pending[0]["id"] in model.prompts[0]
    assert any(version["reason"] == "补充知识桥前自动备份" for version in client.get(f"/api/courses/{course['id']}/versions").json())
    again = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": updated["revision"]})
    assert again.status_code == 400


def test_backfill_keeps_bridges_the_user_wrote_meanwhile(session):
    client, store, model, course = session
    edge = course["edges"][0]

    def user_edits_meanwhile(prompt, **options):
        with store.edit(course["id"]) as (current, _):
            next(e for e in current["edges"] if e["id"] == edge["id"])["bridges"] = []
        return {"text": json.dumps({"nodes": [], "relations": [{"id": e["id"], "bridges": [draft_bridge()]} for e in course["edges"]]},
                                   ensure_ascii=False), "thread_id": "t"}

    model.ask = user_edits_meanwhile
    response = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert response.status_code == 200, response.text
    assert next(e for e in response.json()["edges"] if e["id"] == edge["id"])["bridges"] == []
    stale = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert stale.status_code == 409


def test_user_edits_pieces_and_bridges_and_records_checks(session):
    client, _, _, course = session
    edge = course["edges"][0]
    base = f"/api/courses/{course['id']}"
    pieces = client.put(f"{base}/nodes/{edge['source']}/pieces", json={
        "revision": course["revision"],
        "pieces": [{"kind": "性质", "title": "传递性", "detail": ""}], "steps": [],
    })
    assert pieces.status_code == 200, pieces.text
    course = pieces.json()
    steps = client.put(f"{base}/nodes/{edge['target']}/pieces", json={
        "revision": course["revision"], "pieces": [], "steps": [{"title": "第一步"}],
    }).json()
    piece_id = next(n for n in steps["nodes"] if n["id"] == edge["source"])["pieces"][0]["id"]
    step_id = next(n for n in steps["nodes"] if n["id"] == edge["target"])["steps"][0]["id"]
    bad = client.put(f"{base}/relations/{edge['id']}/bridges", json={
        "revision": steps["revision"],
        "bridges": [{"from_piece": step_id, "to_step": step_id, "how": "用", "strength": "required"}],
    })
    assert bad.status_code == 400
    saved = client.put(f"{base}/relations/{edge['id']}/bridges", json={
        "revision": steps["revision"],
        "bridges": [{"from_piece": piece_id, "to_step": step_id, "how": "用传递性排序", "strength": "suggested",
                     "check": {"question": "能推出什么？", "answer": "x≿z"}}],
    })
    assert saved.status_code == 200, saved.text
    bridge = next(e for e in saved.json()["edges"] if e["id"] == edge["id"])["bridges"][0]
    assert bridge["origin"] == "user" and bridge["strength"] == "suggested"
    stale = client.put(f"{base}/relations/{edge['id']}/bridges", json={"revision": steps["revision"], "bridges": []})
    assert stale.status_code == 409
    checked = client.post(f"{base}/relations/{edge['id']}/bridges/{bridge['id']}/check", json={"result": "known", "answer": "由传递性可得 x≿z"}).json()
    after = next(e for e in checked["edges"] if e["id"] == edge["id"])["bridges"][0]
    assert after["state"]["result"] == "known"
    piece = next(n for n in checked["nodes"] if n["id"] == edge["source"])["pieces"][0]
    assert piece["state"]["result"] == "known"
    assert piece["state"]["answer"] == "由传递性可得 x≿z"
    direct = client.post(f"{base}/nodes/{edge['source']}/pieces/{piece_id}/check", json={"result": "unsure"}).json()
    assert next(n for n in direct["nodes"] if n["id"] == edge["source"])["pieces"][0]["state"]["result"] == "unsure"
    missing = client.post(f"{base}/relations/{edge['id']}/bridges/nope/check", json={"result": "known"})
    assert missing.status_code == 404


def test_generated_map_brings_pieces_steps_and_prerequisite_bridges(session):
    client, _, model, course = session
    material = course["materials"][0]
    quote = material["pages"][0]["text"].splitlines()[0]
    source = [{"material_id": material["id"], "page": 1, "quote": quote}]
    model.replies.append({"nodes": [
        {"key": "a", "title": "偏好关系", "summary": "偏好", "week": "", "sources": source, "prerequisites": [],
         "uncertain": False, "pieces": [{"kind": "性质", "title": "传递性", "detail": "", "sources": []}],
         "steps": ["写出定义"], "bridges": []},
        {"key": "b", "title": "效用函数", "summary": "效用", "week": "", "sources": source, "prerequisites": ["a"],
         "uncertain": False, "pieces": [], "steps": ["验证偏好能被表示"],
         "bridges": [dict(draft_bridge(), from_key="a"), dict(draft_bridge(), from_key="zzz")]},
    ], "relations": []})
    model.replies[-1]["relations"] = [dict(
        source="a", target="b", relation="工具关系", explanation="用传递性检验偏好", when_to_use="建模时",
        basis="定义推断", evidence_kind="ai_inference", sources=[], uncertain=True,
        forward_difficulty="初始估计", reverse_difficulty="初始估计", bridges=[draft_bridge()],
    )]
    response = client.post(f"/api/courses/{course['id']}/generate")
    assert response.status_code == 200, response.text
    generated = response.json()
    a = next(node for node in generated["nodes"] if node["title"] == "偏好关系")
    b = next(node for node in generated["nodes"] if node["title"] == "效用函数")
    edge = next(item for item in generated["edges"] if item["source"] == a["id"] and item["target"] == b["id"])
    assert len(edge["bridges"]) == 1 and not edge["bridges"][0].get("legacy")
    assert edge["bridges"][0]["from_piece"] == a["pieces"][0]["id"]
    assert edge["bridges"][0]["to_step"] == b["steps"][0]["id"]
    explicit = next(e for e in generated["edges"] if e["relation"] == "工具关系")
    assert explicit["bridges"][0]["from_piece"] == a["pieces"][0]["id"]
    assert not explicit["bridges"][0].get("legacy")


def judgment(outcome, missing=()):
    return {"outcome": outcome, "reasoning": "r", "blockers": [], "next_step": "n", "missing_bridges": list(missing)}


def test_failed_practice_marks_the_blamed_bridge_and_a_pass_confirms_required_ones(session):
    client, _, model, course = session
    edge = course["edges"][0]
    legacy_id = edge["bridges"][0]["id"]
    base = f"/api/courses/{course['id']}/nodes/{edge['target']}/attempts"
    model.replies.append(judgment("failed", [legacy_id, "not-a-bridge"]))
    failed = client.post(base, data={"answer": "我的作答"})
    assert failed.status_code == 200, failed.text
    assert "进站知识桥" in model.prompts[-1] and legacy_id in model.prompts[-1]
    updated = failed.json()
    attempt = next(n for n in updated["nodes"] if n["id"] == edge["target"])["attempts"][-1]
    assert attempt["judgment"]["missing_bridges"] == [legacy_id]
    bridge = next(e for e in updated["edges"] if e["id"] == edge["id"])["bridges"][0]
    assert bridge["state"]["result"] == "missing" and bridge["state"]["via"] == "attempt"
    model.replies.append(judgment("passed", [legacy_id]))
    passed = client.post(base, data={"answer": "再答一次"}).json()
    attempt = next(n for n in passed["nodes"] if n["id"] == edge["target"])["attempts"][-1]
    assert attempt["judgment"]["missing_bridges"] == []
    assert next(e for e in passed["edges"] if e["id"] == edge["id"])["bridges"][0]["state"]["result"] == "known"


def test_backfill_does_not_send_full_course_from_selected_pdf_review(session):
    client, store, model, course = session
    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = dict(enabled=True, material_ids=[course["materials"][0]["id"]], ai_scope="selected")
    current = store.course(course["id"])
    response = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": current["revision"]})
    assert response.status_code == 400
    assert model.prompts == []
    assert store.course(course["id"])["revision"] == current["revision"]


def test_strict_review_hides_bridge_and_piece_content_from_other_materials(session):
    client, store, _, course = session
    mid = course["materials"][0]["id"]
    selected_source = dict(material_id=mid, page=1, quote="")
    outside_source = dict(material_id="outside", page=1, quote="excluded")
    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = dict(enabled=True, material_ids=[mid], ai_scope="selected")
        current["nodes"][0]["pieces"] = [
            dict(id="p-in", kind="定义", title="选定内容", detail="", sources=[selected_source]),
            dict(id="p-out", kind="方法", title="范围外内容", detail="", sources=[outside_source]),
        ]
        edge = current["edges"][0]
        edge.update(evidence_kind="material_quote", sources=[selected_source], bridges=[
            dict(id="b-out", from_piece="p-out", to_step="", how="范围外推导", if_missing="", strength="required",
                 check=dict(question="q", answer="a"), sources=[outside_source], origin="ai", uncertain=True),
        ])
    projected = client.get(f"/api/courses/{course['id']}").json()
    assert all(edge["id"] != course["edges"][0]["id"] for edge in projected["edges"])
    assert [piece["id"] for piece in projected["nodes"][0]["pieces"]] == ["p-in"]
    assert projected["progress"]["pieces"]["total"] == 1


def test_backfill_preserves_legacy_gap(session):
    client, store, model, course = session
    edge = course["edges"][0]
    base = f"/api/courses/{course['id']}"
    current = client.post(f"{base}/relations/{edge['id']}/bridges/{edge['bridges'][0]['id']}/check", json={"result": "unsure"}).json()
    model.replies.append({"nodes": [], "relations": [{"id": e["id"], "bridges": [draft_bridge()]} for e in course["edges"]]})
    response = client.post(f"{base}/relations/backfill", json={"revision": current["revision"]})
    assert response.status_code == 200
    replacement = response.json()["edges"][0]["bridges"][0]
    assert replacement["id"] == edge["bridges"][0]["id"]
    assert replacement["state"]["result"] == "unsure"


@pytest.mark.parametrize("mode", ["omitted", "changed"])
def test_incomplete_or_stale_backfill_does_not_write_bridges(session, mode):
    client, store, model, course = session
    def response(prompt, **options):
        if mode == "changed":
            with store.edit(course["id"]) as (current, _):
                current["edges"][0]["explanation"] = "用户刚写的新解释"
        relations = course["edges"][:1] if mode == "omitted" else course["edges"]
        return {"text": json.dumps({"nodes": [], "relations": [{"id": e["id"], "bridges": [draft_bridge()]} for e in relations]}), "thread_id": "t"}
    model.ask = response
    result = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert result.status_code == (400 if mode == "omitted" else 409)
    assert all("bridges" not in e for e in store.course(course["id"])["edges"])


@pytest.mark.parametrize("payload", [
    {"pieces": [{"id": "p", "kind": "定义", "title": "a"}, {"id": "p", "kind": "定义", "title": "b"}], "steps": []},
    {"pieces": [{"kind": "定义", "title": "   "}], "steps": []},
    {"pieces": [], "steps": [{"title": "   "}]},
])
def test_invalid_piece_edits_leave_course_unchanged(session, payload):
    client, store, _, course = session
    response = client.put(f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/pieces", json={"revision": course["revision"], **payload})
    assert response.status_code == 422
    assert store.course(course["id"])["revision"] == course["revision"]


def test_synthesis_from_old_relation_does_not_send_placeholder_to_ai(session):
    client, _, model, course = session
    base = f"/api/courses/{course['id']}"
    response = client.post(f"{base}/relations/{course['edges'][0]['id']}/presentation", json={"revision": course["revision"], "presentation": "synthesis"})
    assert response.status_code == 200
    synthesis = next(node for node in response.json()["nodes"] if node.get("kind") == "synthesis")
    model.replies.append("可以先连接两站的定义。")
    chat = client.post(f"{base}/nodes/{synthesis['id']}/chat", json={"message": "解释综合关系"})
    assert chat.status_code == 200
    assert "旧版关系未记录" not in model.prompts[-1]
