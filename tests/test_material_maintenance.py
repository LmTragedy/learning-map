"""Re-parsing a saved material and editing its name or week without breaking cited pages."""

import pytest
from fastapi.testclient import TestClient

from backend import files
from backend.app import create_app
from backend.documents import DocumentParseError
from backend.page_index import page_index_entry, set_page_index


@pytest.fixture
def session(tmp_path):
    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    return client, app.state.store, course, course["materials"][0]


def _parsed(material, prefix="docling"):
    return dict(kind=material["kind"], warnings=[], pages=[
        dict(number=page["number"], text=f"{prefix} {page['number']}", method="docling", uncertain=False, warnings=[])
        for page in material["pages"]])


def test_reparse_swaps_text_keeps_identity_and_backs_up(session, monkeypatch):
    client, store, course, material = session
    seen = []

    def fake_parse(original, output_dir, parser):
        seen.append((original.name, parser))
        return _parsed(material)

    monkeypatch.setattr(files, "parse_document", fake_parse)
    saved = store.course(course["id"])
    first = saved["materials"][0]["pages"][0]["text"]
    with store.edit(course["id"]) as (current, _):
        set_page_index(current, material["id"], 1, first, digest="d", terms=[], key_quotes=[])
    versions_before = len(client.get(f"/api/courses/{course['id']}/versions").json())

    response = client.post(f"/api/courses/{course['id']}/materials/{material['id']}/reparse", json={"parser": "docling"})
    assert response.status_code == 200, response.text
    updated = response.json()["materials"][0]
    assert seen == [("original.pdf", "docling")]
    assert updated["id"] == material["id"] and updated["sha256"] == material["sha256"]
    assert updated["parser"] == "docling"
    assert [page["text"] for page in updated["pages"]] == [f"docling {n}" for n in range(1, len(material["pages"]) + 1)]
    assert page_index_entry(store.course(course["id"]), material["id"], 1, updated["pages"][0]["text"]) is None
    versions = client.get(f"/api/courses/{course['id']}/versions").json()
    assert len(versions) == versions_before + 1
    assert any("重新解析" in version["reason"] for version in versions)


def test_failed_reparse_leaves_material_untouched(session, monkeypatch):
    client, store, course, material = session

    def broken(*_):
        raise DocumentParseError("Docling 是可选组件，尚未安装。")

    monkeypatch.setattr(files, "parse_document", broken)
    before = store.course(course["id"])["materials"][0]
    response = client.post(f"/api/courses/{course['id']}/materials/{material['id']}/reparse", json={"parser": "docling"})
    assert response.status_code == 400
    assert "Docling" in response.json()["detail"]
    assert store.course(course["id"])["materials"][0] == before


def test_reparse_refuses_a_different_page_count(session, monkeypatch):
    client, store, course, material = session
    parsed = _parsed(material)
    parsed["pages"] = parsed["pages"][:-1]
    monkeypatch.setattr(files, "parse_document", lambda *_: parsed)
    response = client.post(f"/api/courses/{course['id']}/materials/{material['id']}/reparse", json={"parser": "docling"})
    assert response.status_code == 400
    assert store.course(course["id"])["materials"][0]["pages"] == material["pages"]


def test_reparse_rejects_unknown_parser_and_material(session):
    client, _, course, material = session
    assert client.post(f"/api/courses/{course['id']}/materials/{material['id']}/reparse",
                       json={"parser": "magic"}).status_code == 422
    assert client.post(f"/api/courses/{course['id']}/materials/missing/reparse",
                       json={"parser": "basic"}).status_code == 404


def test_edit_name_and_week(session):
    client, store, course, material = session
    url = f"/api/courses/{course['id']}/materials/{material['id']}"
    response = client.patch(url, json={"name": "  第三章.pdf ", "week": " 第 3 周 "})
    assert response.status_code == 200, response.text
    saved = store.course(course["id"])["materials"][0]
    assert (saved["name"], saved["week"]) == ("第三章.pdf", "第 3 周")
    assert saved["pages"] == material["pages"]
    assert client.patch(url, json={"week": ""}).json()["materials"][0]["week"] == ""
    assert store.course(course["id"])["materials"][0]["name"] == "第三章.pdf"


@pytest.mark.parametrize("body", [{"name": "   "}, {"name": "a/b.pdf"}, {"name": "x" * 241}, {"week": "w" * 101},
                                  {"sha256": "x"}])
def test_edit_rejects_bad_values(session, body):
    client, store, course, material = session
    response = client.patch(f"/api/courses/{course['id']}/materials/{material['id']}", json=body)
    assert response.status_code in {400, 422}
    assert store.course(course["id"])["materials"][0]["name"] == material["name"]


def test_edit_missing_material_is_404(session):
    client, _, course, _ = session
    assert client.patch(f"/api/courses/{course['id']}/materials/missing", json={"week": "1"}).status_code == 404
