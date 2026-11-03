import * as React from "react";
import {
  AlertCircle, ArrowRight, CircleCheck, CircleHelp, Download, FileQuestion,
  GitCompare, History, Inbox, RefreshCw, RotateCcw, WifiOff, X,
} from "lucide-react";
import { Button } from "./components/ui/button";
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

function getCardClass(view: TaskView) {
  if (view.semantic === "failed") return "task-card task-card-failed";
  if (view.semantic === "offline") return "task-card task-card-unknown";
  if (view.group === "attention") return "task-card task-card-attention";
  if (view.group === "superseded") return "task-card task-card-superseded";
  if (view.group === "history") return "task-card task-card-history";
  if (view.semantic === "unknown") return "task-card task-card-unknown";
  return "task-card";
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
  const hasActions = refreshButton || view.canRecover || showRegenerate || view.canOpen
    || Boolean(view.newRequestId) || view.canCollect || view.canOrganize
    || (displayedTask.result_ref?.available && !hasStoredObject);
  const organization = displayedTask.organization;
  const checkedAt = organization?.checked_at ? taskTime(organization.checked_at) || organization.checked_at : "未知";

  return (
    <article className={getCardClass(view)} data-task-id={task.id} role="status" aria-live="polite" aria-label={view.title}>
      <span className={`task-card-icon task-icon-${view.semantic}`} aria-hidden="true">{getCardIcon(view)}</span>
      <div className="task-card-heading">
        <h3 className="task-card-title">{view.title}</h3>
        {view.time && <time className="task-card-time">{view.time}</time>}
        {onDismiss && <Button size="icon-sm" variant="ghost" className="task-card-dismiss" aria-label="关闭这张卡片（仍可在 AI 任务中查看）" title="关闭（仍可在 AI 任务中查看）" onClick={onDismiss}><X /></Button>}
      </div>
      {view.description && <p className="task-card-description" title={view.description}>{view.description}</p>}
      {confirming ? (
        <div className="task-card-confirm">
          <p>会新建一个 AI 任务。原任务和已有结果都会保留；如果原任务之后也写入，两份结果都在。</p>
          <div className="task-card-actions task-card-confirm-actions">
            <Button size="sm" onClick={() => void runAction("regenerate", onRegenerate)} disabled={busyAction !== null}>
              <RotateCcw />确认重新生成
            </Button>
            <Button ref={cancelRef} size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
          </div>
        </div>
      ) : hasActions && (
        <div className="task-card-actions">
          {view.canRecover && <Button size="sm" variant="outline" disabled={busyAction !== null || view.semantic === "recovering"} onClick={() => void runAction("recover", onRecover)}><Download />恢复并应用</Button>}
          {view.canCollect && onCollect && <Button size="sm" variant="outline" disabled={busyAction !== null} onClick={() => void runAction("collect", onCollect)}><Download />只读取回</Button>}
          {refreshButton && <Button size="sm" variant={view.semantic === "offline" ? "outline" : "ghost"} disabled={busyAction !== null} onClick={() => void runAction("refresh", onRefresh)}><RefreshCw className={busyAction === "refresh" ? "task-refreshing" : undefined} />刷新状态</Button>}
          {view.canOpen && <Button size="sm" variant="ghost" onClick={onOpen}>打开课程结果<ArrowRight /></Button>}
          {view.newRequestId && <button type="button" className="task-new-link" onClick={() => onNewTask ? onNewTask(view.newRequestId!) : onOpen()}>已重新生成 → 查看新任务<ArrowRight /></button>}
          {showRegenerate && <Button className="task-regenerate" size="sm" variant="ghost" disabled={busyAction !== null || view.semantic === "recovering"} onClick={() => setConfirming(true)}><RotateCcw />重新生成…</Button>}
          {view.canOrganize && onOrganize && <Button size="sm" variant="ghost" disabled={busyAction !== null} onClick={() => void runAction("organize", onOrganize)}><RefreshCw />重试原生归类</Button>}
          {displayedTask.result_ref?.available && !hasStoredObject && onReadResult && <Button size="sm" variant="ghost" disabled={busyAction !== null} onClick={() => void runAction("result", onReadResult)}><FileQuestion />读取已保存对象</Button>}
        </div>
      )}
      <details open={rawExpanded || resultExpanded} onToggle={(event) => { setRawExpanded(event.currentTarget.open); if (!event.currentTarget.open) setResultExpanded(false); }} className="task-inspection">
        <summary>{rawAvailable ? "详情 · 原文与 ID" : "详情 · ID（原文尚未取回）"}</summary>
        <div className="task-inspection-body">
          <dl className="task-identity-list">
            <dt>任务 ID</dt><dd>{displayedTask.id}</dd>
            <dt>会话 ID</dt><dd>{displayedTask.thread_id || "未取得"}</dd>
            <dt>轮次 ID</dt><dd>{displayedTask.turn_id || "未取得"}</dd>
            {organization && <>
              <dt>Codex 分区</dt><dd>{nativeStatusText(organization.native_status)}</dd>
              <dt>桌面侧栏</dt><dd>{desktopStatusText(organization.desktop_status)}</dd>
              <dt>最后核对</dt><dd>{checkedAt}（非持续同步）</dd>
            </>}
          </dl>
          <h4>原文</h4>
          {rawText ? <pre>{rawText}</pre> : <p>当前没有可显示的原始文本。</p>}
          {(displayedTask.result_ref || hasStoredObject) && <>
            <h4>结果引用与保存对象</h4>
            {displayedTask.result_ref && <pre>{formatSavedObject(displayedTask.result_ref)}</pre>}
            {hasStoredObject ? <pre>{formatSavedObject(storedObject)}</pre> : <p>后端已确认保存对象可用；可读取对象后查看。</p>}
          </>}
        </div>
      </details>
      {displayedTask.organization_error && <p className="task-card-error"><AlertCircle aria-hidden="true" />原生归类错误：{displayedTask.organization_error}</p>}
      {(view.error || actionError) && <p className="task-card-error"><AlertCircle aria-hidden="true" />{actionError || view.error}</p>}
      {view.semantic === "unknown" && !view.canRecover && !view.error && <p className="task-card-hint">这个任务没有可恢复并应用的回复。</p>}
      {busyAction && <span className="task-card-sr-only" role="status">{busyAction === "recover" ? "正在恢复并应用…" : busyAction === "collect" ? "正在只读取回…" : busyAction === "organize" ? "正在重试原生归类…" : busyAction === "result" ? "正在读取保存对象…" : busyAction === "refresh" ? "正在刷新状态…" : "正在创建新任务…"}</span>}
    </article>
  );
}

export default TaskCard;
