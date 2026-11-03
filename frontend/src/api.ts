import type {
  Course,
  CourseSummary,
  Preview,
  Profile,
  RecallSummary,
  Settings,
} from "./types";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const isMutation = !!init.method && init.method !== "GET";
  if (isMutation) headers.set("X-Learning-Map", "1");
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new Error("无法连接本地服务。请确认学习地图服务正在运行。");
  }
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      detail =
        ((await response.json()) as { detail?: string }).detail || detail;
    } catch {
      /* keep status message */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (method: string, value?: unknown): RequestInit => ({
  method,
  body: value === undefined ? undefined : JSON.stringify(value),
});
export const api = {
  health: () =>
    request<{
      ai: { available: boolean; [key: string]: unknown };
      parser: Record<string, unknown>;
      data_dir: string;
    }>("/health"),
  courses: () => request<CourseSummary[]>("/courses"),
  course: (id: string) => request<Course>(`/courses/${id}`),
  reviewScope: (id: string, value: { enabled: boolean; material_ids: string[]; ai_scope: "selected" | "course" }) =>
    request<Course>(`/courses/${id}/review-scope`, json("POST", value)),
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
  generate: (id: string) =>
    request<Course>(`/courses/${id}/generate`, json("POST", {})),
  lesson: (cid: string, nid: string, lesson: { kind: "initial" | "supplement"; focus: string; request_id: string }) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/lessons`,
      json("POST", lesson)),
  readLesson: (cid: string, nid: string, lid: string) =>
    request<Course>(`/courses/${cid}/nodes/${nid}/lessons/${lid}/read`, json("POST", {})),
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
  ) => {
    const body = new FormData();
    body.set("answer", answer);
    body.set("reference", reference);
    files.forEach((f) => body.append("files", f));
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
