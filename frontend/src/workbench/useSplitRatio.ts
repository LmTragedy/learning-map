import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const RATIO_KEY = "learning-map:workbench-ratio";

function storedRatio() {
  try { const value = Number(localStorage.getItem(RATIO_KEY)); return value >= 0.2 && value <= 0.8 ? value : 0.5; }
  catch { return 0.5; }
}

/** Left-pane share of a horizontal split, remembered across visits. */
export function useSplitRatio() {
  const [ratio, setRatio] = useState(storedRatio);
  const container = useRef<HTMLDivElement>(null);

  function startDrag(event: ReactPointerEvent) {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(0.8, Math.max(0.2, (moveEvent.clientX - box.left) / box.width));
      setRatio(next);
      try { localStorage.setItem(RATIO_KEY, String(next)); } catch { /* the split still works for this page */ }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return { ratio, container, startDrag };
}
