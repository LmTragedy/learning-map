"""Cut a problem-set PDF into one high-resolution screenshot per problem.

The screenshot is the problem: formulas, figures and layout survive exactly, which text extraction
cannot promise. Text is still pulled from the same region for search, node hints and the AI prompt.
Problem starts are found from the PDF's own text positions (pdfium character boxes); a page with no
recognisable numbering becomes one problem per page.
"""

import re
import threading
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageOps

from .store import identity

SCALE = 3  # 216 dpi: sharp on high-density screens and legible to the model
MAX_PAGES = 200
MAX_PIXELS = 40_000_000
MARGIN_PT = 8
PAD_PX = 24
_LOCK = threading.RLock()

_HEADINGS = [
    re.compile(r"^[ \t]*(?:Problem|Question|Exercise|Exercice|Task|Q)\s*\.?\s*(\d{1,3})\b", re.I | re.M),
    re.compile(r"^[ \t]*第\s*(\d{1,3})\s*[题問问]", re.M),
    re.compile(r"^[ \t]*[（(]?(\d{1,3})\s*[.)）．、](?!\d)[ \t]*\S", re.M),
]


def _starts(pattern, text):
    starts, last = [], 0
    for match in pattern.finditer(text):
        number = int(match.group(1))
        if last < number <= last + 3:
            leading = len(match.group(0)) - len(match.group(0).lstrip())
            starts.append((str(number), match.start() + leading))
            last = number
    return starts


def render_page(document, index):
    page = document[index]
    try:
        width, height = page.get_size()
        if width * height * SCALE * SCALE > MAX_PIXELS:
            raise ValueError("PDF 页面过大，无法生成高清截图")
        return page.render(scale=SCALE).to_pil().convert("RGB"), height
    finally:
        page.close()


def trim(image):
    """Crop surrounding white space, keeping a little padding; None when the region is blank."""
    gray = ImageOps.invert(image.convert("L")).point(lambda value: 255 if value > 24 else 0)
    box = gray.getbbox()
    if not box:
        return None
    left, top, right, bottom = box
    return image.crop((max(0, left - PAD_PX), max(0, top - PAD_PX),
                       min(image.width, right + PAD_PX), min(image.height, bottom + PAD_PX)))


def stack(images):
    if len(images) == 1:
        return images[0]
    width = max(image.width for image in images)
    canvas = Image.new("RGB", (width, sum(image.height for image in images)), "white")
    offset = 0
    for image in images:
        canvas.paste(image, (0, offset))
        offset += image.height
    return canvas


def split_pdf(path, image_dir):
    """Problems as dict(number, text, images=[saved image dicts], pages=[1-based]); preamble text separate."""
    image_dir = Path(image_dir)
    image_dir.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        document = pdfium.PdfDocument(path)
        try:
            if len(document) > MAX_PAGES:
                raise ValueError(f"PDF 超过 {MAX_PAGES} 页")
            return _split(document, image_dir)
        finally:
            document.close()


def _split(document, image_dir):
    pages = []  # (global offset of the page's text, text)
    combined, textpages = "", []
    try:
        for index in range(len(document)):
            textpage = document[index].get_textpage()
            textpages.append(textpage)
            text = textpage.get_text_range() or ""
            pages.append((len(combined), text))
            combined += text + "\n"
        starts = []
        for pattern in _HEADINGS:
            found = _starts(pattern, combined)
            if len(found) >= 2:
                starts = found
                break
        located = []
        for number, offset in starts:
            page_index = max(i for i, (start, _) in enumerate(pages) if start <= offset)
            local = offset - pages[page_index][0]
            if local >= textpages[page_index].count_chars():
                continue
            top = textpages[page_index].get_charbox(local)[3]
            located.append((number, offset, page_index, top))
    finally:
        for textpage in textpages:
            textpage.close()

    rendered = {}

    def page_image(index):
        if index not in rendered:
            rendered[index] = render_page(document, index)
        return rendered[index]

    def band(index, top_pt, bottom_pt):
        image, height = page_image(index)
        y0 = 0 if top_pt is None else max(0, int((height - top_pt - MARGIN_PT) * SCALE))
        y1 = image.height if bottom_pt is None else min(image.height, int((height - bottom_pt - MARGIN_PT) * SCALE))
        return trim(image.crop((0, y0, image.width, y1))) if y1 > y0 else None

    def save(image, name):
        image_id = identity()
        image.save(image_dir / f"{image_id}.png", format="PNG", optimize=True)
        return dict(id=image_id, name=name, width=image.width, height=image.height)

    problems = []
    if not located:
        # No numbering found (e.g. a scanned sheet): one problem per page.
        for index, (_, text) in enumerate(pages):
            image = band(index, None, None)
            if image is not None:
                problems.append(dict(number=str(len(problems) + 1), text=_clean(text), pages=[index + 1],
                                     images=[save(image, f"第{index + 1}页.png")]))
        return problems, ""
    last_page = len(pages) - 1
    for position, (number, offset, page_index, top) in enumerate(located):
        following = located[position + 1] if position + 1 < len(located) else None
        end_page = following[2] if following else last_page
        parts, used = [], []
        for index in range(page_index, end_page + 1):
            start_top = top if index == page_index else None
            end_top = following[3] if following and index == end_page else None
            part = band(index, start_top, end_top)
            if part is not None:
                parts.append(part)
                used.append(index + 1)
        text = combined[offset:following[1] if following else len(combined)]
        images = [save(stack(parts), f"第{number}题.png")] if parts else []
        problems.append(dict(number=number, text=_clean(text), pages=used or [page_index + 1],
                             images=images))
    preamble = _clean(combined[:located[0][1]])
    return problems, preamble[:4000]


def _clean(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def page_render(pdf_path, page_number, output):
    """Cached HD render of one page, for the learner to frame a screenshot by hand."""
    output = Path(output)
    if output.exists():
        return output
    with _LOCK:
        document = pdfium.PdfDocument(pdf_path)
        try:
            if not 1 <= page_number <= len(document):
                raise KeyError("页码不存在")
            image, _ = render_page(document, page_number - 1)
        finally:
            document.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG")
    return output


def page_count(pdf_path):
    with _LOCK:
        document = pdfium.PdfDocument(pdf_path)
        try:
            return len(document)
        finally:
            document.close()
