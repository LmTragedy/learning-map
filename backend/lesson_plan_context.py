"""Lesson context versions, and the teaching-plan part of a version 2 lesson context.

A lesson task records the context version it was started with in its inputs. Recovery and context
validation rebuild the context of that same version, so a task started before teaching plans existed
is neither rewritten nor voided because a plan was saved later.
"""

from .teaching_plans.projection import lesson_plan_context, plan_ref

VERSION_FIELD = "context_version"


def context_version(inputs):
    return (inputs or {}).get(VERSION_FIELD, 1)


def request_fields(inputs):
    """Task inputs without the version marker, as LessonRequest accepts them."""
    return {key: value for key, value in (inputs or {}).items() if key != VERSION_FIELD}


def plan_context(course, node, lessons):
    """The keys a version 2 lesson context adds."""
    return lesson_plan_context(course, node) | dict(learning_state=dict(
        lessons_taught=[lesson["title"] for lesson in lessons],
        marked_read=[lesson["title"] for lesson in lessons if lesson.get("read_at")],
        independent_evidence="见 assessment_evidence：只有用户独立作答并通过验收才说明已掌握。",
    ))


def without_reading_marks(context):
    """Reading a lesson while another is generated must not void it, so validation ignores read marks."""
    state = context.get("learning_state")
    if state is not None:
        state.pop("marked_read", None)
    return context


def lesson_plan_ref(course, node, version):
    return plan_ref(course, node) if version >= 2 else None
