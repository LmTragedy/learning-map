import { useDeferredValue, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { HIGHLIGHT, NOTE_COLORS } from "./noteFormatting";
import { Button } from "./components/ui/button";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor";
import type { NoteEditorActions } from "./noteReviewTypes";

type View = "live" | "source" | "read";
const views: { key: View; label: string }[] = [
  { key: "live", label: "编辑" },
  { key: "read", label: "阅读" },
  { key: "source", label: "源码" },
];

// Only the editor's own colour and highlight tags survive; any other HTML in a note is dropped.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "mark", "span"],
  attributes: {
    ...defaultSchema.attributes,
    span: [["style", ...NOTE_COLORS.map((color) => `color:${color.value}`)]],
    mark: [["style", `background:${HIGHLIGHT}`]],
  },
};

export default function MarkdownNoteEditor({ content, onChange, onReady, onTab }: {
  content: string;
  onChange: (content: string) => void;
  onReady?: (actions: NoteEditorActions | null) => void;
  onTab?: () => boolean;
}) {
  const [view, setView] = useState<View>("live");
  const preview = useDeferredValue(content);
  return <div className="node-note-editor">
    <div className="node-note-editor-toolbar">
      <div role="group" aria-label="笔记显示方式" className="ml-auto flex flex-wrap gap-1">
        {views.map(({ key, label }) => <Button key={key} size="sm" variant={view === key ? "secondary" : "ghost"}
          aria-pressed={view === key} onClick={() => setView(key)}>{label}</Button>)}
      </div>
    </div>
    <div className="node-note-panes" data-view={view}>
      <div hidden={view === "read"}><LiveMarkdownEditor content={content} onChange={onChange} live={view !== "source"} onReady={onReady} onTab={onTab} /></div>
      {view === "read" && <article aria-label="笔记阅读预览" className="node-note-preview">
        {preview ? <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]} components={{
          // Notes remain local: a preview never fetches an embedded image.
          img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt || "未显示"}]</span>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}>{preview}</Markdown> : <p className="text-muted-foreground">这里会显示笔记的阅读效果。</p>}
      </article>}
    </div>
  </div>;
}
