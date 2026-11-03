import { StateEffect, StateField, Transaction } from "@codemirror/state";
import type { EditorState, Extension, StateCommand } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type { NoteSuggestion } from "./noteReviewTypes";

/** Replaces every mark, or keeps only the listed ids when `ids` is given. */
export const setReviewMarks = StateEffect.define<{ suggestions: NoteSuggestion[] } | { ids: string[] }>();
export const pickReviewMark = StateEffect.define<string | null>();

type Marks = { set: DecorationSet; picked: string | null };
const wordChar = /[\p{L}\p{N}\p{M}_]/u;

function edgeCharacter(text: string, fromEnd = false) {
  const characters = Array.from(text);
  return fromEnd ? characters.at(-1) ?? "" : characters[0] ?? "";
}

function deletionJoinsWord(doc: EditorState["doc"], change: {
  changedFrom: number; changedTo: number; markFrom: number; markTo: number;
  mappedFrom: number; mappedTo: number;
}) {
  if (change.changedFrom === change.changedTo) return false;
  const joinsLeft = change.changedTo === change.markFrom
    && wordChar.test(edgeCharacter(doc.sliceString(Math.max(0, change.mappedFrom - 2), change.mappedFrom), true))
    && wordChar.test(edgeCharacter(doc.sliceString(change.mappedFrom, change.mappedFrom + 2)));
  const joinsRight = change.changedFrom === change.markTo
    && wordChar.test(edgeCharacter(doc.sliceString(Math.max(0, change.mappedTo - 2), change.mappedTo), true))
    && wordChar.test(edgeCharacter(doc.sliceString(change.mappedTo, change.mappedTo + 2)));
  return joinsLeft || joinsRight;
}

const mark = (suggestion: NoteSuggestion) => Decoration.mark({
  class: `cm-review-mark is-${suggestion.category}`,
  attributes: { "data-review-id": suggestion.id },
  id: suggestion.id, inclusiveStart: false, inclusiveEnd: false,
});

export const reviewMarks = StateField.define<Marks>({
  create: () => ({ set: Decoration.none, picked: null }),
  update(value, transaction) {
    let { set, picked } = value;
    if (transaction.docChanged) {
      // A mark whose text was edited no longer describes what is written; drop it rather than guess.
      const touched = new Set<string>();
      const nextDoc = transaction.newDoc;
      // Typing glued onto either edge (e.g. finishing the word) counts as editing it; a space or new line does not.
      set.between(0, transaction.startState.doc.length, (from, to, decoration) => {
        transaction.changes.iterChanges((changedFrom, changedTo, _fromB, _toB, inserted) => {
          const text = inserted.toString();
          if ((changedFrom < to && changedTo > from)
            || (changedFrom === changedTo && changedFrom > from && changedFrom < to)
            || (changedTo === from && wordChar.test(edgeCharacter(text, true))
              && wordChar.test(edgeCharacter(transaction.startState.sliceDoc(from, to))))
            || (changedFrom === to && wordChar.test(edgeCharacter(text))
              && wordChar.test(edgeCharacter(transaction.startState.sliceDoc(from, to), true)))
            || deletionJoinsWord(nextDoc, {
              changedFrom, changedTo, markFrom: from, markTo: to,
              mappedFrom: transaction.changes.mapPos(from, 1), mappedTo: transaction.changes.mapPos(to, -1),
            })) touched.add(decoration.spec.id);
        });
      });
      set = set.map(transaction.changes);
      if (touched.size) set = set.update({ filter: (_from, _to, decoration) => !touched.has(decoration.spec.id) });
      if (picked && touched.has(picked)) picked = null;
    }
    for (const effect of transaction.effects) {
      if (effect.is(setReviewMarks)) {
        if ("suggestions" in effect.value) {
          const length = transaction.state.doc.length;
          set = Decoration.set(effect.value.suggestions.filter((entry) => Number.isInteger(entry.from)
            && Number.isInteger(entry.to) && entry.from >= 0 && entry.to <= length && entry.from < entry.to)
            .map((entry) => mark(entry).range(entry.from, entry.to)), true);
        } else {
          const keep = new Set(effect.value.ids);
          set = set.update({ filter: (_from, _to, decoration) => keep.has(decoration.spec.id) });
        }
        if (picked && !markRange(set, picked)) picked = null;
      } else if (effect.is(pickReviewMark)) picked = effect.value;
    }
    return { set, picked };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});

function markRange(set: DecorationSet, id: string) {
  let found: { from: number; to: number } | null = null;
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, decoration) => {
    if (decoration.spec.id === id) { found = { from, to }; return false; }
  });
  return found as { from: number; to: number } | null;
}

export const reviewRange = (state: EditorState, id: string) => markRange(state.field(reviewMarks).set, id);

export function acceptReviewSuggestion(target: Parameters<StateCommand>[0], suggestion: NoteSuggestion) {
  const range = reviewRange(target.state, suggestion.id);
  if (!range || target.state.sliceDoc(range.from, range.to) !== suggestion.original) return null;
  const transaction = target.state.update({ changes: { from: range.from, to: range.to, insert: suggestion.replacement },
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.note-suggestion")] });
  // A filtered edit must not claim acceptance or make Undo target earlier user edits.
  if (!transaction.docChanged) return null;
  target.dispatch(transaction);
  return transaction.state.doc.toString();
}

export function reviewIds(state: EditorState) {
  const ids: string[] = [];
  state.field(reviewMarks).set.between(0, state.doc.length, (_from, _to, decoration) => { ids.push(decoration.spec.id); });
  return ids;
}

/** Clicking a squiggle picks it, like a spelling checker; clicking elsewhere closes the card. */
export function reviewMarksExtension(): Extension {
  return [reviewMarks, EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = (event.target as HTMLElement | null)?.closest?.("[data-review-id]");
      const id = target?.getAttribute("data-review-id") || null;
      if (id !== view.state.field(reviewMarks).picked) view.dispatch({ effects: pickReviewMark.of(id) });
      return false;
    },
  })];
}
