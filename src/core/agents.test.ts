import * as fs from 'fs';
import * as path from 'path';
import { describe, test, expect } from 'bun:test';
import {
  BUILT_IN_AGENTS,
  getBuiltInByKey,
  getBuiltInByPrefix,
  getBuiltInDefByTitle,
  agentKindFromTerminalId,
  isAgentRunner,
  modeFlagForAgent,
  buildAgentLaunchCommand,
  wrapNativeAgentCommand,
} from './agents';
import { harnessLaunchRegistrations } from './launchTarget';
import { CLAUDE_TITLE, CODEX_TITLE, OPENCODE_TITLE, SHELL_TITLE, getIconFilename } from './utils';
import { CLI_AGENT_META, CliAgentId, isCliAgentId } from './agents.cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('BUILT_IN_AGENTS', () => {
  test('every non-shell built-in contributes every registered launch command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'));
    const contributed = new Set(packageJson.contributes.commands.map((entry: { command: string }) => entry.command));
    const extensionSource = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    expect(extensionSource).toContain('harnessLaunchRegistrations(');
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.key === 'shell') continue;
      // Gemini is deprecated and no longer gets launch commands in the palette.
      if (agent.key === 'gemini') continue;
      for (const registration of harnessLaunchRegistrations(agent.key, agent.commandId, () => 'auto')) {
        expect(contributed.has(registration.commandId)).toBe(true);
      }
    }
  });

  test('every non-shell agent is a CLI agent and launches its CLI binary', () => {
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.key === 'shell') continue;
      expect(isCliAgentId(agent.key)).toBe(true);
      expect(agent.command).toBe(CLI_AGENT_META[agent.key as CliAgentId].cliCommand);
    }
  });

  test('antigravity launches the CLI-canonical agy binary, not a phantom "antigravity"', () => {
    const ag = BUILT_IN_AGENTS.find(a => a.key === 'antigravity');
    expect(ag).toBeDefined();
    expect(ag!.command).toBe('agy');
  });

  test('each harness carries its tab chip, id prefix, icon and launch command id', () => {
    const rows = [
      ['claude', CLAUDE_TITLE, 'cl', 'agents.newClaude'],
      ['kimi', 'KM', 'km', 'agents.newKimi'],
      ['droid', 'DR', 'dr', 'agents.newDroid'],
      ['shell', SHELL_TITLE, 'sh', 'agents.newShell'],
    ] as const;
    for (const [key, title, prefix, commandId] of rows) {
      expect(BUILT_IN_AGENTS.find(a => a.key === key)).toMatchObject({ title, prefix, commandId });
    }
    expect(getBuiltInByKey('shell')!.command).toBe('');
    for (const agent of BUILT_IN_AGENTS) expect(agent.icon).toMatch(/\.png$/);
  });
});

describe('built-in lookups', () => {
  test('by key, prefix and title; Gemini and unknown names resolve to nothing', () => {
    expect(getBuiltInByKey('codex')!.title).toBe(CODEX_TITLE);
    expect(getBuiltInByPrefix('oc')!.key).toBe('opencode');
    expect(getBuiltInDefByTitle(OPENCODE_TITLE)!.key).toBe('opencode');
    for (const missing of [getBuiltInByKey('gemini'), getBuiltInByPrefix('gm'), getBuiltInByKey('unknown'), getBuiltInByPrefix('xx'), getBuiltInDefByTitle('Unknown')]) {
      expect(missing).toBeUndefined();
    }
  });
});

describe('agentKindFromTerminalId', () => {
  test('every presented prefix and legacy title resolves to its harness key', () => {
    for (const a of BUILT_IN_AGENTS) {
      expect(agentKindFromTerminalId(`${a.prefix}-1759700000000-1`)).toBe(a.key);
      expect(agentKindFromTerminalId(`${a.title}-1759700000000-1`)).toBe(a.key);
    }
  });

  test('a custom agent prefix is its own kind', () => {
    expect(agentKindFromTerminalId('aider-1759700000000-1')).toBe('aider');
  });
});

describe('modeFlagForAgent', () => {
  // We launch via `agents run <agent>`, which owns `--mode plan|auto|edit` and
  // translates it per CLI. So the flag is agent-agnostic — NOT the raw
  // `--permission-mode`, which agents run would not forward.
  test('maps every mode to agents run --mode', () => {
    expect(modeFlagForAgent('plan')).toBe('--mode plan');
    expect(modeFlagForAgent('auto')).toBe('--mode auto');
    expect(modeFlagForAgent('edit')).toBe('--mode edit');
  });
});

// Base transport contract: every harness is managed by `agents run`; callers
// explicitly choose either automatic balanced rotation or the account picker.
describe('launch contract — every runner uses the managed launch builder', () => {
  // Every built-in that is an agent runner (i.e. not the Shell terminal).
  const RUNNERS = BUILT_IN_AGENTS.map(a => a.key).filter(k => k !== 'shell');

  test('isAgentRunner is true for every runner and false only for shell', () => {
    for (const key of RUNNERS) expect(isAgentRunner(key)).toBe(true);
    expect(isAgentRunner('shell')).toBe(false);
    // Includes the harnesses that used to launch as raw binaries locally.
    expect(isAgentRunner('grok')).toBe(true);
    expect(isAgentRunner('kimi')).toBe(true);
    expect(isAgentRunner('droid')).toBe(true);
  });

  test('every runner supports balanced selection on local, auto, and explicit-host targets', () => {
    for (const key of RUNNERS) {
      // Automatic account selection, local target.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, { local: true },
      )).toBe(`agents run ${key} --interactive --local --strategy balanced --mode auto`);
      // Automatic account selection and automatic device placement.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, {},
      )).toBe(`agents run ${key} --interactive --device auto --strategy balanced --mode auto`);
      // Automatic account selection on an explicit device.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s1' },
      )).toBe(`agents run ${key} --interactive --device 'yosemite-s1' --strategy balanced --mode auto`);
    }
  });

  test('a pinned @version is the one launch that omits --strategy (CLI ignores it against a pin)', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, '1.2.3', 'balanced', undefined, { local: true },
    )).toBe('agents run claude@1.2.3 --interactive --local --mode auto');
  });

  test('account picker keeps automatic placement but omits balanced account selection', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { accountPicker: true },
    )).toBe('agents run claude@ --interactive --device auto --mode auto');
  });

  test('account picker follows an explicitly picked host', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'yosemite-s0', accountPicker: true },
    )).toBe("agents run claude@ --interactive --device 'yosemite-s0' --mode auto");
  });

  test('account picker rejects a version pin or automatic strategy', () => {
    expect(() => buildAgentLaunchCommand(
      'claude', null, undefined, undefined, '2.1.238', undefined, undefined,
      { accountPicker: true },
    )).toThrow('cannot combine an account picker with a pinned version');
    expect(() => buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, 'balanced', undefined,
      { accountPicker: true },
    )).toThrow('cannot combine an account picker with an automatic strategy');
  });

  test('grok (Pick Host) never emits cursor-agent', () => {
    const cmd = buildAgentLaunchCommand(
      'grok', null, undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s1' },
    );
    expect(cmd).toBe("agents run grok --interactive --device 'yosemite-s1' --strategy balanced --mode auto");
    expect(cmd).not.toContain('cursor-agent');
  });
});

describe('buildAgentLaunchCommand', () => {
  // RUSH-2038: interactive AGI EXT launches must default to --mode auto so the
  // agent starts in a writable posture instead of stalling in read-only plan mode.

  test('mode defaults to auto; an explicit mode or a --mode flag wins, emitted once', () => {
    expect(buildAgentLaunchCommand('claude', 'session-abc')).toContain('--session-id session-abc --mode auto');
    const plan = buildAgentLaunchCommand('codex', null, undefined, undefined, undefined, undefined, 'plan');
    expect(plan).toContain('--mode plan');
    expect(plan).not.toContain('--mode auto');
    const flagged = buildAgentLaunchCommand('codex', null, undefined, '--mode plan');
    expect(flagged.match(/--mode/g)?.length).toBe(1);
    expect(flagged).toContain('--mode plan');
  });

  test('Resume in Best Profile: auto takes a new Claude session id and the fleet places it', () => {
    expect(buildAgentLaunchCommand('auto', 'new-id', undefined, undefined, undefined, undefined, undefined, {
      host: 'auto',
      cwd: '/w',
    })).toBe("agents run auto --interactive --device 'auto' --cwd '/w' --session-id new-id --mode auto");
  });

  test('includes --interactive and the agent key in the base command', () => {
    const cmd = buildAgentLaunchCommand('codex', null);
    expect(cmd).toMatch(/^agents run codex --interactive/);
  });

  test('pinned version is appended as agent@version', () => {
    const cmd = buildAgentLaunchCommand('claude', null, undefined, undefined, '2.1.170');
    expect(cmd).toContain('claude@2.1.170');
  });

  test('host flag is shell-quoted and included', () => {
    const cmd = buildAgentLaunchCommand('codex', null, undefined, undefined, undefined, undefined, undefined, { host: 'mac-mini' });
    expect(cmd).toContain("--device 'mac-mini'");
  });

  test('ordinary remote launch sends a local Mac workspace as portable --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src/agents-cli' },
    );
    expect(cmd).toContain("--device 'linux-box'");
    expect(cmd).toContain("--cwd '/Users/muqsit/src/agents-cli'");
    expect(cmd).not.toContain('--remote-cwd');
  });

  test('automatic remote placement also sends the workspace as portable --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { cwd: '/Users/muqsit/src/monorepo' },
    );
    expect(cmd).toContain('--device auto');
    expect(cmd).toContain("--cwd '/Users/muqsit/src/monorepo'");
    expect(cmd).not.toContain('--project');
  });

  test('picked remote session uses exact --remote-cwd and never portable --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', remoteCwd: '/srv/exact repo' },
    );
    expect(cmd).toContain("--remote-cwd '/srv/exact repo'");
    expect(cmd).not.toContain(" --cwd ");
  });

  test('local and pinned launches retain cwd independently of device selection', () => {
    for (const cwd of ['/tmp/monorepo', '/tmp/monorepo/apps/web']) {
      for (const agent of ['claude', 'codex', 'grok', 'custom-runner']) {
        for (const pinnedVersion of [undefined, '1.2.3']) {
          const cmd = buildAgentLaunchCommand(
            agent, null, undefined, undefined, pinnedVersion, 'balanced', undefined,
            { local: true, cwd },
          );
          expect(cmd).toContain(`--cwd '${cwd}'`);
          expect(cmd.match(/ --cwd /g)).toHaveLength(1);
          expect(cmd).not.toContain('--device');
          expect(cmd).not.toContain('--project');
          if (pinnedVersion) expect(cmd).not.toContain('--strategy');
        }
      }
      const pinned = buildAgentLaunchCommand(
        'codex', null, undefined, undefined, '1.2.3', undefined, undefined, { cwd },
      );
      expect(pinned).toContain(`--cwd '${cwd}'`);
      expect(pinned).not.toContain('--device');
    }
  });

  test('rejects an ambiguous remote target with both cwd forms', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src', remoteCwd: '/srv/exact' },
    )).toThrow('cannot combine portable cwd with exact remoteCwd');
  });

  // RUSH-2487: a matched project owns the working directory end-to-end — the
  // CLI's resolveRunCwd (exec.ts) hard-exits on --project + --cwd/--remote-cwd,
  // so buildAgentLaunchCommand must never emit that combination either.
  test('a local launch with a matched project emits --project and no cwd flag', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { local: true, project: 'agents-cli' },
    );
    expect(cmd).toContain("--project 'agents-cli'");
    expect(cmd).not.toContain('--cwd');
    expect(cmd).not.toContain('--device');
  });

  test('a device-auto launch with a matched project emits --device auto and --project together', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { project: 'agents-cli' },
    );
    expect(cmd).toContain('--device auto');
    expect(cmd).toContain("--project 'agents-cli'");
  });

  test('a picked-host launch with a matched project emits --device and --project, never --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'mac-mini', project: 'agents-cli' },
    );
    expect(cmd).toContain("--device 'mac-mini'");
    expect(cmd).toContain("--project 'agents-cli'");
    expect(cmd).not.toContain('--cwd');
    expect(cmd).not.toContain('--remote-cwd');
  });

  test('rejects a project target combined with portable cwd', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src', project: 'agents-cli' },
    )).toThrow('cannot combine project with cwd or remoteCwd');
  });

  test('rejects a project target combined with exact remoteCwd', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', remoteCwd: '/srv/exact', project: 'agents-cli' },
    )).toThrow('cannot combine project with cwd or remoteCwd');
  });

  test('default model is included when provided', () => {
    const cmd = buildAgentLaunchCommand('claude', null, 'claude-haiku-4-5');
    expect(cmd).toContain('--model claude-haiku-4-5');
  });

  // RUSH-2025: Pick Host / Auto Host / New Claude (Auto) launch with BOTH a host
  // and --strategy balanced so the CLI's account rotation routes around a
  // signed-out / throttled version on the chosen device.
  test('balanced strategy + host emit --device and --strategy balanced together', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-1', undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s0' },
    );
    expect(cmd).toContain("--device 'yosemite-s0'");
    expect(cmd).toContain('--strategy balanced');
  });

  test('a hostless version pin explicitly stays local', () => {
    const command = buildAgentLaunchCommand('claude', 'sess-pin', undefined, undefined, '1.2.3', 'balanced', undefined, { cwd: '/w' });
    expect(command).toBe("agents run claude@1.2.3 --interactive --local --cwd '/w' --session-id sess-pin --mode auto");
    expect(command).not.toContain('--device');
  });

  test('explicit local launch suppresses automatic device selection', () => {
    expect(buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, 'balanced', undefined, { local: true },
    )).toBe('agents run codex --interactive --local --strategy balanced --mode auto');
  });

  test('a pinned version on a host launch suppresses --strategy (pin overrides balance)', () => {
    // Pick Version & Host: the exact pin wins, so no --strategy is emitted even
    // if a strategy is passed.
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-2', undefined, undefined, '2.1.170', 'balanced', undefined, { host: 'yosemite-s1' },
    );
    expect(cmd).toContain('claude@2.1.170');
    expect(cmd).toContain("--device 'yosemite-s1'");
    expect(cmd).not.toContain('--strategy');
  });
});

describe('wrapNativeAgentCommand (RUSH-2593)', () => {
  // The wrapped command exits the shell (closing the VS Code tab) on a clean
  // exit, mirroring tmux pane-died behaviour, but leaves the shell running
  // with a readable status line when the launch itself fails — so a bad
  // remote/host launch doesn't close the tab before the error can be read.

  test('agent terminal: command is followed by an exit-code gate, not exec-replaced', () => {
    const cmd = buildAgentLaunchCommand('claude', null);
    const wrapped = wrapNativeAgentCommand(cmd, false);
    expect(wrapped.startsWith('exec ')).toBe(false);
    expect(wrapped).toContain(cmd);
    expect(wrapped).toContain('ec=$?');
    expect(wrapped).toContain('exit 0');
  });

  test('agent terminal with --device: exit-code gate wraps the full --device command', () => {
    const cmd = buildAgentLaunchCommand('claude', null, undefined, undefined, undefined, undefined, undefined, { host: 'yosemite-s0' });
    const wrapped = wrapNativeAgentCommand(cmd, false);
    expect(wrapped.startsWith('exec ')).toBe(false);
    expect(wrapped).toMatch(/^agents run claude --interactive/);
    expect(wrapped).toContain("--device 'yosemite-s0'");
    expect(wrapped).toContain('ec=$?');
  });

  test('shell terminal: command is returned unwrapped', () => {
    const shellCmd = 'zsh';
    expect(wrapNativeAgentCommand(shellCmd, true)).toBe(shellCmd);
    expect(wrapNativeAgentCommand(shellCmd, true)).not.toContain('ec=$?');
  });

  test('empty command returns empty string unchanged', () => {
    expect(wrapNativeAgentCommand('', false)).toBe('');
    expect(wrapNativeAgentCommand('', true)).toBe('');
  });

  // Real-shell contract test (no mocking): run the wrapped command through an
  // actual bash, standing a real exit-0 / exit-nonzero command in for the
  // agent runner, and assert on what bash actually does — not on a guess
  // about shell semantics.
  test('real bash: a clean exit (0) does not print the kept-open message', () => {
    const wrapped = wrapNativeAgentCommand('true', false);
    // execFileSync spawns bash directly with argv — no outer shell to
    // re-interpret the `$?`/`$ec` inside `wrapped` before bash ever sees it.
    const out = execFileSync('bash', ['-c', wrapped], { encoding: 'utf8' });
    expect(out).not.toContain('Agent exited with status');
  });

  test('real bash: a nonzero exit prints a human-readable status line and the shell keeps running past it', () => {
    // A subshell that exits 7, standing in for a failed `agents run …` launch.
    // (A bare `exit 7` would terminate bash -c's own shell instead of just
    // returning a status, which isn't what a failed subprocess launch does.)
    const wrapped = wrapNativeAgentCommand(`bash -c 'exit 7'`, false);
    // The wrapped command never itself invokes an outer `exit` on the failure
    // branch, so appending a marker after it proves the script kept executing
    // instead of the process dying with the agent (RUSH-2593's actual bug).
    const out = execFileSync('bash', ['-c', `${wrapped}; echo MARKER_REACHED`], { encoding: 'utf8' });
    expect(out).toContain('Agent exited with status 7');
    expect(out).toContain('MARKER_REACHED');
  });

  // RUSH-3125 F6: a lost `--device` connection whose reconnect gave up
  // (SSH_CONN_FAILURE=255) or whose remote run ended unexpectedly
  // (REMOTE_EXIT_255_REMAPPED=254) must read as a recoverable reconnect, not a
  // bare "status 255" crash line — and must NOT auto-resume (RUSH-3139).
  for (const code of [255, 254]) {
    test(`real bash: a reconnect-lost exit (${code}) prints the reconnect line, not the crash line, and keeps the shell running`, () => {
      const wrapped = wrapNativeAgentCommand(`bash -c 'exit ${code}'`, false);
      const out = execFileSync('bash', ['-c', `${wrapped}; echo MARKER_REACHED`], { encoding: 'utf8' });
      expect(out).toContain('Lost the connection to the remote agent');
      expect(out).toContain('Reconnect from:  agents ps');
      // Framed as recoverable, never as a raw status code…
      expect(out).not.toContain(`Agent exited with status ${code}`);
      // …never silently resumed (that is RUSH-3139's copy-of-the-session bug)…
      expect(out).not.toContain('--resume');
      // …and the shell survives past the message.
      expect(out).toContain('MARKER_REACHED');
    });
  }

  test('real bash: a failed launch leaves its own status as the line\'s status, for shell integration', () => {
    const wrapped = wrapNativeAgentCommand(`bash -c 'exit 3'`, false);
    const out = execFileSync('bash', ['-c', `${wrapped}; echo "STATUS=$?"`], { encoding: 'utf8' });
    expect(out).toContain('STATUS=3');
  });

  test('real bash: a plain launch failure (1) still gets the generic line, not the reconnect line — there is no session to rejoin', () => {
    const wrapped = wrapNativeAgentCommand(`bash -c 'exit 1'`, false);
    const out = execFileSync('bash', ['-c', `${wrapped}; echo MARKER_REACHED`], { encoding: 'utf8' });
    expect(out).toContain('Agent exited with status 1');
    expect(out).not.toContain('Lost the connection to the remote agent');
    expect(out).toContain('MARKER_REACHED');
  });
});

describe('agent tab icons', () => {
  test('every built-in agent resolves an icon that actually ships in assets/', () => {
    const assetsDir = path.join(import.meta.dir, '..', '..', 'assets');
    for (const def of BUILT_IN_AGENTS) {
      const file = getIconFilename(def.title);
      expect(file, `${def.key}: no icon mapped for title '${def.title}'`).toBeTruthy();
      expect(file).toBe(def.icon);
      expect(
        fs.existsSync(path.join(assetsDir, file!)),
        `${def.key}: '${file}' is mapped but missing from assets/`,
      ).toBe(true);
    }
  });

  test('launchAgent resolves an iconPath at createTerminal time', () => {
    // Reproduces the regression from e2bf3f502 (#2534): launchAgent replaced its
    // openSingleAgent delegation with a bare createTerminal that passed no
    // iconPath, so every `New <Agent>` tab showed the generic terminal glyph.
    // iconPath is frozen at createTerminal() time — there is no setter, and shell
    // adoption only rewrites the internal registry — so if it is not set here it
    // can never be recovered.
    const src = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    const start = src.indexOf('async function launchAgent');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    // Every agent tab is created by the one opener, which takes the icon from the
    // config it registers (openTrackedTab.test.ts checks the created tab).
    const opener = src.slice(src.indexOf('async function openTrackedTab'), src.indexOf('async function launchAgent'));
    expect(opener).toMatch(/iconPath:\s*spec\.agentConfig\.iconPath/);
    expect(opener).not.toMatch(/buildIconPath\(/);
    expect(body).not.toContain('createTerminal(');
    // Registration must not be conditional on knowing the agent: an automatic
    // launch (agents.newAgent) has no agentKey and must still be registered.
    expect(body).toMatch(/await openTrackedTab\(context, \{\n\s*agentConfig,/);
  });

  test('the icon table is keyed by TITLE, never by the lowercase prefix', () => {
    // Regression guard. buildIconPath()'s parameter is named `prefix`, but the
    // lookup table is keyed by TITLE ('CC', 'GK') while def.prefix is the
    // lowercase id ('cl', 'gk'). Passing a prefix silently yields null, and a
    // terminal created with a null iconPath keeps the generic glyph forever —
    // iconPath is frozen at createTerminal() time and has no setter.
    for (const def of BUILT_IN_AGENTS) {
      expect(getIconFilename(def.title), `${def.key}: title should resolve`).toBeTruthy();
      expect(getIconFilename(def.prefix), `${def.key}: prefix must NOT resolve`).toBeNull();
    }
  });
});
