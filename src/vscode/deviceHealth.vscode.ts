import { execFile } from 'child_process';
import { promisify } from 'util';
import { isDeviceOnline } from '../core/deviceHealth';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';
import { dialablePeerScopes } from '../core/remoteSessions';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { streamWait, type StreamWait } from '../core/streamWait';
import { sessionStreamDemand } from '../monitor/sessionDemand';

const execFileAsync = promisify(execFile);

// A registered device, sourced live from `agents devices list --json`.
export interface Device {
  name: string;
  host: string;
  platform?: string;
  online?: boolean;
  registeredAt: number;
}

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
// Background paths MUST use this registry read only — never
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
 * Whether a view of the merged session stream should still wait, and on whom. A
 * machine is missing until it delivers its reset or is marked unavailable, among
 * the peers the CLI fan-out actually dials (`dialablePeerScopes` mirrors its
 * selection). The wait is bounded (src/core/streamWait.ts): past it the view shows
 * what it has and names the silent machines; a late answer still merges in. The
 * Resume Session picker reads this.
 */
export function streamReadiness(localMachineId: string, nowMs: number = Date.now()): StreamWait {
  return streamWait({
    established: sessionPresentationStore.hasSeenReset(),
    pending: sessionPresentationStore.pendingScopes(dialablePeerScopes(getRegisteredDevicesCache() ?? [], localMachineId)),
    sinceMs: sessionStreamDemand.demandSinceMs,
    nowMs,
  });
}

/** Strict registry read used by the one activation seed. */
async function fetchRegisteredDevices(): Promise<Device[]> {
  __deviceHealthTestCounters.registeredDeviceCliCalls++;
  const bin = await resolveAgentsBin();
  // 20s, not 8s: on a loaded box the CLI's per-run startup alone can exceed
  // 8s. Nothing blocks rendering on this call; it starts with persisted
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

/** Callers that want an empty list, not an error, when the registry read fails. */
export async function listRegisteredDevices(): Promise<Device[]> {
  try {
    return await fetchRegisteredDevices();
  } catch {
    return [];
  }
}

function augmentedEnv(binPath: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bootstrapPath(binPath)}:${process.env.PATH ?? ''}` };
}
