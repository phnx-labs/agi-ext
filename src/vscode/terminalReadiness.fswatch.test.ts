import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('armAgentReady never mounts recursive transcript watchers', () => {
  test('terminalReadiness.ts does not recursively fs.watch session roots', () => {
    const src = readFileSync(join(import.meta.dir, 'terminalReadiness.ts'), 'utf8');
    expect(src).not.toMatch(/fs\.watch\([^)]*recursive:\s*true/);
    expect(src).not.toContain('addSharedWatcher');
    expect(src).not.toContain('armSessionFileFastPath');
    expect(src).not.toContain('sharedWatchers');
  });
});
