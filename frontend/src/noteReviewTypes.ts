export type NoteSuggestion = {
  id: string;
  category: "knowledge_logic" | "english" | "uncertain";
  original: string;
  replacement: string;
  reason: string;
  from: number;
  to: number;
  line: number;
  sources: { material_id: string; page: number; quote: string; name: string; uncertain: boolean }[];
};

export type NoteReviewResponse = {
  request_id: string;
  note_id?: string;
  revision: number;
  scope_key: string;
  model: string;
  suggestions: NoteSuggestion[];
  warnings: string[];
};

export type NoteEditorActions = {
  replace: (suggestion: NoteSuggestion, snapshot: string) => string | null;
  locate: (suggestion: NoteSuggestion, snapshot: string) => boolean;
  undo: () => boolean;
};

export function suggestionMatches(content: string, snapshot: string, suggestion: NoteSuggestion) {
  return content === snapshot && Number.isInteger(suggestion.from) && Number.isInteger(suggestion.to)
    && suggestion.from >= 0 && suggestion.to > suggestion.from && suggestion.to <= content.length
    && content.slice(suggestion.from, suggestion.to) === suggestion.original;
}
