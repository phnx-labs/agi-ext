// This machine's host identity, and the one remaining per-session label read.
// Live session state is owned by `agents sessions watch --json` and projected by
// SessionPresentationStore; this module never polls or reconstructs that state.

import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  isLocalHostIdentity,
  normalizeHost,
  parseSessionLabelSource,
  SessionLabelSource,
} from '../core/remoteSessions';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';

const execFileAsync = promisify(execFile);

/** This machine's name — its local sessions are queried directly (no SSH). */
const LOCAL_HOST = os.hostname();
/** Canonical label the webview uses for this machine. The real os.hostname() is
 *  kept only for SSH/isLocal detection; every host string that crosses to the UI
 *  is normalized to this so the 'this-mac' checks there actually match. */
export const LOCAL_LABEL = 'this-mac';
/** This machine's normalized device id (machineId() form), used to recognize the
 *  CLI's own `machine` tag on local rows and fold them back to LOCAL_LABEL. */
export const LOCAL_MACHINE_ID = normalizeHost(LOCAL_HOST);

/** True when `host` names THIS machine, in any of the identities a projected row
 *  can carry ('this-mac', the machine id, the hostname, 'localhost', empty). */
function isLocalHost(host: string | undefined | null): boolean {
  return isLocalHostIdentity(host, LOCAL_HOST, LOCAL_MACHINE_ID, LOCAL_LABEL);
}

/**
 * The `--device` value for a host — or `undefined` when the host is this
 * machine. THE one converter from "the host string on a projected row" to "the
 * device argument a CLI verb may receive", so no caller has to re-derive which
 * strings are local. Passing a local identity through as a device is a silent
 * failure (`agents sessions <id> --device this-mac` resolves to no registered
 * device and the catch swallows it), so the fold happens here, once.
 */
export function remoteDeviceArg(host: string | undefined | null): string | undefined {
  const h = (host ?? '').trim();
  return isLocalHost(h) ? undefined : h;
}

const DETAIL_TIMEOUT_MS = 15000;

/**
 * Label inputs for ONE session that lives on another machine.
 *
 * A tab spawned with `agents run --device` has its transcript on the host, so the
 * local by-session-id lookups the label poller normally uses (the Claude
 * sessions/*.json scan, the jsonl preview read) find nothing and the tab keeps
 * the bare agent prefix forever. `agents sessions <id> --device <name> --json`
 * resolves both fields on the machine that owns the session. `--host` was
 * removed in RUSH-2494; passing it makes commander reject the whole lookup.
 *
 * `host` is optional: omit it and the CLI fans the id out across the fleet
 * (the default). A `--device auto` tab that never recorded which box the CLI
 * picked still gets a title this way.
 *
 * Returns null when the host is unreachable or the session is not indexed there
 * yet — a fresh session has no first message for a second or two, and the poller
 * simply retries on its next tick.
 */
export async function fetchRemoteSessionLabelSource(
  sessionId: string,
  host?: string,
): Promise<SessionLabelSource | null> {
  const agentsBin = await resolveAgentsBin();
  const args = ['sessions', sessionId, '--json'];
  if (host) args.push('--device', host);
  try {
    const { stdout } = await execFileAsync(
      agentsBin,
      args,
      { timeout: DETAIL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${bootstrapPath(agentsBin)}:${process.env.PATH ?? ''}` } },
    );
    return parseSessionLabelSource(stdout, sessionId);
  } catch {
    return null;
  }
}

// A session's real `version` + `account` used to be resolved here by spawning
// `agents sessions <id> [--device <device>] --json` per tab. That side channel
// was DELETED (RUSH-3184, agi-cli#3019): its event-pumped respawn — one Node+SSH
// process per remote tab every ~4–5s — was the 2026-08-25 CPU incident. Identity
// now rides the single watch stream (`version` per RUSH-2205, `account` added to
// the backfill for RUSH-3184) and the status bar reads it from the broadcast row
// via `SessionPresentationStore.liveSession()`. Do not reintroduce a per-tab
// fetch: rule #1 of AGENTS.md.
