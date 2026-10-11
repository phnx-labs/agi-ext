import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const extensionSource = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8');
const settingsSource = readFileSync(join(import.meta.dir, 'settings.vscode.ts'), 'utf8');
const unifiedPaneSource = readFileSync(join(import.meta.dir, '../../ui/settings/components/mission-control/UnifiedAgentsPane.tsx'), 'utf8');

describe('agent session editor-tab routing', () => {
  test('the shared resume helper creates an editor tab and registers its identity', () => {
    const helper = extensionSource.slice(
      extensionSource.indexOf('export async function openAgentSessionTerminal'),
      extensionSource.indexOf('export async function openAgentSessionByRecovery'),
    );

    expect(helper).toContain('location: { viewColumn: vscode.ViewColumn.Active }');
    expect(helper).toContain('await registerAgentTerminal(terminal, context');
    expect(helper).toContain('terminalId = session.terminalId || terminals.nextId');
    expect(helper).toContain('...agentTabShell(resumeCmd, process.env.SHELL)');
    expect(helper).not.toContain('executeCommand(resumeCmd)');
    expect(helper.indexOf('terminal.show();')).toBeLessThan(helper.indexOf("readiness.waitFor(terminal, 'agentReady')"));
  });

  test('CLI-owned recovery preserves an unpresented harness across editor reload', () => {
    const helper = extensionSource.slice(
      extensionSource.indexOf('export async function openAgentSessionTerminal'),
      extensionSource.indexOf('export async function openAgentSessionByRecovery'),
    );
    const restore = extensionSource.slice(
      extensionSource.indexOf('async function restoreAgentTerminals'),
      extensionSource.indexOf('async function reopenLastClosedSession'),
    );

    expect(helper).toContain('if (!agentKey && !resumeCommandOverride)');
    expect(helper).toContain("createAgentConfig(context.extensionPath, recoveryTitle, 'agents', 'agents.png', RECOVERY_AGENT_PREFIX)");
    expect(helper).toContain('recoveryAgent: agentKey ? undefined : session.agent');
    expect(helper).not.toContain("'agents.png', 'ag'");
    expect(helper.indexOf("'agents.png'")).toBeLessThan(helper.indexOf('vscode.window.createTerminal'));
    expect(restore).toContain('session.prefix.toLowerCase() === RECOVERY_AGENT_PREFIX');
    expect(restore).toContain('terminals.setRecoveryAgent(terminal, session.recoveryAgent)');
    expect(restore).toContain('inTabResumeCommand(session.sessionId)');
  });

  test('Fleet Resume and Open run the one resume action; migrate is its own verb', () => {
    const resume = settingsSource.slice(
      settingsSource.indexOf("case 'resumeSession':"),
      settingsSource.indexOf("case 'revealWorktree':"),
    );
    const migrate = settingsSource.slice(
      settingsSource.indexOf("case 'migrateSession':"),
      settingsSource.indexOf("case 'stopSession':"),
    );
    expect(resume).toContain('await resumeAndNotify({');
    expect(resume).not.toContain('createTerminal');
    expect(migrate).toContain('await openAgentSessionByMigration(context');
    // The superseded focus/recovery messages are gone, not kept beside it.
    for (const old of ["case 'focusSession':", "case 'focusRemoteSession':", "case 'resumePreviousSession':"]) {
      expect(settingsSource).not.toContain(old);
    }
    expect(extensionSource).not.toContain('export async function openAgentSessionById');
  });

  test('Previous rows stay on the canonical stream with no history side channel', () => {
    expect(unifiedPaneSource).not.toContain('fetchPreviousSessions');
    expect(settingsSource).not.toContain("case 'fetchPreviousSessions':");
  });

  test('recovery never creates a local terminal in the transcript origin cwd', () => {
    const recovery = extensionSource.slice(
      extensionSource.indexOf('export async function openAgentSessionByRecovery'),
      extensionSource.indexOf('export async function openAgentSessionByMigration'),
    );
    expect(recovery).not.toContain('cwd: opts.cwd');
    expect(recovery).toContain('inTabResumeCommand(opts.sessionId)');
  });
});

describe('new-agent workspace routing', () => {
  test('ordinary launch paths never infer a project from the workspace cwd', () => {
    const launchAgent = extensionSource.slice(
      extensionSource.indexOf('async function launchAgent'),
      extensionSource.indexOf('async function sendCommandWhenReady'),
    );
    const openSingleAgent = extensionSource.slice(
      extensionSource.indexOf('async function openSingleAgent'),
      extensionSource.indexOf('async function spawnCommandTerminal'),
    );

    expect(extensionSource).not.toContain('resolveProjectForCwd');
    expect(launchAgent).toContain('const projectSlug = pickedProjectSlug;');
    expect(openSingleAgent).not.toContain('cwd: targetHost ? cwd : undefined');
    expect(openSingleAgent).toMatch(/local: !targetHost,[\s\S]*?\n\s+cwd,/);
    expect(openSingleAgent).toMatch(/createTerminal\(\{[\s\S]*?\n\s+cwd,/);
    expect(openSingleAgent).not.toMatch(/project:\s*projectSlug/);
  });

  test('queued launches pass cwd for local and auto placement while preserving exact remote paths', () => {
    const start = extensionSource.indexOf('export async function openSingleAgentWithQueue');
    const queued = extensionSource.slice(start, extensionSource.indexOf('\n}', start));
    expect(queued).not.toContain('cwd: targetHost &&');
    expect(queued.match(/cwd: opts\?\.remoteCwd \? undefined : cwd/g)).toHaveLength(2);
    expect(queued.match(/remoteCwd: opts\?\.remoteCwd/g)).toHaveLength(2);
    expect(queued).toMatch(/createTerminal\(\{[\s\S]*?\n\s+cwd,/);
  });
});
