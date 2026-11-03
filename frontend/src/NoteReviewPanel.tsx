import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import type { NoteReviewController, ReviewState } from "./noteReview";
import type { NoteSuggestion } from "./noteReviewTypes";
import { materialFileUrl } from "./api";

const labels = { knowledge_logic: "知识与逻辑", english: "英文表达", uncertain: "无法确定" };
const status = {
  off: "自动检查已关闭；仍可正常编辑和保存。",
  unavailable: "Codex 当前不可用；仍可正常编辑和保存。",
  idle: "写下笔记后，停笔约 8 秒会检查整篇内容；两次自动检查至少间隔 30 秒，可随时“立即检查”。",
  waiting: "等待写作停顿后检查整篇笔记…",
  checking: "正在检查整篇笔记；可以继续输入或保存。",
  ready: "有问题的地方会画上波浪线，点击它查看并决定是否修改。",
  error: "AI 检查失败，自动检查已暂停；编辑和保存不受影响。",
};

/** The card under a clicked squiggle: what to change, why, and where it comes from. */
export function SuggestionCard({ suggestion, courseId, onAccept, onReject }: {
  suggestion: NoteSuggestion; courseId: string; onAccept: () => void; onReject: () => void;
}) {
  return <article className={`note-review-suggestion is-${suggestion.category}`} aria-label={`${labels[suggestion.category]}建议`}>
    <div className="note-review-kind">{labels[suggestion.category]}</div>
    <p className="note-review-change">
      {suggestion.original && <s className="text-muted-foreground">{suggestion.original}</s>}
      <button type="button" className="note-review-replacement" onClick={onAccept} title="接受修改 · Tab">
        {suggestion.replacement || "（删除此片段）"}
      </button>
    </p>
    {suggestion.category === "uncertain" && <p className="text-xs text-muted-foreground">存疑：缺少可靠依据或材料识别不确定，以下为待核对的 AI 判断。</p>}
    <p className="text-xs">{suggestion.reason}</p>
    {suggestion.sources.map((source, index) => <div className="text-xs text-muted-foreground" key={index}>
      <a target="_blank" rel="noreferrer" href={materialFileUrl(courseId, source.material_id, source.page)}>
        {source.name} · 第 {source.page} 页{source.uncertain ? " · 识别不确定" : " · 提取文字依据"}</a>
      <blockquote className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap border-l border-border pl-2">{source.quote}</blockquote>
    </div>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={onAccept}>接受 · Tab</Button>
      <Button size="sm" variant="ghost" onClick={onReject}>忽略</Button>
    </div>
  </article>;
}

/**
 * The AI check as one small dot beside the save status: green while it is on and fine, pulsing while
 * checking, red on errors, grey when off. Clicking it shows the details, the switch and the actions.
 */
export function NoteReviewDot({ controller, state, model, aiEnabled, automatic, onAutomatic, onLocate, onUndo, canUndo, action }: {
  controller: NoteReviewController; state: ReviewState; model: string;
  aiEnabled: boolean; automatic: boolean; onAutomatic: (enabled: boolean) => void;
  onLocate: (id: string) => void; onUndo: () => void; canUndo: boolean;
  /** Feedback from the last accept/undo. */
  action: string;
}) {
  const on = aiEnabled && automatic && state.phase !== "off" && state.phase !== "unavailable";
  const tone = !on ? "is-off" : state.phase === "error" ? "is-error" : state.phase === "checking" ? "is-checking" : "";
  const text = !aiEnabled ? "AI 尚未启用；笔记仍可正常编辑和保存。" : status[state.phase];
  const count = state.suggestions.length;
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" className={`note-ai-dot ${tone}`} title={`AI 检查：${text}`} aria-label={`AI 检查，${text}${count ? `，${count} 处建议` : ""}`}>
        <i aria-hidden />{count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
      <section className="node-note-review" aria-label="AI 笔记检查">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm">AI 检查 · {model}</strong>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="自动检查笔记" checked={automatic}
            disabled={!aiEnabled} onChange={(event) => onAutomatic(event.target.checked)} />自动检查</label>
        </div>
        <p role="status" className="text-xs text-muted-foreground">{text}</p>
        {aiEnabled && automatic && <p className="text-xs text-muted-foreground">整篇笔记和当前节点上下文会发送至配置的检查模型提供方（Codex 或 DeepSeek）。建议不会自动写入原文。</p>}
        {state.message && <p role="alert" className="text-xs text-destructive">{state.message}</p>}
        {state.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
        {!!count && <ul className="note-review-list">
          {state.suggestions.map((suggestion) => <li key={suggestion.id}>
            <button type="button" className={state.activeId === suggestion.id ? "is-active" : ""} onClick={() => onLocate(suggestion.id)}>
              <span className={`note-review-dot is-${suggestion.category}`} aria-hidden />
              <span className="truncate">{suggestion.original || "（插入）"}</span>
              <span className="shrink-0 text-muted-foreground">→ {suggestion.replacement || "删除"}</span>
            </button>
          </li>)}
        </ul>}
        {state.phase === "ready" && !count && <p className="text-xs text-muted-foreground">本次未提出更多建议；不代表已验证笔记完全正确。</p>}
        {action && <p role="status" className="text-xs text-muted-foreground">{action}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!aiEnabled || !automatic || state.phase === "unavailable" || state.phase === "checking"}
            onClick={() => controller.retry()}>{state.phase === "error" ? "重试检查" : "立即检查"}</Button>
          <Button size="sm" variant="ghost" disabled={!canUndo} onClick={onUndo}>撤销已接受的修改</Button>
        </div>
      </section>
    </PopoverContent>
  </Popover>;
}
