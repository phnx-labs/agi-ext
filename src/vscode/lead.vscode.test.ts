import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', '..', 'package.json'), 'utf8'));

// ⌥Space is the Lead's only while docked; with the overlay open it toggles the mic.
test('⌥Space: ask while docked and closed, talk while the overlay is open, nothing in bubble mode', () => {
  const keys = pkg.contributes.keybindings.filter((k: { key: string }) => k.key === 'alt+space');
  expect(keys).toEqual([
    { command: 'agents.lead.ask', key: 'alt+space', mac: 'alt+space', when: '!agents.lead.bubble && !agents.lead.overlayOpen' },
    { command: 'agents.lead.talk', key: 'alt+space', mac: 'alt+space', when: 'agents.lead.overlayOpen' },
  ]);
});

// Agent sessions are terminal tabs: without this the shell would eat ⌥Space there.
test('the Lead commands skip the integrated terminal shell', () => {
  expect(pkg.contributes.configurationDefaults['terminal.integrated.commandsToSkipShell']).toEqual(expect.arrayContaining(['agents.lead.ask', 'agents.lead.talk']));
});

test('Esc while talking cancels the Lead recording instead of stopping (and sending) it', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'lead.vscode.ts'), 'utf8');
  const hide = src.slice(src.indexOf('qp.onDidHide('), src.indexOf('qp.onDidHide(') + 400);
  expect(hide).toContain("this.mic.cancel('overlay')");
  expect(hide).not.toContain('dictation.stop');
});
