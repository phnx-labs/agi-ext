import type { BrowsableSession } from '../core/sessionBrowser';
import { buildForkSessionRequest, forkCommand } from '../core/forkSession';
import { forkHostForSession, type SessionBrowserSessionRow } from '../core/sessionBrowser';

interface SessionBrowserRunResult {
  stdout: string;
  stderr: string;
}

/** Runs the standalone `sessions` CLI with this argv. */
export type SessionBrowserRunner = (
  args: string[],
  options: { maxBuffer: number; timeout: number },
) => Promise<SessionBrowserRunResult>;

/** A listing that is not JSON is the CLI's error; its stderr says why. A remote
 *  host's shell may print warnings on stderr beside a good listing, so stderr
 *  alone is not a failure. */
function parseSessionList(stdout: string, stderr: string): BrowsableSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(stderr.trim() || (err as Error).message);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((session): session is BrowsableSession =>
    !!session && typeof session === 'object' && typeof session.id === 'string');
}

export async function loadBrowsableSessions(
  run: SessionBrowserRunner,
  opts: {
    device?: string;
    localMachine: string;
    limit: number;
    currentSessionId?: string | null;
    currentSessionDevice?: string;
    quote: (value: string) => string;
  },
): Promise<BrowsableSession[]> {
  const timeout = 45_000;
  const listed = await run(['--all', '--json', '--no-interactive', '--limit', String(opts.limit), ...(opts.device ? ['--host', opts.device] : [])], {
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return parseSessionList(listed.stdout, listed.stderr);
}

class LatestSessionBrowserRequest {
  private generation = 0;

  begin(): { current: () => boolean } {
    const requestGeneration = ++this.generation;
    return { current: () => requestGeneration === this.generation };
  }

  invalidate(): void {
    this.generation++;
  }
}

export interface SessionBrowserQuickPick<Item, Button> {
  title: string | undefined;
  busy: boolean;
  items: readonly Item[];
  selectedItems: readonly Item[];
  show(): void;
  hide(): void;
  onDidTriggerButton(listener: (button: Button) => void): unknown;
  onDidAccept(listener: () => void): unknown;
  onDidHide(listener: () => void): unknown;
}

export function registerForkPickSessionCommand<Disposable>(
  register: (command: string, callback: () => Promise<void>) => Disposable,
  run: () => Promise<void>,
): Disposable {
  return register('agents.forkPickSession', run);
}

export async function runSessionBrowserPicker<Item extends { row?: SessionBrowserSessionRow }, Button>(opts: {
  quickPick: SessionBrowserQuickPick<Item, Button>;
  title?: string;
  switchButton: Button;
  reloadButton: Button;
  localMachine: string;
  loadItems: (device?: string) => Promise<Item[]>;
  chooseDevice: (current?: string) => Promise<{ device?: string; cancelled: boolean }>;
  emptyItem: (device?: string) => Item;
  errorItem: (message: string) => Item;
}): Promise<SessionBrowserSessionRow | null> {
  let device: string | undefined;
  let switching = false;
  const requests = new LatestSessionBrowserRequest();

  const load = async (): Promise<void> => {
    const request = requests.begin();
    const loadingDevice = device;
    opts.quickPick.title = `${opts.title ?? 'Agents: Fork (Pick Session)'} · ${loadingDevice ?? opts.localMachine}`;
    opts.quickPick.busy = true;
    opts.quickPick.items = [];
    try {
      const items = await opts.loadItems(loadingDevice);
      if (!request.current()) return;
      opts.quickPick.items = items.length > 0 ? items : [opts.emptyItem(loadingDevice)];
    } catch (error: any) {
      if (!request.current()) return;
      const message = (error?.stderr || error?.message || String(error)).trim().split('\n')[0];
      opts.quickPick.items = [opts.errorItem(message)];
    } finally {
      if (request.current()) opts.quickPick.busy = false;
    }
  };

  return new Promise(resolve => {
    opts.quickPick.onDidTriggerButton(async button => {
      if (button === opts.reloadButton) {
        void load();
        return;
      }
      if (button !== opts.switchButton) return;
      switching = true;
      opts.quickPick.hide();
      const chosen = await opts.chooseDevice(device);
      switching = false;
      opts.quickPick.show();
      if (chosen.cancelled) {
        void load();
        return;
      }
      device = chosen.device;
      void load();
    });
    opts.quickPick.onDidAccept(() => {
      const picked = opts.quickPick.selectedItems[0];
      if (!picked?.row) return;
      resolve(picked.row);
      opts.quickPick.hide();
    });
    opts.quickPick.onDidHide(() => {
      requests.invalidate();
      if (!switching) resolve(null);
    });
    opts.quickPick.show();
    void load();
  });
}

export async function handleForkPickedSession(opts: {
  currentSession: () => { sessionId: string | null; device?: string };
  pickSession: (sessionId: string | null, device?: string) => Promise<SessionBrowserSessionRow | null>;
  localMachine: string;
  /** Opens the fork tab for the `agents fork` command; false when the harness has no tab config. */
  openFork: (fork: { command: string; sessionId: string; agentKey: string; host?: string; sourceTitle: string }) => Promise<boolean>;
  showError: (message: string) => void;
  showStatus: (message: string) => void;
}): Promise<void> {
  const current = opts.currentSession();
  const row = await opts.pickSession(current.sessionId, current.device);
  if (!row) return;

  // The fork runs where the picked transcript lives; `agents fork` resolves the
  // source across the fleet and seeds the sibling with its recap.
  const request = buildForkSessionRequest({
    sessionId: row.session.id,
    agentKey: row.session.agent,
    host: forkHostForSession(row.session, opts.localMachine, row.machine),
  });
  if (!request.ok) {
    opts.showError(request.reason === 'no_session'
      ? `Session ${row.session.shortId} has no id to fork.`
      : `Session ${row.session.shortId} has no agent harness to fork with.`);
    return;
  }

  const opened = await opts.openFork({
    command: forkCommand(request.sessionId, request.host),
    sessionId: request.sessionId,
    agentKey: request.agentKey,
    host: request.host,
    sourceTitle: row.session.topic || row.session.shortId,
  });
  if (!opened) {
    opts.showError(`Cannot fork a ${row.session.agent} session — no built-in agent config for it.`);
    return;
  }
  opts.showStatus(`Forking ${row.session.shortId}${row.remote ? ` on ${row.machine}` : ''}`);
}
