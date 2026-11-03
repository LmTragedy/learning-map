"""Local document parsing adapters used by the course application."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader
from pypdf.errors import PyPdfError

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_PDF_PAGES = 200
MAX_IMAGE_PIXELS = 40_000_000
MAX_EXTRACTED_TEXT_CHARS = 10_000_000
MAX_DOCLING_OUTPUT_BYTES = 40_000_000
OCR_DOCUMENT_TIMEOUT_SECONDS = 180
DOCLING_TIMEOUT_SECONDS = 120
_PDFIUM_LOCK = threading.RLock()
_OCR_LOCK = threading.Lock()
_TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".csv", ".html", ".htm", ".rst"}
_OCR_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ocr.mjs"
_OCR_PACKAGE = _OCR_SCRIPT.parent / "package.json"
_OCR_CACHE = Path(__file__).resolve().parents[1] / "data" / "ocr-cache"


class DocumentParseError(ValueError):
    """An input cannot be safely or correctly parsed."""


def _document_result(kind: str, pages: list[dict[str, Any]], warnings: list[str]) -> dict[str, Any]:
    return {"kind": kind, "pages": pages, "warnings": warnings}


def _check_file(path: Path) -> Path:
    source = Path(path).expanduser().resolve(strict=True)
    if not source.is_file():
        raise DocumentParseError("输入必须是普通文件。")
    if source.stat().st_size > MAX_FILE_BYTES:
        raise DocumentParseError("文件超过 50 MB 解析上限。")
    return source


def _check_separate_output(source: Path, output_path: Path) -> Path:
    target = Path(output_path).expanduser().resolve()
    if target == source or (target.exists() and os.path.samefile(source, target)):
        raise DocumentParseError("渲染页面不能覆盖原文件。")
    return target


def _page(number: int, text: str = "", method: str = "pypdf", uncertain: bool = False,
          warnings: list[str] | None = None) -> dict[str, Any]:
    return {"number": number, "text": text, "method": method, "uncertain": uncertain,
            "warnings": warnings or []}


_OCR_BUDGET_WARNING = (
    "The 180 second document OCR budget was exhausted; remaining pages were not OCRed. "
    "Split this file into smaller documents to continue local OCR."
)


def _ocr_languages() -> tuple[str, list[str]]:
    languages = os.environ.get("LEARNING_MAP_OCR_LANGUAGES", "eng+chi_sim").strip()
    if not re.fullmatch(r"[a-z0-9_]+(?:\+[a-z0-9_]+)*", languages) or len(languages) > 128:
        raise DocumentParseError("LEARNING_MAP_OCR_LANGUAGES 必须是用 '+' 分隔的 Tesseract 语言代码。")
    return languages, [language for language in languages.split("+")
                       if not (_OCR_CACHE / f"{language}.traineddata").is_file()]


def _run_ocr_worker(payload: dict[str, str], deadline: float) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, _OCR_BUDGET_WARNING
        if not _OCR_LOCK.acquire(timeout=remaining):
            return None, _OCR_BUDGET_WARNING
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, _OCR_BUDGET_WARNING
            completed = subprocess.run(
                ["node", str(_OCR_SCRIPT)], input=json.dumps(payload), text=True,
                capture_output=True, timeout=remaining, check=False,
                cwd=str(_OCR_SCRIPT.parent),
            )
        finally:
            _OCR_LOCK.release()
    except subprocess.TimeoutExpired:
        if time.monotonic() >= deadline:
            return None, _OCR_BUDGET_WARNING
        return None, "Local OCR exceeded its remaining time budget."
    except OSError as exc:
        return None, f"Local OCR could not run ({type(exc).__name__})."
    return completed, None


def _ocr_notices(text: str, missing_languages: list[str]) -> list[str]:
    notices = []
    if missing_languages:
        notices.append("OCR language data is not cached yet; first use may download "
                       + ", ".join(missing_languages) + " from the Tesseract.js data CDN. Models are cached locally.")
    if text.strip():
        notices.append("OCR output may contain recognition errors; compare it with the original page.")
    return notices


def _ocr(image_path: Path, deadline: float) -> tuple[str, str | None, list[str]]:
    if not _OCR_SCRIPT.is_file() or not _OCR_PACKAGE.is_file():
        return "", "Local OCR is unavailable: install the optional scripts dependencies with npm install in scripts/.", []
    _OCR_CACHE.mkdir(parents=True, exist_ok=True)
    languages, missing_languages = _ocr_languages()
    payload = {"image": str(image_path), "cache": str(_OCR_CACHE), "languages": languages}
    completed, error = _run_ocr_worker(payload, deadline)
    if error:
        return "", error, []
    if completed.returncode != 0:
        return "", "Local OCR failed. Check first-use language-data network access and the OCR installation.", []
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return "", "Local OCR failed: the OCR worker returned invalid output.", []
    if not isinstance(response, dict) or not isinstance(response.get("text"), str):
        return "", "Local OCR failed: the OCR worker returned an invalid text field.", []
    text = response["text"]
    return text, None, _ocr_notices(text, missing_languages)


def _render_pdf_page(document: pdfium.PdfDocument, page_number: int, output_path: Path) -> Path:
    if page_number < 1 or page_number > len(document):
        raise DocumentParseError(f"PDF 页码必须在 1 到 {len(document)} 之间。")
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    page = document[page_number - 1]
    try:
        width, height = page.get_size()
        if width <= 0 or height <= 0 or width * height * 2.25 > MAX_IMAGE_PIXELS:
            raise DocumentParseError("渲染页面超过 4000 万像素安全上限。")
        bitmap = page.render(scale=1.5)
        image = bitmap.to_pil()
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise DocumentParseError("渲染页面超过 4000 万像素安全上限。")
        image.save(output_path, format="PNG")
    finally:
        page.close()
    return output_path


def render_page(path: Path, page: int, output_path: Path) -> Path:
    """Render one PDF page or copy a supported image to a bounded PNG."""
    source = _check_file(path)
    output_path = _check_separate_output(source, output_path)
    if source.suffix.lower() == ".pdf":
        with _PDFIUM_LOCK:
            try:
                document = pdfium.PdfDocument(source)
                try:
                    if len(document) > MAX_PDF_PAGES:
                        raise DocumentParseError("PDF 超过 200 页解析上限。")
                    return _render_pdf_page(document, page, output_path)
                finally:
                    document.close()
            except DocumentParseError:
                raise
            except (pdfium.PdfiumError, OSError, ValueError) as exc:
                raise DocumentParseError(f"PDF 页面渲染失败（{type(exc).__name__}）。") from exc
    if source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}:
        raise DocumentParseError("只能渲染 PDF 页面和位图图片。")
    if page != 1:
        raise DocumentParseError("图片只有第 1 页。")
    target = output_path
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source) as image:
            _check_image(image)
            image.convert("RGB").save(target, format="PNG")
    except UnidentifiedImageError as exc:
        raise DocumentParseError("图片文件无效或格式不受支持。") from exc
    return target


def _check_image(image: Image.Image) -> None:
    if image.width <= 0 or image.height <= 0 or image.width * image.height > MAX_IMAGE_PIXELS:
        raise DocumentParseError("图片超过 4000 万像素安全上限。")


def _parse_text(source: Path) -> dict[str, Any]:
    text = source.read_text(encoding="utf-8-sig", errors="replace")
    warnings = []
    if "\ufffd" in text:
        warnings.append("Some characters were not valid UTF-8 and were replaced.")
    return _document_result("text", [_page(1, text, "utf-8", bool(warnings), warnings)], warnings)


def _parse_image(source: Path, output_dir: Path, deadline: float) -> dict[str, Any]:
    try:
        with Image.open(source) as image:
            _check_image(image)
            image.verify()
        rendered = render_page(source, 1, output_dir / "page-001.png")
    except UnidentifiedImageError as exc:
        raise DocumentParseError("图片文件无效或格式不受支持。") from exc
    text, error, notices = _ocr(rendered, deadline)
    page_warnings = [*notices, *([error] if error else [])]
    method = "tesseract.js" if not error else "unavailable"
    return _document_result("image", [_page(1, text, method, True, page_warnings)], page_warnings)


def _open_pdf(source: Path) -> tuple[PdfReader, pdfium.PdfDocument]:
    try:
        reader = PdfReader(source, strict=True)
        if reader.is_encrypted:
            raise DocumentParseError("不支持加密的 PDF。")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise DocumentParseError("PDF 超过 200 页解析上限。")
        return reader, pdfium.PdfDocument(source)
    except DocumentParseError:
        raise
    except (PyPdfError, pdfium.PdfiumError, OSError, ValueError) as exc:
        raise DocumentParseError(f"PDF 无效或无法读取（{type(exc).__name__}）。") from exc


def _extract_pdf_text(pdf_page: Any, number: int) -> tuple[str, str | None]:
    try:
        return pdf_page.extract_text() or "", None
    except (PyPdfError, ValueError, TypeError) as exc:
        return "", f"Page {number} text extraction failed ({type(exc).__name__})."


def _recognize_pdf_page(
    pdf_document: pdfium.PdfDocument, number: int, deadline: float
) -> tuple[str, str | None, list[str]]:
    if time.monotonic() >= deadline:
        return "", _OCR_BUDGET_WARNING, []
    with tempfile.TemporaryDirectory(prefix="learning-map-ocr-") as temp_dir:
        # Hold the pdfium lock only while rendering; OCR can take minutes and must not block previews.
        with _PDFIUM_LOCK:
            rendered = _render_pdf_page(pdf_document, number, Path(temp_dir) / "page.png")
        return _ocr(rendered, deadline)


def _limit_pdf_page_text(text: str, used_chars: int) -> tuple[str, str | None]:
    remaining = max(0, MAX_EXTRACTED_TEXT_CHARS - used_chars)
    if len(text) <= remaining:
        return text, None
    warning = "Extracted text was truncated at the 10 million character safety limit."
    return text[:remaining], warning


def _read_pdf_page(pdf_page: Any, pdf_document: pdfium.PdfDocument,
                   number: int, used_chars: int, deadline: float) -> dict[str, Any]:
    text, extraction_error = _extract_pdf_text(pdf_page, number)
    page_warnings = [extraction_error] if extraction_error else []
    if extraction_error is None:
        page_warnings.append("Check the original page image for formulas, tables, and layout.")
    method = "pypdf"
    if not text.strip() and extraction_error is None:
        recognized, error, notices = _recognize_pdf_page(pdf_document, number, deadline)
        page_warnings.extend(notices)
        page_warnings.extend([error] if error else [])
        text = recognized
        method = "pypdf" if error else "pypdf+tesseract.js"
        if not text.strip():
            page_warnings.append("No selectable text was found; this page may be scanned. OCR did not produce readable text.")
    text, limit_warning = _limit_pdf_page_text(text, used_chars)
    page_warnings.extend([limit_warning] if limit_warning else [])
    return _page(number, text, method, True, page_warnings)


def _parse_pdf_basic(source: Path, deadline: float) -> dict[str, Any]:
    with _PDFIUM_LOCK:
        reader, pdf_document = _open_pdf(source)
    pages = []
    used_chars = 0
    try:
        for number, pdf_page in enumerate(reader.pages, start=1):
            page_record = _read_pdf_page(pdf_page, pdf_document, number, used_chars, deadline)
            pages.append(page_record)
            used_chars += len(page_record["text"])
    finally:
        with _PDFIUM_LOCK:
            pdf_document.close()
    warnings = [warning for page in pages for warning in page["warnings"]]
    return _document_result("pdf", pages, list(dict.fromkeys(warnings)))


def _validate_docling_source(source: Path) -> int:
    if source.suffix.lower() == ".pdf":
        try:
            reader = PdfReader(source, strict=True)
            if reader.is_encrypted:
                raise DocumentParseError("不支持加密的 PDF。")
            if len(reader.pages) > MAX_PDF_PAGES:
                raise DocumentParseError("PDF 超过 200 页解析上限。")
        except DocumentParseError:
            raise
        except (PyPdfError, OSError, ValueError) as exc:
            raise DocumentParseError(f"PDF 无效或无法读取（{type(exc).__name__}）。") from exc
        return len(reader.pages)
    try:
        with Image.open(source) as image:
            _check_image(image)
            image.verify()
    except UnidentifiedImageError as exc:
        raise DocumentParseError("图片文件无效或格式不受支持。") from exc
    return 1


def _docling_script() -> str:
    return r'''
import json, sys
from docling.document_converter import DocumentConverter
source = sys.argv[1]
conversion = DocumentConverter().convert(source)
parsed_document = conversion.document
pages = {}
total_characters = 0
truncated = False
for document_element, _level in parsed_document.iterate_items():
    text = str(getattr(document_element, "text", "") or "").strip()
    if not text:
        continue
    remaining = 10000000 - total_characters
    if remaining <= 0:
        truncated = True
        break
    if len(text) > remaining:
        text = text[:remaining]
        truncated = True
    provenances = getattr(document_element, "prov", None) or []
    page_no = int(getattr(provenances[0], "page_no", 1)) if provenances else 1
    pages.setdefault(page_no, []).append(text)
    total_characters += len(text)
print(json.dumps({"pages": [{"number": number, "text": "\n".join(parts)} for number, parts in sorted(pages.items())], "truncated": truncated}))
'''


def _run_docling(source: Path) -> str:
    with tempfile.TemporaryFile() as stdout_file:
        try:
            completed = subprocess.run(
                [sys.executable, "-c", _docling_script(), str(source)],
                stdout=stdout_file, stderr=subprocess.PIPE, timeout=DOCLING_TIMEOUT_SECONDS, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise DocumentParseError(f"Docling 超过 {DOCLING_TIMEOUT_SECONDS} 秒未完成；模型可能尚未初始化或下载完整。") from exc
        if stdout_file.tell() > MAX_DOCLING_OUTPUT_BYTES:
            raise DocumentParseError("Docling 输出超过 1000 万字符安全上限。")
        if completed.returncode:
            error = completed.stderr.decode("utf-8", errors="replace").strip()
            if "No module named 'docling'" in error:
                raise DocumentParseError("Docling 是可选组件，尚未安装。请在后端环境中运行 `pip install docling` 安装。")
            raise DocumentParseError(f"Docling 转换失败（进程退出码 {completed.returncode}）。")
        stdout_file.seek(0)
        return stdout_file.read(MAX_DOCLING_OUTPUT_BYTES + 1).decode("utf-8")


def _parse_docling_output(stdout: str, page_count: int) -> list[dict[str, Any]]:
    try:
        parsed_document = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise DocumentParseError("Docling 返回了无效的结构化输出。") from exc
    if not isinstance(parsed_document, dict) or not isinstance(parsed_document.get("pages"), list):
        raise DocumentParseError("Docling 返回了意外的页面结构。")
    if "truncated" in parsed_document and not isinstance(parsed_document["truncated"], bool):
        raise DocumentParseError("Docling 返回了无效的截断标记。")
    records = {}
    total_characters = 0
    for page_record in parsed_document["pages"]:
        if not isinstance(page_record, dict):
            raise DocumentParseError("Docling 返回了无效的页面记录。")
        number, text = page_record.get("number"), page_record.get("text")
        if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= page_count:
            raise DocumentParseError("Docling 返回的页码超出原文档范围。")
        if number in records or not isinstance(text, str):
            raise DocumentParseError("Docling 返回了重复页面或无效的文字字段。")
        total_characters += len(text)
        if total_characters > MAX_EXTRACTED_TEXT_CHARS:
            raise DocumentParseError("Docling 输出超过 1000 万字符安全上限。")
        records[number] = text
    warnings = ["Review the original page image for formulas, tables, and visual structure."]
    if parsed_document.get("truncated"):
        warnings.append("Docling text was truncated at the 10 million character safety limit.")
    return [
        _page(number, records.get(number, ""), "docling", True,
              warnings if number in records else ["Docling found no text blocks on this page.", *warnings])
        for number in range(1, page_count + 1)
    ]


def _parse_docling(source: Path) -> dict[str, Any]:
    page_count = _validate_docling_source(source)
    pages = _parse_docling_output(_run_docling(source), page_count)
    warnings = [warning for entry in pages for warning in entry["warnings"]]
    return _document_result("pdf" if source.suffix.lower() == ".pdf" else "image", pages, warnings)


def parse_document(path: Path, output_dir: Path, parser: str = "basic") -> dict[str, Any]:
    """Parse bounded local files while retaining page provenance and uncertainty."""
    source = _check_file(path)
    ocr_deadline = time.monotonic() + OCR_DOCUMENT_TIMEOUT_SECONDS
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    parser = str(parser).strip().lower()
    if parser not in {"basic", "docling"}:
        raise DocumentParseError("解析器只能是 'basic' 或 'docling'。")
    suffix = source.suffix.lower()
    if suffix in _TEXT_SUFFIXES:
        if parser == "docling":
            raise DocumentParseError("Docling 适配器目前只接受 PDF 和位图图片。")
        return _parse_text(source)
    if suffix == ".pdf":
        if parser == "docling":
            return _parse_docling(source)
        return _parse_pdf_basic(source, ocr_deadline)
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}:
        if parser == "docling":
            return _parse_docling(source)
        return _parse_image(source, output_dir, ocr_deadline)
    raise DocumentParseError(f"不支持的文件类型：{suffix or '（无扩展名）'}。")


def parser_capabilities() -> dict[str, Any]:
    """Describe locally available parsers without importing optional engines."""
    languages_setting = os.environ.get("LEARNING_MAP_OCR_LANGUAGES", "eng+chi_sim").strip()
    valid_languages = len(languages_setting) <= 128 and bool(
        re.fullmatch(r"[a-z0-9_]+(?:\+[a-z0-9_]+)*", languages_setting)
    )
    languages = [
        language.strip()
        for language in languages_setting.split("+")
        if language.strip()
    ]
    cached = [language for language in languages if (_OCR_CACHE / f"{language}.traineddata").is_file()]
    ocr_package = _OCR_SCRIPT.parent / "node_modules" / "tesseract.js" / "package.json"
    ocr_available = (
        shutil.which("node") is not None and _OCR_SCRIPT.is_file()
        and _OCR_PACKAGE.is_file() and ocr_package.is_file()
    )
    try:
        import importlib.util

        docling_available = importlib.util.find_spec("docling") is not None
    except (ImportError, ValueError):
        docling_available = False
    return {
        "basic": {"available": True, "engines": ["pypdf", "pypdfium2"]},
        "ocr": {
            "available": ocr_available,
            "languages": languages,
            "configuration_valid": valid_languages,
            "cached_languages": cached,
            "first_use_may_download": ocr_available and valid_languages and len(cached) != len(languages),
        },
        "docling": {"available": docling_available, "install": "pip install docling"},
        "limits": {"max_file_bytes": MAX_FILE_BYTES, "max_pdf_pages": MAX_PDF_PAGES,
                   "max_image_pixels": MAX_IMAGE_PIXELS,
                   "max_extracted_text_chars": MAX_EXTRACTED_TEXT_CHARS,
                   "ocr_document_timeout_seconds": OCR_DOCUMENT_TIMEOUT_SECONDS},
    }
