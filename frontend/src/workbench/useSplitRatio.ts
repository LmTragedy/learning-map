import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

function storedRatio(key: string) {
  try { const value = Number(localStorage.getItem(key)); return value >= 0.2 && value <= 0.8 ? value : 0.5; }
  catch { return 0.5; }
}

/** Left-pane share of a horizontal split, remembered across visits under `key`. */
export function useSplitRatio(key = "learning-map:workbench-ratio") {
  const [ratio, setRatio] = useState(() => storedRatio(key));
  const container = useRef<HTMLDivElement>(null);

  function startDrag(event: ReactPointerEvent) {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(0.8, Math.max(0.2, (moveEvent.clientX - box.left) / box.width));
      setRatio(next);
      try { localStorage.setItem(key, String(next)); } catch { /* the split still works for this page */ }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return { ratio, container, startDrag };
}
