"""Which of a node's knowledge pieces none of its saved lessons mentions."""

import re
from html import unescape

_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")
# A piece title such as "理性偏好与理性主体" names two things; each has to appear.
_PARTS = re.compile(r"[与和及、/,，;；·()（）]")


def _plain(text):
    return _SPACE.sub("", unescape(_TAG.sub(" ", text or ""))).casefold()


def uncovered_pieces(node):
    """Piece titles absent from every lesson's text; lessons written before the pieces existed miss them all."""
    lessons = node.get("lessons", [])
    if not lessons or not node.get("pieces"):
        return []
    text = "".join(_plain(lesson.get("html", "")) + _plain(lesson.get("recap", "")) for lesson in lessons)
    if not text:
        return []
    missing = []
    for piece in node["pieces"]:
        title = piece.get("title", "")
        parts = [part for part in (_plain(chunk) for chunk in _PARTS.split(title)) if len(part) >= 2] or [_plain(title)]
        if parts and not all(part in text for part in parts):
            missing.append(title)
    return missing
