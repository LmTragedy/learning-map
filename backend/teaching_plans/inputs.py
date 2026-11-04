"""What a planning turn reads, and the narrower part whose change makes a saved plan stale.

Staleness is local: only the node itself (title, goal, pieces, steps, sources) and the structure of
its related nodes count. Notes, reading marks, chats and other plans never make a plan stale, so one
edit does not force the whole course to be planned again.
"""

import hashlib
import json

from ..review_scope import active_records, active_sources, scope_key
from .neighbours import coordination_neighbours
from .scope import node_goal, plan_for, scoped_pieces, scoped_step_titles

MAX_PROMPT_CHARS = 120000


def _materials(course):
    return {material["id"]: material for material in course["materials"]}


def _source_pages(course, sources):
    """Cited page text, in the shape learning.node_context uses (kept here: domain imports this module)."""
    materials = _materials(course)
    pages = []
    for source in sources:
        material = materials[source["material_id"]]
        page = material["pages"][source["page"] - 1]
        pages.append(dict(name=material["name"], **source, extracted_text=page["text"], uncertain=page["uncertain"]))
    return pages


def _page_names(course, pages):
    materials = _materials(course)
    return [dict(material=materials[material_id]["name"], page=page) for material_id, page in pages]


def target_inputs(course, node):
    return dict(
        id=node["id"],
        title=node["title"],
        goal=node_goal(course, node),
        pieces=[{key: piece[key] for key in ("kind", "title", "detail") if key in piece}
                for piece in scoped_pieces(course, node)],
        steps=scoped_step_titles(course, node),
        sources=_source_pages(course, active_sources(course, node)),
    )


def neighbour_brief(course, entry):
    other = entry["node"]
    return dict(
        id=other["id"],
        title=other["title"],
        reasons=entry["reasons"],
        shared_pages=_page_names(course, entry["shared_pages"]),
        pieces=[f"{piece['kind']}：{piece['title']}" for piece in scoped_pieces(course, other)],
        steps=scoped_step_titles(course, other),
    )


def plan_summary(plan):
    """A saved plan, short enough to show next to other nodes."""
    if not plan:
        return None
    return dict(
        version=plan["version"],
        goal=plan["goal"],
        owns=[point["point"] for point in plan.get("owns", [])],
        defers=[{key: entry[key] for key in ("node_id", "what")} for entry in plan.get("defers", [])],
    )


def staleness_inputs(course, node):
    return dict(
        scope=scope_key(course),
        target=target_inputs(course, node),
        neighbours=[neighbour_brief(course, entry)
                    for entry in coordination_neighbours(course, node, structural_only=True)],
    )


def input_sha256(course, node):
    encoded = json.dumps(staleness_inputs(course, node), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def plan_status(course, node, plan):
    return "current" if plan.get("input_sha256") == input_sha256(course, node) else "stale"


def guiding_plan(course, node):
    """The plan that may steer teaching: saved in this scope and not stale. The one rule for all readers."""
    plan = plan_for(course, node["id"])
    return plan if plan and plan_status(course, node, plan) == "current" else None


def has_stale_plan(course, node):
    return plan_for(course, node["id"]) is not None and guiding_plan(course, node) is None


def planning_inputs(course, node):
    """Everything the planning prompt is built from; a change here while the AI works voids the reply."""
    neighbours = coordination_neighbours(course, node)
    lessons = active_records(course, node.get("lessons", []))
    return dict(
        scope=scope_key(course),
        target=target_inputs(course, node),
        neighbours=[neighbour_brief(course, entry) | dict(plan=plan_summary(guiding_plan(course, entry["node"])),
                                                          plan_stale=has_stale_plan(course, entry["node"]))
                    for entry in neighbours],
        # The node's own earlier plan is shown even when stale: it is what this turn updates.
        current_plan=plan_summary(plan_for(course, node["id"])),
        # History only: what older lessons covered is never a reason to keep it here.
        lesson_history=[{key: lesson[key] for key in ("title", "recap")} for lesson in lessons],
    )


def require_size(text):
    if len(text) > MAX_PROMPT_CHARS:
        from ..learning import LearningError

        raise LearningError("教学分工的输入过长，未生成。请先缩小节点来源或拆分节点。")
    return text
