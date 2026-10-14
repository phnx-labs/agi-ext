// This machine's host identity.
// Live session state is owned by `agents feed watch --json` and projected by
// SessionPresentationStore; this module never polls or reconstructs that state.

import * as os from 'os';
import { isLocalHostIdentity, normalizeHost } from '../core/remoteSessions';

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
 * failure (`agents ps preview <id> --device this-mac` resolves to no registered
 * device and the catch swallows it), so the fold happens here, once.
 */
export function remoteDeviceArg(host: string | undefined | null): string | undefined {
  const h = (host ?? '').trim();
  return isLocalHost(h) ? undefined : h;
}

// A session's real `version` + `account` used to be resolved here by spawning
// a by-id session-detail read per tab over `--device <device>`. That side channel
// was DELETED (RUSH-3184, agi-cli#3019): its event-pumped respawn — one Node+SSH
// process per remote tab every ~4–5s — was the 2026-08-25 CPU incident. Identity
// now rides the single watch stream (`version` per RUSH-2205, `account` added to
// the backfill for RUSH-3184) and the status bar reads it from the broadcast row
// via `SessionPresentationStore.liveSession()`. Do not reintroduce a per-tab
// fetch: rule #1 of AGENTS.md.
