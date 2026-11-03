import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};
globalThis.window = { dispatchEvent() { return true; } };
let lockTail = Promise.resolve();
const testLocks = {
  request(_name, callback) {
    const locked = lockTail.then(callback);
    lockTail = locked.then(() => undefined, () => undefined);
    return locked;
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: testLocks },
});

const { aiReceiptHints, clearAiReceipt, dropAiReceipts, prepareAiReceipt, regenerationRequestId } = await import("../src/aiReceipts.ts");
const { api } = await import("../src/api.ts");
const receiptKey = "learning-map:ai-request-receipts:v1";

function reset() { values.clear(); }
function request(body) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

test("pending requests reuse their durable identity while excluding body request_id", async () => {
  reset();
  const reloaded = await import(`../src/aiReceipts.ts?reload=${Date.now()}`);
  const [first, second] = await Promise.all([
    prepareAiReceipt("/courses/c1/nodes/n1/lessons", request({ kind: "initial", request_id: "fresh-a" })),
    reloaded.prepareAiReceipt("/courses/c1/nodes/n1/lessons", request({ kind: "initial", request_id: "fresh-b" })),
  ]);
  assert.equal(first.receipt.id, second.receipt.id);
  assert.equal(JSON.parse(second.init.body).request_id, first.receipt.id);
  assert.equal(JSON.parse(values.get(receiptKey)).length, 1);
  assert.equal(aiReceiptHints("c1")[0].id, first.receipt.id);
  assert.equal(values.get(receiptKey).includes("initial"), false);
  await clearAiReceipt(first.receipt);
});

test("successful request clears its receipt so the same input starts a new action", async () => {
  reset();
  const first = await prepareAiReceipt("/courses/c1/generate", request({}));
  await clearAiReceipt(first.receipt);
  const next = await prepareAiReceipt("/courses/c1/generate", request({}));
  assert.notEqual(next.receipt.id, first.receipt.id);
});

test("attempt identity includes text and file content while never storing either", async () => {
  reset();
  const form = new globalThis.FormData();
  form.set("answer", "private answer text");
  form.append("files", new globalThis.File(["private attachment"], "work.pdf", { type: "application/pdf", lastModified: 123 }));
  const first = await prepareAiReceipt("/courses/c1/nodes/n1/attempts", { method: "POST", body: form });
  const another = new globalThis.FormData();
  another.set("answer", "different answer");
  another.append("files", new globalThis.File(["private attachment"], "work.pdf", { type: "application/pdf", lastModified: 123 }));
  const second = await prepareAiReceipt("/courses/c1/nodes/n1/attempts", { method: "POST", body: another });
  assert.notEqual(first.receipt.id, second.receipt.id);
  const saved = values.get(receiptKey);
  assert.equal(saved.includes("private answer text"), false);
  assert.equal(saved.includes("private attachment"), false);
});

test("same attachment metadata with different bytes receives a different request identity", async () => {
  reset();
  const createForm = (contents) => {
    const form = new globalThis.FormData();
    form.set("answer", "same text");
    form.append("files", new globalThis.File([contents], "same.pdf", {
      type: "application/pdf",
      lastModified: 456,
    }));
    return form;
  };
  const first = await prepareAiReceipt("/courses/c1/nodes/n1/attempts", { method: "POST", body: createForm("first bytes") });
  const second = await prepareAiReceipt("/courses/c1/nodes/n1/attempts", { method: "POST", body: createForm("other bytes") });
  assert.notEqual(first.receipt.id, second.receipt.id);
});

test("API sends and retains the receipt on failure, then clears it after parsed success", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const ids = [];
  try {
    globalThis.fetch = async (_url, init) => {
      ids.push(new globalThis.Headers(init.headers).get("X-AI-Request-ID"));
      assert.deepEqual(JSON.parse(init.body), { message: "same question" });
      throw new Error("connection lost");
    };
    await assert.rejects(api.chat("c1", "n1", "same question"), /无法连接/);
    const stored = JSON.parse(values.get(receiptKey));
    assert.equal(stored.length, 1);
    globalThis.fetch = async (_url, init) => {
      ids.push(new globalThis.Headers(init.headers).get("X-AI-Request-ID"));
      assert.deepEqual(JSON.parse(init.body), { message: "same question" });
      return new globalThis.Response(JSON.stringify({ detail: "service unavailable" }), { status: 503 });
    };
    await assert.rejects(api.chat("c1", "n1", "same question"), /service unavailable/);
    assert.equal(JSON.parse(values.get(receiptKey)).length, 1);
    globalThis.fetch = async (_url, init) => {
      ids.push(new globalThis.Headers(init.headers).get("X-AI-Request-ID"));
      assert.deepEqual(JSON.parse(init.body), { message: "same question" });
      return new globalThis.Response("not JSON", { status: 200 });
    };
    await assert.rejects(api.chat("c1", "n1", "same question"));
    assert.equal(JSON.parse(values.get(receiptKey)).length, 1);
    globalThis.fetch = async (_url, init) => {
      ids.push(new globalThis.Headers(init.headers).get("X-AI-Request-ID"));
      assert.deepEqual(JSON.parse(init.body), { message: "same question" });
      return new globalThis.Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    assert.deepEqual(await api.chat("c1", "n1", "same question"), { ok: true });
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[1], ids[2]);
    assert.equal(ids[2], ids[3]);
    assert.equal(JSON.parse(values.get(receiptKey)).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a receipt is in flight only while this page is still sending its request", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  try {
    let during;
    globalThis.fetch = async () => {
      during = aiReceiptHints("c1").map((hint) => hint.inFlight);
      throw new Error("connection lost");
    };
    await assert.rejects(api.chat("c1", "n1", "in flight"), /无法连接/);
    assert.deepEqual(during, [true]);
    assert.deepEqual(aiReceiptHints("c1").map((hint) => hint.inFlight), [false]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dropping orphan receipts keeps any request that is still in flight", async () => {
  reset();
  const orphan = await prepareAiReceipt("/courses/c1/nodes/n1/chat", request({ message: "orphan" }));
  const { endAiRequest } = await import("../src/aiReceipts.ts");
  endAiRequest(orphan.receipt);
  const sending = await prepareAiReceipt("/courses/c1/nodes/n1/chat", request({ message: "sending" }));
  await dropAiReceipts([orphan.receipt.id, sending.receipt.id]);
  assert.deepEqual(aiReceiptHints("c1").map((hint) => hint.id), [sending.receipt.id]);
  endAiRequest(sending.receipt);
  await clearAiReceipt(sending.receipt);
});

test("lesson body request_id is replaced but retell gets identity only in its header", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, init) => {
      requests.push({ headers: new globalThis.Headers(init.headers), body: JSON.parse(init.body) });
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    };
    await api.lesson("c1", "n1", { kind: "initial", focus: "", request_id: "ui-generated-id" });
    assert.equal(requests[0].body.request_id, requests[0].headers.get("X-AI-Request-ID"));
    assert.notEqual(requests[0].body.request_id, "ui-generated-id");

    await api.retellLine("c1", "line-1", "我的串讲");
    assert.equal(requests[1].headers.get("X-AI-Request-ID") !== null, true);
    assert.deepEqual(requests[1].body, { text: "我的串讲" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("personal note refresh reuses its settled action identity and preserves UI correlation IDs", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const attempts = [];
  try {
    globalThis.fetch = async (_url, init) => {
      attempts.push({ headers: new globalThis.Headers(init.headers), body: JSON.parse(init.body) });
      throw new Error("connection lost");
    };
    await assert.rejects(api.reviewPersonalNote(
      "c1",
      "n1",
      { content: "待检查", revision: 2, request_id: "ui-correlation-id" },
      new globalThis.AbortController().signal,
    ), /无法连接/);
    globalThis.fetch = async (_url, init) => {
      attempts.push({ headers: new globalThis.Headers(init.headers), body: JSON.parse(init.body) });
      return new globalThis.Response(JSON.stringify({ request_id: attempts.at(-1).body.request_id }), { status: 200 });
    };
    const response = await api.reviewPersonalNote(
      "c1",
      "n1",
      { content: "待检查", revision: 3, request_id: "new-ui-correlation" },
      new globalThis.AbortController().signal,
    );
    assert.equal(response.request_id, "new-ui-correlation");
    assert.equal(attempts[0].body.request_id, "ui-correlation-id");
    assert.equal(attempts[1].body.request_id, "new-ui-correlation");
    assert.notEqual(attempts[0].headers.get("X-AI-Request-ID"), "ui-correlation-id");
    assert.equal(attempts[0].headers.get("X-AI-Request-ID"), attempts[1].headers.get("X-AI-Request-ID"));
    assert.equal(JSON.parse(values.get(receiptKey))[0].settled, true);
    assert.deepEqual(aiReceiptHints("c1"), []);

    const refreshed = await api.reviewPersonalNote(
      "c1",
      "n1",
      { content: "待检查", revision: 4, request_id: "refresh-ui-correlation" },
      new globalThis.AbortController().signal,
    );
    assert.equal(refreshed.request_id, "refresh-ui-correlation");
    assert.equal(attempts[2].body.request_id, "refresh-ui-correlation");
    assert.equal(attempts[1].headers.get("X-AI-Request-ID"), attempts[2].headers.get("X-AI-Request-ID"));
    assert.deepEqual(aiReceiptHints("c1"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settled note review identity ignores autosave revision but includes scope, model, and named note", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const attempts = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      attempts.push({ id: new globalThis.Headers(init.headers).get("X-AI-Request-ID"), body });
      return new globalThis.Response(JSON.stringify({ request_id: body.request_id }), { status: 200 });
    };

    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 2, request_id: "ui-a", note_id: "named-a",
      scope_key: "selected:materials-a", model: "gpt-6-luna",
    }, new globalThis.AbortController().signal);
    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 3, request_id: "ui-b", note_id: "named-a",
      scope_key: "selected:materials-a", model: "gpt-6-luna",
    }, new globalThis.AbortController().signal);
    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 4, request_id: "ui-c", note_id: "named-a",
      scope_key: "selected:materials-a", model: "gpt-6-luna",
    }, new globalThis.AbortController().signal);
    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 5, request_id: "ui-d", note_id: "named-a",
      scope_key: "selected:materials-b", model: "gpt-6-luna",
    }, new globalThis.AbortController().signal);
    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 6, request_id: "ui-e", note_id: "named-a",
      scope_key: "selected:materials-a", model: "gpt-6-astra",
    }, new globalThis.AbortController().signal);
    await api.reviewPersonalNote("c1", "n1", {
      content: "same note text", revision: 7, request_id: "ui-f", note_id: "named-b",
      scope_key: "selected:materials-a", model: "gpt-6-luna",
    }, new globalThis.AbortController().signal);

    assert.equal(attempts[0].id, attempts[1].id);
    assert.equal(attempts[1].id, attempts[2].id);
    assert.notEqual(attempts[0].id, attempts[3].id);
    assert.notEqual(attempts[0].id, attempts[4].id);
    assert.notEqual(attempts[0].id, attempts[5].id);
    assert.deepEqual(attempts.map(({ body }) => [body.scope_key, body.model]), [
      ["selected:materials-a", "gpt-6-luna"], ["selected:materials-a", "gpt-6-luna"],
      ["selected:materials-a", "gpt-6-luna"], ["selected:materials-b", "gpt-6-luna"],
      ["selected:materials-a", "gpt-6-astra"], ["selected:materials-a", "gpt-6-luna"],
    ]);
    assert.deepEqual(attempts.map(({ body }) => body.request_id), ["ui-a", "ui-b", "ui-c", "ui-d", "ui-e", "ui-f"]);
    assert.equal(JSON.parse(values.get(receiptKey)).length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("revision remains part of non-note generation identity", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const ids = [];
  try {
    globalThis.fetch = async (_url, init) => {
      ids.push(new globalThis.Headers(init.headers).get("X-AI-Request-ID"));
      throw new Error("connection lost");
    };
    await assert.rejects(api.backfillRelations("c1", 2), /无法连接/);
    await assert.rejects(api.backfillRelations("c1", 3), /无法连接/);
    assert.notEqual(ids[0], ids[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storage failure blocks a generation request before fetch", async () => {
  reset();
  const originalSetItem = globalThis.localStorage.setItem;
  const originalFetch = globalThis.fetch;
  let sent = false;
  try {
    globalThis.localStorage.setItem = () => { throw new Error("quota"); };
    globalThis.fetch = async () => { sent = true; return new globalThis.Response("{}", { status: 200 }); };
    await assert.rejects(api.generate("c1"), /请求尚未发送/);
    assert.equal(sent, false);
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
    globalThis.fetch = originalFetch;
  }
});

test("missing cross-tab locks blocks a generation request before fetch", async () => {
  reset();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalFetch = globalThis.fetch;
  let sent = false;
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    globalThis.fetch = async () => { sent = true; return new globalThis.Response("{}", { status: 200 }); };
    await assert.rejects(api.generate("c1"), /跨标签页请求锁.*请求尚未发送/);
    assert.equal(sent, false);
    assert.equal(values.has(receiptKey), false);
  } finally {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
    globalThis.fetch = originalFetch;
  }
});

test("regeneration identity is deterministic per validated parent task", () => {
  const courseId = "a".repeat(32);
  const taskId = "b".repeat(32);
  const requestId = regenerationRequestId(courseId, taskId);
  assert.equal(requestId, regenerationRequestId(courseId, taskId));
  assert.match(requestId, /^[a-zA-Z0-9-]{16,80}$/);
  assert.notEqual(requestId, regenerationRequestId(courseId, "c".repeat(32)));
  assert.throws(() => regenerationRequestId(courseId, "invalid-task-id"), /身份无效/);
});

test("corrupt local receipts surface an error instead of appearing empty", () => {
  reset();
  const malformed = [
    "not valid JSON",
    JSON.stringify([{ id: "invalid-id", scope: "POST /courses/c1/generate", inputHash: "a".repeat(64), createdAt: "now" }]),
  ];
  for (const stored of malformed) {
    values.set(receiptKey, stored);
    assert.throws(() => aiReceiptHints("c1"));
  }
});
