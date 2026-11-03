import type { EditorView } from "@codemirror/view";
import { Bold, Code, SquareCode, Heading1, Heading2, Heading3, Highlighter, Italic, Link, List, ListChecks, ListOrdered, Minus, Palette, Quote, Strikethrough, Type } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { colorSelection, highlightSelection, insertCodeBlock, insertDivider, insertLink, NOTE_COLORS, setBlock, toggleInline } from "./noteFormatting";

function Tool({ label, onRun, children }: { label: string; onRun: () => void; children: ReactNode }) {
  // mousedown keeps the editor selection, so the command applies to the selected text.
  return <button type="button" className="note-tool" title={label} aria-label={label}
    onMouseDown={(event) => { event.preventDefault(); onRun(); }}>{children}</button>;
}

export function ColorMenu({ view, compact }: { view: EditorView; compact?: boolean }) {
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" className="note-tool" title="文字颜色" aria-label="文字颜色" onMouseDown={(event) => event.preventDefault()}>
        <Palette size={compact ? 14 : 16} />
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-auto p-2" onOpenAutoFocus={(event) => event.preventDefault()}>
      <div className="flex items-center gap-1.5">
        {NOTE_COLORS.map((color) => <button key={color.key} type="button" className="note-swatch" title={`${color.label}色`}
          aria-label={`${color.label}色`} style={{ background: color.value }}
          onMouseDown={(event) => { event.preventDefault(); colorSelection(view, color.value); }} />)}
        <button type="button" className="note-tool text-xs" title="清除颜色" onMouseDown={(event) => { event.preventDefault(); colorSelection(view, null); }}>清除</button>
      </div>
    </PopoverContent>
  </Popover>;
}

/** Inline formatting shared by the top toolbar and the selection bubble. */
export function InlineTools({ view, compact }: { view: EditorView; compact?: boolean }) {
  const size = compact ? 14 : 16;
  return <>
    <Tool label="加粗 Ctrl+B" onRun={() => toggleInline(view, "**")}><Bold size={size} /></Tool>
    <Tool label="斜体 Ctrl+I" onRun={() => toggleInline(view, "*")}><Italic size={size} /></Tool>
    <Tool label="删除线" onRun={() => toggleInline(view, "~~")}><Strikethrough size={size} /></Tool>
    <Tool label="行内代码" onRun={() => toggleInline(view, "`")}><Code size={size} /></Tool>
    <ColorMenu view={view} compact={compact} />
    <Tool label="高亮" onRun={() => highlightSelection(view)}><Highlighter size={size} /></Tool>
    <Tool label="链接" onRun={() => insertLink(view)}><Link size={size} /></Tool>
  </>;
}

export function NoteToolbar({ view }: { view: EditorView | null }) {
  if (!view) return <div className="note-toolbar" />;
  return <div className="note-toolbar" role="toolbar" aria-label="笔记格式">
    <Tool label="正文" onRun={() => setBlock(view, "p")}><Type size={16} /></Tool>
    <Tool label="大标题 Ctrl+Alt+1" onRun={() => setBlock(view, "h1")}><Heading1 size={16} /></Tool>
    <Tool label="中标题 Ctrl+Alt+2" onRun={() => setBlock(view, "h2")}><Heading2 size={16} /></Tool>
    <Tool label="小标题 Ctrl+Alt+3" onRun={() => setBlock(view, "h3")}><Heading3 size={16} /></Tool>
    <span className="note-tool-sep" />
    <InlineTools view={view} />
    <span className="note-tool-sep" />
    <Tool label="无序列表" onRun={() => setBlock(view, "bullet")}><List size={16} /></Tool>
    <Tool label="有序列表" onRun={() => setBlock(view, "number")}><ListOrdered size={16} /></Tool>
    <Tool label="待办清单" onRun={() => setBlock(view, "todo")}><ListChecks size={16} /></Tool>
    <Tool label="引用" onRun={() => setBlock(view, "quote")}><Quote size={16} /></Tool>
    <Tool label="代码块" onRun={() => insertCodeBlock(view)}><SquareCode size={16} /></Tool>
    <Tool label="分隔线" onRun={() => insertDivider(view)}><Minus size={16} /></Tool>
    <span className="ml-auto text-xs text-muted-foreground max-[700px]:hidden">输入 / 唤出菜单 · 选中文字可设置格式</span>
  </div>;
}
