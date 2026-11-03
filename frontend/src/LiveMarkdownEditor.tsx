import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion } from "@codemirror/autocomplete";
import { liveMarkdown } from "./liveMarkdown";
import { indentInCode, insertCodeBlock, setBlock, slashCommands, toggleInline } from "./noteFormatting";
import { InlineTools, NoteToolbar } from "./NoteToolbar";
import type { NoteEditorActions } from "./noteReviewTypes";
import { acceptReviewSuggestion, pickReviewMark, reviewIds, reviewMarks, reviewMarksExtension, reviewRange, setReviewMarks } from "./reviewMarks";

const externalChange = Annotation.define<boolean>();
const styles = HighlightStyle.define([
  { tag: tags.strong, class: "cm-note-strong" },
  { tag: tags.emphasis, class: "cm-note-emphasis" },
  { tag: tags.strikethrough, class: "cm-note-strike" },
  { tag: tags.monospace, class: "cm-note-code" },
  { tag: tags.link, class: "cm-note-link" },
  { tag: tags.processingInstruction, class: "cm-note-mark" },
]);

export type ReviewHooks = {
  /** Card shown under a clicked squiggle. */
  render: (id: string, close: () => void) => ReactNode;
  onPick: (id: string | null) => void;
  /** Marks dropped because their text was edited. */
  onStale: (ids: string[]) => void;
};

export function LiveMarkdownEditor({ content, onChange, live, onReady, onTab, reviewHooks }: {
  content: string; onChange: (content: string) => void; live: boolean;
  onReady?: (actions: NoteEditorActions | null) => void; onTab?: () => boolean;
  reviewHooks?: ReviewHooks;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const initial = useRef(content);
  const change = useRef(onChange);
  const review = useRef({ onReady, onTab, reviewHooks });
  const presentation = useRef(new Compartment());
  const [warning, setWarning] = useState("");
  const [view, setView] = useState<EditorView | null>(null);
  const [bubble, setBubble] = useState<{ top: number; left: number } | null>(null);
  const [card, setCard] = useState<{ id: string; top: number; left: number } | null>(null);
  useLayoutEffect(() => { change.current = onChange; }, [onChange]);
  useLayoutEffect(() => { review.current = { onReady, onTab, reviewHooks }; }, [onReady, onTab, reviewHooks]);
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: initial.current, extensions: [
        markdown({ base: markdownLanguage }), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
        Prec.highest(keymap.of([
          { key: "Tab", run: (view) => !view.composing && ((review.current.onTab?.() ?? false) || indentInCode(view)) },
          { key: "Escape", run: (view) => {
            if (!view.state.field(reviewMarks).picked) return false;
            view.dispatch({ effects: pickReviewMark.of(null) }); return true;
          } },
        ])),
        reviewMarksExtension(),
        keymap.of([
          { key: "Mod-b", run: (view) => { toggleInline(view, "**"); return true; } },
          { key: "Mod-i", run: (view) => { toggleInline(view, "*"); return true; } },
          { key: "Mod-Alt-1", run: (view) => { setBlock(view, "h1"); return true; } },
          { key: "Mod-Alt-2", run: (view) => { setBlock(view, "h2"); return true; } },
          { key: "Mod-Alt-3", run: (view) => { setBlock(view, "h3"); return true; } },
          { key: "Mod-Alt-0", run: (view) => { setBlock(view, "p"); return true; } },
          { key: "Mod-Alt-c", run: (view) => { insertCodeBlock(view); return true; } },
        ]),
        autocompletion({ override: [slashCommands], icons: false, activateOnTyping: true }),
        syntaxHighlighting(styles), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ role: "textbox", "aria-label": "节点笔记正文", "aria-multiline": "true" }),
        placeholder("从这里记录你对整个知识点的理解…"),
        presentation.current.of([]),
        EditorState.transactionFilter.of((transaction) => {
          // Keep recoverable legacy text visible and allow shortening an oversized note.
          if (!transaction.docChanged || transaction.annotation(externalChange)
            || transaction.newDoc.length <= 100000
            || transaction.newDoc.length <= transaction.startState.doc.length) return transaction;
          queueMicrotask(() => setWarning("笔记最多 100,000 个字符，本次超长输入未应用。请先将超出部分保存在其他位置。"));
          return [];
        }),
        EditorView.updateListener.of((update) => {
          const before = update.startState.field(reviewMarks), after = update.state.field(reviewMarks);
          if (before.set !== after.set) {
            const kept = new Set(reviewIds(update.state));
            const stale = reviewIds(update.startState).filter((id) => !kept.has(id));
            if (stale.length) review.current.reviewHooks?.onStale(stale);
          }
          if (before.picked !== after.picked) review.current.reviewHooks?.onPick(after.picked);
          if (before.picked !== after.picked || (after.picked && update.geometryChanged)) {
            const range = after.picked ? reviewRange(update.state, after.picked) : null;
            const box = host.current?.getBoundingClientRect();
            const start = range && update.view.coordsAtPos(range.from);
            setCard(after.picked && start && box ? { id: after.picked, top: start.bottom - box.top + 6,
              left: Math.max(0, Math.min(start.left - box.left, box.width - Math.min(360, box.width))) } : null);
          }
          if (update.selectionSet || update.focusChanged || update.docChanged) {
            const range = update.state.selection.main;
            const box = host.current?.getBoundingClientRect();
            const start = !range.empty && update.view.hasFocus ? update.view.coordsAtPos(range.from) : null;
            setBubble(start && box ? { top: start.top - box.top - 40, left: Math.max(0, start.left - box.left) } : null);
          }
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) {
            setWarning("");
            change.current(update.state.doc.toString());
          }
        }),
      ] }),
    });
    editor.current = view;
    setView(view);
    let acceptedDepth = -1;
    let acceptedText: string | null = null;
    // Only text still reading the original under its mark may be replaced or selected.
    const marked = (suggestion: { id: string; original: string }) => {
      const range = reviewRange(view.state, suggestion.id);
      return range && view.state.sliceDoc(range.from, range.to) === suggestion.original ? range : null;
    };
    review.current.onReady?.({
      sync: (suggestions, snapshot) => view.dispatch({ effects: setReviewMarks.of(view.state.doc.toString() === snapshot
        ? { suggestions } : { ids: suggestions.map((entry) => entry.id) }) }),
      replace: (suggestion) => {
        const changed = acceptReviewSuggestion(view, suggestion);
        if (changed === null) return null;
        acceptedDepth = undoDepth(view.state);
        acceptedText = changed;
        return acceptedText;
      },
      locate: (suggestion) => {
        const range = marked(suggestion);
        if (!range) return false;
        view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true, effects: pickReviewMark.of(suggestion.id) });
        view.focus(); return true;
      },
      undo: () => acceptedText === view.state.doc.toString() && acceptedDepth === undoDepth(view.state) && undo(view),
    });
    return () => { review.current.onReady?.(null); view.destroy(); editor.current = null; setView(null); };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== content) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
  }, [content]);
  useEffect(() => {
    editor.current?.dispatch({ effects: presentation.current.reconfigure(live ? liveMarkdown : []) });
  }, [live]);
  const cardOpen = !!card;
  useEffect(() => {
    if (!cardOpen) return;
    // Clicks inside the editor are handled by the marks themselves.
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (editor.current && !editor.current.dom.contains(target) && !(target instanceof Element && target.closest(".note-review-card")))
        editor.current.dispatch({ effects: pickReviewMark.of(null) });
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [cardOpen]);
  return <div className="node-note-code">
    <NoteToolbar view={view} />
    {warning && <p role="alert" className="text-xs text-destructive">{warning}</p>}
    <div className="relative">
      <div ref={host} />
      {card && view && reviewHooks && <div className="note-review-card" style={{ top: card.top, left: card.left }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); view.dispatch({ effects: pickReviewMark.of(null) }); view.focus(); } }}>
        {reviewHooks.render(card.id, () => { view.dispatch({ effects: pickReviewMark.of(null) }); view.focus(); })}
      </div>}
      {bubble && view && <div className="note-bubble" role="toolbar" aria-label="所选文字格式" style={{ top: Math.max(-36, bubble.top), left: bubble.left }}>
        <InlineTools view={view} compact />
      </div>}
    </div>
  </div>;
}
