import assert from "node:assert/strict";
import test from "node:test";
import { NODE_HEIGHT, graphPositions, lineage } from "../src/graphLayout.ts";

test("parents precede a shared target even when input arrives out of order", () => {
  const nodes = ["end", "b", "a"].map((id) => ({ id }));
  const edges = [{ source: "a", target: "end" }, { source: "b", target: "end" }];
  const positions = graphPositions(nodes, edges);
  assert.ok(positions.get("a").x < positions.get("end").x);
  assert.ok(positions.get("b").x < positions.get("end").x);
  assert.ok(Math.abs(positions.get("a").y - positions.get("b").y) >= NODE_HEIGHT + 12);
});

test("a simple crossed pair is reordered without changing its edges", () => {
  const nodes = ["a", "b", "d", "c"].map((id) => ({ id }));
  const edges = [{ source: "a", target: "c" }, { source: "b", target: "d" }];
  const before = JSON.parse(JSON.stringify({ nodes, edges }));
  const positions = graphPositions(nodes, edges);
  assert.ok((positions.get("a").y - positions.get("b").y) *
    (positions.get("c").y - positions.get("d").y) > 0);
  assert.deepEqual({ nodes, edges }, before);
  assert.deepEqual(graphPositions(nodes, edges), positions);
});

test("empty graphs and out-of-scope edges remain safe after filtering", () => {
  assert.equal(graphPositions([], []).size, 0);
  const positions = graphPositions([{ id: "visible" }], [{ source: "hidden", target: "visible" }]);
  assert.equal(positions.size, 1);
  assert.ok(Number.isFinite(positions.get("visible").x));
});

test("nodes in one column never overlap and a single child sits level with its parent", () => {
  const nodes = ["r", "a", "b", "c", "x"].map((id) => ({ id }));
  const edges = [{ source: "r", target: "a" }, { source: "r", target: "b" }, { source: "r", target: "c" }, { source: "c", target: "x" }];
  const positions = graphPositions(nodes, edges);
  const column = ["a", "b", "c"].map((id) => positions.get(id).y).sort((p, q) => p - q);
  for (let i = 1; i < column.length; i++) assert.ok(column[i] - column[i - 1] >= NODE_HEIGHT + 12);
  assert.equal(positions.get("x").y, positions.get("c").y);
});

test("a new stage starts with a wider gap than columns inside a stage", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id }));
  const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }];
  const stages = new Map([["a", "s1"], ["b", "s1"], ["c", "s2"]]);
  const p = graphPositions(nodes, edges, stages);
  assert.ok(p.get("c").x - p.get("b").x > p.get("b").x - p.get("a").x);
});

test("lineage walks the whole prerequisite and follower chains", () => {
  const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "d" }, { source: "z", target: "d" }];
  const { up, down } = lineage("c", edges);
  assert.deepEqual([...up].sort(), ["a", "b"]);
  assert.deepEqual([...down], ["d"]);
  assert.equal(lineage(undefined, edges).up.size, 0);
});
