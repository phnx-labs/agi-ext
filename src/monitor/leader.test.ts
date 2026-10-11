/**
 * Leader election: the pure takeover decision and the lease file it reads.
 * The multi-window handoff runs in leader.bootstrap and leader.handoff.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canClaim, holdLease, readLease, writeLease, releaseLease, type MonitorLease } from './lease';
import { isPidAlive } from '../core/liveness';

const DEAD_PID = 2_147_483_000; // implausibly high pid -> ESRCH on kill(pid,0)

describe('canClaim — the pure takeover decision', () => {
  test('no lease yet -> bootstrap claim', () => {
    expect(canClaim(undefined, 'win-1', 1000)).toBe(true);
  });

  test('lease already ours -> renew', () => {
    const lease: MonitorLease = { leaderId: 'win-1', pid: process.pid, expiresAt: 5000 };
    expect(canClaim(lease, 'win-1', 1000)).toBe(true);
  });

  test('valid lease held by someone else -> no claim', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: process.pid, expiresAt: 5000 };
    expect(canClaim(lease, 'win-1', 1000)).toBe(false);
  });

  test('expired but holder pid alive -> no claim (slow, not dead)', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: process.pid, expiresAt: 1000 };
    expect(isPidAlive(process.pid)).toBe(true);
    expect(canClaim(lease, 'win-1', 2000)).toBe(false);
  });

  test('expired and holder pid dead -> takeover claim', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: DEAD_PID, expiresAt: 1000 };
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(canClaim(lease, 'win-1', 2000)).toBe(true);
  });
});

describe('lease file IO — atomic round-trip', () => {
  test('write then read returns the same lease; release removes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lease-io-'));
    const file = path.join(dir, 'monitor-lease.json');
    try {
      const lease: MonitorLease = { leaderId: 'win-7', pid: 1234, expiresAt: 9999 };
      writeLease(lease, file);
      expect(readLease(file)).toEqual(lease);

      // A different holder must not be able to release our lease.
      releaseLease('win-other', file);
      expect(readLease(file)).toEqual(lease);

      // The real holder can.
      releaseLease('win-7', file);
      expect(readLease(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed lease file reads as undefined (no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lease-bad-'));
    const file = path.join(dir, 'monitor-lease.json');
    try {
      fs.writeFileSync(file, '{ not json');
      expect(readLease(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('holdLease — generation claims', () => {
  const withLease = (run: (file: string, claims: () => string[]) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lease-gen-'));
    const file = path.join(dir, 'monitor-lease.json');
    const claims = () => (fs.existsSync(`${file}.claims`) ? fs.readdirSync(`${file}.claims`).sort() : []);
    try { run(file, claims); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  test('a crashed holder is taken over at the next generation and its claim removed', () => withLease((file, claims) => {
    writeLease({ leaderId: 'crashed', pid: DEAD_PID, expiresAt: 1000 }, path.join(`${file}.claims`, '1.json'));
    expect(holdLease('b', process.pid, 1000, file, 2000)).toBe(true);
    expect(claims()).toEqual(['2.json']);
    expect(readLease(file)?.leaderId).toBe('b');
    // A live, unexpired owner cannot be displaced, even past the legacy record.
    expect(holdLease('c', process.pid, 1000, file, 2500)).toBe(false);
    expect(holdLease('b', process.pid, 1000, file, 2500)).toBe(true);
    expect(claims()).toEqual(['2.json']);
  }));

  test('a released generation stays on disk and is claimable at once', () => withLease((file, claims) => {
    expect(holdLease('a', process.pid, 60_000, file, 1000)).toBe(true);
    releaseLease('a', file);
    expect(claims()).toEqual(['1.json']);
    expect(readLease(path.join(`${file}.claims`, '1.json'))?.released).toBe(true);
    expect(readLease(file)).toBeUndefined();
    expect(holdLease('b', process.pid, 60_000, file, 1001)).toBe(true);
    expect(claims()).toEqual(['2.json']);
  }));

  test('a live older-version holder of the legacy record keeps new windows followers', () => withLease((file, claims) => {
    writeLease({ leaderId: 'old', pid: process.pid, expiresAt: 60_000 }, file);
    expect(holdLease('new', process.pid, 1000, file, 1000)).toBe(false);
    expect(claims()).toEqual([]);
    // Once that holder is gone for good the record no longer blocks.
    writeLease({ leaderId: 'old', pid: DEAD_PID, expiresAt: 500 }, file);
    expect(holdLease('new', process.pid, 1000, file, 1000)).toBe(true);
    // An owner that sees an older version take the record stands by unrenewed.
    writeLease({ leaderId: 'old', pid: process.pid, expiresAt: 60_000 }, file);
    const before = fs.readFileSync(path.join(`${file}.claims`, '1.json'), 'utf8');
    expect(holdLease('new', process.pid, 1000, file, 1500)).toBe(false);
    expect(fs.readFileSync(path.join(`${file}.claims`, '1.json'), 'utf8')).toBe(before);
  }));
});
