import React, { useEffect, useRef } from 'react'

const stack: HTMLElement[] = []
const focusable = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export function Modal({ onClose, children, onMouseDown, ...props }: React.HTMLAttributes<HTMLDivElement> & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const callback = useRef(onClose)
  callback.current = onClose
  useEffect(() => {
    const modal = ref.current!
    const previous = document.activeElement as HTMLElement | null
    const childIndex = stack.findIndex(entry => modal.contains(entry))
    if (childIndex < 0) stack.push(modal)
    else stack.splice(childIndex, 0, modal)
    const items = () => Array.from(modal.querySelectorAll<HTMLElement>(focusable)).filter(el => {
      if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
      for (let node: HTMLElement | null = el; node && node !== modal; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return false
      }
      return true
    })
    if (stack.at(-1) === modal) (items()[0] ?? modal).focus()
    const key = (event: KeyboardEvent) => {
      if (stack.at(-1) !== modal || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); callback.current()
      } else if (event.key === 'Tab') {
        const list = items()
        const first = list[0] ?? modal
        const last = list.at(-1) ?? modal
        if (!list.length || (event.shiftKey ? document.activeElement === first : document.activeElement === last) || !modal.contains(document.activeElement)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus()
        }
      }
    }
    const focus = (event: FocusEvent) => {
      if (stack.at(-1) === modal && !modal.contains(event.target as Node)) (items()[0] ?? modal).focus()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('focusin', focus)
    return () => {
      stack.splice(stack.indexOf(modal), 1)
      document.removeEventListener('keydown', key)
      document.removeEventListener('focusin', focus)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1}
    onMouseDown={e => { onMouseDown?.(e); if (e.target === e.currentTarget) onClose() }}>{children}</div>
}
