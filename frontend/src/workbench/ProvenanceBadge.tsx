import { FileText, FileWarning, PenLine, Sparkles } from "lucide-react";
import type { VisualItem } from "./visualTypes";

export function provenanceText(item: VisualItem) {
  if (item.provenance === "invented") return "AI 自编 · 不是材料内容";
  const page = item.source?.page;
  if (item.provenance === "source" && !item.source?.matched) return `出处未核对 · 第 ${page ?? "?"} 页`;
  if (item.provenance === "source") return `原文 · ${item.source?.material_name || "材料"} 第 ${page ?? "?"} 页`;
  const reference = item.source?.matched ? `依据第 ${page ?? "?"} 页` : `页码第 ${page ?? "?"} 页，出处未核对`;
  return `AI 重绘 · ${reference} · 可能与原图有出入`;
}
export function ProvenanceBadge({ item, compact = false }: { item: VisualItem; compact?: boolean }) {
  const unchecked = item.provenance === "source" && !item.source?.matched;
  const Icon = item.provenance === "invented" ? Sparkles : unchecked ? FileWarning : item.provenance === "redraw" ? PenLine : FileText;
  const full = `${provenanceText(item)}${item.source?.uncertain ? " · 识别可能不准" : ""}`;
  let label = full;
  if (compact) label = unchecked ? "未核对" : item.provenance === "source" ? "原文" : item.provenance === "redraw" ? "AI 重绘（可能有出入）" : "AI 自编";
  else if (item.provenance === "source" && item.source?.material_name && item.source.material_name.length > 10 && !unchecked) label = `原文 · ${item.source.material_name.slice(0, 10)}… 第 ${item.source.page} 页${item.source.uncertain ? " · 识别可能不准" : ""}`;
  return <span className={`visual-provenance${unchecked ? " is-unchecked" : ""}${item.provenance === "invented" ? " is-invented" : ""}`} title={full}><Icon size={14} aria-hidden="true" /><span>{label}</span></span>;
}
