// Drift test: UI harness catalog must stay in sync with CLI_AGENT_IDS.
// For every CLI agent id (except hard-deprecated ones), the UI provides labels,
// install info, and title mappings. If a new agent lands in the CLI, this test
// fails until the UI catalog is updated.

import { describe, expect, test } from 'bun:test';
import {
  SUPPORTED_HARNESS_IDS,
  HARNESS_LABELS,
  HARNESS_INSTALL_INFO,
  HARNESS_TITLE_TO_ID,
  HARNESS_ID_TO_TITLE,
} from './harnessRegistry';
import { CLI_AGENT_IDS } from '../core/agents.cli';

describe('harnessRegistry drift test', () => {
  test('SUPPORTED_HARNESS_IDS excludes hard-deprecated agents', () => {
    // gemini is hard-deprecated and must not appear in supported ids
    expect(SUPPORTED_HARNESS_IDS as readonly string[]).not.toContain('gemini');
    // All CLI ids except gemini should be present
    const expected = (CLI_AGENT_IDS as readonly string[]).filter(id => id !== 'gemini').sort();
    const actual = [...SUPPORTED_HARNESS_IDS].sort();
    expect(actual).toEqual(expected);
  });

  test('every supported harness has a label', () => {
    for (const id of SUPPORTED_HARNESS_IDS) {
      expect(HARNESS_LABELS[id as any], `label for '${id}'`).toBeTruthy();
      expect(typeof HARNESS_LABELS[id as any]).toBe('string');
    }
  });

  test('every supported harness has install info', () => {
    for (const id of SUPPORTED_HARNESS_IDS) {
      expect(HARNESS_INSTALL_INFO[id as any], `install info for '${id}'`).toBeTruthy();
      const info = HARNESS_INSTALL_INFO[id as any];
      expect(info.command || info.url).toBeTruthy(`'${id}' must have command or url`);
    }
  });

  test('HARNESS_LABELS has no entries outside SUPPORTED_HARNESS_IDS', () => {
    for (const id of Object.keys(HARNESS_LABELS)) {
      expect(SUPPORTED_HARNESS_IDS as readonly string[]).toContain(id);
    }
  });

  test('HARNESS_INSTALL_INFO has no entries outside SUPPORTED_HARNESS_IDS', () => {
    for (const id of Object.keys(HARNESS_INSTALL_INFO)) {
      expect(SUPPORTED_HARNESS_IDS as readonly string[]).toContain(id);
    }
  });

  test('HARNESS_ID_TO_TITLE has entries for all supported harnesses', () => {
    for (const id of SUPPORTED_HARNESS_IDS) {
      expect(HARNESS_ID_TO_TITLE[id as any], `title for '${id}'`).toBeTruthy();
    }
  });

  test('HARNESS_TITLE_TO_ID has no stale gemini entries', () => {
    expect((HARNESS_TITLE_TO_ID as Record<string, any>)['GX']).toBeUndefined();
    expect((HARNESS_TITLE_TO_ID as Record<string, any>)['Gemini']).toBeUndefined();
  });
});
