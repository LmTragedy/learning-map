"""The tutor chat reads the plan; questions and assessments never do."""

from tests.plan_fixtures import plan_path, plan_reply, plan_session_fixture  # noqa: F401  (fixture)

MARK = "本节教学分工"


def _plan(client, model, course):
    model.replies.append(plan_reply(course))
    assert client.post(plan_path(course), json={"request_id": "plan-request-000001"}).status_code == 200


def _node_path(course):
    return f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}"


def test_chat_prompt_carries_the_plan_and_the_guidance_to_still_explain(plan_session):
    client, _, model, course = plan_session
    _plan(client, model, course)
    model.replies.append("好的，我们从完备性开始。")
    response = client.post(_node_path(course) + "/chat", json={"message": "我忘了传递性是什么"})
    assert response.status_code == 200, response.text
    prompt = model.prompts[-1]
    assert MARK in prompt and "不能以“由其他节点负责”为由拒绝解释" in prompt
    assert "能判断一个偏好关系是否理性" in prompt


def test_chat_without_plan_is_unchanged(plan_session):
    client, _, model, course = plan_session
    model.replies.append("好的。")
    assert client.post(_node_path(course) + "/chat", json={"message": "讲讲完备性"}).status_code == 200
    assert MARK not in model.prompts[-1]


def test_question_prompt_never_sees_the_plan(plan_session):
    client, _, model, course = plan_session
    _plan(client, model, course)
    model.replies.append(dict(prompt="解释完备性", kind="解释", rubric="说清可比较"))
    response = client.post(_node_path(course) + "/question", json={})
    assert response.status_code == 200, response.text
    assert MARK not in model.prompts[-1] and "能判断一个偏好关系是否理性" not in model.prompts[-1]
