import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BadgeCheck, BookOpen, CircleCheck, CircleDot, Crosshair, Focus, Lock, Maximize, Sparkles } from "lucide-react";
import type { Course, LearningNode } from "./types";
import { NODE_HEIGHT, NODE_WIDTH, graphPositions, lineage } from "./graphLayout";

type Tone = "passed" | "mastered" | "studied" | "available" | "locked";
type Role = "focus" | "up" | "down" | "dim" | "none";
type KnowledgeData = {
  title: string; tone: Tone; role: Role; selected: boolean; next: boolean; direct: boolean;
  lessons: number; hint: string;
};
type StageData = { title: string; count: number; done: number; width: number; height: number };

const toneLabel: Record<Tone, string> = {
  passed: "验收通过", mastered: "自我掌握", studied: "学过", available: "可学习", locked: "未解锁",
};
const toneIcon: Record<Tone, typeof Lock> = {
  passed: CircleCheck, mastered: BadgeCheck, studied: BookOpen, available: CircleDot, locked: Lock,
};
const toneColor: Record<Tone, string> = {
  passed: "#35d3c5", mastered: "#7fb7ff", studied: "#a3b3c6", available: "#f5bc58", locked: "#4a5b70",
};

const KnowledgeNode = memo(function KnowledgeNode({ data }: NodeProps<Node<KnowledgeData>>) {
  const Icon = toneIcon[data.tone];
  return <div className={`kn tone-${data.tone} role-${data.role} ${data.selected ? "is-selected" : ""}`} title={data.hint}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <span className="kn-state"><Icon size={12} aria-hidden />{toneLabel[data.tone]}
      {data.next && <em className="kn-flag">建议下一步</em>}
      {data.direct && <em className="kn-flag">临时直达</em>}
      {data.lessons > 0 && <span className="kn-lessons" title={`${data.lessons} 节已保存小课`}><BookOpen size={11} aria-hidden />{data.lessons}</span>}
    </span>
    {data.title ? <strong>{data.title}</strong> : <span className="kn-hidden" aria-label="未解锁知识点"><i /><i /></span>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
});

const StageBand = memo(function StageBand({ data }: NodeProps<Node<StageData>>) {
  const ratio = data.count ? data.done / data.count : 0;
  return <div className="stage-band" style={{ width: data.width, height: data.height }}>
    <div className="stage-band-head">
      {data.title ? <strong>{data.title}</strong> : <span className="kn-hidden" aria-label="未解锁知识点"><i /><i /></span>}
      <span>{data.count} 个 · 已完成 {data.done}</span>
      <i style={{ ["--p" as string]: `${Math.round(ratio * 100)}%` }} aria-hidden />
    </div>
  </div>;
});

const nodeTypes = { knowledge: KnowledgeNode, stage: StageBand };
type GraphNode = Node<KnowledgeData> | Node<StageData>;

function isDone(node: LearningNode) {
  return node.status === "passed" || node.status === "mastered";
}

export function MapView({
  course,
  selected,
  directEntryId,
  directWeek,
  reviewActive,
  onSelect,
}: {
  course: Course;
  selected?: LearningNode;
  directEntryId?: string;
  directWeek?: string;
  reviewActive?: boolean;
  prerequisiteNodes?: LearningNode[];
  onSelect: (node: LearningNode) => void;
}) {
  const flow = useRef<ReactFlowInstance<GraphNode, Edge>>();
  const clickedInside = useRef(false);
  const [hovered, setHovered] = useState<string>();
  const [focusOnly, setFocusOnly] = useState(false);
  const isVisible = useCallback((n: LearningNode) =>
    Boolean(reviewActive) || n.unlocked || n.id === directEntryId || Boolean(directWeek && n.week === directWeek),
  [reviewActive, directEntryId, directWeek]);

  const nodeIds = useMemo(() => new Set(course.nodes.map((n) => n.id)), [course.nodes]);
  const links = useMemo(() => course.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)), [course.edges, nodeIds]);
  const stageOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of course.route?.stages ?? []) for (const id of stage.node_ids) map.set(id, stage.id);
    return map;
  }, [course.route]);
  const positions = useMemo(() => graphPositions(course.nodes, links, stageOf), [course.nodes, links, stageOf]);

  const focusId = hovered ?? selected?.id;
  const chain = useMemo(() => lineage(focusId, links), [focusId, links]);
  const selectedChain = useMemo(() => lineage(selected?.id, links), [selected?.id, links]);
  const filtering = focusOnly && Boolean(selected);
  const inSelectedChain = useCallback((id: string) =>
    id === selected?.id || selectedChain.up.has(id) || selectedChain.down.has(id), [selected?.id, selectedChain]);

  const { nodes, edges } = useMemo(() => {
    const byId = new Map(course.nodes.map((n) => [n.id, n]));
    const roleOf = (id: string): Role => {
      if (!focusId) return "none";
      if (id === focusId) return "focus";
      if (chain.up.has(id)) return "up";
      if (chain.down.has(id)) return "down";
      return "dim";
    };
    const knowledge: Node<KnowledgeData>[] = course.nodes.map((n) => {
      const visible = isVisible(n);
      const tone: Tone = !visible ? "locked" : n.status === "new" ? "available" : n.status;
      const missing = n.prerequisites.map((id) => byId.get(id)).filter((p): p is LearningNode => Boolean(p) && !isDone(p!));
      return {
        id: n.id,
        type: "knowledge",
        position: positions.get(n.id)!,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        zIndex: 2,
        hidden: filtering && !inSelectedChain(n.id),
        draggable: false,
        selectable: visible,
        data: {
          title: visible ? n.title : "",
          tone,
          role: roleOf(n.id),
          selected: n.id === selected?.id,
          next: n.id === course.route?.next_node_id,
          direct: visible && !n.unlocked && !reviewActive,
          lessons: n.lessons?.length ?? 0,
          hint: visible
            ? `${n.title}\n${n.week || "未分周"} · ${n.difficulty || "难度待评估"}`
            : `未解锁${missing.length ? `：还需先完成 ${missing.length} 个先修` : ""}；通过先修节点后显示，也可以从考点搜索临时直达`,
        },
      };
    });
    const bands: Node<StageData>[] = [];
    const placed = knowledge.filter((n) => !n.hidden);
    const bottom = Math.max(0, ...placed.map((n) => n.position.y)) + NODE_HEIGHT + 28;
    for (const stage of course.route?.stages ?? []) {
      const members = stage.node_ids.map((id) => positions.get(id)).filter((p) => p !== undefined);
      if (!members.length || stage.id === "unresolved") continue;
      const left = Math.min(...members.map((p) => p.x)) - 18;
      const right = Math.max(...members.map((p) => p.x)) + NODE_WIDTH + 18;
      const done = stage.node_ids.filter((id) => byId.get(id) && isDone(byId.get(id)!)).length;
      bands.push({
        id: `band:${stage.id}`, type: "stage", position: { x: left, y: 8 }, zIndex: 0,
        draggable: false, selectable: false, focusable: false,
        data: { title: stage.title, count: members.length, done, width: right - left, height: bottom - 8 },
      });
    }
    const edgeRole = (source: string, target: string) => {
      if (!focusId) return "none";
      if ((target === focusId || chain.up.has(target)) && chain.up.has(source)) return "up";
      if ((source === focusId || chain.down.has(source)) && chain.down.has(target)) return "down";
      return "dim";
    };
    const graphEdges: Edge[] = links.map((edge) => {
      const role = edgeRole(edge.source, edge.target);
      const color = role === "up" ? "#f5bc58" : role === "down" ? "#35d3c5" : "#5d7189";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        zIndex: 1,
        hidden: filtering && !(inSelectedChain(edge.source) && inSelectedChain(edge.target)),
        className: `ke role-${role} ${edge.uncertain ? "uncertain" : ""}`,
        ariaLabel: edge.relation,
        style: {
          stroke: color,
          strokeWidth: role === "up" || role === "down" ? 2 : 1.2,
          opacity: role === "dim" ? 0.12 : role === "none" ? 0.55 : 0.95,
          strokeDasharray: edge.uncertain ? "1 5" : undefined,
          strokeLinecap: "round",
        },
        markerEnd: { type: "arrowclosed", color, width: 14, height: 14 },
      };
    });
    return { nodes: [...bands, ...knowledge] as GraphNode[], edges: graphEdges };
  }, [course, positions, links, focusId, chain, selected?.id, isVisible, filtering, inSelectedChain, reviewActive]);

  const frame = useCallback((ids: string[], duration = 300) => {
    const instance = flow.current;
    if (!instance || !ids.length) return;
    void instance.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.12, minZoom: 0.3, maxZoom: 1, duration });
  }, []);
  const focusSelected = useCallback((duration = 300, initial = false) => {
    const target = selected?.id ?? course.route?.next_node_id ?? course.nodes[0]?.id;
    const at = target ? positions.get(target) : undefined;
    if (!flow.current || !at) return;
    const zoom = initial ? 0.85 : Math.min(Math.max(flow.current.getZoom(), 0.85), 1.2);
    void flow.current.setCenter(at.x + NODE_WIDTH * 1.5, at.y + NODE_HEIGHT / 2, { zoom, duration });
  }, [selected?.id, course.route?.next_node_id, course.nodes, positions]);

  // Follow selections made outside the graph (search, learning path) without jumping on every click.
  useEffect(() => {
    if (clickedInside.current) { clickedInside.current = false; return; }
    if (flow.current && selected) focusSelected();
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!filtering || !selected) return;
    const ids = course.nodes.filter((n) => inSelectedChain(n.id)).map((n) => n.id);
    requestAnimationFrame(() => frame(ids));
  }, [filtering]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!course.nodes.length)
    return (
      <div className="map-empty">
        <div className="empty-orbit">⌘</div>
        <h2>地图还没有知识节点</h2>
        <p>导入课程材料后生成地图，或先开始整理学习主题。</p>
        <span>所有节点与进度均由本地学习记录生成</span>
      </div>
    );
  return (
    <div className="map-wrap">
      <div className="graph-tools">
        <button onClick={() => focusSelected()} disabled={!selected} title="把视野移到当前节点">
          <Crosshair size={14} /> 定位当前
        </button>
        <button onClick={() => void flow.current?.fitView({ padding: 0.08, duration: 300 })} title="缩放到能看到全部节点">
          <Maximize size={14} /> 看全图
        </button>
        <button className={filtering ? "on" : ""} aria-pressed={filtering} disabled={!selected}
          onClick={() => setFocusOnly((value) => !value)} title="只显示当前节点的全部先修和后续">
          <Focus size={14} /> 只看相关
        </button>
        {selected && (
          <span className="graph-focus-note">
            <Sparkles size={13} aria-hidden />
            <span><b className="up">{selectedChain.up.size}</b> 个先修 · <b className="down">{selectedChain.down.size}</b> 个后续</span>
          </span>
        )}
      </div>
      <div className="map-canvas">
        <ReactFlow
          key={`${course.id}:${directWeek ?? ""}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={0.15}
          maxZoom={1.6}
          onInit={(instance) => { flow.current = instance; requestAnimationFrame(() => focusSelected(0, true)); }}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          onNodeMouseEnter={(_, node) => { if (node.type === "knowledge") setHovered(node.id); }}
          onNodeMouseLeave={() => setHovered(undefined)}
          onNodeClick={(_, node) => {
            const found = course.nodes.find((n) => n.id === node.id);
            if (found && isVisible(found)) { clickedInside.current = true; onSelect(found); }
          }}
          proOptions={{ hideAttribution: false }}
        >
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{ width: 168, height: 96 }}
            nodeColor={(n) => n.type === "stage" ? "transparent" : toneColor[(n.data as KnowledgeData).tone]}
            nodeStrokeColor={(n) => n.type === "stage" ? "#2b3b50" : "transparent"}
            nodeBorderRadius={6}
            maskColor="rgba(9, 15, 25, .62)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
