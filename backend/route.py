"""Read-only navigation groups; never introduce new learning prerequisites."""

from collections import defaultdict, deque


def learning_route(nodes):
    by_id = {node["id"]: node for node in nodes}
    children = defaultdict(list)
    incoming, depth = {}, dict.fromkeys(by_id, 0)
    for node in nodes:
        parents = set(node["prerequisites"])
        incoming[node["id"]] = len(parents)
        for parent in parents:
            children[parent].append(node["id"])
    queue = deque(node["id"] for node in nodes if incoming[node["id"]] == 0)
    order = []
    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for child in children[node_id]:
            depth[child] = max(depth[child], depth[node_id] + 1)
            incoming[child] -= 1
            if incoming[child] == 0:
                queue.append(child)
    completed = {node["id"] for node in nodes if node["status"] in {"mastered", "passed"}}
    next_id = next(
        (nid for nid in order if nid not in completed and set(by_id[nid]["prerequisites"]) <= completed), None
    )
    groups = defaultdict(list)
    for node_id in order:
        groups[depth[node_id] // 2].append(node_id)
    stages = [
        dict(id=f"stage-{level}", title=f"阶段 {index + 1}", node_ids=ids)
        for index, (level, ids) in enumerate(sorted(groups.items()))
    ]
    ordered_ids = set(order)
    unresolved = [node["id"] for node in nodes if node["id"] not in ordered_ids]
    if unresolved:
        stages.append(dict(id="unresolved", title="先修关系待核对", node_ids=unresolved))
    return dict(
        stages=stages,
        next_node_id=next_id,
        completed_count=len(completed),
        total=len(nodes),
        warning="部分先修关系缺失或存在循环，请核对完整地图。" if unresolved else "",
    )
