from fastapi.testclient import TestClient

from backend.app import create_app


def test_material_file_can_be_framed_by_the_app_only(tmp_path):
    client = TestClient(create_app(tmp_path / "data", lambda _: None), headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    material = course["materials"][0]

    original = client.get(f"/api/courses/{course['id']}/materials/{material['id']}/file")
    assert original.status_code == 200
    assert "frame-ancestors 'self'" in original.headers["content-security-policy"]

    shell = client.get(f"/api/courses/{course['id']}")
    assert "frame-ancestors 'none'" in shell.headers["content-security-policy"]
