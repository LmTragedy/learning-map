import * as React from "react";
import {
  AlertCircle, ArrowRight, CircleCheck, CircleHelp, Download, FileQuestion,
  ChevronDown, GitCompare, History, Inbox, RefreshCw, RotateCcw, WifiOff, X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import type { AiTask, TaskView } from "./aiTaskModel";
import { taskTime } from "./aiTaskModel";
import "./taskUi.css";

type TaskAction = "refresh" | "recover" | "regenerate" | "collect" | "organize" | "result";

type TaskCardProps = {
  task: AiTask;
  view: TaskView;
  onRefresh: () => Promise<unknown>;
  onRecover: () => Promise<unknown>;
  onRegenerate: () => Promise<unknown>;
  onOpen: () => void;
  onCollect?: () => Promise<AiTask>;
  onOrganize?: () => Promise<AiTask>;
  onReadResult?: () => Promise<unknown>;
  onNewTask?: (requestId: string) => void;
  /** Hides this card from the page; the task stays in the AI 任务 tray. */
  onDismiss?: () => void;
};

const statusIcons = {
  prepared: <span className="task-dots task-dots-static" aria-hidden="true"><i /><i /><i /></span>,
  running: <span className="task-dots" aria-hidden="true"><i /><i /><i /></span>,
  processing: <span className="task-dots" aria-hidden="true"><i /><i /><i /></span>,
  received: <Inbox />, unverified: <CircleHelp />, conflict: <GitCompare />, unknown: <CircleHelp />,
  applied: <CircleCheck />, failed: <AlertCircle />, superseded: <History />, history: <History />,
  offline: <WifiOff />, missing: <FileQuestion />, recovering: <span className="task-dots" aria-hidden="true"><i /><i /><i /></span>,
};

function getCardIcon(view: TaskView) {
  return statusIcons[view.semantic];
}

/** Same tones as the page Callout, so a task card reads as one of the page's own messages. */
function cardTone(view: TaskView) {
  if (view.semantic === "failed") return "border-destructive/40 bg-destructive/10";
  if (view.group === "superseded" || view.group === "history" || view.semantic === "offline") return "border-dashed border-border bg-transparent";
  if (view.group === "attention") return "border-st-new/40 bg-st-new/8";
  return "border-border bg-card";
}

function iconTone(view: TaskView) {
  if (view.semantic === "failed") return "text-destructive";
  if (view.group === "attention") return "text-st-new";
  return "text-muted-foreground";
}

function formatSavedObject(savedObject: unknown) {
  if (typeof savedObject === "string") return savedObject;
  try {
    return JSON.stringify(savedObject, null, 2) ?? String(savedObject);
  } catch {
    return String(savedObject);
  }
}

function nativeStatusText(status?: string) {
  if (status === "confirmed") return "已确认";
  if (status === "failed") return "失败";
  return "未验证";
}

function desktopStatusText(status?: string) {
  return status === "confirmed" ? "已核对" : "待在 Codex 桌面核对";
}

export function TaskCard({
  task, view, onRefresh, onRecover, onRegenerate, onOpen,
  onCollect, onOrganize, onReadResult, onNewTask, onDismiss,
}: TaskCardProps) {
  const [confirming, setConfirming] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<TaskAction | null>(null);
  const [actionError, setActionError] = React.useState("");
  const [refreshedTask, setRefreshedTask] = React.useState<AiTask | null>(null);
  const [savedObject, setSavedObject] = React.useState<unknown>();
  const [hasSavedObject, setHasSavedObject] = React.useState(false);
  const [rawExpanded, setRawExpanded] = React.useState(false);
  const [resultExpanded, setResultExpanded] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const displayedTask = refreshedTask ?? task;
  const rawText = displayedTask.raw_reply?.text ?? displayedTask.historical_raw;
  const rawAvailable = view.canViewRaw || Boolean(rawText || displayedTask.has_raw_reply);
  const storedObject = hasSavedObject ? savedObject : displayedTask.result_object;
  const hasStoredObject = hasSavedObject || displayedTask.result_object !== undefined;

  React.useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  React.useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setConfirming(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirming]);

  const runAction = async (action: TaskAction, callback: () => Promise<unknown>) => {
    setBusyAction(action);
    setActionError("");
    try {
      const response = await callback();
      if (action === "collect" && response && typeof response === "object" && "id" in response) {
        setRefreshedTask(response as AiTask);
        setRawExpanded(true);
      }
      if (action === "result" && response && typeof response === "object" && "object" in response) {
        setSavedObject(response.object);
        setHasSavedObject(true);
        setResultExpanded(true);
      }
      if (action === "regenerate") setConfirming(false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setActionError(action === "recover" || action === "collect"
        ? `取回失败：${reason}${reason.includes('不会自动重新生成') ? '' : '。不会自动重新生成。'}`
        : reason);
    } finally {
      setBusyAction(null);
    }
  };

  const refreshButton = view.semantic === "prepared" || view.semantic === "running"
    || view.semantic === "processing" || view.semantic === "offline";
  const showRegenerate = (view.canRegenerate || view.semantic === "recovering") && !view.newRequestId;
  // Raw reply and IDs are for checking a task, not for learning; they stay behind one quiet toggle.
  const showDetails = rawAvailable || hasStoredObject || Boolean(displayedTask.result_ref);
  const detailsOpen = rawExpanded || resultExpanded;
  const organization = displayedTask.organization;
  const checkedAt = organization?.checked_at ? taskTime(organization.checked_at) || organization.checked_at : "未知";

  const busy = busyAction !== null;
  // Some descriptions already carry the time ("回复于 20:12"); never print it twice.
  const meta = [view.description, view.time && !view.description?.includes(view.time) ? view.time : ""].filter(Boolean).join(" · ");
  return (
    <article className={cn("task-card flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 text-left text-sm", cardTone(view))}
      data-task-id={task.id} role="status" aria-live="polite" aria-label={view.title}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", iconTone(view))} aria-hidden="true">{getCardIcon(view)}</span>
        <div className="min-w-0 flex-1">
          <strong className="block font-semibold text-foreground">{view.title}</strong>
          {meta && <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground" title={meta}>{meta}</p>}
          {task.children && task.children.length > 0 && <p className="text-[13px] text-muted-foreground">Luna 子任务：{task.children.filter(child => child.state === 'applied').length} / {task.children.length} 已完成 · 中等推理</p>}
        </div>
        {!confirming && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden">
            {view.canRecover && <Button size="sm" variant="outline" disabled={busy || view.semantic === "recovering"} onClick={() => void runAction("recover", onRecover)}><Download />恢复并应用</Button>}
            {view.canCollect && onCollect && <Button size="sm" variant="outline" disabled={busy} onClick={() => void runAction("collect", onCollect)}><Download />只读取回</Button>}
            {view.canOpen && <Button size="sm" variant="outline" onClick={onOpen}>打开结果<ArrowRight /></Button>}
            {view.newRequestId && <Button size="sm" variant="outline" onClick={() => onNewTask ? onNewTask(view.newRequestId!) : onOpen()}>查看新任务<ArrowRight /></Button>}
            {showRegenerate && <Button size="sm" variant="ghost" disabled={busy || view.semantic === "recovering"} onClick={() => setConfirming(true)}><RotateCcw />重新生成…</Button>}
            {view.canOrganize && onOrganize && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runAction("organize", onOrganize)}><RefreshCw />重试原生归类</Button>}
            {displayedTask.result_ref?.available && !hasStoredObject && onReadResult && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runAction("result", onReadResult)}><FileQuestion />读取已保存对象</Button>}
            {showDetails && <Button size="sm" variant="ghost" className="text-muted-foreground" aria-expanded={detailsOpen} onClick={() => { setRawExpanded(!detailsOpen); if (detailsOpen) setResultExpanded(false); }}>
              {detailsOpen ? "收起原文" : "原文"}<ChevronDown className={cn("transition-transform", detailsOpen && "rotate-180")} />
            </Button>}
          </div>
        )}
        {refreshButton && <Button size="icon-sm" variant="ghost" className="-my-1 shrink-0 text-muted-foreground" aria-label="刷新状态" title="刷新状态" disabled={busy} onClick={() => void runAction("refresh", onRefresh)}><RefreshCw className={busyAction === "refresh" ? "task-refreshing" : undefined} /></Button>}
        {onDismiss && <Button size="icon-sm" variant="ghost" className="-my-1 -mr-1 shrink-0 text-muted-foreground" aria-label="关闭这张卡片（仍可在 AI 任务中查看）" title="关闭（仍可在 AI 任务中查看）" onClick={onDismiss}><X /></Button>}
      </div>
      {(view.error || actionError || displayedTask.organization_error) && <div className="flex flex-col gap-1 pl-7">
        {displayedTask.organization_error && <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-destructive"><AlertCircle className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />原生归类错误：{displayedTask.organization_error}</p>}
        {(view.error || actionError) && <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-destructive"><AlertCircle className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />{actionError || view.error}</p>}
      </div>}
      {view.semantic === "unknown" && !view.canRecover && !view.error && <p className="pl-7 text-[13px] text-muted-foreground">这个任务没有可恢复并应用的回复。</p>}
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/60 px-3 py-2 ml-7">
          <p className="text-[13px] leading-relaxed">会新建一个 AI 任务。原任务和已有结果都会保留；如果原任务之后也写入，两份结果都在。</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void runAction("regenerate", onRegenerate)} disabled={busy}><RotateCcw />确认重新生成</Button>
            <Button ref={cancelRef} size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
          </div>
        </div>
      )}
      {detailsOpen && <div className="task-inspection ml-7 flex flex-col gap-1.5 border-l border-border pl-3">
        {rawText ? <pre>{rawText}</pre> : <p>当前没有可显示的原始文本。</p>}
        {(displayedTask.result_ref || hasStoredObject) && <>
          <h4>结果引用与保存对象</h4>
          {displayedTask.result_ref && <pre>{formatSavedObject(displayedTask.result_ref)}</pre>}
          {hasStoredObject ? <pre>{formatSavedObject(storedObject)}</pre> : <p>后端已确认保存对象可用；可读取对象后查看。</p>}
        </>}
        <dl className="task-identity-list">
          <dt>任务 ID</dt><dd>{displayedTask.id}</dd>
          <dt>会话 ID</dt><dd>{displayedTask.thread_id || "未取得"}</dd>
          <dt>轮次 ID</dt><dd>{displayedTask.turn_id || "未取得"}</dd>
          {displayedTask.parent_task_id && <><dt>主任务 ID</dt><dd>{displayedTask.parent_task_id}</dd></>}
          {displayedTask.model && <><dt>模型</dt><dd>{displayedTask.model}{displayedTask.effort === 'medium' ? ' · 中等推理' : ''}</dd></>}
          {organization && <>
            <dt>Codex 分区</dt><dd>{nativeStatusText(organization.native_status)}</dd>
            <dt>桌面侧栏</dt><dd>{desktopStatusText(organization.desktop_status)}</dd>
            <dt>最后核对</dt><dd>{checkedAt}（非持续同步）</dd>
          </>}
        </dl>
      </div>}
      {busyAction && <span className="sr-only" role="status">{busyAction === "recover" ? "正在恢复并应用…" : busyAction === "collect" ? "正在只读取回…" : busyAction === "organize" ? "正在重试原生归类…" : busyAction === "result" ? "正在读取保存对象…" : busyAction === "refresh" ? "正在刷新状态…" : "正在创建新任务…"}</span>}
    </article>
  );
}

export default TaskCard;
