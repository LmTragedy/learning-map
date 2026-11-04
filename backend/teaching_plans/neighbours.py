"""The related nodes a plan has to be coordinated with.

Three kinds of nodes are looked at together with the target: nodes citing the same material page,
nodes joined to it by a dependency or bridge, and nodes whose saved plan already names it (or that its
own plan names). These only point out who to coordinate with; they never decide what belongs where.
"""

from .scope import in_scope, page_keys, plan_book

MAX_NEIGHBOURS = 12
_REASON_ORDER = ("same_page", "earlier", "later", "contrast", "plan_ref")
_CONTRAST = {"相似或对比"}


def plan_references(plan):
    """Node ids a saved plan names in its borrowed, deferred and distinction entries."""
    if not plan:
        return set()
    return {entry["node_id"] for field in ("borrows", "defers", "distinctions") for entry in plan.get(field, [])}


def coordination_neighbours(course, node, *, structural_only=False):
    """[{node, reasons, shared_pages}] in a stable order, capped at MAX_NEIGHBOURS.

    `structural_only` leaves out nodes found only through saved plans. Staleness uses it, so saving
    a plan (which names other nodes) never makes that same plan stale at once.
    """
    nodes = {item["id"]: item for item in course["nodes"]}
    found = {}

    def add(other_id, reason, page=None):
        other = nodes.get(other_id)
        if other is None or other_id == node["id"] or not in_scope(course, other):
            return
        entry = found.setdefault(other_id, dict(node=other, reasons=set(), shared_pages=set()))
        entry["reasons"].add(reason)
        if page:
            entry["shared_pages"].add(page)

    mine = page_keys(course, node)
    for other in course["nodes"]:
        if other["id"] != node["id"]:
            for page in sorted(mine & page_keys(course, other)):
                add(other["id"], "same_page", page)
    for edge in course.get("edges", []):
        if edge.get("synthesis_link"):
            continue
        contrast = edge.get("relation") in _CONTRAST or edge.get("kind") == "对比"
        if edge["source"] == node["id"]:
            add(edge["target"], "contrast" if contrast else "later")
        elif edge["target"] == node["id"]:
            add(edge["source"], "contrast" if contrast else "earlier")
    book = {} if structural_only else plan_book(course)
    for other_id in plan_references(book.get(node["id"])):
        add(other_id, "plan_ref")
    for other_id, plan in book.items():
        if node["id"] in plan_references(plan):
            add(other_id, "plan_ref")

    def rank(entry):
        first = min(_REASON_ORDER.index(reason) for reason in entry["reasons"])
        return first, course["nodes"].index(entry["node"])

    ordered = sorted(found.values(), key=rank)[:MAX_NEIGHBOURS]
    return [dict(node=entry["node"], reasons=[r for r in _REASON_ORDER if r in entry["reasons"]],
                 shared_pages=sorted(entry["shared_pages"])) for entry in ordered]
