"""Checks on an AI plan reply before it is saved.

References to unknown or unrelated nodes are dropped and listed. Knowledge pieces are never dropped:
a piece the reply leaves out, or hands to another node, stays with this node and becomes a conflict
for the learner to check.
"""

import re

from ..review_scope import active_sources
from .scope import scoped_pieces

_REFERENCE_FIELDS = ("borrows", "defers", "distinctions")


def _key(text):
    return re.sub(r"\s+", "", text or "").casefold()


def _check_sources(course, node, sources):
    """Keep sources on this node's own pages; blank quotes that are not in the page text.

    Returns the kept sources and the reasons (if any) they make the plan uncertain.
    """
    allowed = {(source["material_id"], source["page"]) for source in active_sources(course, node)}
    materials = {material["id"]: material for material in course["materials"]}
    kept, reasons = [], []
    for source in sources:
        where = f"第 {source['page']} 页"
        if (source["material_id"], source["page"]) not in allowed:
            reasons.append(f"引用的{where}不是本节点的来源，已移除")
            continue
        page = materials[source["material_id"]]["pages"][source["page"] - 1]
        if source["quote"] and _key(source["quote"]) not in _key(page["text"]):
            source["quote"] = ""
            reasons.append(f"{where}的引文在原文中找不到，已清空")
        if page.get("uncertain"):
            reasons.append(f"{where}的提取文字本身存疑")
        kept.append(source)
    return kept, reasons


def _earlier_only(neighbours):
    """Nodes that come only before this one: what they teach is borrowed here, never deferred to them."""
    return {entry["node"]["id"] for entry in neighbours
            if "earlier" in entry["reasons"] and "later" not in entry["reasons"]}


def _move_backward_defers(draft, earlier):
    """A defer pointing at an earlier node is content that node already teaches: record it as borrowed."""
    moved, kept = [], []
    for entry in draft["defers"]:
        if entry["node_id"] in earlier:
            draft["borrows"].append(dict(node_id=entry["node_id"], what=entry["what"], use=""))
            moved.append(f"defers→borrows:{entry['node_id']}")
        else:
            kept.append(entry)
    draft["defers"] = kept
    return moved


def validate_draft(course, node, draft, neighbours):
    """Return the cleaned draft and the list of references that were dropped.

    `neighbours` is coordination_neighbours(course, node). Entries moved from defers to borrows are
    listed in draft["moved_refs"]; they are a correction, not a sign the plan is unreliable.
    """
    related_ids = {entry["node"]["id"] for entry in neighbours}
    dropped = []
    for field in _REFERENCE_FIELDS:
        kept = []
        for entry in draft[field]:
            if entry["node_id"] in related_ids:
                kept.append(entry)
            else:
                dropped.append(f"{field}:{entry['node_id']}")
        draft[field] = kept
    allowed_conflict_ids = related_ids | {node["id"]}
    for conflict in draft["conflicts"]:
        dropped.extend(f"conflicts:{node_id}" for node_id in conflict["node_ids"] if node_id not in allowed_conflict_ids)
        conflict["node_ids"] = [node_id for node_id in conflict["node_ids"] if node_id in allowed_conflict_ids]
    draft["moved_refs"] = _move_backward_defers(draft, _earlier_only(neighbours))

    titles = {_key(piece["title"]): piece["title"] for piece in scoped_pieces(course, node)}
    for point in draft["owns"]:
        if point["piece"] and _key(point["piece"]) not in titles:
            dropped.append(f"owns.piece:{point['piece']}")
            point["piece"] = ""
        elif point["piece"]:
            point["piece"] = titles[_key(point["piece"])]
    owned = {_key(point["piece"]) for point in draft["owns"] if point["piece"]}
    for key, title in titles.items():
        if key not in owned:
            draft["owns"].append(dict(piece=title, point=title, depth="讲透"))
            draft["conflicts"].append(dict(node_ids=[node["id"]],
                                           issue=f"知识块「{title}」没有分配到本节分工，已保留在本节，需核对。"))
    for entry in draft["defers"]:
        if _key(entry["what"]) in titles:
            draft["conflicts"].append(dict(
                node_ids=[node["id"], entry["node_id"]],
                issue=f"本节知识块「{titles[_key(entry['what'])]}」被列为由其他节点深入；知识块仍保留在本节，需核对。"))

    draft["sources"], reasons = _check_sources(course, node, draft["sources"])
    draft["candidate"] = not titles
    if draft["uncertain"]:
        reasons.insert(0, "AI 认为依据不足" + (f"：{draft['note'].strip()}" if draft["note"].strip() else ""))
    if draft["candidate"]:
        reasons.append("本节点没有知识块，这是候选分工")
    if draft["conflicts"]:
        reasons.append(f"有 {len(draft['conflicts'])} 处分工冲突")
    if dropped:
        reasons.append(f"有 {len(dropped)} 处无效引用已移除")
    # Several sources on one page give the same reason; show each reason once, in order.
    draft["uncertain_reasons"] = list(dict.fromkeys(reasons))
    draft["uncertain"] = bool(reasons)
    return draft, dropped
