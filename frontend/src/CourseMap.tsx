import { useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, ChevronDown, Flag, Info, Lock, Network, Route, Sparkles, Waypoints } from "lucide-react";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { MapView } from "./MapView";
import { statusIcon, statusLabel } from "./status";
import { splitSummary } from "./summary";
import type { Course, LearningNode } from "./types";

type MapProps = {
  course: Course;
  selected?: LearningNode;
  directEntryId?: string;
  directWeek?: string;
  onSelect: (node: LearningNode) => void;
  reviewActive?: boolean;
  prerequisiteNodes?: LearningNode[];
};

export function CourseMap({ toolbar, ...props }: MapProps & { toolbar?: ReactNode }) {
  const [view, setView] = useState<"route" | "graph">("route");
  const filtered = props.directWeek
    ? props.course.nodes.filter((node) => node.week === props.directWeek) : props.course.nodes;
  const graph = view === "graph" || !props.course.nodes.length;
  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3">
      <Tabs value={graph ? "graph" : "route"} onValueChange={(value) => setView(value as "route" | "graph")} className="max-[780px]:w-full">
        <TabsList aria-label="地图视图" className="max-[780px]:w-full">
          <TabsTrigger value="route"><Route /> 学习主线</TabsTrigger>
          <TabsTrigger value="graph"><Network /> 完整关系图</TabsTrigger>
        </TabsList>
      </Tabs>
      <LegendPopover graph={graph} count={filtered.length} edges={props.course.edges} />
      <div className="flex-1" />
      {toolbar}
    </div>
    {graph
      ? <div className="graph-frame mx-4 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background max-[780px]:mx-2 max-[780px]:mb-2">
          <MapView {...props} course={{ ...props.course, nodes: filtered }} />
        </div>
      : <LearningPath {...props} />}
  </>;
}

function LegendPopover({ graph, count, edges }: { graph: boolean; count: number; edges: Course["edges"] }) {
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="text-muted-foreground"><Info /> 图例</Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 text-[13px]">
      <div className="mb-2 text-xs font-medium text-muted-foreground">学习状态</div>
      <div className="flex flex-wrap gap-1.5">
        {(["new", "studied", "mastered", "passed", "locked"] as const).map((key) => {
          const Icon = statusIcon[key];
          return <Badge key={key} variant={key}><Icon aria-hidden />{statusLabel[key]}</Badge>;
        })}
      </div>
      {graph ? <>
        <div className="mb-2 mt-4 text-xs font-medium text-muted-foreground">连线</div>
        <div className="grid gap-1.5 text-muted-foreground">
          <span className="flex items-center gap-2"><i className="h-0.5 w-6 rounded bg-st-new" />先修链（往前要学的）</span>
          <span className="flex items-center gap-2"><i className="h-0.5 w-6 rounded bg-st-mastered" />后续链（学完能解锁的）</span>
          <span className="flex items-center gap-2"><i className="h-0 w-6 border-t border-dotted border-zinc-500" />AI 推断关系</span>
        </div>
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          {count} 个节点 · {edges.length} 条先修{inferredNote(edges)}。悬停节点看整条链；直达只临时显示，不解锁邻区。
        </p>
      </> : <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">阶段是导航分组，完成条件沿用原有记录。</p>}
    </PopoverContent>
  </Popover>;
}

function inferredNote(edges: Course["edges"]) {
  const inferred = edges.filter((edge) => edge.uncertain).length;
  if (!inferred) return "";
  return inferred === edges.length ? "（全部为 AI 推断）" : `（${inferred} 条为 AI 推断）`;
}

const stateText = {
  new: "text-st-new", studied: "text-st-studied", mastered: "text-st-mastered", passed: "text-st-passed", locked: "text-muted-foreground",
} as const;

function LearningPath({ course, selected, directEntryId, directWeek, onSelect, reviewActive, prerequisiteNodes }: MapProps) {
  const [expansion, setExpansion] = useState<{ selected?: string; stages: Record<string, boolean> }>({ stages: {} });
  const expanded = expansion.selected === selected?.id ? expansion.stages : {};
  const route = course.route;
  if (!route) return <div className="m-4 rounded-xl border border-border p-6 text-sm text-muted-foreground">请重启本地服务后刷新，以加载学习主线。完整关系图仍可使用。</div>;
  const byId = new Map((prerequisiteNodes || course.nodes).map((node) => [node.id, node]));
  const visibleById = new Map(course.nodes.map((node) => [node.id, node]));
  const next = visibleById.get(route.next_node_id ?? "");
  const complete = route.total > 0 && route.completed_count === route.total;
  return <div className="learning-path min-h-0 flex-1 overflow-y-auto px-4 pb-6">
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      {next && !complete && <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 max-[480px]:flex-wrap">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-st-new/10 text-st-new"><Sparkles size={18} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">建议下一步 · {reviewActive && !next.unlocked ? "复习模式临时开放，不改变解锁状态" : "先修已满足"}</div>
          <div className="truncate text-[15px] font-semibold">{next.title}</div>
        </div>
        <Button className="max-[480px]:w-full" onClick={() => {
          const stage = route.stages.find((entry) => entry.node_ids.includes(next.id));
          setExpansion({ selected: next.id, stages: stage ? { [stage.id]: true } : {} });
          onSelect(next);
        }}>{reviewActive ? "开始复习" : "开始学习"} <ArrowRight /></Button>
      </div>}
      {route.warning && <p className="rounded-lg border border-st-new/30 bg-st-new/10 px-3 py-2 text-[13px] text-st-new" role="alert">{route.warning}</p>}
      {directWeek && <p className="text-xs text-muted-foreground">正在查看 {directWeek}，跨周先修条件仍然保留。</p>}
      <div className="flex flex-col gap-2">
        {route.stages.map((stage) => {
          const nodes = stage.node_ids.map((id) => visibleById.get(id)!).filter((node) => node && (!directWeek || node.week === directWeek));
          if (!nodes.length) return null;
          const open = expanded[stage.id] ?? nodes.some((node) => node.id === (selected?.id ?? next?.id));
          return <PathStage key={stage.id} stage={stage} nodes={nodes} byId={byId} open={open}
            selectedId={selected?.id} directEntryId={directEntryId} directWeek={directWeek} reviewActive={reviewActive} onSelect={onSelect}
            onToggle={() => setExpansion({ selected: selected?.id, stages: { ...expanded, [stage.id]: !open } })} />;
        })}
      </div>
      <div className={cn("flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground",
        complete && "border-solid border-st-passed/30 bg-st-passed/10 text-st-passed")}>
        <Flag size={15} aria-hidden />
        <span className="flex-1">{complete ? "本轮主线已完成" : "终点：完成主线，能够解释与运用"}</span>
        <small className="text-xs">自我掌握与验收通过分别记录</small>
      </div>
    </div>
  </div>;
}

function PathStage({ stage, nodes, byId, open, selectedId, directEntryId, directWeek, reviewActive, onSelect, onToggle }: {
  stage: { id: string; title: string }; nodes: LearningNode[]; byId: Map<string, LearningNode>;
  open: boolean; selectedId?: string; directEntryId?: string; directWeek?: string; reviewActive?: boolean;
  onSelect: (node: LearningNode) => void; onToggle: () => void;
}) {
  const completed = nodes.filter((node) => node.status === "passed" || node.status === "mastered").length;
  const isAvailable = (node: LearningNode) =>
    Boolean(reviewActive) || node.unlocked || node.id === directEntryId || Boolean(directWeek && node.week === directWeek);
  const shown = nodes.filter(isAvailable);
  const hidden = nodes.length - shown.length;
  const done = completed === nodes.length;
  return <section className="overflow-hidden rounded-xl border border-border bg-card">
    <button className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      aria-expanded={open} aria-controls={`stage-${stage.id}`} onClick={onToggle}>
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border border-border text-muted-foreground",
        done && "border-st-passed/40 bg-st-passed/10 text-st-passed")}>
        {done ? <Check size={14} /> : <ChevronDown size={15} className={cn("transition-transform", !open && "-rotate-90")} />}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-semibold">{stage.title}</strong>
        <small className="flex items-center gap-1 text-xs text-muted-foreground"><Waypoints size={12} aria-hidden /> {nodes.length} 个知识点 · {shown.length ? `${shown.length} 个可学习` : "均未解锁"}</small>
      </span>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary max-[480px]:hidden"><span className="block h-full rounded-full bg-st-passed" style={{ width: `${Math.round(completed / nodes.length * 100)}%` }} /></span>
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{completed}/{nodes.length}</span>
    </button>
    {open && <div className="flex flex-col gap-2 border-t border-border p-3" id={`stage-${stage.id}`}>
      {shown.map((node) => <PathNode key={node.id} node={node} selected={selectedId === node.id}
        available={isAvailable(node)} reveal={Boolean(reviewActive)}
        parents={node.prerequisites.map((id) => byId.get(id)).filter((parent) => parent !== undefined)}
        onSelect={onSelect} />)}
      {hidden > 0 && <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-[13px] text-muted-foreground">
        <Lock size={14} aria-hidden /><span>另有 {hidden} 个未解锁知识点</span><small className="text-xs opacity-75">完成先修节点后显示，也可以从考点搜索临时直达</small></div>}
    </div>}
  </section>;
}

function PathNode({ node, selected, available, reveal, parents, onSelect }: {
  node: LearningNode; selected: boolean; available: boolean; reveal: boolean; parents: LearningNode[];
  onSelect: (node: LearningNode) => void;
}) {
  const missing = parents.filter((parent) => parent.status !== "passed" && parent.status !== "mastered");
  const statusKey = available ? node.status : "locked";
  const StatusIcon = statusIcon[statusKey];
  // Locked prerequisites keep their titles hidden, the same way the full graph shows them.
  const named = missing.filter((parent) => reveal || parent.unlocked);
  const unnamed = missing.length - named.length;
  return <button className={cn("path-node group flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60",
    selected && "selected border-zinc-400 ring-[3px] ring-ring/15")}
    disabled={!available} onClick={() => onSelect(node)} aria-current={selected ? "step" : undefined}>
    <span className="flex items-center gap-2">
      <StatusIcon size={15} className={cn("shrink-0", stateText[statusKey])} aria-hidden />
      <strong className="min-w-0 flex-1 truncate text-sm font-medium">{node.title}</strong>
      <Badge variant={statusKey}>{statusLabel[statusKey]}</Badge>
    </span>
    <span className="line-clamp-2 pl-[23px] text-[13px] text-muted-foreground">{splitSummary(node.summary || "").explain}</span>
    {missing.length > 0 && <small className="flex items-center gap-1 pl-[23px] text-xs text-muted-foreground"><Lock size={12} aria-hidden /> 还需：{[...named.map((parent) => parent.title), ...(unnamed ? [`${unnamed} 个未解锁先修`] : [])].join("、")}</small>}
    {!!node.lessons?.length && <small className="flex items-center gap-1 pl-[23px] text-xs text-muted-foreground"><BookOpen size={12} aria-hidden /> {node.lessons.length} 节已保存小课</small>}
  </button>;
}
