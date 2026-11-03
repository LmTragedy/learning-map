import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageCircle, Quote, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { DiagramView } from "./DiagramView";
import { SourceImage } from "./SourceImage";
import { materialPageImageAt } from "./diagramModel";
import { provenanceText } from "./provenance";
import type { VisualItem } from "./visualTypes";

export function ProcessStepper({ item, original = false, onClose, onAsk, onExcerpt, onMaterial }: {
  original?: boolean;
  item: VisualItem; onClose: () => void; onAsk: (text: string) => void; onExcerpt: (text: string) => void;
  onMaterial?: (source: { materialId: string; page: number }) => void;
}) {
  const steps = item.steps || [];
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const step = steps[index];
  useEffect(() => { root.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) || (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); setIndex((n) => Math.max(0, n - 1)); }
      else if (event.key === "ArrowRight") { event.preventDefault(); setIndex((n) => Math.min(steps.length - 1, n + 1)); }
      else if (event.key === "Home") { event.preventDefault(); setIndex(0); }
      else if (event.key === "End") { event.preventDefault(); setIndex(steps.length - 1); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);
  if (!step) return <div className="visual-empty" role="status">过程图暂无步骤。</div>;
  const stepPage = step.page ?? item.source?.page;
  const sameParentPage = stepPage === item.source?.page;
  const stepSource = item.source && (item.provenance === "source" || item.provenance === "redraw") ? {
    ...item.source,
    page: stepPage ?? item.source.page,
    quote: step.quote ?? (sameParentPage ? item.source.quote : undefined),
    matched: step.matched ?? (sameParentPage ? item.source.matched : false),
    uncertain: step.uncertain ?? (sameParentPage ? item.source.uncertain ?? true : true),
  } : undefined;
  const stepImageUrl = stepSource ? materialPageImageAt(item.image_url, stepSource.page) : undefined;
  const sourceLabel = stepSource ? `${provenanceText({ ...item, source: stepSource })}${stepSource.uncertain ? " · 识别可能不准" : ""}` : provenanceText(item);
  const excerptContent = [
    stepSource?.quote ? `> ${stepSource.quote}` : "",
    item.provenance === "source" ? "" : step.changes.map((change) => `- ${change}`).join("\n"),
    item.provenance === "source" ? "" : step.reason ? `为什么这样做：${step.reason}` : "",
    `> —— ${sourceLabel}`,
  ].filter(Boolean).join("\n");
  const excerpt = `**图 ${item.number} 第 ${index + 1} 步：${step.title}**\n${excerptContent}`;
  const showsSourceImage = item.provenance === "source" || original;
  return <div className="visual-stepper" ref={root} tabIndex={-1} aria-label="过程图">
    <div className="visual-progress"><div className="visual-progress-dots" aria-label={`第 ${index + 1} / ${steps.length} 步`}>
      {steps.length<=8&&<div className="visual-progress-track is-compact"><span style={{width:`${((index+1)/steps.length)*100}%`}} /></div>}
      {steps.length > 8 ? <div className="visual-progress-track"><span style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div> : steps.map((entry, i) => <span className="visual-dot-wrap" key={`${i}-${entry.title}`}><button className={`visual-dot${i < index ? " is-done" : ""}${i === index ? " is-current" : ""}`} aria-label={`第 ${i + 1} 步：${entry.title}`} aria-current={i === index ? "step" : undefined} title={`第 ${i + 1} 步：${entry.title}`} onClick={() => setIndex(i)} /><i aria-hidden="true" /></span>)}
    </div><span className="visual-step-count">第 {index + 1} / {steps.length} 步</span></div>
    <div className="visual-step-title" aria-live="polite" aria-label={`第 ${index+1} 步，共 ${steps.length} 步：${step.title}`}><strong>{index === 0 && !stepSource && <span>起始 · </span>}{step.title}</strong>{stepSource&&<span>{sourceLabel}</span>}{stepSource?.page && onMaterial && <button onClick={() => onMaterial({ materialId: stepSource.material_id, page: stepSource.page })}>打开第 {stepSource.page} 页</button>}</div>
    <div className="visual-step-canvas"><div>{showsSourceImage && stepSource ? <SourceImage key={stepImageUrl} url={stepImageUrl} title={`原文：${stepSource.material_name} 第 ${stepSource.page} 页`} /> : step.diagram ? <DiagramView diagram={index===0?{...step.diagram,elements:step.diagram.elements.map(e=>({...e,changed:false}))}:step.diagram} label={`图 ${item.number} 第 ${index + 1} 步`} /> : <div className="visual-empty" role="status">{original ? "这一步没有可显示的原图。" : "这一步没有可显示的图示。"}</div>}</div></div>
    {(item.provenance === "source" ? Boolean(stepSource?.quote) : stepSource?.quote || step.changes.length > 0 || step.reason) && <div className={`visual-step-notes${index===0&&!stepSource?' is-initial':''}`}>
      {stepSource?.quote && <><h3>{item.provenance === "source" ? "原文" : "原文参考"}</h3><p>{stepSource.quote}</p></>}
      {item.provenance !== "source" && <><h3>这一步变了什么</h3><ul>{(step.changes.length ? step.changes : index === 0 ? ["起始状态"] : []).map((change, i) => <li key={`${i}-${change}`}>{change}</li>)}</ul>{step.reason && <><h3>为什么这样做</h3><p>{step.reason}</p></>}</>}
    </div>}
    <footer className="visual-step-controls"><div><Button size="sm" variant="ghost" disabled={index === 0} title={index === 0 ? "已在第一步" : undefined} onClick={() => setIndex(0)}><RotateCcw /> 重置</Button></div><div><Button size="sm" variant="outline" disabled={index === 0} title={index === 0 ? "已是第一步" : undefined} onClick={() => setIndex(index - 1)}><ChevronLeft /> 上一步</Button><Button size="sm" onClick={() => index === steps.length - 1 ? onClose() : setIndex(index + 1)}>{index === steps.length - 1 ? <>看完了 · 回到讲解 <Check /></> : <>下一步 <ChevronRight /></>}</Button></div><div><Button size="sm" variant="ghost" onClick={() => onAsk(`关于「图 ${item.number} ${item.title}」第 ${index + 1} 步（${step.title}）：`)}><MessageCircle /> 问 AI 这一步</Button><Button size="sm" variant="ghost" onClick={() => onExcerpt(excerpt)}><Quote /> 摘入笔记</Button></div></footer>
  </div>;
}
