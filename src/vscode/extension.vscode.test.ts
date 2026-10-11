import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const extensionSource = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8');

describe('agent session editor-tab routing', () => {
  test('the shared resume helper creates an editor tab and registers its identity', () => {
    const helper = extensionSource.slice(
      extensionSource.indexOf('export async function openAgentSessionTerminal'),
      extensionSource.indexOf('async function resumeCurrentInBestProfile'),
    );

    expect(helper).toContain('location: { viewColumn: vscode.ViewColumn.Active }');
    expect(helper).toContain('await registerAgentTerminal(terminal, context');
    expect(helper).toContain('terminalId = session.terminalId || terminals.nextId');
    expect(helper).toContain('...agentTabShell(resumeCmd, process.env.SHELL)');
    expect(helper).not.toContain('executeCommand(resumeCmd)');
    expect(helper.indexOf('terminal.show();')).toBeLessThan(helper.indexOf("readiness.waitFor(terminal, 'agentReady')"));
  });
});
