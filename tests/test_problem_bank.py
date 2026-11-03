import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.problem_bank import attach_answers, split_problems


class UnitModel:
    def __init__(self):
        self.reply = {}
        self.prompts = []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        self.images = [str(path) for path in options.get("images") or []]
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
    created = client.post(base + "/problem-sets", data={"title": "PS1", "text": text, "answer_text": "1. A key."})
    assert created.status_code == 200, created.text
    problem_set = created.json()["problem_sets"][0]
    assert problem_set["origin"] == "real" and problem_set["files"] == []
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
    assert question["kind"] == "真题" and set(question) == {"prompt", "kind", "rubric", "problem_ref"}
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


def png(width=1600, height=900, color=(200, 30, 30)):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, "PNG")
    return buffer.getvalue()


def test_screenshots_are_problems_kept_byte_for_byte_and_sent_to_ai(session):
    client, store, model, course, base = session
    node = course["nodes"][0]
    first, second = png(), png(color=(0, 0, 200))
    created = client.post(base + "/problem-sets", data={"title": "截图", "answer_text": "1. 答案一"},
                          files=[("files", ("q1.png", first, "image/png")), ("files", ("q2.png", second, "image/png"))])
    assert created.status_code == 200, created.text
    problem_set = created.json()["problem_sets"][0]
    problems = problem_set["problems"]
    assert [p["text"] for p in problems] == ["", ""] and problems[0]["answer"] == "1. 答案一"
    image = problems[0]["images"][0]
    assert (image["width"], image["height"]) == (1600, 900)
    served = client.get(base + f"/problem-sets/{problem_set['id']}/images/{image['id']}")
    assert served.status_code == 200 and served.content == first

    practised = client.post(base + f"/nodes/{node['id']}/question/from-problem",
                            json={"set_id": problem_set["id"], "problem_id": problems[0]["id"]}).json()
    question = practised["nodes"][0]["question"]
    assert question["images"] == [f"{problem_set['id']}/{image['id']}"]

    model.reply = {"outcome": "passed", "reasoning": "ok", "blockers": [], "next_step": "继续",
                   "missing_bridges": [], "confirmed_points": [], "disputed_points": []}
    from backend.practice_progress import question_key
    attempt = client.post(base + f"/nodes/{node['id']}/attempts",
                          data={"answer": "我的答案", "question_key": question_key(question)})
    assert attempt.status_code == 200, attempt.text
    assert len(model.images) == 1 and model.images[0].endswith(image["id"] + ".png")
    assert question["problem_ref"] == f"{problem_set['id']}/{problems[0]['id']}"
    assert "题目原始截图" in model.prompts[-1]

    model.reply = {"prompt": "新题", "kind": "变体", "rubric": "要点"}
    client.post(base + f"/nodes/{node['id']}/question")
    assert len(model.images) == 2 and "图1" in model.prompts[-1]

    # Merging moves the second screenshot into the first problem; adding goes through its own route.
    latest = client.get(base).json()
    merged = [dict(problems[0], images=[image["id"], problems[1]["images"][0]["id"]])]
    saved = client.put(base + f"/problem-sets/{problem_set['id']}",
                       json={"revision": latest["revision"], "title": "截图", "problems": merged})
    assert saved.status_code == 200, saved.text
    assert len(saved.json()["problem_sets"][0]["problems"][0]["images"]) == 2
    added = client.post(base + f"/problem-sets/{problem_set['id']}/problems/{problems[0]['id']}/images",
                        files=[("images", ("q3.png", png(color=(0, 200, 0)), "image/png"))])
    assert len(added.json()["problem_sets"][0]["problems"][0]["images"]) == 3
    bad = client.post(base + f"/problem-sets/{problem_set['id']}/problems/{problems[0]['id']}/images",
                      files=[("images", ("x.png", b"not an image", "image/png"))])
    assert bad.status_code == 400


def problem_pdf(title, items):
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=letter)
    y = 740
    page.drawString(72, y, title)
    y -= 40
    for number, line in items:
        if y < 160:
            page.showPage()
            y = 740
        page.drawString(72, y, f"{number}. {line}")
        page.rect(90, y - 70, 200, 50)
        y -= 150
    page.save()
    return buffer.getvalue()


def test_pdf_problems_are_cut_into_hd_screenshots_with_matching_answers(session):
    client, store, model, course, base = session
    problems_pdf = problem_pdf("Problem Set 3", [(n, f"Compute the integral of x^{n}.") for n in range(1, 6)])
    answers_pdf = problem_pdf("Solutions", [(n, f"The integral is {n}/{n + 1}.") for n in (1, 2, 3, 5)])
    created = client.post(base + "/problem-sets", data={"title": "PS3"},
                          files=[("files", ("ps3.pdf", problems_pdf, "application/pdf")),
                                 ("answer_files", ("sol3.pdf", answers_pdf, "application/pdf"))])
    assert created.status_code == 200, created.text
    problem_set = created.json()["problem_sets"][0]
    problems = problem_set["problems"]
    assert [p["number"] for p in problems] == ["1", "2", "3", "4", "5"]
    assert problem_set["instructions"] == "Problem Set 3"
    assert all(len(p["images"]) == 1 and p["images"][0]["width"] > 500 for p in problems)
    assert "integral of x^2" in problems[1]["text"]
    assert "2/3" in problems[1]["answer"] and len(problems[1]["answer_images"]) == 1
    assert problems[3]["answer_images"] == [] and problems[3]["answer"] == ""
    roles = {f["role"]: f for f in problem_set["files"]}
    assert roles["problem"]["page_count"] == 2

    pdf = roles["problem"]
    page = client.get(base + f"/problem-sets/{problem_set['id']}/files/{pdf['id']}/pages/1")
    assert page.status_code == 200 and page.headers["content-type"] == "image/png"
    cropped = client.post(base + f"/problem-sets/{problem_set['id']}/problems/{problems[3]['id']}/crop", json={
        "file_id": pdf["id"], "page": 1, "box": [0.05, 0.05, 0.9, 0.3], "target": "answer_images"})
    assert cropped.status_code == 200, cropped.text
    assert len(cropped.json()["problem_sets"][0]["problems"][3]["answer_images"]) == 1
    tiny = client.post(base + f"/problem-sets/{problem_set['id']}/problems/{problems[3]['id']}/crop", json={
        "file_id": pdf["id"], "page": 1, "box": [0.1, 0.1, 0.1001, 0.1001]})
    assert tiny.status_code == 400

    node = course["nodes"][0]
    question = client.post(base + f"/nodes/{node['id']}/question/from-problem",
                           json={"set_id": problem_set["id"], "problem_id": problems[1]["id"]}).json()["nodes"][0]["question"]
    assert len(question["images"]) == 1 and len(question["answer_images"]) == 1
    model.reply = {"outcome": "passed", "reasoning": "ok", "blockers": [], "next_step": "继续",
                   "missing_bridges": [], "confirmed_points": [], "disputed_points": []}
    from backend.practice_progress import question_key
    client.post(base + f"/nodes/{node['id']}/attempts", data={"answer": "2/3", "question_key": question_key(question)})
    assert len(model.images) == 2 and "参考答案截图" in model.prompts[-1]


def editable(problem, **change):
    """Only the fields the update route accepts, as the client sends them."""
    fields = ("id", "number", "text", "answer", "node_ids", "related_node_ids", "key_points")
    return {key: problem[key] for key in fields if key in problem} | dict(
        images=[image["id"] for image in problem.get("images", [])],
        answer_images=[image["id"] for image in problem.get("answer_images", [])]) | change


def test_ai_links_problems_to_nodes_but_keeps_manual_links(session):
    client, store, model, course, base = session
    nodes = [node["id"] for node in course["nodes"]]
    created = client.post(base + "/problem-sets", data={"text": "1. first\n2. second"}).json()
    problem_set = created["problem_sets"][0]
    first, second = problem_set["problems"]
    latest = client.get(base).json()
    manual = [dict(first, node_ids=[nodes[2]]), second]
    client.put(base + f"/problem-sets/{problem_set['id']}", json={"revision": latest["revision"], "title": "t", "problems": manual})
    model.reply = {"links": [{"problem_id": first["id"], "node_id": nodes[0], "related_node_ids": [], "key_points": ["主键 / primary key"]},
                             {"problem_id": second["id"], "node_id": nodes[1], "related_node_ids": [nodes[3], "missing", nodes[1]],
                              "key_points": [" 原子性 / atomicity ", ""]}]}
    linked = client.post(base + f"/problem-sets/{problem_set['id']}/link")
    assert linked.status_code == 200, linked.text
    problems = linked.json()["problem_sets"][0]["problems"]
    assert problems[0]["node_ids"] == [nodes[2]] and problems[0]["link_origin"] == "user"
    assert problems[1]["node_ids"] == [nodes[1]] and problems[1]["link_origin"] == "ai"
    assert problems[1]["related_node_ids"] == [nodes[3]]
    # Key points fill in even where the learner chose the node, and stay once the learner edits them.
    assert problems[0]["key_points"] == ["主键 / primary key"] and problems[1]["key_points"] == ["原子性 / atomicity"]
    latest = client.get(base).json()
    client.put(base + f"/problem-sets/{problem_set['id']}", json={"revision": latest["revision"], "title": "t",
        "problems": [editable(problems[0], key_points=["外键 / foreign key"]), editable(problems[1])]})
    model.reply["links"][0]["key_points"] = ["别的 / other"]
    relinked = client.post(base + f"/problem-sets/{problem_set['id']}/link").json()["problem_sets"][0]["problems"]
    assert relinked[0]["key_points"] == ["外键 / foreign key"]
    assert "知识点" in model.prompts[-1] and nodes[0] in model.prompts[-1]


def test_one_main_node_and_content_close_problems_as_benchmark(session):
    client, store, model, course, base = session
    nodes = course["nodes"]
    text = ("1. Explain why a primary key cannot be null and how a foreign key references another table.\n"
            "2. Two users update the same row concurrently. Explain the lost update and how locking prevents it.\n"
            "3. Compute the integral of x^2 on [0, 2].\n"
            "4. A bank transfer debits A and credits B. If the credit fails, should it commit or rollback?")
    created = client.post(base + "/problem-sets", data={"title": "Exam", "text": text}).json()
    problem_set = created["problem_sets"][0]
    keys, lost_update, integral, transfer = problem_set["problems"]
    latest = client.get(base).json()
    # Several ids sent for one problem: the first is its home, the rest become related references.
    saved = client.put(base + f"/problem-sets/{problem_set['id']}", json={"revision": latest["revision"], "title": "Exam", "problems": [
        dict(keys, node_ids=[nodes[0]["id"], nodes[2]["id"]]), dict(lost_update, node_ids=[nodes[3]["id"]]),
        dict(integral, node_ids=[]), dict(transfer, node_ids=[nodes[2]["id"]], related_node_ids=[nodes[1]["id"]])]}).json()
    stored = saved["problem_sets"][0]["problems"]
    assert stored[0]["node_ids"] == [nodes[0]["id"]] and stored[0]["related_node_ids"] == [nodes[2]["id"]]

    from backend.problem_bank import rank_problems
    current = store.course(course["id"])
    # 提交与回滚 owns the transfer problem; keys only lists it as related.
    levels = {pair[1]["id"]: level for pair, level, _ in rank_problems(current, current["nodes"][2])}
    assert levels[transfer["id"]] == 0 and levels[keys["id"]] == 1
    # 隔离与并发 owns lost-update; for 关系与键's neighbour 事务与 ACID nothing is linked, so content decides.
    ranked = rank_problems(current, current["nodes"][1])
    assert ranked[0][0][1]["id"] == transfer["id"] and ranked[0][1] == 1
    by_id = {pair[1]["id"]: (level, score) for pair, level, score in ranked}
    assert by_id[integral["id"]][1] < by_id[transfer["id"]][1]

    references = client.get(base + f"/nodes/{nodes[1]['id']}/problem-references").json()
    assert references[0]["problem_id"] == transfer["id"] and references[0]["relation"] == "与本知识点相关的真题"
    model.reply = {"prompt": "新题", "kind": "变体", "rubric": "要点"}
    client.post(base + f"/nodes/{nodes[1]['id']}/question")
    assert "与本知识点相关的真题" in model.prompts[-1]


def test_content_similarity_prefers_matching_topic():
    from backend.problem_similarity import similarities
    from backend.sample import SAMPLE
    course = dict(materials=[dict(id="m", pages=[dict(number=i + 1, text="\n".join(lines)) for i, (_, _, lines) in enumerate(SAMPLE)])],
                  nodes=[dict(id=str(i), title=title, summary=summary, sources=[dict(material_id="m", page=i + 1, quote="")])
                         for i, (title, summary, _) in enumerate(SAMPLE)])
    problems = [dict(text="Explain why a primary key cannot be null and how a foreign key references another table."),
                dict(text="Two users update the same row concurrently. Explain the lost update and how locking prevents it."),
                dict(text="Compute the integral of x^2 on [0, 2]."), dict(text="")]
    keys = similarities(course, course["nodes"][0], problems)
    isolation = similarities(course, course["nodes"][3], problems)
    assert keys[0] > 0.1 and keys[0] > keys[1] and keys[0] > keys[2] and keys[3] == 0
    assert isolation[1] > isolation[0] and isolation[1] > isolation[2]


def test_bilingual_key_points_match_across_languages():
    from backend.problem_similarity import similarities
    # A node described only in Chinese, problems written only in English.
    course = dict(materials=[], nodes=[
        dict(id="k", title="主键与外键", summary="用主键唯一标识一行，用外键引用另一张表。", sources=[]),
        dict(id="t", title="事务的原子性", summary="一组修改要么全部生效，要么全部不生效。", sources=[])])
    keys_problem = dict(text="Why can a primary key never be null? Give a table example.")
    transfer = dict(text="A transfer debits A and credits B; the credit fails. What must happen?")
    plain = similarities(course, course["nodes"][0], [keys_problem, transfer])
    assert plain == [0, 0]
    tagged = [dict(keys_problem, key_points=["主键 / primary key", "外键 / foreign key"]),
              dict(transfer, key_points=["原子性 / atomicity", "事务 / transaction"])]
    keys_scores = similarities(course, course["nodes"][0], tagged)
    atomic_scores = similarities(course, course["nodes"][1], tagged)
    assert keys_scores[0] > 0.05 and keys_scores[0] > keys_scores[1]
    assert atomic_scores[1] > atomic_scores[0]
    # Screenshot-only problems become comparable through their key points too.
    shots = similarities(course, course["nodes"][0], [dict(text="", key_points=["主键 / primary key"]),
                                                      dict(text="", key_points=["积分 / integral"]), dict(text="")])
    assert shots[0] > shots[1] and shots[1] == shots[2] == 0
