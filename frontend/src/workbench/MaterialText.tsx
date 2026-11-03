import { useState } from "react";
import { MessageCircle, Quote } from "lucide-react";
import { Button } from "../components/ui/button";
import { quoteBlock } from "../noteFormatting";

/** Extracted page text; selecting some offers to quote it into the note or ask the AI about it. */
export function MaterialText({ text, uncertain, label, onExcerpt, onAsk }: {
  text: string; uncertain: boolean; label: string;
  onExcerpt: (block: string) => void;
  onAsk: (text: string) => void;
}) {
  const [selection, setSelection] = useState("");
  const keepSelection = (event: React.MouseEvent) => event.preventDefault();
  return <div className="wb-text" onMouseUp={() => setSelection(window.getSelection()?.toString().trim() || "")}>
    {uncertain && <p className="text-xs text-st-new">这一页的文字识别可能不准确，请对照原文。</p>}
    <pre>{text || "这一页没有提取到文字，请切换到原文查看。"}</pre>
    {selection && <div className="wb-excerpt" role="toolbar" aria-label="对所选文字">
      <Button size="sm" onMouseDown={keepSelection} onClick={() => { onExcerpt(quoteBlock(selection, label)); setSelection(""); }}><Quote /> 摘入笔记</Button>
      <Button size="sm" variant="outline" onMouseDown={keepSelection} onClick={() => { onAsk(`关于「${label}」这段：\n${selection}\n`); setSelection(""); }}><MessageCircle /> 问 AI</Button>
    </div>}
  </div>;
}
