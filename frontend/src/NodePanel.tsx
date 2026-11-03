import { useEffect, useRef, useState } from "react";
import { taskLessonId, type AiTask } from './aiTaskModel';
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, ExternalLink, FileText, Info, Layers, NotebookPen, RefreshCw, Shapes, Split, Target, Waypoints } from "lucide-react";
import { api, lessonHtmlUrl, materialFileUrl } from "./api";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { statusIcon } from "./status";
import { PracticePanel } from "./PracticePanel";
import { LessonStudy } from "./LessonPanel";
import { NodeChat } from "./NodeChat";
import { BridgeDetail } from "./BridgeDetail";
import { PersonalNote } from "./PersonalNote";
import { Workbench } from "./workbench/Workbench";
import { BridgeCard } from "./BridgeCard";
import { NodeLinks } from "./NodeLinks";
import { useWorkbenchState } from "./workbench/useWorkbenchState";
import { quoteBlock } from "./noteFormatting";
import { NodeGoals } from "./NodeGoals";
import { goalsForNode } from "./goalContext";
import { useGoalActions } from "./goalActions";
import { nodeBridges } from "./bridges";
import { isNodeVisible } from "./nodeVisibility";
import { splitSummary } from "./summary";
import type { Course, LearningNode } from "./types";

const labels: Record<string, string> = {
  new: "可学习",
  studied: "学过",
  mastered: "自我掌握 · 未经验收",
  passed: "验收通过",
};

/**
 * Three-step mastery bar. It only shows where the node stands; changing the self-reported
 * state is a separate, labelled menu so it can never happen by brushing the bar.
 */
function Progress({ status, busy, onMark }: {
  status: string; busy: boolean; onMark: (status: "new" | "studied" | "mastered") => void;
}) {
  const reached = { new: 0, studied: 1, mastered: 2, passed: 3 }[status] ?? 0;
  const passed = status === "passed";
  const labels = ["学过", "自我掌握", passed ? "验收通过" : "验收"];
  return <div className="mt-3.5 flex items-end gap-2">
    <div className="grid flex-1 grid-cols-3 gap-1" role="img" aria-label={`掌握进度：${reached ? labels[reached - 1] : "未开始"}`}>
      {labels.map((label, index) => <div key={label} className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <span className={cn("h-1 w-full rounded-full bg-control", reached > index && "bg-st-passed")} />
        <span className={cn(reached > index && "text-foreground")}>{label}</span>
      </div>)}
    </div>
    {!passed && <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="-mb-1 h-7 px-2 text-xs" disabled={busy}>更改状态<ChevronDown /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={status === "studied"} onSelect={() => onMark("studied")}>标记为学过</DropdownMenuItem>
        <DropdownMenuItem disabled={status === "mastered"} onSelect={() => onMark("mastered")}>标记为自我掌握（跳过验收）</DropdownMenuItem>
        {status !== "new" && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => onMark("new")}>撤销标记</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}

/** The one thing to do next, worked out from the node's lessons and status. */
function NextStep({ node, onLesson, onPractice }: {
  node: LearningNode; onLesson: (id?: string) => void; onPractice: () => void;
}) {
  const lessons = node.lessons ?? [];
  const unread = lessons.findIndex((lesson) => !lesson.read_at);
  const read = lessons.filter((lesson) => lesson.read_at).length;
  const passed = node.status === "passed";
  const step = passed
    ? { title: "这个知识点已经验收通过", meta: lessons.length ? `${lessons.length} 节小课可以回看` : "可以再做一次验收巩固", action: "复习一下", run: () => onLesson() }
    : !lessons.length
      ? { title: "先看一个小例子", meta: "根据课程材料生成一节小课", action: "开始学习", run: () => onLesson() }
      : unread >= 0
        ? { title: `读小课 ${unread + 1}：${lessons[unread].title}`, meta: read ? `已读 ${read} / ${lessons.length} 节` : "还没读", action: "继续小课", run: () => onLesson(lessons[unread].id) }
        : { title: "做一道验收题", meta: `${lessons.length} 节小课都读过了`, action: "去验收", run: onPractice };
  return <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5">
    <span className="flex items-center gap-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", passed ? "bg-st-passed" : "bg-st-new")} aria-hidden />{passed ? "已通过" : "下一步"}
    </span>
    <div className="min-w-0">
      <p className="text-[length:var(--fs-read)] font-semibold leading-snug">{step.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{step.meta}</p>
    </div>
    <Button className="w-full" variant={passed ? "outline" : "default"} onClick={step.run}>
      {passed ? <><RefreshCw />{step.action}</> : <>{step.action}<ArrowRight /></>}
    </Button>
    {!passed && lessons.length > 0 && <button className="cursor-pointer self-center text-xs text-muted-foreground hover:text-foreground"
      onClick={unread >= 0 ? onPractice : () => onLesson()}>{unread >= 0 ? "已经会了？直接验收" : "回看小课"}</button>}
  </div>;
}

/** One line in the "相关" list; opens in place to show the detail. */
function Related({ icon: Icon, label, value, attention, title, defaultOpen, children }: {
  icon: LucideIcon; label: string; value?: string; attention?: boolean; title?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  return <details className="group border-t border-border first-of-type:border-t-0" open={defaultOpen}>
    <summary className="flex h-10 cursor-pointer list-none items-center gap-3 text-sm text-foreground hover:text-foreground [&::-webkit-details-marker]:hidden" title={title}>
      <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value && <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
        {attention && <span className="size-1.5 rounded-full bg-st-new" aria-hidden />}{value}
      </span>}
      <ChevronRight size={14} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
    </summary>
    <div className="pb-3 pt-1">{children}</div>
  </details>;
}
export function NodePanel({
  course,
  node,
  busy,
  aiEnabled,
  aiAvailable,
  noteReviewModel,
  run,
  onRefresh,
  onRecall,
  onRatingSubmitted,
  reviewActive,
  reviewStrict,
  relation,
  relationReturnAvailable,
  onNavigateNode,
  onReturnToTarget,
  onOpenReview,
  onExitReview,
  onCloseRelation,
  onOpenRelation,
  onOpenGoal,
  onOpenNote,
  directEntryId,
  directWeek,
  initialNote = false,
  initialNoteId = "",
  initialChat = false,
  contentContainer,
  taskNavigation,
}: {
  course: Course;
  node: LearningNode;
  busy: boolean;
  aiEnabled: boolean;
  aiAvailable: boolean;
  noteReviewModel: string;
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void;
  onRecall: () => void;
  /** Hides the right dock; it comes back from the layout toggles. */
  onRatingSubmitted: () => void;
  reviewActive: boolean;
  reviewStrict: boolean;
  relation?: Course["edges"][number];
  relationReturnAvailable: boolean;
  onNavigateNode: (node: LearningNode, edge?: Course["edges"][number]) => void;
  onReturnToTarget: () => void;
  onOpenReview: () => void;
  onExitReview: () => void;
  onCloseRelation: () => void;
  onOpenRelation: (edge: Course["edges"][number]) => void;
  onOpenGoal: (goalId: string) => void;
  onOpenNote: (node: LearningNode, noteId: string) => void;
  directEntryId?: string;
  directWeek?: string;
  initialNote?: boolean;
  initialNoteId?: string;
  initialChat?: boolean;
  contentContainer: HTMLDivElement | null;
  taskNavigation?: {task:AiTask;sequence:number};
}) {
  const [reviewMastered, setReviewMastered] = useState(false);
  const [message, setMessage] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const bench = useWorkbenchState(initialNote, initialNoteId);
  const { noteOpen, noteId, material, pendingAppend, appendToNote, openMaterial } = bench;
  const noteCount = 1 + (course.notes || []).filter((entry) => entry.node_ids.includes(node.id)).length;
  const chatField = useRef<HTMLTextAreaElement>(null);
  const studyLesson = node.lessons?.find((lesson) => lesson.id === bench.lessonId) ?? node.lessons?.at(-1);
  // The panel shows the chat while studying and the overview otherwise; a manual pick holds
  // until the workbench opens or closes.
  const [pick, setPick] = useState<{ view: "overview" | "chat"; study: boolean } | null>(initialChat ? { view: "chat", study: false } : null);
  const view = pick && pick.study === bench.study ? pick.view : bench.study ? "chat" : "overview";
  const showView = (next: "overview" | "chat") => setPick({ view: next, study: bench.study });
  // Questions from the workbench land in the chat draft beside it, ready to edit and send.
  const askInChat = (text: string) => {
    setMessage(text);
    setPick({ view: "chat", study: bench.study });
    requestAnimationFrame(() => chatField.current?.focus());
  };
  useEffect(()=>{
    const task=taskNavigation?.task;
    if(!task||task.target!==node.id)return;
    if(task.kind==='lesson')bench.openLesson(taskLessonId(task,course));
    else if(task.kind==='question'||task.kind==='assessment')bench.openPractice();
    // This explicit cross-panel navigation command synchronizes the selected task with the open view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else if(task.kind==='chat')setPick({view:'chat',study:bench.study});
    // Navigation runs once for an explicit task selection, not on ledger polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[taskNavigation?.sequence,node.id]);
  const studyContext = bench.study && bench.active !== "material"
    ? bench.active === "practice"
      ? <><CircleHelp aria-hidden />正在做练习验收</>
      : studyLesson && <><BookOpen aria-hidden />正在看<b className="truncate">小课 {(node.lessons ?? []).indexOf(studyLesson) + 1} · {studyLesson.title}</b></>
    : material && <><FileText aria-hidden />正在看材料第 {material.page} 页</>;
  const parts = splitSummary(node.summary || "");
  const longSummary = parts.explain.length + parts.check.length > 160;
  const stage = course.route?.stages.find((entry) => entry.node_ids.includes(node.id));
  const materialVariants = (node.material_variants || []).filter((variant) =>
    !reviewStrict || (variant.sources.length > 0 && variant.sources.every((source) => course.review_scope.material_ids.includes(source.material_id))),
  );
  const act = async (key: string, fn: () => Promise<Course>) => {
    const value = await run(key, fn);
    if (value) onRefresh(value);
    return value;
  };
  const sendChat = async () => {
    if (!message.trim()) return;
    const saved = await act("chat", () =>
      api.chat(course.id, node.id, message.trim()),
    );
    if (saved) setMessage("");
  };
  const statusText = node.verification === "review"
    ? "用户确认通过"
    : node.status === "passed" && node.verification === "user_passed"
      ? "用户确认通过"
      : node.status === "passed"
        ? "系统验收通过"
        : !node.unlocked && !reviewActive ? "临时直达 · 未解锁" : labels[node.status];
  const statusKey = (!node.unlocked && !reviewActive && node.status === "new" ? "locked" : node.status) as keyof typeof statusIcon;
  const StatusIcon = statusIcon[statusKey] ?? statusIcon.new;
  const note = (text: string) => <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{text}</p>;
  const body = "text-sm leading-[1.75] text-foreground";
  // One scope notice at a time, most specific first.
  const scopeNotice = reviewStrict
    ? "本次范围的结果单独记录，不改变整门课程的掌握与解锁；“自我掌握”仍适用于整个节点。"
    : reviewActive
      ? Object.values(node.review_archived || {}).some((count) => count > 0)
        ? "此前的全课程记录已保留；当前只显示本复习范围的记录。「找回思路」仍可查看全部原始对话。"
        : "当前仅筛选地图。学习对话与验收沿用整门课程，验收通过会更新课程掌握与解锁。"
      : "";
  const goalEntries = goalsForNode(course, node.id);
  const goalActions = useGoalActions();
  const bridges = nodeBridges(course, node);
  const bridgeCount = bridges.incoming.length + bridges.outgoing.length + bridges.contrasts.length;
  const bridgeGaps = bridges.incoming.filter((item) => item.bridge.state?.result === "missing" || item.bridge.state?.result === "unsure").length;
  return (
    <aside className="node-panel flex min-h-0 flex-1 flex-col">
      {(noteOpen || bench.study || material) && contentContainer && createPortal(
        <Workbench course={course} node={node} material={material} active={bench.active} noteOpen={noteOpen}
          study={bench.study ? {
            downloadUrl: studyLesson && lessonHtmlUrl(course.id, node.id, studyLesson.id),
            lesson: <LessonStudy course={course} node={node} lessonId={bench.lessonId} busy={busy} aiEnabled={aiEnabled} act={act}
              onSelect={bench.selectLesson} onAsk={askInChat} onPractice={bench.openPractice} />,
            practice: <PracticePanel course={course} node={node} busy={busy} aiEnabled={aiEnabled} run={run} onRefresh={onRefresh} onRatingSubmitted={onRatingSubmitted} onNavigate={onNavigateNode} />,
          } : null}
          renderNote={() => <PersonalNote key={`${course.id}:${node.id}:${noteId}`} course={course} node={node} noteId={noteId}
            busy={busy} run={run} onRefresh={onRefresh} embedded pendingAppend={pendingAppend}
            aiEnabled={aiEnabled} aiAvailable={aiAvailable} reviewModel={noteReviewModel}
            onOpenNote={bench.setNoteId} onClose={bench.closeNote} />}
          onActivate={bench.activate} onMaterial={openMaterial} onCloseMaterial={bench.closeMaterial}
          onToggleNote={bench.toggleNote} onCloseAll={bench.closeAll}
          onExcerpt={appendToNote}
          onAsk={askInChat} />,
        contentContainer,
      )}
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="grid flex-1 grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px]" role="tablist" aria-label="右栏视图">
          {(["overview", "chat"] as const).map((entry) => <button key={entry} role="tab" aria-selected={view === entry} onClick={() => showView(entry)}
            className={cn("flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
              view === entry && "bg-background text-foreground shadow-sm")}>
            {entry === "overview" ? "概览" : <>对话{!!node.chats.length && <span className="text-xs tabular-nums text-muted-foreground">{node.chats.length}</span>}</>}
          </button>)}
        </div>
        <div className="-mr-1.5 flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" onClick={onRecall} title="找回思路：回看这个知识点的历史对话" aria-label="找回思路">
            <Clock3 />
          </Button>
          <Button variant="ghost" size="icon-sm" className="relative" aria-pressed={noteOpen} onClick={bench.openNote}
            title={`笔记 · ${noteCount} 份${node.personal_note?.trim() ? "" : "（主笔记为空）"}`} aria-label={`笔记，${noteCount} 份`}>
            <NotebookPen />
            <span className="absolute right-0 top-0 min-w-3.5 rounded-full bg-control px-1 text-[11px] leading-3.5 tabular-nums text-foreground/80" aria-hidden>{noteCount}</span>
          </Button>
        </div>
      </div>
      {view === "chat" ? <NodeChat node={node} busy={busy} aiEnabled={aiEnabled} message={message} fieldRef={chatField}
        context={<><b className="truncate">{node.title}</b>{studyContext && <><span aria-hidden>·</span>{studyContext}</>}</>}
        onMessage={setMessage} onSend={() => void sendChat()}
        onSaveToNote={(text) => appendToNote(quoteBlock(text, "AI 导师 · 学习对话"))} />
      : <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pb-5 pt-4">
        <span className="block truncate text-xs text-muted-foreground">{node.kind === "synthesis" ? "综合节点" : stage ? `${stage.title} · 知识点` : "知识点"}</span>
        <h2 className="t-page mt-1">{node.title}</h2>
        <Progress status={node.status} busy={busy}
          onMark={(status) => void act("mark", () => api.mark(course.id, node.id, status))} />
        {(node.status === "passed" || statusKey === "locked" || node.verification === "review" || (reviewStrict && node.review_verification && node.review_verification !== "none")) &&
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {(node.status === "passed" || statusKey === "locked") && <Badge variant={statusKey}><StatusIcon aria-hidden />{statusText}</Badge>}
            {node.verification === "review" && <Badge variant="warning">待复查</Badge>}
            {reviewStrict && node.review_verification && node.review_verification !== "none" && (
              <Badge variant={node.review_verification === "review" ? "warning" : "passed"}>
                {node.review_verification === "ai_passed"
                  ? "当前资料范围验收通过"
                  : node.review_verification === "user_passed"
                    ? "当前资料范围用户确认"
                    : "当前资料范围待复查"}
              </Badge>
            )}
          </div>}
      </div>
      <div className="flex flex-col gap-5 px-5 pb-6">
        {relationReturnAvailable && <Button variant="outline" size="sm" className="self-start" onClick={onReturnToTarget}>返回原复习目标</Button>}
        {/* A relation opened from the map is its own view; closing it brings the overview back. */}
        {relation ? <BridgeDetail key={`${relation.id}:${course.revision}`} course={course} relation={relation} busy={busy} reviewStrict={reviewStrict} run={run}
          onRefresh={onRefresh} onNavigateNode={onNavigateNode} onClose={onCloseRelation} onOpenReview={onOpenReview} onExitReview={onExitReview} onNote={onOpenNote} />
        : <>
        <div className="flex flex-col gap-1.5">
          {reviewStrict && node.summary
            ? <p className={body}><span className="text-muted-foreground">课程总览（跨材料）：</span>{node.summary}</p>
            : <>
              <p className={cn(body, !summaryOpen && longSummary && "line-clamp-3")}>{parts.explain || "还没有补充说明。"}</p>
              {parts.check && (summaryOpen || !longSummary) && <div className="mt-2">
                <h3 className="t-label mb-1 flex items-center gap-1.5"><Target size={13} className="text-st-passed" aria-hidden /> 验收标准</h3>
                <p className={body}>{parts.check}</p>
              </div>}
              {longSummary && (
                <button className="cursor-pointer self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setSummaryOpen((open) => !open)} aria-expanded={summaryOpen}>
                  {summaryOpen ? "收起" : parts.check ? "展开全文与验收标准" : "展开全文"}
                </button>
              )}
              {parts.note && <p className="t-meta flex items-center gap-1" title={parts.note}><Info size={12} aria-hidden /> 依据提取文本生成，公式和表格未核对原图</p>}
            </>}
        </div>
        {course.suggestions.filter((suggestion) => suggestion.node_id === node.id && !suggestion.accepted).map((suggestion) => (
          <div className="flex items-center gap-3 rounded-xl border border-st-new/30 bg-st-new/5 p-3" key={suggestion.id}>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-st-new">难度调整建议</div>
              <p className="text-sm text-foreground">{suggestionText(suggestion)}</p>
            </div>
            <Button variant="outline" size="sm" disabled={busy}
              onClick={() => void run("suggestion", () => api.acceptSuggestion(course.id, suggestion.id)).then((updated) => updated && onRefresh(updated))}>
              同意
            </Button>
          </div>
        ))}
        {node.status === "mastered" && !reviewMastered && !reviewActive && !initialChat ? (
          <div className="flex gap-3 rounded-xl border border-st-mastered/30 bg-st-mastered/5 p-4">
            <Check size={17} className="shrink-0 text-st-mastered" />
            <div className="flex flex-col items-start gap-1">
              <strong className="text-sm font-semibold">你已标记为掌握</strong>
              <p className="text-sm text-muted-foreground">按你的选择跳过本节点的学习与验收。</p>
              <Button variant="outline" size="sm" className="mt-1" onClick={() => setReviewMastered(true)}>仍要复习此节点</Button>
            </div>
          </div>
        ) : (
          <>
            {(!aiEnabled || scopeNotice) && note(!aiEnabled ? "AI 未开启：对话、出题和验收暂不可用，可在设置中开启。" : scopeNotice)}
            <NextStep node={node} onLesson={bench.openLesson} onPractice={bench.openPractice} />
          </>
        )}
        {!reviewStrict && <NodeLinks key={`${node.id}:${course.revision}`} course={course} node={node} busy={busy} aiEnabled={aiEnabled} act={act}
          canOpen={(entry) => isNodeVisible(entry, { reviewActive, directEntryId, directWeek })}
          onNavigate={onNavigateNode} onOpenBridge={onOpenRelation} />}
        <section className="flex flex-col" aria-label="相关">
          <h3 className="t-label mb-1">相关</h3>
          <Related icon={Target} label={goalEntries[0]?.goal.title || "目标"}
            value={goalEntries.length > 1 ? `${goalEntries.length} 个目标` : goalEntries.length ? "目标" : "未加入目标"}
            defaultOpen={goalEntries[0]?.goal.status === "doing" || !!goalActions?.changes.length} attention={!!goalActions?.changes.length}>
            <NodeGoals course={course} node={node} busy={busy} canCreate={!reviewStrict} act={act} onOpenGoal={onOpenGoal} />
          </Related>
          {node.kind === "synthesis" && <Related icon={Shapes} label="综合关联知识点" value={`${(node.related_node_ids || []).length} 个`} defaultOpen>
            <div className="flex flex-wrap gap-2">
              {(node.related_node_ids || []).map((id) => {
                const related = course.nodes.find((entry) => entry.id === id);
                const inReviewScope = course.review_scope.node_ids.includes(id);
                const available = related && (reviewStrict
                  ? inReviewScope
                  : isNodeVisible(related, { reviewActive, directEntryId, directWeek }));
                return available && related
                  ? <Button key={id} size="sm" variant="outline" onClick={() => onNavigateNode(related)}>{related.title}</Button>
                  : <div key={id} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span>{reviewStrict || (reviewActive && !inReviewScope)
                        ? "另有相关点不在本次范围；可调整范围或退出复习访问。"
                        : reviewActive ? "退出复习后可用搜索临时直达相关点。" : "另有未解锁相关点；完成先修或用搜索临时直达。"}</span>
                      {reviewStrict && !inReviewScope && <><Button size="sm" variant="ghost" onClick={onOpenReview}>调整范围</Button><Button size="sm" variant="ghost" onClick={onExitReview}>退出复习</Button></>}
                    </div>;
              })}
            </div>
          </Related>}
          {!!bridgeCount && <Related icon={Waypoints} label="知识桥" value={`${bridgeCount} 条${bridgeGaps ? ` · ${bridgeGaps} 条有缺口` : ""}`} attention={bridgeGaps > 0}>
            <BridgeCard course={course} node={node} busy={busy} act={act}
              canOpen={(entry) => reviewStrict ? course.review_scope.node_ids.includes(entry.id) : isNodeVisible(entry, { reviewActive, directEntryId, directWeek })}
              onNavigate={onNavigateNode} onOpenBridge={onOpenRelation}
              onOpenSource={(source) => openMaterial({ materialId: source.material_id, page: source.page })} />
          </Related>}
          {!!node.pieces?.length && <Related icon={Layers} label="知识块" title="块的自检汇总到主线与课程进度；整站验收和解锁仍按原规则。"
            value={`${node.pieces.filter((piece) => piece.state?.result === "known").length} / ${node.pieces.length} 已掌握`}>
            {node.pieces.map((piece) => <div key={piece.id} className="border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0">
              <strong className="font-medium">{piece.kind} · {piece.title}</strong><p className="text-muted-foreground">{piece.detail}</p>
              <div className="mt-1.5 flex gap-2"><Button size="sm" variant="outline" aria-pressed={piece.state?.result === "known"} disabled={busy} onClick={() => void act("piece-check", () => api.checkPiece(course.id, node.id, piece.id, "known"))}>我已掌握</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("piece-check", () => api.checkPiece(course.id, node.id, piece.id, "unsure"))}>还不确定</Button></div>
            </div>)}
          </Related>}
          <Related icon={FileText} label={sourceSummary(course, node)}>
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              {node.sources.length ? node.sources.map((source, i) => {
                const material = course.materials.find((m) => m.id === source.material_id);
                const page = material?.pages.find((p) => p.number === source.page);
                return (
                  <a className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2 no-underline transition-colors hover:bg-accent/50"
                    href={materialFileUrl(course.id, source.material_id, source.page)}
                    target="_blank" rel="noreferrer" key={`${source.material_id}-${source.page}-${i}`}
                    onClick={(event) => {
                      // Plain click opens the page beside the notes; Ctrl/middle click still opens a new tab.
                      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault();
                      openMaterial({ materialId: source.material_id, page: source.page });
                    }}>
                    <strong className="flex items-center gap-1 text-[13px] font-medium text-foreground">{material?.name || "课程材料"} <ExternalLink size={11} /></strong>
                    <span>第 {source.page} 页 · 自动提取节选{page?.uncertain || node.uncertain ? " · 识别可能不确定" : ""}</span>
                    <span className="line-clamp-2">{source.quote || "打开原始页面查看"}</span>
                  </a>
                );
              }) : <p>暂无材料引用</p>}
            </div>
          </Related>
          {!!materialVariants.length && <Related icon={Split} label="材料中的不同表述（待核对）" value={`${materialVariants.length}`} attention>
            <div className="flex flex-col gap-2 text-xs">
              {materialVariants.map((variant, index) => <div key={`${index}-${variant.summary}`} className="rounded-md bg-muted/30 px-2.5 py-2">
                <p className="text-[13px] leading-relaxed">{variant.summary}</p>
                {variant.sources.map((source, sourceIndex) => {
                  const material = course.materials.find((item) => item.id === source.material_id);
                  return <a className="mt-1 block text-muted-foreground underline-offset-2 hover:underline" target="_blank" rel="noreferrer" key={`${source.material_id}-${source.page}-${sourceIndex}`}
                    href={materialFileUrl(course.id, source.material_id, source.page)}>
                    {material?.name || "课程材料"} · 第 {source.page} 页{source.quote ? ` · ${source.quote}` : ""}
                  </a>;
                })}
              </div>)}
            </div>
          </Related>}
        </section>
        </>}
      </div>
      </div>}
    </aside>
  );
}
function suggestionText(suggestion: { [key: string]: unknown }) {
  return String(
    suggestion.advice ||
      suggestion.message ||
      suggestion.reason ||
      JSON.stringify(suggestion),
  );
}

function sourceSummary(course: Course, node: LearningNode) {
  if (!node.sources.length) return "材料来源";
  const byMaterial = new Map<string, number[]>();
  node.sources.forEach((source) => {
    const pages = byMaterial.get(source.material_id) || [];
    if (!pages.includes(source.page)) pages.push(source.page);
    byMaterial.set(source.material_id, pages);
  });
  const [first] = byMaterial.entries();
  const name = course.materials.find((m) => m.id === first[0])?.name || "课程材料";
  const pages = first[1].sort((a, b) => a - b).join("、");
  return `${name} · 第 ${pages} 页${byMaterial.size > 1 ? ` 等 ${byMaterial.size} 份` : ""}`;
}
