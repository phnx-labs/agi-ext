import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { DetailPane } = require('./UnifiedAgentsPane')

type UnifiedAgent = React.ComponentProps<typeof DetailPane>['item']
type TerminalInfo = NonNullable<UnifiedAgent['terminal']>

afterEach(() => {
  document.body.innerHTML = ''
})

function minimalItem(overrides: Partial<UnifiedAgent> = {}): UnifiedAgent {
  return {
    kind: 'headless',
    id: 'agent-1',
    agentType: 'claude',
    displayName: 'test-agent',
    activity: 'idle',
    active: false,
    duration: '',
    timestamp: new Date().toISOString(),
    status: 'idle',
    files: [],
    toolCalls: 0,
    ...overrides,
  }
}

function renderDetailPane(props: Partial<React.ComponentProps<typeof DetailPane>> = {}) {
  const rootElement = document.createElement('div')
  document.body.appendChild(rootElement)
  const root = createRoot(rootElement)

  const defaultProps: React.ComponentProps<typeof DetailPane> = {
    item: minimalItem(),
    onClose: () => {},
    onFocusTerminal: () => {},
    onRetry: () => {},
    onKill: () => {},
  }

  act(() => {
    root.render(React.createElement(DetailPane, { ...defaultProps, ...props }))
  })

  return {
    root,
    rootElement,
    cleanup() {
      act(() => {
        root.unmount()
      })
      rootElement.remove()
    },
  }
}

describe('DetailPane states (PHNX-2976)', () => {
  test('renders loading skeleton when loading=true and no body content', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      loading: true,
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeTruthy()
      expect(rootElement.querySelector('[data-testid="detail-empty"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-error"]')).toBeNull()
      expect(rootElement.querySelector('.sw-detail-skeleton')).toBeTruthy()
    } finally {
      cleanup()
    }
  })

  test('renders explicit empty state when not loading and body content is absent', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      loading: false,
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-empty"]')).toBeTruthy()
      expect(rootElement.textContent).toContain('No details yet')
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-error"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('renders error state when error is provided and body content is absent', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      error: 'Host sync failed',
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-error"]')).toBeTruthy()
      expect(rootElement.textContent).toContain('Host sync failed')
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-empty"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('renders degraded state when degraded=true and body content is absent', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      degraded: true,
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-degraded"]')).toBeTruthy()
      expect(rootElement.textContent).toContain('Data is stale')
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-empty"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('precedence: error beats loading and empty', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      loading: true,
      error: 'Upstream failed',
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-error"]')).toBeTruthy()
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('precedence: degraded beats loading and empty', () => {
    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'headless', agent: undefined }),
      loading: true,
      degraded: true,
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-degraded"]')).toBeTruthy()
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('renders normal content when body content exists, even while loading', () => {
    const terminal: TerminalInfo = {
      id: 'term-1',
      agentType: 'claude',
      label: 'migration-agent',
      autoLabel: null,
      createdAt: Date.now() - 60_000,
      index: 0,
      sessionId: 'session-1',
      firstUserMessage: 'Choose the migration strategy',
      status: 'running',
      lastActivityTimestamp: new Date().toISOString(),
      currentActivity: 'Waiting for a migration decision',
      waitingForInput: true,
      recentToolCalls: [],
    }

    const { rootElement, cleanup } = renderDetailPane({
      item: minimalItem({ kind: 'terminal', terminal }),
      loading: true,
    })

    try {
      expect(rootElement.querySelector('[data-testid="detail-loading"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-empty"]')).toBeNull()
      expect(rootElement.querySelector('[data-testid="detail-error"]')).toBeNull()
      expect(rootElement.textContent).toContain('Choose the migration strategy')
    } finally {
      cleanup()
    }
  })
})
