import test from "node:test";
import assert from "node:assert/strict";
import { splitSummary } from "../src/summary.ts";

test("splits explanation, acceptance and the extraction note", () => {
  const parts = splitSummary("AI解释：结果依赖自己和他人的行动。验收：解释这种相互依赖。本地图仅依据所给提取文本；原文见sources。");
  assert.equal(parts.explain, "结果依赖自己和他人的行动。");
  assert.equal(parts.check, "解释这种相互依赖。");
  assert.match(parts.note, /^本地图仅依据/);
});

test("plain summaries stay whole", () => {
  const parts = splitSummary("按材料概述初始策略与更新循环。");
  assert.equal(parts.explain, "按材料概述初始策略与更新循环。");
  assert.equal(parts.check, "");
  assert.equal(parts.note, "");
});
