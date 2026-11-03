import { Button } from "./components/ui/button";
import type { Course, LearningNode } from "./types";
import { isRelationVisible } from "./relationVisibility";
import { isNodeVisible } from "./nodeVisibility";

export function RelationsSection({ course, node, reviewActive, reviewStrict, directEntryId, directWeek, onNavigateNode, onOpenReview, onExitReview }: {
  course: Course;
  node: LearningNode;
  reviewActive: boolean;
  reviewStrict: boolean;
  directEntryId?: string;
  directWeek?: string;
  onNavigateNode: (node: LearningNode, edge?: Course["edges"][number]) => void;
  onOpenReview: () => void;
  onExitReview: () => void;
}) {
  const relatedEdges = course.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const visibleRelations = relatedEdges.filter((edge) => {
    const other = course.nodes.find((entry) => entry.id === (edge.source === node.id ? edge.target : edge.source));
    return Boolean(other && isRelationVisible(course, edge, reviewStrict)
      && (reviewStrict ? course.review_scope?.node_ids.includes(other.id)
        : isNodeVisible(other, { reviewActive, directEntryId, directWeek })));
  });
  const hiddenRelationCount = relatedEdges.length - visibleRelations.length;
  return <details className="rounded-lg border border-border px-3 py-2 text-xs">
    <summary className="cursor-pointer font-medium">相关关系 · {visibleRelations.length}{hiddenRelationCount ? `（另有 ${hiddenRelationCount} 个未解锁或不在范围内）` : ""}</summary>
    <div className="mt-2 flex flex-col gap-1.5">
      {visibleRelations.map((edge) => {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const other = course.nodes.find((entry) => entry.id === otherId);
        if (!other) return null;
        const canonical = edge.origin_relation_id ? course.edges.find((candidate) => candidate.id === edge.origin_relation_id) || edge : edge;
        const target = course.nodes.find((entry) => entry.id === canonical.target);
        const controlsUnlock = canonical.controls_unlock ?? Boolean(target?.prerequisites.includes(canonical.source));
        return <div key={edge.id} className="flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate"><strong>{canonical.relation}</strong> · {other.title}<small className="ml-1 text-muted-foreground">{controlsUnlock ? "真实先修" : "不影响解锁"}</small></span>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onNavigateNode(other, edge)}>查看联系</Button>
        </div>;
      })}
      {hiddenRelationCount > 0 && <div className="flex flex-wrap items-center gap-1 text-muted-foreground"><span>满足先修或调整复习范围后可查看隐藏联系。</span>{reviewStrict && <><Button size="sm" variant="ghost" onClick={onOpenReview}>调整范围</Button><Button size="sm" variant="ghost" onClick={onExitReview}>退出复习</Button></>}</div>}
      {!relatedEdges.length && <p className="text-muted-foreground">暂无已记录关系。</p>}
    </div>
  </details>;
}
