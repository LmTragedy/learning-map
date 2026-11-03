import { useState } from "react";

/** The three modules of the course screen; each can be shown or hidden. */
export type PanelName = "list" | "map" | "dock";
export type PanelLayout = Record<PanelName, boolean> & {
  toggle: (name: PanelName) => void;
  /** Whether hiding this module is allowed: the centre always keeps the list or the map. */
  canHide: (name: PanelName) => boolean;
};

const LAYOUT_KEY = "learning-map:panels";
/** Older builds remembered only the list. */
const LEGACY_LIST_KEY = "learning-map:route-list";

function storedLayout(): Record<PanelName, boolean> {
  const fallback = { list: true, map: true, dock: true };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (saved && typeof saved === "object") return { ...fallback, ...saved };
    return { ...fallback, list: localStorage.getItem(LEGACY_LIST_KEY) !== "closed" };
  } catch { return fallback; }
}

/** Which modules are shown, remembered across visits. */
export function usePanelLayout(): PanelLayout {
  const [shown, setShown] = useState(storedLayout);
  const hideable = (state: Record<PanelName, boolean>, name: PanelName) =>
    name === "dock" || (name === "list" ? state.map : state.list);
  const toggle = (name: PanelName) => setShown((current) => {
    if (current[name] && !hideable(current, name)) return current;
    const next = { ...current, [name]: !current[name] };
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  return { ...shown, toggle, canHide: (name) => hideable(shown, name) };
}
