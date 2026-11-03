import { useEffect, useState } from "react";

/** The three modules of the course screen; each can be shown or hidden. */
export type PanelName = "list" | "map" | "dock";
export type PanelLayout = Record<PanelName, boolean> & {
  toggle: (name: PanelName) => void;
  /** Reveals a hidden module, e.g. the details dock when a node is picked. */
  show: (name: PanelName) => void;
  /** Whether hiding this module is allowed: the centre always keeps the list or the map. */
  canHide: (name: PanelName) => boolean;
  /** Phone width: the centre shows the list or the map, never both side by side. */
  narrow: boolean;
  /** Which of list and map the phone shows. */
  phonePane: "list" | "map";
  setPhonePane: (pane: "list" | "map") => void;
};

const LAYOUT_KEY = "learning-map:panels";
const PHONE_KEY = "learning-map:phone-pane";
/** Older builds remembered only the list. */
const LEGACY_LIST_KEY = "learning-map:route-list";
const NARROW_QUERY = "(max-width: 780px)";

function storedLayout(): Record<PanelName, boolean> {
  // Four columns at once (sidebar, list, map, dock) squeeze the map; the list starts closed unless the screen is wide.
  const wide = typeof window !== "undefined" && window.innerWidth >= 1600;
  const fallback = { list: wide, map: true, dock: true };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (saved && typeof saved === "object") return { ...fallback, ...saved };
    const legacy = localStorage.getItem(LEGACY_LIST_KEY);
    return legacy ? { ...fallback, list: legacy !== "closed" } : fallback;
  } catch { return fallback; }
}

function storedPhonePane(): "list" | "map" {
  try { return localStorage.getItem(PHONE_KEY) === "map" ? "map" : "list"; } catch { return "list"; }
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** Which modules are shown, remembered across visits. */
export function usePanelLayout(): PanelLayout {
  const [shown, setShown] = useState(storedLayout);
  const [phonePane, setPane] = useState(storedPhonePane);
  const narrow = useNarrow();
  const hideable = (state: Record<PanelName, boolean>, name: PanelName) =>
    name === "dock" || (name === "list" ? state.map : state.list);
  const toggle = (name: PanelName) => setShown((current) => {
    if (current[name] && !hideable(current, name)) return current;
    const next = { ...current, [name]: !current[name] };
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  const show = (name: PanelName) => { if (!shown[name]) toggle(name); };
  const setPhonePane = (pane: "list" | "map") => {
    setPane(pane);
    try { localStorage.setItem(PHONE_KEY, pane); } catch { /* per-viewer convenience only */ }
  };
  const visible = narrow ? { list: phonePane === "list", map: phonePane === "map", dock: shown.dock } : shown;
  return { ...visible, toggle, show, canHide: (name) => hideable(shown, name), narrow, phonePane, setPhonePane };
}
