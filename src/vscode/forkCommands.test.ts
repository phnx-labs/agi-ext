import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  handleForkPickHost,
  registerForkPickHostCommand,
} from './forkCommands.vscode';
import { handleForkPickedSession } from './sessionBrowser.vscode';
import type { SessionBrowserSessionRow } from '../core/sessionBrowser';

/**
 * A palette entry and its `registerCommand` are two halves of one contract, in two
 * files that nothing else keeps in step. Contribute without registering and the
 * command is in the palette but throws "command not found" on pick; register
 * without contributing and it is unreachable. Read both real files and pin them
 * to each other.
 */
const factoryRoot = path.resolve(import.meta.dir, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(factoryRoot, 'src/vscode/extension.ts'), 'utf8');

const contributed = (id: string) =>
  (manifest.contributes.commands as Array<{ command: string; title: string }>).find(c => c.command === id);

describe('fork command contributions', () => {
  test('Agents: Fork (Pick Host) is contributed under its stable command id', () => {
    expect(contributed('agents.forkPickHost')?.title).toBe('Agents: Fork (Pick Host)');
  });

  test('Agents: Fork (Recap) is contributed under its stable command id', () => {
    expect(contributed('agents.forkRecap')?.title).toBe('Agents: Fork (Recap)');
  });

  test('Agents: Fork (Recap) forks the active tab instead of opening the session browser', () => {
    expect(extensionSource).toContain(
      "vscode.commands.registerCommand('agents.forkRecap', () => forkCurrentSession(context))",
    );
    expect(extensionSource).not.toContain("forkPickedSession(context, 'recap')");
  });

  test('registered Agents: Fork (Pick Host) creates a sibling on the picked host', async () => {
    let command = '';
    let callback!: () => Promise<void>;
    let launch: unknown;
    let rejection: unknown;

    registerForkPickHostCommand((id, run) => {
      command = id;
      callback = run;
      return {};
    }, () => handleForkPickHost({
      source: { sessionId: 'source-id', agentKey: 'claude' },
      pickHost: async () => ({ host: 'chosen-host', cancelled: false }),
      openFork: async (value) => { launch = value; },
      showRejection: (value) => { rejection = value; },
      viewColumn: 'Active',
    }));

    await callback();

    expect(command).toBe('agents.forkPickHost');
    expect(launch).toEqual({
      command: "agents fork 'source-id' --device 'chosen-host'",
      host: 'chosen-host',
      viewColumn: 'Active',
    });
    expect(rejection).toBeUndefined();
  });

  test('a remote Grok source brought back local carries the bare fork verb', async () => {
    let launch: unknown;
    await handleForkPickHost({
      source: { sessionId: 'source-id', agentKey: 'grok', host: 'source-host' },
      pickHost: async () => ({ host: undefined, cancelled: false }),
      openFork: async (value) => { launch = value; },
      showRejection: () => {},
      viewColumn: 'Active',
    });
    expect(launch).toEqual({
      command: "agents fork 'source-id'",
      host: undefined,
      viewColumn: 'Active',
    });
  });
});

describe('Agents: Fork (Pick Session)', () => {
  const row = (machine: string, remote: boolean): SessionBrowserSessionRow => ({
    kind: 'session',
    session: { id: 'picked-id', shortId: 'picked', agent: 'codex', timestamp: '', machine, topic: 'Fix the parser' },
    machine,
    remote,
    current: false,
    label: '',
    description: '',
    detail: '',
  });

  test('forks the picked session with the agents fork verb, on the device it lives on', async () => {
    let fork: unknown;
    let status = '';
    await handleForkPickedSession({
      currentSession: () => ({ sessionId: null }),
      pickSession: async () => row('yosemite-s1', true),
      localMachine: 'zion',
      openFork: async (value) => { fork = value; return true; },
      showError: () => { throw new Error('unexpected error'); },
      showStatus: (message) => { status = message; },
    });
    expect(fork).toEqual({
      command: "agents fork 'picked-id' --device 'yosemite-s1'",
      sessionId: 'picked-id',
      agentKey: 'codex',
      host: 'yosemite-s1',
      sourceTitle: 'Fix the parser',
    });
    expect(status).toBe('Forking picked on yosemite-s1');
  });

  test('a session on this machine forks here', async () => {
    let command = '';
    await handleForkPickedSession({
      currentSession: () => ({ sessionId: null }),
      pickSession: async () => row('zion', false),
      localMachine: 'zion',
      openFork: async (value) => { command = value.command; return true; },
      showError: () => {},
      showStatus: () => {},
    });
    expect(command).toBe("agents fork 'picked-id'");
  });
});
