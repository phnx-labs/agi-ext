import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { summarizeAgentInventory } from './agentInventory';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'view-claude.json'), 'utf-8'));

describe('summarizeAgentInventory', () => {
  test('counts signed-in installs and the healthy ones among them from agents view json', () => {
    const summary = summarizeAgentInventory(fixture);
    expect(summary.agent).toBe('claude');
    expect(summary.signedInCount).toBeGreaterThan(1);
    expect(summary.healthyCount).toBeLessThanOrEqual(summary.signedInCount);
  });

  test('an out-of-credits install is signed in but not healthy', () => {
    const summary = summarizeAgentInventory({
      agent: 'claude',
      versions: [
        { signedIn: true, usageStatus: 'out_of_credits' },
        { signedIn: true, usageStatus: 'available' },
        { signedIn: false, usageStatus: 'available' },
      ],
    });
    expect(summary).toEqual({ agent: 'claude', signedInCount: 2, healthyCount: 1 });
  });
});
