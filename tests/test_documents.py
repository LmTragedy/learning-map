from __future__ import annotations

from hashlib import sha256
from pathlib import Path

import pytest
from reportlab.pdfgen import canvas

import backend.documents as documents
from backend.documents import DocumentParseError, parse_document, parser_capabilities, render_page

FIXTURES = Path(__file__).parent / "fixtures"


def _require_cached_local_ocr() -> None:
    capabilities = parser_capabilities()
    ocr = capabilities["ocr"]
    if not ocr["available"] or not ocr["configuration_valid"]:
        pytest.skip("Local Tesseract.js and valid language configuration are required for OCR integration checks.")
    if set(ocr["cached_languages"]) != set(ocr["languages"]):
        pytest.skip("OCR language data is downloaded on first use; integration checks run when the local cache is ready.")


def test_digital_pdf_keeps_page_text_and_warns_about_visual_review(tmp_path: Path) -> None:
    source = FIXTURES / "sample-text-formula-table.pdf"
    before = sha256(source.read_bytes()).hexdigest()

    parsed_document = parse_document(source, tmp_path / "parsed")

    assert parsed_document["kind"] == "pdf"
    assert len(parsed_document["pages"]) == 1
    page = parsed_document["pages"][0]
    assert page["number"] == 1
    assert "E = mc^2" in page["text"]
    assert "Algebra" in page["text"]
    assert page["method"] == "pypdf"
    assert page["uncertain"] is True
    assert any("original page" in warning for warning in page["warnings"])
    assert sha256(source.read_bytes()).hexdigest() == before


def test_scanned_pdf_uses_local_ocr_and_stays_uncertain(tmp_path: Path) -> None:
    _require_cached_local_ocr()
    parsed_document = parse_document(FIXTURES / "scanned-english.pdf", tmp_path / "parsed")
    page = parsed_document["pages"][0]

    assert parsed_document["kind"] == "pdf"
    assert page["method"] == "pypdf+tesseract.js"
    assert page["uncertain"] is True
    assert "Evaporation" in page["text"]
    assert any("OCR output" in warning for warning in page["warnings"])


def test_scanned_pdf_preserves_page_when_document_ocr_budget_is_exhausted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock_values = iter([0.0, 181.0])
    monkeypatch.setattr(documents.time, "monotonic", lambda: next(clock_values))

    def fail_if_ocr_runs(*_args: object, **_kwargs: object) -> None:
        pytest.fail("OCR subprocess must not run after the document budget expires")

    monkeypatch.setattr(documents.subprocess, "run", fail_if_ocr_runs)
    parsed_document = parse_document(FIXTURES / "scanned-english.pdf", tmp_path / "parsed")

    assert len(parsed_document["pages"]) == 1
    page = parsed_document["pages"][0]
    assert page["number"] == 1
    assert page["text"] == ""
    assert page["uncertain"] is True
    assert any("180 second document OCR budget" in warning for warning in page["warnings"])
    assert any("Split this file" in warning for warning in page["warnings"])


def test_printed_answer_photo_runs_local_ocr_and_is_not_claimed_as_handwriting(tmp_path: Path) -> None:
    _require_cached_local_ocr()
    parsed_document = parse_document(FIXTURES / "printed-answer-simulation.jpg", tmp_path / "parsed")
    page = parsed_document["pages"][0]

    assert parsed_document["kind"] == "image"
    assert page["method"] == "tesseract.js"
    assert page["uncertain"] is True
    assert "NOT HANDWRITTEN" in page["text"]
    assert "Student response" in page["text"]


def test_render_page_returns_a_png_without_changing_the_original(tmp_path: Path) -> None:
    source = FIXTURES / "sample-text-formula-table.pdf"
    before = sha256(source.read_bytes()).hexdigest()
    target = render_page(source, 1, tmp_path / "source-page.png")

    assert target.is_file()
    assert target.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert sha256(source.read_bytes()).hexdigest() == before


def test_page_outside_pdf_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(DocumentParseError, match="between 1 and 1"):
        render_page(FIXTURES / "sample-text-formula-table.pdf", 2, tmp_path / "page.png")


def test_render_refuses_to_overwrite_the_original_image() -> None:
    source = FIXTURES / "printed-answer-simulation.jpg"
    before = sha256(source.read_bytes()).hexdigest()

    with pytest.raises(DocumentParseError, match="cannot overwrite"):
        render_page(source, 1, source)

    assert sha256(source.read_bytes()).hexdigest() == before


def test_pdf_over_page_limit_is_rejected_before_rendering(tmp_path: Path) -> None:
    source = tmp_path / "too-many-pages.pdf"
    output = canvas.Canvas(str(source))
    for _ in range(201):
        output.drawString(20, 20, "page")
        output.showPage()
    output.save()

    with pytest.raises(DocumentParseError, match="200 page"):
        parse_document(source, tmp_path / "parsed")


def test_docling_output_preserves_source_page_positions_and_marks_empty_pages() -> None:
    pages = documents._parse_docling_output(
        '{"pages":[{"number":1,"text":"First"},{"number":3,"text":"Third"}]}', 3
    )

    assert [page["number"] for page in pages] == [1, 2, 3]
    assert [page["text"] for page in pages] == ["First", "", "Third"]
    assert any("no text blocks" in warning for warning in pages[1]["warnings"])


@pytest.mark.parametrize(
    "response",
    [
        '{"pages":[{"number":0,"text":"Bad"}]}',
        '{"pages":[{"number":4,"text":"Bad"}]}',
        '{"pages":[{"number":1,"text":"A"},{"number":1,"text":"B"}]}',
        '{"pages":[{"number":true,"text":"Bad"}]}',
        '{"pages":[],"truncated":"yes"}',
    ],
)
def test_docling_output_rejects_invalid_or_duplicate_page_numbers(response: str) -> None:
    with pytest.raises(DocumentParseError, match="page number|duplicate page|truncation flag"):
        documents._parse_docling_output(response, 3)


def test_docling_output_rejects_text_over_character_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "MAX_EXTRACTED_TEXT_CHARS", 3)

    with pytest.raises(DocumentParseError, match="10 million character"):
        documents._parse_docling_output('{"pages":[{"number":1,"text":"long"}]}', 1)


def test_ocr_capability_requires_installed_node_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "_OCR_SCRIPT", tmp_path / "ocr.mjs")
    monkeypatch.setattr(documents, "_OCR_PACKAGE", tmp_path / "package.json")
    documents._OCR_SCRIPT.touch()
    documents._OCR_PACKAGE.touch()
    monkeypatch.setattr(documents.shutil, "which", lambda _name: "node.exe")

    assert parser_capabilities()["ocr"]["available"] is False
