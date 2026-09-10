import { describe, it, expect } from 'bun:test';
import { BUILT_IN_AGENTS } from './agents';
import {
  buildNewAgentLaunchCommand,
  harnessLaunchRegistrations,
  resolveLaunchTarget,
  launchOptsForTarget,
  launchOptsForHarnessCommand,
  DEFAULT_LAUNCH_TARGET,
} from './launchTarget';

describe('resolveLaunchTarget', () => {
  it('defaults to auto when unset', () => {
    expect(resolveLaunchTarget(undefined)).toBe('auto');
    expect(DEFAULT_LAUNCH_TARGET).toBe('auto');
  });

  it('accepts the three configured values', () => {
    expect(resolveLaunchTarget('auto')).toBe('auto');
    expect(resolveLaunchTarget('local')).toBe('local');
    expect(resolveLaunchTarget('ask')).toBe('ask');
  });

  it('falls back to the default on an unrecognized value instead of failing the launch', () => {
    expect(resolveLaunchTarget('worker')).toBe('auto');
    expect(resolveLaunchTarget(42)).toBe('auto');
    expect(resolveLaunchTarget(null)).toBe('auto');
  });
});

describe('launchOptsForTarget', () => {
  it('auto sets neither flag, so the launch emits --device auto', () => {
    expect(launchOptsForTarget('auto')).toEqual({});
  });

  it('local pins this machine', () => {
    expect(launchOptsForTarget('local')).toEqual({ local: true });
  });

  it('ask prompts for the host', () => {
    expect(launchOptsForTarget('ask')).toEqual({ pickHost: true });
  });
});

describe('launchOptsForHarnessCommand', () => {
  it('default auto-picks the device and the account, with no prompt on either', () => {
    expect(launchOptsForHarnessCommand('default', 'auto')).toEqual({});
  });

  it('preserves explicit local or ask placement and never adds an account prompt', () => {
    expect(launchOptsForHarnessCommand('default', 'local')).toEqual({ local: true });
    expect(launchOptsForHarnessCommand('default', 'ask')).toEqual({ pickHost: true });
  });

  it('Pick Host pins the device and balances the account, while Auto pins neither', () => {
    // Pick Host no longer prompts for an account: it pins the device and lets the
    // CLI balance the account on it (`--strategy balanced`, added by the builder
    // when no accountPicker is set). Pick Account is the orthogonal command.
    expect(launchOptsForHarnessCommand('pick-host')).toEqual({ pickHost: true });
    expect(launchOptsForHarnessCommand('auto')).toEqual({});
  });

  it('Pick Account pins the account and auto-picks the device', () => {
    expect(launchOptsForHarnessCommand('pick-account')).toEqual({ accountPicker: true });
  });

  it('Pick Project asks only for the project — never a host, so placement stays automatic', () => {
    expect(launchOptsForHarnessCommand('pick-project')).toEqual({ pickProject: true });
  });
});

describe('registered harness launch commands', () => {
  const RUNNERS = BUILT_IN_AGENTS.filter(({ key }) => key !== 'shell' && key !== 'gemini');

  it('registers the default, Pick Host, Auto, Pick Project, and Pick Account command ids for every active harness', () => {
    for (const agent of RUNNERS) {
      expect(harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto').map((entry) => ({
        commandId: entry.commandId,
        variant: entry.variant,
      }))).toEqual([
        { commandId: agent.commandId, variant: 'default' },
        { commandId: `${agent.commandId}PickHost`, variant: 'pick-host' },
        { commandId: `${agent.commandId}Auto`, variant: 'auto' },
        { commandId: `${agent.commandId}PickProject`, variant: 'pick-project' },
        { commandId: `${agent.commandId}PickAccount`, variant: 'pick-account' },
      ]);
    }
  });

  it('reads the configured default target when the command is invoked', () => {
    let target: 'auto' | 'local' = 'auto';
    const [registration] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => target);
    expect(registration.launchOptions()).toEqual({ agentKey: 'claude' });
    target = 'local';
    expect(registration.launchOptions()).toEqual({ agentKey: 'claude', local: true });
  });

  it('builds each active harness default as automatic device and balanced account, with no picker', () => {
    for (const agent of RUNNERS) {
      const [registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      const command = buildNewAgentLaunchCommand(registration.launchOptions());
      expect(command).toBe(
        `agents run ${agent.key} --interactive --device auto --strategy balanced --mode auto`,
      );
      // The trailing `@` is what makes agents-cli stop and prompt. RUSH-3057:
      // the everyday launch command must never carry it.
      expect(command).not.toContain(`${agent.key}@`);
    }
  });

  it('builds each Pick Host command as an explicit device with a balanced account, no picker', () => {
    for (const agent of RUNNERS) {
      const [, registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      const command = buildNewAgentLaunchCommand({
        ...registration.launchOptions(),
        host: 'worker-box',
      });
      expect(command).toBe(
        `agents run ${agent.key} --interactive --device 'worker-box' --strategy balanced --mode auto`,
      );
      // Pick Host balances the account on the chosen device; the trailing `@` that
      // would stop for an interactive account choice now belongs to Pick Account.
      expect(command).not.toContain(`${agent.key}@`);
    }
  });

  it('builds each Pick Account command as the account picker on an auto-picked device', () => {
    for (const agent of RUNNERS) {
      const [, , , , registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      // Pins the account (trailing `@` → the CLI's interactive picker) and lets the
      // CLI auto-pick a picker-eligible device (`--device auto`). No --strategy: the
      // picker and an automatic strategy are mutually exclusive by construction.
      expect(registration.launchOptions()).toEqual({ agentKey: agent.key, accountPicker: true });
      const command = buildNewAgentLaunchCommand(registration.launchOptions());
      expect(command).toBe(
        `agents run ${agent.key}@ --interactive --device auto --mode auto`,
      );
      expect(command).not.toContain('--strategy');
    }
  });

  it('builds each Auto command with automatic device and balanced account selection', () => {
    for (const agent of RUNNERS) {
      const [, , registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      expect(buildNewAgentLaunchCommand(registration.launchOptions())).toBe(
        `agents run ${agent.key} --interactive --device auto --strategy balanced --mode auto`,
      );
    }
  });

  it('builds each Pick Project command as automatic device + balanced account + the picked project', () => {
    for (const agent of RUNNERS) {
      const [, , , registration] = harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto');
      // The variant carries pickProject but never a host/local flag, so placement
      // stays automatic (`--device auto`) and the account stays balanced.
      expect(registration.launchOptions()).toEqual({ agentKey: agent.key, pickProject: true });
      // launchAgent supplies the picked slug via context.projectSlug; the CLI then
      // owns the cwd on the auto-picked worker (no --cwd is emitted alongside it).
      const command = buildNewAgentLaunchCommand(registration.launchOptions(), { projectSlug: 'my-app' });
      expect(command).toBe(
        `agents run ${agent.key} --interactive --device auto --project 'my-app' --strategy balanced --mode auto`,
      );
      expect(command).not.toContain(`${agent.key}@`);
      expect(command).not.toContain('--cwd');
    }
  });

  it('preserves a shared monorepo cwd unless Pick Project was explicitly chosen', () => {
    const cwd = '/Users/me/src/github.com/example/monorepo';
    const context = { cwd, projectSlug: 'child-a' };

    // A caller may know which managed project contains this path, but that is
    // attribution only. Default, Auto, and Pick Host must not reinterpret it as
    // consent to replace the exact workspace with the project's defaultPath.
    const ordinaryOptions = [
      { agentKey: 'claude' },
      launchOptsForHarnessCommand('auto'),
      { ...launchOptsForHarnessCommand('pick-host'), agentKey: 'claude', host: 'worker-box' },
    ];
    for (const options of ordinaryOptions) {
      const command = buildNewAgentLaunchCommand(options, context);
      expect(command).toContain(`--cwd '${cwd}'`);
      expect(command).not.toContain('--project');
    }

    const explicit = buildNewAgentLaunchCommand(
      { agentKey: 'claude', ...launchOptsForHarnessCommand('pick-project') },
      context,
    );
    expect(explicit).toContain("--project 'child-a'");
    expect(explicit).not.toContain('--cwd');
  });

  it('preserves an explicitly opened nested project folder as the remote cwd', () => {
    const cwd = '/Users/me/src/github.com/example/monorepo/apps/web';
    const context = { cwd, projectSlug: 'web' };

    const automatic = buildNewAgentLaunchCommand({ agentKey: 'claude' }, context);
    expect(automatic).toContain('--device auto');
    expect(automatic).toContain(`--cwd '${cwd}'`);
    expect(automatic).not.toContain('--project');

    const pickedHost = buildNewAgentLaunchCommand(
      { agentKey: 'claude', pickHost: true, host: 'worker-box' },
      context,
    );
    expect(pickedHost).toContain("--device 'worker-box'");
    expect(pickedHost).toContain(`--cwd '${cwd}'`);
    expect(pickedHost).not.toContain('--project');
  });

  it('local settings and This Machine picks preserve root and nested workspaces', () => {
    for (const cwd of ['/tmp/monorepo', '/tmp/monorepo/apps/web']) {
      for (const agentKey of ['claude', 'codex', 'auto']) {
        for (const options of [
          launchOptsForHarnessCommand('default', 'local'),
          launchOptsForHarnessCommand('pick-host'),
        ]) {
          const command = buildNewAgentLaunchCommand(
            { agentKey, ...options }, { cwd, projectSlug: 'child-a' },
          );
          expect(command).toContain(`--cwd '${cwd}'`);
          expect(command.match(/ --cwd /g)).toHaveLength(1);
          expect(command).not.toContain('--project');
          expect(command).not.toContain('--device');
        }
      }
    }
  });

  it('falls back to the plain Auto command when no project was picked', () => {
    // A cancelled quickpick leaves projectSlug undefined; the launch must still be
    // the Auto-equivalent command, not a broken one with a dangling --project.
    const [, , , registration] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'auto');
    expect(buildNewAgentLaunchCommand(registration.launchOptions())).toBe(
      'agents run claude --interactive --device auto --strategy balanced --mode auto',
    );
  });

  it('keeps configured local and prompted-device defaults on the balanced path', () => {
    const [local] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'local');
    expect(buildNewAgentLaunchCommand(local.launchOptions())).toBe(
      'agents run claude --interactive --strategy balanced --mode auto',
    );

    const [ask] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'ask');
    expect(buildNewAgentLaunchCommand({ ...ask.launchOptions(), host: 'worker-box' })).toBe(
      "agents run claude --interactive --device 'worker-box' --strategy balanced --mode auto",
    );
  });

  // PHNX-2553: a LOCAL New Claude used to emit no --session-id, so the auto-label
  // poller never armed and the tab kept its bare prefix. launchAgent now mints the id
  // up front and threads it through context.sessionId.
  it('emits a caller-minted Claude session id on the local path', () => {
    const [local] = harnessLaunchRegistrations('claude', 'agents.newClaude', () => 'local');
    expect(buildNewAgentLaunchCommand(local.launchOptions(), { sessionId: 'sess-abc' })).toBe(
      'agents run claude --interactive --session-id sess-abc --strategy balanced --mode auto',
    );
  });

  it('does not emit --session-id for a non-Claude harness even when one is supplied', () => {
    // buildAgentLaunchCommand gates --session-id on claude; a Grok id would be a lie
    // the CLI never pinned. The builder must drop it, not forward it.
    const [local] = harnessLaunchRegistrations('grok', 'agents.newGrok', () => 'local');
    expect(buildNewAgentLaunchCommand(local.launchOptions(), { sessionId: 'sess-abc' })).toBe(
      'agents run grok --interactive --strategy balanced --mode auto',
    );
  });
});
