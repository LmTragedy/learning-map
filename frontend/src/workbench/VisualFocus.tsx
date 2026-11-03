import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ExternalLink, FileText, MessageCircle, Quote, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { DiagramView } from "./DiagramView";
import { validateVisualItem } from "./diagramModel";
import { ProcessStepper } from "./ProcessStepper";
import { SourceImage } from './SourceImage';
import { ProvenanceBadge, provenanceText } from "./ProvenanceBadge";
import type { VisualItem } from "./visualTypes";

export function VisualFocus({ item, onClose, onMaterial, onAsk, onExcerpt, onRegenerate }: {
  item: VisualItem; onClose: () => void; onMaterial: (source: { materialId: string; page: number }) => void;
  onAsk: (text: string) => void; onExcerpt: (text: string) => void; onRegenerate?: (item: VisualItem) => void;
}) {
  const [original, setOriginal] = useState(false);
  const [inserted, setInserted] = useState(false);
  const safeItem = validateVisualItem(item);
  const source = item.source;
  const showsSourceImage = (item.provenance === "source" && item.kind !== "example") || original;
  const openMaterial = () => { if (source) { onMaterial({ materialId: source.material_id, page: source.page }); onClose(); } };
  const excerpt = `> ${source?.quote || item.title}\n> —— ${provenanceText(item)}`;
  const addExcerpt = () => { onExcerpt(excerpt); setInserted(true); window.setTimeout(() => setInserted(false), 1500); };
  const ask = () => onAsk(`关于「图 ${item.number} ${item.title}」：`);
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="visual-dialog-overlay" />
      <Dialog.Content asChild aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()}>
        <section className="visual-focus" aria-label={`图 ${item.number} ${item.title}`}>
          <Dialog.Title className="sr-only">{`图 ${item.number} ${item.title}`}</Dialog.Title>
          {!safeItem ? <><p className="visual-diagram-error" role="alert">例图数据无法显示。</p><Button size="sm" onClick={onClose}>回到讲解</Button></> : <>
    <header className="visual-focus-header"><button className="visual-back" onClick={onClose}><ChevronLeft size={16} />回到讲解</button><span className="visual-focus-separator" /><div className="visual-focus-title"><b>图 {item.number}</b><strong>{item.title}</strong></div>
      {item.provenance === "redraw" && <div className="wb-seg visual-segment"><button aria-pressed={!original} onClick={() => setOriginal(false)}>重绘</button><button aria-pressed={original} onClick={() => setOriginal(true)}>原图</button></div>}
      {item.kind === "process" && item.provenance === "source" ? <span className="visual-provenance" title={`${source?.material_name || "材料"} · 原文逐页对照`}><FileText size={14} aria-hidden="true" /><span>{source?.material_name || "材料"} · 原文逐页对照</span></span> : item.kind === "process" && item.provenance === "redraw" ? <span className="visual-provenance" title={`${source?.material_name || "材料"} · AI 重绘可能与原图有出入`}><FileText size={14} aria-hidden="true" /><span>{source?.material_name || "材料"} · AI 重绘可能与原图有出入</span></span> : <ProvenanceBadge item={item} />}{source && !(item.kind === "process" && item.provenance === "source") && <Button size="sm" variant="ghost" onClick={openMaterial}><ExternalLink /> 打开原页</Button>}
    </header>
    {item.kind === "process" ? <ProcessStepper item={item} original={original} onClose={onClose} onAsk={onAsk} onExcerpt={onExcerpt} onMaterial={onMaterial} /> : <>
      <div className={`visual-focus-canvas${item.provenance === "source" || original ? " is-image" : ""}`}>
        {showsSourceImage && source && !source.crop && <div className="visual-ocr-warning">整页显示，未定位到具体图。</div>}
        {item.provenance === "source" && item.kind === "example"
          ? <div className="visual-focus-prose"><h2>{item.title}</h2><p>{source?.quote || item.body || item.explanation}</p>{source?.quote&&item.body&&item.body!==source.quote&&<p>{item.body}</p>}</div>
          : item.provenance === "source" || original
          ? <SourceImage key={item.image_url} url={item.image_url} title={`${source?.crop ? "原文裁剪图" : "原文页图"}：图 ${item.number} ${item.title}`} crop={source?.crop}/>
          : item.diagram ? <DiagramView diagram={item.diagram} label={`图 ${item.number} ${item.title}`} /> : <div className="visual-focus-prose"><h2>{item.provenance === "invented" ? `例：${item.title}` : item.title}</h2><p>{item.body || item.explanation}</p></div>}
      </div>
      <div className="visual-focus-notes">{source?.quote && item.kind !== "example" && <p><b>引文：</b>{source.quote}</p>}{item.explanation && <p><b>AI 说明：</b>{item.explanation}</p>}{source?.uncertain && <p className="visual-ocr-warning">这一页的文字识别可能不准确，请对照原页。</p>}</div>
      <footer className="visual-focus-footer">{item.provenance === "invented" && onRegenerate && <Button className="visual-regenerate" size="sm" variant="ghost" onClick={() => onRegenerate(item)}><RefreshCw /> 换一个例子</Button>}<Button size="sm" onClick={addExcerpt}><Quote /> {inserted ? "已摘入" : "摘入笔记"}</Button><Button size="sm" variant="outline" onClick={ask}><MessageCircle /> 问 AI</Button></footer>
    </>}
          </>}
        </section>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
