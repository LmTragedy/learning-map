import type { VisualItem } from "./visualTypes";

export function provenanceText(item: VisualItem) {
  if (item.provenance === "invented") return "AI 自编 · 不是材料内容";
  const page = item.source?.page;
  if (item.provenance === "source" && !item.source?.matched) return `出处未核对 · 第 ${page ?? "?"} 页`;
  if (item.provenance === "source") return `原文 · ${item.source?.material_name || "材料"} 第 ${page ?? "?"} 页`;
  const reference = item.source?.matched ? `依据第 ${page ?? "?"} 页` : `页码第 ${page ?? "?"} 页，出处未核对`;
  return `AI 重绘 · ${reference} · 可能与原图有出入`;
}
