from fastapi.testclient import TestClient

from backend.app import create_app


def test_goals_and_notes_persist_per_course_and_reject_stale_note(tmp_path):
    data = tmp_path / 'data'
    client = TestClient(create_app(data), headers={'X-Learning-Map': '1'})
    first = client.post('/api/sample').json()
    second = client.post('/api/courses', json={'title': '其他课程'}).json()
    cid, nid = first['id'], first['nodes'][0]['id']
    created = client.post(f'/api/courses/{cid}/goals', json={'title': '理解事务', 'node_ids': [nid]})
    assert created.status_code == 200
    goal = created.json()['goals'][0]
    saved = client.put(f'/api/courses/{cid}/nodes/{nid}/personal-note', json={'content': '我的理解', 'expected': ''})
    assert saved.status_code == 200
    conflict = client.put(f'/api/courses/{cid}/nodes/{nid}/personal-note', json={'content': '不应覆盖', 'expected': ''})
    assert conflict.status_code == 409
    moved = client.put(f'/api/courses/{cid}/goals/{goal["id"]}', json={'title': goal['title'], 'node_ids': [nid], 'status': 'done', 'revision': saved.json()['revision']})
    assert moved.status_code == 200
    restarted = TestClient(create_app(data), headers={'X-Learning-Map': '1'})
    loaded = restarted.get(f'/api/courses/{cid}').json()
    assert loaded['goals'][0]['status'] == 'done'
    assert loaded['nodes'][0]['personal_note'] == '我的理解'
    assert not restarted.get(f'/api/courses/{second["id"]}').json().get('goals')
    assert restarted.post(f'/api/courses/{second["id"]}/goals', json={'title': '错误引用', 'node_ids': [nid]}).status_code == 404
