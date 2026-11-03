import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, isolateHistory, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion } from "@codemirror/autocomplete";
import { liveMarkdown } from "./liveMarkdown";
import { setBlock, slashCommands, toggleInline } from "./noteFormatting";
import { InlineTools, NoteToolbar } from "./NoteToolbar";
import { suggestionMatches } from "./noteReviewTypes";
import type { NoteEditorActions } from "./noteReviewTypes";

const externalChange = Annotation.define<boolean>();
const styles = HighlightStyle.define([
  { tag: tags.strong, class: "cm-note-strong" },
  { tag: tags.emphasis, class: "cm-note-emphasis" },
  { tag: tags.strikethrough, class: "cm-note-strike" },
  { tag: tags.monospace, class: "cm-note-code" },
  { tag: tags.link, class: "cm-note-link" },
  { tag: tags.processingInstruction, class: "cm-note-mark" },
]);

export function LiveMarkdownEditor({ content, onChange, live, onReady, onTab }: {
  content: string; onChange: (content: string) => void; live: boolean;
  onReady?: (actions: NoteEditorActions | null) => void; onTab?: () => boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const initial = useRef(content);
  const change = useRef(onChange);
  const review = useRef({ onReady, onTab });
  const presentation = useRef(new Compartment());
  const [warning, setWarning] = useState("");
  const [view, setView] = useState<EditorView | null>(null);
  const [bubble, setBubble] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => { change.current = onChange; }, [onChange]);
  useLayoutEffect(() => { review.current = { onReady, onTab }; }, [onReady, onTab]);
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: initial.current, extensions: [
        markdown({ base: markdownLanguage }), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
        Prec.highest(keymap.of([{ key: "Tab", run: (view) => !view.composing && (review.current.onTab?.() ?? false) }])),
        keymap.of([
          { key: "Mod-b", run: (view) => { toggleInline(view, "**"); return true; } },
          { key: "Mod-i", run: (view) => { toggleInline(view, "*"); return true; } },
          { key: "Mod-Alt-1", run: (view) => { setBlock(view, "h1"); return true; } },
          { key: "Mod-Alt-2", run: (view) => { setBlock(view, "h2"); return true; } },
          { key: "Mod-Alt-3", run: (view) => { setBlock(view, "h3"); return true; } },
          { key: "Mod-Alt-0", run: (view) => { setBlock(view, "p"); return true; } },
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
    review.current.onReady?.({
      replace: (suggestion, snapshot) => {
        if (!suggestionMatches(view.state.doc.toString(), snapshot, suggestion)) return null;
        view.dispatch({ changes: { from: suggestion.from, to: suggestion.to, insert: suggestion.replacement },
          annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.note-suggestion")] });
        acceptedDepth = undoDepth(view.state);
        acceptedText = view.state.doc.toString();
        return acceptedText;
      },
      locate: (suggestion, snapshot) => {
        if (!suggestionMatches(view.state.doc.toString(), snapshot, suggestion)) return false;
        view.dispatch({ selection: { anchor: suggestion.from, head: suggestion.to }, scrollIntoView: true });
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
  return <div className="node-note-code">
    <NoteToolbar view={view} />
    {warning && <p role="alert" className="text-xs text-destructive">{warning}</p>}
    <div className="relative">
      <div ref={host} />
      {bubble && view && <div className="note-bubble" role="toolbar" aria-label="所选文字格式" style={{ top: Math.max(-36, bubble.top), left: bubble.left }}>
        <InlineTools view={view} compact />
      </div>}
    </div>
  </div>;
}
