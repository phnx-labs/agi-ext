// Lease mechanics for monitor leader election.
//
// Ownership is the highest generation file in `<lease>.claims/` holding
//
//   { leaderId, pid, expiresAt, released? }
//
// A claim creates generation N+1 with link(), which fails if the name exists,
// so two windows that judge generation N stale cannot both win. The highest
// generation is never deleted, only marked released: removing it would let a
// slow claimant start over at a lower number and overlap the real owner.
//
// The holder renews `expiresAt` on a heartbeat. Any window may claim once the
// holder released, or its lease expired AND its pid is dead (crash takeover).
//
// `monitor-lease.json` itself is the record older installed versions elect
// through (read, overwrite, read back). The holder mirrors itself there so
// those windows stay followers, and a new window yields while that file names
// a live holder of its own (`legacyBlocks`).
//
// This module is intentionally free of any vscode dependency so the election
// logic can run — and be tested — in plain subprocesses (see leader.test.ts).

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isPidAlive } from '../core/liveness';

const LEASE_DIR = path.join(os.homedir(), '.agents', '.tmp');
export const LEASE_FILE = path.join(LEASE_DIR, 'monitor-lease.json');

export interface MonitorLease {
  /** computeWindowId(sessionId, pid) of the current holder. */
  leaderId: string;
  /** OS pid of the holder's extension host — used for liveness on takeover. */
  pid: number;
  /** Epoch ms after which the lease is stale and may be claimed. */
  expiresAt: number;
  /** Set by a graceful handoff: the generation is free to claim at once. */
  released?: boolean;
}

function isLease(v: any): v is MonitorLease {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.leaderId === 'string' &&
    typeof v.pid === 'number' &&
    typeof v.expiresAt === 'number'
  );
}

/** Read the current lease, or undefined if absent / unreadable / malformed. */
export function readLease(file: string = LEASE_FILE): MonitorLease | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isLease(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let tmpSeq = 0;
function stage(lease: MonitorLease, target: string): string {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${++tmpSeq}`);
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2));
  return tmp;
}

/** Atomically write the lease (temp file + rename), creating the dir if needed. */
export function writeLease(lease: MonitorLease, file: string = LEASE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.renameSync(stage(lease, file), file);
}

/** Create `target` with its full contents, or return false if it already exists. */
function createExclusive(lease: MonitorLease, target: string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = stage(lease, target);
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.unlinkSync(tmp);
  }
}

const claimsDir = (file: string) => `${file}.claims`;
const generationFile = (file: string, gen: number) => path.join(claimsDir(file), `${gen}.json`);

/** Generation numbers present on disk, highest first. */
function generations(file: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(claimsDir(file));
  } catch {
    return [];
  }
  return names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter((gen): gen is string => gen !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
}

/**
 * One heartbeat: renew our generation, or claim the next one if the current
 * owner is gone. Returns whether `selfId` owns the monitor afterwards.
 */
export function holdLease(
  selfId: string,
  pid: number,
  ttlMs: number,
  file: string = LEASE_FILE,
  now: number = Date.now(),
): boolean {
  const gens = generations(file);
  const top = gens[0];
  // Unreadable means corrupt (claims are written whole), so it is claimable.
  const current = top === undefined ? undefined : readLease(generationFile(file, top));
  const legacy = readLease(file);
  const legacyBlocks =
    !!legacy &&
    legacy.leaderId !== selfId &&
    legacy.leaderId !== current?.leaderId &&
    !canClaim(legacy, selfId, now);
  const lease: MonitorLease = { leaderId: selfId, pid, expiresAt: now + ttlMs };

  if (current && current.leaderId === selfId && !current.released) {
    // Still ours. While an older version holds the legacy record, stand by
    // without renewing; nobody else can claim a generation whose pid is alive.
    if (legacyBlocks) return false;
    writeLease(lease, generationFile(file, top!));
    writeLease(lease, file);
    return true;
  }
  if (legacyBlocks || (current && !canClaim(current, selfId, now))) return false;

  const next = (top ?? 0) + 1;
  if (!createExclusive(lease, generationFile(file, next))) return false;
  // A claimant that read an older listing can recreate a generation the owner
  // already cleaned up; the higher one on disk wins.
  if (generations(file)[0] !== next) {
    fs.rmSync(generationFile(file, next), { force: true });
    return false;
  }
  writeLease(lease, file);
  for (const gen of gens) fs.rmSync(generationFile(file, gen), { force: true });
  return true;
}

/** Release our generation and legacy record — graceful handoff on shutdown. */
export function releaseLease(selfId: string, file: string = LEASE_FILE): void {
  const top = generations(file)[0];
  const current = top === undefined ? undefined : readLease(generationFile(file, top));
  if (current?.leaderId === selfId && !current.released) {
    writeLease({ ...current, released: true }, generationFile(file, top!));
  }
  const lease = readLease(file);
  if (lease && lease.leaderId !== selfId) return; // someone else owns it now
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Pure decision: may `selfId` write itself as leader right now?
 *
 *   - no lease yet, or released    -> claim (bootstrap / handoff)
 *   - lease is already ours        -> renew
 *   - lease still valid (not past) -> no
 *   - expired but holder pid alive -> no (holder is just slow, not dead)
 *   - expired and holder pid dead  -> claim (takeover)
 *
 * Caller performs the IO; this stays side-effect free for testability.
 */
export function canClaim(
  lease: MonitorLease | undefined,
  selfId: string,
  now: number,
): boolean {
  if (!lease || lease.released) return true;
  if (lease.leaderId === selfId) return true;
  if (now < lease.expiresAt) return false;
  return !isPidAlive(lease.pid);
}
