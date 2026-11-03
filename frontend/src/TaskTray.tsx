import * as React from "react";
import { AlertCircle, ChevronDown, CircleCheck, CircleHelp, FileQuestion, History, Inbox, ListChecks, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import type { AiTask, TaskView } from "./aiTaskModel";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { TaskCard } from "./TaskCard";
import { Callout } from "./components/ui/callout";
import "./taskUi.css";

type TaskTrayProps = {
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
};

type TaskNoticeProps = TaskTrayProps & {
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

function TaskList({ tasks, viewFor, loading, onRefresh, onRecover, onRegenerate, onCollect, onOrganize, onReadResult, onNavigate, compact = false }: TaskTrayProps & { compact?: boolean }) {
  const [visibleCount, setVisibleCount] = React.useState(20);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  // Archived history is reference material and piles up; keep it folded so live work stays on top.
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const visibleTasks = tasks.slice(0, visibleCount);

  if (!tasks.length) return <div className="task-tray-empty"><ListChecks aria-hidden="true" />这门课还没有 AI 任务。</div>;

  const totalGroups = getTaskGroups(visibleTasks, viewFor);
  return (
    <div className="task-tray-list" aria-busy={loading}>
      {totalGroups.map((group) => (
        <section key={group.id} aria-label={`${group.title} · ${tasks.filter(task=>viewFor(task).group===group.id).length}`}>
          {group.id === "history"
            ? <h3 className="task-tray-group-heading"><button type="button" className="task-tray-group-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{group.title} · {tasks.filter(task=>viewFor(task).group===group.id).length}<ChevronDown aria-hidden="true" /></button></h3>
            : <h3 className="task-tray-group-heading">{group.title} · {tasks.filter(task=>viewFor(task).group===group.id).length}</h3>}
          {(group.id !== "history" || historyOpen) && group.tasks.map((task) => {
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
      {!compact && tasks.length > visibleCount && <div className="task-tray-load-more"><Button size="sm" variant="ghost" onClick={() => setVisibleCount((count) => count + 20)}>加载更早的任务</Button></div>}
      {!compact && tasks.length <= visibleCount && <div className="task-tray-all-shown">已显示全部 {tasks.length} 条</div>}
    </div>
  );
}

export function TaskTray(props: TaskTrayProps) {
  const activeCount = props.tasks.filter((task) => props.viewFor(task).group === "active").length;
  const attentionCount = props.tasks.filter((task) => props.viewFor(task).group === "attention").length;
  const countParts = [activeCount ? `${activeCount} 个进行中` : "", attentionCount ? `${attentionCount} 个需要处理` : ""].filter(Boolean);
  const ariaLabel = `AI 任务${countParts.length ? `，${countParts.join("，")}` : ""}`;

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="task-tray-trigger" aria-label={ariaLabel}>
          <ListChecks aria-hidden="true" /><span className="task-tray-trigger-label">AI 任务</span>
          {(activeCount > 0 || attentionCount > 0) && <span className={`task-tray-badge${attentionCount ? " task-tray-badge-attention" : ""}`}>{attentionCount ? "!" : activeCount > 9 ? "9+" : activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="task-tray-popover">
        <span className="task-tray-grabber" aria-hidden="true" />
        <header className="task-tray-header"><strong>AI 任务</strong><span>本课程 · 共 {props.tasks.length} 条</span><Button size="sm" variant="outline" disabled={props.importingHistory} onClick={() => void props.onImportHistory()}>{props.importingHistory ? "正在查找…" : "查找本机历史"}</Button></header>
        {props.importMessage && <p className="task-history-import-status" role="status">{props.importMessage}</p>}
        {props.error && <div className="task-tray-error"><WifiOff aria-hidden="true" />无法读取任务记录。<Button size="sm" variant="ghost" onClick={() => void props.onRefresh()}><RefreshCw />刷新状态</Button></div>}
        <div className="task-tray-scroll" aria-busy={props.loading}>
          {props.loading && !props.tasks.length ? <div className="task-tray-skeleton" aria-label="正在加载任务">{[0, 1, 2].map((row) => <div key={row}><i /><i /></div>)}</div> : <TaskList {...props} />}
        </div>
        {props.loading && props.tasks.length > 0 && <span className="task-tray-sr-only" role="status">正在刷新任务记录…</span>}
      </PopoverContent>
    </Popover>
  );
}

export function TaskNotice(props: TaskNoticeProps) {
  const { tasks, viewFor, onDismiss } = props;
  const [expanded, setExpanded] = React.useState(false);
  const visibleTasks = tasks.filter((task) => !task.history_only && task.kind !== "history");
  const counts = visibleTasks.reduce((summary, task) => {
    const semantic = viewFor(task).semantic;
    if (semantic === "prepared" || semantic === "running" || semantic === "processing" || semantic === "recovering") summary.active += 1;
    if (semantic === "received") summary.received += 1;
    if (semantic === "conflict") summary.conflict += 1;
    if (semantic === "unknown") summary.unknown += 1;
    if (semantic === "failed") summary.failed += 1;
    if(semantic==='unverified')summary.unverified+=1;
    return summary;
  }, { active: 0, received: 0, conflict: 0, unknown: 0, failed: 0, unverified:0 });
  const reviewCount = counts.received + counts.conflict + counts.unknown + counts.failed+counts.unverified;
  if (!reviewCount && !counts.active) return null;

  const details = [
    counts.active ? `${counts.active} 个仍在进行` : "",
    counts.received ? `${counts.received} 个已回复未写入` : "",
    counts.conflict ? `${counts.conflict} 个未写入` : "",
    counts.unknown ? `${counts.unknown} 个中断` : "",
    counts.failed ? `${counts.failed} 个失败` : "",
    counts.unverified ? `${counts.unverified} 个当前版本待核对` : '',
  ].filter(Boolean).join("，");

  // 查看 expands in place: the tasks this notice counts open right under it, not in a popover in the far corner.
  const noticeTasks = visibleTasks.filter((task) => { const group = viewFor(task).group; return group === "active" || group === "attention"; });
  return <div className={`task-notice${expanded ? " task-notice-open" : ""}`}>
    <Callout tone={reviewCount ? "attention" : "neutral"} icon={<ListChecks />} dismissLabel="关闭提示" onDismiss={onDismiss}
      actions={<Button size="sm" variant="outline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "查看"}<ChevronDown className="task-notice-chevron" /></Button>}>
      {reviewCount ? `有 ${reviewCount + counts.active} 个 AI 任务需要查看：${details}。` : `有 ${counts.active} 个 AI 任务仍在进行。`}
    </Callout>
    {expanded && <div className="task-notice-panel">
      <TaskList {...props} tasks={noticeTasks} compact />
      <footer className="task-notice-footer"><Button size="sm" variant="ghost" onClick={() => props.onOpenChange(true)}>全部 AI 任务记录</Button></footer>
    </div>}
  </div>;
}

export default TaskTray;
