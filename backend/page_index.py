"""Per-page material index stored in `course["page_index"]`, outside `materials`.

AI results may not change `materials`, so digests, terms and verbatim key lines live here, keyed by
material id and page number, and tied to the page text by a hash so a re-read page goes stale.
"""

import hashlib


def text_pages(course):
    """(material, page number, page) for every page that has text."""
    for material in course["materials"]:
        for number, page in enumerate(material.get("pages", []), 1):
            if page.get("text", "").strip():
                yield material, number, page


def page_index_entry(course, material_id, number, text):
    """The saved index for one page, or None when absent or written for different page text."""
    entry = course.get("page_index", {}).get(material_id, {}).get(str(number))
    return entry if entry and entry["text_hash"] == _text_hash(text) else None


def set_page_index(course, material_id, number, text, **fields):
    entries = course.setdefault("page_index", {}).setdefault(material_id, {})
    entries[str(number)] = (page_index_entry(course, material_id, number, text) or {}) | fields | dict(
        text_hash=_text_hash(text))


def is_indexed(course, material, number, page):
    """Whether the page carries the full index (terms and key lines), not just a map digest."""
    return "key_quotes" in (page_index_entry(course, material["id"], number, page["text"]) or {})


def index_progress(course):
    pages = list(text_pages(course))
    return dict(indexed=sum(is_indexed(course, *page) for page in pages), total=len(pages))


def _text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]
