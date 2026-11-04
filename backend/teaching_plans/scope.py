"""Where plans are stored, and the view of a node inside the current review scope.

Plans are kept per review scope: a strict PDF review reads only the plans made from that exact
selection of materials, never the whole-course plans (which may rest on other materials).
"""

from ..review_scope import active_sources, scope_key, strict_scope

STORE_KEY = "teaching_plans"


def plan_book(course):
    """Plans of the current scope, by node id (read-only view)."""
    return course.get(STORE_KEY, {}).get(scope_key(course), {})


def writable_book(course):
    return course.setdefault(STORE_KEY, {}).setdefault(scope_key(course), {})


def plan_for(course, node_id):
    return plan_book(course).get(node_id)


def in_scope(course, node):
    return not strict_scope(course) or bool(active_sources(course, node))


def scoped_pieces(course, node):
    """The node's pieces whose every source belongs to the selected materials (all pieces otherwise)."""
    pieces = node.get("pieces", [])
    if not strict_scope(course):
        return pieces
    selected = set(course["review_scope"]["material_ids"])
    return [piece for piece in pieces if piece.get("sources")
            and all(source.get("material_id") in selected for source in piece["sources"])]


def scoped_step_titles(course, node):
    """Step titles that may be shown in the current scope.

    Steps carry no sources today, so in a strict review none can be confirmed to come from the
    selected materials and none are sent; a step that does name sources is kept when all are selected.
    """
    steps = node.get("steps", [])
    if strict_scope(course):
        selected = set(course["review_scope"]["material_ids"])
        steps = [step for step in steps if step.get("sources")
                 and all(source.get("material_id") in selected for source in step["sources"])]
    return [step["title"] for step in steps]


def node_goal(course, node):
    # A node summary may draw on materials outside a strict selection, so it is not shown there.
    if strict_scope(course):
        return "仅依据所选资料中的本节点内容；资料不足时明确说明。"
    return node.get("summary", "")


def page_keys(course, node):
    return {(source["material_id"], source["page"]) for source in active_sources(course, node)}
