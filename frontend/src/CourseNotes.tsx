import { useEffect, useState } from "react";
import { NotebookPen, Search } from "lucide-react";
import { Button } from "./components/ui/button";
import { noteScope, storedDrafts } from "./noteDrafts";
import { mainNoteTitle, plainPreview } from "./noteFormatting";
import type { Course, LearningNode } from "./types";

type Entry = { node: LearningNode; noteId: string; title: string; content: string; drafts: number; also: string[] };

export function CourseNotes({ course, onOpen, onExitReview }: {
  course: Course;
  onOpen: (node: LearningNode, noteId?: string) => void;
  onExitReview: () => void;
}) {
  const [, refresh] = useState(0);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const reload = () => refresh((value) => value + 1);
    window.addEventListener("storage", reload);
    window.addEventListener("note-drafts-changed", reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener("note-drafts-changed", reload);
    };
  }, []);
  let unreadable = false;
  const draftsOf = (scope: string) => {
    const stored = storedDrafts(scope);
    unreadable ||= Boolean(stored.error);
    return stored.drafts.length;
  };
  const byId = new Map(course.nodes.map((node) => [node.id, node]));
  // Notes are grouped under each node they are bound to, so a shared note appears in every group.
  const groups = course.nodes.map((node) => {
    const entries: Entry[] = [];
    const drafts = draftsOf(noteScope(course.id, node.id));
    if (node.personal_note || drafts) entries.push({ node, noteId: "", title: mainNoteTitle(node), content: node.personal_note || "", drafts, also: [] });
    for (const note of course.notes || []) {
      if (!note.node_ids.includes(node.id)) continue;
      entries.push({ node, noteId: note.id, title: note.title, content: note.content, drafts: draftsOf(noteScope(course.id, `note:${note.id}`)),
        also: note.node_ids.filter((id) => id !== node.id).map((id) => byId.get(id)?.title || "").filter(Boolean) });
    }
    return { node, entries };
  });
  const needle = query.trim().toLowerCase();
  const visible = groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => !needle
    || entry.title.toLowerCase().includes(needle) || entry.content.toLowerCase().includes(needle)
    || group.node.title.toLowerCase().includes(needle)) })).filter((group) => group.entries.length);
  const total = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.noteId || `main:${entry.node.id}`))).size;
  return <div className="modal-body">
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-field px-2.5 text-muted-foreground">
        <Search size={15} aria-hidden />
        <input type="search" className="!m-0 min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-sm text-foreground !shadow-none outline-none"
          placeholder="搜索笔记名称、正文或知识点" aria-label="搜索笔记" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <span className="text-sm text-muted-foreground">共 {total} 份笔记</span>
    </div>
    <p className="text-sm text-muted-foreground">按知识点分组。点击后在学习工作台中打开，可以同时看原课程材料、和 AI 对话。</p>
    {unreadable && <p role="alert">部分本机草稿无法读取，原数据已保留。</p>}
    {visible.length ? visible.map(({ node, entries }) => {
      const outside = course.review_scope.enabled && !course.review_scope.node_ids.includes(node.id);
      return <section key={node.id} className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{node.title}</h3>
        {entries.map((entry) => <button key={entry.noteId || "main"} className="note-result text-left disabled:opacity-60" disabled={outside}
          onClick={() => onOpen(node, entry.noteId)}>
          <strong className="flex items-center gap-1.5"><NotebookPen size={14} aria-hidden />{entry.title}</strong>
          <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{plainPreview(entry.content) || "尚未保存到课程"}</p>
          <span className="text-xs text-muted-foreground">
            {entry.noteId ? (course.notes?.find((note) => note.id === entry.noteId)?.anchor?.kind === "line" ? "主线笔记" : course.notes?.find((note) => note.id === entry.noteId)?.anchor?.kind === "bridge" ? "知识桥笔记" : "独立笔记") : "节点主笔记"}
            {entry.also.length ? ` · 同时绑定：${entry.also.join("、")}` : ""}
            {entry.drafts ? ` · 本机草稿 ${entry.drafts}` : ""}
          </span>
        </button>)}
        {outside && <div className="text-xs text-muted-foreground">此节点不在本次复习范围。<Button size="sm" variant="ghost" onClick={onExitReview}>退出复习后访问</Button></div>}
      </section>;
    }) : <p>{needle ? "没有匹配的笔记。" : "本课程还没有笔记。在知识点详情点「笔记」开始写。"}</p>}
  </div>;
}
