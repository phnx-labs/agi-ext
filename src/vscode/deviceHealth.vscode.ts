import { execFile } from 'child_process';
import { promisify } from 'util';
import { isDeviceOnline } from '../core/deviceHealth';
import { RepoSyncStatus } from '../core/repoSync';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';
import { dialablePeerScopes } from '../core/remoteSessions';
import { sessionPresentationStore } from '../core/sessionPresentationStore';

const execFileAsync = promisify(execFile);

// A registered device, sourced live from `agents devices list --json`.
export interface Device {
  name: string;
  host: string;
  platform?: string;
  online?: boolean;
  registeredAt: number;
}

/**
 * The minimal device shape the fleet sweep actually reads (name + address +
 * reachability). Both `Device` and the persisted `HostPickerDevice` satisfy it,
 * so the host-picker cache can drive a usage sweep without carrying the full
 * registry row.
 */
export type DeviceRef = Pick<Device, 'name' | 'host' | 'online'>;

interface AgentsDeviceEntry {
  name: string;
  platform?: string;
  address?: { via?: string; dnsName?: string; ip?: string };
  tailscale?: { online?: boolean };
  createdAt?: string;
}

// Source the device fleet from the canonical agents-cli registry
// (`agents devices list --json`, self-populated from Tailscale) rather than a
// hand-rolled file. Online status is derived by isDeviceOnline (matching the
// CLI: a missing tailscale block is NOT offline), and the SSH address from
// address.dnsName.
//
// Floor background paths MUST use this registry read only — never
// `agents doctor`, `agents devices status`, `agents fleet status`, or
// `agents projects status` on a recurring/activation path.
let registeredDevicesCache: Device[] | null = null;

export const __deviceHealthTestCounters = {
  registeredDeviceCliCalls: 0,
  reset() {
    this.registeredDeviceCliCalls = 0;
  },
};

export function setRegisteredDevicesCache(devices: readonly Device[] | null): void {
  registeredDevicesCache = devices ? devices.map((device) => ({ ...device })) : null;
}

export function getRegisteredDevicesCache(): Device[] | null {
  return registeredDevicesCache?.map((device) => ({ ...device })) ?? null;
}

/**
 * The machines the merged session stream is still waiting on: every peer the CLI
 * fan-out actually dials (`dialablePeerScopes` mirrors its selection) that has not
 * delivered its reset or been marked unavailable. Until the stream has reset at
 * all, `established` is false. A view shows "loading machines" while either holds,
 * never a confident local-only or empty list (PHNX-2735).
 */
export function streamReadiness(localMachineId: string): { established: boolean; pending: string[] } {
  return {
    established: sessionPresentationStore.hasSeenReset(),
    pending: sessionPresentationStore.pendingScopes(dialablePeerScopes(getRegisteredDevicesCache() ?? [], localMachineId)),
  };
}

/** Strict registry read used by the one activation seed. */
export async function fetchRegisteredDevices(): Promise<Device[]> {
  __deviceHealthTestCounters.registeredDeviceCliCalls++;
  const bin = await resolveAgentsBin();
  // 20s, not 8s: on a loaded box the CLI's per-run startup alone can exceed
  // 8s. The Floor never blocks rendering on this call; it starts with persisted
  // data and refreshes the cache once in the background.
  const { stdout } = await execFileAsync(bin, ['devices', 'list', '--json'], {
    timeout: 20_000,
    env: augmentedEnv(bin),
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('agents devices list --json: expected a JSON array');
  }
  const devices = (parsed as AgentsDeviceEntry[]).map((d) => ({
    name: d.name,
    host: d.address?.dnsName || d.name,
    platform: d.platform,
    online: isDeviceOnline(d.tailscale),
    registeredAt: d.createdAt ? Date.parse(d.createdAt) || 0 : 0,
  }));
  setRegisteredDevicesCache(devices);
  return devices;
}

/** Existing non-Floor callers keep their empty-list error contract. */
export async function listRegisteredDevices(): Promise<Device[]> {
  try {
    return await fetchRegisteredDevices();
  } catch {
    return [];
  }
}

const PROBE_TIMEOUT_MS = 20_000;

function augmentedEnv(binPath: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bootstrapPath(binPath)}:${process.env.PATH ?? ''}` };
}

function isLocalHost(host: string): boolean {
  return host === 'this-mac' || host === 'localhost' || host === '';
}

export async function probeReachable(host: string): Promise<boolean> {
  if (isLocalHost(host)) return true;
  try {
    const device = (await fetchRegisteredDevices()).find((row) => row.name === host || row.host === host);
    return device?.online !== false;
  } catch {
    return false;
  }
}

// Sync status for a repo AS IT EXISTS ON THE DEVICE (not the local mac). A repo
// that isn't cloned there is a first-class state ('missing') — the dispatch
// policy clones it. Runs a single shell snippet locally or over SSH.
export async function getDeviceSyncStatus(
  host: string,
  projectPath: string,
  _opts: { isLocal: boolean },
): Promise<RepoSyncStatus> {
  const empty: RepoSyncStatus = { root: projectPath, state: 'unknown', ahead: 0, behind: 0, dirty: false, defaultBranch: '' };
  if (!projectPath) return empty;
  try {
    const bin = await resolveAgentsBin();
    const { stdout } = await execFileAsync(bin, ['devices', 'status', '--json'], { timeout: PROBE_TIMEOUT_MS, env: augmentedEnv(bin) });
    const parsed = JSON.parse(stdout) as { devices?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : parsed.devices ?? [];
    const row = rows.find((item) => item.name === host || item.host === host);
    const repos = Array.isArray(row?.repos) ? row.repos as Array<Record<string, unknown>> : [];
    const repo = repos.find((item) => item.path === projectPath || item.root === projectPath);
    if (repo) return repo as unknown as RepoSyncStatus;
    return empty;
  } catch {
    return empty;
  }
}
