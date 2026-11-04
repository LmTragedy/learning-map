import test from "node:test";
import assert from "node:assert/strict";
import { splitSummary } from "../src/summary.ts";

test("splits explanation, acceptance and the extraction note", () => {
  const parts = splitSummary("AI解释：结果依赖自己和他人的行动。验收：解释这种相互依赖。本地图仅依据所给提取文本；原文见sources。");
  assert.equal(parts.explain, "结果依赖自己和他人的行动。");
  assert.equal(parts.check, "解释这种相互依赖。");
  assert.match(parts.note, /^本地图仅依据/);
});

test("moves author-facing caveats out of the learner text", () => {
  const parts = splitSummary("彩票是结果集合上的概率分布；[0.05:pass,0.95:fail]描述可能结果及概率，是课件假设例子。验收：识别结果、检查概率非负且总和为1，并解释彩票与确定结果的差别。提取文本中的集合公式排版有损失。");
  assert.equal(parts.explain, "彩票是结果集合上的概率分布；[0.05:pass,0.95:fail]描述可能结果及概率。");
  assert.equal(parts.check, "识别结果、检查概率非负且总和为1，并解释彩票与确定结果的差别。");
  assert.deepEqual(parts.caveats, ["是课件假设例子", "提取文本中的集合公式排版有损失"]);
});

test("ordinary sentences that mention extraction words are kept", () => {
  const parts = splitSummary("从三个人的偏好中提取共同结构。");
  assert.equal(parts.explain, "从三个人的偏好中提取共同结构。");
  assert.deepEqual(parts.caveats, []);
});

test("plain summaries stay whole", () => {
  const parts = splitSummary("按材料概述初始策略与更新循环。");
  assert.equal(parts.explain, "按材料概述初始策略与更新循环。");
  assert.equal(parts.check, "");
  assert.equal(parts.note, "");
});
