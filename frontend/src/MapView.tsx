import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph.css";
import { Crosshair, Focus, Maximize, Sparkles, Tags } from "lucide-react";
import type { Course, LearningNode } from "./types";
import { forceLayout, lineage } from "./graphLayout";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { isRelationVisible, needsExplanation } from "./relationVisibility";
import { isNodeVisible } from "./nodeVisibility";

type Tone = "passed" | "mastered" | "studied" | "available" | "locked";
type Role = "focus" | "up" | "down" | "dim" | "none";
type DotData = {
  title: string; tone: Tone; role: Role; selected: boolean; next: boolean; radius: number; hint: string;
};

const toneLabel: Record<Tone, string> = {
  passed: "验收通过", mastered: "自我掌握", studied: "学过", available: "可学习", locked: "未解锁",
};

const DotNode = memo(function DotNode({ data }: NodeProps<Node<DotData>>) {
  const size = data.radius * 2;
  return <div className={`gdot tone-${data.tone} role-${data.role} ${data.selected ? "is-selected" : ""} ${data.next ? "is-next" : ""}`}
    style={{ width: size, height: size }} title={data.hint} aria-label={data.title ? `${data.title}，${toneLabel[data.tone]}` : "未解锁知识点"}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <span className="gdot-core" />
    {data.title && <span className="gdot-label">{data.title}</span>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
});

const nodeTypes = { dot: DotNode };
type GraphNode = Node<DotData>;

function isDone(node: LearningNode) {
  return node.status === "passed" || node.status === "mastered";
}

export function MapView({
  course,
  selected,
  directEntryId,
  directWeek,
  reviewActive,
  reviewStrict,
  onSelect,
  onRelationSelect,
  focusIds,
}: {
  course: Course;
  selected?: LearningNode;
  directEntryId?: string;
  directWeek?: string;
  reviewActive?: boolean;
  reviewStrict?: boolean;
  prerequisiteNodes?: LearningNode[];
  focusIds?: string[];
  onSelect: (node: LearningNode) => void;
  onRelationSelect?: (edge: Course["edges"][number]) => void;
}) {
  const flow = useRef<ReactFlowInstance<GraphNode, Edge>>();
  const clickedInside = useRef(false);
  const [hovered, setHovered] = useState<string>();
  const [focusOnly, setFocusOnly] = useState(false);
  const [alwaysLabels, setAlwaysLabels] = useState(false);
  const [zoom, setZoom] = useState(1);
  const isVisible = useCallback((node: LearningNode) => isNodeVisible(node, { reviewActive: Boolean(reviewActive), directEntryId, directWeek }),
    [reviewActive, directEntryId, directWeek]);

  const nodeIds = useMemo(() => new Set(course.nodes.map((n) => n.id)), [course.nodes]);
  const links = useMemo(() => course.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && isRelationVisible(course, e, Boolean(reviewStrict))), [course, nodeIds, reviewStrict]);
  const prerequisiteLinks = useMemo(() => links.filter((edge) =>
    course.nodes.find((node) => node.id === edge.target)?.prerequisites.includes(edge.source),
  ), [course.nodes, links]);
  const prerequisiteEdgeIds = useMemo(() => new Set(prerequisiteLinks.map((edge) => edge.id)), [prerequisiteLinks]);
  const centres = useMemo(() => forceLayout(course.nodes, links), [course.nodes, links]);
  const degree = useMemo(() => {
    const count = new Map<string, number>();
    for (const edge of links) {
      count.set(edge.source, (count.get(edge.source) ?? 0) + 1);
      count.set(edge.target, (count.get(edge.target) ?? 0) + 1);
    }
    return count;
  }, [links]);

  // Like Obsidian, the graph stays neutral until the pointer rests on a node; the selection only gets a ring.
  const focusId = hovered ?? (focusOnly ? selected?.id : undefined);
  const chain = useMemo(() => lineage(focusId, prerequisiteLinks), [focusId, prerequisiteLinks]);
  const selectedChain = useMemo(() => lineage(selected?.id, prerequisiteLinks), [selected?.id, prerequisiteLinks]);
  const filtering = focusOnly && Boolean(selected);
  const inSelectedChain = useCallback((id: string) =>
    id === selected?.id || selectedChain.up.has(id) || selectedChain.down.has(id), [selected?.id, selectedChain]);
  const relatedContextIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of links) {
      if (prerequisiteEdgeIds.has(edge.id)) continue;
      if (inSelectedChain(edge.source)) ids.add(edge.target);
      if (inSelectedChain(edge.target)) ids.add(edge.source);
    }
    return ids;
  }, [links, prerequisiteEdgeIds, inSelectedChain]);
  const inRelatedContext = useCallback((id: string) => inSelectedChain(id) || relatedContextIds.has(id), [inSelectedChain, relatedContextIds]);

  const { nodes, edges } = useMemo(() => {
    const byId = new Map(course.nodes.map((n) => [n.id, n]));
    const roleOf = (id: string): Role => {
      if (!focusId) return "none";
      if (id === focusId) return "focus";
      if (chain.up.has(id)) return "up";
      if (chain.down.has(id)) return "down";
      return "dim";
    };
    const dots: GraphNode[] = course.nodes.map((n) => {
      const visible = isVisible(n);
      const tone: Tone = !visible ? "locked" : n.status === "new" ? "available" : n.status;
      const radius = Math.round(5 + Math.sqrt(degree.get(n.id) ?? 0) * 2.4);
      const centre = centres.get(n.id)!;
      const missing = n.prerequisites.map((id) => byId.get(id)).filter((p): p is LearningNode => Boolean(p) && !isDone(p!));
      return {
        id: n.id,
        type: "dot",
        position: { x: centre.x - radius, y: centre.y - radius },
        width: radius * 2,
        height: radius * 2,
        hidden: filtering && !inRelatedContext(n.id),
        // Focusing on a goal fades every node outside it.
        style: focusIds && !focusIds.includes(n.id) ? { opacity: 0.15 } : undefined,
        draggable: false,
        selectable: visible,
        data: {
          title: visible ? n.title : "",
          tone,
          role: roleOf(n.id),
          selected: n.id === selected?.id,
          next: n.id === course.route?.next_node_id,
          radius,
          hint: visible
            ? `${n.title} · ${toneLabel[tone]}${n.personal_note?.trim() ? " · 有笔记" : ""}`
            : `未解锁${missing.length ? `：还需先完成 ${missing.length} 个先修` : ""}；通过先修节点后显示，也可以从考点搜索临时直达`,
        },
      };
    });
    const edgeRole = (edge: Course["edges"][number]) => {
      const { source, target } = edge;
      if (!prerequisiteEdgeIds.has(edge.id)) return "none";
      if (!focusId) return "none";
      if ((target === focusId || chain.up.has(target)) && chain.up.has(source)) return "up";
      if ((source === focusId || chain.down.has(source)) && chain.down.has(target)) return "down";
      return "dim";
    };
    const lines: Edge[] = links.map((edge) => {
      const role = edgeRole(edge);
      const lit = role === "up" || role === "down";
      const color = role === "up" ? "#fbbf24" : role === "down" ? "#60a5fa" : "#52525b";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "straight",
        className: "relationship-edge",
        selectable: false,
        focusable: true,
        interactionWidth: 24,
        hidden: filtering && !(inRelatedContext(edge.source) && inRelatedContext(edge.target)),
        ariaLabel: `${edge.relation}：${needsExplanation(edge) ? "原因待补充" : (edge.explanation || "").split("\n")[0]}`,
        style: {
          stroke: color,
          strokeWidth: lit ? 1.6 : 1,
          opacity: role === "dim" ? 0.06 : role === "none" ? 0.32 : 0.9,
          strokeDasharray: edge.uncertain || !edge.confirmed ? "4 3" : undefined,
        },
        markerEnd: lit ? { type: "arrowclosed", color, width: 12, height: 12 } : undefined,
      };
    });
    return { nodes: dots, edges: lines };
  }, [course, centres, degree, links, prerequisiteEdgeIds, focusId, chain, selected?.id, isVisible, filtering, inRelatedContext, focusIds]);

  const fitAll = useCallback((duration = 300) => {
    void flow.current?.fitView({ padding: 0.18, maxZoom: 1.4, duration });
  }, []);
  const focusSelected = useCallback((duration = 300) => {
    const target = selected?.id ?? course.route?.next_node_id ?? course.nodes[0]?.id;
    const at = target ? centres.get(target) : undefined;
    if (!flow.current || !at) return;
    const next = Math.min(Math.max(flow.current.getZoom(), 1.3), 2);
    void flow.current.setCenter(at.x, at.y, { zoom: next, duration });
  }, [selected?.id, course.route?.next_node_id, course.nodes, centres]);

  // Follow selections made outside the graph (search, learning path) without jumping on every click.
  useEffect(() => {
    if (clickedInside.current) { clickedInside.current = false; return; }
    if (flow.current && selected) focusSelected();
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flow.current) return;
    if (!filtering) { requestAnimationFrame(() => fitAll()); return; }
    const ids = course.nodes.filter((n) => inRelatedContext(n.id)).map((n) => ({ id: n.id }));
    requestAnimationFrame(() => void flow.current?.fitView({ nodes: ids, padding: 0.2, maxZoom: 1.6, duration: 300 }));
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
  const labelMode = alwaysLabels || zoom >= 1.15 ? "labels-all" : zoom >= 0.75 ? "labels-key" : "labels-none";
  return (
    <div className="map-wrap">
      <div className="graph-tools flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="outline" size="sm" onClick={() => focusSelected()} disabled={!selected} title="放大到当前节点">
          <Crosshair /> 定位当前
        </Button>
        <Button variant="outline" size="sm" onClick={() => fitAll()} title="缩放到能看到全部节点">
          <Maximize /> 看全图
        </Button>
        <Button variant="outline" size="sm" className={cn(filtering && "border-zinc-500 bg-accent text-foreground")} aria-pressed={filtering}
          disabled={!selected} onClick={() => setFocusOnly((value) => !value)} title="显示当前先修链及其一跳关系">
          <Focus /> 只看相关
        </Button>
        <Button variant="outline" size="sm" className={cn(alwaysLabels && "border-zinc-500 bg-accent text-foreground")} aria-pressed={alwaysLabels}
          onClick={() => setAlwaysLabels((value) => !value)} title="缩小时也显示全部名称">
          <Tags /> 显示名称
        </Button>
        {selected && (
          <span className="graph-focus-note ml-auto flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden />
            <span><b className="up">{selectedChain.up.size}</b> 个先修 · <b className="down">{selectedChain.down.size}</b> 个后续</span>
          </span>
        )}
      </div>
      <div className={`map-canvas graph-canvas ${labelMode} ${focusId ? "has-focus" : ""}`}>
        <ReactFlow
          key={`${course.id}:${directWeek ?? ""}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={0.3}
          maxZoom={3}
          onInit={(instance) => { flow.current = instance; requestAnimationFrame(() => fitAll(0)); }}
          onMove={(_, viewport) => setZoom((current) => Math.abs(current - viewport.zoom) > 0.04 ? viewport.zoom : current)}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(undefined)}
          onNodeClick={(_, node) => {
            const found = course.nodes.find((n) => n.id === node.id);
            if (found && isVisible(found)) { clickedInside.current = true; onSelect(found); }
          }}
          onEdgeClick={(_, edge) => {
            const found = links.find((item) => item.id === edge.id);
            const source = found && course.nodes.find((item) => item.id === found.source);
            const target = found && course.nodes.find((item) => item.id === found.target);
            if (found && source && target && isVisible(source) && isVisible(target)) onRelationSelect?.(found);
          }}
          proOptions={{ hideAttribution: false }}
        >
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </div>
  );
}
