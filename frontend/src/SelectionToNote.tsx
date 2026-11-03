import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MessageCircle, NotebookPen } from "lucide-react";
import { quoteBlock } from "./noteFormatting";

type Picked = { text: string; top: number; left: number };

/**
 * Selecting text anywhere inside (including a same-origin lesson iframe) shows a small bar
 * to add the text to the note or ask the AI about it.
 */
export function SelectionToNote({ label, onExcerpt, onAsk, className, children }: {
  label: string;
  onExcerpt: (block: string) => void;
  onAsk?: (text: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    const host = box.current;
    if (!host) return;
    const read = (doc: Document, frame?: HTMLIFrameElement) => {
      const selection = doc.getSelection();
      const text = selection?.toString().trim() || "";
      if (!selection || !text || !selection.rangeCount) { setPicked(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const offset = frame?.getBoundingClientRect();
      const outer = host.getBoundingClientRect();
      const top = rect.top + (offset?.top ?? 0) - outer.top;
      const left = rect.left + rect.width / 2 + (offset?.left ?? 0) - outer.left;
      setPicked({ text, top: Math.max(4, top - 44), left: Math.min(Math.max(8, left - 90), Math.max(8, outer.width - 200)) });
    };
    // Wait a tick so a click that collapses the selection is seen as empty.
    const onUp = (doc: Document, frame?: HTMLIFrameElement) => (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".selection-note-bar")) return;
      window.setTimeout(() => read(doc, frame), 0);
    };
    const hostUp = onUp(document);
    host.addEventListener("mouseup", hostUp);
    host.addEventListener("keyup", hostUp);
    const detach: (() => void)[] = [];
    const bound = new WeakSet<Document>();
    const attach = (frame: HTMLIFrameElement) => {
      let doc: Document | null = null;
      try { doc = frame.contentDocument; } catch { return; }
      if (!doc || bound.has(doc) || doc.location.href === "about:blank") return;
      bound.add(doc);
      const handler = onUp(doc, frame);
      const hide = () => setPicked(null);
      doc.addEventListener("mouseup", handler);
      doc.addEventListener("keyup", handler);
      doc.addEventListener("scroll", hide, true);
      detach.push(() => {
        doc!.removeEventListener("mouseup", handler);
        doc!.removeEventListener("keyup", handler);
        doc!.removeEventListener("scroll", hide, true);
      });
    };
    const scan = () => host.querySelectorAll("iframe").forEach((frame) => {
      attach(frame);
      if (!frame.dataset.selectionWatch) {
        frame.dataset.selectionWatch = "1";
        frame.addEventListener("load", () => attach(frame));
      }
    });
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(host, { childList: true, subtree: true });
    const hide = () => setPicked(null);
    host.addEventListener("scroll", hide, true);
    return () => {
      observer.disconnect();
      host.removeEventListener("mouseup", hostUp);
      host.removeEventListener("keyup", hostUp);
      host.removeEventListener("scroll", hide, true);
      detach.forEach((run) => run());
    };
  }, []);

  const keep = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  const done = () => {
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    box.current?.querySelectorAll("iframe").forEach((frame) => {
      try { frame.contentWindow?.getSelection()?.removeAllRanges(); } catch { /* cross-origin frame */ }
    });
  };
  return <div ref={box} className={`selection-note ${className ?? ""}`}>
    {children}
    {picked && <div className="selection-note-bar" role="toolbar" aria-label="对所选文字" style={{ top: picked.top, left: picked.left }}
      onMouseDown={keep}>
      <button type="button" onClick={() => { onExcerpt(quoteBlock(picked.text, label)); done(); }}><NotebookPen size={14} aria-hidden />加入笔记</button>
      {onAsk && <button type="button" onClick={() => { onAsk(`关于「${label}」这段：\n${picked.text}\n`); done(); }}><MessageCircle size={14} aria-hidden />问 AI</button>}
    </div>}
  </div>;
}
