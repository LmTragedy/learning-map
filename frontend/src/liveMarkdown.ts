import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";

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
const TASK = /^(\s*[-*+]\s+)\[([ xX])\]\s/;

/** Colours, highlights and to-do boxes: Markdown has no syntax for them, so notes keep small HTML tags. */
function extras(view: EditorView, ranges: Range<Decoration>[], editing: (from: number, to: number) => boolean) {
  for (const visible of view.visibleRanges) {
    let at = visible.from;
    while (at <= visible.to) {
      const line = view.state.doc.lineAt(at);
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
        // Every line of a multi-line quote keeps the quote bar.
        for (let line = view.state.doc.lineAt(node.from).number; line <= view.state.doc.lineAt(node.to).number; line++) {
          ranges.push(Decoration.line({ class: "cm-note-quote" }).range(view.state.doc.line(line).from));
        }
      }
      const parent = node.node.parent;
      if (!parent || editing(parent.from, parent.to)) return;
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
  extras(view, ranges, editing);
  return Decoration.set(ranges, true);
}

// Decorations change presentation only; Markdown characters stay in the document.
export const liveMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = decorations(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });
