import { useState } from "react";
import { ArrowRight, CheckCircle2, CheckSquare, ChevronRight, Flag, Plus, Route, Square, Target, X } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { useGoalActions } from "./goalActions";
import { editableGoal, readyToFinish } from "./goalFields";
import { finished, goalsForNode, type NodeGoalContext } from "./goalContext";
import { cn } from "./lib/utils";
import type { Course, LearningNode } from "./types";

const STATUS = { doing: "进行中", todo: "待开始", done: "已完成" } as const;
const STATUS_STYLE = { doing: "bg-st-new/15 text-st-new", todo: "bg-secondary text-muted-foreground", done: "bg-st-passed/15 text-st-passed" } as const;
/** Beyond this many stations the route is drawn as one bar instead of segments. */
const MAX_SEGMENTS = 16;

function RouteTrack({ course, entry, nodeId }: { course: Course; entry: NodeGoalContext; nodeId: string }) {
  const nodes = new Map(course.nodes.map((node) => [node.id, node]));
  const { path, completed } = entry;
  if (!path.length) return null;
  const first = nodes.get(path[0]), last = nodes.get(path[path.length - 1]);
  return <div className="flex flex-col gap-1">
    {path.length <= MAX_SEGMENTS
      ? <div className="flex gap-[3px]" aria-hidden>{path.map((id) => {
        const node = nodes.get(id)!;
        return <span key={id} title={node.unlocked ? node.title : "未解锁知识点"} className={cn("h-1.5 flex-1 rounded-full bg-track",
          id === nodeId ? "bg-st-new ring-2 ring-st-new/30" : finished(node) && "bg-st-passed")} />;
      })}</div>
      : <div className="h-1.5 overflow-hidden rounded-full bg-track" aria-hidden>
        <span className="block h-full bg-st-passed" style={{ width: `${completed / path.length * 100}%` }} />
      </div>}
    <div className="flex justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
      <span className="truncate">{first?.unlocked ? first.title : "起点"}</span>
      <span className="shrink-0">已掌握 {completed}/{path.length}</span>
      <span className="truncate text-right">{last?.unlocked ? last.title : "终点"}</span>
    </div>
  </div>;
}

/** Goal progress that moved with the last save, shown where the learner is working. */
function GoalChanges({ course, onOpenGoal }: { course: Course; onOpenGoal: (goalId: string) => void }) {
  const actions = useGoalActions();
  const changes = (actions?.changes || []).filter((change) => course.goals?.some((goal) => goal.id === change.goalId));
  if (!actions || !changes.length) return null;
  return <div className="flex items-start gap-2 rounded-xl border border-st-passed/40 bg-st-passed/10 p-3 text-xs" role="status">
    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-st-passed" aria-hidden />
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {changes.map((change) => {
        const goal = course.goals!.find((entry) => entry.id === change.goalId)!;
        return <div key={change.goalId} className="flex flex-col gap-0.5">
          <span className="text-[13px] text-foreground">目标「{change.title}」{change.verified ? <>验收 {change.verified[0]}/{change.total} → <strong className="font-semibold">{change.verified[1]}/{change.total}</strong></> : "有新进展"}</span>
          {change.subtasks.map((title) => <span key={title} className="text-muted-foreground">小目标「{title}」已完成</span>)}
          {readyToFinish(goal) && <button className="w-fit cursor-pointer text-st-new hover:underline" onClick={() => onOpenGoal(goal.id)}>条件已全部满足，去看板确认完成 →</button>}
        </div>;
      })}
    </div>
    <Button size="icon-sm" variant="ghost" className="-mr-1 -mt-1 size-6" aria-label="关闭进度提示" onClick={actions.onDismissChanges}><X /></Button>
  </div>;
}

function GoalCard({ course, node, entry, busy, onOpenGoal }: {
  course: Course; node: LearningNode; entry: NodeGoalContext; busy: boolean; onOpenGoal: (goalId: string) => void;
}) {
  const actions = useGoalActions();
  const { goal, roles, step, path, remaining, subtasks, next } = entry;
  const scope = course.review_scope;
  const nextOutside = Boolean(next && scope?.enabled && !scope.node_ids.includes(next.id));
  const focused = actions?.focusedGoal === goal.id;
  return <div className="flex flex-col gap-2.5 rounded-xl border border-st-passed/35 bg-st-passed/[0.05] p-3">
    <div className="flex items-start gap-2">
      <Target size={15} className="mt-0.5 shrink-0 text-st-passed" aria-hidden />
      <strong className="min-w-0 flex-1 text-sm font-semibold">{goal.title}</strong>
      <span className={cn("shrink-0 rounded-full px-2 py-px text-[11px]", STATUS_STYLE[goal.status])}>{STATUS[goal.status]}</span>
    </div>
    <RouteTrack course={course} entry={entry} nodeId={node.id} />
    <p className="text-[13px]">
      {roles.includes("endpoint")
        ? <><Flag size={13} className="mr-1 inline align-[-2px] text-st-passed" aria-hidden />这是<strong className="font-semibold text-st-passed">目标终点</strong></>
        : roles.includes("route")
          ? <>通往终点的<strong className="font-semibold text-st-new">第 {step} / {path.length} 步</strong></>
          : <>关联到这个目标的小目标</>}
      {(roles.includes("endpoint") || roles.includes("route")) && <span className="text-muted-foreground"> · {remaining ? `还剩 ${remaining} 步` : "路线已全部掌握"}</span>}
    </p>
    {subtasks.map((task) => {
      const ticked = task.done || task.auto_done;
      const Icon = ticked ? CheckSquare : Square;
      return <p key={task.id} className={cn("flex items-start gap-1.5 text-xs", ticked ? "text-st-passed" : "text-muted-foreground")}>
        <Icon size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>{ticked ? "小目标已完成：" : "验收通过后自动完成："}<span className={cn(ticked ? "line-through" : "text-foreground")}>{task.title}</span></span>
      </p>;
    })}
    <div className="flex items-center gap-2 border-t border-border pt-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {next ? <>下一步：<span className="text-foreground">{next.unlocked ? next.title : "未解锁知识点"}</span></> : "路线上没有其他待学节点"}
      </span>
      {next && actions && <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={busy || nextOutside}
        title={nextOutside ? "不在当前 PDF 复习范围，请先调整范围或退出复习" : undefined} onClick={() => actions.onOpenNode(next.id)}>
        {next.unlocked ? "进入" : "临时直达"} <ArrowRight />
      </Button>}
    </div>
    <div className="-mx-1 -mb-1 flex flex-wrap gap-1">
      {actions && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-pressed={focused} onClick={() => actions.onFocusGoal(goal.id)}>
        <Route /> {focused ? "取消路线显示" : "在地图上显示路线"}
      </Button>}
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpenGoal(goal.id)} title="在目标看板中打开">
        打开目标 <ChevronRight />
      </Button>
    </div>
  </div>;
}

/** Goals this node leads to, sits on or completes, plus a quick way to link it to another goal. */
export function NodeGoals({ course, node, busy, act, onOpenGoal }: {
  course: Course; node: LearningNode; busy: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onOpenGoal: (goalId: string) => void;
}) {
  const [expanded, setExpanded] = useState("");
  const goals = course.goals || [];
  if (!goals.length) return null;
  const related = goalsForNode(course, node.id);
  const primary = related.find((entry) => entry.goal.id === expanded) || related[0];
  const rest = related.filter((entry) => entry !== primary);
  const others = goals.filter((goal) => !goal.node_ids.includes(node.id) && goal.node_ids.length < 100);
  const addToGoal = !!others.length && <label className="relative flex items-center text-muted-foreground">
    <Plus size={12} className="pointer-events-none absolute left-1.5" aria-hidden />
    <select className="h-6 cursor-pointer appearance-none rounded-full border border-dashed border-border bg-transparent !py-0 !pl-5 !pr-2 text-xs"
      aria-label="把这个知识点设为目标终点" value="" disabled={busy}
      onChange={(event) => {
        const goal = others.find((entry) => entry.id === event.target.value);
        if (goal) void act("goal", () => api.updateGoal(course.id, goal.id,
          { ...editableGoal(goal), node_ids: [...goal.node_ids, node.id], revision: course.revision }));
      }}>
      <option value="">加入目标…</option>
      {others.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
    </select>
  </label>;

  if (!primary) return <div className="flex flex-col gap-2">
    <GoalChanges course={course} onOpenGoal={onOpenGoal} />
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="flex items-center gap-1 text-muted-foreground"><Target size={13} aria-hidden /> 不在任何目标路线上</span>
      {addToGoal}
    </div>
  </div>;

  return <section className="flex flex-col gap-2" aria-label="这个知识点所属的目标">
    <GoalChanges course={course} onOpenGoal={onOpenGoal} />
    <GoalCard key={primary.goal.id} course={course} node={node} entry={primary} busy={busy} onOpenGoal={onOpenGoal} />
    {!!rest.length && <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">另有 {rest.length} 个目标经过这里</span>
      {rest.map((entry) => <button key={entry.goal.id} onClick={() => setExpanded(entry.goal.id)}
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs hover:bg-accent/40">
        <Target size={13} className="shrink-0 text-st-passed" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{entry.goal.title}</span>
        <span className="shrink-0 text-muted-foreground">{entry.roles.includes("endpoint") ? "终点" : entry.step ? `第 ${entry.step}/${entry.path.length} 步` : "小目标"}</span>
        <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10px]", STATUS_STYLE[entry.goal.status])}>{STATUS[entry.goal.status]}</span>
      </button>)}
    </div>}
    {addToGoal && <div className="flex">{addToGoal}</div>}
  </section>;
}
