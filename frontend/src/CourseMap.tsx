import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, BookOpen, ChevronDown, Info, ListOrdered, Lock, Network, NotebookPen, PanelRight, Sparkles } from "lucide-react";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { MapView } from "./MapView";
import type { PanelLayout, PanelName } from "./panelLayout";
import { useResizableWidth } from "./useResizableWidth";
import { lineColor } from "./lines";
import { isRelationVisible } from "./relationVisibility";
import { statusIcon, statusLabel } from "./status";
import type { Course, LearningNode } from "./types";

type MapProps = {
  course: Course;
  selected?: LearningNode;
  directEntryId?: string;
  directWeek?: string;
  onSelect: (node: LearningNode) => void;
  onRelationSelect?: (edge: Course["edges"][number]) => void;
  reviewActive?: boolean;
  reviewStrict?: boolean;
  prerequisiteNodes?: LearningNode[];
  /** Nodes of the goal in focus; the rest are faded. */
  focusIds?: string[];
  /** Route of the selected node's active goal; outlined without fading anything. */
  hintIds?: string[];
  /** Opens a main line's own panel (its story, retelling and notes). */
  onOpenLine?: (lineId: string) => void;
};

const PANELS: { name: PanelName; label: string; Icon: typeof ListOrdered; hint: string }[] = [
  { name: "list", label: "列表", Icon: ListOrdered, hint: "按学习顺序列出的知识点，和图同步" },
  { name: "map", label: "地图", Icon: Network, hint: "知识关系图" },
  { name: "dock", label: "详情", Icon: PanelRight, hint: "右栏：选中知识点的概览与对话" },
];

/** Show or hide each module of the course screen; the last of list and map cannot be hidden. On a phone, list and map are one choice. */
function LayoutToggles({ layout }: { layout: PanelLayout }) {
  // Pressing the one module that must stay explains why, in text, instead of silently doing nothing.
  const [why, setWhy] = useState("");
  useEffect(() => { if (!why) return; const timer = window.setTimeout(() => setWhy(""), 3000); return () => window.clearTimeout(timer); }, [why]);
  return <><div className="flex items-center gap-0.5 rounded-lg bg-muted p-[3px]" role="group" aria-label="显示的模块">
    {PANELS.map(({ name, label, Icon, hint }) => {
      if (layout.narrow && name === "dock") return null;
      const on = layout[name];
      const locked = !layout.narrow && on && !layout.canHide(name);
      return <Button key={name} size="sm" variant="ghost" aria-pressed={on} aria-disabled={locked || undefined} aria-label={label}
        className={cn("h-7 gap-1.5 px-2.5 text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm", locked && "cursor-default")}
        title={layout.narrow ? hint : locked ? `${hint}（至少保留列表或地图之一）` : `${on ? "隐藏" : "显示"}${label}：${hint}`}
        onClick={() => layout.narrow ? layout.setPhonePane(name as "list" | "map") : locked ? setWhy("列表和地图至少保留一个") : layout.toggle(name)}>
        <Icon /><span className="max-[1439px]:min-[781px]:hidden">{label}</span>
      </Button>;
    })}
  </div>{why && <span role="status" className="text-xs text-muted-foreground">{why}</span>}</>;
}

/**
 * The full relationship graph is the centre; the ordered study list sits beside it and stays in
 * sync: picking a row centres the graph on it, picking a dot scrolls the list to its row.
 * Either can be hidden, and the list can be dragged wider.
 */
export function CourseMap({ toolbar, layout, ...props }: MapProps & { toolbar?: ReactNode; layout: PanelLayout }) {
  const listWidth = useResizableWidth({ key: "learning-map:list-width", min: 220, max: 560, maxShare: 0.32, edge: "right" });
  const filtered = props.directWeek
    ? props.course.nodes.filter((node) => node.week === props.directWeek) : props.course.nodes;
  const visibleIds = new Set(filtered.map((node) => node.id));
  const visibleEdges = props.course.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    && isRelationVisible(props.course, edge, Boolean(props.reviewStrict)));
  const listShown = layout.list && props.course.nodes.length > 0;
  return <>
    {/* One flush plane: this row, the list, the graph and the node dock share their rules and their 48px header line. */}
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2 max-[781px]:flex-wrap max-[781px]:px-3">
      <LayoutToggles layout={layout} />
      {toolbar}
    </div>
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      {listShown && <div className={cn("route-list-panel relative flex shrink-0 flex-col border-r border-border",
          layout.map ? "w-[300px] max-[1279px]:w-[256px]" : "min-w-0 flex-1 border-r-0",
          layout.map && listWidth.width && "min-[781px]:!w-[var(--list-w)]")}
        style={listWidth.width ? { "--list-w": `${listWidth.width}px` } as CSSProperties : undefined}>
        <RouteList {...props} wide={!layout.map} />
        {layout.map && <div className="panel-resizer is-right max-[781px]:hidden" aria-label="调整列表宽度" {...listWidth.handle} />}
      </div>}
      <div className={cn("graph-frame flex min-w-0 flex-1 flex-col", !layout.map && "hidden")}>
        <MapView {...props} course={{ ...props.course, nodes: filtered }}
          legend={<LegendPopover count={filtered.length} edges={visibleEdges} hasLines={Boolean(props.course.lines?.length)} />} />
      </div>
    </div>
  </>;
}

function LegendPopover({ count, edges, hasLines }: { count: number; edges: Course["edges"]; hasLines: boolean }) {
  const pending = edges.filter((edge) => edge.uncertain || !edge.confirmed).length;
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" aria-label="图例" title="图例"><Info /><span className="graph-tool-label">图例</span></Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 text-[13px]">
      <div className="mb-2 text-xs font-medium text-muted-foreground">学习状态</div>
      <div className="flex flex-wrap gap-1.5">
        {(["new", "studied", "mastered", "passed", "locked"] as const).map((key) => {
          const Icon = statusIcon[key];
          return <Badge key={key} variant={key}><Icon aria-hidden />{statusLabel[key]}</Badge>;
        })}
      </div>
      <div className="mb-2 mt-4 text-xs font-medium text-muted-foreground">连线（知识桥）</div>
      <div className="grid gap-1.5 text-muted-foreground">
        <span className="flex items-center gap-2"><i className="h-0.5 w-6 rounded bg-zinc-400" />实线：有必需的桥</span>
        <span className="flex items-center gap-2"><i className="h-0 w-6 border-t border-dashed border-zinc-400" />虚线：只有建议或拓展的桥</span>
        <span className="flex items-center gap-2"><i className="h-0 w-6 border-t-2 border-dashed border-red-400" />红色：练习中暴露的缺口</span>
        {hasLines && <span className="flex items-center gap-2"><i className="h-1 w-6 rounded bg-emerald-400" />彩色粗线：主线；带白圈的大点是换乘站</span>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">放大到能读字时线上显示“类型 · 用到的块”；点标签打开知识桥详情。悬停节点看先修链。</p>
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        {count} 个节点 · {edges.length} 条联系{pending ? ` · ${pending} 条待核对` : ""}。直达只临时显示，不解锁邻区。
      </p>
    </PopoverContent>
  </Popover>;
}

const stateText = {
  new: "text-st-new", studied: "text-st-studied", mastered: "text-st-mastered", passed: "text-st-passed", locked: "text-muted-foreground",
} as const;

type Group = { id: string; title: string; color?: string; subtitle?: string; lineId?: string; node_ids: string[] };

function RouteList({ course, selected, directEntryId, directWeek, onSelect, reviewActive, focusIds, onOpenLine, wide }: MapProps & { wide: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const route = course.route;
  const byId = new Map(course.nodes.map((node) => [node.id, node]));
  const next = byId.get(route?.next_node_id ?? "");
  const transfers = new Set(course.transfers || []);
  const noted = new Set([...course.nodes.filter((node) => node.personal_note?.trim()).map((node) => node.id), ...(course.notes || []).flatMap((note) => note.node_ids)]);
  const lines = course.lines || [];
  const onLine = new Set(lines.flatMap((line) => line.node_ids));
  const groups: Group[] = lines.length
    ? [
        ...lines.map((line) => ({ id: line.id, lineId: line.id, title: line.name, color: lineColor(line), subtitle: line.goal, node_ids: line.node_ids })),
        ...(course.nodes.some((node) => !onLine.has(node.id)) ? [{ id: "off-line", title: "不在主线上的知识点", node_ids: course.nodes.filter((node) => !onLine.has(node.id)).map((node) => node.id) }] : []),
      ]
    : (route?.stages || []).map((stage) => ({ ...stage }));
  const available = (node: LearningNode) => Boolean(reviewActive) || node.unlocked || node.id === directEntryId || Boolean(directWeek && node.week === directWeek);

  // The graph is the centre: whatever gets selected there, the list scrolls to its row.
  useEffect(() => {
    if (!selected) return;
    let scrollFrame = 0;
    // Expand the owning group first, then scroll once that row has rendered.
    const frame = requestAnimationFrame(() => {
      setCollapsed((current) => {
        const next = { ...current };
        for (const group of groups) if (group.node_ids.includes(selected.id)) next[group.id] = false;
        return next;
      });
      scrollFrame = requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-node-id="${selected.id}"]`);
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(scrollFrame); };
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <aside ref={listRef} aria-label="按顺序看"
    className={cn("route-list flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto bg-sidebar/60 px-3 py-3", wide && "mx-auto max-w-3xl bg-transparent p-4")}>
    <div className="flex items-center gap-2 px-1">
      {/* Course progress lives in the page header; the list does not repeat it. */}
      <strong className="t-label flex-1">{lines.length ? `${lines.length} 条主线` : "学习顺序"}</strong>
    </div>
    {/* Hidden while that node is already open: the card would only point at itself. */}
    {next && next.id !== selected?.id && <button onClick={() => onSelect(next)}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40">
      <Sparkles size={15} className="shrink-0 text-st-new" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="t-meta block">建议接着学{route?.next_for_goal ? " · 在你进行中的目标路线上" : ""}</span>
        <strong className="t-item block truncate">{next.title}</strong>
      </span>
      <ArrowRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
    </button>}
    {route?.warning && <p className="rounded-lg border border-st-new/30 bg-st-new/10 px-2.5 py-2 text-xs text-st-new" role="alert">{route.warning}</p>}
    {groups.map((group) => {
      const nodes = group.node_ids.map((id) => byId.get(id)).filter((node): node is LearningNode => Boolean(node) && (!directWeek || node!.week === directWeek));
      if (!nodes.length) return null;
      const done = nodes.filter((node) => node.progress ? node.progress.done : node.status === "passed" || node.status === "mastered").length;
      const open = !(collapsed[group.id] ?? false);
      const hidden = nodes.filter((node) => !available(node)).length;
      return <section key={group.id}>
        <div className="flex items-center gap-1.5 px-1 py-1">
          <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" aria-expanded={open}
            onClick={() => setCollapsed((current) => ({ ...current, [group.id]: open }))}>
            <ChevronDown size={14} className={cn("shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
            {group.color && <i className="h-3 w-1.5 shrink-0 rounded-full" style={{ background: group.color }} />}
            <span className="min-w-0 flex-1">
              <strong className="t-item block truncate">{group.title}</strong>
              {group.subtitle && <span className="t-meta block truncate">{group.subtitle}</span>}
            </span>
          </button>
          <span className="t-meta shrink-0 tabular-nums">{done}/{nodes.length}</span>
          {group.lineId && onOpenLine && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onOpenLine(group.lineId!)}>串讲</Button>}
        </div>
        {open && <ol className={cn("mt-0.5 flex list-none flex-col gap-px", group.color && "route-line")} style={group.color ? { "--line": group.color } as CSSProperties : undefined}>
          {nodes.map((node) => available(node)
            ? <RouteRow key={node.id} node={node} selected={selected?.id === node.id} transfer={transfers.has(node.id)} hasNote={noted.has(node.id)}
                dimmed={Boolean(focusIds && !focusIds.includes(node.id))} onSelect={onSelect} />
            : null)}
          {hidden > 0 && <li className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground"><Lock size={12} aria-hidden /> 另有 {hidden} 个未解锁</li>}
        </ol>}
      </section>;
    })}
  </aside>;
}

function RouteRow({ node, selected, transfer, hasNote, dimmed, onSelect }: {
  node: LearningNode; selected: boolean; transfer: boolean; hasNote: boolean; dimmed: boolean; onSelect: (node: LearningNode) => void;
}) {
  const StatusIcon = statusIcon[node.status];
  return <li data-node-id={node.id}>
    <button onClick={() => onSelect(node)} aria-current={selected ? "step" : undefined}
      className={cn("flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/40",
        selected && "bg-accent text-foreground", dimmed && "opacity-35")}>
      <StatusIcon size={14} className={cn("shrink-0", stateText[node.status])} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{node.title}</span>
      {transfer && <Badge variant="outline" className="px-1.5">换乘</Badge>}
      {hasNote && <NotebookPen size={12} className="shrink-0 text-muted-foreground" aria-label="有笔记" />}
      {!!node.lessons?.length && <BookOpen size={12} className="shrink-0 text-muted-foreground" aria-label="有小课" />}
      <span className="sr-only">{statusLabel[node.status]}</span>
    </button>
  </li>;
}
