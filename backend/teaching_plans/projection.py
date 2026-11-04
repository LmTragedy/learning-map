"""What lessons, the tutor chat and the client see of the plans.

Questions and assessments never read these views: a plan says what a node is meant to teach, not
what the learner has shown they can do.
"""

import json

from .inputs import guiding_plan, has_stale_plan, neighbour_brief, plan_status, plan_summary
from .neighbours import coordination_neighbours
from .scope import STORE_KEY, in_scope, plan_for

_PRIVATE = {"id", "task_id", "created_at", "input_sha256", "scope_key", "dropped_refs", "moved_refs", "node_id"}


def plan_view(course, node):
    """This node's plan in the current scope with its status, or None."""
    plan = plan_for(course, node["id"])
    if not plan or not in_scope(course, node):
        return None
    view = {key: value for key, value in plan.items() if key not in _PRIVATE}
    if "uncertain_reasons" in view:
        # Plans saved before reasons were de-duplicated may repeat one.
        view["uncertain_reasons"] = list(dict.fromkeys(view["uncertain_reasons"]))
    return view | dict(status=plan_status(course, node, plan))


def plan_ref(course, node):
    """What a lesson records about the plan it was generated with."""
    plan = plan_for(course, node["id"])
    if not plan:
        return None
    return dict(id=plan["id"], version=plan["version"], input_sha256=plan["input_sha256"],
                status=plan_status(course, node, plan))


def guiding_view(course, node):
    """This node's plan as teaching guidance: None when there is no plan or it is stale."""
    return plan_view(course, node) if guiding_plan(course, node) else None


def related_duties(course, node):
    """Related nodes, their current pieces, and their plan only while that plan is still current."""
    found = []
    for entry in coordination_neighbours(course, node):
        brief = neighbour_brief(course, entry)
        found.append(dict(title=brief["title"], reasons=brief["reasons"], shared_pages=brief["shared_pages"],
                          pieces=brief["pieces"], duty=plan_summary(guiding_plan(course, entry["node"])),
                          duty_stale=has_stale_plan(course, entry["node"])))
    return found


def lesson_plan_context(course, node):
    return dict(teaching_plan=guiding_view(course, node), teaching_plan_stale=has_stale_plan(course, node),
                related_duties=related_duties(course, node))


CHAT_GUIDANCE = (
    "本节教学分工（只用于组织讲解，不代表用户已掌握；用户跳读、说忘了或回答暴露卡点时，"
    "照样展开补讲前置或相关内容，不能以“由其他节点负责”为由拒绝解释）："
)


def chat_plan_payload(course, node):
    """What the tutor chat is told about the plan, or None when the node has no current plan."""
    view = guiding_view(course, node)
    if view is None:
        return None
    return dict(teaching_plan=view, related_duties=related_duties(course, node))


def chat_plan_text(course, node):
    """The plan as a prompt block for the tutor chat; empty when the node has no plan."""
    payload = chat_plan_payload(course, node)
    return "" if payload is None else "\n" + CHAT_GUIDANCE + json.dumps(payload, ensure_ascii=False)


def project_plans(course):
    """Attach each node's scoped plan to the client view and drop the raw store."""
    for node in course["nodes"]:
        node["teaching_plan"] = plan_view(course, node)
    course.pop(STORE_KEY, None)
