"""Question-bound practice chains and evidence-backed progress projections."""

import hashlib
import json

from .review_scope import active_records, question_for, scope_key


def question_key(question):
    encoded = json.dumps(question, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def validate_parent(course, node, parent_id, key):
    current_question = question_for(course, node)
    if key and (not current_question or key != question_key(current_question)):
        raise ValueError("题目已变化，请刷新后重新作答")
    if not parent_id:
        return
    if not key:
        raise ValueError("补答必须同时提供当前题目标识")
    attempts = active_records(course, node["attempts"])
    parent = next((attempt for attempt in attempts if attempt["id"] == parent_id), None)
    parent_key = parent.get("question_key") or question_key(parent.get("question", {})) if parent else None
    if (parent is None or parent_key != key
            or parent.get("review_scope_key", "course") != scope_key(course)):
        raise ValueError("补答记录不属于当前节点、资料范围或题目")


def _attempt_key(attempt):
    return attempt.get("question_key") or (
        question_key(attempt["question"]) if attempt.get("question") else None
    )


def _has_user_quote(attempt, quote):
    if not quote.strip():
        return False
    if quote in attempt.get("answer", ""):
        return True
    return any(
        quote in page.get("text", "")
        for attachment in attempt.get("attachments", [])
        for page in attachment.get("pages", [])
    )


def _in_current_scope(course, attempt):
    return attempt.get("review_scope_key", "course") == scope_key(course)


def practice_resolutions(course, node):
    progress = project_practice_progress(course, node)
    if not progress:
        return []
    wanted = set(progress["attempt_ids"])
    return [
        {"attempt_id": attempt["id"], "resolution": attempt.get("resolution")}
        for attempt in node["attempts"]
        if attempt["id"] in wanted and _in_current_scope(course, attempt)
    ]


def confirmed_points(attempts):
    by_id = {attempt["id"]: attempt for attempt in attempts}
    points = {}
    for attempt in attempts:
        judgment = attempt.get("judgment", {})
        for point in judgment.get("confirmed_points", []):
            evidence_id = point.get("attempt_id") or attempt["id"]
            source = by_id.get(evidence_id)
            quote = point.get("quote", "")
            if source and _has_user_quote(source, quote):
                points[point["id"]] = dict(
                    id=point["id"], point=point["point"], attempt_id=evidence_id, quote=quote
                )
        for item in judgment.get("disputed_points", []):
            source = by_id.get(item.get("attempt_id"))
            if item.get("id") in points and source and _has_user_quote(source, item.get("quote", "")):
                points.pop(item["id"])
    return list(points.values())


def _attempt_chain(attempts, head):
    by_id = {attempt["id"]: attempt for attempt in attempts}
    chain, visited = [], set()
    cursor = head
    while cursor and cursor["id"] not in visited:
        visited.add(cursor["id"])
        chain.append(cursor)
        cursor = by_id.get(cursor.get("parent_attempt_id"))
    return list(reversed(chain))


def _markdown_points(points):
    lines = ["## 已确认要点"]
    lines.extend(
        f"- {point['point']}（来源作答：`{point['attempt_id']}`；原话：{point['quote']}）"
        for point in points
    )
    if not points:
        lines.append("- 暂无经原话核验的要点")
    return lines


def _markdown_attempts(chain):
    lines = ["## 原答与补充"]
    for attempt in chain:
        lines.extend([f"### 作答 `{attempt['id']}`", "", attempt.get("answer", "（无文字作答）")])
        for attachment in attempt.get("attachments", []):
            for page in attachment.get("pages", []):
                confidence = "需核对" if page.get("uncertain", False) else "提取文字"
                lines.extend([
                    "", f"附件 `{attachment.get('name', attachment.get('id', '未命名'))}` 第 {page.get('number', '?')} 页（{confidence}）：",
                    page.get("text", ""),
                ])
        lines.append("")
    return lines


def _markdown_review(latest):
    judgment = latest.get("judgment", {})
    return [
        "## 最新 AI 判断", "", f"- 结果：{judgment.get('outcome', '未知')}",
        "", judgment.get("reasoning", "（无判断说明）"), "", "## 用户处理", "",
        latest.get("resolution") or "尚未处理",
    ]


def _progress_markdown(question, key, course, points, chain, blockers):
    lines = [
        f"# 练习进度：{question['prompt']}", "", f"- 题目标识：`{key}`",
        f"- 资料范围：`{scope_key(course)}`", "",
    ]
    lines.extend(_markdown_points(points))
    lines.extend(["", *_markdown_attempts(chain), "", *_markdown_review(chain[-1]), "", "## 待解决卡点"])
    lines.extend(f"- {blocker}" for blocker in blockers)
    if not blockers:
        lines.append("- 暂无")
    return "\n".join(lines) + "\n"


def validate_judgment_evidence(judgment, parent_chain, submission):
    current_id = submission["id"]
    sources = {attempt["id"]: attempt for attempt in parent_chain}
    sources[current_id] = submission
    existing = {
        point["id"]: point for point in confirmed_points(parent_chain)
    }
    confirmed, invalid_confirmed = _validate_confirmed_points(
        judgment.get("confirmed_points", []), sources, current_id, existing
    )
    disputed, invalid_disputed = _validate_disputed_points(
        judgment.get("disputed_points", []), sources, existing, current_id
    )
    validated = judgment | {"confirmed_points": confirmed, "disputed_points": disputed}
    if invalid_confirmed or invalid_disputed:
        validated["outcome"] = "uncertain"
        validated["blockers"] = list(dict.fromkeys(
            [*validated.get("blockers", []), "AI 提供的确认/撤回依据无法核验，需人工复核"]
        ))
        validated["reasoning"] += "\n新增要点或撤回依据未能在本题链用户原答/附件中核验，因此本次不能作为通过验收。"
    return validated


def _validate_confirmed_points(candidates, sources, current_id, existing):
    confirmed, invalid = [], False
    for point in candidates:
        source_id = point.get("attempt_id") or current_id
        source = sources.get(source_id)
        if not source or not _has_user_quote(source, point.get("quote", "")):
            invalid = True
            continue
        previous = existing.get(point["id"])
        confirmed.append(previous or (point | {"attempt_id": source_id}))
    return confirmed, invalid


def _validate_disputed_points(candidates, sources, existing, current_id):
    disputed, invalid = [], False
    for item in candidates:
        source = sources.get(current_id) if item.get("attempt_id") == current_id else None
        if (item.get("id") not in existing or not source
                or not _has_user_quote(source, item.get("quote", ""))):
            invalid = True
            continue
        disputed.append(item)
    return disputed, invalid


def project_practice_progress(course, node):
    question = question_for(course, node)
    if not question:
        return None
    key = question_key(question)
    attempts = [
        attempt for attempt in active_records(course, node["attempts"])
        if _in_current_scope(course, attempt) and _attempt_key(attempt) == key
    ]
    if not attempts:
        return None
    chain = _attempt_chain(attempts, attempts[-1])
    points = confirmed_points(chain)
    latest = chain[-1]
    blockers = latest.get("judgment", {}).get("blockers", [])
    if latest.get("resolution") in {"pass", "review"}:
        blockers = []
    markdown = _progress_markdown(question, key, course, points, chain, blockers)
    return dict(
        question_key=key,
        attempt_ids=[attempt["id"] for attempt in chain],
        confirmed_points=points,
        blockers=blockers,
        markdown=markdown,
    )


def practice_evidence(course, node, parent_attempt_id):
    scoped = [attempt for attempt in active_records(course, node["attempts"])
              if _in_current_scope(course, attempt)]
    parent = next((attempt for attempt in scoped if attempt["id"] == parent_attempt_id), None)
    if parent is None:
        return []
    key = _attempt_key(parent)
    attempts = {attempt["id"]: attempt for attempt in scoped if _attempt_key(attempt) == key}
    chain = _attempt_chain(list(attempts.values()), parent)
    return [
        {key: attempt[key] for key in (
            "id", "parent_attempt_id", "answer", "reference", "attachments", "judgment", "resolution"
        ) if key in attempt}
        for attempt in chain
    ]
