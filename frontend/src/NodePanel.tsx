import { useState } from "react";
import { BadgeCheck, BookOpen, Check, ChevronRight, CircleCheck, CircleHelp, Clock3, ExternalLink, FileText, Info, Lightbulb, MessageCircle, Send, Sparkles, Target } from "lucide-react";
import { api } from "./api";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { statusIcon } from "./status";
import { PracticePanel } from "./PracticePanel";
import { LessonPanel } from "./LessonPanel";
import { splitSummary } from "./summary";
import type { Course, LearningNode } from "./types";

const labels: Record<string, string> = {
  new: "可学习",
  studied: "学过",
  mastered: "自我掌握 · 未经验收",
  passed: "验收通过",
};

function Steps({ status }: { status: string }) {
  const reached = { new: 0, studied: 1, mastered: 2, passed: 3 }[status] ?? 0;
  const steps = [
    { label: "学过", Icon: BookOpen },
    { label: "自我掌握", Icon: BadgeCheck },
    { label: "验收通过", Icon: CircleCheck },
  ];
  return <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="掌握进度（只读）">
    {steps.map(({ label, Icon }, index) => <span key={label} className="flex items-center gap-1">
      {index > 0 && <ChevronRight size={12} className="opacity-50" aria-hidden />}
      <span className={cn("flex items-center gap-1", reached > index && "text-foreground")}>
        <Icon size={12} className={cn(reached > index && "text-st-passed")} aria-hidden />{label}
      </span>
    </span>)}
  </div>;
}
export function NodePanel({
  course,
  node,
  busy,
  aiEnabled,
  run,
  onRefresh,
  onRecall,
  onRatingSubmitted,
  reviewActive,
  reviewStrict,
}: {
  course: Course;
  node: LearningNode;
  busy: boolean;
  aiEnabled: boolean;
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void;
  onRecall: () => void;
  onRatingSubmitted: () => void;
  reviewActive: boolean;
  reviewStrict: boolean;
}) {
  const [tab, setTab] = useState<"lesson" | "learn" | "practice">("lesson");
  const [reviewMastered, setReviewMastered] = useState(false);
  const [message, setMessage] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const parts = splitSummary(node.summary || "");
  const longSummary = parts.explain.length + parts.check.length > 160;
  const stage = course.route?.stages.find((entry) => entry.node_ids.includes(node.id));
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
  const note = (text: string) => <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{text}</p>;
  return (
    <aside className="node-panel flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-border px-5 pb-4 pt-4">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">{stage ? `${stage.title} · 知识点` : "知识点"}</span>
          <Button variant="ghost" size="sm" className="-mr-2 h-7 px-2 text-xs" onClick={onRecall} title="回看这个知识点的历史对话">
            <Clock3 /> 找回思路
          </Button>
        </div>
        <h2 className="mt-1 text-lg font-semibold leading-snug">{node.title}</h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge variant={statusKey}><StatusIcon aria-hidden />{statusText}</Badge>
          <Steps status={node.status} />
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
        </div>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {reviewStrict && note("本次范围的结果单独记录，不改变整门课程的掌握与解锁；“自我掌握”仍适用于整个节点。")}
        {reviewActive && !reviewStrict && note("当前仅筛选地图。学习对话与验收沿用整门课程，验收通过会更新课程掌握与解锁。")}
        {reviewStrict && node.summary && note(`课程总览（跨材料）：${node.summary}`)}
        {(!reviewStrict || !node.summary) && <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold"><Lightbulb size={14} className="text-st-new" aria-hidden /> 讲解</h3>
          <p className={cn("text-[13px] leading-relaxed text-muted-foreground", !summaryOpen && longSummary && "line-clamp-3")}>{parts.explain || "还没有补充说明。"}</p>
          {parts.check && (summaryOpen || !longSummary) && <>
            <h3 className="mb-1.5 mt-3 flex items-center gap-1.5 text-[13px] font-semibold"><Target size={14} className="text-st-passed" aria-hidden /> 验收标准</h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{parts.check}</p>
          </>}
          {longSummary && (
            <button className="mt-2 cursor-pointer text-xs font-medium text-foreground/80 underline-offset-4 hover:underline" onClick={() => setSummaryOpen((open) => !open)} aria-expanded={summaryOpen}>
              {summaryOpen ? "收起" : parts.check ? "展开全文与验收标准" : "展开全文"}
            </button>
          )}
          {parts.note && <p className="mt-3 flex items-center gap-1 border-t border-border pt-2.5 text-[11px] text-muted-foreground" title={parts.note}><Info size={12} aria-hidden /> 依据提取文本生成，公式和表格未核对原图</p>}
        </div>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm"
            onClick={() => void act("mark", () => api.mark(course.id, node.id, node.status === "studied" ? "new" : "studied"))}
            disabled={busy || node.status === "passed"}>
            <BookOpen /> {node.status === "studied" ? "撤销学过" : "标记学过"}
          </Button>
          <Button variant="outline" size="sm"
            onClick={() => void act("mark", () => api.mark(course.id, node.id, node.status === "mastered" ? "new" : "mastered"))}
            disabled={busy || node.status === "passed"}>
            <Check /> {node.status === "mastered" ? "撤销掌握" : "自我掌握"}
          </Button>
        </div>
        <details className="group rounded-lg text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <FileText size={13} className="shrink-0" /> <span className="truncate">{sourceSummary(course, node)}</span>
            <ChevronRight size={13} className="ml-auto shrink-0 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {node.sources.length ? node.sources.map((source, i) => {
              const material = course.materials.find((m) => m.id === source.material_id);
              const page = material?.pages.find((p) => p.number === source.page);
              return (
                <a className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2 no-underline transition-colors hover:bg-accent/50"
                  href={`/api/courses/${course.id}/materials/${source.material_id}/file#page=${source.page}`}
                  target="_blank" rel="noreferrer" key={`${source.material_id}-${source.page}-${i}`}>
                  <strong className="flex items-center gap-1 text-[13px] font-medium text-foreground">{material?.name || "课程材料"} <ExternalLink size={11} /></strong>
                  <span>第 {source.page} 页 · 自动提取节选{page?.uncertain || node.uncertain ? " · 识别可能不确定" : ""}</span>
                  <span className="line-clamp-2">{source.quote || "打开原始页面查看"}</span>
                </a>
              );
            }) : <p>暂无材料引用</p>}
          </div>
        </details>
        {course.suggestions.filter((suggestion) => suggestion.node_id === node.id && !suggestion.accepted).map((suggestion) => (
          <div className="flex items-center gap-3 rounded-xl border border-st-new/30 bg-st-new/5 p-3" key={suggestion.id}>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-st-new">难度调整建议</div>
              <p className="text-[13px] text-muted-foreground">{suggestionText(suggestion)}</p>
            </div>
            <Button variant="outline" size="sm" disabled={busy}
              onClick={() => void run("suggestion", () => api.acceptSuggestion(course.id, suggestion.id)).then((updated) => updated && onRefresh(updated))}>
              同意
            </Button>
          </div>
        ))}
        {node.status === "mastered" && !reviewMastered && !reviewActive ? (
          <div className="flex gap-3 rounded-xl border border-st-mastered/30 bg-st-mastered/5 p-4">
            <Check size={17} className="shrink-0 text-st-mastered" />
            <div className="flex flex-col items-start gap-1">
              <strong className="text-sm font-semibold">你已标记为掌握</strong>
              <p className="text-[13px] text-muted-foreground">按你的选择跳过本节点学习与验收，继续地图中的后续内容。</p>
              <Button variant="outline" size="sm" className="mt-1" onClick={() => setReviewMastered(true)}>仍要复习此节点</Button>
            </div>
          </div>
        ) : (
          <>
            {reviewActive && Object.values(node.review_archived || {}).some((count) => count > 0) &&
              note("此前的全课程记录已保留；当前只显示本复习范围的记录。「找回思路」仍可查看全部原始对话。")}
            <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="mt-1 gap-3">
              <TabsList className="w-full">
                <TabsTrigger value="lesson"><BookOpen /> 小课</TabsTrigger>
                <TabsTrigger value="learn"><MessageCircle /> 学习对话</TabsTrigger>
                <TabsTrigger value="practice"><CircleHelp /> 练习验收</TabsTrigger>
              </TabsList>
              {!aiEnabled && note("AI 辅助已关闭。打开设置并确认数据发送说明后，可使用对话、出题和验收。")}
              <TabsContent value="lesson">
                <LessonPanel course={course} node={node} busy={busy} aiEnabled={aiEnabled}
                  act={act} onPractice={() => setTab("practice")}
                  onDiscuss={(text) => { setMessage(text); setTab("learn"); }} />
              </TabsContent>
              <TabsContent value="learn" className="flex flex-col gap-3">
                <div className="conversation flex flex-col gap-2.5">
                  {node.chats.length ? node.chats.map((chat) => (
                    <div className={cn("flex flex-col gap-1", chat.role === "assistant" ? "items-start" : "items-end")} key={chat.id}>
                      <span className="text-[11px] text-muted-foreground">{chat.role === "assistant" ? "AI 导师" : "我"}</span>
                      <p className={cn("max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed",
                        chat.role === "assistant" ? "border border-border bg-card" : "bg-secondary")}>{chat.content}</p>
                    </div>
                  )) : (
                    <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-border p-4 text-[13px] text-muted-foreground">
                      <Sparkles size={16} className="shrink-0" />
                      <span>从你已有的理解出发，和 AI 一起梳理这个知识点。</span>
                    </div>
                  )}
                </div>
                <form className="flex items-end gap-2 rounded-xl border border-input p-2 focus-within:border-zinc-600" onSubmit={(event) => { event.preventDefault(); void sendChat(); }}>
                  <textarea className="min-h-[44px] flex-1 resize-none !border-0 !bg-transparent !p-1 text-[13px] !shadow-none outline-none" aria-label="学习对话" value={message}
                    onChange={(event) => setMessage(event.target.value)} placeholder="说说你的想法或疑问…" rows={2} disabled={!aiEnabled} />
                  <Button size="icon-sm" disabled={busy || !message.trim() || !aiEnabled} title="发送" aria-label="发送"><Send /></Button>
                </form>
              </TabsContent>
              <TabsContent value="practice">
                <PracticePanel course={course} node={node} busy={busy} aiEnabled={aiEnabled} run={run} onRefresh={onRefresh} onRatingSubmitted={onRatingSubmitted} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
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
