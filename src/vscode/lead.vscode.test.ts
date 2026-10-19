import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'package.json'), 'utf8'));

// ⌥Space is the Lead's only while docked: it opens the Lead tab and starts or stops talking.
test('⌥Space talks to the Lead while docked, and does nothing in bubble mode', () => {
  const keys = pkg.contributes.keybindings.filter((k: { key: string }) => k.key === 'alt+space');
  expect(keys).toEqual([{ command: 'agents.lead.talk', key: 'alt+space', mac: 'alt+space', when: '!agents.lead.bubble' }]);
});

// Agent sessions are terminal tabs: without this the shell would eat ⌥Space there.
test('the Lead commands skip the integrated terminal shell', () => {
  expect(pkg.contributes.configurationDefaults['terminal.integrated.commandsToSkipShell']).toEqual(expect.arrayContaining(['agents.lead.talk']));
});

