"""Compatibility projection and helpers for course-owned learning relationships."""

from .bridges import bridge_context, bridges_of, learner_kind, real_text
from .review_scope import active_sources, strict_scope
from .store import identity


def project_edges(course):
    """Give old persisted edges safe defaults without rewriting the stored aggregate."""
    nodes = {node["id"]: node for node in course.get("nodes", [])}
    edges = course.get("edges", [])
    by_id = {edge.get("id"): edge for edge in edges}
    defaults = {
        "explanation": "旧版关系未记录解释。", "when_to_use": "旧版关系未记录适用时机。",
        "basis": "旧版关系未记录依据。", "evidence_kind": "ai_inference", "sources": [],
        "forward_difficulty": "初始估计 · 未验证", "reverse_difficulty": "初始估计 · 未验证",
        "presentation": "simple", "synthesis_node_id": None, "confirmed": False, "uncertain": True,
    }
    for edge in edges:
        if edge.get("synthesis_link"):
            continue
        for key, default in defaults.items():
            edge.setdefault(key, default)
        target = nodes.get(edge.get("target"), {})
        edge.setdefault("controls_unlock", edge.get("source") in target.get("prerequisites", []))
    for edge in edges:
        if not edge.get("synthesis_link"):
            continue
        parent = by_id.get(edge.get("origin_relation_id"), {})
        for key, default in defaults.items():
            edge[key] = parent.get(key, default)
        edge["controls_unlock"] = False
    return course


def relations_for_node(course, node):
    """Return only relationships that are safe to use in the current source scope."""
    nodes = {item["id"]: item for item in course["nodes"]}
    strict = strict_scope(course)
    visible = []
    for edge in course.get("edges", []):
        if strict and not relationship_in_scope(course, edge):
            continue
        if edge.get("synthesis_link"):
            parent = next(
                (item for item in course.get("edges", []) if item.get("id") == edge.get("origin_relation_id")),
                None,
            )
            if parent is not None:
                edge = {**parent, **edge, "id": parent["id"]}
        if node["id"] not in {edge.get("source"), edge.get("target")}:
            continue
        # Placeholders from older relationships are not explanations and must not reach the AI.
        texts = {field: real_text(edge.get(field)) for field in ("explanation", "when_to_use", "basis")}
        bridges = bridge_context(course, edge)
        if not texts["explanation"] and not bridges:
            continue
        other_id = edge["target"] if edge["source"] == node["id"] else edge["source"]
        other = nodes.get(other_id)
        if other is None:
            continue
        fields = (
            "id", "relation", "evidence_kind", "sources",
            "uncertain", "confirmed", "presentation", "synthesis_node_id", "controls_unlock",
        )
        entry = {key: edge.get(key) for key in fields}
        entry.update(texts, kind=learner_kind(edge), bridges=bridges)
        entry.update(
            other_node={"id": other["id"], "title": other["title"], "status": other["status"]},
            direction="forward" if edge["source"] == node["id"] else "reverse",
            difficulty=edge.get("forward_difficulty") if edge["source"] == node["id"] else edge.get("reverse_difficulty"),
            other_difficulty=edge.get("reverse_difficulty") if edge["source"] == node["id"] else edge.get("forward_difficulty"),
            sources=edge.get("sources", []),
        )
        target = nodes.get(edge.get("target"), {})
        entry["controls_unlock"] = edge.get(
            "controls_unlock", edge.get("source") in target.get("prerequisites", [])
        )
        visible.append(entry)
    return visible


def incoming_bridges(course, node):
    """Bridges into a node that a failed practice may point back to, under the same scope rules."""
    nodes = {item["id"]: item for item in course["nodes"]}
    strict = strict_scope(course)
    found = []
    for edge in course.get("edges", []):
        if edge.get("synthesis_link") or edge.get("target") != node["id"]:
            continue
        source = nodes.get(edge.get("source"))
        if source is None or (strict and not relationship_in_scope(course, edge)):
            continue
        pieces = {piece["id"]: piece for piece in source.get("pieces", [])}
        for bridge in bridges_of(edge):
            piece = pieces.get(bridge.get("from_piece"))
            found.append(dict(
                id=bridge["id"], relation_id=edge["id"], from_node=source["title"],
                uses=f"{piece['kind']}：{piece['title']}" if piece else "整个知识点",
                how=bridge.get("how", ""), strength=bridge["strength"],
            ))
    return found


def relationship_in_scope(course, edge):
    """Require every endpoint and cited source in a relation to belong to strict PDF review."""
    if not strict_scope(course):
        return True
    selected = set(course.get("review_scope", {}).get("material_ids", []))
    nodes = {node["id"]: node for node in course["nodes"]}
    parent = edge
    if edge.get("synthesis_link"):
        parent = next(
            (candidate for candidate in course.get("edges", [])
             if candidate.get("id") == edge.get("origin_relation_id")),
            None,
        )
        if parent is None:
            return False
    endpoint_ids = [edge.get("source"), edge.get("target"), parent.get("source"), parent.get("target")]
    endpoint_ids.extend(parent.get("related_node_ids", []))
    if any(endpoint_id not in nodes or not active_sources(course, nodes[endpoint_id]) for endpoint_id in endpoint_ids):
        return False
    if parent.get("evidence_kind", "ai_inference") == "ai_inference":
        return False
    sources = parent.get("sources", [])
    bridge_sources = [source for bridge in parent.get("bridges", []) for source in bridge.get("sources", [])]
    source_pieces = {piece["id"]: piece for piece in nodes[parent["source"]].get("pieces", [])}
    piece_sources = [
        source for bridge in parent.get("bridges", [])
        for source in source_pieces.get(bridge.get("from_piece"), {}).get("sources", [])
    ]
    return bool(sources) and all(source.get("material_id") in selected for source in [*sources, *bridge_sources, *piece_sources])


def relation_fingerprint(course, node):
    """Capture relationships and counterpart learning state used by a node AI request."""
    return dict(relations=relations_for_node(course, node), synthesis=synthesis_context(course, node))


def create_synthesis_node(course, edge):
    """Create or reuse an ordinary learning node that integrates both relation endpoints."""
    existing_id = edge.get("synthesis_node_id")
    for node in course["nodes"]:
        if node.get("relation_id") == edge["id"] or node["id"] == existing_id:
            return node
    related_ids, related_nodes = _related_nodes(course, edge)
    node = _build_synthesis_node(edge, related_ids, related_nodes)
    course["nodes"].append(node)
    edge["synthesis_node_id"] = node["id"]
    _connect_synthesis_node(course, edge, node, related_nodes)
    return node


def _related_nodes(course, edge):
    nodes = {node["id"]: node for node in course["nodes"]}
    related_ids = list(dict.fromkeys([edge["source"], edge["target"], *edge.get("related_node_ids", [])]))
    related_nodes = [nodes[item] for item in related_ids if item in nodes]
    if len(related_nodes) != len(related_ids):
        raise ValueError("联系端点不存在，无法创建综合节点")
    return related_ids, related_nodes


def _synthesis_details(edge, related_nodes):
    title = edge.get("synthesis_title", "").strip()
    summary = edge.get("synthesis_summary", "").strip()
    if not title:
        title = ("与" + "、".join(item["title"] for item in related_nodes[:3]) + "的综合应用")[:160]
    if not summary:
        explanation = real_text(edge.get("explanation")) or "整合相关知识，说明它们如何一起使用。"
        when_to_use = real_text(edge.get("when_to_use")) or "结合相关知识练习时"
        summary = f"{explanation}\n\n适用时机：{when_to_use}".strip()[:3000]
    sources = [source for item in related_nodes for source in item.get("sources", [])]
    sources.extend(edge.get("sources", []))
    unique_sources = {(item["material_id"], item["page"], item["quote"]): item for item in sources}
    return title, summary, list(unique_sources.values())


def _build_synthesis_node(edge, related_ids, related_nodes):
    from .domain import make_node

    title, summary, sources = _synthesis_details(edge, related_nodes)
    node = make_node(dict(
        title=title, summary=summary, week="", sources=sources,
        uncertain=bool(edge.get("uncertain", True)),
    ))
    node.update(kind="synthesis", related_node_ids=related_ids, relation_id=edge["id"])
    node["prerequisites"] = []
    return node


def _connect_synthesis_node(course, edge, node, related_nodes):
    for related in related_nodes:
        course.setdefault("edges", []).append(dict(
            id=identity(),
            source=related["id"],
            target=node["id"],
            relation="综合联系",
            origin_relation_id=edge["id"],
            synthesis_link=True,
            controls_unlock=False,
        ))


def synthesis_context(course, node):
    relation_id = node.get("relation_id")
    if node.get("kind") != "synthesis" or not relation_id:
        return None
    edge = next((item for item in course.get("edges", []) if item.get("id") == relation_id), None)
    if edge is None:
        return None
    nodes = {item["id"]: item for item in course["nodes"]}
    related = [nodes[item] for item in node.get("related_node_ids", []) if item in nodes]
    if strict_scope(course):
        if len(related) < 2 or len(related) != len(node.get("related_node_ids", [])) or any(
            not active_sources(course, item) for item in related
        ):
            return None
        if not relationship_in_scope(course, edge):
            return None
    return {
        "relation": {key: real_text(edge.get(key)) if key in {"explanation", "when_to_use", "basis"} else edge.get(key) for key in (
            "id", "relation", "explanation", "when_to_use", "basis", "evidence_kind", "sources",
            "uncertain", "confirmed", "forward_difficulty", "reverse_difficulty", "controls_unlock",
        )},
        "related_nodes": [
            {
                key: item.get(key)
                for key in (("id", "title", "status", "verification") if strict_scope(course)
                            else ("id", "title", "summary", "status", "verification"))
            }
            for item in related
        ],
    }
