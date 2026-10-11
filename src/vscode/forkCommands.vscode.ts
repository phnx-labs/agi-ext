import { buildForkSessionRequest, forkCommand, type ForkSessionSource } from '../core/forkSession';

export interface ForkPickHostLaunch<ViewColumn> {
  command: string;
  host?: string;
  viewColumn: ViewColumn;
}

/** Keep the VS Code command id coupled to its executable handler. */
export function registerForkPickHostCommand<Disposable>(
  register: (command: string, callback: () => Promise<void>) => Disposable,
  run: () => Promise<void>,
): Disposable {
  return register('agents.forkPickHost', run);
}

/**
 * The executable `Agents: Fork (Pick Host)` path. The extension supplies VS Code
 * effects; this seam keeps one production implementation testable end-to-end.
 */
export async function handleForkPickHost<ViewColumn>(opts: {
  source: ForkSessionSource & { localHost: string };
  pickHost: (agentKey: string) => Promise<{ host?: string; cancelled: boolean }>;
  openFork: (launch: ForkPickHostLaunch<ViewColumn>) => Promise<void>;
  showRejection: (reason: 'no_session' | 'no_agent') => void;
  viewColumn: ViewColumn;
}): Promise<void> {
  const dryRun = buildForkSessionRequest(opts.source);
  if (!dryRun.ok) {
    opts.showRejection(dryRun.reason);
    return;
  }

  const picked = await opts.pickHost(dryRun.agentKey);
  if (picked.cancelled) return;

  const request = buildForkSessionRequest(opts.source, { host: picked.host });
  if (!request.ok) {
    opts.showRejection(request.reason);
    return;
  }

  await opts.openFork({
    command: forkCommand(request.sessionId, request.host),
    host: request.host,
    viewColumn: opts.viewColumn,
  });
}
