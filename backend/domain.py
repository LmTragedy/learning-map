import hashlib
import json

from .bridges import project_bridges
from .goals import project_goals
from .handoff import project_handoffs
from .lesson_coverage import uncovered_pieces
from .lines import project_lines
from .page_index import index_progress
from .practice_progress import project_practice_progress
from .relations import project_edges
from .review_scope import project_review
from .route import learning_route
from .store import identity, timestamp
from .teaching_plans.projection import project_plans


def find_node(course, node_id):
    for node in course["nodes"]:
        if node["id"] == node_id:
            return node
    raise KeyError("知识节点不存在")


def find_attempt(node, attempt_id):
    for attempt in node["attempts"]:
        if attempt["id"] == attempt_id:
            return attempt
    raise KeyError("验收记录不存在")


def is_complete(node):
    return node["status"] in {"mastered", "passed"}


def project_course(course):
    project_goals(course)
    # The client lists problems and file names; extracted pages stay server-side.
    for problem_set in course.get("problem_sets", []):
        for source in problem_set.get("files", []):
            source.pop("pages", None)
        for problem in problem_set.get("problems", []):
            # One main node per problem; extra ids from older records read as related references.
            extra = problem.get("node_ids", [])[1:]
            if extra:
                problem["related_node_ids"] = [*extra, *problem.get("related_node_ids", [])]
                problem["node_ids"] = problem["node_ids"][:1]
    completed = {node["id"] for node in course["nodes"] if is_complete(node)}
    for node in course["nodes"]:
        node["unlocked"] = is_complete(node) or set(node["prerequisites"]).issubset(completed)
        node["lesson_gaps"] = uncovered_pieces(node)
        # Full HTML is retrieved separately so every chat does not retransmit every lesson.
        for lesson in node.get("lessons", []):
            lesson.pop("html", None)
        node["practice_progress"] = project_practice_progress(course, node)
    # Goals in progress steer "next step" along their whole route, not just their end stations.
    doing = [node_id for goal in course.get("goals", []) if goal.get("status") == "doing" for node_id in goal.get("route_ids", [])]
    course["route"] = learning_route(course["nodes"], doing)
    project_edges(course)
    project_bridges(course)
    # Plans are read in the raw scope before the review projection trims pieces and records.
    project_plans(course)
    project_review(course)
    course["material_index"] = index_progress(course)
    project_handoffs(course)
    return project_lines(course)


def mark_node(node, status):
    node["status"] = status
    node["user_mark"] = status
    if node["verification"] in {"ai_passed", "user_passed", "review"}:
        node["status"] = "passed"


def make_node(spec):
    return dict(
        id=identity(),
        title=spec["title"],
        summary=spec["summary"],
        week=spec.get("week", ""),
        sources=spec["sources"],
        prerequisites=[],
        status="new",
        user_mark="new",
        verification="none",
        uncertain=spec["uncertain"],
        difficulty="初始估计 · 中等",
        chats=[],
        attempts=[],
        thread_id=None,
    )


def append_chat(node, role, content):
    node["chats"].append(dict(id=identity(), role=role, content=content, created_at=timestamp()))


def record_attempt(node, submission):
    judgment = submission["judgment"]
    attempt = dict(id=identity(), created_at=timestamp(), rating_state="pending", **submission)
    node["attempts"].append(attempt)
    if judgment["outcome"] == "passed":
        progress = _assessment_progress(node, attempt)
        progress["status"], progress["verification"] = "passed", "ai_passed"
    return attempt


def _assessment_progress(node, attempt):
    key = attempt.get("review_scope_key", "course")
    if key.startswith("pdf:"):
        return node.setdefault("review_progress", {}).setdefault(key, {})
    return node


def resolve_attempt(node, attempt, decision):
    if attempt["judgment"]["outcome"] != "uncertain" or attempt.get("resolution"):
        raise ValueError("只有尚未处理的不确定判断需要用户决定")
    attempt["resolution"] = decision
    if decision in {"pass", "review"}:
        progress = _assessment_progress(node, attempt)
        progress["status"] = "passed"
        progress["verification"] = "review" if decision == "review" else "user_passed"


def record_rating(course, node, attempt, submission):
    if attempt["rating_state"] != "pending":
        raise ValueError("这次验收已经评分或跳过，不能重复计数")
    if submission["skip"]:
        attempt["rating_state"] = "skipped"
        return
    if submission["problem"] is None and submission["mastery"] is None:
        raise ValueError("至少填写一项评分，或选择跳过")
    attempt["rating_state"] = "submitted"
    course["ratings"].append(
        dict(
            id=identity(), node_id=node["id"], attempt_id=attempt["id"], created_at=timestamp(),
            review_scope_key=attempt.get("review_scope_key", "course"), **submission
        )
    )


def propose_streak(course, node):
    key = node["attempts"][-1].get("review_scope_key", "course") if node["attempts"] else "course"
    attempts = [a for a in node["attempts"] if a.get("review_scope_key", "course") == key][-2:]
    if len(attempts) < 2:
        return
    outcomes = [entry["judgment"]["outcome"] for entry in attempts]
    if outcomes[0] != outcomes[1] or outcomes[0] not in {"passed", "failed"}:
        return
    evidence = [entry["id"] for entry in attempts]
    if any(suggestion.get("evidence") == evidence for suggestion in course["suggestions"]):
        return
    pace = "增加迁移与变体练习" if outcomes[0] == "passed" else "拆成小步并增加具体例子"
    course["suggestions"].append(
        dict(
            id=identity(),
            node_id=node["id"],
            review_scope_key=key,
            evidence=evidence,
            reason=f"本节点同一资料范围最近两次{'通过' if outcomes[0] == 'passed' else '未通过'}；仅是调整线索，不能证明长期掌握。",
            advice=pace,
            accepted=False,
        )
    )


def _average(batch, key):
    filled = [entry[key] for entry in batch if entry[key] is not None]
    return round(sum(filled) / len(filled), 2) if filled else None


def learning_profile(courses, accepted):
    ratings = sorted(
        [
            rating | {"course_id": course["id"], "course_title": course["title"]}
            for course in courses
            for rating in course["ratings"]
        ],
        key=lambda entry: (entry["created_at"], entry["id"]),
    )
    stages = []
    for offset in range(0, len(ratings) - 9, 10):
        batch = ratings[offset : offset + 10]
        stage_id = hashlib.sha256(json.dumps([r["id"] for r in batch]).encode()).hexdigest()[:24]
        mastery = _average(batch, "mastery")
        advice = "拆成小步并增加具体例子" if mastery is not None and mastery < 2 else "增加迁移与变体练习"
        stages.append(
            dict(
                id=stage_id,
                count=10,
                problem_average=_average(batch, "problem"),
                mastery_average=mastery,
                advice=advice,
                accepted=stage_id in accepted,
                ratings=batch,
                basis="按实际评分生成的规则建议，尚未验证学习效果",
            )
        )
    return dict(
        courses=[dict(id=c["id"], title=c["title"], nodes=c["nodes"]) for c in courses],
        ratings_count=len(ratings),
        stages=stages,
        suggestions=[s | {"course_id": c["id"]} for c in courses for s in c["suggestions"]],
    )
