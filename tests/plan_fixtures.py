"""Shared setup for teaching-plan tests: a sample course whose first two nodes cite the same page."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class PlanModel:
    def __init__(self):
        self.replies, self.prompts, self.before_reply = [], [], None

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        if self.before_reply:
            hook, self.before_reply = self.before_reply, None
            hook()
        reply = self.replies.pop(0)
        return {"text": reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False),
                "thread_id": "plan-thread"}


def piece(title, material_id, page, kind="定义"):
    return dict(id=title, kind=kind, title=title, detail=f"{title}的说明",
                sources=[dict(material_id=material_id, page=page, quote="")])


@pytest.fixture(name="plan_session")
def plan_session_fixture(tmp_path):
    model = PlanModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    store = app.state.store
    with store.edit(course["id"]) as (current, _):
        material = current["materials"][0]["id"]
        first, second = current["nodes"][0], current["nodes"][1]
        # The second node also cites page 1, the way 传递性局限 shares 理性偏好's page.
        second["sources"].append(dict(material_id=material, page=1, quote=""))
        first["pieces"] = [piece("完备性", material, 1), piece("传递性", material, 1, "性质")]
        second["pieces"] = [piece("加糖例子", material, 1, "例子")]
        first["steps"] = [dict(id="s1", title="检查完备性")]
    return client, store, model, store.course(course["id"])


def plan_reply(course, **extra):
    second = course["nodes"][1]
    reply = dict(
        goal="能判断一个偏好关系是否理性",
        owns=[dict(piece="完备性", point="完备性的定义与检查", depth="讲透"),
              dict(piece="传递性", point="传递性的定义与检查", depth="讲透")],
        borrows=[],
        defers=[dict(node_id=second["id"], what="逐粒加糖的完整论证")],
        distinctions=[dict(node_id=second["id"], shared="传递性", axis="应用", difference="本节给定义，后一节看它的局限")],
        sources=[dict(material_id=course["materials"][0]["id"], page=1, quote="")],
        conflicts=[],
        uncertain=False,
        note="",
    )
    return reply | extra


def plan_path(course, index=0):
    return f"/api/courses/{course['id']}/nodes/{course['nodes'][index]['id']}/teaching-plan"
