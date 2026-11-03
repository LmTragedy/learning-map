"""Knowledge bridges: which piece of an earlier node a step of a later node uses.

Nodes carry `pieces` (definition / notation / property / method / example) and ordered `steps`.
Each relationship carries `bridges` linking one source piece to one target step, with how it is
used, what goes wrong without it, a strength and a ten-second check question. Relationships saved
before bridges existed are projected with one stable "legacy" bridge so every view and record can
refer to it; nothing is rewritten until the user or the AI fills real bridges in.
"""

from typing import Literal

from pydantic import Field, model_validator

from .schemas import Input, PieceKind, Strength
from .store import identity, timestamp

STRENGTH_ORDER = {"required": 0, "suggested": 1, "extension": 2}
LEGACY_TEXTS = {"旧版关系未记录解释。", "旧版关系未记录适用时机。", "旧版关系未记录依据。"}

# Learner-facing kinds; the stored `relation` keeps its original vocabulary for compatibility.
_KIND = {
    "前置知识": "用到", "工具关系": "用到", "前置（AI 推断）": "用到",
    "归纳关系": "推广", "相似或对比": "对比", "帮助理解": "帮助理解", "综合联系": "综合",
}


class Check(Input):
    question: str = Field(default="", max_length=600)
    answer: str = Field(default="", max_length=1200)


class BridgeInput(Input):
    id: str = Field(default="", max_length=100)
    from_piece: str = Field(default="", max_length=100)
    to_step: str = Field(default="", max_length=100)
    how: str = Field(min_length=1, max_length=600, pattern=r"\S")
    if_missing: str = Field(default="", max_length=600)
    strength: Strength
    check: Check = Field(default_factory=Check)


class BridgeEdit(Input):
    revision: int = Field(ge=0)
    bridges: list[BridgeInput] = Field(max_length=12)

    @model_validator(mode="after")
    def unique_ids(self):
        _unique_ids(self.bridges)
        return self


class PieceInput(Input):
    id: str = Field(default="", max_length=100)
    kind: PieceKind
    title: str = Field(min_length=1, max_length=160, pattern=r"\S")
    detail: str = Field(default="", max_length=1000)


class StepInput(Input):
    id: str = Field(default="", max_length=100)
    title: str = Field(min_length=1, max_length=200, pattern=r"\S")


class PiecesEdit(Input):
    revision: int = Field(ge=0)
    pieces: list[PieceInput] = Field(max_length=10)
    steps: list[StepInput] = Field(max_length=12)

    @model_validator(mode="after")
    def unique_ids(self):
        _unique_ids(self.pieces)
        _unique_ids(self.steps)
        return self


def _unique_ids(records):
    ids = [record.id for record in records if record.id]
    if len(ids) != len(set(ids)):
        raise ValueError("标识不能重复")


class CheckResult(Input):
    result: Literal["known", "unsure"]
    answer: str = Field(default="", max_length=2000)


def learner_kind(edge):
    return _KIND.get(edge.get("relation", ""), "用到")


def real_text(value):
    """Blank out the placeholders older relationships were projected with."""
    value = (value or "").strip()
    return "" if value in LEGACY_TEXTS else value


def bridgeable(edge):
    return not edge.get("synthesis_link") and learner_kind(edge) != "对比"


def legacy_bridge(edge):
    kind = learner_kind(edge)
    controls = edge.get("controls_unlock", True)
    strength = "required" if kind == "用到" and controls else "extension" if kind == "帮助理解" else "suggested"
    return dict(
        id=f"{edge['id']}:legacy", from_piece="", to_step="", how=real_text(edge.get("explanation")).split("\n")[0],
        if_missing="", strength=strength, check=dict(question="", answer=""), sources=[],
        uncertain=True, origin="migrated", legacy=True,
    )


def bridges_of(edge):
    """Stored bridges, or the one migrated bridge an unbridged relationship is read as."""
    if not bridgeable(edge):
        return []
    if "bridges" in edge:
        return edge["bridges"]
    return [legacy_bridge(edge)]


def needs_bridges(edge):
    return bridgeable(edge) and "bridges" not in edge


def strongest(bridges):
    return min((bridge["strength"] for bridge in bridges), key=STRENGTH_ORDER.get, default=None)


def project_bridges(course):
    """Projected on read: learner kinds, migrated bridges and the check state of every bridge."""
    checks = course.get("bridge_checks", {})
    for node in course.get("nodes", []):
        node.setdefault("pieces", [])
        node.setdefault("steps", [])
    piece_state = {}
    for edge in course.get("edges", []):
        edge["kind"] = learner_kind(edge)
        if edge.get("synthesis_link"):
            continue
        edge["bridges"] = [dict(bridge) for bridge in bridges_of(edge)]
        for bridge in edge["bridges"]:
            state = checks.get(bridge["id"])
            bridge["state"] = state
            if state and bridge.get("from_piece"):
                key = (edge["source"], bridge["from_piece"])
                if key not in piece_state or piece_state[key]["at"] < state["at"]:
                    piece_state[key] = state
        edge["strength"] = strongest(edge["bridges"])
    for node in course.get("nodes", []):
        for piece in node["pieces"]:
            bridge_state = piece_state.get((node["id"], piece["id"]))
            own_state = course.get("piece_checks", {}).get(piece["id"])
            piece["state"] = max(
                (state for state in (bridge_state, own_state) if state),
                key=lambda state: state["at"], default=None,
            )
    return course


def bridge_context(course, edge):
    """Readable bridges for AI context: piece and step titles instead of ids, no placeholders."""
    nodes = {node["id"]: node for node in course["nodes"]}
    source, target = nodes.get(edge["source"], {}), nodes.get(edge["target"], {})
    pieces = {piece["id"]: piece for piece in source.get("pieces", [])}
    steps = {step["id"]: (index, step) for index, step in enumerate(target.get("steps", []), 1)}
    readable = []
    for bridge in bridges_of(edge):
        if bridge.get("legacy") and not bridge.get("how"):
            continue
        piece = pieces.get(bridge.get("from_piece"))
        step = steps.get(bridge.get("to_step"))
        readable.append(dict(
            id=bridge["id"],
            uses=f"{piece['kind']}：{piece['title']}" if piece else "",
            in_step=f"第 {step[0]} 步：{step[1]['title']}" if step else "",
            how=bridge.get("how", ""), if_missing=bridge.get("if_missing", ""),
            strength=bridge["strength"], check_state=(course.get("bridge_checks", {}).get(bridge["id"]) or {}).get("result"),
        ))
    return readable


def _find_edge(course, relation_id):
    for edge in course.get("edges", []):
        if edge.get("id") == relation_id and not edge.get("synthesis_link"):
            return edge
    raise KeyError("知识联系不存在")


def _nodes_of(course, edge):
    nodes = {node["id"]: node for node in course["nodes"]}
    if edge["source"] not in nodes or edge["target"] not in nodes:
        raise KeyError("知识联系端点不存在")
    return nodes[edge["source"]], nodes[edge["target"]]


def set_bridges(course, relation_id, bridges):
    """Replace a relationship's bridges with the user's version; edited bridges are never regenerated."""
    edge = _find_edge(course, relation_id)
    if not bridgeable(edge):
        raise ValueError("对比关系不记录知识桥")
    source, target = _nodes_of(course, edge)
    piece_ids = {piece["id"] for piece in source.get("pieces", [])}
    step_ids = {step["id"] for step in target.get("steps", [])}
    previous = {bridge["id"]: bridge for bridge in bridges_of(edge)}
    saved = []
    for item in bridges:
        if item["from_piece"] and item["from_piece"] not in piece_ids:
            raise ValueError("用到的块不属于前一个知识点")
        if item["to_step"] and item["to_step"] not in step_ids:
            raise ValueError("用在的步骤不属于后一个知识点")
        old = previous.get(item["id"], {})
        if old and (old.get("from_piece") != item["from_piece"] or old.get("check") != item["check"]):
            course.get("bridge_checks", {}).pop(old["id"], None)
        saved.append(dict(
            id=item["id"] if item["id"] in previous and not old.get("legacy") else identity(),
            from_piece=item["from_piece"], to_step=item["to_step"], how=item["how"].strip(),
            if_missing=item["if_missing"].strip(), strength=item["strength"],
            check=dict(question=item["check"]["question"].strip(), answer=item["check"]["answer"].strip()),
            sources=old.get("sources", []), uncertain=old.get("uncertain", True), origin="user",
            **({"from_step": old["from_step"]} if old.get("from_step") else {}),
        ))
    edge["bridges"] = saved
    edge["confirmed"] = False


def set_pieces(course, node, pieces, steps):
    """Replace a node's pieces and steps; bridges pointing at removed ones fall back to "unspecified"."""
    old_pieces = {piece["id"]: piece for piece in node.get("pieces", [])}
    node["pieces"] = [
        dict(old_pieces.get(item["id"], {}), id=item["id"] if item["id"] in old_pieces else identity(),
             kind=item["kind"], title=item["title"].strip(), detail=item["detail"].strip())
        for item in pieces
    ]
    for piece in node["pieces"]:
        piece.setdefault("sources", [])
        piece.setdefault("uncertain", True)
    old_steps = {step["id"]: step for step in node.get("steps", [])}
    node["steps"] = [
        dict(id=item["id"], title=item["title"].strip(),
             # The formal statement belongs to the step's wording; a renamed step drops it.
             **({"formal": old_steps[item["id"]]["formal"]} if old_steps[item["id"]].get("formal")
                and old_steps[item["id"]]["title"].strip() == item["title"].strip() else {}))
        if item["id"] in old_steps else dict(id=identity(), title=item["title"].strip())
        for item in steps
    ]
    piece_ids = {piece["id"] for piece in node["pieces"]}
    step_ids = {step["id"] for step in node["steps"]}
    for edge in course.get("edges", []):
        for bridge in edge.get("bridges", []):
            if edge["source"] == node["id"] and bridge["from_piece"] not in piece_ids:
                bridge["from_piece"] = ""
            if edge["target"] == node["id"] and bridge["to_step"] not in step_ids:
                bridge["to_step"] = ""
            if edge["source"] == node["id"] and bridge.get("from_step") and bridge["from_step"] not in step_ids:
                bridge["from_step"] = ""


def record_check(course, relation_id, bridge_id, result, answer=""):
    edge = _find_edge(course, relation_id)
    if not any(bridge["id"] == bridge_id for bridge in bridges_of(edge)):
        raise KeyError("知识桥不存在")
    course.setdefault("bridge_checks", {})[bridge_id] = dict(result=result, at=timestamp(), via="check", answer=answer.strip())


def record_attempt_bridges(course, node, incoming, judgment):
    """A failed practice marks the bridges it blames as missing; a pass confirms the required ones."""
    known = {bridge["id"] for bridge in incoming}
    blamed = [bridge_id for bridge_id in judgment.get("missing_bridges", []) if bridge_id in known]
    judgment["missing_bridges"] = blamed if judgment["outcome"] != "passed" else []
    checks = course.setdefault("bridge_checks", {})
    now = timestamp()
    for bridge_id in judgment["missing_bridges"]:
        checks[bridge_id] = dict(result="missing", at=now, via="attempt", node_id=node["id"])
    if judgment["outcome"] == "passed":
        for bridge in incoming:
            if bridge["strength"] == "required":
                checks[bridge["id"]] = dict(result="known", at=now, via="attempt", node_id=node["id"])


def _piece_by_title(node, draft):
    title = draft["title"].strip()
    for piece in node.setdefault("pieces", []):
        if piece["title"].strip().casefold() == title.casefold():
            return piece
    piece = dict(id=identity(), kind=draft["kind"], title=title, detail=draft.get("detail", "").strip(),
                 sources=draft.get("sources", []), uncertain=draft.get("uncertain", True))
    node["pieces"].append(piece)
    return piece


def _step_by_title(node, title):
    title = title.strip()
    for step in node.setdefault("steps", []):
        if step["title"].strip().casefold() == title.casefold():
            return step
    step = dict(id=identity(), title=title)
    node["steps"].append(step)
    return step


def apply_draft_bridges(source, target, drafts):
    """Turn AI bridges into stored ones, creating pieces and steps the AI named but nodes lack."""
    saved = []
    for draft in drafts:
        piece = _piece_by_title(source, draft["piece"])
        step = _step_by_title(target, draft["step"])
        saved.append(dict(
            id=identity(), from_piece=piece["id"], to_step=step["id"], how=draft["how"].strip(),
            if_missing=draft["if_missing"].strip(), strength=draft["strength"],
            check=dict(question=draft["check_question"].strip(), answer=draft["check_answer"].strip()),
            sources=draft.get("sources", []), uncertain=draft.get("uncertain", True), origin="ai",
        ))
    return saved


def summarize_bridges(source, target, bridges):
    """One readable explanation for views that still show a single sentence per relationship."""
    pieces = {piece["id"]: piece for piece in source.get("pieces", [])}
    steps = {step["id"]: (index, step) for index, step in enumerate(target.get("steps", []), 1)}
    first = bridges[0]
    piece = pieces.get(first["from_piece"])
    step = steps.get(first["to_step"])
    return "\n".join([
        f"用到了什么：{piece['kind']}·{piece['title']}" if piece else "用到了什么：未指定",
        f"在哪一步用：第 {step[0]} 步 · {step[1]['title']}——{first['how']}" if step else f"在哪一步用：{first['how']}",
        f"不会会怎样：{first['if_missing'] or '未记录'}",
    ])


def stamp_generated(node):
    """Give AI pieces and steps of a freshly generated node their ids."""
    node["pieces"] = [
        dict(id=identity(), kind=piece["kind"], title=piece["title"].strip(), detail=piece["detail"].strip(),
             sources=piece.get("sources", []), uncertain=piece.get("uncertain", True))
        for piece in node.get("pieces", [])
    ]
    node["steps"] = [dict(id=identity(), title=title.strip()) for title in node.get("steps", [])]
