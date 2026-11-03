import { ArrowRight, CheckCircle2, CircleDashed, HelpCircle, Lock } from "lucide-react";
import { Button } from "./components/ui/button";
import { needsExplanation } from "./relationVisibility";
import type { Course, LearningNode } from "./types";

const done = (node: LearningNode) => node.status === "passed" || node.status === "mastered";

function stateLabel(node: LearningNode) {
  if (node.status === "passed") return "已验收";
  if (node.status === "mastered") return "自我掌握";
  if (node.status === "studied") return "学过";
  return "未学";
}

/**
 * What this node builds on and what it unlocks, each with the reason recorded on the relation,
 * so the prerequisite chain reads as "you need X for step Y" rather than a bare arrow.
 */
export function BridgeCard({ course, node, canOpen, onNavigate, onSelfCheck }: {
  course: Course; node: LearningNode;
  canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Course["edges"][number]) => void;
  onSelfCheck: (prerequisite: LearningNode) => void;
}) {
  const byId = new Map(course.nodes.map((entry) => [entry.id, entry]));
  const edgeBetween = (source: string, target: string) => course.edges.find((edge) => !edge.synthesis_link && edge.source === source && edge.target === target);
  const before = node.prerequisites.map((id) => byId.get(id)).filter((entry): entry is LearningNode => !!entry);
  const after = course.nodes.filter((entry) => entry.prerequisites.includes(node.id));
  if (!before.length && !after.length) return null;
  const missing = before.filter((entry) => !done(entry)).length;
  return <section className="rounded-xl border border-border bg-card p-3.5" aria-label="前后知识联系">
    {!!before.length && <>
      <h3 className="t-label">学这个之前需要 · {before.length - missing}/{before.length} 已掌握</h3>
      <div className="mt-2 flex flex-col gap-2">
        {before.map((pre) => {
          const edge = edgeBetween(pre.id, node.id);
          const reason = edge && !needsExplanation(edge) ? edge.explanation : "";
          const visible = canOpen(pre);
          return <div key={pre.id} className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-center gap-2">
              {done(pre) ? <CheckCircle2 size={15} className="shrink-0 text-st-passed" aria-hidden />
                : visible ? <CircleDashed size={15} className="shrink-0 text-st-new" aria-hidden /> : <Lock size={15} className="shrink-0 text-muted-foreground" aria-hidden />}
              <strong className="t-item min-w-0 flex-1 truncate">{visible ? pre.title : "未解锁的先修知识点"}</strong>
              <span className="t-meta shrink-0">{stateLabel(pre)}</span>
            </div>
            {reason
              ? <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{reason}</p>
              : <p className="t-meta mt-1">还没有记录为什么需要它。可在页面顶部「用 AI 补充说明」，或在关系详情里手动填写。</p>}
            {visible && <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onSelfCheck(pre)}><HelpCircle /> 10 秒自测</Button>
              <Button size="sm" variant="ghost" onClick={() => onNavigate(pre, edge)}>去复习它 <ArrowRight /></Button>
            </div>}
          </div>;
        })}
      </div>
    </>}
    {!!after.length && <>
      <h3 className={`t-label ${before.length ? "mt-3" : ""}`}>学完它会用在</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {after.map((next) => {
          const edge = edgeBetween(node.id, next.id);
          const open = canOpen(next);
          return <Button key={next.id} size="sm" variant="outline" disabled={!open}
            title={open && edge && !needsExplanation(edge) ? edge.explanation : undefined}
            onClick={() => onNavigate(next, edge)}>{open ? next.title : "后续知识点（解锁后显示）"} <ArrowRight /></Button>;
        })}
      </div>
    </>}
  </section>;
}
