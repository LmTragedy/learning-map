"""Main lines: ordered chains of nodes that together solve one larger problem, like metro lines.

A node on two or more lines is a transfer station; transfers are derived on read, never stored.
Lines the user edited keep `origin="user"` and are not replaced when the AI regenerates lines.
"""

from pydantic import Field

from .review_scope import active_sources, strict_scope
from .schemas import Input
from .store import identity


class StoryStep(Input):
    """One sentence of a line's story, about one station; the sentences join along its bridges."""
    node_id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=400)


class LineInput(Input):
    name: str = Field(min_length=1, max_length=80)
    goal: str = Field(default="", max_length=400)
    node_ids: list[str] = Field(min_length=1, max_length=60)
    endpoint: str = Field(default="", max_length=400)
    story: list[StoryStep] = Field(default_factory=list, max_length=60)


class LineEdit(LineInput):
    revision: int = Field(ge=0)


class LineRevision(Input):
    revision: int = Field(ge=0)


def find_line(course, line_id):
    for line in course.get("lines", []):
        if line["id"] == line_id:
            return line
    raise KeyError("主线不存在")


def anchored_line_ids(course):
    return {
        note["anchor"]["id"] for note in course.get("notes", [])
        if note.get("anchor", {}).get("kind") == "line"
    }


def clean_line(course, fields):
    known = {node["id"] for node in course["nodes"]}
    requested = fields["node_ids"]
    if any(node_id not in known for node_id in requested):
        raise ValueError("主线包含不存在的知识点")
    node_ids = list(dict.fromkeys(requested))
    if not node_ids:
        raise ValueError("主线至少要有一个存在的知识点")
    name = fields["name"].strip()
    if not name:
        raise ValueError("主线名称不能为空")
    story = _clean_story(fields.get("story", []), node_ids)
    return dict(
        name=name, goal=fields.get("goal", "").strip(), node_ids=node_ids,
        endpoint=fields.get("endpoint", "").strip(), story=story,
    )


def _clean_story(raw_story, node_ids):
    story = [dict(node_id=step["node_id"], text=step["text"].strip()) for step in raw_story]
    if any(step["node_id"] not in node_ids for step in story):
        raise ValueError("串讲包含不在主线中的知识点")
    if any(not step["text"] for step in story):
        raise ValueError("串讲内容不能为空")
    return story


def save_line(course, line_id, fields):
    line = find_line(course, line_id)
    line.update(clean_line(course, fields), origin="user")
    return line


def new_line(course, fields, origin="user"):
    line = dict(id=identity(), origin=origin, **clean_line(course, fields))
    course.setdefault("lines", []).append(line)
    return line


def node_progress(node):
    pieces = node.get("pieces", [])
    done = node["status"] in {"mastered", "passed"}
    if pieces:
        known = sum((piece.get("state") or {}).get("result") == "known" for piece in pieces)
        total = len(pieces)
    else:
        known = int(done)
        total = 1
    return dict(known=known, total=total, ratio=known / total, done=done)


def _nodes_progress(nodes):
    done = sum(node["progress"]["done"] for node in nodes)
    total = len(nodes)
    return dict(known=done, done=done, total=total, ratio=done / total if total else 0)


def _progress_for(node_ids, nodes):
    selected = [nodes[node_id] for node_id in node_ids if node_id in nodes]
    done = sum(node["progress"]["known"] for node in selected)
    total = sum(node["progress"]["total"] for node in selected)
    pieces = [piece for node in selected for piece in node.get("pieces", [])]
    known_pieces = sum((piece.get("state") or {}).get("result") == "known" for piece in pieces)
    nodes_done = sum(node["progress"]["done"] for node in selected)
    return dict(
        done=done, total=total, ratio=done / total if total else 0,
        pieces=dict(known=known_pieces, total=len(pieces), ratio=known_pieces / len(pieces) if pieces else 0),
        nodes=dict(done=nodes_done, total=len(selected), ratio=nodes_done / len(selected) if selected else 0),
    )


def _project_scoped_progress(course):
    scoped_nodes = [node for node in course["nodes"] if active_sources(course, node)]
    for node in scoped_nodes:
        node["progress"] = node_progress(node)
    nodes = {node["id"]: node for node in scoped_nodes}
    aggregate = _progress_for(nodes, nodes)
    course["lines"], course["transfers"] = [], []
    course.pop("overview", None)
    course["progress"] = aggregate | dict(nodes=_nodes_progress(scoped_nodes), lines=[])
    return course


def _project_line_progress(course, nodes):
    seen = {}
    for index, line in enumerate(course.get("lines", [])):
        line["node_ids"] = [node_id for node_id in line["node_ids"] if node_id in nodes]
        line["color"] = index
        line["progress"] = _progress_for(line["node_ids"], nodes)
        for node_id in line["node_ids"]:
            seen.setdefault(node_id, []).append(line["id"])
    course["transfers"] = [node_id for node_id, line_ids in seen.items() if len(line_ids) > 1]
    aggregate = _progress_for(list(nodes), nodes)
    course["progress"] = aggregate | dict(
        nodes=_nodes_progress(course["nodes"]),
        lines=[dict(id=line["id"], **line["progress"]) for line in course.get("lines", [])],
    )
    return course


def project_lines(course):
    """Project line links and progress without changing completion or unlock status."""
    if strict_scope(course):
        return _project_scoped_progress(course)
    for node in course["nodes"]:
        node["progress"] = node_progress(node)
    nodes = {node["id"]: node for node in course["nodes"]}
    return _project_line_progress(course, nodes)
