import assert from "node:assert/strict";
import test from "node:test";
import { edgeLabel, needsBridges, nodeBridges, resolveBridges } from "../src/bridges.ts";

const bridge = (id, strength, extra = {}) => ({
  id, from_piece: "", to_step: "", how: "", if_missing: "", strength, check: { question: "", answer: "" },
  sources: [], uncertain: true, origin: "ai", ...extra,
});

const course = {
  nodes: [
    { id: "a", title: "偏好关系", pieces: [{ id: "p1", kind: "性质", title: "传递性", detail: "" }], steps: [] },
    { id: "b", title: "效用函数", pieces: [], steps: [{ id: "s1", title: "写出定义" }, { id: "s2", title: "验证可以表示" }] },
    { id: "c", title: "序数效用", pieces: [], steps: [] },
  ],
  edges: [
    { id: "e1", source: "a", target: "b", kind: "用到", bridges: [bridge("x", "suggested"), bridge("y", "required", { from_piece: "p1", to_step: "s2" })] },
    { id: "e2", source: "b", target: "c", kind: "用到", bridges: [bridge("e2:legacy", "required", { legacy: true })] },
    { id: "e3", source: "b", target: "c", kind: "对比", bridges: [] },
  ],
};

test("bridges resolve pieces and step numbers and list required ones first", () => {
  const [first, second] = resolveBridges(course, [course.edges[0]]);
  assert.equal(first.bridge.id, "y");
  assert.equal(first.piece.title, "传递性");
  assert.equal(first.stepNumber, 2);
  assert.equal(second.piece, undefined);
});

test("a node reads what it uses, where it is used and what it is easy to confuse with", () => {
  const b = nodeBridges(course, course.nodes[1]);
  assert.deepEqual(b.incoming.map((item) => item.bridge.id), ["y", "x"]);
  assert.deepEqual(b.outgoing.map((item) => item.bridge.id), ["e2:legacy"]);
  assert.deepEqual(b.contrasts.map((edge) => edge.id), ["e3"]);
});

test("only migrated single bridges need the AI, and edge labels name the piece used", () => {
  assert.equal(needsBridges(course.edges[0]), false);
  assert.equal(needsBridges(course.edges[1]), true);
  assert.equal(needsBridges(course.edges[2]), false);
  assert.equal(edgeLabel(course, course.edges[0]), "用到 · 传递性");
  assert.equal(edgeLabel(course, course.edges[1]), "用到");
});
