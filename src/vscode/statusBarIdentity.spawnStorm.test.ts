import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural guard for RUSH-3184 / agi-cli#3019: the per-tab identity side channel
// that caused the 2026-08-25 CPU incident must stay deleted. The status bar reads
// identity from the broadcast watch row (SessionPresentationStore), never a per-tab
// by-id session-detail respawn over `--device <host>`. The behavioral contract is
// in src/core/spawnStorm.regression.test.ts.
const extensionSource = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8');

test('applyStreamIdentity resolves identity from the presentation store only', () => {
  const fn = extensionSource.slice(
    extensionSource.indexOf('function applyStreamIdentity'),
    extensionSource.indexOf('const liveSessionInFlight'),
  );
  expect(fn).toContain('sessionPresentationStore.liveSession');
  expect(fn).toContain('resolveStreamIdentityStamp');
  expect(fn).not.toContain('await'); // synchronous: no subprocess, no I/O
  expect(fn).not.toContain('execFile');
});
