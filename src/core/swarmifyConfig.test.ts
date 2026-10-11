import { describe, expect, test } from 'bun:test';
import {
  AgentsConfig,
  getDefaultConfig,
  parseAgentsConfig,
  parseAgentsConfigOverrides,
  mergeAgentsConfig,
  serializeAgentsConfig,
  isValidAgentId,
} from './swarmifyConfig';

describe('swarmifyConfig', () => {
  test('the default config links AGENTS.md to CLAUDE.md for claude and codex', () => {
    expect(getDefaultConfig()).toEqual({
      context: [{ source: 'AGENTS.md', aliases: ['CLAUDE.md'] }],
      agents: ['claude', 'codex'],
      tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
    });
  });

  describe('isValidAgentId', () => {
    test('accepts every agent the CLI supports, not a hardcoded five (issue #741)', () => {
      for (const id of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'grok', 'droid', 'antigravity', 'openclaw']) {
        expect(isValidAgentId(id)).toBe(true);
      }
    });

    test('returns false for invalid agent ids', () => {
      expect(isValidAgentId('gpt')).toBe(false);
      expect(isValidAgentId('Claude')).toBe(false); // case sensitive
    });
  });

  describe('parseAgentsConfig', () => {
    test('returns defaults for an empty or whitespace-only file', () => {
      expect(parseAgentsConfig('')).toEqual(getDefaultConfig());
      expect(parseAgentsConfig('   \n\t  ')).toEqual(getDefaultConfig());
    });

    test('parses every context mapping, trimming sources, aliases and task names', () => {
      const yaml = `
context:
  - source: "  AGENTS.md  "
    aliases:
      - "  CLAUDE.md  "
  - source: TASKS.md
    aliases:
      - TASKS_CLAUDE.md
      - TASKS_GEMINI.md
agents:
  - claude
  - codex
tasks:
  ralph: "  TASKS.md  "
  todo: TODOS.md
`;
      expect(parseAgentsConfig(yaml)).toEqual({
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md', 'TASKS_GEMINI.md'] },
        ],
        agents: ['claude', 'codex'],
        tasks: { ralph: 'TASKS.md', todo: 'TODOS.md' },
      });
    });

    test('drops invalid agent ids, and an empty agents list falls back to the default', () => {
      expect(parseAgentsConfig('agents:\n  - claude\n  - invalid\n  - codex\n').agents).toEqual(['claude', 'codex']);
      expect(parseAgentsConfig('agents: []\n').agents).toEqual(['claude', 'codex']);
    });

    test('an empty task file name falls back to the default', () => {
      const config = parseAgentsConfig('tasks:\n  ralph: ""\n  todo: "   "\n');
      expect(config.tasks).toEqual({ ralph: 'RALPH.md', todo: 'TODO.md' });
    });
  });

  describe('parseAgentsConfigOverrides', () => {
    test('returns null for empty string', () => {
      const overrides = parseAgentsConfigOverrides('');
      expect(overrides).toBeNull();
    });

    test('returns overrides for valid fields only', () => {
      const yaml = `
context:
  - source: AGENTS.md
    aliases:
      - CLAUDE.md
agents:
  - claude
  - invalid
tasks:
  ralph: TASKS.md
  todo: "   "
`;
      const overrides = parseAgentsConfigOverrides(yaml);
      expect(overrides?.context).toEqual([
        { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
      ]);
      expect(overrides?.agents).toEqual(['claude']);
      expect(overrides?.tasks).toEqual({ ralph: 'TASKS.md' });
    });
  });

  describe('mergeAgentsConfig', () => {
    test('unions context mappings with workspace overrides', () => {
      const base: AgentsConfig = {
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
        ],
        agents: ['claude'],
        tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
      };

      const overrides = {
        context: [
          { source: 'AGENTS.md', aliases: ['GEMINI.md'] },
        ],
        agents: ['codex'],
        tasks: { todo: 'TODOS.md' },
      };

      const merged = mergeAgentsConfig(base, overrides, { contextMerge: 'union' });

      expect(merged.context).toEqual([
        { source: 'AGENTS.md', aliases: ['GEMINI.md'] },
        { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
      ]);
      expect(merged.agents).toEqual(['codex']);
      expect(merged.tasks).toEqual({ ralph: 'RALPH.md', todo: 'TODOS.md' });
    });
  });

  test('serializeAgentsConfig round-trips through parseAgentsConfig', () => {
    const config: AgentsConfig = {
      context: [{ source: 'CLAUDE.md', aliases: ['AGENTS.md'] }],
      agents: ['claude'],
      tasks: { ralph: 'TASKS.md', todo: 'TODOS.md' },
    };
    expect(parseAgentsConfig(serializeAgentsConfig(config))).toEqual(config);
    expect(parseAgentsConfig(serializeAgentsConfig(getDefaultConfig()))).toEqual(getDefaultConfig());
  });
});
