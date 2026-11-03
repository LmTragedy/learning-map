import test from "node:test";
import assert from "node:assert/strict";
import { resultPresent, taskLessonId, taskView } from "../src/aiTaskModel.ts";

const baseTask = (overrides = {}) => ({
  id: "task-1", course_id: "course-1", kind: "lesson", target: "node-1", state: "prepared",
  request_id: "request-1", created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:00Z",
  inputs: { kind: "initial", prompt: "original prompt" }, ...overrides,
});
const baseCourse = (overrides = {}) => ({
  id: "course-1", revision: 5,
  nodes: [{ id: "node-1", title: "矩阵", lessons: [], chats: [] }], edges: [],
  ...overrides,
});

test("completed child work stays separate from applying its parent to the course", () => {
  const child = baseTask({ kind: "child", state: "applied", parent_task_id: "parent-1", role: "material_page_index" });
  const completed = taskView(child, baseCourse());
  assert.equal(completed.title, "Luna 子任务已完成");
  assert.equal(completed.group, "applied");
  assert.equal(completed.canOpen, false);
  assert.equal(completed.canRegenerate, false);
  const received = taskView({ ...child, state: "received", has_raw_reply: true, can_recover: true }, baseCourse());
  assert.equal(received.canRecover, true);
  assert.equal(received.canRegenerate, false);
});

test("maps each persisted backend state to its user-visible task meaning", () => {
  const cases = [
    ["prepared", "prepared", "active"], ["sending", "running", "active"], ["running", "running", "active"],
    ["processing", "processing", "active"], ["received", "received", "attention"], ["invalid", "received", "attention"],
    ["conflict", "conflict", "attention"], ["rejected", "failed", "attention"], ["failed", "failed", "attention"],
    ["superseded", "superseded", "superseded"], ["applied", "unverified", "attention"], ["unknown", "unknown", "attention"], ["future-state", "unknown", "attention"],
  ];
  for (const [state, semantic, group] of cases) {
    const view = taskView(baseTask({ state }), baseCourse(), { now: Date.parse("2026-11-03T00:01:00Z") });
    assert.equal(view.semantic, semantic, `${state} semantic`);
    assert.equal(view.group, group, `${state} group`);
  }
});

test("requires applied revision and the exact persisted lesson or chat result before opening", () => {
  const lesson = baseTask({ state: "applied", applied_revision: 5 });
  const savedLesson = { id: "lesson-1", request_id: "request-1" };
  const courseWithLesson = baseCourse({ nodes: [{ id: "node-1", lessons: [savedLesson], chats: [] }] });
  assert.equal(taskLessonId(lesson, courseWithLesson), "lesson-1");
  assert.equal(resultPresent(lesson, courseWithLesson), true);
  assert.equal(resultPresent({...lesson,result_ref:null}, courseWithLesson), false);
  assert.equal(resultPresent({...lesson,result_ref:{kind:'lesson',course_id:'course-1',available:false}}, courseWithLesson), false);
  assert.equal(resultPresent(lesson, baseCourse({ revision: 4, nodes: [{ id: "node-1", lessons: [savedLesson], chats: [] }] })), false);
  assert.equal(resultPresent(lesson, baseCourse({ id: "another-course", nodes: [{ id: "node-1", lessons: [savedLesson], chats: [] }] })), false);
  assert.equal(resultPresent(lesson, baseCourse({ nodes: [{ id: "node-1", lessons: [{ ...savedLesson, request_id: "other-request" }], chats: [] }] })), false);

  const chat = baseTask({ kind: "chat", state: "applied", applied_revision: 5, raw_reply: { text: "exact reply" } });
  assert.equal(resultPresent(chat, baseCourse({ nodes: [{ id: "node-1", lessons: [], chats: [{ role: "assistant", content: "exact reply" }] }] })), true);
  assert.equal(resultPresent(chat, baseCourse({ nodes: [{ id: "node-1", lessons: [], chats: [{ role: "assistant", content: "edited reply" }] }] })), false);
  assert.equal(resultPresent(chat, baseCourse({ nodes: [{ id: "node-1", lessons: [], chats: [{ role: "user", content: "exact reply" }] }] })), false);
  assert.equal(resultPresent(baseTask({ kind: "question", state: "applied", applied_revision: 5 }), baseCourse()), false);
});

test("conflict recovery requires an explicit backend capability and unknown task kinds cannot dispatch", () => {
  assert.equal(taskView(baseTask({ state: "conflict" })).canRecover, false);
  assert.equal(taskView(baseTask({ state: "conflict", can_recover: true })).canRecover, true);
  assert.equal(taskView(baseTask({ state: "conflict", can_recover: false, raw_reply: { text: "reply" } })).canRecover, false);
  const unsupported = taskView(baseTask({ kind: "unrecognized-operation", state: "received", raw_reply: { text: "reply" } }));
  assert.equal(unsupported.canRecover, false);
  assert.equal(unsupported.canRegenerate, false);
  assert.match(unsupported.error, /暂不支持/);
});

test("offline and missing evidence never become a successful applied result", () => {
  const task = baseTask({ state: "applied", applied_revision: 5 });
  const view = taskView(task, baseCourse(), { offline: true });
  assert.equal(view.semantic, "offline");
  assert.equal(view.canOpen, false);
  assert.equal(view.canRecover, false);
  assert.equal(resultPresent(task, undefined), false);
  assert.equal(resultPresent(baseTask({ state: "applied", applied_revision: 5, kind: "chat", raw_reply: { text: "" } }), baseCourse()), false);
});

test("read-only state mapping leaves the persisted task inputs unchanged", () => {
  const inputs = Object.freeze({ kind: "supplement", prompt: "do not rewrite" });
  const task = Object.freeze(baseTask({ state: "received", inputs }));
  const before = JSON.stringify(task);
  taskView(task, baseCourse());
  assert.equal(JSON.stringify(task), before);
  assert.equal(task.inputs.prompt, "do not rewrite");
});

test("history-only receipts stay in the history group without recovery or generation actions", () => {
  const dispositions = [
    ["already_applied", "此前已应用"],
    ["conflict", "与当前课程冲突"],
    ["unmatched", "尚未匹配"],
    ["recovered", "已取回原文"],
  ];
  for (const [history_disposition, expectedLabel] of dispositions) {
    const view = taskView(baseTask({
      kind: "history", state: "archived", history_only: true,
      history_kind: "note_review", history_match_reason: "internal matching evidence",
      history_disposition, can_recover: true, can_regenerate: true, can_collect: true,
      thread_id: "thread-history", turn_id: "turn-history", historical_raw: "original output",
    }), baseCourse());
    assert.equal(view.semantic, "history");
    assert.equal(view.group, "history");
    assert.equal(view.shortLabel, expectedLabel);
    assert.equal(view.description, '检查笔记「矩阵」');
    assert.equal(view.canRecover, false);
    assert.equal(view.canRegenerate, false);
    assert.equal(view.canCollect, true); // A read of the exact original turn cannot apply or generate.
    assert.equal(view.canViewRaw, true);
    assert.doesNotMatch(view.error || "", /暂不支持历史取回/);
  }
  const unknown = taskView(baseTask({
    kind: 'history', state: 'archived', history_kind: 'future_kind', history_only: true,
  }), baseCourse());
  assert.equal(unknown.description, '历史任务「矩阵」');
});

test("explicit result references only open for the matching course and a current checked revision", () => {
  const task = baseTask({
    state: "applied",
    result_ref: { kind: "lesson", course_id: "course-1", available: true, checked_revision: 4 },
  });
  assert.equal(resultPresent(task, baseCourse({ revision: 5 })), true);
  assert.equal(resultPresent(task, baseCourse({ revision: 3 })), false);
  assert.equal(resultPresent({
    ...task, result_ref: { ...task.result_ref, course_id: "another-course" },
  }, baseCourse()), false);
  assert.equal(resultPresent({
    ...task, result_ref: { ...task.result_ref, available: false },
  }, baseCourse()), false);
});

test("collection and native organization actions require explicit backend capabilities", () => {
  const collectable = taskView(baseTask({ state: "unknown", can_collect: true, thread_id: "thread-1" }), baseCourse());
  assert.equal(collectable.canCollect, true);
  assert.equal(taskView(baseTask({ state: "unknown", thread_id: "thread-1" }), baseCourse()).canCollect, false);

  const organizationFailed = taskView(baseTask({ organization: { native_status: "failed", desktop_status: "pending" } }), baseCourse());
  assert.equal(organizationFailed.canOrganize, true);
  assert.equal(taskView(baseTask({ organization: { native_status: "confirmed", desktop_status: "pending" } }), baseCourse()).canOrganize, false);
});

test("conflict and superseded receipts continue to expose saved raw output", () => {
  for (const state of ["conflict", "superseded"]) {
    const view = taskView(baseTask({ state, raw_reply: { text: "saved response" }, thread_id: "thread-1", turn_id: "turn-1" }), baseCourse());
    assert.equal(view.canViewRaw, true);
  }
});
