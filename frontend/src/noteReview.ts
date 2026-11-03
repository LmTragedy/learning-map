import { suggestionMatches } from "./noteReviewTypes.ts";
import type { NoteReviewResponse, NoteSuggestion } from "./noteReviewTypes";

export type ReviewContext = {
  courseId: string; nodeId: string; revision: number; scopeKey: string;
  content: string; enabled: boolean; available: boolean; model: string;
  noteId?: string;
};
type Phase = "off" | "unavailable" | "idle" | "waiting" | "checking" | "ready" | "error";
export type ReviewState = {
  phase: Phase; message: string; suggestions: NoteSuggestion[]; activeId: string | null;
  snapshot: string; warnings: string[];
};
type ReviewRequest = (context: ReviewContext, requestId: string, signal: AbortSignal) => Promise<NoteReviewResponse>;
const empty: ReviewState = { phase: "idle", message: "", suggestions: [], activeId: null, snapshot: "", warnings: [] };
const fingerprint = (suggestion: NoteSuggestion) => JSON.stringify([suggestion.original, suggestion.replacement]);
const contextKey = (context: ReviewContext) => JSON.stringify([
  context.courseId, context.nodeId, context.noteId || "", context.revision, context.scopeKey, context.model,
]);

export class NoteReviewController {
  private context?: ReviewContext;
  private state: ReviewState = empty;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: AbortController;
  private generation = 0;
  private checked = -1;
  private paused = false;
  private disposed = false;
  private lastEdit = 0;
  private dismissed = new Set<string>();
  private request: ReviewRequest;
  private delay: number;
  private timeout: number;

  constructor(request: ReviewRequest, delay = 1800, timeout = 60000) {
    this.request = request; this.delay = delay; this.timeout = timeout;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;

  private publish(fields: Partial<ReviewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...fields };
    this.listeners.forEach((listener) => listener());
  }

  update(context: ReviewContext) {
    const restarting = this.disposed;
    this.disposed = false;
    const changedContext = !this.context || contextKey(this.context) !== contextKey(context);
    const changed = restarting || changedContext || this.context?.content !== context.content
      || this.context.enabled !== context.enabled || this.context.available !== context.available;
    this.context = context;
    if (!changed) return;
    this.generation++;
    this.lastEdit = Date.now();
    clearTimeout(this.timer);
    if (changedContext) { this.paused = false; this.dismissed.clear(); }
    this.publish({ ...empty, phase: this.phase(context), message: this.paused ? this.state.message : "" });
    this.schedule();
  }

  private phase(context: ReviewContext): Phase {
    if (!context.enabled) return "off";
    if (!context.available) return "unavailable";
    if (!context.content.trim()) return "idle";
    return this.paused ? "error" : "waiting";
  }

  private schedule(immediate = false) {
    if (!this.context || this.phase(this.context) !== "waiting" || this.checked === this.generation) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.pending) void this.check(); },
      immediate ? 0 : Math.max(0, this.delay - (Date.now() - this.lastEdit)));
  }

  retry() {
    this.generation++;
    this.paused = false;
    this.checked = -1;
    if (this.context) this.publish({ phase: this.phase(this.context), message: "" });
    this.schedule(true);
  }

  private async check() {
    const context = this.context;
    if (!context || this.disposed) return;
    const generation = this.generation;
    const requestId = crypto.randomUUID();
    const abort = new AbortController();
    this.pending = abort;
    let timedOut = false;
    this.publish({ phase: "checking", message: "" });
    // A hung provider must not keep the UI in checking state or block saving.
    let timeoutTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Error("检查已取消。")), { once: true });
      timeoutTimer = setTimeout(() => {
        timedOut = true; abort.abort(); reject(new Error("检查超过 60 秒，已停止等待。笔记可继续编辑保存，请手动重试。"));
      }, this.timeout);
    });
    try {
      const response = await Promise.race([this.request(context, requestId, abort.signal), deadline]);
      if (this.disposed || generation !== this.generation) return;
      if (response.request_id !== requestId || response.revision !== context.revision
        || (response.note_id || "") !== (context.noteId || "")
        || response.scope_key !== context.scopeKey || response.model !== context.model) throw new Error("检查上下文已变化，建议未应用。请重新检查。");
      this.checked = generation;
      this.publish({ phase: "ready", snapshot: context.content, activeId: null,
        suggestions: response.suggestions.filter((suggestion) => suggestionMatches(context.content, context.content, suggestion)
          && !this.dismissed.has(fingerprint(suggestion))), warnings: response.warnings });
    } catch (error) {
      if (abort.signal.aborted && !timedOut) return;
      if (this.disposed || !this.context || contextKey(context) !== contextKey(this.context)) return;
      this.paused = true;
      this.publish({ phase: "error", suggestions: [], activeId: null,
        message: timedOut ? "检查超过 60 秒，已停止等待。笔记可继续编辑保存，请手动重试。"
          : error instanceof Error ? error.message : "AI 检查失败；编辑和保存不受影响。" });
    } finally {
      clearTimeout(timeoutTimer!);
      if (this.pending === abort) this.pending = undefined;
      if (!this.disposed) this.schedule();
    }
  }

  select(id: string) { this.publish({ activeId: id }); }
  current(id = this.state.activeId) {
    const suggestion = this.state.suggestions.find((entry) => entry.id === id);
    return suggestion && this.context && suggestionMatches(this.context.content, this.state.snapshot, suggestion) ? suggestion : undefined;
  }
  reject(id: string) {
    const suggestion = this.current(id);
    if (!suggestion) return;
    this.dismissed.add(fingerprint(suggestion));
    if (this.dismissed.size > 100) this.dismissed.delete(this.dismissed.values().next().value!);
    this.publish({ suggestions: this.state.suggestions.filter((entry) => entry.id !== id), activeId: null });
  }
  accepted() {
    this.publish({ ...empty, phase: "waiting" });
  }
  dispose() {
    this.disposed = true; this.generation++; clearTimeout(this.timer); this.pending?.abort();
  }
}
