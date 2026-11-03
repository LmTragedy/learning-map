export type AnswerDraft = {
  answer: string;
  reference: string;
  files: File[];
  warning: string;
};

const drafts = new Map<string, AnswerDraft>();
const listeners = new Set<() => void>();
const prefix = "learning-map:answer-draft:";
const storageWarning = "浏览器无法保存作答草稿，内容暂留在当前页面。请勿刷新或关闭页面。";

export function answerDraft(scope: string): AnswerDraft {
  const existing = drafts.get(scope);
  if (existing) return existing;
  const draft: AnswerDraft = { answer: "", reference: "", files: [], warning: "" };
  try {
    const raw = localStorage.getItem(prefix + scope);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (!stored || typeof stored !== "object" || !("answer" in stored)
        || !("reference" in stored) || typeof stored.answer !== "string"
        || typeof stored.reference !== "string") throw new Error("Invalid answer draft");
      draft.answer = stored.answer;
      draft.reference = stored.reference;
    }
  } catch {
    draft.warning = "无法读取浏览器作答草稿，原数据已保留。请检查浏览器存储设置。";
  }
  drafts.set(scope, draft);
  return draft;
}

export function subscribeAnswerDrafts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function updateAnswerDraft(scope: string, fields: Partial<Pick<AnswerDraft, "answer" | "reference" | "files">>) {
  const draft = { ...answerDraft(scope), ...fields, warning: "" };
  try {
    if (draft.answer || draft.reference) {
      localStorage.setItem(prefix + scope, JSON.stringify({ answer: draft.answer, reference: draft.reference }));
    } else localStorage.removeItem(prefix + scope);
  } catch {
    draft.warning = storageWarning;
  }
  drafts.set(scope, draft);
  listeners.forEach((listener) => listener());
}

export function completeAnswerDraft(scope: string, submitted: AnswerDraft) {
  // A late response must not erase text or attachments added during submission.
  if (answerDraft(scope) !== submitted) return;
  updateAnswerDraft(scope, { answer: "", files: [] });
}

export function hasVolatileAnswerDrafts() {
  return [...drafts.values()].some((draft) => draft.files.length > 0
    || (!!draft.warning && !!(draft.answer || draft.reference)));
}
