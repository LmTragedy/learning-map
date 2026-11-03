import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMath, rehypeKatexPlugin, remarkCjkStrongPlugin, remarkMathPlugin } from "./mathMarkdown";
import "./nodeNotes.css";

/** AI replies are written in Markdown; show them formatted instead of as raw `**` and `>` marks. Raw HTML is not rendered. */
export function ChatMarkdown({ text }: { text: string }) {
  return <div className="chat-md">
    <Markdown remarkPlugins={[remarkGfm, remarkMathPlugin, remarkCjkStrongPlugin]} rehypePlugins={[rehypeKatexPlugin]} components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt || "未显示"}]</span>,
    }}>{normalizeMath(text)}</Markdown>
  </div>;
}
