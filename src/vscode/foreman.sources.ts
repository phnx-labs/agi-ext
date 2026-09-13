// Data sources for the Foreman digest.
//
// We do NOT re-parse session JSONL ourselves any more. agents-cli already owns
// that (SQLite + FTS5 + normalized events, 5 agent formats). We shell out,
// parse the JSON, and cross-reference against the live VS Code terminal map
// for the "open in IDE right now" flag.
//
// Three cohorts:
//   1. Local sessions      -> `agents sessions --json --all --since <x> --limit <n>`
//   2. Cloud dispatches    -> `agents cloud list --json`
//   3. Team DAGs           -> `agents teams list --json`
//
// Each wrapper has a 3-second timeout and returns [] on any failure so a
// single slow source can't stall the voice turn.

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { shellQuote } from '../core/deviceDispatchShell';
import { resolveAgentsBin, bootstrapPath } from '../core/agentsBin';

const execAsync = promisify(exec);
const TIMEOUT_MS = 3_000;
const TEAM_LIST_CACHE_TTL_MS = 15_000;
const TEAM_STATUS_CACHE_TTL_MS = 5_000;

let lastResolveError: string | undefined;

export function getLastSourcesError(): string | undefined {
  return lastResolveError;
}

export interface SessionLite {
  id: string;
  shortId: string;
  agent: string;          // 'claude' | 'codex' | 'opencode' | 'openclaw'
  version?: string;
  account?: string;
  timestamp: string;
  project?: string;
  cwd?: string;
  gitBranch?: string;
  topic?: string;         // the session's headline (often the first prompt)
  label?: string;         // user-set name via Claude /rename
  messageCount?: number;
  tokenCount?: number;
  isTeamOrigin?: boolean;
  teamOrigin?: { handle?: string; mode?: string };
  // Joined-in at runtime:
  openInIde?: boolean;    // true when a live VS Code terminal owns this sessionId
}

export interface CloudTaskLite {
  id: string;
  provider: string;
  agent: string;
  status: string;         // running | needs_review | completed | cancelled | failed
  prompt: string;
  repo?: string | null;
  updatedAt?: string;
}

export interface TeamLite {
  task_name: string;
  agent_count: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
  workspace_dir?: string;
  modified_at?: string;
}

// --- P1 Jarvis read-tool sources -------------------------------------------
// Thin wrappers over `agents <cmd> --json` for the expanded Foreman tool set.
// Shapes below match the live CLI output (verified against agents-cli).

export interface CloudTaskDetail {
  id: string;
  provider: string;
  agent: string;
  status: string;
  prompt: string;
  repo?: string | null;
}

export interface RoutineLite {
  name: string;
  agent: string;
  schedule: string;
  scheduleHuman?: string;
  enabled: boolean;
  overdue?: boolean;
  nextRunHuman?: string;
  lastStatus?: string | null;
}

export interface DeviceLite {
  name: string;
  platform: string;
  online: boolean;
  relay?: string | null;
}

export interface UsageLite {
  agent: string;
  plan?: string | null;
  usageStatus?: string | null;   // available | limited | ...
  maxUsedPercent: number;        // worst window, so "am I rate limited" is honest
  soonestResetAt?: string | null;
}

export async function getCloudTask(id: string): Promise<CloudTaskDetail | null> {
  if (!id) return null;
  const r = await runJson<any>(['cloud', 'status', id, '--json'], null);
  if (!r || typeof r !== 'object') return null;
  return {
    id: String(r.id ?? id),
    provider: String(r.provider ?? ''),
    agent: String(r.agent ?? ''),
    status: String(r.status ?? ''),
    prompt: String(r.prompt ?? '').slice(0, 200),
    repo: r.repo ? String(r.repo) : null,
  };
}

export async function listRoutines(): Promise<RoutineLite[]> {
  const raw = await runJson<any[]>(['routines', 'list', '--json'], []);
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    name: String(r.name ?? ''),
    agent: String(r.agent ?? ''),
    schedule: String(r.schedule ?? ''),
    scheduleHuman: r.scheduleHuman ? String(r.scheduleHuman) : undefined,
    enabled: r.enabled === true,
    overdue: r.overdue === true,
    nextRunHuman: r.nextRunHuman ? String(r.nextRunHuman) : undefined,
    lastStatus: r.lastStatus ? String(r.lastStatus) : null,
  }));
}

export async function listDevices(): Promise<DeviceLite[]> {
  const raw = await runJson<any[]>(['devices', 'list', '--json'], []);
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    name: String(r.name ?? ''),
    platform: String(r.platform ?? ''),
    online: !!(r.tailscale && r.tailscale.online),
    relay: r.tailscale && r.tailscale.relay ? String(r.tailscale.relay) : null,
  }));
}

export async function getUsage(): Promise<UsageLite[]> {
  const raw = await runJson<any[]>(['view', '--json'], []);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const versions = Array.isArray(entry.versions) ? entry.versions : [];
    // Pick the default (else first signed-in) version and report its tightest
    // window, so "am I rate limited on Claude" answers on the worst limit.
    const v = versions.find((x: any) => x.isDefault)
      ?? versions.find((x: any) => x.signedIn)
      ?? versions[0]
      ?? {};
    const windows = Array.isArray(v.windows) ? v.windows : [];
    let maxUsedPercent = 0;
    let soonestResetAt: string | null = null;
    let soonestMs = Infinity;
    for (const w of windows) {
      const p = typeof w.usedPercent === 'number' ? w.usedPercent : 0;
      if (p > maxUsedPercent) maxUsedPercent = p;
      if (w.resetsAt) {
        const ms = Date.parse(String(w.resetsAt));
        if (Number.isFinite(ms) && ms < soonestMs) { soonestMs = ms; soonestResetAt = String(w.resetsAt); }
      }
    }
    return {
      agent: String(entry.agent ?? ''),
      plan: v.plan ? String(v.plan) : null,
      usageStatus: v.usageStatus ? String(v.usageStatus) : null,
      maxUsedPercent,
      soonestResetAt,
    };
  });
}

type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  pending?: Promise<T>;
};

let allTeamsCache: CacheEntry<TeamLite[]> | undefined;
const teamStatusCache = new Map<string, CacheEntry<TeammateLite[]>>();

export interface SessionEvent {
  type: string;           // message | tool_use | tool_result | thinking | usage | ...
  timestamp?: string;
  role?: 'user' | 'assistant';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  path?: string;
  success?: boolean;
  output?: string;
}

export async function listLocalSessions(opts: { since?: string; limit?: number; all?: boolean } = {}): Promise<SessionLite[]> {
  const since = opts.since ?? '2h';
  const limit = opts.limit ?? 30;
  const all = opts.all !== false;
  const args = ['sessions', '--json', '--since', since, '--limit', String(limit)];
  if (all) args.push('--all', '--teams');
  return runJson<SessionLite[]>(args, []);
}

export async function readSessionEvents(sessionId: string, lastN = 20): Promise<SessionEvent[]> {
  // 1.20.51+ emits { session, events }; older CLIs emit a bare event array.
  const parsed = await runJson<SessionEvent[] | { events?: SessionEvent[] }>(
    ['sessions', sessionId, '--json', '--last', String(lastN)],
    []
  );
  return Array.isArray(parsed) ? parsed : (parsed.events ?? []);
}

export async function listCloudTasks(): Promise<CloudTaskLite[]> {
  const raw = await runJson<any[]>(['cloud', 'list', '--json'], []);
  return raw.map((r) => ({
    id: String(r.id ?? ''),
    provider: String(r.provider ?? ''),
    agent: String(r.agent ?? ''),
    status: String(r.status ?? ''),
    prompt: String(r.prompt ?? '').slice(0, 200),
    repo: r.repo ? String(r.repo) : null,
    updatedAt: r.updatedAt ? String(r.updatedAt) : undefined,
  }));
}

export async function listTeams(): Promise<TeamLite[]> {
  const teams = await listAllTeams();
  return teams.filter((t: any) => (t.running ?? 0) + (t.pending ?? 0) > 0);
}

// All teams (including completed/stopped) — used by the agent panel so the
// "Teams in this directory" list can show recently-finished work too.
async function listAllTeams(): Promise<TeamLite[]> {
  const now = Date.now();
  if (allTeamsCache?.value && allTeamsCache.expiresAt > now) {
    return allTeamsCache.value;
  }
  if (allTeamsCache?.pending) {
    return allTeamsCache.pending;
  }

  const pending = (async () => {
    const raw = await runJson<any>(['teams', 'list', '--json'], { teams: [] });
    const teams = (Array.isArray(raw) ? raw : Array.isArray(raw?.teams) ? raw.teams : []) as TeamLite[];
    allTeamsCache = { value: teams, expiresAt: Date.now() + TEAM_LIST_CACHE_TTL_MS };
    return teams;
  })();

  allTeamsCache = { pending, expiresAt: now + TEAM_LIST_CACHE_TTL_MS };
  return pending;
}

export interface TeammateLite {
  agent_id: string;
  name: string;
  agent_type: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  duration?: string;
  cwd?: string;
}

export async function getTeamStatus(team: string): Promise<TeammateLite[]> {
  const now = Date.now();
  const cached = teamStatusCache.get(team);
  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const pending = (async () => {
    const raw = await runJson<any>(['teams', 'status', team, '--json'], { agents: [] });
    const agents = Array.isArray(raw?.agents) ? raw.agents : [];
    const teammates = agents.map((a: any) => ({
      agent_id: String(a.agent_id ?? ''),
      name: String(a.name ?? ''),
      agent_type: String(a.agent_type ?? ''),
      status: String(a.status ?? ''),
      started_at: a.started_at ? String(a.started_at) : undefined,
      completed_at: a.completed_at ? String(a.completed_at) : undefined,
      duration: a.duration ? String(a.duration) : undefined,
      cwd: a.cwd ? String(a.cwd) : undefined,
    }));
    teamStatusCache.set(team, { value: teammates, expiresAt: Date.now() + TEAM_STATUS_CACHE_TTL_MS });
    return teammates;
  })();

  teamStatusCache.set(team, { pending, expiresAt: now + TEAM_STATUS_CACHE_TTL_MS });
  return pending;
}

export interface TeamWithMates extends TeamLite {
  teammates: TeammateLite[];
}

// Teams whose workspace_dir is related to `cwd` (equal, parent, or descendant).
// Includes the teammates so the panel can render the full breakdown without
// firing another round-trip. Limits status calls to the first 6 matches to
// keep the panel responsive.
// Collect live session ids from the VS Code terminal environment so we can
// mark which sessions are "open in the IDE" without re-reading JSONL.

async function runJson<T>(args: string[], fallback: T): Promise<T> {
  try {
    const bin = await resolveAgentsBin();
    const cmd = [shellQuote(bin), ...args.map(shellQuote)].join(' ');
    // The agents binary is a `#!/usr/bin/env node` script. The extension host
    // on macOS inherits a minimal PATH (no nvm, no homebrew) so the shebang
    // can't find `node`. Augment PATH with the directory of the resolved
    // binary plus common node locations so shebang + any transitive shell-outs
    // (git, etc.) resolve.
    const { stdout } = await execAsync(cmd, {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: bootstrapPath(bin) },
    });
    const trimmed = stdout.trim();
    if (!trimmed) return fallback;
    return JSON.parse(trimmed) as T;
  } catch (err: any) {
    lastResolveError = `agents ${args.join(' ')}: ${err?.message ?? String(err)}`;
    return fallback;
  }
}

