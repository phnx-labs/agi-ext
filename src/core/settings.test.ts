import { describe, test, expect } from 'bun:test';
import {
  getDefaultSettings,
  hasLoginEnabled,
  migrateStaleClaudeQuickLaunch,
  QuickLaunchConfig,
} from './settings';

describe('getDefaultSettings', () => {
  test('every built-in starts with login off and 2 instances; labels and the Reader are on', () => {
    const settings = getDefaultSettings();
    for (const key of ['claude', 'codex', 'opencode', 'cursor'] as const) {
      expect(settings.builtIn[key]).toEqual({ login: false, instances: 2 });
    }
    expect(settings.custom).toEqual([]);
    expect(settings.display).toEqual({ autoLabelInTabTitles: true, showSessionIdInTitles: false });
    expect(settings.editor.markdownViewerEnabled).toBe(true);
  });
});

describe('hasLoginEnabled', () => {
  test('is true once a built-in or custom agent has login on', () => {
    const settings = getDefaultSettings();
    expect(hasLoginEnabled(settings)).toBe(false);
    settings.custom.push({ name: 'Custom', command: 'custom-cli', login: false, instances: 1 });
    expect(hasLoginEnabled(settings)).toBe(false);
    settings.custom[0]!.login = true;
    expect(hasLoginEnabled(settings)).toBe(true);
    const codex = getDefaultSettings();
    codex.builtIn.codex.login = true;
    expect(hasLoginEnabled(codex)).toBe(true);
  });
});

describe('migrateStaleClaudeQuickLaunch', () => {
  test('rewrites stale Claude model ids to aliases', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'claude', model: 'claude-opus-4-5', label: 'Claude Opus' },
      slot2: { agent: 'claude', model: 'claude-haiku-4-5', label: 'Claude Haiku' },
      slot3: { agent: 'claude', model: 'claude-sonnet-4-5', label: 'Claude Sonnet' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(true);
    expect(cfg.slot1).toEqual({ agent: 'claude', model: undefined, modelAlias: 'opus', label: 'Claude Opus' });
    expect(cfg.slot2).toEqual({ agent: 'claude', model: undefined, modelAlias: 'haiku', label: 'Claude Haiku' });
    expect(cfg.slot3).toEqual({ agent: 'claude', model: undefined, modelAlias: 'sonnet', label: 'Claude Sonnet' });
  });

  test('leaves non-stale ids alone', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'claude', model: 'claude-opus-4-7', label: 'Custom' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
    expect(cfg.slot1?.model).toBe('claude-opus-4-7');
    expect(cfg.slot1?.modelAlias).toBeUndefined();
  });

  test('does not touch non-Claude slots', () => {
    const cfg: QuickLaunchConfig = {
      slot1: { agent: 'codex', model: 'claude-opus-4-5', label: 'Weird' },
    };
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
    expect(cfg.slot1?.model).toBe('claude-opus-4-5');
  });

  test('handles missing slots', () => {
    const cfg: QuickLaunchConfig = {};
    expect(migrateStaleClaudeQuickLaunch(cfg)).toBe(false);
  });
});
