import { test, expect } from 'bun:test'
import { ALL_SWARM_AGENTS, SWARM_AGENT_LABELS, AGENT_INSTALL_INFO, AGENT_TITLE_TO_KEY, AGENT_KEY_TO_TITLE } from './index'
import { CLI_AGENT_IDS, CLI_AGENT_META, BUILT_IN_AGENTS, type CliAgentId } from '@shared/agents'

const cliIds = CLI_AGENT_IDS as readonly string[]

test('every id the UI tables mention is a CLI agent id', () => {
  const uiIds = [
    ...ALL_SWARM_AGENTS,
    ...Object.keys(AGENT_INSTALL_INFO),
    ...Object.keys(AGENT_KEY_TO_TITLE),
    ...Object.values(AGENT_TITLE_TO_KEY).filter((k) => k !== 'shell'),
  ]
  for (const id of uiIds) expect(cliIds).toContain(id)
})

test('swarm labels come from the CLI catalog, one per swarm agent', () => {
  expect(Object.keys(SWARM_AGENT_LABELS).sort()).toEqual([...ALL_SWARM_AGENTS].sort())
  for (const id of ALL_SWARM_AGENTS) expect(SWARM_AGENT_LABELS[id]).toBe(CLI_AGENT_META[id].name)
})

test('title maps mirror the presented agents exactly', () => {
  for (const agent of BUILT_IN_AGENTS) {
    expect(AGENT_TITLE_TO_KEY[agent.title]).toBe(agent.key)
    if (agent.key === 'shell') {
      expect(AGENT_KEY_TO_TITLE[agent.key]).toBeUndefined()
    } else {
      expect(AGENT_TITLE_TO_KEY[CLI_AGENT_META[agent.key as CliAgentId].name]).toBe(agent.key)
      expect(AGENT_KEY_TO_TITLE[agent.key]).toBe(agent.title)
    }
  }
  expect(Object.keys(AGENT_KEY_TO_TITLE).length).toBe(BUILT_IN_AGENTS.filter((a) => a.key !== 'shell').length)
})
