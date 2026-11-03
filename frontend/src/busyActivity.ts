import { useEffect, useState, useSyncExternalStore } from "react";

/** What the app is waiting on right now, so any panel can show its own progress without prop drilling. */
type Activity = { key: string; since: number };

let current: Activity = { key: "", since: 0 };
const listeners = new Set<() => void>();

export function setBusyActivity(key: string) {
  current = key ? { key, since: Date.now() } : { key: "", since: 0 };
  listeners.forEach((listener) => listener());
}

export function useBusyActivity() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => current);
}

/** Requests that wait on the model, which can take tens of seconds. */
export const AI_KEYS = new Set(["chat", "lesson", "question", "attempt", "generate", "generate-lines", "recall-summary", "retell", "backfill-relations", "find-links", "goal-candidates", "problem-unit"]);

/** Whole seconds since `since`, ticking once a second while `since` is set. */
export function useElapsedSeconds(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  // `now` may predate a fresh `since` until the first tick; that reads as 0.
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}
