import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTime } from "./formatTime";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { ChevronRight, Link2, NotebookPen, Plus, Trash2, X } from "lucide-react";
import "./nodeNotes.css";
import { acknowledgeSaved, activeDraft, currentDraft, isUnsaved, keepDraft, newDraft, noteScope, storedDrafts } from "./noteDrafts";
import type { NoteDraft } from "./noteDrafts";
import { appendBlock, mainNoteTitle } from "./noteFormatting";
import type { Course, CourseNote, LearningNode } from "./types";
import { useNoteReview } from "./useNoteReview";
import { NoteReviewDot, SuggestionCard } from "./NoteReviewPanel";
import type { NoteEditorActions } from "./noteReviewTypes";

const MarkdownNoteEditor = lazy(() => import("./MarkdownNoteEditor"));
const AUTOSAVE_MS = 1500;

/**
 * One note document. Without `noteId` it edits the node's main note; with it, a named
 * extra note that can be bound to several nodes.
 */
export function PersonalNote({ course, node, noteId = "", busy, run, onRefresh, onClose, onOpenNote, aiEnabled, aiAvailable, reviewModel, embedded = false, pendingAppend }: {
  course: Course; node: LearningNode; noteId?: string; busy: boolean;
  run: <T,>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
  aiEnabled: boolean; aiAvailable: boolean; reviewModel: string;
  embedded?: boolean;
  /** Text from another pane (a PDF excerpt, an AI answer) to add at the end of this note once. */
  pendingAppend?: { id: number; text: string };
}) {
  const extra: CourseNote | undefined = noteId ? course.notes?.find((note) => note.id === noteId) : undefined;
  const scope = noteScope(course.id, noteId ? `note:${noteId}` : node.id);
  const saved = (extra ? extra.content : node.personal_note) || "";
  const savedTitle = extra ? extra.title : mainNoteTitle(node);
  const [draft, setDraft] = useState(() => currentDraft(scope, saved));
  const draftRef = useRef(draft);
  const saving = useRef(false);
  const mounted = useRef(true);
  const [storage, setStorage] = useState(() => storedDrafts(scope));
  const [error, setError] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const [title, setTitle] = useState(savedTitle);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = isUnsaved(draft);
  const conflict = draft.expected === null || saved !== draft.expected;
  const editor = useRef<NoteEditorActions | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [lastAccepted, setLastAccepted] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState("");
  const { controller, state: review } = useNoteReview({
    courseId: course.id, nodeId: node.id, noteId, revision: course.revision,
    scopeKey: course.review_scope.key, model: reviewModel.trim(), content: draft.content,
    enabled: aiEnabled && automatic, available: aiAvailable,
  });
  const nodeNotes = [
    { id: "", title: mainNoteTitle(node) },
    ...(course.notes || []).filter((note) => note.node_ids.includes(node.id)).map((note) => ({ id: note.id, title: note.title })),
  ];

  function acceptSuggestion(id?: string) {
    const suggestion = controller.current(id);
    if (!suggestion) return false;
    const changed = editor.current?.replace(suggestion);
    if (changed === undefined || changed === null) return false;
    setLastAccepted(changed);
    setReviewAction("已接受这一条，稍后自动保存。可撤销或继续编辑。");
    controller.accepted(suggestion.id);
    return true;
  }

  // New results replace the squiggles; pruned or ignored ones disappear from the editor too.
  useEffect(() => { editor.current?.sync(review.suggestions, review.snapshot); }, [review.suggestions, review.snapshot]);
  const reviewHooks = {
    onPick: (id: string | null) => { if (id) controller.select(id); else if (controller.snapshot().activeId) controller.deselect(); },
    onStale: (ids: string[]) => controller.prune(ids),
    render: (id: string, close: () => void) => {
      const suggestion = review.suggestions.find((entry) => entry.id === id);
      return suggestion && <SuggestionCard suggestion={suggestion} courseId={course.id}
        onAccept={() => { if (!acceptSuggestion(id)) setReviewAction("本次未应用，请核对原文或编辑器提示。"); }}
        onReject={() => { controller.reject(id); close(); }} />;
    },
  };

  function undoSuggestion() {
    if (lastAccepted !== draftRef.current.content || !editor.current?.undo()) {
      setReviewAction("此后已有其他编辑，请用 Ctrl+Z 逐步撤销，避免覆盖后续内容。"); return;
    }
    setLastAccepted(null); setReviewAction("已撤销建议修改。");
  }

  useEffect(() => {
    mounted.current = true;
    const reloadDrafts = () => setStorage(storedDrafts(scope));
    const syncDraft = () => {
      const latest = activeDraft(scope);
      if (latest) { draftRef.current = latest; setDraft(latest); }
      reloadDrafts();
    };
    window.addEventListener("storage", reloadDrafts);
    window.addEventListener("note-drafts-changed", syncDraft);
    return () => {
      mounted.current = false;
      window.removeEventListener("storage", reloadDrafts);
      window.removeEventListener("note-drafts-changed", syncDraft);
    };
  }, [scope]);

  function update(next: NoteDraft) {
    draftRef.current = next;
    // Write synchronously before a node switch, tab change or component unmount.
    const warning = keepDraft(scope, next);
    if (mounted.current) {
      setDraft(next);
      setError(warning);
      setStorage(storedDrafts(scope));
    }
  }

  async function refreshSaved() {
    const latest = await run("personal-note-refresh", () => api.course(course.id));
    if (latest) onRefresh(latest);
  }

  function request(content: string, expected: string, nextTitle = savedTitle, nodeIds = extra?.node_ids) {
    if (extra) return api.saveNote(course.id, extra.id, { title: nextTitle, node_ids: nodeIds || extra.node_ids, content, expected });
    // An empty title falls back to the node name.
    return api.savePersonalNote(course.id, node.id, content, expected, nextTitle === node.title ? "" : nextTitle);
  }

  async function save() {
    const submitted = draftRef.current;
    const expected = submitted.expected;
    if (saving.current || conflict || expected === null || !isUnsaved(submitted)) return;
    saving.current = true;
    setSavingNote(true);
    const result = await run("personal-note", () => request(submitted.content, expected));
    if (result) {
      // Edits made while the request was in flight remain unsaved.
      const warning = acknowledgeSaved(scope, submitted);
      if (mounted.current) setError(warning);
      onRefresh(result);
    } else if (mounted.current) {
      setError("未能保存到课程，草稿已保留。可读取最新已保存版本后核对。");
      // Do not clear the global save error with another run() call.
      try { onRefresh(await api.course(course.id)); }
      catch { setError("保存失败，且无法读取最新版本。草稿已保留，请确认本地服务运行后重试。"); }
    }
    saving.current = false;
    if (mounted.current) setSavingNote(false);
  }

  /** Title and bindings save the stored content unchanged, so a dirty draft is never sent by accident. */
  async function saveMeta(nextTitle: string, nodeIds?: string[]) {
    const clean = nextTitle.trim() || (extra ? savedTitle : node.title);
    setTitle(clean);
    if (clean === savedTitle && !nodeIds) return;
    const result = await run("note-title", () => request(saved, saved, clean, nodeIds));
    if (result) onRefresh(result);
  }

  async function createNote() {
    const result = await run("note-create", () => api.createNote(course.id, { title: `${node.title} · 新笔记`, node_ids: [node.id] }));
    const created = result?.notes?.at(-1);
    if (result) onRefresh(result);
    if (created) onOpenNote(created.id);
  }

  async function deleteNote() {
    if (!extra) return;
    const result = await run("note-delete", () => api.deleteNote(course.id, extra.id));
    if (result) { onRefresh(result); onOpenNote(""); }
  }

  const saveRef = useRef(save);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { saveRef.current = save; closeRef.current = onClose; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      } else if (event.key === "Escape" && !embedded && !event.defaultPrevented && !document.querySelector(".modal-scrim, .cm-tooltip-autocomplete")) {
        // A dialog or the slash menu above the note takes the first Escape; the draft is kept either way.
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded]);

  const appended = useRef(0);
  const updateRef = useRef(update);
  useLayoutEffect(() => { updateRef.current = update; });
  useEffect(() => {
    if (!pendingAppend || appended.current === pendingAppend.id) return;
    appended.current = pendingAppend.id;
    updateRef.current({ ...draftRef.current, content: appendBlock(draftRef.current.content, pendingAppend.text), updatedAt: new Date().toISOString() });
  }, [pendingAppend]);

  // Autosave shortly after typing stops; conflicts still wait for the user.
  useEffect(() => {
    if (!dirty || conflict) return;
    const timer = window.setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft.content, dirty, conflict]);

  const reviewDot = <NoteReviewDot controller={controller} state={review} model={reviewModel}
    aiEnabled={aiEnabled} automatic={automatic} onAutomatic={setAutomatic} action={reviewAction}
    onLocate={(id) => {
      const suggestion = controller.current(id);
      if (suggestion && !editor.current?.locate(suggestion)) controller.prune([id]);
    }} onUndo={undoSuggestion} canUndo={lastAccepted !== null && lastAccepted === draft.content} />;
  const recoverable = storage.drafts.filter((entry) => entry.id !== draft.id);
  const status = savingNote ? "正在保存…" : conflict ? "版本待核对" : dirty ? "有改动 · 即将自动保存" : "已保存";
  const boundNodes = extra ? extra.node_ids.map((id) => course.nodes.find((entry) => entry.id === id)).filter((entry): entry is LearningNode => !!entry) : [node];
  const bindable = course.nodes.filter((entry) => !boundNodes.includes(entry));
  return <section className="node-note-document" aria-label={`笔记：${savedTitle}`}>
    {!embedded && <header className="node-note-header">
      <nav aria-label="笔记位置" className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <button className="truncate hover:text-foreground" onClick={onClose}>{course.title}</button>
        <ChevronRight size={14} className="shrink-0" />
        <button className="truncate hover:text-foreground" onClick={onClose} title="回到节点详情">{node.title}</button>
        <ChevronRight size={14} className="shrink-0" />
        <span className="flex min-w-0 items-center gap-1 font-medium text-foreground"><NotebookPen size={14} className="shrink-0" /><span className="truncate">{savedTitle}</span></span>
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        <span role="status" className="text-xs text-muted-foreground">{status}</span>
        {reviewDot}
        <Button size="sm" variant="outline" onClick={onClose} aria-label="关闭笔记" title="Esc"><X /> 关闭</Button>
      </div>
    </header>}
    <div className="node-note-body">
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="这个知识点的笔记">
      {nodeNotes.map((entry) => <Button key={entry.id || "main"} size="sm" role="tab" aria-selected={entry.id === noteId}
        variant="ghost" aria-pressed={entry.id === noteId} onClick={() => onOpenNote(entry.id)}>{entry.title}</Button>)}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void createNote()}><Plus /> 新建笔记</Button>
      {embedded && <span className="ml-auto flex items-center gap-1"><span role="status" className="t-meta">{status}</span>{reviewDot}</span>}
    </div>
    <div className="flex flex-col gap-2">
      <input className="node-note-title-input" aria-label="笔记名称" maxLength={200} value={title}
        placeholder={extra ? "笔记名称" : node.title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void saveMeta(title)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
      <div className="note-binding">
        <Link2 size={13} aria-hidden /> 绑定知识点：
        {boundNodes.map((entry) => <span key={entry.id} className="chip">{entry.title}
          {extra && boundNodes.length > 1 && <button aria-label={`解除绑定 ${entry.title}`} className="text-muted-foreground hover:text-foreground"
            onClick={() => void saveMeta(title, extra.node_ids.filter((id) => id !== entry.id))}><X size={11} /></button>}
        </span>)}
        {extra && <select className="h-6 rounded-full border border-dashed border-border bg-transparent !py-0 !pl-2 !pr-1 text-xs" value=""
          aria-label="加绑知识点" disabled={busy || extra.node_ids.length >= 20}
          onChange={(event) => event.target.value && void saveMeta(title, [...extra.node_ids, event.target.value])}>
          <option value="">＋ 加绑知识点</option>
          {bindable.filter((entry) => entry.unlocked).map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
        </select>}
        {!extra && <span>（节点主笔记；跨知识点的总结可用「新建笔记」并加绑多个知识点）</span>}
      </div>
    </div>
    {(error || storage.error) && <p role="alert" className="text-xs text-destructive">{error || storage.error}</p>}
    {conflict && <div className="flex flex-col gap-2 rounded-lg border border-border p-2 text-xs">
      <p role="alert">已保存版本与草稿原版本不同，尚未覆盖任何内容，自动保存已暂停。请对照后手动合并到下方笔记，再确认。</p>
      <strong>最新已保存版本</strong><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{saved || "（空笔记）"}</pre>
      <Button size="sm" variant="outline" disabled={busy || savingNote} onClick={() => setReviewedVersion(saved)}>我已核对，准备合并</Button>
      {reviewedVersion === saved && <Button size="sm" variant="outline" disabled={busy || savingNote} onClick={() => {
        // Preserve the original draft as a separate recovery copy before rebasing.
        update(newDraft(draft.content, saved));
        setReviewedVersion(null);
      }}>确认使用下方内容</Button>}
    </div>}
    <Suspense fallback={<p className="text-sm text-muted-foreground">正在打开笔记编辑器…</p>}>
    <MarkdownNoteEditor key={scope} content={draft.content} reviewHooks={reviewHooks} onReady={(actions) => {
      editor.current = actions;
      const current = controller.snapshot();
      actions?.sync(current.suggestions, current.snapshot);
    }} onTab={() => acceptSuggestion()} onChange={(content) => {
      setReviewedVersion(null);
      update({ ...draftRef.current, content, updatedAt: new Date().toISOString() });
    }} />
    </Suspense>
    {!!recoverable.length && <details className="text-xs">
      <summary className="cursor-pointer">找回本机草稿（{recoverable.length}）</summary>
      {recoverable.map((entry) => <div key={entry.id} className="mt-2 flex flex-col gap-1 rounded-lg border border-border p-2">
        <span>{entry.updatedAt ? formatTime(entry.updatedAt) : "旧版草稿（需核对原版本）"}</span>
        <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{entry.content || "（空笔记）"}</p>
        <Button size="sm" variant="outline" disabled={savingNote} onClick={() => {
          // The current draft and the source draft remain available for recovery.
          update(newDraft(entry.content, entry.expected));
          setReviewedVersion(null);
        }}>载入此草稿</Button>
      </div>)}
    </details>}
    </div>
    <footer className="node-note-footer">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || savingNote || !dirty || conflict} onClick={() => void save()}>立即保存</Button>
        <Button size="sm" variant="ghost" disabled={busy || savingNote} onClick={() => void refreshSaved()}>读取最新已保存版本</Button>
        {extra && (confirmDelete
          ? <span className="flex items-center gap-1 text-xs">删除后可在版本历史中找回。<Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteNote()}>确认删除</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button></span>
          : <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmDelete(true)}><Trash2 /> 删除这份笔记</Button>)}
      </div>
      <p className="text-xs text-muted-foreground">停止输入约 1.5 秒后自动保存，Ctrl+S 立即保存。每次保存前都会备份课程版本。不会自动写入 Obsidian。</p>
    </footer>
  </section>;
}
