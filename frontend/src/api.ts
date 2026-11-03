import type {
  Course,
  CourseSummary,
  GoalFields,
  GoalPreview,
  PieceKind,
  Preview,
  Profile,
  RecallSummary,
  RelationKind,
  Settings,
  Strength,
} from "./types";
import type { NoteReviewResponse } from "./noteReviewTypes";
import { clearAiReceipt, endAiRequest, prepareAiReceipt } from "./aiReceipts.ts";
import type { AiTask } from './aiTaskModel';

/** FastAPI sends a string detail; a list (validation errors) is joined, never shown as [object Object]. */
function errorDetail(body: { detail?: unknown }): string {
  const { detail } = body;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail.map((item) => (typeof item === "string" ? item : String(item?.msg ?? ""))).filter(Boolean).join("；");
  return "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const prepared = await prepareAiReceipt(path, init);
  if (prepared.receipt) window.dispatchEvent(new Event('lm:ai-tasks-changed'));
  try {
    return await send<T>(path, prepared);
  } finally {
    endAiRequest(prepared.receipt);
  }
}

async function send<T>(path: string, prepared: Awaited<ReturnType<typeof prepareAiReceipt>>): Promise<T> {
  const requestInit = prepared.init;
  const headers = new Headers(requestInit.headers);
  const isMutation = !!requestInit.method && requestInit.method !== "GET";
  if (isMutation) headers.set("X-Learning-Map", "1");
  if (requestInit.body && !(requestInit.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...requestInit, headers });
  } catch {
    throw new Error("无法连接本地服务。请确认学习地图服务正在运行。");
  }
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      detail = errorDetail((await response.json()) as { detail?: unknown }) || detail;
    } catch {
      /* keep status message */
    }
    throw new Error(detail);
  }
  if (response.status === 204) {
    await clearAiReceipt(prepared.receipt);
    return undefined as T;
  }
  const result = (await response.json()) as T;
  await clearAiReceipt(prepared.receipt);
  return result;
}
type LineFields = { name: string; goal: string; node_ids: string[]; endpoint: string; story: { node_id: string; text: string }[] };
const json = (method: string, value?: unknown): RequestInit => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
});
/** Direct links to files the browser opens itself (iframes, new tabs), so they skip `request`. */
export const materialFileUrl = (cid: string, mid: string, page?: number) =>
  `/api/courses/${cid}/materials/${mid}/file${page ? `#page=${page}` : ""}`;
/** ref is "setId/imageId", as stored on a practice question. */
export const problemImageUrl = (cid: string, ref: string) => {
  const [sid, iid] = ref.split("/");
  return `/api/courses/${cid}/problem-sets/${sid}/images/${iid}`;
};
export const problemPageUrl = (cid: string, sid: string, fid: string, page: number) => `/api/courses/${cid}/problem-sets/${sid}/files/${fid}/pages/${page}`;
export const problemFileUrl = (cid: string, sid: string, fid: string) => `/api/courses/${cid}/problem-sets/${sid}/files/${fid}`;
export const lessonHtmlUrl = (cid: string, nid: string, lid: string) => `/api/courses/${cid}/nodes/${nid}/lessons/${lid}/html`;

export const api = {
  aiTasks: (cid: string) => request<AiTask[]>(`/courses/${cid}/ai-tasks`),
  aiTask: (cid: string, tid: string) => request<AiTask>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}`),
  recoverAiTask: (cid: string, tid: string) => request<{ task: AiTask; course: Course | null; result?: unknown }>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}/recover`, json('POST', {})),
  regenerateAiTask: (cid: string, tid: string, request_id: string) => request<unknown>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}/regenerate`, json('POST', { request_id })),
  organizeAiTask: (cid: string, tid: string) => request<AiTask>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}/organize`, json('POST', {})),
  importAiHistory: (cid: string) => request<{ tasks: AiTask[]; unmatched: number }>(`/courses/${cid}/ai-tasks/import-history`, json('POST', {})),
  collectAiTask: (cid: string, tid: string) => request<{ task: AiTask; course: null }>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}/collect`, json('POST', {})),
  aiTaskResult: (cid: string, tid: string) => request<{ result_ref: AiTask['result_ref']; object: unknown }>(`/courses/${cid}/ai-tasks/${encodeURIComponent(tid)}/result`),
  resetNodeConversation: (cid: string, nid: string, revision: number) => request<Course>(`/courses/${cid}/nodes/${encodeURIComponent(nid)}/conversations/reset`, json('POST', { revision })),
  reviewPersonalNote: (cid: string, nid: string, draft: { content: string; revision: number; request_id: string; note_id?: string; scope_key: string; model: string }, signal: AbortSignal) =>
    request<NoteReviewResponse>(`/courses/${cid}/nodes/${nid}/personal-note/review`, { ...json("POST", draft), signal }),
  health: () =>
    request<{
      ai: { available: boolean; [key: string]: unknown };
      deepseek: { available: boolean; reason?: string } | null;
      parser: Record<string, unknown>;
      data_dir: string;
    }>("/health"),
  courses: () => request<CourseSummary[]>("/courses"),
  course: (id: string) => request<Course>(`/courses/${id}`),
  addGoal: (cid: string, goal: GoalFields) => request<Course>(`/courses/${cid}/goals`, json("POST", goal)),
  updateGoal: (cid: string, gid: string, goal: GoalFields & { revision: number }) => request<Course>(`/courses/${cid}/goals/${gid}`, json("PUT", goal)),
  createProblemSet: (cid: string, value: { title: string; text: string; answer_text: string; files: File[]; answer_files: File[]; screenshot_mode: "each" | "one" }) => {
    const body = new FormData();
    body.append("title", value.title);
    body.append("text", value.text);
    body.append("answer_text", value.answer_text);
    body.append("screenshot_mode", value.screenshot_mode);
    value.files.forEach((file) => body.append("files", file));
    value.answer_files.forEach((file) => body.append("answer_files", file));
    return request<Course>(`/courses/${cid}/problem-sets`, { method: "POST", body });
  },
  updateProblemSet: (cid: string, sid: string, value: { revision: number; title: string; instructions: string; problems: { id: string; number: string; text: string; answer: string; node_ids: string[]; related_node_ids: string[]; key_points: string[]; images: string[]; answer_images: string[] }[] }) =>
    request<Course>(`/courses/${cid}/problem-sets/${sid}`, json("PUT", value)),
  addProblemImages: (cid: string, sid: string, pid: string, images: File[], target: "images" | "answer_images" = "images") => {
    const body = new FormData();
    images.forEach((file) => body.append("images", file));
    body.append("target", target);
    return request<Course>(`/courses/${cid}/problem-sets/${sid}/problems/${pid}/images`, { method: "POST", body });
  },
  cropProblem: (cid: string, sid: string, pid: string, value: { file_id: string; page: number; box: number[]; target: "images" | "answer_images"; replace: boolean }) =>
    request<Course>(`/courses/${cid}/problem-sets/${sid}/problems/${pid}/crop`, json("POST", value)),
  linkProblems: (cid: string, sid: string) => request<Course>(`/courses/${cid}/problem-sets/${sid}/link`, json("POST", {})),
  deleteProblemSet: (cid: string, sid: string) => request<Course>(`/courses/${cid}/problem-sets/${sid}/delete`, json("POST", {})),
  generateUnit: (cid: string, value: { material_ids: string[]; problem_set_ids: string[]; count: number; focus: string }) =>
    request<Course>(`/courses/${cid}/problem-sets/generate`, json("POST", value)),
  problemReferences: (cid: string, nid: string) =>
    request<{ set_id: string; problem_id: string; set_title: string; number: string; relation: string }[]>(`/courses/${cid}/nodes/${nid}/problem-references`),
  practiseProblem: (cid: string, nid: string, set_id: string, problem_id: string) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/question/from-problem`, json("POST", { set_id, problem_id })),
  goalCandidates: (cid: string) => request<GoalPreview>(`/courses/${cid}/goal-candidates`, json("POST", {})),
  acceptGoals: (cid: string, token: string, indices: number[]) => request<Course>(`/courses/${cid}/goals/accept`, json("POST", { token, indices })),
  savePersonalNote: (cid: string, nid: string, content: string, expected: string, title?: string) => request<Course>(`/courses/${cid}/nodes/${nid}/personal-note`, json("PUT", { content, expected, ...(title === undefined ? {} : { title }) })),
  createNote: (cid: string, note: { title: string; node_ids: string[]; content?: string; anchor?: { kind: "bridge" | "line"; id: string } }) => request<Course>(`/courses/${cid}/notes`, json("POST", note)),
  saveNote: (cid: string, id: string, note: { title: string; node_ids: string[]; content: string; expected: string }) =>
    request<Course>(`/courses/${cid}/notes/${encodeURIComponent(id)}`, json("PUT", note)),
  deleteNote: (cid: string, id: string) => request<Course>(`/courses/${cid}/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reviewScope: (id: string, value: { enabled: boolean; material_ids: string[]; ai_scope: "selected" | "course" }) =>
    request<Course>(`/courses/${id}/review-scope`, json("POST", value)),
  relationPresentation: (cid: string, rid: string, presentation: "simple" | "synthesis", revision: number) =>
    request<Course>(`/courses/${cid}/relations/${encodeURIComponent(rid)}/presentation`, json("POST", { presentation, revision })),
  confirmRelation: (cid: string, rid: string, revision: number) =>
    request<Course>(`/courses/${cid}/relations/${encodeURIComponent(rid)}/confirm`, json("POST", { revision })),
  backfillRelations: (cid: string, revision: number) =>
    request<Course>(`/courses/${cid}/relations/backfill`, json("POST", { revision })),
  findLinks: (cid: string, nid: string, revision: number) =>
    request<Course>(`/courses/${cid}/nodes/${encodeURIComponent(nid)}/links`, json("POST", { revision })),
  backfillRelation: (cid: string, rid: string, revision: number) =>
    request<Course>(`/courses/${cid}/relations/${rid}/backfill`, json("POST", { revision })),
  editBridges: (cid: string, rid: string, revision: number, bridges: { id: string; from_piece: string; to_step: string; how: string; if_missing: string; strength: Strength; check: { question: string; answer: string } }[]) =>
    request<Course>(`/courses/${cid}/relations/${encodeURIComponent(rid)}/bridges`, json("PUT", { revision, bridges })),
  editPieces: (cid: string, nid: string, revision: number, pieces: { id: string; kind: PieceKind; title: string; detail: string }[], steps: { id: string; title: string }[]) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/pieces`, json("PUT", { revision, pieces, steps })),
  checkPiece: (cid: string, nid: string, pid: string, result: "known" | "unsure") =>
    request<Course>(`/courses/${cid}/nodes/${nid}/pieces/${pid}/check`, json("POST", { result })),
  checkBridge: (cid: string, rid: string, bid: string, result: "known" | "unsure", answer = "") =>
    request<Course>(`/courses/${cid}/relations/${encodeURIComponent(rid)}/bridges/${encodeURIComponent(bid)}/check`, json("POST", { result, answer })),
  createLine: (cid: string, line: LineFields) => request<Course>(`/courses/${cid}/lines`, json("POST", line)),
  generateLines: (cid: string) => request<Course>(`/courses/${cid}/lines/generate`, json("POST", {})),
  retellLine: (cid: string, lid: string, text: string) => request<Course>(`/courses/${cid}/lines/${lid}/retell`, json("POST", { text })),
  editLine: (cid: string, lid: string, revision: number, line: LineFields) => request<Course>(`/courses/${cid}/lines/${lid}`, json("PUT", { ...line, revision })),
  deleteLine: (cid: string, lid: string, revision: number) => request<Course>(`/courses/${cid}/lines/${lid}/delete`, json("POST", { revision })),
  editRelation: (cid: string, rid: string, value: { revision: number; explanation: string; when_to_use: string; basis: string; relation: RelationKind; forward_difficulty: string; reverse_difficulty: string }) =>
    request<Course>(`/courses/${cid}/relations/${encodeURIComponent(rid)}`, json("POST", value)),
  create: (title: string) =>
    request<Course>("/courses", json("POST", { title })),
  sample: () => request<Course>("/sample", json("POST", {})),
  importFiles: (id: string, files: File[], week: string, parser: string) => {
    const body = new FormData();
    files.forEach((f) => body.append("files", f));
    body.append("week", week);
    body.append("parser", parser);
    return request<Course>(`/courses/${id}/materials`, {
      method: "POST",
      body,
    });
  },
  reparseMaterial: (id: string, mid: string, parser: "basic" | "docling") =>
    request<Course>(`/courses/${id}/materials/${mid}/reparse`, json("POST", { parser })),
  updateMaterial: (id: string, mid: string, value: { name?: string; week?: string }) =>
    request<Course>(`/courses/${id}/materials/${mid}`, json("PATCH", value)),
  generate: (id: string) =>
    request<Course>(`/courses/${id}/generate`, json("POST", {})),
  indexMaterials: (id: string, indexed: number) =>
    request<{ course: Course; indexed: number; total: number }>(`/courses/${id}/material-index`, json("POST", { indexed })),
  lesson: (cid: string, nid: string, lesson: { kind: "initial" | "supplement"; focus: string; request_id: string }) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/lessons`,
      json("POST", lesson)),
  readLesson: (cid: string, nid: string, lid: string) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/lessons/${lid}/read`, json("POST", {})),
  unreadLesson: (cid: string, nid: string, lid: string) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/lessons/${lid}/read`, json("DELETE")),
  mark: (cid: string, nid: string, status: string) =>
    request<Course>(
      `/courses/${cid}/nodes/${nid}/mark`,
      json("POST", { status }),
    ),
  chat: (cid: string, nid: string, message: string) =>
    request<Course>(
      `/courses/${cid}/nodes/${nid}/chat`,
      json("POST", { message }),
    ),
  recall: (cid: string, nid: string, q = "") =>
    request<{
      messages: {
        id: string;
        role: string;
        content: string;
        created_at: string;
      }[];
      note: string;
    }>(`/courses/${cid}/nodes/${nid}/recall?q=${encodeURIComponent(q)}`),
  recallSummary: (cid: string, nid: string) =>
    request<RecallSummary>(
      `/courses/${cid}/nodes/${nid}/recall-summary`,
      json("POST", {}),
    ),
  question: (cid: string, nid: string) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/question`, json("POST", {})),
  attempt: (
    cid: string,
    nid: string,
    answer: string,
    reference: string,
    files: File[],
    continuation?: { base_attempt_id?: string; question_key?: string },
  ) => {
    const body = new FormData();
    body.set("answer", answer);
    body.set("reference", reference);
    files.forEach((f) => body.append("files", f));
    if (continuation?.base_attempt_id) body.set("base_attempt_id", continuation.base_attempt_id);
    if (continuation?.question_key) body.set("question_key", continuation.question_key);
    return request<Course>(`/courses/${cid}/nodes/${nid}/attempts`, {
      method: "POST",
      body,
    });
  },
  resolve: (cid: string, nid: string, aid: string, decision: string) =>
    request<Course>(
      `/courses/${cid}/nodes/${nid}/attempts/${aid}/resolve`,
      json("POST", { decision }),
    ),
  rate: (
    cid: string,
    nid: string,
    aid: string,
    value: {
      problem: number | null;
      mastery: number | null;
      comment: string;
      skip: boolean;
    },
  ) =>
    request<Course>(
      `/courses/${cid}/nodes/${nid}/attempts/${aid}/rating`,
      json("POST", value),
    ),
  profile: () => request<Profile>("/profile"),
  acceptStage: (id: string) =>
    request<Profile>(`/profile/stages/${id}/accept`, json("POST", {})),
  acceptSuggestion: (cid: string, sid: string) =>
    request<Course>(
      `/courses/${cid}/suggestions/${sid}/accept`,
      json("POST", {}),
    ),
  versions: (id: string) =>
    request<
      {
        id: string;
        created_at: string;
        reason: string;
        node_count: number;
        revision: number;
      }[]
    >(`/courses/${id}/versions`),
  snapshot: (id: string) =>
    request<Course>(`/courses/${id}/snapshot`, json("POST", {})),
  restorePreview: (id: string, version_id: string) =>
    request<Preview>(
      `/courses/${id}/restore-preview`,
      json("POST", { version_id }),
    ),
  restore: (id: string, token: string) =>
    request<Course>(`/courses/${id}/restore`, json("POST", { token })),
  deletePreview: (id: string) =>
    request<Preview>(`/courses/${id}/delete-preview`, json("POST", {})),
  delete: (id: string, token: string) =>
    request<{ deleted: boolean }>(
      `/courses/${id}/delete`,
      json("POST", { token }),
    ),
  settings: () => request<Settings>("/settings"),
  saveSettings: (value: Partial<Settings>) =>
    request<Settings>("/settings", json("POST", value)),
  notes: (q: string) =>
    request<{ path: string; content: string }[]>(
      `/obsidian/notes?q=${encodeURIComponent(q)}`,
    ),
  notePreview: (path: string, content: string) =>
    request<Preview>("/obsidian/preview", json("POST", { path, content })),
  noteWrite: (token: string) =>
    request<{ path: string }>("/obsidian/write", json("POST", { token })),
};
