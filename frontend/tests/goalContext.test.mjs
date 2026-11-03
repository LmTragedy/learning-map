import assert from "node:assert/strict";
import test from "node:test";
import { goalPath, goalProgressDiff, goalsForNode } from "../src/goalContext.ts";

const node = (id, prerequisites = [], status = "new", unlocked = true) => ({ id, title: id, prerequisites, status, unlocked });
const goal = (id, status, node_ids, subtasks = [], verified = 0) => ({
  id, title: id, status, node_ids, subtasks, progress: { verified },
});

// rec → memo → knap → interval → dp, and rec → dc → sort
const course = {
  nodes: [
    node("rec", [], "passed"), node("dc", ["rec"], "passed"), node("memo", ["rec"], "mastered"),
    node("sort", ["dc"], "passed"), node("knap", ["memo"]), node("interval", ["knap"], "new", false),
    node("dp", ["interval"], "new", false), node("alone"),
  ],
  goals: [
    goal("done-goal", "done", ["sort"]),
    goal("dp-goal", "doing", ["dp"], [{ id: "t1", title: "背包转移", done: false, node_id: "knap" }]),
    goal("todo-goal", "todo", ["knap"]),
  ],
};

test("goal path lists prerequisites before the nodes that need them", () => {
  assert.deepEqual(goalPath(course, ["dp"]), ["rec", "memo", "knap", "interval", "dp"]);
  assert.deepEqual(goalPath(course, ["missing"]), []);
});

test("a prerequisite node sees the goals whose route passes through it", () => {
  const [dp, todo] = goalsForNode(course, "knap");
  assert.equal(dp.goal.id, "dp-goal");
  assert.deepEqual(dp.roles, ["route", "subtask"]);
  assert.equal(dp.step, 3);
  assert.equal(dp.completed, 2);
  assert.equal(dp.remaining, 3);
  assert.equal(dp.next.id, "interval");
  assert.deepEqual(dp.subtasks.map((task) => task.id), ["t1"]);
  assert.deepEqual(todo.roles, ["endpoint"]);
});

test("active goals sort before finished ones and unrelated nodes have none", () => {
  assert.deepEqual(goalsForNode(course, "rec").map((entry) => entry.goal.id), ["dp-goal", "todo-goal", "done-goal"]);
  assert.deepEqual(goalsForNode(course, "alone"), []);
});

test("progress diff reports verified count changes and newly ticked subtasks", () => {
  const after = structuredClone(course);
  after.goals[1].progress.verified = 1;
  after.goals[1].subtasks[0].auto_done = true;
  assert.deepEqual(goalProgressDiff(course, after), [
    { goalId: "dp-goal", title: "dp-goal", verified: [0, 1], total: 1, subtasks: ["背包转移"] },
  ]);
  assert.deepEqual(goalProgressDiff(course, course), []);
});
