import { Button } from "./components/ui/button";
import type { NoteReviewController, ReviewState } from "./noteReview";
import { materialFileUrl } from "./api";

const labels = { knowledge_logic: "知识与逻辑", english: "英文表达", uncertain: "无法确定" };
const status = {
  off: "自动检查已关闭；仍可正常编辑和保存。",
  unavailable: "Codex 当前不可用；仍可正常编辑和保存。",
  idle: "写下笔记后，停笔约两秒会检查整篇内容。",
  waiting: "等待写作停顿后检查整篇笔记…",
  checking: "正在检查整篇笔记；可以继续输入或保存。",
  ready: "以下是 AI 建议，请核对后逐条决定。",
  error: "AI 检查失败，自动检查已暂停；编辑和保存不受影响。",
};

export function NoteReviewPanel({ controller, state, courseId, model, aiEnabled, automatic, onAutomatic,
  onAccept, onLocate, onUndo, canUndo }: {
  controller: NoteReviewController; state: ReviewState; courseId: string; model: string;
  aiEnabled: boolean; automatic: boolean; onAutomatic: (enabled: boolean) => void;
  onAccept: (id?: string) => boolean; onLocate: (id: string) => void;
  onUndo: () => void; canUndo: boolean;
}) {
  return <section className="node-note-review" aria-label="AI 笔记检查">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="text-sm">AI 检查 · {model}</strong>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="自动检查笔记" checked={automatic}
        disabled={!aiEnabled} onChange={(event) => onAutomatic(event.target.checked)} />自动检查</label>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{!aiEnabled ? "AI 尚未启用；笔记仍可正常编辑和保存。" : status[state.phase]}</p>
    {aiEnabled && automatic && <p className="text-xs text-muted-foreground">整篇笔记和当前节点上下文会发送至配置的 Codex 提供方。建议不会自动写入原文。</p>}
    {state.message && <p role="alert" className="text-xs text-destructive">{state.message}</p>}
    {state.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={!aiEnabled || !automatic || state.phase === "unavailable" || state.phase === "checking"}
        onClick={() => controller.retry()}>{state.phase === "error" ? "重试检查" : "立即检查"}</Button>
      <Button size="sm" variant="ghost" disabled={!canUndo} onClick={onUndo}>撤销已接受的修改</Button>
    </div>
    {state.phase === "ready" && !state.suggestions.length && <p className="text-xs text-muted-foreground">本次未提出更多建议；不代表已验证笔记完全正确。</p>}
    {state.suggestions.map((suggestion) => <article key={suggestion.id} tabIndex={0}
      aria-label={`${labels[suggestion.category]}建议，第${suggestion.line}行`}
      className={`node-note-suggestion ${state.activeId === suggestion.id ? "is-active" : ""}`}
      onFocus={() => controller.select(suggestion.id)} onClick={() => controller.select(suggestion.id)}
      onKeyDown={(event) => {
        if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && onAccept(suggestion.id)) {
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      <div className="flex items-center justify-between gap-2 text-xs"><strong>{labels[suggestion.category]}</strong><span>第 {suggestion.line} 行</span></div>
      <div><span className="text-xs text-muted-foreground">原句</span><p className="whitespace-pre-wrap break-words">{suggestion.original}</p></div>
      <div><span className="text-xs text-muted-foreground">建议修改</span><p className="whitespace-pre-wrap break-words">{suggestion.replacement || "（删除此片段）"}</p></div>
      {suggestion.category === "uncertain" && <p className="text-xs text-muted-foreground">存疑：缺少可靠依据或材料识别不确定，以下为待核对的 AI 判断。</p>}
      <p className="text-xs">{suggestion.reason}</p>
      {suggestion.sources.map((source, index) => <div className="text-xs text-muted-foreground" key={index}>
        <a target="_blank" rel="noreferrer" href={materialFileUrl(courseId, source.material_id, source.page)}>
          {source.name} · 第 {source.page} 页{source.uncertain ? " · 识别不确定" : " · 提取文字依据"}</a>
        <blockquote className="mt-1 whitespace-pre-wrap border-l border-border pl-2">{source.quote}</blockquote>
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); onLocate(suggestion.id); }}>定位原文</Button>
        <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); onAccept(suggestion.id); }}>接受此条 · Tab</Button>
        <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); controller.reject(suggestion.id); }}>拒绝</Button>
      </div>
    </article>)}
    {!!state.suggestions.length && <p className="text-xs text-muted-foreground">先聚焦一条建议或定位原文，再按 Tab 仅接受这一条。继续编辑后旧建议失效。后续已有编辑时，可用 Ctrl+Z 逐步撤销。</p>}
  </section>;
}
