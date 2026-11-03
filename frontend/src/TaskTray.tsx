import * as React from "react";
import { AlertCircle, ChevronDown, CircleCheck, CircleHelp, FileQuestion, History, Inbox, ListChecks, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { AiTask, TaskView } from "./aiTaskModel";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { TaskCard } from "./TaskCard";
import { Callout } from "./components/ui/callout";
import "./taskUi.css";

type TaskTrayProps = {
  /** The page header pairs it with outlined buttons; the workbench toolbar with ghost ones. */
  variant?: "outline" | "ghost";
  tasks: AiTask[];
  viewFor: (task: AiTask) => TaskView;
  loading: boolean;
  error: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<unknown>;
  onRecover: (task: AiTask) => Promise<unknown>;
  onRegenerate: (task: AiTask) => Promise<unknown>;
  onCollect: (task: AiTask) => Promise<AiTask>;
  onOrganize: (task: AiTask) => Promise<AiTask>;
  onReadResult: (task: AiTask) => Promise<unknown>;
  onImportHistory: () => Promise<unknown>;
  importingHistory: boolean;
  importMessage: string;
  onNavigate: (task: AiTask) => void;
  /** "attention" lists only tasks that need the user, as opened from the page reminder. */
  filter?: "all" | "attention";
  onShowAll?: () => void;
};

type TaskNoticeProps = {
  tasks: AiTask[];
  viewFor: (task: AiTask) => TaskView;
  onNavigate: (task: AiTask) => void;
  onViewAll: () => void;
  onDismiss: () => void;
};

const groups = [
  { id: "attention", title: "需要处理" },
  { id: "active", title: "进行中" },
  { id: "applied", title: "已写入" },
  { id: "superseded", title: "已取代" },
  { id: "history", title: "历史原文" },
] as const;

function renderTaskIcon(view: TaskView) {
  const className = `task-tray-row-icon task-icon-${view.semantic}`;
  if (view.semantic === "received") return <Inbox className={className} aria-hidden="true" />;
  if (view.semantic === "applied") return <CircleCheck className={className} aria-hidden="true" />;
  if (view.semantic === "superseded") return <History className={className} aria-hidden="true" />;
  if (view.semantic === "failed") return <AlertCircle className={className} aria-hidden="true" />;
  if (view.semantic === "unknown" || view.semantic === "missing") return <FileQuestion className={className} aria-hidden="true" />;
  if (view.semantic === "offline") return <WifiOff className={className} aria-hidden="true" />;
  if (view.group === "active") return <LoaderCircle className={className} aria-hidden="true" />;
  return <CircleHelp className={className} aria-hidden="true" />;
}

function getTaskGroups(tasks: AiTask[], viewFor: (task: AiTask) => TaskView) {
  return groups.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => viewFor(task).group === group.id),
  })).filter((group) => group.tasks.length > 0);
}

function TaskRow({ view, expanded, onNavigate, onToggle }: {
  view: TaskView;
  expanded: boolean;
  onNavigate: () => void;
  onToggle: () => void;
}) {
  return (
    <div className={`task-tray-row${view.group === "attention" ? " task-tray-row-attention" : ""}`}>
      <button type="button" className="task-tray-row-main" onClick={view.group === "history" ? onToggle : onNavigate} aria-label={view.group === "history" ? `查看历史原文：${view.title}` : `打开任务：${view.title}`}>
        {renderTaskIcon(view)}
        <span className="task-tray-row-copy">
          <strong title={view.title}>{view.title}</strong>
          <small>{view.description || view.shortLabel}</small>
        </span>
        <time>{view.time}</time>
      </button>
      <Button size="icon-sm" variant="ghost" aria-label={expanded?'收起任务操作':'展开任务操作'} aria-expanded={expanded} onClick={onToggle}><ChevronDown /></Button>
    </div>
  );
}

function TaskList({ tasks, viewFor, loading, onRefresh, onRecover, onRegenerate, onCollect, onOrganize, onReadResult, onNavigate }: TaskTrayProps) {
  const [visibleCount, setVisibleCount] = React.useState(20);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  // Archived history is reference material and piles up; keep it folded so live work stays on top.
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const historyCount = tasks.filter((task) => viewFor(task).group === "history").length;
  const pool = historyOpen ? tasks : tasks.filter((task) => viewFor(task).group !== "history");
  const visibleTasks = pool.slice(0, visibleCount);

  if (!tasks.length) return <div className="task-tray-empty"><ListChecks aria-hidden="true" />这门课还没有 AI 任务。</div>;

  const totalGroups = getTaskGroups(visibleTasks, viewFor);
  if (!historyOpen && historyCount) totalGroups.push({ ...groups[groups.length - 1], tasks: [] });
  return (
    <div className="task-tray-list" aria-busy={loading}>
      {totalGroups.map((group) => (
        <section key={group.id} aria-label={`${group.title} · ${tasks.filter(task=>viewFor(task).group===group.id).length}`}>
          {group.id === "history"
            ? <h3 className="task-tray-group-heading"><button type="button" className="task-tray-group-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{group.title} · {historyCount}<ChevronDown aria-hidden="true" /></button></h3>
            : <h3 className="task-tray-group-heading">{group.title} · {tasks.filter(task=>viewFor(task).group===group.id).length}</h3>}
          {group.tasks.map((task) => {
            const view = viewFor(task);
            const id = task.id;
            return <React.Fragment key={id}>
              <TaskRow view={view} expanded={expandedId === id} onNavigate={() => onNavigate(task)} onToggle={() => setExpandedId(expandedId===id?null:id)} />
              {expandedId === id && <div className="task-tray-expanded"><TaskCard task={task} view={view} onRefresh={() => onRefresh()} onRecover={() => onRecover(task)} onRegenerate={() => onRegenerate(task)} onCollect={() => onCollect(task)} onOrganize={() => onOrganize(task)} onReadResult={() => onReadResult(task)} onOpen={() => onNavigate(task)} onNewTask={(requestId) => {
                const replacement = tasks.find((candidate) => candidate.request_id === requestId);
                if (replacement) onNavigate(replacement);
              }} /></div>}
            </React.Fragment>;
          })}
        </section>
      ))}
      {pool.length > visibleCount && <div className="task-tray-load-more"><Button size="sm" variant="ghost" onClick={() => setVisibleCount((count) => count + 20)}>加载更早的任务</Button></div>}
      {pool.length <= visibleCount && (historyOpen || !historyCount) && <div className="task-tray-all-shown">已显示全部 {tasks.length} 条</div>}
    </div>
  );
}

export function TaskTray(props: TaskTrayProps) {
  const activeCount = props.tasks.filter((task) => props.viewFor(task).group === "active").length;
  const attentionCount = props.tasks.filter((task) => props.viewFor(task).group === "attention").length;
  const countParts = [activeCount ? `${activeCount} 个进行中` : "", attentionCount ? `${attentionCount} 个需要处理` : ""].filter(Boolean);
  const ariaLabel = `AI 任务${countParts.length ? `，${countParts.join("，")}` : ""}`;
  const attentionOnly = props.filter === "attention";
  const listed = attentionOnly ? props.tasks.filter((task) => props.viewFor(task).group === "attention") : props.tasks;

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={props.variant ?? "ghost"} className="task-tray-trigger" aria-label={ariaLabel}>
          <ListChecks aria-hidden="true" /><span className="task-tray-trigger-label">AI 任务</span>
          {(activeCount > 0 || attentionCount > 0) && <span className={`task-tray-badge${attentionCount ? " task-tray-badge-attention" : ""}`}>{attentionCount ? "!" : activeCount > 9 ? "9+" : activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="task-tray-popover">
        <span className="task-tray-grabber" aria-hidden="true" />
        {attentionOnly
          ? <header className="task-tray-header"><strong>AI 任务 · 需要处理</strong><span>{listed.length} 条</span><Button size="sm" variant="ghost" onClick={props.onShowAll}>显示全部记录</Button></header>
          : <header className="task-tray-header"><strong>AI 任务</strong><span>本课程 · 共 {props.tasks.length} 条</span><Button size="sm" variant="outline" disabled={props.importingHistory} onClick={() => void props.onImportHistory()}>{props.importingHistory ? "正在查找…" : "查找本机历史"}</Button></header>}
        {props.importMessage && !attentionOnly && <p className="task-history-import-status" role="status">{props.importMessage}</p>}
        {props.error && <div className="task-tray-error"><WifiOff aria-hidden="true" />无法读取任务记录。<Button size="sm" variant="ghost" onClick={() => void props.onRefresh()}><RefreshCw />刷新状态</Button></div>}
        <div className="task-tray-scroll" aria-busy={props.loading}>
          {props.loading && !props.tasks.length ? <div className="task-tray-skeleton" aria-label="正在加载任务">{[0, 1, 2].map((row) => <div key={row}><i /><i /></div>)}</div> : <TaskList key={props.filter} {...props} tasks={listed} />}
        </div>
        {props.loading && props.tasks.length > 0 && <span className="task-tray-sr-only" role="status">正在刷新任务记录…</span>}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The only page-level task message: tasks that need the user and are not already showing in their own place on screen.
 * Running tasks never appear here; their progress shows where they were started and as the badge on AI 任务.
 */
export function TaskNotice({ tasks, viewFor, onNavigate, onViewAll, onDismiss }: TaskNoticeProps) {
  // "unverified" means saved but not checkable against a single object; nothing for the user to do, so it stays in the tray only.
  const pending = tasks.filter((task) => !task.history_only && task.kind !== "history" && viewFor(task).group === "attention" && viewFor(task).semantic !== "unverified");
  if (!pending.length) return null;
  if (pending.length === 1) {
    const view = viewFor(pending[0]);
    return <Callout tone="attention" icon={<ListChecks />} title={view.title} dismissLabel="关闭提示" onDismiss={onDismiss}
      actions={<Button size="sm" variant="outline" onClick={() => onNavigate(pending[0])}>去处理</Button>}>
      {view.error || view.description}
    </Callout>;
  }
  return <Callout tone="attention" icon={<ListChecks />} title={`${pending.length} 个 AI 任务需要处理`} dismissLabel="关闭提示" onDismiss={onDismiss}
    actions={<Button size="sm" variant="outline" onClick={onViewAll}>查看</Button>}>
    {pending.slice(0, 3).map((task) => viewFor(task).description).join(" · ")}{pending.length > 3 ? " …" : ""}
  </Callout>;
}

