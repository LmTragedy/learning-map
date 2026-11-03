import { cn } from "./lib/utils";
import { useElapsedSeconds } from "./busyActivity";

/** Animated dots plus a "thought for N s" counter while the model works on a request started at `since`. */
export function AiThinking({ label, since, className }: { label: string; since: number; className?: string }) {
  const seconds = useElapsedSeconds(since);
  return <div className={cn("ai-thinking", className)} role="status" aria-live="polite">
    <span className="ai-thinking-dots" aria-hidden><i /><i /><i /></span>
    <span>{label}</span>
    {seconds > 0 && <span className="ai-thinking-time">已思考 {seconds} 秒</span>}
  </div>;
}
