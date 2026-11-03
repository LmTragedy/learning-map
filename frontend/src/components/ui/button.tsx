import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// shadcn/ui Button.
// Hierarchy: default = the one main action of an area (at most one per area, placed last/right);
// outline = other real actions; ghost = low-stakes ones (cancel, back, edit, refresh);
// destructive = deletes, always behind a confirmation. Selection is never a variant:
// toggles pass aria-pressed and get the shared pressed look below.
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 cursor-pointer aria-pressed:bg-control-active aria-pressed:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90",
        outline: "border border-input bg-transparent text-foreground hover:border-input-hover hover:bg-control",
        ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 pointer-coarse:h-10",
        // On touch screens every control grows to at least 40px so it can be hit with a finger.
        sm: "h-8 gap-1.5 rounded-md px-3 text-[13px] pointer-coarse:h-10",
        lg: "h-10 rounded-md px-6",
        icon: "size-9 pointer-coarse:size-10",
        "icon-sm": "size-8 pointer-coarse:size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

// forwardRef so Radix triggers (menus, tooltips, popovers) can measure the button on React 18.
export const Button = React.forwardRef<HTMLButtonElement,
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  });
Button.displayName = "Button";
