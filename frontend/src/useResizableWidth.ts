import { useEffect, useReducer, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

type Options = {
  /** localStorage key the width is remembered under. */
  key: string;
  min: number;
  max: number;
  /** The panel takes at most this share of the window, so its neighbours keep their room. */
  maxShare: number;
  /** Which edge of the panel carries the handle: a right dock drags by its left edge, a left list by its right edge. */
  edge: "left" | "right";
};

/**
 * Width of a side panel, set by dragging its edge handle and remembered across visits.
 * Undefined means the panel's CSS default; double-clicking the handle returns to it.
 * The handle must be a direct child of the panel.
 */
export function useResizableWidth({ key, min, max, maxShare, edge }: Options) {
  const limit = () => Math.max(min, Math.min(max, window.innerWidth * maxShare));
  const clamp = (value: number) => Math.round(Math.min(limit(), Math.max(min, value)));
  const store = (value: number | undefined) => {
    try { if (value) localStorage.setItem(key, String(value)); else localStorage.removeItem(key); }
    catch { /* the width still applies for this page */ }
  };
  const [width, setWidth] = useState(() => {
    try { const value = Number(localStorage.getItem(key)); return value >= min ? value : undefined; }
    catch { return undefined; }
  });
  // A width saved on a large screen is re-clamped when the window gets smaller.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    window.addEventListener("resize", rerender);
    return () => window.removeEventListener("resize", rerender);
  }, []);

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    const panel = event.currentTarget.parentElement;
    if (!panel || event.button !== 0) return;
    event.preventDefault();
    const box = panel.getBoundingClientRect();
    document.body.classList.add("is-resizing-panel");
    // Only a real drag saves; a plain click (or the clicks of a double-click) leaves the stored width alone.
    let dragged: number | undefined;
    const move = (moveEvent: PointerEvent) => {
      dragged = clamp(edge === "left" ? box.right - moveEvent.clientX : moveEvent.clientX - box.left);
      setWidth(dragged);
    };
    const up = () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragged !== undefined) store(dragged);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function nudge(event: ReactKeyboardEvent<HTMLElement>) {
    const step = event.shiftKey ? 80 : 20;
    const grow = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft";
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    const current = width ?? event.currentTarget.parentElement?.offsetWidth ?? min;
    const value = clamp(current + (event.key === grow ? step : -step));
    setWidth(value);
    store(value);
  }

  function reset() { setWidth(undefined); store(undefined); }

  const current = width && clamp(width);
  /** Props for the handle element (role="separator"). */
  const handle = {
    role: "separator" as const, "aria-orientation": "vertical" as const, "aria-valuemin": min, "aria-valuenow": current,
    tabIndex: 0, title: "拖动调整宽度，双击恢复默认", onPointerDown: startDrag, onKeyDown: nudge, onDoubleClick: reset,
  };
  return { width: current, handle };
}
