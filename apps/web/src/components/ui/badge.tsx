import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium leading-4",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-foreground",
        blue: "border-primary/20 bg-primary/10 text-primary",
        green: "border-primary/20 bg-primary/10 text-primary",
        amber: "border-accent/40 bg-accent/20 text-foreground",
        violet: "border-primary/20 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
