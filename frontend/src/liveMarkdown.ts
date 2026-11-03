import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { noteBlocks, renderMath } from "./noteBlocks";

class InlineMath extends WidgetType {
  constructor(readonly tex: string) { super(); }
  eq(other: InlineMath) { return other.tex === this.tex; }
  toDOM() { const math = renderMath(this.tex, false); math.className = "cm-note-inlinemath"; return math; }
}

// $x$ but not $$, an escaped \$, or a price like "$5 and $6" with spaces just inside the dollars.
const INLINE_MATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\$)/g;

class Bullet extends WidgetType {
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-note-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

class TaskBox extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super(); }
  eq(other: TaskBox) { return other.checked === this.checked && other.at === this.at; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-note-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "已完成，点击取消" : "未完成，点击勾选");
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: this.checked ? " " : "x" }, userEvent: "input.task" });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

const INLINE_STYLE = /<(span) style="color:(#[0-9a-fA-F]{6})">(.*?)<\/span>|<(mark) style="background:(#[0-9a-fA-F]{8})">(.*?)<\/mark>/g;
const CALLOUTS: Record<string, string> = { "💡": "tip", "⚠️": "warn", "📘": "def", "✏️": "example" };
const CALLOUT = /^\s*>\s*(💡|⚠️|📘|✏️)/u;
// Markdown will not close ** after a full-width bracket when a CJK character follows (e.g. **关系（relation）**就是).
const LOOSE_STRONG = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;
const TASK = /^(\s*[-*+]\s+)\[([ xX])\]\s/;

/** Colours, highlights and to-do boxes: Markdown has no syntax for them, so notes keep small HTML tags. */
function extras(view: EditorView, ranges: Range<Decoration>[], editing: (from: number, to: number) => boolean, code: Set<number>) {
  for (const visible of view.visibleRanges) {
    let at = visible.from;
    while (at <= visible.to) {
      const line = view.state.doc.lineAt(at);
      // Code is shown as typed: no colours or checkboxes inside a code block.
      if (code.has(line.number)) { at = line.to + 1; continue; }
      const active = editing(line.from, line.to);
      for (const match of line.text.matchAll(INLINE_STYLE)) {
        const start = line.from + match.index!;
        const openLength = match[0].indexOf(">") + 1;
        const inner = match[3] ?? match[6];
        const closeLength = 7; // "</span>" and "</mark>"
        const style = match[1] ? `color:${match[2]}` : `background:${match[5]};border-radius:3px`;
        if (inner) ranges.push(Decoration.mark({ attributes: { style } }).range(start + openLength, start + openLength + inner.length));
        if (!active) {
          ranges.push(Decoration.replace({}).range(start, start + openLength));
          ranges.push(Decoration.replace({}).range(start + openLength + inner.length, start + openLength + inner.length + closeLength));
        }
      }
      for (const match of line.text.matchAll(LOOSE_STRONG)) {
        const start = line.from + match.index!;
        let parsed = false;
        for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(start + 2, 1); node; node = node.parent)
          if (node.name === "StrongEmphasis" || node.name === "InlineCode" || node.name === "FencedCode") { parsed = true; break; }
        if (parsed) continue;
        ranges.push(Decoration.mark({ class: "cm-note-strong" }).range(start + 2, start + match[0].length - 2));
        if (!active) {
          ranges.push(Decoration.replace({}).range(start, start + 2));
          ranges.push(Decoration.replace({}).range(start + match[0].length - 2, start + match[0].length));
        }
      }
      if (!active) for (const match of line.text.matchAll(INLINE_MATH)) {
        // Inline code keeps its dollars: an odd number of backticks before the match means it is inside code.
        if ((line.text.slice(0, match.index).match(/`/g)?.length ?? 0) % 2) continue;
        const start = line.from + match.index!;
        ranges.push(Decoration.replace({ widget: new InlineMath(match[1]) }).range(start, start + match[0].length));
      }
      const task = TASK.exec(line.text);
      if (task && !active) {
        const box = line.from + task[1].length;
        ranges.push(Decoration.replace({ widget: new TaskBox(task[2] !== " ", box + 1) }).range(box, box + 4));
        if (task[2] !== " ") ranges.push(Decoration.line({ class: "cm-note-done" }).range(line.from));
      }
      at = line.to + 1;
    }
  }
}

function decorations(view: EditorView) {
  const ranges: Range<Decoration>[] = [];
  const visited = new Set<string>();
  const code = new Set<number>();
  const editing = (from: number, to: number) => view.hasFocus && view.state.selection.ranges.some((selection) =>
    view.state.doc.lineAt(selection.from).from <= to && view.state.doc.lineAt(selection.to).to >= from);
  for (const visible of view.visibleRanges) syntaxTree(view.state).iterate({
    from: visible.from, to: visible.to,
    enter(node) {
      const key = `${node.name}:${node.from}`;
      if (visited.has(key)) return;
      visited.add(key);
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (heading) ranges.push(Decoration.line({ class: `cm-note-heading${heading[1]}` }).range(view.state.doc.lineAt(node.from).from));
      if (node.name === "Blockquote") {
        // Every line of a multi-line quote keeps the quote bar; a quote opening with an icon is a callout box.
        const first = view.state.doc.lineAt(node.from).number, last = view.state.doc.lineAt(node.to).number;
        const callout = CALLOUT.exec(view.state.doc.line(first).text)?.[1];
        for (let line = first; line <= last; line++) {
          const edge = line === first ? " is-first" : "";
          const end = line === last ? " is-last" : "";
          ranges.push(Decoration.line({ class: callout ? `cm-note-callout is-${CALLOUTS[callout]}${edge}${end}` : "cm-note-quote" }).range(view.state.doc.line(line).from));
        }
      }
      if (node.name === "FencedCode") {
        // One continuous box for the block; the fence lines shrink to a thin edge when not editing.
        const first = view.state.doc.lineAt(node.from).number, last = view.state.doc.lineAt(node.to).number;
        const open = editing(node.from, node.to);
        for (let line = first; line <= last; line++) {
          code.add(line);
          const edge = line === first ? " cm-note-codeblock-first" : line === last ? " cm-note-codeblock-last" : "";
          const fence = (line === first || (line === last && last > first && /^\s*(`{3,}|~{3,})\s*$/.test(view.state.doc.line(line).text)))
            && !open ? " cm-note-codefence" : "";
          ranges.push(Decoration.line({ class: `cm-note-codeblock${edge}${fence}` }).range(view.state.doc.line(line).from));
        }
      }
      const parent = node.node.parent;
      if (!parent || editing(parent.from, parent.to)) return;
      if (parent.name === "FencedCode" && node.name === "CodeMark"
        && view.state.doc.lineAt(node.from).number === view.state.doc.lineAt(node.to).number) {
        ranges.push(Decoration.replace({}).range(node.from, node.to));
        return;
      }
      const hidden = node.name === "HeaderMark" || node.name === "EmphasisMark" || node.name === "QuoteMark"
        || (node.name === "CodeMark" && parent.name === "InlineCode")
        || (["LinkMark", "URL", "LinkTitle"].includes(node.name) && parent.name === "Link");
      // View decorations may not replace a line break (e.g. a multiline link title).
      if (hidden && view.state.doc.lineAt(node.from).number === view.state.doc.lineAt(node.to).number) {
        const trailingSpace = ["HeaderMark", "QuoteMark"].includes(node.name)
          && view.state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
        ranges.push(Decoration.replace({}).range(node.from, node.to + trailingSpace));
      } else if (node.name === "ListMark" && parent.parent?.name === "BulletList"
        && /^\s+\[[ xX]\]\s/.test(view.state.sliceDoc(node.to, node.to + 5))) {
        // A to-do item shows only its checkbox.
        ranges.push(Decoration.replace({}).range(node.from, node.to + 1));
      } else if (node.name === "ListMark" && parent.parent?.name === "BulletList") {
        ranges.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to));
      }
    },
  });
  extras(view, ranges, editing, code);
  return Decoration.set(ranges, true);
}

// Decorations change presentation only; Markdown characters stay in the document.
const inlineMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = decorations(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });

export const liveMarkdown = [inlineMarks, noteBlocks];
