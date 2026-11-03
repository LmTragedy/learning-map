import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BaseEdge,
  Controls,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
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
import { isRelationVisible } from "./relationVisibility";
import { edgeLabel, STRENGTH_LABEL } from "./bridges";
import { lineColor, linesByNode, lineSegments } from "./lines";
import { isNodeVisible } from "./nodeVisibility";

type Tone = "passed" | "mastered" | "studied" | "available" | "locked";
type Role = "focus" | "up" | "down" | "dim" | "none";
type DotData = {
  title: string; tone: Tone; role: Role; selected: boolean; next: boolean; radius: number; hint: string;
  /** Colour of the first main line the node is on; transfer stations sit on two or more. */
  line?: string; transfer: boolean;
};
type LinkData = { label: string; title: string; color: string; weak: boolean; onOpen?: () => void };
/** The bridge label follows the pointer while it rests on a line, so it never sits on the dots. */
type EdgeTip = { id: string; x: number; y: number };

/** Node names stop growing past 100% zoom, so zooming in makes room instead of crowding. */
const labelScale = (zoom: number) => Math.min(1, 1 / zoom);

const toneLabel: Record<Tone, string> = {
  passed: "验收通过", mastered: "自我掌握", studied: "学过", available: "可学习", locked: "未解锁",
};

const DotNode = memo(function DotNode({ data }: NodeProps<Node<DotData>>) {
  const size = data.radius * 2;
  return <div className={`gdot tone-${data.tone} role-${data.role} ${data.selected ? "is-selected" : ""} ${data.next ? "is-next" : ""} ${data.line ? "on-line" : ""} ${data.transfer ? "is-transfer" : ""}`}
    style={{ width: size, height: size, ...(data.line ? { "--line": data.line } as CSSProperties : {}) }} title={data.hint} aria-label={data.title ? `${data.title}，${toneLabel[data.tone]}` : "未解锁知识点"}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <span className="gdot-core" />
    {data.title && <span className="gdot-label">{data.title}</span>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
});

/** A straight link; hovering shows its bridge label, clicking opens the bridge detail. */
const BridgeEdge = memo(function BridgeEdge({ sourceX, sourceY, targetX, targetY, style, markerEnd }: EdgeProps<Edge<LinkData>>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} interactionWidth={24} />;
});

const nodeTypes = { dot: DotNode };
const edgeTypes = { bridge: BridgeEdge };
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
  hintIds,
  onOpenLine,
  legend,
}: {
  course: Course;
  /** Sits with the graph tools on the canvas, so it costs no row of its own. */
  legend?: ReactNode;
  selected?: LearningNode;
  directEntryId?: string;
  directWeek?: string;
  reviewActive?: boolean;
  reviewStrict?: boolean;
  prerequisiteNodes?: LearningNode[];
  focusIds?: string[];
  hintIds?: string[];
  onOpenLine?: (lineId: string) => void;
  onSelect: (node: LearningNode) => void;
  onRelationSelect?: (edge: Course["edges"][number]) => void;
}) {
  const flow = useRef<ReactFlowInstance<GraphNode, Edge<LinkData>>>();
  const clickedInside = useRef(false);
  const [hovered, setHovered] = useState<string>();
  const [focusOnly, setFocusOnly] = useState(false);
  const [alwaysLabels, setAlwaysLabels] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tip, setTip] = useState<EdgeTip>();
  const canvasRef = useRef<HTMLDivElement>(null);
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

  const stationLines = useMemo(() => linesByNode(course), [course]);
  const segments = useMemo(() => lineSegments(course), [course]);
  const transfers = useMemo(() => new Set(course.transfers || []), [course.transfers]);
  const overview = zoom < 0.65 && Boolean(course.lines?.length) && !focusOnly && !focusIds;
  const overviewStops = useMemo(() => new Set([
    ...(course.transfers || []),
    ...(course.lines || []).flatMap((line) => [line.node_ids[0], line.node_ids.at(-1)]).filter((id): id is string => Boolean(id)),
  ]), [course.lines, course.transfers]);

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
      const transfer = transfers.has(n.id);
      const radius = Math.round(5 + Math.sqrt(degree.get(n.id) ?? 0) * 2.4) + (transfer ? 3 : 0);
      const onLines = stationLines.get(n.id) || [];
      const centre = centres.get(n.id)!;
      const missing = n.prerequisites.map((id) => byId.get(id)).filter((p): p is LearningNode => Boolean(p) && !isDone(p!));
      return {
        id: n.id,
        type: "dot",
        position: { x: centre.x - radius, y: centre.y - radius },
        width: radius * 2,
        height: radius * 2,
        hidden: (filtering && !inRelatedContext(n.id)) || (overview && !overviewStops.has(n.id)),
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
          line: onLines[0] ? lineColor(onLines[0]) : undefined,
          transfer,
          hint: visible
            ? `${n.title} · ${toneLabel[tone]}${onLines.length ? ` · ${onLines.map((line) => line.name).join(" / ")}${transfer ? "（换乘站）" : ""}` : ""}${n.personal_note?.trim() ? " · 有笔记" : ""}`
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
    const lines: Edge<LinkData>[] = links.map((edge) => {
      // A bridge a failed practice blamed stays red until it is checked again.
      const weak = (edge.bridges || []).some((bridge) => bridge.state?.result === "missing");
      const role = weak ? "weak" : edgeRole(edge);
      const lit = role !== "none" && role !== "dim";
      const line = segments.get(`${edge.source}>${edge.target}`);
      const onGoal = Boolean(focusIds?.includes(edge.source) && focusIds.includes(edge.target));
      // Without an explicit goal focus, quietly outline the selected node's goal route.
      const hinted = !focusIds && role === "none" && Boolean(hintIds?.includes(edge.source) && hintIds.includes(edge.target));
      const color = weak ? "#f87171" : onGoal || hinted ? "#fbbf24" : role === "up" ? "#fbbf24" : role === "down" ? "#60a5fa" : line ? lineColor(line) : "#52525b";
      // Solid = a required bridge; dashed = only suggested or extension bridges.
      const optional = edge.strength ? edge.strength !== "required" : edge.kind !== "用到";
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const readable = Boolean(source && target && isVisible(source) && isVisible(target));
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "bridge",
        className: "relationship-edge",
        selectable: false,
        focusable: true,
        hidden: filtering && !(inRelatedContext(edge.source) && inRelatedContext(edge.target)),
        ariaLabel: edgeLabel(course, edge),
        data: {
          label: edgeLabel(course, edge),
          title: `${edgeLabel(course, edge)}${edge.strength ? ` · ${STRENGTH_LABEL[edge.strength]}` : ""} · 点击看知识桥`,
          color, weak,
          onOpen: readable ? () => onRelationSelect?.(edge) : undefined,
        },
        style: {
          stroke: color,
          strokeWidth: onGoal ? 3 : hinted ? 2 : lit ? 1.8 : line ? 2.4 : 1,
          opacity: focusIds && !onGoal ? 0.06 : onGoal ? 1 : hinted ? 0.6 : role === "dim" ? 0.06 : role === "none" ? (line ? 0.75 : edge.uncertain && !edge.confirmed ? 0.25 : 0.38) : 0.9,
          strokeDasharray: optional ? "4 3" : undefined,
        },
        markerEnd: lit ? { type: "arrowclosed", color, width: 12, height: 12 } : undefined,
      };
    });
    if (overview) {
      const overviewEdges: Edge<LinkData>[] = [];
      for (const mainLine of course.lines || []) {
        const stops = mainLine.node_ids.filter((id) => byId.has(id) && overviewStops.has(id));
        stops.slice(0, -1).forEach((id, index) => overviewEdges.push({
          id: `overview:${mainLine.id}:${index}`, source: id, target: stops[index + 1], type: "bridge",
          style: { stroke: lineColor(mainLine), strokeWidth: 4, opacity: 0.85 },
          data: { label: mainLine.name, title: mainLine.goal, color: lineColor(mainLine), weak: false,
            onOpen: () => onOpenLine?.(mainLine.id) },
        }));
      }
      return { nodes: dots, edges: overviewEdges };
    }

    return { nodes: dots, edges: lines };
  }, [course, centres, degree, links, prerequisiteEdgeIds, focusId, chain, selected?.id, isVisible, filtering, inRelatedContext, focusIds, hintIds,
    stationLines, segments, transfers, onRelationSelect, overview, overviewStops, onOpenLine]);

  // A small course fills its canvas instead of sitting as a cluster in the middle.
  const fitAll = useCallback((duration = 300) => {
    void flow.current?.fitView({ padding: 0.2, maxZoom: 2.2, duration });
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

  // Refit when the canvas changes size (list or workbench opened, window resized), unless a view is filtered.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - last) < 40) return;
      last = el.clientWidth;
      if (!filtering) fitAll(0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [filtering, fitAll, course.nodes.length]);

  if (!course.nodes.length)
    return (
      <div className="map-empty">
        <div className="empty-orbit">⌘</div>
        <h2>地图还没有知识节点</h2>
        <p>导入课程材料后生成地图，或先开始整理学习主题。</p>
        <span>所有节点与进度均由本地学习记录生成</span>
      </div>
    );
  const labelMode = overview || alwaysLabels || zoom >= 1.15 ? "labels-all" : zoom >= 0.75 ? "labels-key" : "labels-none";
  return (
    <div className="map-wrap">
      <div className={`map-canvas graph-canvas ${labelMode} ${focusId ? "has-focus" : ""}`} ref={canvasRef} style={{ "--label-scale": labelScale(zoom) } as CSSProperties}>
        {/* Canvas tools float on the graph like a map's controls instead of taking a row above it. */}
        <div className="graph-overlay" role="toolbar" aria-label="图工具">
          <div className="graph-tools">
            <Button variant="ghost" size="sm" onClick={() => focusSelected()} disabled={!selected} aria-label="定位当前" title="定位当前：放大到当前节点">
              <Crosshair /><span className="graph-tool-label">定位当前</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => fitAll()} aria-label="看全图" title="看全图：缩放到能看到全部节点">
              <Maximize /><span className="graph-tool-label">看全图</span>
            </Button>
            <span className="graph-tools-sep" aria-hidden />
            <Button variant="ghost" size="sm" className={cn(filtering && "bg-accent text-foreground")} aria-pressed={filtering}
              disabled={!selected} onClick={() => setFocusOnly((value) => !value)} aria-label="只看相关" title="只看相关：显示当前先修链及其一跳关系">
              <Focus /><span className="graph-tool-label">只看相关</span>
            </Button>
            <Button variant="ghost" size="sm" className={cn(alwaysLabels && "bg-accent text-foreground")} aria-pressed={alwaysLabels}
              onClick={() => setAlwaysLabels((value) => !value)} aria-label="显示名称" title="显示名称：缩小时也显示全部名称">
              <Tags /><span className="graph-tool-label">显示名称</span>
            </Button>
            {legend && <><span className="graph-tools-sep" aria-hidden />{legend}</>}
          </div>
          {overview && <div className="flex max-w-full flex-wrap gap-2" aria-label="整体视图主线">
            <span className="graph-chip">整体视图 · 主线与换乘站（放大返回知识点）</span>
            {(course.lines || []).map((line) => <Button key={line.id} size="sm" variant="outline" className="bg-card" onClick={() => onOpenLine?.(line.id)}>
              <i className="h-1 w-5 rounded" style={{ background: lineColor(line) }} />{line.name}
            </Button>)}
          </div>}
        </div>
        {selected && (
          <span className="graph-focus-note graph-chip">
            <Sparkles className="size-3.5" aria-hidden />
            <span><b className="up">{selectedChain.up.size}</b> 个先修 · <b className="down">{selectedChain.down.size}</b> 个后续</span>
          </span>
        )}
        <ReactFlow
          key={`${course.id}:${directWeek ?? ""}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
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
          onEdgeMouseMove={(event, edge) => {
            const box = canvasRef.current?.getBoundingClientRect();
            if (box && edge.data?.onOpen) setTip({ id: edge.id, x: event.clientX - box.left, y: event.clientY - box.top });
          }}
          onEdgeMouseLeave={() => setTip(undefined)}
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
        {tip && (() => {
          const edge = edges.find((item) => item.id === tip.id);
          // Centred above the pointer, then kept inside the canvas once its width is known.
          const clamp = (el: HTMLDivElement | null) => {
            const width = canvasRef.current?.clientWidth;
            if (!el || !width) return;
            el.style.left = `${Math.max(8, Math.min(tip.x - el.offsetWidth / 2, width - el.offsetWidth - 8))}px`;
          };
          return edge?.data && <div ref={clamp} className={`gedge-tip ${edge.data.weak ? "is-weak" : ""}`} role="tooltip"
            style={{ left: tip.x, top: tip.y, borderColor: edge.data.color }}>{edge.data.title}</div>;
        })()}
      </div>
    </div>
  );
}
