import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-primary text-white shadow-sm hover:bg-primary/90",
        destructive: "bg-[#a9453e] text-white shadow-sm hover:bg-[#8e3933]",
        secondary: "border border-border bg-background text-foreground shadow-sm hover:bg-muted/35",
        ghost: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        outline: "border border-border bg-transparent text-foreground hover:bg-muted/30",
        subtle: "bg-muted text-foreground hover:bg-muted/80",
      },
      size: { default: "h-9 px-3.5", sm: "h-8 rounded-md px-2.5 text-xs", lg: "h-10 px-4", icon: "size-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
Button.displayName = "Button";
