import test from "node:test";
import assert from "node:assert/strict";

// Only the browser storage boundary is replaced; reloads use fresh module instances.
const contents = new Map();
globalThis.localStorage = {
  getItem(key) { return contents.get(key) ?? null; },
  setItem(key, value) { contents.set(key, value); },
  removeItem(key) { contents.delete(key); },
};
let instance = 0;
const page = () => import(`../src/answerDrafts.ts?page=${instance++}`);
const scope = (node = "node", review = "course", question = "question") =>
  JSON.stringify(["course", node, review, question]);

test("answer survives switching screens and reload while other nodes, scopes and questions stay separate", async () => {
  const drafts = await page();
  const original = scope();
  drafts.updateAnswerDraft(original, { answer: "我的答案", reference: "reference" });
  for (const other of [scope("other"), scope("node", "pdf"), scope("node", "course", "new")]) {
    assert.equal(drafts.answerDraft(other).answer, "");
    drafts.updateAnswerDraft(other, { answer: "another answer" });
  }
  assert.equal(drafts.answerDraft(original).answer, "我的答案");
  const reopened = (await page()).answerDraft(original);
  assert.equal(reopened.answer, "我的答案");
  assert.equal(reopened.reference, "reference");
});

test("successful submission clears its answer and attachments but retains reference", async () => {
  const drafts = await page();
  const key = scope("submitted");
  const file = new globalThis.File(["answer"], "answer.pdf");
  drafts.updateAnswerDraft(key, { answer: "submitted", reference: "keep reference", files: [file] });
  assert.equal(drafts.answerDraft(key).files[0], file);
  assert.equal(drafts.hasVolatileAnswerDrafts(), true);
  drafts.completeAnswerDraft(key, drafts.answerDraft(key));
  const reopened = (await page()).answerDraft(key);
  assert.equal(reopened.answer, "");
  assert.equal(reopened.reference, "keep reference");
  assert.deepEqual(reopened.files, []);
  assert.equal(drafts.hasVolatileAnswerDrafts(), false);
});

test("late submission success never clears newer edits after navigating away and back", async () => {
  const drafts = await page();
  const key = scope("in-flight");
  drafts.updateAnswerDraft(key, { answer: "submitted" });
  const submitted = drafts.answerDraft(key);
  drafts.updateAnswerDraft(key, { answer: "continued typing", files: [new globalThis.File(["new"], "new.pdf")] });
  drafts.answerDraft(scope("elsewhere"));
  drafts.completeAnswerDraft(key, submitted);
  assert.equal(drafts.answerDraft(key).answer, "continued typing");
  assert.equal(drafts.answerDraft(key).files[0].name, "new.pdf");
  assert.equal((await page()).answerDraft(key).answer, "continued typing");
});

test("storage failures retain edits across screens and warn instead of claiming a save", async () => {
  const drafts = await page();
  const key = scope("quota");
  const setItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new globalThis.DOMException("Quota exceeded", "QuotaExceededError"); };
  try {
    drafts.updateAnswerDraft(key, { answer: "keep me" });
    drafts.answerDraft(scope("elsewhere"));
    assert.equal(drafts.answerDraft(key).answer, "keep me");
    assert.ok(drafts.answerDraft(key).warning);
    assert.equal(drafts.hasVolatileAnswerDrafts(), true);
  } finally { globalThis.localStorage.setItem = setItem; }
});

test("malformed stored drafts warn and remain untouched", async () => {
  const drafts = await page();
  const key = scope("corrupt");
  for (const raw of ["{broken", "null", '{"answer":123,"reference":""}']) {
    contents.set(`learning-map:answer-draft:${key}`, raw);
    const reopened = await page();
    assert.ok(reopened.answerDraft(key).warning);
    assert.equal(contents.get(`learning-map:answer-draft:${key}`), raw);
  }
  assert.equal(drafts.answerDraft(scope("unrelated")).warning, "");
});
