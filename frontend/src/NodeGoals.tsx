import { Plus, Target } from "lucide-react";
import { api } from "./api";
import { editableGoal } from "./goalFields";
import type { Course, LearningNode } from "./types";

/** Goals that link this node, plus a quick way to link it to another goal. */
export function NodeGoals({ course, node, busy, act, onOpenGoal }: {
  course: Course; node: LearningNode; busy: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onOpenGoal: (goalId: string) => void;
}) {
  const goals = course.goals || [];
  const linked = goals.filter((goal) => goal.node_ids.includes(node.id));
  const others = goals.filter((goal) => !goal.node_ids.includes(node.id) && goal.node_ids.length < 100);
  if (!goals.length) return null;
  return <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
    <span className="flex items-center gap-1 text-muted-foreground"><Target size={13} aria-hidden /> 所属目标</span>
    {linked.map((goal) => <button key={goal.id} onClick={() => onOpenGoal(goal.id)} title="在目标看板中打开"
      className="cursor-pointer rounded-full border border-border bg-card px-2 py-0.5 hover:border-zinc-500">
      {goal.title}{goal.status === "done" ? " · 已完成" : goal.status === "doing" ? " · 进行中" : ""}
    </button>)}
    {!linked.length && <span className="text-muted-foreground">暂无</span>}
    {!!others.length && <label className="relative flex items-center text-muted-foreground">
      <Plus size={12} className="pointer-events-none absolute left-1.5" aria-hidden />
      <select className="h-6 cursor-pointer appearance-none rounded-full border border-dashed border-border bg-transparent !py-0 !pl-5 !pr-2 text-xs"
        aria-label="把这个知识点加入目标" value="" disabled={busy}
        onChange={(event) => {
          const goal = others.find((entry) => entry.id === event.target.value);
          if (goal) void act("goal", () => api.updateGoal(course.id, goal.id,
            { ...editableGoal(goal), node_ids: [...goal.node_ids, node.id], revision: course.revision }));
        }}>
        <option value="">加入目标…</option>
        {others.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
      </select>
    </label>}
  </div>;
}
