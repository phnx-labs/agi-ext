import * as React from "react"
import { cn } from "../../lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border-0 bg-[var(--ds-bg-inset)] px-3 py-2 text-sm text-[var(--ds-text)] placeholder:text-[var(--ds-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--ds-bg)] disabled:cursor-not-allowed disabled:opacity-40 transition-all duration-150",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
