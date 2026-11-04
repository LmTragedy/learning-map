import { useState } from "react";
import { ChevronDown, ClipboardList, Sparkles, Trash2 } from "lucide-react";
import { api } from "./api";
import { TaskCards } from "./aiTasks";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { conflictTitles, planState } from "./teachingPlan";
import type { Course, LearningNode } from "./types";

const TONE = { none: "text-muted-foreground", current: "text-muted-foreground", stale: "text-st-new", review: "text-st-new" };

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1">
    <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
    <ul className="flex flex-col gap-1 text-sm">{children}</ul>
  </div>;
}

/**
 * What this node is responsible for teaching: its goal, what it explains in full, what it borrows,
 * what it leaves to other nodes, and conflicts to check. Lessons and the tutor read the same plan.
 */
export function TeachingPlanPanel({ course, node, busy, aiEnabled, act }: {
  course: Course; node: LearningNode; busy: boolean; aiEnabled: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
}) {
  const plan = node.teaching_plan;
  const state = planState(plan);
  const titles = new Map(course.nodes.map((entry) => [entry.id, entry.title]));
  const prepare = () => act("teaching-plan", () => api.prepareTeachingPlan(course.id, node.id, crypto.randomUUID()));
  const remove = () => act("teaching-plan", () => api.deleteTeachingPlan(course.id, node.id, course.revision));
  // Reference for the tutor more than for the learner: one line until opened, per node.
  const [openFor, setOpenFor] = useState("");
  const open = openFor === node.id;
  const pages = plan ? [...new Set(plan.sources.map((source) => source.page))] : [];

  return <section className="flex flex-col gap-3" aria-label="教学分工">
    <div className="flex items-center gap-2">
      <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={open} onClick={() => setOpenFor(open ? "" : node.id)}>
        <ClipboardList size={14} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">教学分工 <span className={TONE[state.key]}>· {state.label}</span></span>
        <ChevronDown size={14} className={cn("shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && aiEnabled && <Button size="sm" variant="ghost" disabled={busy} onClick={prepare}>
        <Sparkles /> {plan ? "更新分工" : "准备分工"}
      </Button>}
      {open && plan && <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label="删除教学分工"><Trash2 /></Button>}
    </div>
    <TaskCards kind="teaching_plan" target={node.id} limit={1} />
    {open && state.hint && <p className="t-meta">{state.hint}</p>}
    {open && plan && <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <p className="text-sm"><strong>本节目标：</strong>{plan.goal}</p>
      <Block title="本节主讲">
        {plan.owns.map((point, index) => <li key={index}>
          {point.point}{point.piece && point.piece !== point.point && <span className="text-muted-foreground">（{point.piece}）</span>}
          {point.depth === "简述" && <span className="text-muted-foreground"> · 简述</span>}
        </li>)}
      </Block>
      {plan.borrows.length > 0 && <Block title="借用前置">
        {plan.borrows.map((entry, index) => <li key={index}>{entry.what}<span className="text-muted-foreground">（来自「{entry.title}」{entry.use && `，用来${entry.use}`}）</span></li>)}
      </Block>}
      {plan.defers.length > 0 && <Block title="留待展开">
        {plan.defers.map((entry, index) => <li key={index}>{entry.what}<span className="text-muted-foreground"> → 「{entry.title}」</span></li>)}
      </Block>}
      {plan.distinctions.length > 0 && <Block title="与其他节点的区别">
        {plan.distinctions.map((entry, index) => <li key={index}>
          {entry.shared}<span className="text-muted-foreground">（与「{entry.title}」相比，新增{entry.axis}）</span>：{entry.difference}
        </li>)}
      </Block>}
      {plan.conflicts.length > 0 && <Block title="待核对">
        {plan.conflicts.map((conflict, index) => {
          const others = conflictTitles(conflict, titles, node.id);
          return <li key={index} className="text-st-new">{conflict.issue}{others.length > 0 && <span className="text-muted-foreground">（涉及 {others.map((title) => `「${title}」`).join("、")}）</span>}</li>;
        })}
      </Block>}
      {(plan.sources.length > 0 || plan.note) && <p className="t-meta">
        {pages.length > 0 && `依据：${pages.map((page) => `第 ${page} 页`).join("、")}。`}{plan.note}
      </p>}
    </div>}
  </section>;
}
