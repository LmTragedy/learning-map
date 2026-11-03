import { useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, ChevronDown, Flag, Lock, Network, Route, Sparkles, Waypoints } from "lucide-react";
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
    <div className="map-bar">
      <div className="map-view-tabs" role="group" aria-label="地图视图">
        <button className={view === "route" ? "active" : ""} aria-pressed={view === "route"} onClick={() => setView("route")}>
          <Route size={15} /> 学习主线
        </button>
        <button className={view === "graph" ? "active" : ""} aria-pressed={view === "graph"} onClick={() => setView("graph")}>
          <Network size={15} /> 完整关系图
        </button>
      </div>
      {toolbar}
    </div>
    {graph
      ? <MapView {...props} course={{ ...props.course, nodes: filtered }} />
      : <LearningPath {...props} />}
    <div className="map-legend">
      {graph ? <>
        <span className="legend-stat">{filtered.length} 个节点 · {props.course.edges.length} 条先修{inferredNote(props.course.edges)}</span>
        <Legend />
        <span><i className="legend-line up" />先修链</span>
        <span><i className="legend-line down" />后续链</span>
        <span><i className="legend-line dotted" />AI 推断关系</span>
        <span className="legend-hint">悬停节点看整条链 · 直达只临时显示，不解锁邻区</span>
      </> : <>
        <Legend />
        <span className="legend-hint">阶段是导航分组，完成条件沿用原有记录</span>
      </>}
    </div>
  </>;
}

function Legend() {
  return <>
    {(["new", "studied", "mastered", "passed", "locked"] as const).map((key) => {
      const Icon = statusIcon[key];
      return <span key={key} className={`legend-item tone-${key}`}><Icon size={13} aria-hidden />{statusLabel[key]}</span>;
    })}
  </>;
}

function inferredNote(edges: Course["edges"]) {
  const inferred = edges.filter((edge) => edge.uncertain).length;
  if (!inferred) return "";
  return inferred === edges.length ? "（全部为 AI 推断）" : `（${inferred} 条为 AI 推断）`;
}

function LearningPath({ course, selected, directEntryId, directWeek, onSelect, reviewActive, prerequisiteNodes }: MapProps) {
  const [expansion, setExpansion] = useState<{ selected?: string; stages: Record<string, boolean> }>({ stages: {} });
  const expanded = expansion.selected === selected?.id ? expansion.stages : {};
  const route = course.route;
  if (!route) return <div className="route-empty">请重启本地服务后刷新，以加载学习主线。完整关系图仍可使用。</div>;
  const byId = new Map((prerequisiteNodes || course.nodes).map((node) => [node.id, node]));
  const visibleById = new Map(course.nodes.map((node) => [node.id, node]));
  const next = visibleById.get(route.next_node_id ?? "");
  const complete = route.total > 0 && route.completed_count === route.total;
  return <div className="learning-path">
    {next && !complete && <div className="path-next"><Sparkles size={18} className="path-next-icon" aria-hidden /><div>
      <span className="eyebrow">建议下一步 · {reviewActive && !next.unlocked ? "复习模式临时开放，不改变解锁状态" : "先修已满足"}</span>
      <strong>{next.title}</strong></div>
      <button className="primary" onClick={() => {
        const stage = route.stages.find((entry) => entry.node_ids.includes(next.id));
        setExpansion({ selected: next.id, stages: stage ? { [stage.id]: true } : {} });
        onSelect(next);
      }}>{reviewActive ? "开始复习" : "开始学习"} <ArrowRight size={15} /></button></div>}
    {route.warning && <p className="ai-disabled-note" role="alert">{route.warning}</p>}
    {directWeek && <p className="path-caption">正在查看 {directWeek}，跨周先修条件仍然保留。</p>}
    <div className="path-stages">
      {route.stages.map((stage) => {
        const nodes = stage.node_ids.map((id) => visibleById.get(id)!).filter((node) => node && (!directWeek || node.week === directWeek));
        if (!nodes.length) return null;
        const open = expanded[stage.id] ?? nodes.some((node) => node.id === (selected?.id ?? next?.id));
        return <PathStage key={stage.id} stage={stage} nodes={nodes} byId={byId} open={open}
          selectedId={selected?.id} directEntryId={directEntryId} directWeek={directWeek} reviewActive={reviewActive} onSelect={onSelect}
          onToggle={() => setExpansion({ selected: selected?.id, stages: { ...expanded, [stage.id]: !open } })} />;
      })}
    </div>
    <div className={`path-finish ${complete ? "complete" : ""}`}>
      <Flag size={16} aria-hidden />
      <span>{complete ? "本轮主线已完成" : "终点：完成主线，能够解释与运用"}</span>
      <small>自我掌握与验收通过分别记录</small>
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
  return <section className={`path-stage ${open ? "expanded" : ""}`}>
    <button className="stage-heading" aria-expanded={open} aria-controls={`stage-${stage.id}`} onClick={onToggle}>
      <span className={`stage-dot ${completed === nodes.length ? "complete" : ""}`}>
        {completed === nodes.length ? <Check size={15} /> : <ChevronDown size={16} />}</span>
      <strong>{stage.title}</strong>
      <small><Waypoints size={13} aria-hidden /> {nodes.length} 个知识点 · {shown.length ? `${shown.length} 个可学习` : "均未解锁"}</small>
      <i className="stage-progress" style={{ ["--p" as string]: `${Math.round(completed / nodes.length * 100)}%` }} aria-hidden />
      <span className="stage-count">{completed}/{nodes.length}</span>
    </button>
    {open && <div className="stage-nodes" id={`stage-${stage.id}`}>
      {shown.map((node) => <PathNode key={node.id} node={node} selected={selectedId === node.id}
        available={isAvailable(node)} reveal={Boolean(reviewActive)}
        parents={node.prerequisites.map((id) => byId.get(id)).filter((parent) => parent !== undefined)}
        onSelect={onSelect} />)}
      {hidden > 0 && <div className="path-locked-group"><Lock size={14} aria-hidden />
        <span>另有 {hidden} 个未解锁知识点</span><small>完成先修节点后显示，也可以从考点搜索临时直达</small></div>}
    </div>}
  </section>;
}

function PathNode({ node, selected, available, reveal, parents, onSelect }: {
  node: LearningNode; selected: boolean; available: boolean; reveal: boolean; parents: LearningNode[];
  onSelect: (node: LearningNode) => void;
}) {
  const missing = parents.filter((parent) => parent.status !== "passed" && parent.status !== "mastered");
  const tone = !available ? "locked" : node.status === "new" ? "available" : node.status;
  const statusKey = available ? node.status : "locked";
  const StatusIcon = statusIcon[statusKey];
  // Locked prerequisites keep their titles hidden, the same way the full graph shows them.
  const named = missing.filter((parent) => reveal || parent.unlocked);
  const unnamed = missing.length - named.length;
  return <button className={`path-node tone-${tone} ${selected ? "selected" : ""} ${available ? "" : "locked"}`}
    disabled={!available} onClick={() => onSelect(node)} aria-current={selected ? "step" : undefined}>
    <span className="path-node-top"><StatusIcon size={15} className="path-node-icon" aria-hidden /><strong>{node.title}</strong>
      <small className={`status-chip tone-${statusKey}`}>{statusLabel[statusKey]}</small></span>
    <span className="path-node-summary">{splitSummary(node.summary || "").explain}</span>
    {missing.length > 0 && <small className="path-node-note"><Lock size={12} aria-hidden /> 还需：{[...named.map((parent) => parent.title), ...(unnamed ? [`${unnamed} 个未解锁先修`] : [])].join("、")}</small>}
    {!!node.lessons?.length && <small className="path-node-note"><BookOpen size={12} aria-hidden /> {node.lessons.length} 节已保存小课</small>}
  </button>;
}
