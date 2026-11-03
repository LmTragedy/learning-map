import type { EditorView } from "@codemirror/view";
import { Bold, Code, SquareCode, Sigma, Table, Lightbulb, TriangleAlert, BookMarked, PencilLine, Plus, Radical, Heading1, Heading2, Heading3, Highlighter, Italic, Link, List, ListChecks, ListOrdered, Minus, Palette, Quote, Strikethrough, Type } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { colorSelection, highlightSelection, insertCallout, insertCodeBlock, insertDivider, insertInlineMath, insertMathBlock, insertTable, insertLink, NOTE_COLORS, setBlock, toggleInline } from "./noteFormatting";

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

/** Blocks that need more than a line marker: code, formulas, tables and callouts. */
function InsertMenu({ view }: { view: EditorView }) {
  const items: { label: string; hint: string; icon: ReactNode; run: () => void }[] = [
    { label: "代码块", hint: "Ctrl+Alt+C", icon: <SquareCode size={15} />, run: () => insertCodeBlock(view) },
    { label: "公式块", hint: "$$ LaTeX $$", icon: <Sigma size={15} />, run: () => insertMathBlock(view) },
    { label: "行内公式", hint: "$x^2$", icon: <Radical size={15} />, run: () => insertInlineMath(view) },
    { label: "表格", hint: "3 列", icon: <Table size={15} />, run: () => insertTable(view) },
    { label: "提示框", hint: "💡", icon: <Lightbulb size={15} />, run: () => insertCallout(view) },
    { label: "注意框", hint: "⚠️", icon: <TriangleAlert size={15} />, run: () => insertCallout(view, "⚠️", "注意") },
    { label: "定义框", hint: "📘", icon: <BookMarked size={15} />, run: () => insertCallout(view, "📘", "定义") },
    { label: "例子框", hint: "✏️", icon: <PencilLine size={15} />, run: () => insertCallout(view, "✏️", "例子") },
    { label: "待办清单", hint: "☐", icon: <ListChecks size={15} />, run: () => setBlock(view, "todo") },
    { label: "分隔线", hint: "---", icon: <Minus size={15} />, run: () => insertDivider(view) },
  ];
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" className="note-tool note-tool-insert" title="插入代码块、公式、表格、提示框…" aria-label="插入块" onMouseDown={(event) => event.preventDefault()}>
        <Plus size={16} /><span>插入</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="note-insert-menu w-56 p-1.5" onOpenAutoFocus={(event) => event.preventDefault()}>
      {items.map((item) => <button key={item.label} type="button" className="note-insert-item"
        onMouseDown={(event) => { event.preventDefault(); item.run(); }}>
        {item.icon}<span>{item.label}</span><kbd>{item.hint}</kbd>
      </button>)}
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
    <span className="note-tool-sep" />
    <InsertMenu view={view} />
    <span className="note-toolbar-hint">输入 / 唤出菜单</span>
  </div>;
}
