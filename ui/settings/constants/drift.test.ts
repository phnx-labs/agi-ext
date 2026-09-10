import { test, expect } from 'bun:test'
import {
  ALL_SWARM_AGENTS,
  SWARM_AGENT_LABELS,
  AGENT_INSTALL_INFO,
  AGENT_TITLE_TO_KEY,
  AGENT_KEY_TO_TITLE,
} from './index'
import { CLI_AGENT_IDS, CLI_AGENT_META, BUILT_IN_AGENTS } from '@shared/agents'

test('drift: every presented agent has a label', () => {
  for (const agent of BUILT_IN_AGENTS) {
    if (agent.key !== 'shell' && !['claude', 'codex', 'gemini', 'opencode'].includes(agent.key)) {
      // Non-swarm agents might not be in SWARM_AGENT_LABELS, that's OK.
      continue
    }
    if (agent.key === 'shell') {
      // Shell is not a CLI agent, OK.
      continue
    }
    // For swarm agents, label must exist
    if (['claude', 'codex', 'gemini', 'opencode'].includes(agent.key)) {
      const label = SWARM_AGENT_LABELS[agent.key as 'claude' | 'codex' | 'gemini' | 'opencode']
      expect(label).toBeDefined()
      expect(label).toBeTruthy()
    }
  }
})

test('drift: no UI agent is outside CLI_AGENT_IDS', () => {
  const allUiAgents = new Set<string>()

  // Collect all agents from UI tables
  for (const agent of ALL_SWARM_AGENTS) {
    allUiAgents.add(agent)
  }
  for (const key of Object.keys(AGENT_INSTALL_INFO)) {
    allUiAgents.add(key)
  }
  for (const key of Object.keys(AGENT_KEY_TO_TITLE)) {
    allUiAgents.add(key)
  }

  // Verify all are in CLI_AGENT_IDS
  for (const agent of allUiAgents) {
    if (agent === 'shell') {
      // Shell is extension-only, OK
      continue
    }
    expect((CLI_AGENT_IDS as readonly string[]).includes(agent)).toBe(true)
  }
})

test('drift: AGENT_TITLE_TO_KEY has entries for presented agents', () => {
  for (const agent of BUILT_IN_AGENTS) {
    const titleEntry = AGENT_TITLE_TO_KEY[agent.title]
    expect(titleEntry).toBe(agent.key)

    // Also check by name for CLI agents
    if (agent.key !== 'shell') {
      const nameEntry = AGENT_TITLE_TO_KEY[CLI_AGENT_META[agent.key as any].name]
      expect(nameEntry).toBe(agent.key)
    }
  }
})

test('drift: AGENT_KEY_TO_TITLE maps only non-shell agents', () => {
  for (const agent of BUILT_IN_AGENTS) {
    if (agent.key === 'shell') {
      expect(AGENT_KEY_TO_TITLE[agent.key]).toBeUndefined()
      continue
    }
    const title = AGENT_KEY_TO_TITLE[agent.key]
    expect(title).toBe(agent.title)
  }
})

test('drift: SWARM_AGENT_LABELS has exactly 4 entries', () => {
  const keys = Object.keys(SWARM_AGENT_LABELS)
  expect(keys.length).toBe(4)
  expect(keys.sort()).toEqual(['claude', 'codex', 'gemini', 'opencode'].sort())
})

test('drift: ALL_SWARM_AGENTS has exactly 4 entries', () => {
  expect(ALL_SWARM_AGENTS.length).toBe(4)
  expect(ALL_SWARM_AGENTS.sort()).toEqual(['claude', 'codex', 'gemini', 'opencode'].sort())
})
