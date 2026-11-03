import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// shadcn/ui Badge, plus learning-state tones
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        new: "border-st-new/30 bg-st-new/10 text-st-new",
        studied: "border-st-studied/30 bg-st-studied/10 text-st-studied",
        mastered: "border-st-mastered/30 bg-st-mastered/10 text-st-mastered",
        passed: "border-st-passed/30 bg-st-passed/10 text-st-passed",
        locked: "border-border text-muted-foreground",
        warning: "border-st-new/30 bg-st-new/10 text-st-new",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
