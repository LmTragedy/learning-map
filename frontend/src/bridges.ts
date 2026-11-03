import type { Bridge, Course, LearningNode, Piece, Step, Strength } from "./types";

type Edge = Course["edges"][number];

export const STRENGTH_LABEL: Record<Strength, string> = { required: "必需", suggested: "建议", extension: "拓展" };
const STRENGTH_ORDER: Record<Strength, number> = { required: 0, suggested: 1, extension: 2 };

/** One bridge with its endpoints resolved, ready to read as "B's step n uses A's piece". */
export type ResolvedBridge = {
  edge: Edge;
  bridge: Bridge;
  source: LearningNode;
  target: LearningNode;
  piece?: Piece;
  step?: Step;
  stepNumber?: number;
};

export function resolveBridges(course: Course, edges: Edge[]): ResolvedBridge[] {
  const byId = new Map(course.nodes.map((node) => [node.id, node]));
  const resolved: ResolvedBridge[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || edge.synthesis_link) continue;
    for (const bridge of edge.bridges || []) {
      const piece = source.pieces?.find((entry) => entry.id === bridge.from_piece);
      const index = target.steps?.findIndex((entry) => entry.id === bridge.to_step) ?? -1;
      resolved.push({ edge, bridge, source, target, piece, step: index >= 0 ? target.steps![index] : undefined, stepNumber: index >= 0 ? index + 1 : undefined });
    }
  }
  return resolved.sort((a, b) => STRENGTH_ORDER[a.bridge.strength] - STRENGTH_ORDER[b.bridge.strength]);
}

/** Bridges into a node (what it uses) and out of it (where it is used), plus things easy to confuse it with. */
export function nodeBridges(course: Course, node: LearningNode) {
  const edges = course.edges.filter((edge) => !edge.synthesis_link);
  return {
    incoming: resolveBridges(course, edges.filter((edge) => edge.target === node.id)),
    outgoing: resolveBridges(course, edges.filter((edge) => edge.source === node.id)),
    contrasts: edges.filter((edge) => edge.kind === "对比" && (edge.source === node.id || edge.target === node.id)),
  };
}

export function pieceLabel(item: Pick<ResolvedBridge, "piece" | "bridge">) {
  if (item.piece) return `${item.piece.kind}：${item.piece.title}`;
  return item.bridge.legacy ? "整个知识点（还没拆到具体一块）" : "未指定的一块";
}

export function stepLabel(item: Pick<ResolvedBridge, "step" | "stepNumber">) {
  return item.step ? `第 ${item.stepNumber} 步 · ${item.step.title}` : "";
}

/** Short text for an edge label on the graph: "类型 · 用到的块". */
export function edgeLabel(course: Course, edge: Edge) {
  const kind = edge.kind || "用到";
  const [first] = resolveBridges(course, [edge]);
  const piece = first?.piece?.title;
  return piece ? `${kind} · ${piece}` : kind;
}

/** Relationships whose only bridge is the migrated placeholder; the AI can fill these in. */
export function needsBridges(edge: Edge) {
  return !edge.synthesis_link && edge.kind !== "对比" && (edge.bridges || []).length === 1 && Boolean(edge.bridges![0].legacy);
}

/** Bridges a failed practice or a "不确定" self-check flagged; they are what the learner should go back to. */
export function isWeak(bridge: Bridge) {
  return bridge.state?.result === "missing" || bridge.state?.result === "unsure";
}

/** A link worth drawing as structure: written out (not the migrated placeholder) and not a "read after" extension. */
export function isStrong(item: ResolvedBridge) {
  return !item.bridge.legacy && item.bridge.strength !== "extension";
}

/**
 * Follow required links away from `start`, one node at a time, up to `depth` nodes: how far back a
 * node's foundations go (`before`) or how far ahead it is still used (`after`). Nodes in `seen` are
 * skipped so a chain never loops or repeats what is already on screen.
 */
export function chain(course: Course, start: LearningNode, direction: "before" | "after", depth: number, seen: Set<string>) {
  const edges = course.edges.filter((edge) => !edge.synthesis_link && edge.kind !== "对比");
  const found: ResolvedBridge[] = [];
  const visited = new Set(seen);
  let current = start;
  while (found.length < depth) {
    const candidates = resolveBridges(course, edges.filter((edge) => (direction === "after" ? edge.source : edge.target) === current.id));
    const next = candidates.find((item) => isStrong(item) && item.bridge.strength === "required"
      && !visited.has((direction === "after" ? item.target : item.source).id));
    if (!next) break;
    current = direction === "after" ? next.target : next.source;
    visited.add(current.id);
    found.push(next);
  }
  return found;
}
