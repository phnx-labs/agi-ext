import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectSelect } from './ProjectSelect'

test('most-used ties retain incoming order regardless of selection', () => {
  const html = renderToStaticMarkup(<ProjectSelect
    items={[{ id: 'a', label: 'A', uses: 5 }, { id: 'b', label: 'B', uses: 5 }]}
    value="b"
    cloud={true}
    onChange={() => {}}
  />)
  expect(html).toContain('<span class="nm">A</span><span class="badge used">MOST USED</span>')
  expect(html).not.toContain('<span class="nm">B</span><span class="badge used">MOST USED</span>')
})
