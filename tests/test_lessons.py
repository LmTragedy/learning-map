import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.ai import AIError
from backend.app import create_app
from backend.domain import append_chat
from backend.lesson_html import LESSON_CSP
from backend.route import learning_route


def lesson_draft():
    return dict(
        title="关系中的一行",
        goal="用一个选课例子区分一行与一列。",
        html="<h2>看一个例子</h2><p>一个学生选两门课，可以形成两条选课记录。每一行记录一次选课。</p>",
        check_question="同一学生出现两行，是否一定有两个学生？",
        check_answer="不一定，两行可以表示同一学生的两次选课。",
        recap="一行代表一条记录，不能仅凭行数判断不同学生数。",
    )


class LessonModel:
    def __init__(self):
        self.replies = []
        self.before_reply = None

    def ask(self, prompt, **options):
        if self.before_reply:
            self.before_reply()
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return {"text": json.dumps(reply, ensure_ascii=False), "thread_id": "lesson-test-thread"}


@pytest.fixture
def session(tmp_path):
    model = LessonModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def lesson_path(course):
    return f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/lessons"


def generate(client, course, **overrides):
    request = dict(request_id="first-request-0001", kind="initial", focus="") | overrides
    return client.post(lesson_path(course), json=request)


def test_old_course_records_survive_lessons_reading_and_restart(session):
    client, store, model, course = session
    with store.edit(course["id"]) as (current, _):
        node = current["nodes"][0]
        node["status"] = "studied"
        append_chat(node, "user", "我知道一行可能是一次选课。")
    original = store.course(course["id"])
    model.replies.append(lesson_draft())
    generated = generate(client, course)
    assert generated.status_code == 200, generated.text
    lesson = generated.json()["nodes"][0]["lessons"][0]
    assert "html" not in lesson
    assert client.post(lesson_path(course) + f"/{lesson['id']}/read").status_code == 200
    saved = store.course(course["id"])
    assert saved["nodes"][0]["lessons"][0]["read_at"]
    for before, after in zip(original["nodes"], saved["nodes"], strict=True):
        assert {key: after[key] for key in before} == before
    for key in ("edges", "ratings", "suggestions", "preferences", "materials"):
        assert saved[key] == original[key]
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    restarted.post("/api/settings", json={"ai_enabled": False})
    assert "一个学生" in restarted.get(lesson_path(course) + f"/{lesson['id']}/html").text
    reopened = generate(restarted, course, request_id="reopen-request-0002")
    assert reopened.status_code == 200
    assert len(reopened.json()["nodes"][0]["lessons"]) == 1
    assert not reopened.json()["nodes"][1]["unlocked"]


def test_read_can_be_undone_and_persists_without_changing_learning_records(session):
    client, store, model, course = session
    model.replies.append(lesson_draft())
    lesson = generate(client, course).json()["nodes"][0]["lessons"][0]
    path = lesson_path(course) + f"/{lesson['id']}/read"
    before = store.course(course["id"])

    marked = client.post(path)
    assert marked.status_code == 200, marked.text
    read_at = marked.json()["nodes"][0]["lessons"][0]["read_at"]
    assert read_at
    assert client.post(path).json()["nodes"][0]["lessons"][0]["read_at"] == read_at
    for _ in range(2):
        undone = client.delete(path)
        assert undone.status_code == 200, undone.text
        assert undone.json()["nodes"][0]["lessons"][0]["read_at"] is None

    after = store.course(course["id"])
    assert {k: v for k, v in after.items() if k != "revision"} == {
        k: v for k, v in before.items() if k != "revision"
    }
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    reopened = restarted.get(f"/api/courses/{course['id']}")
    assert reopened.json()["nodes"][0]["lessons"][0]["read_at"] is None
    assert restarted.post(path).json()["nodes"][0]["lessons"][0]["read_at"]


def test_undo_read_rejects_missing_lesson_and_other_review_scope(session):
    client, store, model, course = session
    before = store.course(course["id"])
    assert client.delete(lesson_path(course) + "/missing/read").status_code == 404
    assert store.course(course["id"]) == before

    model.replies.append(lesson_draft())
    lesson = generate(client, course).json()["nodes"][0]["lessons"][0]
    path = lesson_path(course) + f"/{lesson['id']}/read"
    assert client.post(path).status_code == 200
    with store.edit(course["id"]) as (current, _):
        current["review_scope"] = dict(
            enabled=True, material_ids=[course["materials"][0]["id"]], ai_scope="selected"
        )
    before = store.course(course["id"])
    assert client.delete(path).status_code == 400
    assert store.course(course["id"]) == before


def test_supplement_appends_and_restore_recovers_the_original_html(session):
    client, store, model, course = session
    model.replies.append(lesson_draft())
    first = generate(client, course).json()["nodes"][0]["lessons"][0]
    original_html = client.get(lesson_path(course) + f"/{first['id']}/html").text
    model.replies.append(lesson_draft())
    response = generate(
        client, course, kind="supplement", focus="再换一个更小的例子", request_id="supplement-request-1"
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["nodes"][0]["lessons"]) == 2
    assert (
        generate(
            client, course, kind="supplement", focus="再换一个更小的例子", request_id="supplement-request-1"
        ).json()
        == response.json()
    )
    version = store.versions(course["id"])[0]
    preview = client.post(
        f"/api/courses/{course['id']}/restore-preview", json={"version_id": version["id"]}
    ).json()
    restored = client.post(f"/api/courses/{course['id']}/restore", json={"token": preview["token"]}).json()
    assert [lesson["id"] for lesson in restored["nodes"][0]["lessons"]] == [first["id"]]
    assert client.get(lesson_path(course) + f"/{first['id']}/html").text == original_html


@pytest.mark.parametrize("reply", [AIError("provider unavailable"), {"title": "incomplete"}])
def test_failed_generation_leaves_course_and_snapshots_unchanged(session, reply):
    client, store, model, course = session
    before = store.course(course["id"])
    versions = store.versions(course["id"])
    model.replies.append(reply)
    assert generate(client, course).status_code in {400, 503}
    assert store.course(course["id"]) == before
    assert store.versions(course["id"]) == versions


def test_concurrent_progress_change_rejects_stale_lesson(session):
    client, store, model, course = session

    def mark_during_generation():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["status"] = "mastered"

    model.before_reply = mark_during_generation
    model.replies.append(lesson_draft())
    assert generate(client, course).status_code == 409
    current = store.course(course["id"])
    assert current["nodes"][0]["status"] == "mastered"
    assert "lessons" not in current["nodes"][0]


def test_generated_html_cannot_run_scripts_or_reach_app_endpoints(session):
    client, _, model, course = session
    draft = lesson_draft()
    draft["html"] += (
        '<script>fetch("/api/settings")</script><img src="https://evil.invalid/x">'
        '<iframe src="/api/settings"></iframe><p onclick="alert(1)">继续学习记录的含义</p>'
        '<a href="javascript:alert(1)">思考一下</a><style>body{display:none}</style>'
    )
    model.replies.append(draft)
    lesson = generate(client, course).json()["nodes"][0]["lessons"][0]
    response = client.get(lesson_path(course) + f"/{lesson['id']}/html")
    assert response.headers["content-security-policy"] == LESSON_CSP
    for forbidden in ("<script", "<iframe", "<img", "onclick", "javascript:", "evil.invalid", "display:none"):
        assert forbidden not in response.text
    assert "继续学习记录" in response.text
    download = client.get(lesson_path(course) + f"/{lesson['id']}/html?download=true")
    assert download.headers["content-disposition"].startswith("attachment;")
    other = client.post("/api/sample").json()
    assert client.get(lesson_path(other) + f"/{lesson['id']}/html").status_code == 404


def test_supplement_requires_a_saved_lesson_and_specific_focus(session):
    client, store, _, course = session
    before = store.course(course["id"])
    assert generate(client, course, kind="supplement", focus="例子").status_code == 400
    assert store.course(course["id"]) == before


def test_route_includes_all_parents_and_does_not_mutate_legacy_nodes():
    nodes = [
        dict(id=nid, prerequisites=parents, status=status)
        for nid, parents, status in [("end", ["a", "b"], "new"), ("a", [], "passed"), ("b", [], "new")]
    ]
    before = copy.deepcopy(nodes)
    route = learning_route(nodes)
    order = [nid for stage in route["stages"] for nid in stage["node_ids"]]
    assert order.index("end") > order.index("a") and order.index("end") > order.index("b")
    assert route["next_node_id"] == "b"
    assert nodes == before
    nodes[2]["status"] = "mastered"
    assert learning_route(nodes)["next_node_id"] == "end"


@pytest.mark.parametrize("parents", [["missing"], ["a"]])
def test_broken_dependencies_remain_visible_without_becoming_recommended(parents):
    route = learning_route([dict(id="a", prerequisites=parents, status="new")])
    assert route["warning"] and route["next_node_id"] is None
    assert route["stages"][0]["node_ids"] == ["a"]


def test_empty_route_and_completed_route_have_no_false_next_step():
    assert learning_route([])["stages"] == []
    route = learning_route([dict(id="done", prerequisites=[], status="mastered")])
    assert route["next_node_id"] is None and route["completed_count"] == route["total"] == 1


def test_served_lesson_links_citations_to_the_original_page(session):
    client, _, model, course = session
    model.replies.append(lesson_draft())
    lesson = generate(client, course).json()["nodes"][0]["lessons"][0]
    source = lesson["sources"][0]
    response = client.get(lesson_path(course) + f"/{lesson['id']}/html")
    url = f"/api/courses/{course['id']}/materials/{source['material_id']}/file#page={source['page']}"
    assert f'<a href="{url}" target="_blank" rel="noopener noreferrer">' in response.text
    assert "allow-popups" in response.headers["content-security-policy"]
    assert "allow-scripts" not in response.headers["content-security-policy"]
    assert "<script" not in response.text
    # A download has no app to link back to, so its citations stay plain text.
    download = client.get(lesson_path(course) + f"/{lesson['id']}/html?download=true")
    assert "<a href" not in download.text and source["name"] in download.text
