import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Badge } from './Badge'

test('badge preserves usage pills and supports accessible Linear labels', () => {
  expect(renderToStaticMarkup(<Badge>SUGGESTED</Badge>)).toBe('<span class="badge">SUGGESTED</span>')
  expect(renderToStaticMarkup(<Badge variant="used">MOST USED</Badge>)).toBe('<span class="badge used">MOST USED</span>')
  const html = renderToStaticMarkup(<Badge variant="linear" title="Linear · AGI">AGI</Badge>)
  expect(html).toContain('ui-badge-linear')
  expect(html).toContain('title="Linear · AGI"')
})
