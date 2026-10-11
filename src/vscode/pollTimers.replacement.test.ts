import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the Agent Panel's 4s poll removed under the one-scheduler
// rule (PHNX-2833): the agents-cli daemon is the only scheduler, and the panel
// redraws on stream facts. This pins that no timer comes back.
const agentPanel = readFileSync(join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');

test('agentPanel.vscode keeps no poll timer', () => {
  expect(agentPanel).not.toMatch(/setInterval\s*\(/);
  expect(agentPanel).not.toMatch(/this\.pollTimer/);
  expect(agentPanel).not.toMatch(/private (start|stop)Polling\s*\(/);
});
