export type NoteDraft = {
  id: string;
  content: string;
  expected: string | null;
  updatedAt: string;
};

const active = new Map<string, NoteDraft>();
const unsaved = new Map<string, { scope: string; draft: NoteDraft }>();
const unsafe = new Set<string>();
const prefix = "learning-map:note-draft:";
const storageWarning = "浏览器草稿存储不可用，未保存内容暂留当前页面。关闭前请确认已保存到课程。";

export function noteScope(courseId: string, nodeId: string) {
  return `${prefix}${courseId}:${nodeId}`;
}

export function newDraft(content: string, expected: string | null): NoteDraft {
  return { id: crypto.randomUUID(), content, expected, updatedAt: new Date().toISOString() };
}

export function currentDraft(scope: string, saved: string) {
  const existing = active.get(scope);
  if (existing && (isUnsaved(existing) || existing.expected === saved)) return existing;
  const draft = newDraft(saved, saved);
  active.set(scope, draft);
  return draft;
}

export function isUnsaved(draft: NoteDraft) {
  return draft.expected === null || draft.content !== draft.expected;
}

// Each editor has its own key. Never remove or overwrite another window's draft.
function persistDraft(scope: string, draft: NoteDraft): string {
  const key = `${scope}:${draft.id}`;
  if (isUnsaved(draft)) unsaved.set(key, { scope, draft });
  else unsaved.delete(key);
  try {
    if (isUnsaved(draft)) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
    unsafe.delete(key);
    return "";
  } catch {
    unsafe.add(key);
    return storageWarning;
  } finally {
    window.dispatchEvent(new Event("note-drafts-changed"));
  }
}

export function keepDraft(scope: string, draft: NoteDraft): string {
  active.set(scope, draft);
  return persistDraft(scope, draft);
}

export function activeDraft(scope: string) {
  return active.get(scope);
}

export function acknowledgeSaved(scope: string, submitted: NoteDraft) {
  const editing = active.get(scope);
  const latest = editing?.id === submitted.id ? editing : unsaved.get(`${scope}:${submitted.id}`)?.draft;
  if (!latest) return "";
  const acknowledged = { ...latest, expected: submitted.content };
  if (editing?.id === submitted.id) active.set(scope, acknowledged);
  return persistDraft(scope, acknowledged);
}

export function storedDrafts(scope: string): { drafts: NoteDraft[]; error: string } {
  const drafts = new Map<string, NoteDraft>();
  let error = "";
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || (key !== scope && !key.startsWith(`${scope}:`))) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      if (key === scope) {
        // Old drafts did not retain a baseline. Require explicit conflict review.
        drafts.set("legacy", { id: "legacy", content: raw, expected: null, updatedAt: "" });
        continue;
      }
      try {
        const draft = JSON.parse(raw) as NoteDraft;
        if (typeof draft.id !== "string" || key !== `${scope}:${draft.id}`
          || typeof draft.content !== "string" || draft.content.length > 100000
          || (draft.expected !== null && typeof draft.expected !== "string")
          || typeof draft.updatedAt !== "string") throw new Error("Invalid draft");
        drafts.set(draft.id, draft);
      } catch {
        error = "有一份浏览器草稿无法读取，原数据已保留。";
      }
    }
  } catch {
    error = storageWarning;
  }
  for (const { scope: storedScope, draft } of unsaved.values()) {
    if (storedScope === scope) drafts.set(draft.id, draft);
  }
  if ([...unsafe].some((key) => key.startsWith(`${scope}:`))) error = storageWarning;
  return { drafts: [...drafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), error };
}

export function hasUnsavedNotes() {
  return [...active.values()].some(isUnsaved) || unsafe.size > 0;
}
