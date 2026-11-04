import { Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";

/** The one caution the app repeats: written by AI from the materials, check the original page. */
export const AI_MARK_NOTE = "AI 根据课程材料写的，可能有误；需要时打开材料原页核对。";

/**
 * One small mark for AI-written content, replacing the many differently worded disclaimers.
 * `detail` adds what is known about the evidence ("有 2 处材料原文"); the full caution sits in the tooltip.
 */
export function AiMark({ detail, className }: { detail?: string; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px align-middle text-[11px] font-normal leading-4 text-muted-foreground", className)}
    title={AI_MARK_NOTE}>
    <Sparkles className="size-3" aria-hidden />AI 写的{detail ? ` · ${detail}` : ""}
    <span className="sr-only">：{AI_MARK_NOTE}</span>
  </span>;
}
