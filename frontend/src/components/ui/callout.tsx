import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/**
 * One page-level message (error, success, something to attend to, a suggestion).
 * Every banner on the course screen uses this, so they share one look and one dismiss control.
 */
export type CalloutTone = "danger" | "success" | "attention" | "neutral";

const tones: Record<CalloutTone, string> = {
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  success: "border-st-passed/40 bg-st-passed/10 text-foreground",
  attention: "border-st-new/40 bg-st-new/8 text-foreground",
  neutral: "border-border bg-card text-foreground",
};

export function Callout({ tone = "neutral", compact, icon, title, children, actions, onDismiss, dismissLabel = "关闭", className }: {
  tone?: CalloutTone;
  /** One slim line: for hints that should not push the workspace down. */
  compact?: boolean;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"}
      className={cn("callout flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm", compact && "py-1.5 [&_strong]:font-medium", tones[tone], className)}>
      {icon && <span className="flex shrink-0 [&_svg]:size-4" aria-hidden>{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <strong className={cn("block font-semibold", compact && "truncate")}>{title}</strong>}
        {children && <div className={cn("text-[13px] leading-relaxed", title && "text-muted-foreground")}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      {onDismiss && <Button size="icon-sm" variant="ghost" className="-my-1 -mr-1 shrink-0" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}><X /></Button>}
    </div>
  );
}
