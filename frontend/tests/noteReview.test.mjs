import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { NoteReviewController } from "../src/noteReview.ts";
import { suggestionMatches } from "../src/noteReviewTypes.ts";

const base = { courseId: "course", nodeId: "node", revision: 1, scopeKey: "course", model: "gpt-6-luna", enabled: true, available: true };
const reply = (context, id, suggestions = []) => ({ request_id: id, note_id: context.noteId || "", revision: context.revision, scope_key: context.scopeKey, model: context.model, suggestions, warnings: [] });
const suggestion = (original, from = 0) => ({ id: "suggestion", category: "english", original, replacement: "clearer", reason: "Meaning preserved", from, to: from + original.length, line: 1, sources: [] });
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { if (Date.now() > deadline) assert.fail("review did not reach expected state"); await delay(2); }
}

test("writing pauses coalesce edits and send the whole latest note, including earlier text", async (t) => {
  const calls = [];
  const controller = new NoteReviewController(async (context, id) => { calls.push(context.content); return reply(context, id); }, 35, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "earlier statement\nlast" });
  await delay(5);
  controller.update({ ...base, content: "earlier statement\nlast sentence" });
  await until(() => controller.snapshot().phase === "ready");
  assert.deepEqual(calls, ["earlier statement\nlast sentence"]);
});

test("editing during a request discards old suggestions and then checks the newest snapshot", async (t) => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "old sentence" });
  await until(() => pending.length === 1);
  controller.update({ ...base, content: "new sentence" });
  pending[0].resolve(reply(pending[0].context, pending[0].id, [suggestion("old sentence")]));
  await until(() => pending.length === 2);
  assert.equal(controller.current("suggestion"), undefined);
  pending[1].resolve(reply(pending[1].context, pending[1].id, [suggestion("new sentence")]));
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.current("suggestion").original, "new sentence");
});

for (const failure of ["error", "unresponsive"]) test(`${failure} pauses checks without losing edits and requires an explicit retry`, async (t) => {
  let calls = 0;
  const controller = new NoteReviewController(async (context, id) => {
    calls++;
    if (calls > 1) return reply(context, id);
    if (failure === "error") throw new Error("provider unavailable");
    return new Promise(() => {});
  }, 5, 30, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "original" });
  await until(() => calls === 1);
  controller.update({ ...base, content: "typing while checking" });
  await until(() => controller.snapshot().phase === "error");
  controller.update({ ...base, content: "still editable" });
  await delay(45);
  assert.equal(calls, 1);
  assert.ok(controller.snapshot().message);
  controller.retry();
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.snapshot().snapshot, "still editable");
});

test("rejecting one suggestion preserves text and deactivates Tab acceptance", async (t) => {
  const controller = new NoteReviewController(async (context, id) => reply(context, id, [suggestion(context.content)]), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "my wording" });
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.current(), undefined);
  controller.select("suggestion");
  assert.equal(controller.current().original, "my wording");
  controller.reject("suggestion");
  assert.equal(controller.current(), undefined);
  assert.equal(controller.snapshot().snapshot, "my wording");
});

test("disabled or unavailable AI sends no requests; remount and context change reject old results", async () => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  try {
    controller.update({ ...base, enabled: false, content: "text" });
    await delay(10); assert.equal(pending.length, 0);
    controller.update({ ...base, available: false, content: "text" });
    await delay(10); assert.equal(pending.length, 0);
    controller.update({ ...base, content: "text" });
    await until(() => pending.length === 1);
    controller.dispose();
    controller.update({ ...base, nodeId: "other", content: "other note" });
    pending[0].resolve(reply(pending[0].context, pending[0].id, [suggestion("text")]));
    await until(() => pending.length === 2);
    assert.equal(controller.current("suggestion"), undefined);
    pending[1].resolve(reply(pending[1].context, pending[1].id));
    await until(() => controller.snapshot().phase === "ready");
    assert.equal(controller.snapshot().snapshot, "other note");
  } finally { controller.dispose(); }
});

test("acceptance rejects changed snapshots and invalid positions, including UTF-16 boundaries", () => {
  const source = "😀 bad text";
  const anchored = suggestion("bad", 3);
  assert.equal(suggestionMatches(source, source, anchored), true);
  assert.equal(suggestionMatches(source + " new", source, anchored), false);
  assert.equal(suggestionMatches(source, source, { ...anchored, from: 2 }), false);
  assert.equal(suggestionMatches(source, source, { ...anchored, to: 999 }), false);
});

test("switching between named notes with identical text cannot reuse the previous note's suggestions", async (t) => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, noteId: "first", content: "shared sentence" });
  await until(() => pending.length === 1);
  controller.update({ ...base, noteId: "second", content: "shared sentence" });
  pending[0].resolve(reply(pending[0].context, pending[0].id, [suggestion("shared sentence")]));
  await until(() => pending.length === 2);
  assert.equal(controller.current("suggestion"), undefined);
  pending[1].resolve(reply(pending[1].context, pending[1].id, [suggestion("shared sentence")]));
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.current("suggestion").original, "shared sentence");
});

test("an autosave bumping the revision neither resets suggestions nor fails a check in flight", async (t) => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "my wording" });
  await until(() => pending.length === 1);
  controller.update({ ...base, revision: 2, content: "my wording" });
  pending[0].resolve({ ...reply(pending[0].context, pending[0].id, [suggestion("my wording")]), revision: 1 });
  await until(() => controller.snapshot().phase === "ready");
  controller.update({ ...base, revision: 3, content: "my wording" });
  await delay(20);
  assert.equal(controller.snapshot().suggestions.length, 1);
  assert.equal(pending.length, 1);
});

test("edits keep earlier suggestions until the editor prunes the ones it touched", async (t) => {
  const two = [{ ...suggestion("first"), id: "a" }, { ...suggestion("second", 6), id: "b" }];
  const controller = new NoteReviewController(async (context, id) => reply(context, id, context.content === "first second" ? two : []), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "first second" });
  await until(() => controller.snapshot().phase === "ready");
  controller.update({ ...base, content: "first second!" });
  assert.deepEqual(controller.snapshot().suggestions.map((entry) => entry.id), ["a", "b"]);
  controller.prune(["b"]);
  assert.deepEqual(controller.snapshot().suggestions.map((entry) => entry.id), ["a"]);
  controller.accepted("a");
  assert.equal(controller.snapshot().suggestions.length, 0);
});

for (const [label, change] of [
  ["review scope", { scopeKey: "selected:node" }],
  ["course", { courseId: "other-course" }],
  ["node", { nodeId: "other-node" }],
  ["model", { model: "gpt-6-astra" }],
]) test(`switching ${label} with identical text rejects the old asynchronous result`, async (t) => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "shared sentence" });
  await until(() => pending.length === 1);
  controller.update({ ...base, ...change, content: "shared sentence" });
  pending[0].resolve(reply(pending[0].context, pending[0].id, [suggestion("shared sentence")]));
  await until(() => pending.length === 2);
  assert.equal(controller.current("suggestion"), undefined);
  pending[1].resolve(reply(pending[1].context, pending[1].id, [suggestion("shared sentence")]));
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.current("suggestion").original, "shared sentence");
});

test("unrelated edits keep existing suggestions and reject stale response offsets", async (t) => {
  const pending = [];
  const controller = new NoteReviewController((context, id) => new Promise(resolve => pending.push({ context, id, resolve })), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "first second" });
  await until(() => pending.length === 1);
  pending[0].resolve(reply(pending[0].context, pending[0].id, [{ ...suggestion("first"), id: "first-mark" }]));
  await until(() => controller.snapshot().phase === "ready");

  controller.retry();
  await until(() => pending.length === 2);
  controller.update({ ...base, content: "first second!" });
  assert.deepEqual(controller.snapshot().suggestions.map(({ id }) => id), ["first-mark"]);
  pending[1].resolve(reply(pending[1].context, pending[1].id, [
    { ...suggestion("second", 6), id: "stale-offset" },
  ]));
  await until(() => pending.length === 3);
  assert.deepEqual(controller.snapshot().suggestions.map(({ id }) => id), ["first-mark"]);
});

test("disabling AI after a successful check clears existing suggestions", async (t) => {
  const controller = new NoteReviewController(async (context, id) => reply(context, id, [suggestion(context.content)]), 5, 500, 0);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "my wording" });
  await until(() => controller.snapshot().phase === "ready");
  assert.equal(controller.snapshot().suggestions.length, 1);
  controller.update({ ...base, enabled: false, content: "my wording" });
  assert.equal(controller.snapshot().phase, "off");
  assert.equal(controller.snapshot().suggestions.length, 0);
});

test("automatic checks are spaced by the cooldown while an explicit retry runs at once", async (t) => {
  const calls = [];
  const controller = new NoteReviewController(async (context, id) => { calls.push(context.content); return reply(context, id); }, 5, 500, 120);
  t.after(() => controller.dispose());
  controller.update({ ...base, content: "first" });
  await until(() => calls.length === 1);
  controller.update({ ...base, content: "second" });
  await delay(40);
  assert.deepEqual(calls, ["first"]);
  await until(() => calls.length === 2);
  assert.deepEqual(calls, ["first", "second"]);
  controller.update({ ...base, content: "third" });
  controller.retry();
  await until(() => calls.length === 3);
  assert.equal(calls[2], "third");
});
