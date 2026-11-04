import assert from "node:assert/strict";
import test from "node:test";
import { conflictTitles, planState } from "../src/teachingPlan.ts";

const plan = (extra = {}) => ({
  version: 2, status: "current", goal: "会检查理性偏好", owns: [], borrows: [], defers: [], distinctions: [],
  sources: [], conflicts: [], uncertain: false, candidate: false, note: "", ...extra,
});

test("a missing plan reads as not prepared", () => {
  assert.equal(planState(null).key, "none");
  assert.equal(planState(undefined).key, "none");
});

test("a current plan shows its version", () => {
  assert.deepEqual([planState(plan()).key, planState(plan()).label], ["current", "第 2 版"]);
});

test("conflicts outrank staleness and candidates", () => {
  const conflicted = plan({ status: "stale", candidate: true, conflicts: [{ node_ids: ["a"], issue: "x" }] });
  assert.equal(planState(conflicted).key, "review");
  assert.equal(planState(plan({ status: "stale" })).key, "stale");
  assert.equal(planState(plan({ candidate: true })).label, "候选");
});

test("conflict titles skip this node and name deleted ones", () => {
  const titles = new Map([["a", "理性偏好"], ["b", "传递性局限"]]);
  assert.deepEqual(conflictTitles({ node_ids: ["a", "b", "gone"], issue: "" }, titles, "a"), ["传递性局限", "已删除的知识点"]);
});

test("an uncertain plan is flagged with its reasons, not shown as a plain version", () => {
  const state = planState(plan({ uncertain: true, uncertain_reasons: ["第 1 页的引文在原文中找不到，已清空"] }));
  assert.equal(state.key, "review");
  assert.equal(state.label, "第 2 版 · 待核对");
  assert.match(state.hint, /引文在原文中找不到/);
});

test("an uncertain plan saved without reasons still asks for a check", () => {
  assert.match(planState(plan({ uncertain: true })).hint, /依据存疑/);
});
