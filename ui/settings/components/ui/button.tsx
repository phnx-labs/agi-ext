import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--ds-bg)] disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-[var(--ds-button)] text-[var(--ds-accent-foreground)] hover:brightness-110 active:brightness-90",
        secondary: "bg-[var(--ds-bg-inset)] text-[var(--ds-text)] hover:bg-[var(--ds-border)] active:bg-[var(--ds-bg-hover)]",
        ghost: "hover:bg-[var(--ds-bg-inset)] active:bg-[var(--ds-bg-hover)]",
        link: "text-[var(--ds-button)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-5",
        icon: "h-9 w-9 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
