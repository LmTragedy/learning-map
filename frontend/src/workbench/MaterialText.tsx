/** Extracted page text; selecting some offers (via the workbench) to add it to the note or ask the AI. */
export function MaterialText({ text, uncertain }: { text: string; uncertain: boolean }) {
  return <div className="wb-text">
    {uncertain && <p className="text-xs text-st-new">这一页的文字识别可能不准确，请对照原文。</p>}
    <pre>{text || "这一页没有提取到文字，请切换到原文查看。"}</pre>
  </div>;
}
