const STORAGE_KEY = "learning-map:ai-request-receipts:v1";
const receiptIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const inputHashPattern = /^[0-9a-f]{64}$/i;

export type AiReceipt = {
  id: string;
  scope: string;
  inputHash: string;
};

type StoredReceipt = AiReceipt & { createdAt: string; settled?: boolean };

/** Recovery hints contain identities only; full inputs and replies stay in the backend ledger. */
export function aiReceiptHints(courseId: string) {
  return readStored().filter((receipt) => !receipt.settled && receipt.scope.includes(`/courses/${courseId}/`));
}

export function regenerationRequestId(courseId: string, taskId: string) {
  const identityPattern = /^[a-f0-9]{32}$/;
  if (!identityPattern.test(courseId) || !identityPattern.test(taskId)) {
    throw new Error("AI 任务身份无效，无法安全创建再生成请求。");
  }
  return `regenerate-${courseId}-${taskId}`;
}

const generationPaths = [
  /^\/courses\/[^/]+\/generate$/,
  /^\/courses\/[^/]+\/material-index$/,
  /^\/courses\/[^/]+\/nodes\/[^/]+\/(?:chat|question|recall-summary|lessons|attempts)$/,
  /^\/courses\/[^/]+\/relations\/(?:[^/]+\/)?backfill$/,
  /^\/courses\/[^/]+\/nodes\/[^/]+\/personal-note\/review$/,
  /^\/courses\/[^/]+\/goal-candidates$/,
  /^\/courses\/[^/]+\/problem-sets\/generate$/,
  /^\/courses\/[^/]+\/lines\/generate$/,
  /^\/courses\/[^/]+\/lines\/[^/]+\/retell$/,
];

function routePath(path: string) {
  const pathname = path.split("?", 1)[0].replace(/^\/api(?=\/)/, "");
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function isGenerationPath(path: string) {
  return generationPaths.some((pattern) => pattern.test(routePath(path)));
}

function keepsBodyRequestId(path: string) {
  return /^\/courses\/[^/]+\/nodes\/[^/]+\/personal-note\/review$/.test(routePath(path));
}

function stable(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(input);
}

async function describeBody(body: BodyInit | null | undefined, path: string) {
  if (body instanceof FormData) {
    const entries = await Promise.all(Array.from(body.entries(), async ([name, value]) => [
      name,
      typeof value === "string"
        ? { kind: "text", value }
        : {
            kind: "file",
            filename: value.name,
            size: value.size,
            lastModified: value.lastModified,
            type: value.type,
            contentHash: await hashBytes(await value.arrayBuffer()),
          },
    ]));
    return { kind: "form-data", entries };
  }
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const input = { ...(parsed as Record<string, unknown>) };
        delete input.request_id;
        if (keepsBodyRequestId(path)) delete input.revision;
        return { kind: "json", value: input };
      }
    } catch {
      // Preserve non-JSON request bodies as input to the identity hash.
    }
    return { kind: "text", value: body };
  }
  return { kind: "empty" };
}

async function hashBytes(bytes: BufferSource) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("当前浏览器无法安全生成请求身份；请求尚未发送，请稍后重试。");
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashInput(value: unknown) {
  return hashBytes(new TextEncoder().encode(stable(value)));
}

function newId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("当前浏览器无法安全生成请求身份；请求尚未发送。");
}

function readStored(): StoredReceipt[] {
  const raw = globalThis.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records) || records.some((record) =>
    !record || !receiptIdPattern.test(record.id) || typeof record.scope !== "string" || !record.scope
      || !inputHashPattern.test(record.inputHash) || typeof record.createdAt !== "string"
      || (record.settled !== undefined && typeof record.settled !== "boolean"))) {
    throw new Error("本地 AI 请求记录无法读取；为避免重复生成，请求尚未发送。");
  }
  return records as StoredReceipt[];
}

async function withReceiptLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager) throw new Error("当前浏览器不支持跨标签页请求锁；为避免重复生成，请求尚未发送。");
  return lockManager.request(STORAGE_KEY, operation);
}

function storageError(error: unknown, message: string): Error {
  return new Error(`${message}${error instanceof Error ? `（${error.message}）` : ""}`);
}

export async function prepareAiReceipt(path: string, init: RequestInit) {
  if (!isGenerationPath(path)) return { init, receipt: null as AiReceipt | null };

  const method = (init.method || "GET").toUpperCase();
  const scope = `${method} ${path}`;
  const inputHash = await hashInput(await describeBody(init.body, path));
  let receipt: StoredReceipt;
  try {
    receipt = await withReceiptLock(() => {
      const stored = readStored();
      const previous = stored.find((item) => item.scope === scope && item.inputHash === inputHash);
      if (previous) return previous;
      const created: StoredReceipt = { id: newId(), scope, inputHash, createdAt: new Date().toISOString() };
      globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([...stored, created]));
      return created;
    });
  } catch (error) {
    throw storageError(error, "无法持久保存 AI 请求身份，请检查浏览器本地存储；请求尚未发送");
  }

  const headers = new Headers(init.headers);
  headers.set("X-AI-Request-ID", receipt.id);
  let body = init.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && "request_id" in parsed && !keepsBodyRequestId(path)) {
        body = JSON.stringify({ ...(parsed as Record<string, unknown>), request_id: receipt.id });
      }
    } catch {
      // Non-JSON bodies use the request header as their durable identity.
    }
  }
  return { init: { ...init, headers, body }, receipt };
}

export async function clearAiReceipt(receipt: AiReceipt | null) {
  if (!receipt) return;
  try {
    await withReceiptLock(() => {
      const stored = readStored();
      if (keepsBodyRequestId(receipt.scope.split(" ").slice(1).join(" "))) {
        globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored.map((item) =>
          item.id === receipt.id ? { ...item, settled: true } : item)));
        return;
      }
      const remaining = stored.filter((item) => item.id !== receipt.id);
      globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
    });
  } catch (error) {
    throw storageError(error, "请求已成功，但本地身份记录未能清除；刷新后可安全读取已保存结果");
  }
}
