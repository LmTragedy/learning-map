import io
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.problem_bank import attach_answers, split_problems


class UnitModel:
    def __init__(self):
        self.reply = {}
        self.prompts = []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        return {"text": json.dumps(self.reply, ensure_ascii=False), "thread_id": "bank-thread"}


@pytest.fixture
def session(tmp_path):
    model = UnitModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course, f'/api/courses/{course["id"]}'


def test_split_numbered_problems_and_attach_answers():
    text = "Answer all questions.\n1. Define a key.\nIt has 2.5 parts.\n2. (a) Draw a table\n3) Explain joins"
    problems = split_problems(text)
    assert [p["number"] for p in problems] == ["1", "2", "3"]
    assert problems[0]["preamble"] == "Answer all questions." and problems[0]["text"].startswith("1. Define")
    assert "2.5 parts" in problems[0]["text"]
    answered = attach_answers(problems, "1. A unique id\n3. Combine rows")
    assert [p.get("answer", "") for p in answered] == ["1. A unique id", "", "3. Combine rows"]


def test_split_problem_headings_and_separators():
    assert len(split_problems("Problem 1\nfoo\nProblem 2\nbar")) == 2
    assert len(split_problems("第1题 甲\n第2题 乙\n第3题 丙")) == 3
    assert [p["text"] for p in split_problems("A\n---\nB")] == ["A", "B"]
    assert split_problems("only one problem") == [dict(number="1", text="only one problem")]


def test_import_edit_practise_and_benchmark(session):
    client, store, model, course, base = session
    node = course["nodes"][0]
    text = f"1. Explain {node['title']} with an example.\n2. Something unrelated."
    upload = ("answers.txt", io.BytesIO(b"extra 3. third one"), "text/plain")
    created = client.post(base + "/problem-sets", data={"title": "PS1", "text": text, "answer_text": "1. A key."},
                          files=[("files", upload)])
    assert created.status_code == 200, created.text
    problem_set = created.json()["problem_sets"][0]
    assert problem_set["origin"] == "real" and "pages" not in problem_set["files"][0]
    first = next(p for p in problem_set["problems"] if p["number"] == "1")
    assert first["answer"] == "1. A key." and first["node_ids"] == [node["id"]]

    problems = [dict(p, node_ids=[]) for p in problem_set["problems"]]
    stale = client.put(base + f"/problem-sets/{problem_set['id']}",
                       json={"revision": 0, "title": "PS1", "problems": problems})
    assert stale.status_code == 409
    latest = client.get(base).json()
    edited = client.put(base + f"/problem-sets/{problem_set['id']}",
                        json={"revision": latest["revision"], "title": "Problem Set 1", "problems": problems[:1]})
    assert edited.status_code == 200
    assert [p["id"] for p in edited.json()["problem_sets"][0]["problems"]] == [first["id"]]

    practised = client.post(base + f"/nodes/{node['id']}/question/from-problem",
                            json={"set_id": problem_set["id"], "problem_id": first["id"]}).json()
    question = practised["nodes"][0]["question"]
    assert question["kind"] == "真题" and set(question) == {"prompt", "kind", "rubric"}
    assert "A key." in question["rubric"]
    assert practised["problem_sets"][0]["problems"][0]["node_ids"] == [node["id"]]

    model.reply = {"prompt": "新题", "kind": "变体", "rubric": "要点"}
    client.post(base + f"/nodes/{node['id']}/question")
    assert "真题基准" in model.prompts[-1] and "Problem Set 1" in model.prompts[-1]

    deleted = client.post(base + f"/problem-sets/{problem_set['id']}/delete").json()
    assert deleted["problem_sets"] == []


def test_generate_unit_follows_materials_and_benchmark(session):
    client, store, model, course, base = session
    material = course["materials"][0]
    node = course["nodes"][0]
    real = client.post(base + "/problem-sets", data={"title": "Past exam", "text": "1. A\n2. B"}).json()
    real_set = real["problem_sets"][0]
    model.reply = {"title": "Unit 1 practice", "standard": "两道计算题，分小问。", "problems": [{
        "text": "Compute something", "answer": "42", "node_ids": [node["id"], "missing"],
        "sources": [{"material_id": material["id"], "page": 1}, {"material_id": "nope", "page": 1}],
        "benchmark_ids": [real_set["problems"][0]["id"], "nope"], "kind": "计算",
    }]}
    response = client.post(base + "/problem-sets/generate", json={
        "material_ids": [material["id"]], "problem_set_ids": [real_set["id"]], "count": 1})
    assert response.status_code == 200, response.text
    unit = response.json()["problem_sets"][-1]
    assert unit["origin"] == "ai" and unit["standard"]
    problem = unit["problems"][0]
    assert problem["node_ids"] == [node["id"]]
    assert problem["sources"] == [{"material_id": material["id"], "page": 1}]
    assert problem["benchmark_ids"] == [real_set["problems"][0]["id"]]
    assert "Past exam" in model.prompts[-1]


def test_unknown_node_link_is_rejected(session):
    client, _, _, _, base = session
    real = client.post(base + "/problem-sets", data={"text": "only"}).json()
    problem_set = real["problem_sets"][0]
    response = client.put(base + f"/problem-sets/{problem_set['id']}", json={
        "revision": real["revision"], "title": "x",
        "problems": [dict(problem_set["problems"][0], node_ids=["missing"])]})
    assert response.status_code == 404
    assert client.post(base + "/problem-sets", data={"text": "  "}).status_code == 400
