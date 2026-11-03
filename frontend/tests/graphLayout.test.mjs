import assert from "node:assert/strict";
import test from "node:test";
import { forceLayout, lineage } from "../src/graphLayout.ts";

test("lineage walks the whole prerequisite and follower chains", () => {
  const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "d" }, { source: "z", target: "d" }];
  const { up, down } = lineage("c", edges);
  assert.deepEqual([...up].sort(), ["a", "b"]);
  assert.deepEqual([...down], ["d"]);
  assert.equal(lineage(undefined, edges).up.size, 0);
});

test("force layout is deterministic, finite and keeps nodes apart", () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` }));
  const edges = nodes.slice(1).map((node, i) => ({ source: `n${Math.floor(i / 2)}`, target: node.id }));
  const first = forceLayout(nodes, edges);
  assert.deepEqual(forceLayout(nodes, edges), first);
  const points = [...first.values()];
  assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
    assert.ok(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 14);
});

test("force layout keeps a prerequisite chain flowing left to right", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
  const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "d" }];
  const p = forceLayout(nodes, edges);
  assert.ok(p.get("a").x < p.get("b").x && p.get("b").x < p.get("c").x && p.get("c").x < p.get("d").x);
  assert.equal(forceLayout([], []).size, 0);
});
