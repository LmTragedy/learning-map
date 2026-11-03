import { useState } from "react";
import { PanelRightClose, PanelRightOpen, Play } from "lucide-react";
import { Button } from "../components/ui/button";
import { DiagramView } from "./DiagramView";
import { validateVisualItem } from "./diagramModel";
import { materialPageImageAt } from "./diagramModel";
import { ProvenanceBadge, provenanceText } from "./ProvenanceBadge";
import type { VisualItem } from "./visualTypes";
import "./visuals.css";
import { SourceImage } from './SourceImage';

const COLLAPSED_KEY = "lm.visualRail.collapsed";
export function VisualRail({ items, activeId, onSelect }: { items: VisualItem[]; activeId?: string | null; onSelect: (id: string, trigger?: HTMLElement) => void }) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; } });
  if (!items.length) return null;
  const validatedItems = items.map(validateVisualItem).filter((entry): entry is VisualItem => entry !== null);
  const safeItems = validatedItems.filter((entry) => entry.provenance !== "source" || entry.kind !== "example");
  const invalidCount = items.length - validatedItems.length;
  if (!safeItems.length && !invalidCount) return null;
  if (!safeItems.length) return <aside className="visual-rail" aria-label="这节的例子和图"><p className="visual-diagram-error" role="status">例图数据无法显示。</p></aside>;
  const toggle = () => setCollapsed((value) => { const next = !value; try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* optional preference */ } return next; });
  return <aside className={`visual-rail${collapsed ? " is-collapsed" : ""}`} aria-label="这节的例子和图" data-visual-rail>
    <header className="visual-rail-header">{collapsed ? <Button size="icon-sm" variant="ghost" aria-label={`展开例图栏，${safeItems.length} 项`} onClick={toggle}><PanelRightOpen /></Button> : <><strong>这节的例子和图</strong><span className="visual-count">{safeItems.length}</span><Button size="icon-sm" variant="ghost" aria-label="收起例图栏" onClick={toggle}><PanelRightClose /></Button></>}</header>
    {invalidCount > 0 && <p className="visual-invalid-notice" role="status">有 {invalidCount} 项例图数据无法显示。</p>}
    {collapsed&&<div className="visual-rail-vertical-count" aria-hidden="true">{safeItems.length}</div>}<div className="visual-rail-list">{safeItems.map((item) => <button key={item.id} className={`visual-card provenance-${item.provenance}${item.provenance === "source" && !item.source?.matched ? " is-unchecked" : ""}${activeId === item.id ? " is-active" : ""}`} aria-label={`图 ${item.number}，${item.title}，${provenanceText(item)}，打开`} onClick={(event) => onSelect(item.id, event.currentTarget)}>
      <ProvenanceBadge item={item} />
      <div className={`visual-card-preview${item.provenance === "source" ? " is-source" : ""}`}>
        {item.provenance === "source" && item.kind !== "example" && item.image_url ? <SourceImage key={item.image_url} url={item.kind === "process" && item.steps?.[0]?.page ? materialPageImageAt(item.image_url,item.steps[0].page) : item.image_url} title={item.title} crop={item.kind === "process" ? undefined : item.source?.crop}/> : item.kind === "example" ? <span>{(item.source?.quote || item.body || item.explanation || item.title).slice(0, 180)}</span> : (item.diagram||item.steps?.[0]?.diagram) ? <DiagramView diagram={item.kind === "process" ? item.steps?.[0]?.diagram || item.diagram : item.diagram} label={`图 ${item.number} ${item.title}`} /> : <span>{(item.body || item.explanation || item.title).slice(0, 180)}</span>}
        {item.kind === "process" && item.steps?.length ? <span className="visual-play-pill"><Play size={12} fill="currentColor" />{item.steps.length} 步</span> : null}
      </div><span className="visual-card-title"><b>图 {item.number}</b><span>{item.provenance === "invented" ? "例：" : ""}{item.title}</span></span>
    </button>)}</div>
  </aside>;
}

