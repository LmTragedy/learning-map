import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { isMaterialPageImageUrl, materialPageImageAt, materialPageImageUrl, validateDiagram, validateVisualForCourse, validateVisualItem } from "../src/workbench/diagramModel.ts";

test("accepts the bounded declarative element set and returns a safe copy", () => {
  const input = { width: 300, height: 160, elements: [
    { id: "box-1", type: "box", x: 2, y: 3, width: 40, height: 20, text: "A" },
    { id: "cell-1", type: "cell", x: 50, y: 3, width: 40, height: 20, text: "2" },
    { id: "text-1", type: "text", x: 2, y: 40, text: "Start" },
    { id: "arrow-1", type: "arrow", x1: 42, y1: 12, x2: 50, y2: 12, label: "next" },
    { id: "line-1", type: "line", x1: 1, y1: 50, x2: 100, y2: 50, dashed: true },
    { id: "point-1", type: "point", x: 12, y: 70, label: "P" },
  ] };
  const diagram = validateDiagram(input);
  assert.equal(diagram?.elements.length, 6);
  assert.notEqual(diagram?.elements, input.elements);
  assert.deepEqual(diagram?.elements.map((item) => item.type), ["box", "cell", "text", "arrow", "line", "point"]);
});

test("validates visual provenance metadata and refuses malformed embedded diagrams", () => {
  const visual = { id: "visual-1", number: 1, title: "矩阵分块", kind: "figure", provenance: "source", source: { material_id: "pdf-1", material_name: "讲义", page: 12, matched: false } };
  assert.equal(validateVisualItem(visual)?.source?.matched, false);
  assert.equal(validateVisualItem({ ...visual, provenance: "invented", source: undefined })?.provenance, "invented");
  assert.equal(validateVisualItem({ ...visual, source: { ...visual.source, matched: "yes" } }), null);
  assert.equal(validateVisualItem({ ...visual, source: { ...visual.source, page: 0 } }), null);
  assert.equal(validateVisualItem({ ...visual, diagram: { width: 100, height: 100, elements: [{ id: "bad", type: "foreignObject", x: 1, y: 1 }] } }), null);
});

test("labels AI redraws cautiously and exposes unmatched source references", async () => {
  const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  try {
    const { provenanceText } = await server.ssrLoadModule("/src/workbench/ProvenanceBadge.tsx");
    assert.equal(provenanceText({ provenance: "redraw", source: { page: 12, matched: true } }), "AI 重绘 · 依据第 12 页 · 可能与原图有出入");
    assert.equal(provenanceText({ provenance: "redraw", source: { page: 12, matched: false } }), "AI 重绘 · 页码第 12 页，出处未核对 · 可能与原图有出入");
    assert.equal(provenanceText({ provenance: "source", source: { page: 12, matched: true, material_name: "讲义" } }), "原文 · 讲义 第 12 页");
    assert.equal(provenanceText({ provenance: "source", source: { page: 12, matched: false } }), "出处未核对 · 第 12 页");

    const { ProcessStepper } = await server.ssrLoadModule("/src/workbench/ProcessStepper.tsx");
    const item = {
      id: "redraw-process", number: 2, title: "矩阵变化", kind: "process", provenance: "redraw",
      source: { material_id: "pdf-1", material_name: "讲义", page: 12, matched: true, quote: "总引文" },
      image_url: "/api/courses/course-1/materials/pdf-1/pages/12",
      steps: [{ title: "变换矩阵", changes: ["交换两行"], reason: "保持等价", page: 24, quote: "这一步的原文", matched: true, uncertain: false, diagram: { width: 40, height: 30, elements: [{ id: "step-label", type: "text", x: 2, y: 12, text: "重绘步骤" }] } }],
    };
    const render = (original) => renderToStaticMarkup(React.createElement(ProcessStepper, { item, original, onClose() {}, onAsk() {}, onExcerpt() {}, onMaterial() {} }));
    const redraw = render(false);
    assert.match(redraw, /class="visual-diagram"/);
    assert.match(redraw, /AI 重绘 · 依据第 24 页/);
    assert.match(redraw, /这一步的原文/);
    assert.match(redraw, /交换两行/);
    assert.match(redraw, /为什么这样做/);
    const original = render(true);
    assert.doesNotMatch(original, /class="visual-diagram"/);
    assert.match(original, /原页图像无法显示/);
    assert.match(original, /AI 重绘 · 依据第 24 页/);
    assert.match(original, /打开第 24 页/);

    const unmatchedItem = { ...item, steps: [{ ...item.steps[0], page: 24, matched: undefined, uncertain: undefined }] };
    const unmatched = renderToStaticMarkup(React.createElement(ProcessStepper, { item: unmatchedItem, original: false, onClose() {}, onAsk() {}, onExcerpt() {} }));
    assert.match(unmatched, /出处未核对/);
    assert.match(unmatched, /识别可能不准/);

    const sourceItem = { ...item, provenance: "source", steps: [{ ...item.steps[0], page: 24, matched: undefined, uncertain: undefined, changes: ["不应显示"], reason: "不应显示" }] };
    const sourceMarkup = renderToStaticMarkup(React.createElement(ProcessStepper, { item: sourceItem, onClose() {}, onAsk() {}, onExcerpt() {} }));
    assert.match(sourceMarkup, /出处未核对/);
    assert.doesNotMatch(sourceMarkup, /不应显示/);
  } finally {
    await server.close();
  }
});

test("rejects invalid or unbounded diagrams instead of partially rendering them", () => {
  const base = { width: 100, height: 100, elements: [] };
  assert.equal(validateDiagram(null), null);
  assert.equal(validateDiagram({ ...base, width: Infinity }), null);
  assert.equal(validateDiagram({ ...base, height: 5000 }), null);
  assert.equal(validateDiagram({ ...base, elements: Array.from({ length: 81 }, (_, i) => ({ id: `p${i}`, type: "point", x: 1, y: 1 })) }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "point", x: NaN, y: 1 }] }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "point", x: 1, y: 1 }, { id: "x", type: "point", x: 2, y: 2 }] }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "html", x: 1, y: 1, markup: "<svg/>" }] }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "text", x: 1, y: 1, text: "safe", html: "<img src=x>" }] }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "text", x: 1, y: 1, text: "a".repeat(241) }] }), null);
  assert.equal(validateDiagram({ ...base, elements: [{ id: "x", type: "box", x: 1, y: 1, width: 0, height: 10 }] }), null);
});

test("accepts source process steps backed by real pages without diagrams", () => {
  const item = { id: "source-process", number: 1, title: "原文过程", kind: "process", provenance: "source", source: { material_id: "pdf-1", material_name: "stale name", page: 12, matched: true }, steps: [
    { title: "开始", changes: [], page: 12, quote: "原文第一步", matched: true, uncertain: false },
    { title: "继续", changes: ["变化"], page: 24 },
  ] };
  assert.equal(validateVisualItem(item)?.steps?.[0]?.diagram, undefined);
  assert.equal(validateVisualItem({ ...item, steps: [{ ...item.steps[0], page: undefined }] }), null);
  assert.equal(validateVisualItem({ ...item, steps: [{ ...item.steps[0], page: 0 }] }), null);
  assert.equal(validateVisualItem({ ...item, steps: [{ ...item.steps[0], quote: "x".repeat(2001) }] }), null);
  assert.equal(validateVisualItem({ ...item, steps: [{ ...item.steps[0], matched: "yes" }] }), null);
  assert.equal(validateVisualItem({ ...item, steps: [{ ...item.steps[0], uncertain: 1 }] }), null);
  assert.equal(validateVisualItem({ ...item, provenance: "redraw" }), null);
});

test("derives page URLs only from current course materials and ignores stored image URLs", () => {
  const materials = [{ id: "pdf-1", name: "当前讲义", pages: [{ number: 12 }, { number: 24 }] }];
  const item = { id: "source-1", number: 1, title: "原图", kind: "figure", provenance: "source", source: { material_id: "pdf-1", material_name: "伪造名称", page: 12, matched: true }, image_url: "https://attacker.example/track.png" };
  const safe = validateVisualForCourse(item, "course-1", materials);
  assert.equal(safe?.image_url, "/api/courses/course-1/materials/pdf-1/pages/12");
  assert.equal(safe?.source?.material_name, "当前讲义");
  assert.equal(validateVisualForCourse({ ...item, source: { ...item.source, material_id: "other-course-pdf" } }, "course-1", materials), null);
  assert.equal(validateVisualForCourse({ ...item, source: { ...item.source, page: 99 } }, "course-1", materials), null);
  assert.equal(materialPageImageAt(safe?.image_url, 24), "/api/courses/course-1/materials/pdf-1/pages/24");
  assert.equal(materialPageImageUrl("course-1", "pdf-1", 24), "/api/courses/course-1/materials/pdf-1/pages/24");
  assert.equal(isMaterialPageImageUrl("/api/courses/course-1/materials/pdf-1/pages/24"), true);
  assert.equal(isMaterialPageImageUrl("/api/courses/course-2/lessons/private"), false);
  assert.equal(isMaterialPageImageUrl("https://attacker.example/api/courses/course-1/materials/pdf-1/pages/24"), false);
});
