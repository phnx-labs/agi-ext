// The Lead client: one long-lived headless Claude per project that agents-cli owns
// (`agents lead … --json`). The extension is a thin client: every gesture is one
// `agents lead` verb, and what it shows is the NDJSON that verb prints. These are
// the pure parts plus the process boundary; the overlay, status bar and tab live in
// src/vscode/lead.vscode.ts and src/vscode/leadTab.vscode.ts.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { bootstrapPath, resolveAgentsBin } from './agentsBin';

// ── Stream events (`agents lead ask|confirm --json`) ──

export type LeadEngine = 'warm' | 'cold';
type LeadPhase = 'booting' | 'thinking' | 'tool' | 'answering';

export type LeadRef =
  | { kind: 'ticket'; id: string; url?: string }
  | { kind: 'pr'; repo: string; number: number; url?: string }
  | { kind: 'session'; id: string; title?: string; host?: string };

interface LeadTiming { boot?: number; model?: number; tools?: number }

export type LeadEvent =
  | { type: 'turn'; turn: string; project: string; session: string; engine: LeadEngine }
  | { type: 'status'; state: LeadPhase }
  | { type: 'tool'; id: string; label: string; cmd?: string; state: 'run' | 'ok' | 'fail'; secs?: number }
  | { type: 'text'; delta: string }
  | { type: 'confirm'; token: string; action: string; sessionId?: string; label: string }
  | { type: 'done'; turn: string; text: string; summary: string; refs: LeadRef[]; timing?: LeadTiming }
  | { type: 'error'; message: string };

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A ref's url opens only as a web page: http(s), nothing else. */
export function isWebUrl(v: unknown): v is string {
  if (!str(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

export function parseLeadRef(v: unknown): LeadRef | null {
  if (!obj(v)) return null;
  if (v.kind === 'ticket' && str(v.id) && v.id) return { kind: 'ticket', id: v.id, ...(isWebUrl(v.url) ? { url: v.url } : {}) };
  if (v.kind === 'pr' && str(v.repo) && /^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(v.repo) && num(v.number)) return { kind: 'pr', repo: v.repo, number: v.number, ...(isWebUrl(v.url) ? { url: v.url } : {}) };
  if (v.kind === 'session' && str(v.id) && v.id) {
    return { kind: 'session', id: v.id, ...(str(v.title) ? { title: v.title } : {}), ...(str(v.host) ? { host: v.host } : {}) };
  }
  return null;
}

function parseRefs(v: unknown): LeadRef[] {
  return Array.isArray(v) ? v.map(parseLeadRef).filter((r): r is LeadRef => !!r) : [];
}

function parseTiming(v: unknown): LeadTiming | undefined {
  if (!obj(v)) return undefined;
  const t: LeadTiming = {};
  if (num(v.boot)) t.boot = v.boot;
  if (num(v.model)) t.model = v.model;
  if (num(v.tools)) t.tools = v.tools;
  return t;
}

/** One NDJSON line to a typed event, or null for a line that is not one of the contract's events. */
export function parseLeadLine(line: string): LeadEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let v: unknown;
  try { v = JSON.parse(trimmed); } catch { return null; }
  if (!obj(v)) return null;
  switch (v.type) {
    case 'turn':
      if (!str(v.turn)) return null;
      return { type: 'turn', turn: v.turn, project: str(v.project) ? v.project : '', session: str(v.session) ? v.session : '', engine: v.engine === 'cold' ? 'cold' : 'warm' };
    case 'status':
      return v.state === 'booting' || v.state === 'thinking' || v.state === 'tool' || v.state === 'answering' ? { type: 'status', state: v.state } : null;
    case 'tool':
      if (!str(v.id) || !(v.state === 'run' || v.state === 'ok' || v.state === 'fail')) return null;
      return { type: 'tool', id: v.id, label: str(v.label) ? v.label : '', state: v.state, ...(str(v.cmd) ? { cmd: v.cmd } : {}), ...(num(v.secs) ? { secs: v.secs } : {}) };
    case 'text':
      return str(v.delta) ? { type: 'text', delta: v.delta } : null;
    case 'confirm':
      if (!str(v.token) || !v.token) return null;
      return { type: 'confirm', token: v.token, action: str(v.action) ? v.action : '', label: str(v.label) ? v.label : 'Confirm', ...(str(v.sessionId) ? { sessionId: v.sessionId } : {}) };
    case 'done': {
      const text = str(v.text) ? v.text : '';
      return { type: 'done', turn: str(v.turn) ? v.turn : '', text, summary: str(v.summary) && v.summary ? v.summary : summaryOf(text), refs: parseRefs(v.refs), ...(parseTiming(v.timing) ? { timing: parseTiming(v.timing) } : {}) };
    }
    case 'error':
      return { type: 'error', message: str(v.message) && v.message ? v.message : 'The Lead reported an error without a message.' };
    default:
      return null;
  }
}

/** The contract's summary: the first sentence, at most 80 characters. */
export function summaryOf(text: string): string {
  const first = (text.trim().match(/^[\s\S]*?[.?!](\s|$)/) || [text.trim()])[0].replace(/\s+/g, ' ').trim();
  return first.length > 80 ? first.slice(0, 79) + '…' : first;
}

// ── One turn, as the events build it ──

interface LeadToolRow { id: string; label: string; cmd?: string; state: 'run' | 'ok' | 'fail'; secs?: number }
interface LeadConfirmRow { token: string; action: string; sessionId?: string; label: string; state: 'open' | 'running' | 'done' | 'failed'; message?: string }

export interface LeadTurn {
  /** The words you sent; empty for a turn a Confirm started. */
  ask: string;
  voiceSecs?: number;
  turn?: string;
  project?: string;
  session?: string;
  engine?: LeadEngine;
  phase?: LeadPhase;
  tools: LeadToolRow[];
  text: string;
  confirms: LeadConfirmRow[];
  refs: LeadRef[];
  summary?: string;
  timing?: LeadTiming;
  error?: string;
  finished: boolean;
  startedAt: number;
  endedAt?: number;
}

export function newTurn(ask: string, now: number, voiceSecs?: number): LeadTurn {
  return { ask, ...(voiceSecs !== undefined ? { voiceSecs } : {}), tools: [], text: '', confirms: [], refs: [], finished: false, startedAt: now };
}

/** Apply one event to the turn in place; returns the turn for chaining. */
export function applyLeadEvent(t: LeadTurn, e: LeadEvent, now: number): LeadTurn {
  switch (e.type) {
    case 'turn': t.turn = e.turn; t.project = e.project || t.project; t.session = e.session || t.session; t.engine = e.engine; break;
    case 'status': t.phase = e.state; break;
    case 'tool': {
      const row = t.tools.find((x) => x.id === e.id);
      if (row) { row.state = e.state; if (e.label) row.label = e.label; if (e.cmd) row.cmd = e.cmd; if (e.secs !== undefined) row.secs = e.secs; }
      else t.tools.push({ id: e.id, label: e.label || e.cmd || e.id, state: e.state, ...(e.cmd ? { cmd: e.cmd } : {}), ...(e.secs !== undefined ? { secs: e.secs } : {}) });
      break;
    }
    case 'text': t.text += e.delta; break;
    case 'confirm':
      if (!t.confirms.some((c) => c.token === e.token)) t.confirms.push({ token: e.token, action: e.action, label: e.label, state: 'open', ...(e.sessionId ? { sessionId: e.sessionId } : {}) });
      break;
    case 'done':
      if (e.turn) t.turn = e.turn;
      t.text = e.text || t.text; t.summary = e.summary; t.refs = e.refs;
      if (e.timing) t.timing = e.timing;
      t.finished = true; t.endedAt = now;
      break;
    case 'error': t.error = e.message; t.finished = true; t.endedAt = now; break;
  }
  return t;
}

// ── Inline links ──

export type LeadSegment = { kind: 'text'; text: string } | { kind: 'ref'; text: string; ref: LeadRef };

const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const PR_RE = /(^|[\s(\[,;:])#(\d{1,6})\b/g;

/**
 * Split the Lead's plain text into text and links. A ticket id links when the turn
 * named it in `refs`, or when it carries the prefix of a ticket the turn named
 * (PHNX-9 beside PHNX-4365) or one of `knownPrefixes`; so UTF-8, SHA-256 or GPT-4
 * stay text. A PR number links only to a PR in `refs`, since `#3607` alone does not
 * say which repository; a session links where its title (from `refs`) appears verbatim.
 */
export function linkify(text: string, refs: readonly LeadRef[], knownPrefixes: readonly string[] = []): LeadSegment[] {
  type Hit = { start: number; end: number; ref: LeadRef };
  const hits: Hit[] = [];
  const tickets = refs.filter((r): r is Extract<LeadRef, { kind: 'ticket' }> => r.kind === 'ticket');
  const prefixes = new Set([...knownPrefixes, ...tickets.map((r) => r.id.replace(/-\d+$/, ''))]);
  for (const m of text.matchAll(TICKET_RE)) {
    const id = m[0];
    const ref = tickets.find((r) => r.id === id) ?? (prefixes.has(id.replace(/-\d+$/, '')) ? { kind: 'ticket' as const, id } : undefined);
    if (ref) hits.push({ start: m.index!, end: m.index! + id.length, ref });
  }
  for (const m of text.matchAll(PR_RE)) {
    const n = Number(m[2]);
    const ref = refs.find((r) => r.kind === 'pr' && r.number === n);
    if (!ref) continue;
    const start = m.index! + m[1].length;
    hits.push({ start, end: start + 1 + m[2].length, ref });
  }
  for (const r of refs) {
    if (r.kind !== 'session' || !r.title || r.title.length < 3) continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(r.title, from);
      if (i < 0) break;
      hits.push({ start: i, end: i + r.title.length, ref: r });
      from = i + r.title.length;
    }
  }
  // Earliest first; on overlap the longer match wins.
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: LeadSegment[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    if (h.start > at) out.push({ kind: 'text', text: text.slice(at, h.start) });
    out.push({ kind: 'ref', text: text.slice(h.start, h.end), ref: h.ref });
    at = h.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** What a ref row or link says about itself. */
export function refLabel(r: LeadRef): string {
  return r.kind === 'ticket' ? r.id : r.kind === 'pr' ? `#${r.number}` : (r.title || r.id.slice(0, 8));
}

export function refDescription(r: LeadRef): string {
  return r.kind === 'ticket' ? 'ticket · opens in Issues'
    : r.kind === 'pr' ? `${r.repo} · pull request`
      : ['session', r.host].filter(Boolean).join(' · ') + ' · goes to its tab';
}

/** Ticket ids, PR numbers or session ids are the identity; one row per ref. */
export function refKey(r: LeadRef): string {
  return r.kind === 'ticket' ? `t:${r.id}` : r.kind === 'pr' ? `p:${r.repo}#${r.number}` : `s:${r.id}`;
}

export function uniqueRefs(refs: readonly LeadRef[]): LeadRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => { const k = refKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** "now", "12s", "5m", "3h", "2d": the status bar's age of the last summary. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The answer as the overlay's rows: one per sentence, since a quick-pick row is one line. */
export function answerLines(text: string): string[] {
  return text.split(/\n+|(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
}

// ── history and status (`agents lead history|status --json`) ──

/** One finished turn from `agents lead history --json`. */
export interface LeadHistoryTurn {
  turn: string;
  at?: number;
  ask: string;
  voiceSecs?: number;
  text: string;
  summary: string;
  refs: LeadRef[];
  tools: LeadToolRow[];
  timing?: LeadTiming;
}

function parseAt(v: unknown): number | undefined {
  if (num(v)) return v < 1e12 ? v * 1000 : v;
  if (str(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : undefined; }
  return undefined;
}

function parseHistoryTurn(v: unknown): LeadHistoryTurn | null {
  if (!obj(v)) return null;
  const text = str(v.text) ? v.text : '';
  const ask = str(v.ask) ? v.ask : str(v.prompt) ? v.prompt : str(v.input) ? v.input : '';
  if (!text && !ask) return null;
  const tools = Array.isArray(v.tools) ? v.tools.filter(obj).map((x, i) => ({
    id: str(x.id) ? x.id : String(i), label: str(x.label) ? x.label : str(x.cmd) ? x.cmd : 'tool',
    state: (x.state === 'fail' ? 'fail' : x.state === 'run' ? 'run' : 'ok') as LeadToolRow['state'],
    ...(str(x.cmd) ? { cmd: x.cmd } : {}), ...(num(x.secs) ? { secs: x.secs } : {}),
  })) : [];
  const at = parseAt(v.at ?? v.ts ?? v.endedAt);
  return {
    turn: str(v.turn) ? v.turn : '', ...(at !== undefined ? { at } : {}), ask,
    ...(num(v.voice) ? { voiceSecs: v.voice } : num(v.voiceSecs) ? { voiceSecs: v.voiceSecs } : {}),
    text, summary: str(v.summary) && v.summary ? v.summary : summaryOf(text), refs: parseRefs(v.refs), tools,
    ...(parseTiming(v.timing) ? { timing: parseTiming(v.timing) } : {}),
  };
}

/** `history --json` prints a JSON array, `{ turns: [...] }`, or one turn per line; oldest first. */
export function parseLeadHistory(stdout: string): LeadHistoryTurn[] {
  const s = stdout.trim();
  if (!s) return [];
  let items: unknown[] | null = null;
  try {
    const v: unknown = JSON.parse(s);
    items = Array.isArray(v) ? v : obj(v) && Array.isArray(v.turns) ? v.turns : obj(v) ? [v] : null;
  } catch { /* NDJSON */ }
  if (!items) items = s.split('\n').map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } });
  return items.map(parseHistoryTurn).filter((t): t is LeadHistoryTurn => !!t);
}

export interface LeadStatus {
  project: string;
  state: string;
  session?: string;
  engine?: LeadEngine;
  model?: string;
  host?: string;
  startedAt?: number;
  brief: string[];
  memory: string[];
  tools: string[];
}

const lines = (v: unknown): string[] => Array.isArray(v) ? v.filter(str).map((x) => x.trim()).filter(Boolean)
  : str(v) ? v.split('\n').map((x) => x.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean) : [];

/** `status --json` for one project: an object, or the project's entry in an array or `{ projects }`. */
export function parseLeadStatus(stdout: string, project: string): LeadStatus | null {
  let v: unknown;
  try { v = JSON.parse(stdout.trim()); } catch { return null; }
  const list = Array.isArray(v) ? v : obj(v) && Array.isArray(v.projects) ? v.projects : [v];
  const hit = list.filter(obj).find((x) => !str(x.project) || x.project === project);
  if (!hit) return null;
  const at = parseAt(hit.startedAt);
  return {
    project: str(hit.project) ? hit.project : project,
    state: str(hit.state) ? hit.state : str(hit.status) ? hit.status : 'unknown',
    ...(str(hit.session) ? { session: hit.session } : str(hit.sessionId) ? { session: hit.sessionId } : {}),
    ...(hit.engine === 'warm' || hit.engine === 'cold' ? { engine: hit.engine } : {}),
    ...(str(hit.model) ? { model: hit.model } : {}),
    ...(str(hit.host) ? { host: hit.host } : {}),
    ...(at !== undefined ? { startedAt: at } : {}),
    brief: lines(hit.brief), memory: lines(hit.memory), tools: lines(hit.tools ?? hit.allowedTools),
  };
}

// ── The shared surface switch (`~/.agents/lead/surface.json`) ──

export type LeadSurface = 'bubble' | 'docked';

function leadDir(home: string = os.homedir()): string {
  return path.join(home, '.agents', 'lead');
}

function surfacePath(home: string = os.homedir()): string {
  return path.join(leadDir(home), 'surface.json');
}

export function parseSurface(text: string): LeadSurface | null {
  try {
    const v: unknown = JSON.parse(text);
    return obj(v) && (v.surface === 'bubble' || v.surface === 'docked') ? v.surface : null;
  } catch { return null; }
}

/** What the file says: a surface, `absent` (no file, or no folder), or `invalid` (unreadable or malformed). */
export function readSurfaceFile(home: string = os.homedir()): LeadSurface | 'absent' | 'invalid' {
  let text: string;
  try { text = fs.readFileSync(surfacePath(home), 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'absent' : 'invalid';
  }
  return parseSurface(text) ?? 'invalid';
}

/**
 * The next surface given what was last known: FastWispr writes "bubble" when its
 * Lead mode is on; no file means the extension is the Lead's surface; a file
 * caught half-written or malformed keeps the last known value.
 */
export function nextSurface(read: LeadSurface | 'absent' | 'invalid', last: LeadSurface): LeadSurface {
  return read === 'absent' ? 'docked' : read === 'invalid' ? last : read;
}

export function readSurface(home: string = os.homedir()): LeadSurface {
  return nextSurface(readSurfaceFile(home), 'docked');
}

/** Write the switch atomically, so the other client never reads half a file. */
export function writeSurface(surface: LeadSurface, home: string = os.homedir()): void {
  const file = surfacePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ surface }) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Watch the switch without creating anything: `onChange` gets the surface each
 * time it differs from the last one seen. Three sources feed one `sync`, because
 * no single one is reliable on every platform:
 * - a watcher on ~/.agents/lead, while it exists;
 * - a watcher on ~/.agents, for the lead folder appearing or going away (on
 *   macOS, FSEvents may say nothing to a watcher whose own folder is deleted, and
 *   a watcher does not follow a folder recreated at the same path);
 * - an unref'd read every `pollMs` (default 2 s), since FSEvents can coalesce or
 *   drop events. surface.json is a few bytes; the read is the comparison.
 * Each `sync` re-arms whichever watcher no longer matches what is on disk.
 */
export function watchSurface(onChange: (s: LeadSurface) => void, home: string = os.homedir(), opts: { pollMs?: number } = {}): { dispose(): void } {
  const dir = leadDir(home);
  const parent = path.dirname(dir);
  let last = readSurface(home);
  let dirWatcher: fs.FSWatcher | undefined;
  let parentWatcher: fs.FSWatcher | undefined;
  let disposed = false;
  const check = () => { const now = nextSurface(readSurfaceFile(home), last); if (now !== last) { last = now; onChange(now); } };
  const watch = (target: string): fs.FSWatcher | undefined => {
    try {
      const w = fs.watch(target, () => sync());
      // A broken watcher is dropped; the next sync (at the latest the poll) re-arms it.
      w.on('error', () => { w.close(); if (dirWatcher === w) dirWatcher = undefined; if (parentWatcher === w) parentWatcher = undefined; });
      return w;
    } catch { return undefined; }
  };
  let dirIno: number | undefined;
  function sync(): void {
    if (disposed) return;
    let ino: number | undefined;
    try { ino = fs.statSync(dir).ino; } catch { ino = undefined; }
    // The folder went away, or was recreated (a new inode): the old watcher is stale.
    if (ino !== dirIno) { dirWatcher?.close(); dirWatcher = undefined; dirIno = ino; }
    if (ino !== undefined && !dirWatcher) dirWatcher = watch(dir);
    if (!parentWatcher && fs.existsSync(parent)) parentWatcher = watch(parent);
    check();
  }
  const timer = setInterval(sync, opts.pollMs ?? 2_000);
  timer.unref?.();
  sync();
  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      dirWatcher?.close();
      parentWatcher?.close();
      dirWatcher = parentWatcher = undefined;
    },
  };
}

// ── The process boundary ──

export interface LeadRunOptions {
  /** The `agents` binary; the shared resolver by default. Tests pass the stub. */
  resolveBin?: () => Promise<string>;
  cwd?: string;
  /** End a turn that prints nothing for this long (default 120 s). */
  idleMs?: number;
  /** End a turn that runs longer than this, output or not (default 15 min). */
  maxMs?: number;
}

export interface LeadRun { child: ChildProcess; exited: Promise<number | null>; kill(reason: string): void }

const LEAD_IDLE_MS = 120_000;
const LEAD_MAX_MS = 15 * 60_000;

function spawnLead(bin: string, args: string[], cwd: string | undefined): ChildProcess {
  return spawn(bin, ['lead', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    windowsHide: true,
    env: { ...process.env, PATH: `${bootstrapPath(bin)}:${process.env.PATH ?? ''}` },
  });
}

/** A CLI without the `lead` noun is an upgrade error, said as one. */
function upgradeHint(why: string): string {
  return /unknown command|no such command|invalid choice|unknown subcommand/i.test(why) ? `This agents CLI has no \`agents lead\`. Upgrade agents-cli. (${why})` : why;
}

const secsText = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;

/**
 * Spawn one `agents lead <args>` and hand each contract event to `onEvent`. A
 * process that ends without `done` or `error` is reported as an `error` event
 * carrying its stderr; one silent for `idleMs`, or running past `maxMs`, is
 * killed and reported the same way, so a turn never hangs.
 */
async function runLeadStream(args: string[], onEvent: (e: LeadEvent) => void, opts: LeadRunOptions = {}): Promise<LeadRun> {
  const bin = await (opts.resolveBin ?? resolveAgentsBin)();
  const child = spawnLead(bin, args, opts.cwd);
  const idleMs = opts.idleMs ?? LEAD_IDLE_MS;
  let ended = false;
  let stderr = '';
  let killedFor: string | undefined;
  const kill = (reason: string) => {
    if (killedFor || child.exitCode !== null || child.signalCode !== null) return;
    killedFor = reason;
    child.kill('SIGTERM');
  };
  let idle = setTimeout(() => kill(`The Lead printed nothing for ${secsText(idleMs)}; this turn was stopped.`), idleMs);
  const cap = setTimeout(() => kill(`The turn ran past ${secsText(opts.maxMs ?? LEAD_MAX_MS)}; it was stopped.`), opts.maxMs ?? LEAD_MAX_MS);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => kill(`The Lead printed nothing for ${secsText(idleMs)}; this turn was stopped.`), idleMs); };
  child.stdout?.on('data', touch);
  child.stderr?.on('data', (d: Buffer) => { touch(); stderr = (stderr + d.toString()).slice(-4000); });
  // readline joins a line split across chunks before it is parsed.
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    if (ended) return;
    const e = parseLeadLine(line);
    if (!e) return;
    if (e.type === 'done' || e.type === 'error') ended = true;
    onEvent(e);
  });
  const lineDone = new Promise<void>((resolve) => rl.on('close', resolve));
  const exited = new Promise<number | null>((resolve) => {
    let spawnError: Error | undefined;
    child.on('error', (err) => { spawnError = err; });
    child.on('close', async (code, signal) => {
      clearTimeout(idle);
      clearTimeout(cap);
      await lineDone;
      if (!ended) {
        ended = true;
        const last = stderr.trim().split('\n').filter(Boolean).pop();
        const why = killedFor ?? spawnError?.message ?? last ?? `agents lead ${args[0]} ${signal ? `was killed (${signal})` : `exited ${code}`} without an answer`;
        onEvent({ type: 'error', message: upgradeHint(why) });
      }
      resolve(spawnError ? -1 : code);
    });
  });
  return { child, exited, kill };
}

/** `agents lead <args>` that prints one JSON document (history, status). */
async function runLeadJson(args: string[], opts: LeadRunOptions): Promise<string> {
  const bin = await (opts.resolveBin ?? resolveAgentsBin)();
  const child = spawnLead(bin, args, opts.cwd);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  return new Promise((resolve, reject) => {
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(upgradeHint(stderr.trim().split('\n').filter(Boolean).pop() || `agents lead ${args[0]} exited ${code ?? 'on a signal'}`)));
    });
  });
}

// ── The client: one per window ──

export interface LeadSnapshot {
  project: string | undefined;
  busy: boolean;
  current: LeadTurn | undefined;
  /** Turns finished in this window, oldest first. */
  turns: LeadTurn[];
  last: { summary: string; at: number } | undefined;
  session?: string;
  engine?: LeadEngine;
}

export class LeadClient {
  private current: LeadTurn | undefined;
  private finished: LeadTurn[] = [];
  private last: { summary: string; at: number } | undefined;
  private session: string | undefined;
  private engine: LeadEngine | undefined;
  private project: string | undefined;
  private running: LeadRun | undefined;
  private listeners = new Set<(s: LeadSnapshot) => void>();

  constructor(private readonly opts: LeadRunOptions & { now?: () => number } = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  onChange(fn: (s: LeadSnapshot) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  snapshot(): LeadSnapshot {
    return { project: this.project, busy: this.busy, current: this.current, turns: [...this.finished], last: this.last, session: this.session, engine: this.engine };
  }

  get busy(): boolean { return !!this.current && !this.current.finished; }

  private emit(): void { const s = this.snapshot(); for (const fn of this.listeners) fn(s); }

  /** Seed the last summary from history, unless this window has a newer one. */
  noteSummary(summary: string, at: number): void {
    if (!summary || (this.last && this.last.at >= at)) return;
    this.last = { summary, at };
    this.emit();
  }

  /** `agents lead ask --project <p> [--voice <secs>] --json <text>`; resolves when the turn ends. */
  async ask(project: string, text: string, voiceSecs?: number): Promise<LeadTurn> {
    if (this.busy) throw new Error('The Lead is still working on the last turn.');
    const args = ['ask', '--project', project, ...(voiceSecs !== undefined ? ['--voice', voiceSecs.toFixed(1)] : []), '--json', '--', text];
    return this.run(project, newTurn(text, this.now(), voiceSecs), args);
  }

  /** `agents lead confirm <token> --json`: runs the gated action as its own turn. */
  async confirm(token: string): Promise<LeadTurn> {
    if (this.busy) throw new Error('The Lead is still working on the last turn.');
    const row = [this.current, ...this.finished].flatMap((t) => t?.confirms ?? []).find((c) => c.token === token);
    if (row) row.state = 'running';
    const turn = newTurn('', this.now());
    turn.project = this.project;
    const done = await this.run(this.project, turn, ['confirm', token, '--json']);
    if (row) { row.state = done.error ? 'failed' : 'done'; if (done.error) row.message = done.error; }
    this.emit();
    return done;
  }

  private async run(project: string | undefined, turn: LeadTurn, args: string[]): Promise<LeadTurn> {
    if (this.current?.finished) this.finished.push(this.current);
    this.current = turn;
    if (project) { this.project = project; turn.project = project; }
    this.emit();
    try {
      this.running = await runLeadStream(args, (e) => {
        applyLeadEvent(turn, e, this.now());
        if (e.type === 'turn') { if (e.session) this.session = e.session; this.engine = e.engine; }
        if (e.type === 'done' && e.summary) this.last = { summary: e.summary, at: this.now() };
        this.emit();
      }, this.opts);
      await this.running.exited;
    } catch (err) {
      applyLeadEvent(turn, { type: 'error', message: err instanceof Error ? err.message : String(err) }, this.now());
      this.emit();
    } finally {
      this.running = undefined;
    }
    return turn;
  }

  history(project: string, limit = 50): Promise<LeadHistoryTurn[]> {
    return runLeadJson(['history', '--project', project, '--limit', String(limit), '--json'], this.opts).then(parseLeadHistory);
  }

  status(project: string): Promise<LeadStatus | null> {
    return runLeadJson(['status', '--project', project, '--json'], this.opts).then((out) => parseLeadStatus(out, project));
  }

  /** Window teardown: SIGTERM an unfinished `ask`/`confirm` child. The Lead's own process is agents-cli's and runs on. */
  dispose(): void {
    this.listeners.clear();
    this.running?.kill('The window closed while the Lead was answering.');
  }

  /** True when `token` is an open Confirm row of a turn this client knows. */
  hasOpenConfirm(token: string): boolean {
    return [this.current, ...this.finished].some((t) => t?.confirms.some((c) => c.token === token && c.state === 'open'));
  }
}
