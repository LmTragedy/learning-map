import type { Course } from "./types";

export function isRelationVisible(course: Course, edge: Course["edges"][number], strict: boolean) {
  if (!strict) return true;
  const materialIds = new Set(course.review_scope?.material_ids || []);
  const parent = edge.synthesis_link && edge.origin_relation_id
    ? course.edges.find((candidate) => candidate.id === edge.origin_relation_id)
    : edge;
  if (!parent || (parent.evidence_kind !== "material_quote" && parent.evidence_kind !== "material_inference")) return false;
  if (!parent.sources?.length || parent.sources.some((source) => !materialIds.has(source.material_id))) return false;
  const endpointIds = [edge.source, edge.target, parent.source, parent.target, ...(parent.related_node_ids || [])];
  return endpointIds.every((id) => course.nodes.some((node) =>
    node.id === id && node.sources.some((source) => materialIds.has(source.material_id)),
  ));
}

/** Relationships saved before explanations were recorded still carry this server placeholder. */
export const LEGACY_EXPLANATION = "旧版关系未记录解释。";

export function needsExplanation(edge: Course["edges"][number]) {
  return !edge.synthesis_link && (edge.explanation ?? LEGACY_EXPLANATION) === LEGACY_EXPLANATION;
}
