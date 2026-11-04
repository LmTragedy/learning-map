"""The AI task that prepares or updates one node's teaching plan.

The model is called outside any database transaction; the plan is written in one `store.edit` that
re-validates the frozen planning inputs, so a plan built from inputs that changed meanwhile is kept as
a raw reply and never applied.
"""

from ..ai_tasks import current_task_id
from ..conversation_labels import remember_conversation
from ..domain import find_node, project_course
from ..learning import BASE_SYSTEM, structured
from ..review_scope import require_review_node, review_label, scope_key
from ..store import identity, timestamp
from .inputs import input_sha256, planning_inputs
from .neighbours import coordination_neighbours
from .prompt import build_prompt
from .schema import TeachingPlanDraft
from .scope import writable_book
from .validate import validate_draft

TASK_KIND = "teaching_plan"


def prepare_plan(store, learning, course_id, node_id, request_id=None):
    return learning.tasks.run(course_id, TASK_KIND, node_id, {},
                              lambda: _prepare(store, learning, course_id, node_id), request_id=request_id)


def _titled(entries, nodes):
    return [entry | dict(title=nodes[entry["node_id"]]["title"]) for entry in entries]


def _record(course, node, draft, dropped):
    nodes = {item["id"]: item for item in course["nodes"]}
    return dict(
        id=identity(),
        node_id=node["id"],
        created_at=timestamp(),
        task_id=current_task_id(),
        scope_key=scope_key(course),
        input_sha256=input_sha256(course, node),
        goal=draft["goal"].strip(),
        owns=draft["owns"],
        borrows=_titled(draft["borrows"], nodes),
        defers=_titled(draft["defers"], nodes),
        distinctions=_titled(draft["distinctions"], nodes),
        sources=draft["sources"],
        conflicts=draft["conflicts"],
        uncertain=draft["uncertain"],
        uncertain_reasons=draft["uncertain_reasons"],
        candidate=draft["candidate"],
        note=draft["note"].strip(),
        dropped_refs=dropped,
        moved_refs=draft["moved_refs"],
    )


def _prepare(store, learning, course_id, node_id):
    course = learning.tasks.input_course(course_id)
    node = find_node(course, node_id)
    require_review_node(course, node)
    label = review_label(course, node, "教学分工")
    reply = structured(learning.ai(), build_prompt(planning_inputs(course, node)), TeachingPlanDraft,
                       {"conversation": label}, system=BASE_SYSTEM)
    draft, dropped = validate_draft(course, node, reply.payload, coordination_neighbours(course, node))
    plan = _record(course, node, draft, dropped)
    with store.edit(course_id, task_id=current_task_id()) as (current, connection):
        store.snapshot(current, "准备教学分工前自动备份", connection)
        book = writable_book(current)
        plan["version"] = (book.get(node_id) or {}).get("version", 0) + 1
        book[node_id] = plan
        remember_conversation(current, reply.thread_id, label, node_id)
    return project_course(store.course(course_id))


def delete_plan(store, course_id, node_id, revision):
    with store.edit(course_id, expected=revision) as (course, connection):
        find_node(course, node_id)
        book = writable_book(course)
        if node_id in book:
            store.snapshot(course, "删除教学分工前自动备份", connection)
            del book[node_id]
    return project_course(store.course(course_id))
