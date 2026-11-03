"""Non-destructive PDF review selection and scoped learning context policies."""

import hashlib
import json

from .conversation_labels import conversation_label


def strict_scope(course):
    scope = course.get("review_scope", {})
    return bool(scope.get("enabled") and scope.get("ai_scope") == "selected")


def scope_key(course):
    if not strict_scope(course):
        return "course"
    selected = set(course["review_scope"]["material_ids"])
    fingerprints = sorted(
        (m["id"], m["sha256"]) for m in course["materials"] if m["id"] in selected
    )
    return "pdf:" + hashlib.sha256(json.dumps(fingerprints).encode()).hexdigest()


def active_sources(course, node):
    if not strict_scope(course):
        return node["sources"]
    selected = set(course["review_scope"]["material_ids"])
    return [source for source in node["sources"] if source["material_id"] in selected]


def active_records(course, records):
    if not strict_scope(course):
        return records
    key = scope_key(course)
    return [record for record in records if record.get("review_scope_key") == key]


def require_review_node(course, node):
    if strict_scope(course) and not active_sources(course, node):
        raise ValueError("此节点没有所选 PDF 的来源，请更换复习资料或退出复习。")


def require_review_record(course, record):
    if strict_scope(course) and record.get("review_scope_key") != scope_key(course):
        raise ValueError("这条记录属于其他资料范围，请退出复习或切回原资料组合后操作。")


def question_for(course, node):
    if strict_scope(course):
        return node.get("review_questions", {}).get(scope_key(course))
    return node.get("question")


def thread_for(course, node):
    if strict_scope(course):
        return node.get("review_threads", {}).get(scope_key(course))
    return node.get("thread_id")


def review_label(course, node=None, purpose=None):
    if strict_scope(course):
        names = ", ".join(
            m["name"] for m in course["materials"] if m["id"] in course["review_scope"]["material_ids"]
        )
        # Keep titles within the adapter limit, with a stable discriminator for long selections.
        suffix = f"PDF复习 {names[:100]} [{scope_key(course)[4:12]}]"
        purpose = f"{suffix}｜{purpose}" if purpose else suffix
    return conversation_label(course, node, purpose)


def set_review_scope(course, selection):
    ids = selection["material_ids"]
    pdf_ids = {m["id"] for m in course["materials"] if m["kind"] == "pdf"}
    if len(ids) != len(set(ids)) or not set(ids).issubset(pdf_ids):
        raise ValueError("请只选择当前课程中已导入的 PDF，且不要重复选择。")
    if selection["enabled"] and not ids:
        raise ValueError("至少勾选一份 PDF 后才能开始复习。")
    course["review_scope"] = selection


def project_review(course):
    """Project active records only; never persist this view back to the aggregate."""
    scope = dict(enabled=False, material_ids=[], ai_scope="selected") | course.get("review_scope", {})
    selected = set(scope["material_ids"])
    scope["key"] = scope_key(course)
    scope["node_ids"] = [
        n["id"] for n in course["nodes"]
        if not scope["enabled"] or any(s["material_id"] in selected for s in n["sources"])
    ]
    if strict_scope(course):
        # Relationship explanations can carry context from more than one source.
        # Hide them unless both endpoints and every cited page belong to this exact PDF selection.
        from .relations import relationship_in_scope

        course["edges"] = [
            edge for edge in course.get("edges", [])
            if relationship_in_scope(course, edge)
        ]
        course["suggestions"] = active_records(course, course["suggestions"])
        for node in course["nodes"]:
            node["review_verification"] = node.get("review_progress", {}).get(scope_key(course), {}).get("verification", "none")
            node["material_variants"] = [
                variant for variant in node.get("material_variants", [])
                if variant.get("sources")
                and all(source.get("material_id") in selected for source in variant["sources"])
            ]
            node["review_archived"] = {}
            for field in ("chats", "attempts", "lessons"):
                records = node.get(field, [])
                active = active_records(course, records)
                node["review_archived"][field] = len(records) - len(active)
                node[field] = active
            question = question_for(course, node)
            node.pop("question", None)
            if question:
                node["question"] = question
            node["sources"] = active_sources(course, node)
            # Raw saved thread maps/questions are not part of the client projection.
    for node in course["nodes"]:
        node.pop("review_questions", None)
        node.pop("review_threads", None)
        node.pop("review_progress", None)
    course["review_scope"] = scope
    return course
