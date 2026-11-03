"""Goals in progress steer the suggested next node without changing unlocking."""

from backend.route import learning_route


def node(node_id, prerequisites=(), status="new"):
    return dict(id=node_id, prerequisites=list(prerequisites), status=status)


def test_goal_in_progress_picks_its_available_node_first():
    nodes = [node("a"), node("b"), node("c", ["a"])]
    assert learning_route(nodes)["next_node_id"] == "a"
    route = learning_route(nodes, ["b"])
    assert route["next_node_id"] == "b" and route["next_for_goal"] is True


def test_goal_node_that_is_still_locked_does_not_jump_the_queue():
    nodes = [node("a"), node("c", ["a"])]
    route = learning_route(nodes, ["c"])
    assert route["next_node_id"] == "a" and route["next_for_goal"] is False


def test_subgoal_linked_to_node_completes_when_node_is_verified(tmp_path):
    from fastapi.testclient import TestClient

    from backend.app import create_app

    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    node_id = course["nodes"][0]["id"]
    created = client.post(f"/api/courses/{course['id']}/goals", json={
        "title": "g", "subtasks": [{"title": "学会关系", "node_id": node_id}, {"title": "手动"}]}).json()
    goal = created["goals"][0]
    assert goal["progress"]["subtasks_done"] == 0
    with app.state.store.edit(course["id"]) as (current, _):
        current["nodes"][0]["verification"] = "user_passed"
    goal = client.get(f"/api/courses/{course['id']}").json()["goals"][0]
    assert goal["subtasks"][0]["auto_done"] is True and goal["subtasks"][0]["done"] is False
    assert goal["progress"]["subtasks_done"] == 1
    bad = client.post(f"/api/courses/{course['id']}/goals", json={"title": "g", "subtasks": [{"title": "x", "node_id": "missing"}]})
    assert bad.status_code == 404



def test_goal_map_route_includes_completed_predecessors_and_subtask_endpoints(tmp_path):
    from fastapi.testclient import TestClient
    from backend.app import create_app
    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    client.post(f"{base}/nodes/{ids[0]}/mark", json={"status": "mastered"})
    saved = client.post(f"{base}/goals", json={"title": "终点", "node_ids": [ids[2]], "status": "doing",
        "subtasks": [{"title": "最后一站", "node_id": ids[3]}]}).json()
    assert set(saved["goals"][0]["route_ids"]) == set(ids)
    assert saved["route"]["next_node_id"] == ids[1]
    assert saved["nodes"][2]["unlocked"] is False
