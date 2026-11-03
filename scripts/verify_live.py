"""Explicit opt-in synthetic-course integration check against the real configured Codex provider."""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from backend.app import create_app  # noqa: E402
from backend.files import material_original  # noqa: E402


def require(response):
    if response.status_code != 200:
        raise RuntimeError(f"{response.status_code}: {response.text}")
    return response.json()


def verify():
    root = Path(__file__).resolve().parents[1]
    destination = root / "test-results" / "live-flow"
    destination.mkdir(parents=True, exist_ok=True)
    app = create_app(destination / "data")
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    require(client.post("/api/settings", json={"ai_enabled": True}))
    source_course = require(client.post("/api/sample"))
    source = material_original(app.state.store, source_course["id"], source_course["materials"][0]["id"])
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    course = require(
        client.post("/api/courses", json={"title": "真实AI集成验证 · " + source_course["id"][:8]})
    )
    cid = course["id"]
    with source.open("rb") as opened:
        course = require(
            client.post(
                f"/api/courses/{cid}/materials",
                files=[("files", ("database.pdf", opened, "application/pdf"))],
            )
        )
    print("Real copied PDF imported; original hash recorded.", flush=True)
    course = require(client.post(f"/api/courses/{cid}/generate"))
    assert course["nodes"]
    print(f"Real AI generated {len(course['nodes'])} source-linked nodes.", flush=True)
    node = next((n for n in course["nodes"] if not n["prerequisites"]), course["nodes"][0])
    path = f"/api/courses/{cid}/nodes/{node['id']}"
    course = require(
        client.post(
            path + "/chat",
            json={
                "message": "我想理解这个节点如何用在转账或选课数据库里。请先用小例子解释，之后给我一个自己判断的机会。"
            },
        )
    )
    print("Real node conversation completed.", flush=True)
    course = require(client.post(path + "/question"))
    print("Real content-dependent assessment question generated.", flush=True)
    node = next(n for n in course["nodes"] if n["id"] == node["id"])
    answer = (
        "我的理解是：关系用行和列表示事实。主键唯一标识一行且不能空，外键引用相关表的候选键。"
        "例如Student.student_id为主键，Enrollment.student_id引用它，选课记录需要学生和课程一起标识。"
        "转账应把扣款和入账放在同一事务：全成功才提交，一步失败则回滚，不能出现只扣钱没到账。"
        "总余额A+B不变是一致性约束；并发读取同一个旧余额可能丢失更新，用适合的锁或串行化防止。"
        "提交的结果崩溃后仍保留是持久性；回滚只能放弃未提交更改，不能当通用撤销。"
        "以上是集成测试者编写的合成答案，不代表真实学习者掌握。"
    )
    course = require(client.post(path + "/attempts", data={"answer": answer}))
    node = next(n for n in course["nodes"] if n["id"] == node["id"])
    attempt = node["attempts"][-1]
    print(f"Real semantic judgment: {attempt['judgment']['outcome']}.", flush=True)
    course = require(
        client.post(
            path + f"/attempts/{attempt['id']}/rating",
            json={"problem": 3, "mastery": 2, "comment": "合成答案真实模型集成测试，不代表真人学习效果"},
        )
    )
    before = next(n for n in course["nodes"] if n["id"] == node["id"])
    restarted = TestClient(create_app(destination / "data"), headers={"X-Learning-Map": "1"})
    after = require(restarted.get(f"/api/courses/{cid}"))
    persisted = next(n for n in after["nodes"] if n["id"] == node["id"])
    assert persisted["chats"] == before["chats"] and persisted["attempts"] == before["attempts"]
    recall = require(restarted.get(path + "/recall"))
    assert recall["messages"] == persisted["chats"]
    course = require(
        restarted.post(path + "/chat", json={"message": "继续刚才的例子，用一个很短的问题让我自己判断。"})
    )
    assert next(n for n in course["nodes"] if n["id"] == node["id"])["thread_id"] == before["thread_id"]
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    report = dict(
        course_id=cid,
        node_id=node["id"],
        real_ai=True,
        synthetic_material=True,
        node_count=len(course["nodes"]),
        question=node["question"],
        judgment=attempt["judgment"],
        restarted_history_equal=True,
        resumed_node_thread=True,
        recall_equal=True,
        original_unchanged=True,
        rating_count=len(course["ratings"]),
    )
    (destination / "results.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("Restart, thread resume, exact Recall, rating persistence and original hash verified.", flush=True)


if __name__ == "__main__":
    verify()
