import { useState } from "react";

export type MaterialView = { materialId: string; page: number };
/** "lesson" and "practice" are the two study modes; "material" is an open page tab beside them. */
export type SourceKind = "lesson" | "practice" | "material";

/**
 * What the study workbench has open for one node. The study modes and a material page are
 * separate, so opening one never closes the other.
 */
export function useWorkbenchState(initialNote = false, initialNoteId?: string) {
  const [noteOpen, setNoteOpen] = useState(initialNote);
  const [noteId, setNoteId] = useState(initialNoteId);
  const [study, setStudy] = useState(false);
  const [lessonId, setLessonId] = useState("");
  const [material, setMaterial] = useState<MaterialView | null>(null);
  const [active, setActive] = useState<SourceKind>("material");
  const [pendingAppend, setPendingAppend] = useState<{ id: number; text: string }>();
  const activate = (kind: SourceKind) => {
    if (kind !== "material") setStudy(true);
    setActive(kind);
  };
  return {
    noteOpen, noteId, study, lessonId, material, active, pendingAppend,
    setNoteId,
    openNote: () => setNoteOpen(true),
    closeNote: () => setNoteOpen(false),
    toggleNote: () => setNoteOpen((open) => !open),
    // Sending text to the note opens it, so an excerpt is never lost in a closed pane.
    appendToNote: (text: string) => { setPendingAppend({ id: Date.now(), text }); setNoteOpen(true); },
    openMaterial: (view: MaterialView) => { setMaterial(view); setActive("material"); },
    /** Opens the lesson mode; without an id it shows the node's latest lesson, or the empty state. */
    openLesson: (id = "") => { if (id) setLessonId(id); activate("lesson"); },
    selectLesson: setLessonId,
    openPractice: () => activate("practice"),
    closeMaterial: () => { setMaterial(null); setActive("lesson"); },
    activate,
    closeAll: () => { setNoteOpen(false); setMaterial(null); setStudy(false); setLessonId(""); },
  };
}
