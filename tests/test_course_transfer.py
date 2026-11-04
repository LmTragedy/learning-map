import io
import json
import zipfile

from fastapi.testclient import TestClient

from backend.app import create_app


def _client(tmp_path):
    return TestClient(create_app(tmp_path / "data"), headers={"X-Learning-Map": "1"})


def _course_with_material(client):
    course = client.post("/api/courses", json={"title": "博弈论"}).json()
    note = ("note.txt", io.BytesIO("彩票是结果上的概率分布".encode()), "text/plain")
    client.post(f"/api/courses/{course['id']}/materials", files={"files": note})
    return client.get(f"/api/courses/{course['id']}").json()


def test_export_then_import_makes_an_independent_copy_with_its_files(tmp_path):
    client = _client(tmp_path)
    course = _course_with_material(client)
    exported = client.get(f"/api/courses/{course['id']}/export")
    assert exported.status_code == 200 and exported.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(exported.content)).namelist()
    assert "manifest.json" in names and "course.json" in names
    assert any(name.startswith("files/materials/") for name in names)

    imported = client.post("/api/courses/import", files={"file": ("backup.zip", io.BytesIO(exported.content), "application/zip")})
    assert imported.status_code == 200, imported.text
    copy = imported.json()
    assert copy["id"] != course["id"] and copy["title"] == "博弈论（导入）"
    assert [m["id"] for m in copy["materials"]] == [m["id"] for m in course["materials"]]
    store = client.app.state.store
    material = copy["materials"][0]
    assert (store.root / "courses" / copy["id"] / "materials" / material["id"]).is_dir()
    assert {c["title"] for c in client.get("/api/courses").json()} == {"博弈论", "博弈论（导入）"}


def test_import_rejects_unsafe_paths_and_foreign_files(tmp_path):
    client = _client(tmp_path)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps({"format": "learning-map-course", "version": 1}))
        archive.writestr("course.json", json.dumps({"title": "x", "nodes": []}))
        archive.writestr("files/../../escape.txt", "no")
    bad = client.post("/api/courses/import", files={"file": ("bad.zip", io.BytesIO(buffer.getvalue()), "application/zip")})
    assert bad.status_code == 400 and "不安全" in bad.json()["detail"]
    other = client.post("/api/courses/import", files={"file": ("x.zip", io.BytesIO(b"not a zip"), "application/zip")})
    assert other.status_code == 400
    assert not (tmp_path / "escape.txt").exists()


def test_deleted_course_is_listed_and_restored(tmp_path):
    client = _client(tmp_path)
    course = _course_with_material(client)
    token = client.post(f"/api/courses/{course['id']}/delete-preview").json()["token"]
    assert client.post(f"/api/courses/{course['id']}/delete", json={"token": token}).status_code == 200
    trash = client.get("/api/trash").json()
    assert [entry["title"] for entry in trash] == ["博弈论"] and trash[0]["deleted_at"]
    # A new course took the name meanwhile; restoring keeps both.
    client.post("/api/courses", json={"title": "博弈论"})
    restored = client.post(f"/api/trash/{course['id']}/restore").json()
    assert restored["id"] == course["id"] and restored["title"] == "博弈论（恢复）"
    assert client.get("/api/trash").json() == []
    assert len(restored["materials"]) == 1
