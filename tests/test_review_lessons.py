import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.store import identity


def lesson_draft():
    return dict(
        title="范围内的小课",
        goal="使用所选资料解释概念。",
        html="<h2>例子</h2><p>从当前选中的资料开始，逐步连接定义、记录结构和实际应用，再用自己的话解释每一步。</p>",
        check_question="如何解释这个概念？",
        check_answer="结合材料中的定义与例子。",
        recap="回看所选资料。",
    )


class LessonModel:
    def __init__(self):
        self.prompts = []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        return {"text": json.dumps(lesson_draft(), ensure_ascii=False), "thread_id": "scoped-lesson"}


def test_strict_review_lesson_excludes_unselected_history_and_preserves_old_lessons(tmp_path):
    model = LessonModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    store = app.state.store
    node_id = course["nodes"][0]["id"]
    first_material = course["materials"][0]
    excluded_material_id = identity()
    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = {
            "enabled": True,
            "material_ids": [first_material["id"]],
            "ai_scope": "selected",
        }
        current["materials"].append(
            dict(
                id=excluded_material_id,
                name="UNSELECTED_SOURCE_SENTINEL.pdf",
                week="",
                kind="pdf",
                sha256="not-a-real-file",
                pages=[dict(number=1, text="UNSELECTED_PAGE_TEXT_SENTINEL", uncertain=False)],
                warnings=[],
            )
        )
        node = current["nodes"][0]
        node["summary"] += " NODE_SUMMARY_SENTINEL"
        node["sources"].append(dict(material_id=excluded_material_id, page=1, quote="UNSELECTED_QUOTE_SENTINEL"))
        node["chats"].append(dict(id="old-chat", role="user", content="OLD_CHAT_SENTINEL", created_at="old"))
        node["attempts"].append(
            dict(id="old-attempt", judgment={"reasoning": "OLD_ATTEMPT_SENTINEL"}, created_at="old")
        )
        node["lessons"] = [
            dict(
                id="old-lesson",
                request_id="old-request-000001",
                title="旧小课",
                goal="OLD_LESSON_SENTINEL",
                recap="旧复习",
                focus="",
                read_at=None,
                sources=[dict(name="OLD_SNAPSHOT_SOURCE_SENTINEL", material_id=excluded_material_id, page=1)],
            )
        ]

    path = f"/api/courses/{course['id']}/nodes/{node_id}/lessons"
    response = client.post(path, json={"request_id": "selected-request-0001", "kind": "initial"})
    assert response.status_code == 200, response.text
    prompt = model.prompts[0]
    for sentinel in (
        "NODE_SUMMARY_SENTINEL",
        "OLD_CHAT_SENTINEL",
        "OLD_ATTEMPT_SENTINEL",
        "OLD_LESSON_SENTINEL",
        "UNSELECTED_SOURCE_SENTINEL",
        "UNSELECTED_PAGE_TEXT_SENTINEL",
        "UNSELECTED_QUOTE_SENTINEL",
        "OLD_SNAPSHOT_SOURCE_SENTINEL",
    ):
        assert sentinel not in prompt

    projected = response.json()["nodes"][0]["lessons"]
    assert len(projected) == 1
    assert projected[0]["review_scope_key"].startswith("pdf:")
    assert projected[0]["material_ids"] == [first_material["id"]]
    raw = store.course(course["id"])["nodes"][0]["lessons"]
    assert [lesson["id"] for lesson in raw] == ["old-lesson", projected[0]["id"]]
    assert raw[0]["sources"][0]["name"] == "OLD_SNAPSHOT_SOURCE_SENTINEL"


def test_course_review_mode_keeps_broad_context_behavior(tmp_path):
    model = LessonModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    store = app.state.store
    node_id = course["nodes"][0]["id"]
    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = {
            "enabled": True,
            "material_ids": [course["materials"][0]["id"]],
            "ai_scope": "course",
        }
        current["nodes"][0]["summary"] += " COURSE_SUMMARY_SENTINEL"
        current["nodes"][0]["chats"].append(
            dict(id="broad-chat", role="user", content="COURSE_CHAT_SENTINEL", created_at="old")
        )

    path = f"/api/courses/{course['id']}/nodes/{node_id}/lessons"
    response = client.post(path, json={"request_id": "course-request-0001", "kind": "initial"})
    assert response.status_code == 200, response.text
    assert "COURSE_SUMMARY_SENTINEL" in model.prompts[0]
    assert "COURSE_CHAT_SENTINEL" in model.prompts[0]
    lesson = response.json()["nodes"][0]["lessons"][0]
    assert lesson["review_scope_key"] == "course"
