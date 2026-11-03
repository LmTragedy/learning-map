import { EditorSelection } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/** Colours a note may use; the same exact values are allowed by the reading view's sanitizer. */
export const NOTE_COLORS = [
  { key: "red", label: "红", value: "#e5484d" },
  { key: "orange", label: "橙", value: "#f76b15" },
  { key: "green", label: "绿", value: "#30a46c" },
  { key: "blue", label: "蓝", value: "#3e8ef7" },
  { key: "purple", label: "紫", value: "#8e4ec6" },
  { key: "gray", label: "灰", value: "#8b8d98" },
] as const;
export const HIGHLIGHT = "#f5d90a55";

/** Note text without Markdown markers or colour tags, for one-line previews. */
export function plainPreview(content: string) {
  return content
    .replace(/<\/?(span|mark)[^>]*>/g, "")
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function mainNoteTitle(node: { title: string; personal_note_title?: string }) {
  return node.personal_note_title?.trim() || node.title;
}

const BLOCK_PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

export type Block = "p" | "h1" | "h2" | "h3" | "bullet" | "number" | "todo" | "quote";
const prefixes: Record<Block, string> = {
  p: "", h1: "# ", h2: "## ", h3: "### ", bullet: "- ", number: "1. ", todo: "- [ ] ", quote: "> ",
};

/** Replace the block marker of every selected line, e.g. turn a paragraph into a heading. */
export function setBlock(view: EditorView, block: Block) {
  const { state } = view;
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let at = state.doc.lineAt(range.from).number; at <= state.doc.lineAt(range.to).number; at++) lines.add(at);
  }
  const changes = [...lines].map((number, index) => {
    const line = state.doc.line(number);
    const match = BLOCK_PREFIX.exec(line.text)!;
    const marker = block === "number" ? `${index + 1}. ` : prefixes[block];
    // Choosing the block a line already has turns it back into a paragraph.
    const same = (match[2] || "") === marker && block !== "p";
    return { from: line.from + match[1].length, to: line.from + match[0].length, insert: same ? "" : marker };
  });
  const changeSet = state.changes(changes);
  // Keep a cursor at the line start after the new marker, so typing continues inside the block.
  view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1), userEvent: "input.format" });
  view.focus();
}

/** Wrap or unwrap the selection with an inline marker such as ** or ~~. */
export function toggleInline(view: EditorView, open: string, close = open) {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - open.length, range.from);
    const after = state.sliceDoc(range.to, range.to + close.length);
    if (before === open && after === close) {
      return {
        changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }],
        range: EditorSelection.range(range.from - open.length, range.to - open.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
      range: EditorSelection.range(range.from + open.length, range.to + open.length),
    };
  }), { userEvent: "input.format" });
  view.focus();
}

export function colorSelection(view: EditorView, color: string | null) {
  if (color === null) return clearColor(view);
  toggleInline(view, `<span style="color:${color}">`, "</span>");
}

export function highlightSelection(view: EditorView) {
  toggleInline(view, `<mark style="background:${HIGHLIGHT}">`, "</mark>");
}

function clearColor(view: EditorView) {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const plain = text.replace(/<span style="color:#[0-9a-f]{6}">|<\/span>|<mark style="background:#[0-9a-f]{8}">|<\/mark>/gi, "");
    return { changes: { from: range.from, to: range.to, insert: plain }, range: EditorSelection.range(range.from, range.from + plain.length) };
  }), { userEvent: "input.format" });
  view.focus();
}

export function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const label = view.state.sliceDoc(from, to) || "链接文字";
  view.dispatch({ changes: { from, to, insert: `[${label}](https://)` },
    selection: { anchor: from + label.length + 3, head: from + label.length + 11 }, userEvent: "input.format" });
  view.focus();
}

export function insertDivider(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = line.text.trim() ? "\n\n---\n" : "---\n";
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, userEvent: "input.format" });
  view.focus();
}

/** Wrap the selected lines in a fenced code block, or start an empty one on a new line. */
export function insertCodeBlock(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from), last = state.doc.lineAt(range.to);
  if (!range.empty) {
    const body = state.sliceDoc(first.from, last.to);
    const insert = `\`\`\`\n${body}\n\`\`\``;
    view.dispatch({ changes: { from: first.from, to: last.to, insert },
      selection: { anchor: first.from + 3 }, userEvent: "input.format" });
  } else {
    // An empty line becomes the block; otherwise the block opens below the current line.
    const blank = !first.text.trim();
    const from = blank ? first.from : first.to;
    const lead = blank ? "" : "\n";
    const insert = `${lead}\`\`\`\n\n\`\`\``;
    view.dispatch({ changes: { from, to: blank ? first.to : first.to, insert },
      selection: { anchor: from + lead.length + 4 }, userEvent: "input.format" });
  }
  view.focus();
}

/** Put a multi-line template on its own lines below the cursor (or on the current empty line). */
function insertTemplate(view: EditorView, template: string, cursor: number) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const blank = !line.text.trim();
  // A blank line before keeps the block from joining the paragraph or list item above.
  const lead = blank ? "" : "\n\n";
  const from = blank ? line.from : line.to;
  view.dispatch({ changes: { from, to: line.to, insert: lead + template },
    selection: { anchor: from + lead.length + cursor }, userEvent: "input.format" });
  view.focus();
}

/** A display formula: $$ … $$ on their own lines, typeset when the cursor leaves it. */
export function insertMathBlock(view: EditorView) {
  const { from, to, empty } = view.state.selection.main;
  const body = empty ? "" : view.state.sliceDoc(from, to);
  if (!empty) {
    view.dispatch({ changes: { from, to, insert: `\n$$\n${body}\n$$\n` }, selection: { anchor: from + 4 }, userEvent: "input.format" });
    view.focus(); return;
  }
  insertTemplate(view, "$$\n\n$$", 3);
}

export function insertInlineMath(view: EditorView) { toggleInline(view, "$"); }

export function insertTable(view: EditorView) {
  insertTemplate(view, "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |", 2);
}

/** A callout: a quote that starts with an icon and a bold label. */
export function insertCallout(view: EditorView, icon = "💡", label = "提示") {
  const text = `> ${icon} **${label}**：`;
  insertTemplate(view, text, text.length);
}

/** Inside a fenced code block, Tab indents instead of leaving the editor. */
export function indentInCode(view: EditorView) {
  const { state } = view;
  const head = state.selection.main.head;
  let inside = false;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(head, -1); node; node = node.parent) {
    if (node.name === "FencedCode") { inside = true; break; }
  }
  if (!inside) return false;
  view.dispatch(state.replaceSelection("  "), { userEvent: "input.indent" });
  return true;
}

/** Append text (for example a PDF excerpt or an AI answer) as a new block at the end of the note. */
export function appendBlock(content: string, block: string) {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function quoteBlock(text: string, source: string) {
  const body = text.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `${body}\n> \n> —— ${source}`;
}

type SlashItem = { label: string; detail: string; keys: string; run: (view: EditorView) => void };
const slashItems: SlashItem[] = [
  { label: "大标题", detail: "H1", keys: "h1 biaoti dabiaoti title", run: (view) => setBlock(view, "h1") },
  { label: "中标题", detail: "H2", keys: "h2 biaoti zhongbiaoti", run: (view) => setBlock(view, "h2") },
  { label: "小标题", detail: "H3", keys: "h3 biaoti xiaobiaoti", run: (view) => setBlock(view, "h3") },
  { label: "正文", detail: "段落", keys: "p text zhengwen", run: (view) => setBlock(view, "p") },
  { label: "无序列表", detail: "•", keys: "ul list liebiao bullet", run: (view) => setBlock(view, "bullet") },
  { label: "有序列表", detail: "1.", keys: "ol number youxu", run: (view) => setBlock(view, "number") },
  { label: "待办清单", detail: "☐", keys: "todo daiban check", run: (view) => setBlock(view, "todo") },
  { label: "引用", detail: "❝", keys: "quote yinyong", run: (view) => setBlock(view, "quote") },
  { label: "分隔线", detail: "—", keys: "hr divider fengexian", run: insertDivider },
  { label: "公式块", detail: "$$", keys: "math formula gongshi latex katex block", run: insertMathBlock },
  { label: "行内公式", detail: "$", keys: "math inline gongshi latex", run: insertInlineMath },
  { label: "表格", detail: "▦", keys: "table biaoge", run: insertTable },
  { label: "提示框", detail: "💡", keys: "callout tip tishi", run: (view) => insertCallout(view) },
  { label: "注意框", detail: "⚠️", keys: "callout warning zhuyi", run: (view) => insertCallout(view, "⚠️", "注意") },
  { label: "定义框", detail: "📘", keys: "callout definition dingyi", run: (view) => insertCallout(view, "📘", "定义") },
  { label: "例子框", detail: "✏️", keys: "callout example lizi", run: (view) => insertCallout(view, "✏️", "例子") },
  { label: "代码块", detail: "```", keys: "code block daimakuai pre", run: insertCodeBlock },
  { label: "行内代码", detail: "`", keys: "code inline daima", run: (view) => toggleInline(view, "`") },
  ...NOTE_COLORS.map((color) => ({ label: `${color.label}色文字`, detail: "颜色", keys: `color yanse ${color.key}`, run: (view: EditorView) => colorSelection(view, color.value) })),
  { label: "高亮", detail: "荧光笔", keys: "highlight gaoliang mark", run: highlightSelection },
];

/** "/" at the start of a word opens a block menu, like Notion. */
export function slashCommands(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/(?:^|\s)\/[\w一-龥]*$/);
  if (!word) return null;
  const slash = word.from + word.text.indexOf("/");
  const query = context.state.sliceDoc(slash + 1, context.pos).toLowerCase();
  const options: Completion[] = slashItems
    .filter((item) => !query || item.label.includes(query) || item.keys.includes(query))
    .map((item) => ({
      label: item.label, detail: item.detail,
      apply: (view, _completion, from, to) => {
        view.dispatch({ changes: { from, to } });
        item.run(view);
      },
    }));
  return { from: slash, to: context.pos, options, filter: false };
}
