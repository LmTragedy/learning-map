import { useState } from "react";
import { BadgeCheck, BookOpen, Check, ChevronRight, CircleCheck, CircleHelp, Clock3, ExternalLink, FileText, Info, Lightbulb, MessageCircle, Send, Sparkles, Target } from "lucide-react";
import { api } from "./api";
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
  return <div className="steps" aria-label="掌握进度（只读）">
    {steps.map(({ label, Icon }, index) => <span key={label} className="steps-item">
      {index > 0 && <ChevronRight size={12} className="steps-sep" aria-hidden />}
      <span className={`step ${reached > index ? "done" : ""} step-${index}`}><Icon size={12} aria-hidden />{label}</span>
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
  return (
    <aside className="detail-panel">
      <div className="panel-top">
        <span className="eyebrow">{stage ? `${stage.title} · 知识点` : "知识点"}</span>
        <button
          className="quiet-button recall-button"
          onClick={onRecall}
          title="回看这个知识点的历史对话"
        >
          <Clock3 size={14} /> 找回思路
        </button>
      </div>
      <h2 className="panel-title">{node.title}</h2>
      <Steps status={node.status} />
      <div className="status-line">
        <span className={`status-dot ${node.status}`} />
        {node.verification === "review"
          ? "用户确认通过"
          : node.status === "passed" && node.verification === "user_passed"
            ? "用户确认通过"
            : node.status === "passed"
              ? "系统验收通过"
              : !node.unlocked && !reviewActive ? "临时直达 · 未解锁" : labels[node.status]}
        {node.verification === "review" && (
          <span className="tag warning">待复查</span>
        )}
        {reviewStrict && node.review_verification && node.review_verification !== "none" && (
          <span className={`tag ${node.review_verification === "review" ? "warning" : "success"}`}>
            {node.review_verification === "ai_passed"
              ? "当前资料范围验收通过"
              : node.review_verification === "user_passed"
                ? "当前资料范围用户确认"
                : "当前资料范围待复查"}
          </span>
        )}
      </div>
      {reviewStrict && <div className="review-history-note">本次范围的结果单独记录，不改变整门课程的掌握与解锁；“自我掌握”仍适用于整个节点。</div>}
      {reviewActive && !reviewStrict && <div className="review-history-note">当前仅筛选地图。学习对话与验收沿用整门课程，验收通过会更新课程掌握与解锁。</div>}
      {reviewStrict && node.summary && <div className="review-history-note">课程总览（跨材料）：{node.summary}</div>}
      {(!reviewStrict || !node.summary) && <div className={`summary-blocks ${summaryOpen || !longSummary ? "open" : ""}`}>
        <section><h3><Lightbulb size={14} aria-hidden /> 讲解</h3><p>{parts.explain || "还没有补充说明。"}</p></section>
        {parts.check && <section><h3><Target size={14} aria-hidden /> 验收标准</h3><p>{parts.check}</p></section>}
      </div>}
      {(!reviewStrict || !node.summary) && longSummary && (
        <button className="summary-toggle" onClick={() => setSummaryOpen((open) => !open)} aria-expanded={summaryOpen}>
          {summaryOpen ? "收起" : "展开全文"}
        </button>
      )}
      {parts.note && <p className="summary-note" title={parts.note}><Info size={12} aria-hidden /> 依据提取文本生成，公式和表格未核对原图</p>}
      <details className="source-box">
        <summary className="section-title">
          <FileText size={15} /> {sourceSummary(course, node)}
          <ExternalLink size={13} className="source-more" aria-hidden />
        </summary>
        {node.sources.length ? (
          node.sources.map((source, i) => {
            const material = course.materials.find(
              (m) => m.id === source.material_id,
            );
            const page = material?.pages.find((p) => p.number === source.page);
            return (
              <a
                className="source-link"
                href={`/api/courses/${course.id}/materials/${source.material_id}/file#page=${source.page}`}
                target="_blank"
                rel="noreferrer"
                key={`${source.material_id}-${source.page}-${i}`}
              >
                <strong>{material?.name || "课程材料"}</strong>
                <span>
                  第 {source.page} 页 · 自动提取节选
                  {page?.uncertain || node.uncertain ? " · 识别可能不确定" : ""}
                </span>
                <span>{source.quote || "打开原始页面查看"}</span>
              </a>
            );
          })
        ) : (
          <p className="muted small">暂无材料引用</p>
        )}
      </details>
      {course.suggestions
        .filter(
          (suggestion) =>
            suggestion.node_id === node.id && !suggestion.accepted,
        )
        .map((suggestion) => (
          <div className="suggestion-card" key={suggestion.id}>
            <div>
              <span className="eyebrow">难度调整建议</span>
              <p>{suggestionText(suggestion)}</p>
            </div>
            <button
              className="secondary"
              onClick={() =>
                void run("suggestion", () =>
                  api.acceptSuggestion(course.id, suggestion.id),
                ).then((updated) => updated && onRefresh(updated))
              }
              disabled={busy}
            >
              同意
            </button>
          </div>
        ))}
      <div className="mark-actions">
        <button
          onClick={() =>
            void act("mark", () =>
              api.mark(
                course.id,
                node.id,
                node.status === "studied" ? "new" : "studied",
              ),
            )
          }
          disabled={busy || node.status === "passed"}
        >
          <BookOpen size={15} />{" "}
          {node.status === "studied" ? "撤销学过" : "标记学过"}
        </button>
        <button
          onClick={() =>
            void act("mark", () =>
              api.mark(
                course.id,
                node.id,
                node.status === "mastered" ? "new" : "mastered",
              ),
            )
          }
          disabled={busy || node.status === "passed"}
        >
          <Check size={15} />{" "}
          {node.status === "mastered" ? "撤销掌握" : "自我掌握"}
        </button>
      </div>
      {node.status === "mastered" && !reviewMastered && !reviewActive ? (
        <div className="mastered-note">
          <Check size={17} />
          <div>
            <strong>你已标记为掌握</strong>
            <p>按你的选择跳过本节点学习与验收，继续地图中的后续内容。</p>
            <button
              className="secondary"
              onClick={() => setReviewMastered(true)}
            >
              仍要复习此节点
            </button>
          </div>
        </div>
      ) : (
        <>
          {reviewActive && Object.values(node.review_archived || {}).some((count) => count > 0) && (
            <div className="review-history-note">此前的全课程记录已保留；当前只显示本复习范围的记录。「找回思路」仍可查看全部原始对话。</div>
          )}
          <div className="tab-row">
            <button className={tab === "lesson" ? "active" : ""} onClick={() => setTab("lesson")}>
              <BookOpen size={15} /> 小课
            </button>
            <button
              className={tab === "learn" ? "active" : ""}
              onClick={() => setTab("learn")}
            >
              <MessageCircle size={15} /> 学习对话
            </button>
            <button
              className={tab === "practice" ? "active" : ""}
              onClick={() => setTab("practice")}
            >
              <CircleHelp size={15} /> 练习验收
            </button>
          </div>
          {!aiEnabled && (
            <div className="ai-disabled-note">
              AI
              辅助已关闭。打开设置并确认数据发送说明后，可使用对话、出题和验收。
            </div>
          )}
          {tab === "lesson" && <LessonPanel course={course} node={node} busy={busy} aiEnabled={aiEnabled}
            act={act} onPractice={() => setTab("practice")}
            onDiscuss={(text) => { setMessage(text); setTab("learn"); }} />}
          {tab === "learn" && (
            <div className="learn-pane">
              <div className="conversation">
                {node.chats.length ? node.chats.map((chat) => (
                  <div className={`bubble ${chat.role === "assistant" ? "assistant" : "user"}`} key={chat.id}>
                    <span>{chat.role === "assistant" ? "AI 导师" : "我"}</span>
                    <p>{chat.content}</p>
                  </div>
                )) : (
                  <div className="quiet-card">
                    <Sparkles size={17} />
                    <span>从你已有的理解出发，和 AI 一起梳理这个知识点。</span>
                  </div>
                )}
              </div>
              <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendChat(); }}>
                <textarea aria-label="学习对话" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="说说你的想法或疑问…" rows={2} disabled={!aiEnabled} />
                <button className="primary-icon" disabled={busy || !message.trim() || !aiEnabled} title="发送"><Send size={16} /></button>
              </form>
            </div>
          )}
          {tab === "practice" && <PracticePanel course={course} node={node} busy={busy} aiEnabled={aiEnabled} run={run} onRefresh={onRefresh} onRatingSubmitted={onRatingSubmitted} />}
        </>
      )}
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
