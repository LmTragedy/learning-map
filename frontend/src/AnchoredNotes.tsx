import { NotebookPen, Plus } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import type { Course, CourseNote, LearningNode } from "./types";

/** Reuses the Markdown workbench for notes attached to a bridge or a main line. */
export function AnchoredNotes({ course, anchor, nodeIds, title, busy, act, onOpen }: {
  course: Course; anchor: NonNullable<CourseNote["anchor"]>; nodeIds: string[]; title: string; busy: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onOpen: (node: LearningNode, noteId: string) => void;
}) {
  const node = course.nodes.find((entry) => nodeIds.includes(entry.id));
  const notes = (course.notes || []).filter((note) => note.anchor?.kind === anchor.kind && note.anchor.id === anchor.id);
  const create = async () => {
    if (!node) return;
    const updated = await act("anchor-note", () => api.createNote(course.id, {
      title: `${title} · 笔记`, node_ids: nodeIds.slice(0, 20), anchor,
    }));
    const created = updated?.notes?.at(-1);
    if (created) onOpen(node, created.id);
  };
  return <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
    <span className="text-xs text-muted-foreground"><NotebookPen size={13} className="mr-1 inline" />{anchor.kind === "line" ? "主线笔记" : "桥笔记"}</span>
    {notes.map((note) => <Button key={note.id} size="sm" variant="outline" disabled={!node} onClick={() => node && onOpen(node, note.id)}>{note.title}</Button>)}
    <Button size="sm" variant="ghost" disabled={busy || !node} onClick={() => void create()}><Plus />新建笔记</Button>
  </div>;
}
