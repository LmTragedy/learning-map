import { useState } from "react";

export type MaterialView = { materialId: string; page: number };
export type SourceKind = "lesson" | "material";

/**
 * What the study workbench has open for one node. A lesson and a material page are separate
 * tabs, so opening one never closes the other.
 */
export function useWorkbenchState(initialNote = false, initialNoteId?: string) {
  const [noteOpen, setNoteOpen] = useState(initialNote);
  const [noteId, setNoteId] = useState(initialNoteId);
  const [lessonId, setLessonId] = useState("");
  const [material, setMaterial] = useState<MaterialView | null>(null);
  const [active, setActive] = useState<SourceKind>("material");
  const [pendingAppend, setPendingAppend] = useState<{ id: number; text: string }>();
  return {
    noteOpen, noteId, lessonId, material, active, pendingAppend,
    setNoteId,
    openNote: () => setNoteOpen(true),
    closeNote: () => setNoteOpen(false),
    toggleNote: () => setNoteOpen((open) => !open),
    // Sending text to the note opens it, so an excerpt is never lost in a closed pane.
    appendToNote: (text: string) => { setPendingAppend({ id: Date.now(), text }); setNoteOpen(true); },
    openMaterial: (view: MaterialView) => { setMaterial(view); setActive("material"); },
    openLesson: (id: string) => { setLessonId(id); setActive("lesson"); },
    closeMaterial: () => { setMaterial(null); setActive("lesson"); },
    closeLesson: () => { setLessonId(""); setActive("material"); },
    activate: setActive,
    closeAll: () => { setNoteOpen(false); setMaterial(null); setLessonId(""); },
  };
}
