import React, { createContext, useContext, useEffect, useId, useRef } from 'react'
import { cn } from '../../lib/utils'

function useClickAway<T extends HTMLElement>(ref: React.RefObject<T | null>, onAway: () => void, active: boolean, ignore?: React.RefObject<HTMLElement | null>) {
  const callback = useRef(onAway)
  callback.current = onAway
  useEffect(() => {
    if (!active) return
    const handler = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !ignore?.current?.contains(event.target as Node)) callback.current()
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [ref, active, ignore])
}

const Context = createContext<{
  open: boolean; setOpen: (open: boolean) => void; id: string
  trigger: React.RefObject<HTMLButtonElement | null>
} | null>(null)

export function Dropdown({ open, onOpenChange, children, ...props }: React.HTMLAttributes<HTMLDivElement> & {
  open: boolean; onOpenChange: (open: boolean) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  return <Context.Provider value={{ open, setOpen: onOpenChange, id, trigger }}>
    <div {...props}>{children}</div>
  </Context.Provider>
}

export function DropdownTrigger({ onClick, onKeyDown, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const context = useContext(Context)!
  return <button {...props} ref={context.trigger} type="button" aria-haspopup="menu" aria-expanded={context.open} aria-controls={context.id}
    onClick={e => { onClick?.(e); if (!e.defaultPrevented) context.setOpen(!context.open) }}
    onKeyDown={e => {
      onKeyDown?.(e)
      if (!e.defaultPrevented && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        context.setOpen(true)
      }
    }} />
}

// Also supports positioned portal menus whose trigger belongs to a session row.
export function DropdownMenu({ open: suppliedOpen, onClose: suppliedClose, onKeyDown, children, ...props }:
  React.HTMLAttributes<HTMLDivElement> & { open?: boolean; onClose?: () => void }) {
  const context = useContext(Context)
  const open = suppliedOpen ?? context?.open ?? true
  const close = suppliedClose ?? (() => context?.setOpen(false))
  const callback = useRef(close)
  callback.current = close
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, close, open, context?.trigger)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const menu = ref.current!
    const first = menu.querySelector<HTMLElement>('input:not(:disabled)')
      ?? menu.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled):not([aria-disabled="true"])')
      ?? menu.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])')
    ;(first ?? menu).focus()
    return () => {
      if (menu.contains(document.activeElement) || document.activeElement === document.body) previous?.focus()
    }
  }, [open])
  return <div {...props} ref={ref} id={context?.id ?? props.id} hidden={!open} role={props.role ?? 'menu'} tabIndex={-1}
    onKeyDown={e => {
      onKeyDown?.(e)
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); callback.current(); return
      }
      const items = Array.from(ref.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])'))
      const index = items.indexOf(document.activeElement as HTMLElement)
      let next: number
      if (e.key === 'ArrowDown') next = (index + 1) % items.length
      else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = items.length - 1
      else if (e.key === 'Enter' && index >= 0) { e.preventDefault(); items[index]?.click(); return }
      else return
      e.preventDefault(); items[next]?.focus()
    }}>{children}</div>
}

export function DropdownSection(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="presentation" />
}

export function DropdownItem({ selected, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return <button type="button" role={selected === undefined ? 'menuitem' : 'menuitemradio'}
    aria-checked={selected} {...props} className={cn('ui-menu-item', className)} />
}
