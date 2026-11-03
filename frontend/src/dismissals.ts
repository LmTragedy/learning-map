import { useState } from "react";

/**
 * Remembers which hints this viewer has closed, so a closed hint stays closed after a reload.
 * Each hint is stored with a level (e.g. how many items it was about); it comes back only when
 * the current level rises above the one that was dismissed.
 */
export function useDismissals(key: string) {
  const [levels, setLevels] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
  });
  const hidden = (id: string, level = 1) => (levels[id] ?? -Infinity) >= level;
  const dismiss = (id: string, level = 1) => setLevels((current) => {
    const next = { ...current, [id]: level };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  return { hidden, dismiss };
}
