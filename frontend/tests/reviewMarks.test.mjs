import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import { acceptReviewSuggestion, reviewIds, reviewMarks, reviewRange, setReviewMarks } from "../src/reviewMarks.ts";

const suggestion = (id, original, from) => ({ id, category: "english", original, replacement: "x", reason: "", from, to: from + original.length, line: 1, sources: [] });

test("squiggles follow edits elsewhere and drop when their own text is edited", () => {
  let state = EditorState.create({ doc: "alpha beta gamma", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("a", "alpha", 0), suggestion("g", "gamma", 11)] }) }).state;
  state = state.update({ changes: { from: 0, insert: "new " } }).state;
  assert.deepEqual(reviewIds(state), ["a", "g"]);
  assert.deepEqual(reviewRange(state, "g"), { from: 15, to: 20 });
  state = state.update({ changes: { from: 16, to: 17, insert: "A" } }).state;
  assert.deepEqual(reviewIds(state), ["a"]);
  state = state.update({ changes: { from: 9, insert: "s" } }).state;
  assert.deepEqual(reviewIds(state), []);
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 10)] }) }).state;
  assert.deepEqual(reviewIds(state), ["b"]);
  state = state.update({ effects: setReviewMarks.of({ ids: [] }) }).state;
  assert.deepEqual(reviewIds(state), []);
});

test("insertions and deletions inside a marked range invalidate it", () => {
  for (const change of [{ from: 8, insert: "x" }, { from: 7, to: 8, insert: "" }]) {
    let state = EditorState.create({ doc: "alpha beta", extensions: [reviewMarks] });
    state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 6)] }) }).state;
    state = state.update({ changes: change }).state;
    assert.deepEqual(reviewIds(state), []);
  }
});

test("whitespace and punctuation at a mark edge stay valid unless deletion joins words", () => {
  for (const insert of [" ", "!", "\n"]) {
    let state = EditorState.create({ doc: "beta tail", extensions: [reviewMarks] });
    state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 0)] }) }).state;
    state = state.update({ changes: { from: 4, insert } }).state;
    assert.deepEqual(reviewIds(state), ["b"]);
  }

  let state = EditorState.create({ doc: "a-beta tail", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 2)] }) }).state;
  state = state.update({ changes: { from: 1, to: 2, insert: "" } }).state;
  assert.deepEqual(reviewIds(state), []);
});

test("boundary replacements that leave punctuation or whitespace do not invalidate the mark", () => {
  for (const insert of [" ", "!"]) {
    let state = EditorState.create({ doc: "a-beta tail", extensions: [reviewMarks] });
    state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 2)] }) }).state;
    state = state.update({ changes: { from: 1, to: 2, insert } }).state;
    assert.deepEqual(reviewIds(state), ["b"]);
  }

  let state = EditorState.create({ doc: "This is sentence. Next", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("sentence", "sentence.", 8)] }) }).state;
  state = state.update({ changes: { from: 17, to: 18, insert: "" } }).state;
  assert.deepEqual(reviewIds(state), ["sentence"]);
});

test("deleting a multi-character delimiter segment invalidates a word that becomes joined", () => {
  let state = EditorState.create({ doc: "prefix x bad", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("bad", "bad", 9)] }) }).state;
  state = state.update({ changes: { from: 6, to: 9, insert: "" } }).state;
  assert.deepEqual(reviewIds(state), []);
});

test("word characters glued to either edge invalidate the mark", () => {
  for (const change of [{ from: 0, insert: "字" }, { from: 4, insert: "x" }, { from: 4, insert: "\u0301" }]) {
    let state = EditorState.create({ doc: "beta", extensions: [reviewMarks] });
    state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("b", "beta", 0)] }) }).state;
    state = state.update({ changes: change }).state;
    assert.deepEqual(reviewIds(state), []);
  }
});

test("typing after a sentence-ending mark preserves its original range", () => {
  let state = EditorState.create({ doc: "A sentence.", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("s", "A sentence.", 0)] }) }).state;
  state = state.update({ changes: { from: 11, insert: "Next" } }).state;
  assert.deepEqual(reviewIds(state), ["s"]);
  assert.deepEqual(reviewRange(state, "s"), { from: 0, to: 11 });
});

test("UTF-16 offsets preserve Chinese and emoji marks and reject negative ranges", () => {
  let state = EditorState.create({ doc: "😀 中文 beta", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [
    suggestion("cn", "中文", 3), suggestion("bad", "x", -1), suggestion("b", "beta", 6),
  ] }) }).state;
  assert.deepEqual(reviewIds(state), ["cn", "b"]);
  state = state.update({ changes: { from: 0, insert: "🙂" } }).state;
  assert.deepEqual(reviewRange(state, "cn"), { from: 5, to: 7 });
  assert.deepEqual(reviewRange(state, "b"), { from: 8, to: 12 });
});

test("accepting one suggestion keeps other suggestions mapped", () => {
  let state = EditorState.create({ doc: "alpha beta gamma", extensions: [reviewMarks] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [
    suggestion("a", "alpha", 0), suggestion("b", "beta", 6), suggestion("g", "gamma", 11),
  ] }) }).state;
  state = state.update({ changes: { from: 0, to: 5, insert: "A" } }).state;
  state = state.update({ effects: setReviewMarks.of({ ids: ["b", "g"] }) }).state;
  state = state.update({ changes: { from: 0, insert: "new " } }).state;
  assert.deepEqual(reviewRange(state, "b"), { from: 6, to: 10 });
  assert.deepEqual(reviewRange(state, "g"), { from: 11, to: 16 });
});

test("one isolated suggestion undo keeps earlier user edits and maps the other mark back", () => {
  let state = EditorState.create({ doc: "alpha beta", extensions: [reviewMarks, history()] });
  state = state.update({ effects: setReviewMarks.of({ suggestions: [suggestion("a", "alpha", 0), suggestion("b", "beta", 6)] }) }).state;
  state = state.update({ changes: { from: 0, insert: "prefix " }, annotations: Transaction.userEvent.of("input.type") }).state;
  assert.equal(acceptReviewSuggestion({ state, dispatch: (transaction) => { state = transaction.state; } },
    { ...suggestion("a", "alpha", 0), replacement: "A" }), "prefix A beta");
  assert.equal(state.doc.toString(), "prefix A beta");
  assert.deepEqual(reviewRange(state, "b"), { from: 9, to: 13 });
  assert.equal(undo({ state, dispatch: (transaction) => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), "prefix alpha beta");
  assert.deepEqual(reviewRange(state, "b"), { from: 13, to: 17 });
});

test("a filtered acceptance preserves the suggestion and earlier user history", () => {
  let state = EditorState.create({ doc: "alpha", extensions: [reviewMarks, history(),
    EditorState.transactionFilter.of((transaction) => transaction.isUserEvent("input.note-suggestion") ? [] : transaction),
  ] });
  const entry = suggestion("a", "alpha", 0);
  state = state.update({ effects: setReviewMarks.of({ suggestions: [entry] }) }).state;
  state = state.update({ changes: { from: 0, insert: "prefix " }, annotations: Transaction.userEvent.of("input.type") }).state;
  const previousDepth = undoDepth(state);
  const accepted = acceptReviewSuggestion({ state, dispatch: (transaction) => { state = transaction.state; } }, entry);
  assert.equal(accepted, null);
  assert.equal(state.doc.toString(), "prefix alpha");
  assert.deepEqual(reviewIds(state), ["a"]);
  assert.equal(undoDepth(state), previousDepth);
});
