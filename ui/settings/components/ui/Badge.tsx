import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badge = cva('badge', { variants: { variant: {
  suggested: '', used: 'used', linear: 'ui-badge-linear',
} }, defaultVariants: { variant: 'suggested' } })

export function Badge({ variant, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span {...props} className={cn(badge({ variant }), className)} />
}
