import test from "node:test";
import assert from "node:assert/strict";

// Browser storage is the boundary; each module instance represents a separate window.
const contents = new Map();
globalThis.window = new globalThis.EventTarget();
globalThis.localStorage = {
  get length() { return contents.size; },
  key(index) { return [...contents.keys()][index] ?? null; },
  getItem(key) { return contents.get(key) ?? null; },
  setItem(key, content) { contents.set(key, content); },
  removeItem(key) { contents.delete(key); },
};
let instance = 0;
const editor = () => import(`../src/noteDrafts.ts?window=${instance++}`);

test("two windows retain separate drafts and the original baseline after reload", async () => {
  const first = await editor(), second = await editor();
  const scope = first.noteScope("course", "concurrent");
  const a = first.newDraft("window A", "original");
  const b = second.newDraft("window B", "original");
  first.keepDraft(scope, a);
  second.keepDraft(scope, b);
  first.acknowledgeSaved(scope, a);
  const reopened = await editor();
  const restored = reopened.storedDrafts(scope).drafts;
  assert.deepEqual(restored.map(({ content, expected }) => ({ content, expected })), [
    { content: "window B", expected: "original" },
  ]);
  assert.equal(reopened.currentDraft(scope, "window A").content, "window A");
  assert.equal(second.currentDraft(scope, "window A").content, "window B");
});

test("save acknowledgement preserves typing made after submission and node switching", async () => {
  const notes = await editor();
  const scope = notes.noteScope("course", "in-flight");
  const submitted = notes.newDraft("submitted", "original");
  notes.keepDraft(scope, submitted);
  notes.keepDraft(scope, { ...submitted, content: "typed during save" });
  notes.currentDraft(notes.noteScope("course", "another-node"), "another note");
  notes.acknowledgeSaved(scope, submitted);
  const resumed = notes.currentDraft(scope, "submitted");
  assert.equal(resumed.content, "typed during save");
  assert.equal(resumed.expected, "submitted");
  assert.equal(notes.hasUnsavedNotes(), true);
  notes.acknowledgeSaved(scope, resumed);
  assert.equal(notes.hasUnsavedNotes(), false);
  assert.equal(notes.storedDrafts(scope).drafts.length, 0);
});

test("switching drafts during a save never changes the replacement draft baseline", async () => {
  const notes = await editor();
  const scope = notes.noteScope("course", "recovery");
  const submitted = notes.newDraft("submitted", "original");
  notes.keepDraft(scope, submitted);
  const recovery = notes.newDraft("older recovery", "older baseline");
  notes.keepDraft(scope, recovery);
  notes.acknowledgeSaved(scope, submitted);
  assert.deepEqual(notes.currentDraft(scope, "submitted"), recovery);
  assert.equal(notes.storedDrafts(scope).drafts[0].content, "older recovery");
});

test("legacy drafts require review and corrupt storage remains intact", async () => {
  const notes = await editor();
  const scope = notes.noteScope("course", "legacy");
  globalThis.localStorage.setItem(scope, "old user text");
  globalThis.localStorage.setItem(`${scope}:broken`, "{broken json");
  const recovered = notes.storedDrafts(scope);
  assert.equal(recovered.drafts[0].content, "old user text");
  assert.equal(recovered.drafts[0].expected, null);
  assert.ok(recovered.error);
  assert.equal(globalThis.localStorage.getItem(`${scope}:broken`), "{broken json");
});

test("storage failure keeps an in-memory draft across nodes and warns on close", async () => {
  const notes = await editor();
  const scope = notes.noteScope("course", "storage-failure");
  const draft = notes.newDraft("do not lose this", "");
  const originalSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new globalThis.DOMException("Quota exceeded", "QuotaExceededError"); };
  try {
    assert.ok(notes.keepDraft(scope, draft));
    assert.equal(notes.storedDrafts(scope).drafts[0].content, "do not lose this");
    assert.equal(notes.currentDraft(scope, "").content, "do not lose this");
    assert.ok(notes.storedDrafts(scope).error);
    assert.equal(notes.hasUnsavedNotes(), true);
  } finally { globalThis.localStorage.setItem = originalSet; }
  notes.acknowledgeSaved(scope, draft);
  assert.equal(notes.hasUnsavedNotes(), false);
});
