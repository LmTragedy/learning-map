import katex from "katex";
import "katex/dist/katex.min.css";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Range, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

/** Click a rendered block to edit its source: the cursor moves into it, so the source shows again. */
function editOnClick(dom: HTMLElement, view: EditorView, offset: number) {
  dom.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest("a")) return;
    event.preventDefault();
    const at = view.posAtDOM(dom);
    view.dispatch({ selection: { anchor: Math.min(at + offset, view.state.doc.length) } });
    view.focus();
  });
}

export function renderMath(tex: string, display: boolean) {
  const host = document.createElement(display ? "div" : "span");
  try { katex.render(tex, host, { displayMode: display, throwOnError: false, strict: "ignore" }); }
  catch { host.textContent = tex; }
  return host;
}

class MathBlock extends WidgetType {
  constructor(readonly tex: string) { super(); }
  eq(other: MathBlock) { return other.tex === this.tex; }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-note-mathblock";
    if (this.tex.trim()) box.appendChild(renderMath(this.tex, true));
    else { box.textContent = "空公式，点击输入 LaTeX"; box.classList.add("is-empty"); }
    box.title = "点击编辑公式";
    editOnClick(box, view, 3);
    return box;
  }
  ignoreEvent() { return false; }
}

/** Cells of one Markdown table row, split on unescaped pipes. */
function cells(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

class TableBlock extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: TableBlock) { return other.source === this.source; }
  toDOM(view: EditorView) {
    const lines = this.source.split("\n");
    const wrap = document.createElement("div");
    wrap.className = "cm-note-table";
    wrap.title = "点击编辑表格";
    const table = document.createElement("table");
    const align = cells(lines[1] || "").map((cell) => cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left");
    const row = (text: string, tag: "th" | "td") => {
      const tr = document.createElement("tr");
      cells(text).forEach((cell, index) => {
        const td = document.createElement(tag);
        td.style.textAlign = align[index] || "left";
        // Inline formulas typeset; everything else shows as plain text.
        cell.split(/(\$[^$\n]+\$)/).forEach((part) => td.appendChild(/^\$[^$]+\$$/.test(part)
          ? renderMath(part.slice(1, -1), false) : document.createTextNode(part.replace(/\*\*|`/g, ""))));
        tr.appendChild(td);
      });
      return tr;
    };
    const head = document.createElement("thead"); head.appendChild(row(lines[0], "th"));
    const body = document.createElement("tbody");
    lines.slice(2).forEach((line) => body.appendChild(row(line, "td")));
    table.append(head, body);
    wrap.appendChild(table);
    editOnClick(wrap, view, 2);
    return wrap;
  }
  ignoreEvent() { return false; }
}

const FENCE = /^\s*\$\$\s*$/;

function build(state: EditorState, focused: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const touched = (from: number, to: number) => focused && state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  const tree = syntaxTree(state);
  const inCode = (pos: number) => {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); node; node = node.parent)
      if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    return false;
  };
  // $$ … $$ blocks on their own lines.
  for (let number = 1; number <= state.doc.lines; number++) {
    const open = state.doc.line(number);
    if (!FENCE.test(open.text) || inCode(open.from)) continue;
    let close = number + 1;
    while (close <= state.doc.lines && !FENCE.test(state.doc.line(close).text)) close++;
    if (close > state.doc.lines) break;
    const end = state.doc.line(close);
    const tex = state.sliceDoc(open.to + 1, Math.max(open.to + 1, end.from - 1));
    if (touched(open.from, end.to)) {
      for (let line = number; line <= close; line++) ranges.push(Decoration.line({ class: "cm-note-mathsrc" }).range(state.doc.line(line).from));
    } else {
      ranges.push(Decoration.replace({ widget: new MathBlock(tex), block: true }).range(open.from, end.to));
    }
    number = close;
  }
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from, to = state.doc.lineAt(node.to).to;
      if (!touched(from, to)) ranges.push(Decoration.replace({ widget: new TableBlock(state.sliceDoc(from, to)), block: true }).range(from, to));
      else for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++)
        ranges.push(Decoration.line({ class: "cm-note-tablesrc" }).range(state.doc.line(line).from));
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const setFocus = StateEffect.define<boolean>();
type Blocks = { focused: boolean; decorations: DecorationSet };

/** Formula blocks and tables render in place; with the cursor inside one (and the editor focused) its Markdown shows. */
const blocks = StateField.define<Blocks>({
  create: (state) => ({ focused: false, decorations: build(state, false) }),
  update: (value: Blocks, transaction: Transaction) => {
    const focus = transaction.effects.find((effect) => effect.is(setFocus));
    const focused = focus ? focus.value : value.focused;
    // Selection moves, edits, focus and background parse progress can all change what renders.
    return focus || transaction.docChanged || transaction.selection || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? { focused, decorations: build(transaction.state, focused) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const noteBlocks = [blocks, EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing))];
