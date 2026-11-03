"""The lesson just before and just after a node, in the order the learner sees, and how they connect.

The order matches the side list: a node on a main line follows that line (the first one holding it);
without lines it follows the learning route's stages; with lines, nodes on none keep course order.
Transitions the links AI wrote are stored with the neighbour they were written for, so a change in
order hides them instead of showing a sentence about the wrong lesson.
"""

from .route import learning_route


def neighbours(course, node_id):
    known = {node["id"] for node in course["nodes"]}
    lines = course.get("lines", [])
    line_name = ""
    for line in lines:
        ids = [item for item in line["node_ids"] if item in known]
        if node_id in ids:
            order, line_name = ids, line["name"]
            break
    else:
        on_line = {item for line in lines for item in line["node_ids"]}
        if lines:
            order = [node["id"] for node in course["nodes"] if node["id"] not in on_line]
        else:
            nodes = [dict(node, prerequisites=node.get("prerequisites", []), status=node.get("status", "new"))
                     for node in course["nodes"]]
            order = [item for stage in learning_route(nodes)["stages"] for item in stage["node_ids"]]
    if node_id not in order:
        return dict(line_name=line_name, prev=None, next=None)
    index = order.index(node_id)
    return dict(line_name=line_name, prev=order[index - 1] if index else None,
                next=order[index + 1] if index + 1 < len(order) else None)


def _story(course, line_name, node_id):
    line = next((line for line in course.get("lines", []) if line["name"] == line_name), None)
    return next((entry["text"] for entry in (line or {}).get("story", []) if entry["node_id"] == node_id), "")


def handoff(course, node):
    """Neighbours plus the stored transition for each, when it was written for that same neighbour."""
    found = neighbours(course, node["id"])
    saved = node.get("transitions", {})
    for side in ("prev", "next"):
        entry = saved.get(side) or {}
        found[f"{side}_text"] = entry.get("text", "") if found[side] and entry.get("node_id") == found[side] else ""
    if found["prev"] and not found["prev_text"] and found["line_name"]:
        # The line's story already says what this station takes from the one before it.
        found["prev_text"] = _story(course, found["line_name"], node["id"])
    return found


def project_handoffs(course):
    for node in course["nodes"]:
        node["handoff"] = handoff(course, node)
