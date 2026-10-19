// The session cards the Active Session sidebar (src/vscode/agentPanel.vscode.ts)
// draws.
//
// SESSION_CARDS_SCRIPT is plain webview JavaScript (the timeline with its seek
// strip, phases and filters, and the artifacts gallery, plus the handlers that
// wire them). It is a string because the sidebar inlines it into its nonce'd
// <script>, which supplies the free names it reads: root, viewState, vscode,
// lastSnapshot and render.
//
// Written exactly as it was inside the sidebar's template literal: a regex
// backslash is doubled, because this literal collapses `\\` to `\` the same way.
// No backticks inside; the only interpolations are functions shared with the host
// (their compiled source is inserted as is), so the host and the page say one thing.

import { relTime } from './sessionState';
import { REPLY_BOX_CSS } from './replyBox';

/** HTML-escape any value; the host's renderers and both sidebars' scripts (as
 *  `esc`, from THUMB_SCRIPT) use this one. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const SERVICE_MARK = {
  github: '<path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>',
  linear: '<circle cx="8" cy="8" r="8" fill="#5E6AD2" stroke="none"/><path d="M2.2 9.6l4.2 4.2M2.9 6.8l6.3 6.3M4.4 4.4l7.2 7.2M6.8 2.9l6.3 6.3" stroke="#fff" stroke-width="1.1"/>',
};

/** GitHub's or Linear's own mark, for whatever points there; `cls` sizes it for the surface. */
export function serviceMark(service: keyof typeof SERVICE_MARK, cls: string): string {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${SERVICE_MARK[service]}</svg>`;
}

export const SESSION_CARDS_SCRIPT = `
${relTime}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function compactDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.max(1, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
  return hours ? hours + 'h ' + minutes + 'm' : minutes + 'm';
}

// "today 3:54 PM", "yesterday 10:13 PM", or "Oct 1, 10:13 PM": a person reads a
// clock time, not a bare 24-hour stamp.
function clockTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'today ' + time;
  if (diff === 1) return 'yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

// ── Timeline ────────────────────────────────────────────────────────────────
// The CLI's narration-anchored fold: last 5 steps newest-first, 3 more behind
// "more", everything older collapsed into one counter. On an older CLI the
// summarizer's 'checkpoints' are projected into the same step shape so the card
// degrades instead of disappearing.
function timelineFromCheckpoints(s) {
  const checkpoints = s.checkpoints || [];
  if (!checkpoints.length) return null;
  return {
    steps: checkpoints.map((c) => ({
      text: c.text, at: c.at, source: 'narration', tools: 0, failed: 0, blocked: 0,
    })),
    earlier: { steps: 0, tools: 0, failed: 0 },
    tools: 0, failed: 0, spanMs: 0, state: 'ready',
  };
}

function stepChips(step) {
  const bits = [];
  const mix = step.mix || {};
  // Top 3 verb classes by count — the shape of the work, not a full histogram.
  const top = Object.keys(mix)
    .map((k) => ({ k: k, n: mix[k] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  for (const entry of top) bits.push(esc(entry.n + ' ' + entry.k));
  if (step.failed > 0) bits.push('<span class="bad">' + step.failed + ' failed</span>');
  if (step.blocked > 0) bits.push('<span class="bad">' + step.blocked + ' blocked</span>');
  for (const mark of (step.marks || [])) bits.push('<span class="mark">' + esc(mark) + '</span>');
  return bits.length ? '<span class="step-chips">' + bits.join(' · ') + '</span>' : '';
}

function renderStep(step) {
  const at = Date.parse(step.at);
  const when = Number.isFinite(at) ? relTime(at) : '';
  const cls = 'step src-' + esc(step.source || 'narration') + (step.live ? ' live' : '');
  // A user turn is the user's own words, so it renders quoted and muted — it is
  // not something the agent did.
  const text = step.source === 'user' ? '“' + truncate(step.text, 120) + '”' : truncate(step.text, 160);
  const key = JSON.stringify([lastSnapshot && lastSnapshot.fullSessionId, step.at, step.source]);
  const expanded = !!(viewState.expandedSteps && viewState.expandedSteps[key]);
  return (
    '<button type="button" data-at="' + (Number.isFinite(at) ? at : '') + '" data-step-key="' + esc(key) + '" class="' + cls + '" data-expand="' + esc(step.source === 'user' ? '“' + step.text + '”' : step.text) + '" data-short="' + esc(text) + '" aria-expanded="' + expanded + '">' +
      '<span class="step-mk"></span>' +
      '<span class="step-txt">' + esc(expanded ? (step.source === 'user' ? '“' + step.text + '”' : step.text) : text) + '</span>' +
      '<span class="step-at" title="' + esc(step.at || '') + '">' + esc(step.live ? 'now' : when) + '</span>' +
      (step.live && step.now ? '<span class="step-now">▶ ' + esc(truncate(step.now, 120)) + '</span>' : '') +
      stepChips(step) +
    '</button>'
  );
}

// How many steps show before "N more": 8 unless the viewer picked 4, 16 or all
// (owner video, 2026-10-12: "we need to show more steps here, always by default,
// maybe configurable").
const STEP_CHOICES = ['4', '8', '16', 'all'];
function timelineShown() {
  const v = String(viewState.stepsShown || '8');
  return v === 'all' ? Infinity : Number(v) || 8;
}

// One strip of tool activity across the whole session. A run of 3+ empty buckets
// collapses into a labeled gap so a 17-hour session with 10 idle hours still
// shows its bursts. Markers: your messages (numbered), subagent starts, and the
// open ask at the end. Clicking a bar jumps the step list to that moment.
function seekSegments(h) {
  const n = h.buckets.length;
  const empty = (b) => b.tools === 0 && b.failed === 0 && b.blocked === 0;
  const segs = [];
  for (let i = 0; i < n;) {
    if (empty(h.buckets[i])) {
      let j = i;
      while (j < n && empty(h.buckets[j])) j++;
      if (j - i >= 3) { segs.push({ gap: true, from: i, to: j }); i = j; continue; }
    }
    segs.push({ gap: false, i: i });
    i++;
  }
  return segs;
}

// A range is any stretch you drag across on the strip (owner, 2026-10-12: "I
// should be able to change the left and right boundary by myself"). A remembered
// range applies while it still lies inside this session's strip and is narrower
// than the whole of it; otherwise it lapses instead of dimming everything.
function currentRange(s) {
  const r = (viewState.timelineRange || {})[(s && s.fullSessionId) || ''];
  const h = s && s.activityHistogram;
  if (!Array.isArray(r) || r.length !== 2 || !h || !(h.endMs > h.startMs)) return null;
  if (!(r[1] > r[0]) || r[0] < h.startMs || r[1] > h.endMs || (r[0] <= h.startMs && r[1] >= h.endMs)) return null;
  return { startMs: r[0], endMs: r[1] };
}


function renderSeekBar(s) {
  const h = s.activityHistogram;
  if (!h || !h.buckets || !h.buckets.length || !(h.endMs > h.startMs)) return '';
  const n = h.buckets.length;
  const bucketMs = (h.endMs - h.startMs) / n;
  const max = Math.max(1, ...h.buckets.map((b) => b.tools));
  const segs = seekSegments(h);
  const range = currentRange(s);
  const units = segs.reduce((acc, seg) => acc + (seg.gap ? 3 : 1), 0);
  const leftOf = {};
  let u = 0;
  for (const seg of segs) {
    if (seg.gap) { for (let k = seg.from; k < seg.to; k++) leftOf[k] = (u + 1.5) / units * 100; u += 3; }
    else { leftOf[seg.i] = (u + 0.5) / units * 100; u += 1; }
  }
  const bucketOf = (ms) => Math.max(0, Math.min(n - 1, Math.floor((ms - h.startMs) / bucketMs)));
  const bars = segs.map((seg) => {
    if (seg.gap) {
      return '<div class="seek-gap" style="flex:3" role="img" aria-label="' + esc(compactDuration((seg.to - seg.from) * bucketMs) + ' idle') + '">' + esc(compactDuration((seg.to - seg.from) * bucketMs)) + '<br>idle</div>';
    }
    const b = h.buckets[seg.i];
    const height = b.tools ? Math.max(8, Math.round(b.tools / max * 100)) : 4;
    const at = Math.round(h.startMs + (seg.i + 0.5) * bucketMs);
    const bad = b.failed + b.blocked;
    const tip = clockTime(at) + ' · ' + b.tools + ' tools' + (b.failed ? ' · ' + b.failed + ' failed' : '') + (b.blocked ? ' · ' + b.blocked + ' blocked' : '');
    const out = range && !inRange(range, at) ? ' out' : '';
    return '<button type="button" class="seek-bar' + (bad ? ' bad' : '') + out + '" style="flex:1" data-seek="' + at + '" title="' + esc(tip) + '" aria-label="' + esc('Jump to ' + tip) + '"><i style="height:' + height + '%"></i></button>';
  }).join('');
  const marks = [];
  // Messages that land in one bucket share one marker (its tooltip lists them all);
  // subagents and the open ask sit on a second row so they never cover a message.
  const youByBucket = {};
  (h.userAtMs || []).forEach((t, k) => { (youByBucket[bucketOf(t)] = youByBucket[bucketOf(t)] || []).push(k + 1); });
  for (const key of Object.keys(youByBucket)) {
    const nums = youByBucket[key];
    const label = nums.length === 1 ? String(nums[0]) : nums[0] + '+';
    marks.push('<span class="seek-mk you" role="img" aria-label="' + esc('Your message' + (nums.length > 1 ? 's ' : ' ') + nums.join(', ')) + '" style="left:' + leftOf[key].toFixed(2) + '%" title="Your message' + (nums.length > 1 ? 's ' : ' ') + esc(nums.join(', ')) + '">' + esc(label) + '</span>');
  }
  const lower = {};
  for (const x of (s.subagents || [])) {
    if (!x.startedAtMs) continue;
    const b = bucketOf(x.startedAtMs);
    (lower[b] = lower[b] || []).push(x.description);
  }
  for (const key of Object.keys(lower)) {
    marks.push('<span class="seek-mk sub low" role="img" aria-label="' + esc('Subagent: ' + lower[key].join('; ')) + '" style="left:' + leftOf[key].toFixed(2) + '%" title="Subagent: ' + esc(lower[key].join('; ')) + '">' + (lower[key].length > 1 ? lower[key].length : 'S') + '</span>');
  }
  if (s.needsYou) marks.push('<span class="seek-mk ask low" role="img" aria-label="Needs you" style="left:' + leftOf[n - 1].toFixed(2) + '%" title="Needs you">!</span>');
  return (
    '<div class="seek" role="group" aria-label="Session activity" data-bucket-ms="' + Math.round(bucketMs) + '">' +
      '<div class="seek-bars">' + bars + '</div>' +
      '<div class="seek-marks">' + marks.join('') + '</div>' +
      '<div class="seek-axis"><span>' + esc(clockTime(h.startMs)) + '</span>' +
        (range
          ? '<button type="button" class="seek-range" data-phase="" title="Show the whole session">' + esc(compactDuration(range.endMs - range.startMs)) + ' selected ×</button>'
          : '<span class="seek-hint">' + esc((s.timeline && s.timeline.tools > 0 ? s.timeline.tools + ' tools · ' : '') + 'drag across to filter') + '</span>') +
        '<span>' + esc(clockTime(h.endMs)) + '</span></div>' +
    '</div>'
  );
}

// Filters swap the default summary for one stream. You and Failed ride the row;
// Agent, Tools and Reasoning are one agents-sessions call per click (cached).
const TIMELINE_FILTERS = [{ id: 'summary', label: 'All' }, { id: 'updates', label: 'Updates' }, { id: 'user', label: 'You' }, { id: 'failed', label: 'Failed' }, { id: 'assistant', label: 'Agent' }, { id: 'tools', label: 'Tools' }, { id: 'thinking', label: 'Reasoning' }, { id: 'files', label: 'Files' }, { id: 'subagents', label: 'Subagents' }, { id: 'checklist', label: 'Checklist' }];
// Chips that show a section of the row in place of the steps; they need no load.
const SECTION_FILTERS = ['updates', 'files', 'subagents', 'checklist'];
function sectionCount(s, id) {
  if (id === 'updates') return (s.updates || []).length;
  if (id === 'files') return (s.files && (s.files.total || (s.files.changes || []).length)) || 0;
  if (id === 'subagents') return (s.subagents || []).length || s.subAgentCount || 0;
  if (id === 'checklist') return (s.todoProgress && s.todoProgress.total) || 0;
  return 0;
}
const filterCache = {};
const pendingFilters = {};
const VERB_FILTERS = ['assistant', 'tools', 'thinking'];

// One loaded list per session and filter. A live session keeps writing, so the list
// remembers the activity stamp it was loaded at and offers a refresh; it never refetches
// on its own. The id can outlive the page (webview state); the payload cannot, so a
// restored heavy filter with no request in this page falls back to Summary.
function filterKey(s, role) {
  return ((s && s.fullSessionId) || '') + ':' + role;
}

function requestTimelineFilter(sessionId, role) {
  const key = (sessionId || '') + ':' + role;
  delete filterCache[key];
  pendingFilters[key] = true;
}

function applyTimelineFilter(msg, snapshot) {
  const key = (msg.sessionId || '') + ':' + msg.role;
  delete pendingFilters[key];
  const current = snapshot && snapshot.fullSessionId === msg.sessionId;
  filterCache[key] = msg.error ? { error: msg.error } : { items: msg.items || [], atStamp: current ? (snapshot.lastActivityMs || 0) : 0 };
  return !!current;
}

function currentFilter(s) {
  const id = (s && s.fullSessionId) || '';
  const f = (viewState.timelineFilter || {})[id];
  if (VERB_FILTERS.indexOf(f) >= 0 && !(s && s.sessionLocal)) return 'summary';
  if (VERB_FILTERS.indexOf(f) >= 0 && !filterCache[id + ':' + f] && !pendingFilters[id + ':' + f]) return 'summary';
  return TIMELINE_FILTERS.some((x) => x.id === f) ? f : 'summary';
}

function renderFilterChips(s, active) {
  if (!s.fullSessionId) return '';
  const counts = { user: (s.userTurns || []).length, failed: (s.failures || []).length, updates: sectionCount(s, 'updates'), files: sectionCount(s, 'files'), subagents: sectionCount(s, 'subagents'), checklist: sectionCount(s, 'checklist') };
  return '<div class="tl-filters">' + TIMELINE_FILTERS.map((f) => {
    if (f.id === 'user' && !s.userTurns) return '';
    if (f.id === 'failed' && !(s.failures && s.failures.length)) return '';
    if (VERB_FILTERS.indexOf(f.id) >= 0 && !s.sessionLocal) return '';
    if (SECTION_FILTERS.indexOf(f.id) >= 0 && !counts[f.id]) return '';
    const count = counts[f.id] ? '<em>' + counts[f.id] + '</em>' : '';
    return '<button type="button" class="tl-filter' + (f.id === active ? ' on' : '') + '" data-filter="' + f.id + '" aria-pressed="' + (f.id === active) + '">' + esc(f.label) + count + '</button>';
  }).join('') + '</div>';
}

function filteredRows(items) {
  if (!items.length) return '<div class="card-note">Nothing here.</div>';
  return items.map((it) => (
    '<div class="tl-item' + (it.bad ? ' bad' : '') + '">' +
      '<div class="tl-item-at">' + esc((it.label ? it.label + ' · ' : '') + (it.atMs ? clockTime(it.atMs) : '')) + '</div>' +
      '<div class="tl-item-text">' + esc(it.text) + '</div>' +
    '</div>'
  )).join('');
}

// The zoomed lane: every loaded tool call in the chosen stretch at its own
// moment (failed ones in red), with your messages above it, so one phase reads
// at the resolution the whole-session strip cannot show.
const LANE_BINS = 200;

function renderRangeLane(s, rows, range) {
  const span = range.endMs - range.startMs;
  if (!(span > 0)) return '';
  const pct = (ms) => Math.max(0, Math.min(100, (ms - range.startMs) / span * 100));
  const left = (ms) => pct(ms).toFixed(2);
  // Calls closer than half a percent of the lane share one tick (red if any
  // failed), so a stretch with thousands of calls stays a few hundred nodes.
  const bins = new Map();
  for (const r of rows) {
    if (!r.atMs) continue;
    const key = Math.min(LANE_BINS - 1, Math.floor(pct(r.atMs) / 100 * LANE_BINS));
    const bin = bins.get(key) || { atMs: r.atMs, n: 0, bad: false, text: r.text };
    bin.n++;
    bin.bad = bin.bad || !!r.bad;
    bins.set(key, bin);
  }
  const ticks = Array.from(bins.values()).map((b) =>
    '<i class="lane-tick' + (b.bad ? ' bad' : '') + '" style="left:' + left(b.atMs) + '%" title="' + esc(clockTime(b.atMs) + ' · ' + (b.n > 1 ? b.n + ' calls' : truncate(b.text, 80))) + '"></i>').join('');
  const turns = (s.userTurns || []).map((t, i) => ({ t: t, n: i + 1 })).filter((x) => inRange(range, x.t.atMs)).map((x) =>
    '<span class="seek-mk you" style="left:' + left(x.t.atMs) + '%" title="' + esc('turn ' + x.n + ' · ' + truncate(x.t.text, 80)) + '">' + x.n + '</span>').join('');
  const count = rows.filter((r) => r.atMs).length;
  return (
    '<div class="range-lane" role="img" aria-label="' + esc(count + ' tool calls in this range') + '">' +
      '<div class="lane-marks">' + turns + '</div>' +
      '<div class="lane-track">' + ticks + '</div>' +
      '<div class="seek-axis"><span>' + esc(clockTime(range.startMs)) + '</span><span>' + esc(count + ' calls') + '</span><span>' + esc(clockTime(range.endMs)) + '</span></div>' +
    '</div>'
  );
}

function renderFilteredBody(s, active) {
  const range = currentRange(s);
  if (active === 'user') {
    return filteredRows((s.userTurns || []).map((t, i) => ({
      atMs: t.atMs,
      label: 'turn ' + (i + 1) + (t.images ? ' · ' + t.images + ' image' + (t.images === 1 ? '' : 's') : ''),
      text: t.text,
    })).filter((it) => inRange(range, it.atMs)));
  }
  if (active === 'failed') {
    return filteredRows((s.failures || []).slice().reverse().map((f) => ({
      atMs: f.atMs, label: f.blocked ? 'blocked' : 'failed', text: f.tool + ': ' + f.summary + ' → ' + f.error, bad: true,
    })).filter((it) => inRange(range, it.atMs)));
  }
  const cached = filterCache[filterKey(s, active)];
  if (!cached) return '<div class="card-note">Loading…</div>';
  if (cached.error) return '<div class="card-note">Could not load: ' + esc(cached.error) + ' <button type="button" class="tl-refresh" data-refresh-filter="' + active + '">Retry</button></div>';
  const stale = (s.lastActivityMs || 0) > (cached.atStamp || 0)
    ? '<div class="card-note">Newer activity since this loaded. <button type="button" class="tl-refresh" data-refresh-filter="' + active + '">Refresh</button></div>'
    : '';
  const rows = cached.items.map((it) => ({ atMs: Date.parse(it.at) || 0, text: it.text, bad: it.bad })).filter((it) => !it.atMs || inRange(range, it.atMs));
  const lane = active === 'tools' && range ? renderRangeLane(s, rows, range) : '';
  return stale + lane + filteredRows(rows.reverse());
}

// One status post (agents feed post): its title, what it says, its links. A
// blocked post reads red.
function renderUpdate(u) {
  return '<div class="upd' + (u.blocked ? ' blocked' : '') + '"><span class="upd-mk"></span><span class="upd-b"><b>' + esc(u.title || (u.blocked ? 'Blocked' : 'Update')) + '</b>' +
    (u.detail ? ' <span class="upd-d">' + esc(truncate(u.detail, 220)) + '</span>' : '') +
    (u.links.length ? '<span class="upd-l">' + u.links.map((l) => '<a class="chip path-link" data-path="' + esc(l.href) + '">' + esc(l.name) + '</a>').join('') + '</span>' : '') +
    '</span><span class="step-at">' + esc(relTime(u.atMs)) + '</span></div>';
}

// The strip and the feed under it, inside the session card (no heading of its
// own): the strip's range filters the feed, and the chips switch what it lists.
function renderTimelineCard(s) {
  // The stream has not established for this session's scope: say so instead of
  // rendering an empty feed that reads as "the agent has done nothing".
  if (s.streamDegraded) {
    return (
      '<div class="feed"><div class="card-note">' +
        '<strong>Waiting for the session stream…</strong><br>' +
        'No row has arrived for ' + esc(s.streamScope || 'this machine') + ' yet. The elected ' +
        'window runs <code>agents feed watch --json</code> while a session view is open, and ' +
        'this panel renders whatever that stream carries. Nothing here is fetched per click.' +
      '</div></div>'
    );
  }
  const t = s.timeline || timelineFromCheckpoints(s);
  if (t && t.state === 'unavailable') {
    return (
      '<div class="feed"><div class="card-note">' +
        '<strong>Timeline unavailable for this harness</strong>' +
        (t.reason ? '<br>' + esc(t.reason) : '') +
      '</div></div>'
    );
  }
  const active = currentFilter(s);
  const range = currentRange(s);
  const strip = renderSeekBar(s);
  // With no strip (an older CLI), the tool count still has a place to live.
  const head = (strip || (t && t.tools > 0 ? '<div class="card-note tl-meta">' + esc(t.tools + ' tools' + (s.lastActivityMs ? ' · last active ' + relTime(s.lastActivityMs) : '')) + '</div>' : '')) + renderFilterChips(s, active) +
    (range && s.sessionLocal && active !== 'tools'
      ? '<div class="tl-range card-note">' + esc(clockTime(range.startMs) + ' to ' + clockTime(range.endMs)) + ' · <button type="button" class="tl-refresh" data-filter="tools">Show tool calls</button></div>'
      : '');
  if (active === 'updates') {
    const ups = (s.updates || []).filter((u) => inRange(range, u.atMs)).slice().reverse();
    return '<div class="feed">' + head + (ups.length ? ups.map(renderUpdate).join('') : '<div class="card-note">No updates in this range.</div>') + '</div>';
  }
  if (active === 'files') return '<div class="feed">' + head + renderFilesCard(s) + '</div>';
  if (active === 'subagents') return '<div class="feed">' + head + renderSpawnedTeamCard(s) + '</div>';
  if (active === 'checklist') return '<div class="feed">' + head + renderChecklistCard(s) + '</div>';
  if (active !== 'summary') return '<div class="feed">' + head + '<div class="tl-filtered">' + renderFilteredBody(s, active) + '</div></div>';
  if (!t) return head ? '<div class="feed">' + head + '</div>' : '';

  const steps = (t.steps || []).slice().reverse();   // newest first
  const visible = steps.filter((step) => !Number.isFinite(Date.parse(step.at)) || inRange(range, Date.parse(step.at)));
  const none = range && !visible.length
    ? '<div class="card-note">No loaded step falls in this range; older steps are folded into the count below.</div>'
    : '';
  // The agent's own status posts sit among its steps, newest first.
  const ups = (s.updates || []).filter((u) => inRange(range, u.atMs)).map((u) => ({ at: u.atMs, html: renderUpdate(u) }));
  const merged = visible.map((step) => ({ at: Date.parse(step.at) || 0, html: renderStep(step) })).concat(ups).sort((a, b) => b.at - a.at);
  const n = timelineShown();
  const shown = none + merged.slice(0, n).map((x) => x.html).join('');
  const rest = merged.slice(n);
  // "N more" stays open across stream updates (it used to fold back on the next row).
  const key = (s.fullSessionId || '') + ':more';
  const more = rest.length
    ? (viewState.feedMore === key
        ? rest.map((x) => x.html).join('') + '<button type="button" class="timeline-more" data-feed-more="">Show less</button>'
        : '<button type="button" class="timeline-more" data-feed-more="' + esc(key) + '">' + rest.length + ' more</button>')
    : '';
  const pick = merged.length > 4
    ? '<label class="steps-n">Show <select data-steps-shown aria-label="Steps shown">' + STEP_CHOICES.map((v) => '<option value="' + v + '"' + (String(viewState.stepsShown || '8') === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>'
    : '';
  const earlierBits = [];
  if (t.earlier.steps > 0) {
    earlierBits.push(t.earlier.steps + ' earlier step' + (t.earlier.steps === 1 ? '' : 's'));
    if (t.earlier.tools > 0) earlierBits.push(t.earlier.tools + ' tools');
    if (t.earlier.failed > 0) earlierBits.push(t.earlier.failed + ' failed');
  }
  const earlier = earlierBits.length ? '<div class="timeline-earlier">▸ ' + esc(earlierBits.join(' · ')) + '</div>' : '';
  const partial = t.state === 'partial' ? '<div class="card-note" style="margin-top:6px">Partial: the transcript was capped this tick.</div>' : '';
  return '<div class="feed">' + head + shown + more + pick + earlier + partial + '</div>';
}

let seekDragged = false;
function bindSeekDrag() {
  const seek = root.querySelector('.seek');
  if (!seek || !bindOnce(seek, 'drag')) return;
  let from = null;
  const barAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.seek-bar') : null; };
  const mark = (a, b) => {
    for (const bar of seek.querySelectorAll('.seek-bar')) {
      const t = Number(bar.getAttribute('data-seek'));
      bar.classList.toggle('sel', t >= Math.min(a, b) && t <= Math.max(a, b));
    }
  };
  seek.addEventListener('pointerdown', (e) => {
    const bar = barAt(e.clientX, e.clientY);
    if (!bar) return;
    from = Number(bar.getAttribute('data-seek'));
    seekDragged = false;
  });
  seek.addEventListener('pointermove', (e) => {
    if (from === null || !(e.buttons & 1)) return;
    const bar = barAt(e.clientX, e.clientY);
    if (!bar) return;
    const to = Number(bar.getAttribute('data-seek'));
    if (to !== from) { seekDragged = true; mark(from, to); }
  });
  seek.addEventListener('pointerup', (e) => {
    if (from === null) return;
    const bar = barAt(e.clientX, e.clientY);
    const to = bar ? Number(bar.getAttribute('data-seek')) : from;
    const start = from;
    from = null;
    if (!seekDragged || to === start) return;
    const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
    const half = Number(seek.getAttribute('data-bucket-ms') || 0) / 2;
    const next = Object.assign({}, viewState.timelineRange);
    next[key] = [Math.round(Math.min(start, to) - half), Math.round(Math.max(start, to) + half)];
    viewState.timelineRange = next;
    vscode.setState(viewState);
    render(lastSnapshot);
  });
}

function bindSessionCards() {
  observeThumbs(root);
  for (const el of root.querySelectorAll('.artifact-open')) {
    if (bindOnce(el, 'open')) el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openArtifact', path: el.getAttribute('data-artifact') });
    });
  }
  for (const el of root.querySelectorAll('[data-filter]')) {
    if (bindOnce(el, 'filter')) el.addEventListener('click', () => {
      const id = el.getAttribute('data-filter');
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      const next = Object.assign({}, viewState.timelineFilter);
      next[key] = id;
      viewState.timelineFilter = next;
      vscode.setState(viewState);
      const cached = filterCache[filterKey(lastSnapshot, id)];
      if (VERB_FILTERS.indexOf(id) >= 0 && (!cached || cached.error)) {
        requestTimelineFilter(key, id);
        vscode.postMessage({ type: 'loadTimelineFilter', role: id, sessionId: key });
      }
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-phase]')) {
    if (bindOnce(el, 'phase')) el.addEventListener('click', () => {
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      const value = el.getAttribute('data-phase');
      const next = Object.assign({}, viewState.timelineRange);
      const parts = value ? value.split('-').map(Number) : null;
      if (!parts) delete next[key];
      else next[key] = parts;
      viewState.timelineRange = next;
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-refresh-filter]')) {
    if (bindOnce(el, 'refresh')) el.addEventListener('click', () => {
      const id = el.getAttribute('data-refresh-filter');
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      requestTimelineFilter(key, id);
      vscode.postMessage({ type: 'loadTimelineFilter', role: id, sessionId: key });
      render(lastSnapshot);
    });
  }
  bindSeekDrag();
  for (const el of root.querySelectorAll('[data-steps-shown]')) {
    if (bindOnce(el, 'steps')) el.addEventListener('change', () => { viewState.stepsShown = el.value; vscode.setState(viewState); render(lastSnapshot); });
  }
  for (const el of root.querySelectorAll('[data-feed-more]')) {
    if (bindOnce(el, 'more')) el.addEventListener('click', () => { viewState.feedMore = el.getAttribute('data-feed-more'); vscode.setState(viewState); render(lastSnapshot); });
  }
  for (const el of root.querySelectorAll('[data-seek]')) {
    if (bindOnce(el, 'seek')) el.addEventListener('click', () => {
      if (seekDragged) { seekDragged = false; return; }
      const at = Number(el.getAttribute('data-seek'));
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      if (currentFilter(lastSnapshot) !== 'summary') {
        const next = Object.assign({}, viewState.timelineFilter);
        next[key] = 'summary';
        viewState.timelineFilter = next;
        vscode.setState(viewState);
        render(lastSnapshot);
      }
      let best = null;
      for (const step of root.querySelectorAll('.step[data-at]')) {
        const t = Number(step.getAttribute('data-at'));
        if (!Number.isFinite(t) || !t) continue;
        if (!best || Math.abs(t - at) < Math.abs(Number(best.getAttribute('data-at')) - at)) best = step;
      }
      if (!best) return;
      const fold = best.closest('details');
      if (fold) fold.open = true;
      best.scrollIntoView({ block: 'center' });
      best.classList.add('flash');
      setTimeout(() => best.classList.remove('flash'), 1200);
    });
  }
  for (const el of root.querySelectorAll('[data-expand]')) {
    if (bindOnce(el, 'expand')) el.addEventListener('click', () => {
      const expanded = el.getAttribute('aria-expanded') === 'true';
      viewState.expandedSteps = viewState.expandedSteps || {};
      const key = el.getAttribute('data-step-key');
      if (expanded) delete viewState.expandedSteps[key];
      else viewState.expandedSteps[key] = true;
      vscode.setState(viewState);
      el.setAttribute('aria-expanded', String(!expanded));
      el.querySelector('.step-txt').textContent = expanded ? el.getAttribute('data-short') : el.getAttribute('data-expand');
    });
  }
  for (const el of root.querySelectorAll('[data-url]:not([data-action])')) {
    if (bindOnce(el, 'url')) el.addEventListener('click', (e) => {
      e.preventDefault();
      // ⌘, Ctrl or ⌥ sends the link to the OS browser; a plain click opens it as an editor tab.
      vscode.postMessage({ type: 'openUrl', url: el.getAttribute('data-url'), external: e.metaKey || e.ctrlKey || e.altKey });
    });
  }
}
`;

// The Made shelf as both panels draw it (the Active Session sidebar under its card,
// the Project panel inside the pinned front card) from one MadeShelf
// (src/core/sessionCardFields.ts). Plain webview JavaScript; it needs esc and
// thumbImg (THUMB_SCRIPT) and relTime.
export const MADE_SCRIPT = `
function inRange(range, ms) {
  return !range || (Number.isFinite(ms) && ms >= range.startMs && ms < range.endMs);
}

// ── Artifacts ───────────────────────────────────────────────────────────────
// Everything the session produced for a person, as the row carries it: the CLI's
// artifact files grouped into folders, its PRs and its ticket. The Made shelf in
// the sidebar draws them; these are the shared pieces (icons, kinds, thumbnails).
const APP_ICON = ${JSON.stringify({ github: serviceMark('github', 'art-icon'), linear: serviceMark('linear', 'art-icon') })};
function artifactItems(s) {
  const files = (s.artifacts || []).slice();
  if (s.plan && !files.some((a) => a.path === s.plan.path)) {
    files.push({ path: s.plan.path, display: s.plan.display, basename: s.plan.display.split('/').pop(), bucket: 'plans' });
  }
  const folders = new Map();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
    let folder = folders.get(dir);
    if (!folder) {
      const cut = f.display.lastIndexOf('/');
      const shown = cut < 0 ? '' : f.display.slice(0, cut);
      folder = { app: 'finder', key: dir, name: dir.split('/').pop() || dir, display: shown, files: [], editedAtMs: 0 };
      folders.set(dir, folder);
    }
    folder.files.push(Object.assign({ name: f.title || f.basename }, f));
    folder.editedAtMs = Math.max(folder.editedAtMs, f.editedAtMs || 0);
  }
  return Array.from(folders.values());
}

const FILE_GLYPH = { md: '¶', markdown: '¶', txt: '¶', html: '‹/›', htm: '‹/›', json: '{ }', csv: '▦', pdf: '▤' };

function artifactKind(f) {
  const base = f.path.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'file';
}

// Wires the timeline and artifact cards rendered into root: their thumbnails,
// filters, phases, seek bar, step folds and links. Reads the surface's own
// root, viewState, vscode, lastSnapshot and render.
// Drag across the strip's bars to choose a range; a click without a drag still
// jumps to that moment. The range is remembered per session.
const PR_SEGMENT_ORDER = { passed: 0, running: 1, failed: 2, skipped: 3 };

// One bar segment per check the row lists, greens first so the bar fills like
// progress; a row with only the rolled-up verdict draws one segment for it.
// passed/counted leave skipped checks out of the fraction.
function prCheckSegments(pr) {
  const items = pr.checkItems || [];
  if (!items.length) {
    const state = pr.checks === 'passing' ? 'passed' : pr.checks === 'failing' ? 'failed' : pr.checks === 'pending' ? 'running' : '';
    return { segments: state ? [{ state: state, name: 'checks ' + pr.checks }] : [], passed: 0, running: 0, failed: 0, counted: 0 };
  }
  const segments = items.map((c, i) => ({ state: c.state, name: c.name, i: i }))
    .sort((a, b) => (PR_SEGMENT_ORDER[a.state] - PR_SEGMENT_ORDER[b.state]) || (a.i - b.i))
    .map((c) => ({ state: c.state, name: c.name }));
  const count = (state) => items.filter((c) => c.state === state).length;
  return { segments: segments, passed: count('passed'), running: count('running'), failed: count('failed'), counted: items.filter((c) => c.state !== 'skipped').length };
}

// ── Made ────────────────────────────────────────────────────────────────────
// What the session made, as one row of previews you scroll sideways (owner,
// 2026-10-12: "artifacts are important; a PR is an artifact, and so is the
// ticket"). The PR tile carries its checks as a bar and a count, and opens the PR
// on GitHub; merging lives in the ⋯ menu (owner video, 2026-10-12: "show how many
// pass here; clicking it takes us to the link"). The ticket is a tile that opens
// the ticket to read. Then every artifact file, newest first; an image previews,
// a page or doc shows its type, and a click opens it in the editor. A chosen
// timeline range dims files changed outside it, without moving anything. Pages,
// docs and images on this machine carry Share.
const SHARE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v4.5h9V8.5"/></svg>';
const SHAREABLE = /^(html?|md|markdown|pdf|png|jpe?g|gif|webp|svg)$/;
const busyArtifacts = new Set();

function prChecksBar(pr) {
  const bar = prCheckSegments(pr);
  const words = bar.counted
    ? bar.passed + ' of ' + bar.counted + ' checks passed' + (bar.running ? ', ' + bar.running + ' running' : '') + (bar.failed ? ', ' + bar.failed + ' failed' : '')
    : pr.checks ? (pr.checks === 'passing' ? 'Checks passed' : pr.checks === 'failing' ? 'A check failed' : 'Checks running') : 'No checks reported';
  const segs = bar.segments.map((c) => '<i class="seg ' + esc(c.state) + '"></i>').join('');
  return '<span class="mk-checks" role="img" title="' + esc(words) + '" aria-label="' + esc(words) + '">' +
    '<span class="pr-bar">' + (segs || '<i class="seg none"></i>') + '</span>' +
    (bar.counted ? '<span class="pr-frac pr-tone-' + (bar.failed ? 'bad' : bar.passed === bar.counted ? 'ok' : 'warn') + '">' + bar.passed + '/' + bar.counted + '</span>' : '') +
  '</span>';
}

// The same as one row of chips that scrolls sideways (owner video, 2026-10-18 8:59 PM: the
// tiles are too big): PRs it opened, tickets it is on or made, its files, then what it touched.
function madeChips(s, pr, others, tickets, files, touched) {
  const chip = (attrs, icon, label, title, tone) => '<button type="button" class="mk-chip' + (tone ? ' ' + tone : '') + '" ' + attrs + ' title="' + esc(title) + '">' + icon + '<span>' + esc(label) + '</span></button>';
  const out = [];
  if (pr) out.push(chip('data-url="' + esc(pr.url) + '"', APP_ICON.github, '#' + pr.number + ' ' + s.prVerdict.word, 'Open #' + pr.number + (pr.title ? ' ' + pr.title : '') + ' on GitHub', 'pr-tone-' + s.prVerdict.tone));
  for (const p of others) out.push(chip('data-url="' + esc(p.url) + '"', APP_ICON.github, p.ownerRepo.split('/').pop() + ' #' + p.number, 'Open ' + p.url));
  for (const t of tickets) out.push(chip('data-ticket="' + esc(t.id) + '"', APP_ICON.linear, t.id, 'Read ' + t.id + (t.title ? ' ' + t.title : '')));
  for (const f of files) {
    const kind = artifactKind(f);
    out.push(chip('data-artifact="' + esc(f.path) + '"', '<span class="mk-cg" aria-hidden="true">' + esc(FILE_GLYPH[kind] || '▢') + '</span>', f.name, 'Open ' + f.path + (f.renderedFrom ? ' (from ' + f.renderedFrom + ')' : ''), 'artifact-open'));
  }
  for (const t of touched) out.push('<button type="button" class="mk-chip mk-tch"' + (t.url ? ' data-url="' + esc(t.url) + '"' : ' data-ticket="' + esc(t.ticket) + '"') + ' title="' + esc(t.title) + '">' + t.icon + '<span>' + esc(t.label) + '</span></button>');
  return '<div class="made chips"><div class="made-l">Made <span>' + (out.length - touched.length) + '</span></div><div class="mk-row" data-strip="made">' + out.join('') + '</div></div>';
}

function renderMadeShelf(s, range) {
  const pr = s.prStatus;
  const others = (s.pullRequests || []).filter((p) => !pr || p.url !== pr.url);
  const files = [];
  for (const it of artifactItems(s)) if (it.files) for (const f of it.files) files.push(f);
  files.sort((a, b) => (b.editedAtMs || 0) - (a.editedAtMs || 0));
  const tk = s.ticket;
  const created = (s.createdTickets || []).filter((t) => !tk || t.id !== tk.id);
  const touched = (s.touchedPrs || []).map((p) => ({ url: p.url, label: (p.action || 'touched') + ' #' + p.number, title: (p.action || 'Touched') + ' ' + (p.repo ? p.repo + '#' : '#') + p.number, icon: APP_ICON.github }))
    .concat((s.touchedTickets || []).map((t) => ({ ticket: t.id, label: (t.action || 'touched') + ' ' + t.id, title: (t.action || 'Touched') + ' ' + t.id, icon: APP_ICON.linear })));
  if (!pr && !others.length && !tk && !created.length && !files.length && !touched.length) return '';
  if (s.chips) return madeChips(s, pr, others, tk ? [tk].concat(created) : created, files, touched);
  const tiles = [];
  if (pr) {
    const v = s.prVerdict;
    tiles.push('<button type="button" class="mk mk-pr" data-url="' + esc(pr.url) + '" title="' + esc('Open #' + pr.number + (pr.title ? ' ' + pr.title : '') + ' on GitHub') + '">' +
      '<span class="mk-h">' + APP_ICON.github + '<b>#' + esc(pr.number) + '</b><span class="mk-st pr-tone-' + v.tone + '">' + esc(v.word) + '</span></span>' +
      '<span class="mk-t">' + esc(pr.title || s.prRepo || '') + '</span>' +
      '<span class="mk-f">' + prChecksBar(pr) + '<span class="mk-go" aria-hidden="true">↗</span></span></button>');
  }
  for (const p of others) {
    tiles.push('<button type="button" class="mk mk-pr" data-url="' + esc(p.url) + '" title="' + esc('Open ' + p.url) + '">' +
      '<span class="mk-h">' + APP_ICON.github + '<b>#' + esc(p.number) + '</b></span><span class="mk-t">' + esc(p.ownerRepo) + '</span>' +
      '<span class="mk-f"><span class="mk-go" aria-hidden="true">↗</span></span></button>');
  }
  for (const t of tk ? [tk].concat(created) : created) {
    tiles.push('<button type="button" class="mk mk-pr mk-tk" data-ticket="' + esc(t.id) + '" title="' + esc('Read ' + t.id + (t.title ? ' ' + t.title : '')) + '">' +
      '<span class="mk-h">' + APP_ICON.linear + '<b>' + esc(t.id) + '</b>' + (t.state ? '<span class="mk-st tk-st">' + esc(t.state) + '</span>' : '') + '</span>' +
      '<span class="mk-t">' + esc(t.title || 'Linear ticket') + '</span>' +
      '<span class="mk-f"><span class="mk-read">Read ›</span></span></button>');
  }
  for (const f of files) {
    const kind = artifactKind(f);
    const out = range && f.editedAtMs && !inRange(range, f.editedAtMs) ? ' out' : '';
    const busy = busyArtifacts.has(f.path) ? ' busy' : '';
    const face = f.uri ? '<span class="mk-img">' + thumbImg(f) + '</span>' : '<span class="mk-doc" aria-hidden="true">' + esc(FILE_GLYPH[kind] || kind.slice(0, 4).toUpperCase()) + '</span>';
    const share = s.sessionLocal && SHAREABLE.test(kind)
      ? '<button type="button" class="mk-share" data-share="' + esc(f.path) + '" title="Share as a Rush artifact" aria-label="' + esc('Share ' + f.name) + '">' + SHARE_ICON + '</button>'
      : '';
    tiles.push('<div class="mk mk-file' + out + busy + '"><button type="button" class="mk-open artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc('Open ' + f.path) + '">' + face +
      '<span class="mk-n">' + esc(f.name) + '</span><span class="mk-m">' + esc(busy ? 'opening…' : kind + (f.renderedFrom ? ' · from ' + f.renderedFrom : '') + (f.editedAtMs ? ' · ' + relTime(f.editedAtMs) : '')) + '</span></button>' + share + '</div>');
  }
  // What it acted on without opening it (merged, reviewed, commented, updated): one
  // compact chip each, after what it made.
  const acted = touched.map((t) => '<button type="button" class="mk-touch"' + (t.url ? ' data-url="' + esc(t.url) + '"' : ' data-ticket="' + esc(t.ticket) + '"') + ' title="' + esc(t.title) + '">' + t.icon + esc(t.label) + '</button>').join('');
  return '<div class="made"><div class="made-l">Made <span>' + tiles.length + '</span></div>' +
    '<div class="made-strip" data-strip="made">' + tiles.join('') + (acted ? '<div class="mk-touched"><span class="made-l">Touched</span>' + acted + '</div>' : '') + '</div></div>';
}

`;

/** The panel faces. A shadow root ignores @font-face, so a surface hosting the
 *  cards in one declares these on its document instead. */
export function sessionPanelFontFaces(fontJost: string, fontInter: string): string {
  return `  @font-face { font-family: 'Jost'; src: url('${fontJost}') format('woff2'); font-weight: 100 900; font-display: swap; }
  @font-face { font-family: 'Inter'; src: url('${fontInter}') format('woff2'); font-weight: 100 900; font-display: swap; }
`;
}

/** The Rush register both sidebars read: the theme tokens, the one outlined card,
 *  and the slow breath of a Waiting dot. The Active Session sidebar's stylesheet
 *  opens with it and the Project panel's inlines it, so a color is set in one place. */
export const RUSH_THEME_CSS = `  /* ── Rush register tokens (rush/DESIGN.md, Day and Altitude) ─────────────
     The ONLY block allowed to hold a color literal; every rule below reads these.
     Dark editor = Altitude (white glass, zinc type), light editor = Day (ivory
     glass, ink type). High-contrast themes keep VS Code's own colors. Gold is the
     one accent: the primary action (--r-gold) and the selected card's rail
     (--r-gold-line). Status stays small: dots, badges, text. */
  body {
    --r-display: 'Jost', Futura, 'Century Gothic', var(--vscode-font-family), sans-serif;
    --r-sans: 'Inter', var(--vscode-font-family), system-ui, sans-serif;
    --r-mono: var(--vscode-editor-font-family, ui-monospace), ui-monospace, monospace;
    --r-text: #FAFAFA;
    --r-text-2: #D4D4D8;
    --r-caption: #A1A1AA;
    --r-faint: #71717A;
    --r-link: #FAFAFA;
    --r-glass: rgba(255, 255, 255, 0.05);
    --r-glass-hover: rgba(255, 255, 255, 0.09);
    --r-glass-strong: rgba(17, 17, 20, 0.94);
    --r-well: rgba(0, 0, 0, 0.35);
    --r-edge: rgba(255, 255, 255, 0.12);
    --r-edge-hi: rgba(255, 255, 255, 0.24);
    --r-sheen: rgba(255, 255, 255, 0.07);
    --r-sky: rgba(86, 104, 150, 0.16);
    --r-horizon: rgba(201, 169, 98, 0.07);
    --r-selected: rgba(250, 250, 250, 0.10);
    --r-selected-edge: rgba(250, 250, 250, 0.55);
    --r-mark: #141418;
    --r-gold: linear-gradient(135deg, #E8CE8C, #D4B872 35%, #C9A962 55%, #A8884A);
    --r-gold-hover: linear-gradient(135deg, #F0D99E, #DCC384 35%, #D4B872 55%, #B39354);
    --r-on-gold: #09090B;
    --r-ok: #86efac;
    --r-wait: #93c5fd;
    --r-wait-tint: rgba(59, 130, 246, 0.16);
    --r-ok-tint: rgba(34, 197, 94, 0.16);
    --r-warn: #fcd34d;
    --r-idle: #facc15;
    --r-warn-tint: rgba(245, 158, 11, 0.14);
    --r-bad: #fca5a5;
    --r-bad-tint: rgba(239, 68, 68, 0.12);
    --r-bar: rgba(255, 255, 255, 0.30);
    --r-bar-hi: rgba(255, 255, 255, 0.62);
    --r-focus: rgba(255, 255, 255, 0.45);
    --r-float: 0 10px 26px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
    --r-gold-line: #D4B872;
    --r-info: #a5b4fc;
    --r-av0: #7c3aed; --r-av1: #0891b2; --r-av2: #c2410c; --r-av3: #15803d; --r-av4: #be185d; --r-av5: #4338ca; --r-on-av: #FFFFFF;
  }
  body.vscode-light {
    --r-text: #141829;
    --r-text-2: #4B4A55;
    --r-caption: #665E52;
    --r-faint: #8A8174;
    --r-link: #141829;
    --r-glass: rgba(251, 248, 242, 0.70);
    --r-glass-hover: rgba(255, 255, 255, 0.92);
    --r-glass-strong: rgba(251, 248, 242, 0.97);
    --r-well: rgba(20, 24, 41, 0.06);
    --r-edge: #DCD2C3;
    --r-edge-hi: #C9BEAD;
    --r-sheen: rgba(255, 255, 255, 0.9);
    --r-sky: rgba(184, 204, 220, 0.30);
    --r-horizon: rgba(232, 206, 140, 0.30);
    --r-selected: rgba(20, 24, 41, 0.07);
    --r-selected-edge: rgba(20, 24, 41, 0.45);
    --r-mark: #FBF8F2;
    --r-on-gold: #141829;
    --r-ok: #15803d;
    --r-wait: #1D5FA8;
    --r-wait-tint: rgba(29, 95, 168, 0.10);
    --r-ok-tint: rgba(22, 163, 74, 0.12);
    --r-warn: #b45309;
    --r-idle: #ca8a04;
    --r-warn-tint: rgba(217, 119, 6, 0.12);
    --r-bad: #b91c1c;
    --r-bad-tint: rgba(220, 38, 38, 0.08);
    --r-bar: rgba(20, 24, 41, 0.24);
    --r-bar-hi: rgba(20, 24, 41, 0.55);
    --r-focus: rgba(20, 24, 41, 0.45);
    --r-float: 0 10px 24px rgba(20, 24, 41, 0.18), 0 2px 6px rgba(20, 24, 41, 0.12);
    --r-gold-line: #A8884A;
    --r-info: #4f46e5;
    --r-av0: #7c3aed; --r-av1: #0e7490; --r-av2: #c2410c; --r-av3: #15803d; --r-av4: #be185d; --r-av5: #4338ca; --r-on-av: #FFFFFF;
  }
  body.vscode-high-contrast, body.vscode-high-contrast-light {
    --r-text: var(--vscode-foreground);
    --r-text-2: var(--vscode-foreground);
    --r-caption: var(--vscode-descriptionForeground);
    --r-faint: var(--vscode-descriptionForeground);
    --r-link: var(--vscode-textLink-foreground);
    --r-glass: transparent;
    --r-glass-hover: var(--vscode-list-hoverBackground);
    --r-glass-strong: var(--vscode-sideBar-background);
    --r-well: var(--vscode-editor-background);
    --r-edge: var(--vscode-contrastBorder, var(--vscode-widget-border));
    --r-edge-hi: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder));
    --r-sheen: transparent;
    --r-sky: transparent;
    --r-horizon: transparent;
    --r-selected: var(--vscode-list-activeSelectionBackground);
    --r-selected-edge: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder));
    --r-mark: var(--vscode-sideBar-background);
    --r-gold: var(--vscode-button-background);
    --r-gold-hover: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    --r-on-gold: var(--vscode-button-foreground);
    --r-ok: var(--vscode-charts-green);
    --r-wait: var(--vscode-charts-blue);
    --r-wait-tint: transparent;
    --r-ok-tint: transparent;
    --r-warn: var(--vscode-charts-yellow);
    --r-idle: var(--vscode-charts-yellow);
    --r-warn-tint: transparent;
    --r-bad: var(--vscode-errorForeground);
    --r-bad-tint: transparent;
    --r-bar: var(--vscode-charts-blue);
    --r-bar-hi: var(--vscode-foreground);
    --r-focus: var(--vscode-focusBorder);
    --r-float: none;
    --r-gold-line: var(--vscode-focusBorder);
    --r-info: var(--vscode-textLink-foreground);
    --r-av0: transparent; --r-av1: transparent; --r-av2: transparent; --r-av3: transparent; --r-av4: transparent; --r-av5: transparent; --r-on-av: var(--vscode-foreground);
  }
  .card {
    border: 1px solid var(--r-edge);
    border-radius: 10px;
    padding: 9px 11px;
    background: var(--r-glass);
    box-shadow: inset 0 1px 0 var(--r-sheen);
  }
  /* The done verdict in an idle session's state slot (verdictChipHtml), the state pill's size. */
  .vchip { display: inline-flex; align-items: center; gap: 4px; flex: none; border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px 0 6px; font-size: 10.5px; line-height: 16px; color: var(--r-caption); white-space: nowrap; }
  .vchip i { width: 6px; height: 6px; border-radius: 50%; display: block; background: var(--r-faint); }
  .vchip.v-ok { color: var(--r-ok); border-color: var(--r-ok); background: var(--r-ok-tint); } .vchip.v-ok i { background: var(--r-ok); }
  .vchip.v-bad { color: var(--r-bad); border-color: var(--r-bad); background: var(--r-bad-tint); } .vchip.v-bad i { background: var(--r-bad); }
  /* A harness logo: its .hx-<key> class (harnessLogoCss) sets the image. */
  .hx { display: inline-block; flex: none; background-position: center; background-size: contain; background-repeat: no-repeat; }
  @keyframes waitbreathe { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
`;

/** The session panel stylesheet: Rush register tokens, cards, timeline, gallery.
 *  Tokens hang off `body` and its VS Code theme class, so a surface that hosts the
 *  cards in a shadow root gives them a `body` element carrying that class. */
/** What a session made (the Made shelf) and the PR checks bar, as both panels draw them. */
export const MADE_CSS = `
  .art-icon { width: 14px; height: 14px; flex: none; }
  /* Made: one row of previews, scrolled sideways. */
  .made { margin: 9px -11px 0; }
  .made-l { padding: 0 11px; font-family: var(--r-display); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--r-caption); }
  .made-l span { letter-spacing: 0; color: var(--r-faint); }
  .made-strip { display: flex; gap: 6px; overflow-x: auto; padding: 5px 11px 6px; scroll-snap-type: x proximity; scrollbar-width: thin;
    -webkit-mask-image: linear-gradient(90deg, var(--r-text) calc(100% - 20px), transparent); mask-image: linear-gradient(90deg, var(--r-text) calc(100% - 20px), transparent); }
  .mk { flex: none; width: 116px; height: 88px; border: 1px solid var(--r-edge); border-radius: 9px; background: var(--r-well); scroll-snap-align: start; position: relative; overflow: hidden; display: flex; flex-direction: column; text-align: left; }
  .mk:hover { border-color: var(--r-edge-hi); }
  .mk.on { border-color: var(--r-selected-edge); }
  .mk.out { opacity: 0.32; }
  .mk-pr { width: 148px; padding: 7px 8px; gap: 4px; }
  .mk-h { display: flex; align-items: center; gap: 5px; font-size: 11px; min-width: 0; }
  .mk-h b { font-family: var(--r-mono); font-size: 11px; white-space: nowrap; }
  .mk-st { margin-left: auto; font-size: 10px; white-space: nowrap; }
  .mk-t { font-size: 11.5px; color: var(--r-text-2); line-height: 1.3; max-height: 2.6em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; flex: none; text-align: left; }
  .mk-f { display: flex; gap: 6px; align-items: center; margin-top: auto; }
  .mk-open { display: flex; flex-direction: column; width: 100%; height: 100%; padding: 0; }
  .mk-img, .mk-doc { display: block; height: 54px; flex: none; border-bottom: 1px solid var(--r-edge); overflow: hidden; }
  .mk-img img { width: 100%; height: 100%; object-fit: cover; }
  .mk-doc { display: grid; place-items: center; font-family: var(--r-mono); font-size: 14px; color: var(--r-caption); }
  .mk-n { display: block; padding: 4px 7px 0; font-size: 11.5px; color: var(--r-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mk-m { display: block; padding: 0 7px; font-size: 10px; color: var(--r-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mk-share { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: var(--r-glass-strong); border: 1px solid var(--r-edge-hi); color: var(--r-text); opacity: 0; cursor: pointer; padding: 0; }
  .mk-share svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .mk-file:hover .mk-share, .mk-file:focus-within .mk-share { opacity: 1; }
  .mk-checks { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; }
  .mk-go, .mk-read { margin-left: auto; flex: none; font-size: 10.5px; color: var(--r-faint); }
  .mk:hover .mk-go, .mk:hover .mk-read { color: var(--r-text); }
  .tk-st { color: var(--r-caption); }
  .mk-file.busy .mk-doc, .mk-file.busy .mk-img { animation: mk-busy 1s ease-in-out infinite alternate; }
  @keyframes mk-busy { to { opacity: 0.35; } }
  .pr-tone-ok { color: var(--r-ok); }
  .pr-tone-warn { color: var(--r-warn); }
  .pr-tone-bad { color: var(--r-bad); }
  .pr-bar { flex: 1; min-width: 0; display: flex; gap: 2px; height: 5px; border-radius: 3px; overflow: hidden; }
  .pr-bar .seg { flex: 1; min-width: 2px; background: var(--r-edge-hi); }
  .pr-bar .seg.passed { background: var(--r-ok); }
  .pr-bar .seg.running { background: var(--r-warn); }
  .pr-bar .seg.failed { background: var(--r-bad); }
  .pr-bar .seg.skipped { background: var(--r-edge); }
  .pr-frac { flex: none; font-family: var(--r-mono); font-size: 10px; font-weight: 600; color: var(--r-caption); }
  .mk-touched { flex: none; display: flex; align-items: center; gap: 4px; padding-left: 4px; }
  .mk-touched .made-l { padding: 0 2px 0 0; }
  .mk-touch { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border: 1px solid var(--r-edge); border-radius: 999px; background: transparent; color: var(--r-text-2); font: inherit; font-size: 10.5px; white-space: nowrap; cursor: pointer; }
  .mk-touch:hover { border-color: var(--r-edge-hi); color: var(--r-text); }
  .mk-touch .art-icon { width: 11px; height: 11px; }
  /* Made as chips (Settings › What it made): one row, the cards' chip shape, scrolled sideways. */
  .made.chips { display: flex; align-items: center; gap: 6px; margin: 9px 0 0; min-width: 0; }
  .made.chips .made-l { padding: 0; flex: none; }
  .mk-row { flex: 1; min-width: 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .mk-row::-webkit-scrollbar { display: none; }
  .mk-chip { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 20px; max-width: 180px; padding: 0 6px 0 5px; border: 1px solid var(--r-edge); border-radius: 5px; background: transparent; color: var(--r-text-2); font-family: var(--r-mono); font-size: 10.5px; white-space: nowrap; cursor: pointer; }
  .mk-chip:hover { border-color: var(--r-edge-hi); color: var(--r-text); }
  .mk-chip span { overflow: hidden; text-overflow: ellipsis; }
  .mk-chip .art-icon { width: 11px; height: 11px; }
  .mk-cg { font-size: 9.5px; color: var(--r-faint); flex: none; }
  .mk-tch { border-style: dashed; }
  @media (prefers-reduced-motion: reduce) { .mk-file.busy .mk-doc, .mk-file.busy .mk-img { animation: none; } }`;

export function sessionPanelCss(fontFaces: string): string {
  return `${fontFaces}${RUSH_THEME_CSS}  :root {
    color-scheme: light dark;
  }
  /* Pin the whole webview canvas to the sidebar background so short content
     never leaves a mismatched void under light/custom themes (PHNX-3809). The
     root element's background paints the entire viewport canvas; body repeats
     it and stretches to full height so the padded area is themed too. */
  html {
    background: var(--vscode-sideBar-background);
  }
  body {
    font-family: var(--r-sans);
    font-size: 12px;
    color: var(--r-text);
    background: var(--vscode-sideBar-background);
    /* The sky over the theme's own ground: a cool wash at the top, a warm
       horizon at the bottom. Glass cards sit on it; nothing paints a flat panel. */
    background-image:
      radial-gradient(130% 55% at 72% 0%, var(--r-sky), transparent 70%),
      radial-gradient(110% 45% at 60% 100%, var(--r-horizon), transparent 70%);
    background-attachment: fixed;
    padding: 0 12px 16px;
    margin: 0;
    min-height: 100vh;
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
  }
  /* Section labels: Jost capitals at 500, tracked out (the label stop). */
  h2 {
    font-family: var(--r-display);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--r-caption);
    font-weight: 500;
    margin: 18px 0 7px;
  }
  .empty {
    color: var(--r-caption);
    padding: 24px 4px;
    font-style: italic;
  }
  .card { margin-top: 4px; }
  .agent-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-logo {
    width: 16px;
    height: 16px;
    border-radius: 4px;
  }
  .agent-head-text { flex: 1; min-width: 0; }
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
  }
  .session-chunk {
    font-family: var(--r-mono);
    color: var(--r-caption);
    font-size: 11px;
    font-weight: 400;
  }
  .account-row {
    margin-top: 3px;
    color: var(--r-caption);
    font-size: 11px;
  }
  .dirty-pill {
    background: var(--r-warn-tint);
    color: var(--r-text);
    padding: 0 5px;
    border-radius: 8px;
    font-size: 10px;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
  }
  .dirty-pill:hover { filter: brightness(1.15); }
  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--r-ok);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .path-link {
    color: var(--r-link);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--r-mono);
    font-size: 11px;
  }
  .path-link:hover { text-decoration: underline; }
  .conv-topic {
    color: var(--r-text);
    line-height: 1.4;
    word-break: break-word;
  }
  .conv-topic p { margin: 0 0 6px; }
  .conv-topic p:last-child { margin-bottom: 0; }
  .conv-topic .md-heading {
    font-weight: 600;
    margin: 0 0 5px;
  }
  .conv-topic code {
    font-family: var(--r-mono);
    font-size: 0.94em;
    background: var(--r-well);
    border-radius: 3px;
    padding: 0 3px;
  }
  .conv-topic .md-bullet {
    padding-left: 10px;
    text-indent: -8px;
  }
  .requester { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--r-caption); font-size: 11px; }
  .avatar {
    position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none;
    border-radius: 50%; overflow: hidden; font-size: 10px; font-weight: 600;
    background: var(--r-selected); color: var(--r-text);
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .caret { width: 10px; flex: none; color: var(--r-caption); font-size: 9px; }
  /* Gallery: the newest preview full width, the rest as 2-up tiles, then
     files with no preview as compact tiles marked by their type. */
  .mk:focus-visible, .mk-open:focus-visible { outline: 1px solid var(--r-focus); outline-offset: 1px; }
  .team-summary { display: flex; align-items: center; gap: 8px; }
  .team-summary-name { color: var(--r-text); font-weight: 600; }
  .team-summary-count { margin-left: auto; color: var(--r-caption); font-size: 11px; }
  .activity {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  /* ◈ Goal (PHNX-3939) — teal accent label {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .goal-mk {
    flex-shrink: 0;
    color: var(--r-text-2);
    font-size: 12px;
  }
  .goal-txt {
    color: var(--r-text);
    font-weight: 600;
    line-height: 1.45;
    word-break: break-word;
  }
  /* Always-on checklist empty/summarizing state. */
  .todo-empty {
    color: var(--r-caption);
    font-size: 11.5px;
    font-style: italic;
  }
  /* ── Request card (PHNX-3939 follow-up) ────────────────────────────────
     The user's own sentence leads, bold; attachments and pasted terminal become
     chips; the full turn folds away. Nothing here is a rewrite. */
  .request-headline {
    color: var(--r-text);
    font-weight: 600;
    line-height: 1.45;
    word-break: break-word;
  }
  .request-command {
    font-family: var(--r-mono);
    font-weight: 600;
  }
  .request-continues {
    color: var(--r-caption);
    font-weight: 400;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }
  .chip {
    border: 1px solid var(--r-edge);
    border-radius: 9px;
    padding: 1px 6px;
    color: var(--r-caption);
    font-size: 10px;
  }
  .chip.mono { font-family: var(--r-mono); }
  .request-first {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--r-edge);
  }
  .request-first-label {
    color: var(--r-caption);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  /* ── Timeline card ─────────────────────────────────────────────────────
     One row per folded step, newest first. The live step gets the amber
     now-line; a 'user' step is a hollow dot with quoted text; a 'derived' step
     (a harness that wrote no narration) renders muted so it never reads as
     something the agent said. */
  .step {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 2px 8px;
    padding: 4px 0;
    font-size: 13px;
    line-height: 1.45;
  }
  .steps-n { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; color: var(--r-caption); margin: 4px 0; }
  .steps-n select { font: inherit; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--r-edge); border-radius: 4px; }
  .step-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-top: 4px;
    background: var(--r-caption);
  }
  .step.live .step-mk { background: var(--r-warn); }
  .step.src-user .step-mk {
    background: transparent;
    border: 1px solid var(--r-caption);
  }
  .step-txt { color: var(--r-text); word-break: break-word; }
  .step.src-user .step-txt { color: var(--r-caption); font-style: italic; }
  .step.src-derived .step-txt { color: var(--r-caption); }
  .step-at {
    color: var(--r-caption);
    font-size: 10.5px;
    white-space: nowrap;
  }
  .step.live .step-at { color: var(--r-warn); font-weight: 600; }
  .step-now {
    grid-column: 2 / span 2;
    color: var(--r-warn);
    font-size: 10.5px;
    word-break: break-word;
  }
  .step-chips {
    grid-column: 2 / span 2;
    color: var(--r-caption);
    font-size: 10px;
  }
  .step-chips .bad { color: var(--r-bad); }
  .step-chips .mark { color: var(--r-ok); }
  .timeline-more, .timeline-earlier {
    color: var(--r-link);
    font-size: 10.5px;
    cursor: pointer;
    list-style: none;
    padding-top: 4px;
  }
  .timeline-more::-webkit-details-marker, .timeline-earlier::-webkit-details-marker { display: none; }
  .timeline-earlier { cursor: default; color: var(--r-caption); }
  h2 .head-meta {
    font-family: var(--r-sans);
    float: right;
    color: var(--r-caption);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: 10.5px;
  }
  .card-note {
    color: var(--r-caption);
    font-size: 11px;
    line-height: 1.45;
  }
  .card-note strong { color: var(--r-text); }
  .card-note code {
    font-family: var(--r-mono);
    background: var(--r-well);
    border-radius: 3px;
    padding: 0 3px;
  }
  /* ── Files card ────────────────────────────────────────────────────────── */
  .file-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 2px 0;
    font-size: 11.5px;
  }
  .file-op {
    font-family: var(--r-mono);
    flex-shrink: 0;
    width: 8px;
  }
  .file-op.created { color: var(--r-ok); }
  .file-op.modified { color: var(--r-link); }
  .file-op.deleted { color: var(--r-bad); }
  .file-row .path-link {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  /* ── Reply field ───────────────────────────────────────────────────────── */
${REPLY_BOX_CSS}
  /* The reply box stays at the bottom of the sidebar, whatever the card's length
     (owner video, 2026-10-17); a short card leaves room above it instead. */
  #panel-body { min-height: calc(100vh - 128px); }
  .reply-box { position: sticky; bottom: 0; z-index: 2; margin-top: 14px; padding: 8px 0 10px; background: var(--vscode-sideBar-background); }
  /* Header actions — Focus / Resume. */
  .head-actions {
    display: flex;
    gap: 5px;
    margin-left: auto;
    align-self: flex-start;
  }
  .head-btn {
    background: transparent;
    color: var(--r-text);
    border: 1px solid var(--r-edge);
    border-radius: 9px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 18px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .head-btn:hover {
    background: var(--r-glass-hover);
  }
  /* Demoted, collapsible Request. */
  .request-details > summary {
    list-style: none;
    cursor: pointer;
  }
  .request-details > summary::-webkit-details-marker { display: none; }
  .request-details > summary h2 { display: inline; }
  .request-details > summary::before {
    content: '▸';
    color: var(--r-caption);
    font-size: 10px;
    margin-right: 4px;
  }
  .request-details[open] > summary::before { content: '▾'; }
  h2 .todo-frac {
    color: var(--r-caption);
    font-weight: 600;
    font-size: 11px;
  }
  .todo-track {
    height: 3px;
    border-radius: 2px;
    background: var(--r-edge);
    overflow: hidden;
    margin-bottom: 6px;
  }
  .todo-track > i {
    display: block;
    height: 100%;
    background: var(--r-text-2);
  }
  .todo {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 1px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .todo-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
    background: var(--r-caption);
  }
  .todo.status-in_progress .todo-mk { background: var(--r-warn); }
  .todo.status-completed .todo-mk { background: var(--r-ok); }
  .todo.status-completed .todo-txt { text-decoration: line-through; color: var(--r-caption); }
  .todo-txt { color: var(--r-text); word-break: break-word; }
  .action-btn {
    flex: 1 1 auto;
    background: var(--r-glass);
    color: var(--r-text);
    border: 1px solid var(--r-edge-hi);
    border-radius: 999px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: center;
  }
  .action-btn:hover {
    background: var(--r-glass-hover);
  }
  .action-btn.primary {
    background: var(--r-gold);
    color: var(--r-on-gold);
    border-color: transparent;
    font-weight: 600;
  }
  .action-btn.primary:hover {
    background: var(--r-gold-hover);
  }
  .action-btn.slash {
    flex: none;
    font-family: var(--r-mono);
    font-size: 11.5px;
    padding: 5px 8px;
    text-align: left;
  }
  .usage-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .usage-badge.usage-out {
    background: var(--r-bad-tint);
    color: var(--r-bad);
    border: 1px solid var(--r-bad);
  }
  .usage-badge.usage-rate {
    background: var(--r-warn-tint);
    color: var(--r-warn);
    border: 1px solid var(--r-warn);
  }

  .worktree {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 11.5px;
  }
  .err {
    color: var(--r-bad);
    font-size: 11px;
    margin-top: 4px;
  }
  .footer {
    margin-top: 16px;
    color: var(--r-caption);
    font-size: 10.5px;
    text-align: right;
  }
  .footer button {
    background: none;
    border: none;
    color: var(--r-link);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .footer button:hover { text-decoration: underline; }
  button.path-link, button.step, button.session-chunk,
  button.mk, button.mk-open, button.seek-range, button.timeline-more {
    background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  button.path-link { color: var(--r-link); padding: 0; }
  button.step { width: 100%; }
  /* Header: title line, then model · account · host; the ⋯ menu opens a drawer
     inside the card (no overlay, so nothing floats over the session). */
  .head-row { position: relative; }
  .title-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .title-line .session-title { flex: 1; min-width: 0; }
  .head-menu > summary { list-style: none; position: absolute; top: 8px; right: 10px; }
  .head-menu > summary::-webkit-details-marker { display: none; }
  .head-menu[open] > summary { background: var(--r-selected); border-color: var(--r-selected-edge); }
  .head-row .head-actions { margin-right: 26px; }
  .menu-panel { display: none; }
  .head-menu[open] .menu-panel { display: block; margin: 9px 0 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--r-glass-strong); }
  .menu-row { display: grid; grid-template-columns: 64px 1fr; gap: 8px; align-items: center; padding: 3px 0; font-size: 11.5px; }
  .menu-k { color: var(--r-caption); }
  .menu-v { color: var(--r-text); min-width: 0; overflow-wrap: anywhere; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .menu-v .where-row { margin: 0; }
  .session-details { font-family: var(--r-mono); font-size: 10.5px; color: var(--r-caption); overflow-wrap: anywhere; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--r-edge); }
  .session-stats b { color: var(--r-text); font-weight: 600; }
  .state-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--r-caption); }
  .state-running .state-dot { background: var(--r-ok); box-shadow: 0 0 0 3px var(--r-ok-tint); }
  .state-move .state-dot { background: var(--r-warn); box-shadow: 0 0 0 3px var(--r-warn-tint); }
  .state-review .state-dot { background: var(--r-info); }
  .state-failed .state-dot { background: var(--r-bad); }
  /* Waiting on its own background work: a blue dot that breathes slowly. */
  .state-waiting .state-dot { background: var(--r-wait); box-shadow: 0 0 0 3px var(--r-wait-tint); animation: waitbreathe 2.2s ease-in-out infinite; }
  .session-stats.state-waiting { color: var(--r-wait); }
  .pend-list { margin: 8px 0 2px; border-radius: 10px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--r-wait) 40%, transparent); background: var(--r-wait-tint); }
  .pend-k { font-family: var(--r-display); font-size: 10px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; color: var(--r-wait); }
  .pend-list ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: 12px; }
  .pend-list li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 6px; align-items: baseline; }
  .pend-m { color: var(--r-wait); } .pend-d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pend-t { font-family: var(--r-mono); font-size: 10.5px; color: var(--r-caption); }
  @media (prefers-reduced-motion: reduce) { .state-waiting .state-dot { animation: none; } }
  .session-stats.live .state-dot { animation: livedot 2s ease-out infinite; }
  @keyframes livedot { 0% { box-shadow: 0 0 0 0 var(--r-ok); } 100% { box-shadow: 0 0 0 6px transparent; } }
  @media (prefers-reduced-motion: reduce) { .session-stats.live .state-dot { animation: none; } }
  /* Timeline phases: the strip dims outside the chosen stretch. */
  .seek-bar.out i { opacity: 0.22; }
  .tl-range { margin: -2px 0 8px; }
  .sub-label { margin: 7px 0 2px 13px; font-family: var(--r-display); font-size: 9.5px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: var(--r-caption); }
  .sub-asked { margin: 0 0 0 13px; padding: 6px 8px; border-radius: 8px; background: var(--r-well); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  /* Zoomed lane for one phase: a tick per tool call. */
  .range-lane { margin: 2px 0 10px; }
  .lane-marks { position: relative; height: 15px; }
  .lane-track { position: relative; height: 26px; border-bottom: 1px solid var(--r-edge); }
  .lane-tick { position: absolute; bottom: 0; width: 2px; height: 18px; margin-left: -1px; border-radius: 1px; background: var(--r-bar-hi); }
  .lane-tick.bad { background: var(--r-bad); height: 24px; }
  /* Pull request: one status word, a segmented check bar with its count, and
     the review and merge glyphs in the ⋯ menu. */
  .pr-glyph { flex: none; width: 16px; height: 16px; color: var(--r-faint); }
  .pr-glyph svg { width: 16px; height: 16px; display: block; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .pr-glyph.ok { color: var(--r-ok); }
  .pr-glyph.bad { color: var(--r-bad); }
  .pr-glyph .badge { stroke-width: 1.8; }
  .menu-pr { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .menu-pr .action-btn { padding: 2px 8px; }
  .menu-note { flex-basis: 100%; color: var(--r-caption); font-size: 11px; }
  /* Files as a tree. */
  .files-card { position: relative; }
  .ft-toggle { display: flex; justify-content: flex-end; gap: 2px; margin: -2px 0 4px; }
  .ft-toggle button { font: inherit; font-size: 10.5px; padding: 0 8px; line-height: 17px; border-radius: 999px; cursor: pointer; border: 1px solid transparent; background: transparent; color: var(--r-caption); }
  .ft-toggle button[aria-pressed="true"] { color: var(--r-text); background: var(--r-selected); border-color: var(--r-selected-edge); }
  .ft-dir > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 4px; padding-top: 3px; padding-bottom: 3px; font-size: 11.5px; }
  .ft-dir > summary::-webkit-details-marker { display: none; }
  .ft-dir > summary .caret::before { content: '▸'; }
  .ft-dir[open] > summary .caret::before { content: '▾'; }
  .ft-name { font-weight: 600; color: var(--r-text-2); overflow-wrap: anywhere; }
  .ft-count { margin-left: auto; color: var(--r-caption); font-family: var(--r-mono); font-size: 10px; }
  /* Subagent rows: what, how long, how much, before you open one. */
  .subagent > summary { align-items: flex-start; }
  .sub-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sub-body .sub-meta { margin: 0; }
  .subagent .sub-dot { margin-top: 4px; }
  button:focus-visible, summary:focus-visible { outline: 1px solid var(--r-focus); }
  /* Links are the text color, underlined (no blue): the underline is what marks them. */
  .path-link, button.path-link, .footer button, .tl-refresh, .timeline-more, .failures-show {
    text-decoration: underline; text-decoration-color: var(--r-edge-hi); text-underline-offset: 2px;
  }
  .path-link:hover, button.path-link:hover, .footer button:hover, .tl-refresh:hover, .timeline-more:hover {
    text-decoration-color: currentColor;
  }
  /* Glance header (v3): title, model, id, where it runs. */
  .session-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .model-name { font-weight: 600; color: var(--r-text); }
  .head-btn.small { width: 16px; height: 16px; font-size: 10px; }
  .where-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .where-chip { font-size: 10.5px; padding: 0 8px; border-radius: 999px; line-height: 17px; border: 1px solid var(--r-edge); color: var(--r-text-2); background: var(--r-glass); white-space: nowrap; }
  .where-chip.proj { font-weight: 600; color: var(--r-text); }
  .where-chip.mono { font-family: var(--r-mono); font-size: 10px; cursor: pointer; }
  .where-chip.wt { border-style: dashed; }
  .needs-you { margin: 8px 0 2px; border-radius: 10px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--r-warn) 55%, transparent); background: var(--r-warn-tint); box-shadow: inset 0 1px 0 var(--r-sheen); }
  .needs-you-k { font-family: var(--r-display); font-size: 10px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; color: var(--r-warn); }
  .needs-you-t { font-size: 12.5px; margin-top: 3px; line-height: 1.4; }
  .needs-you-btns { display: flex; gap: 6px; margin-top: 7px; }
  .ny-btn { font-size: 11px; padding: 3px 11px; border-radius: 999px; cursor: pointer; border: 1px solid var(--r-edge); background: var(--r-glass); color: var(--r-text); }
  .ny-btn.primary { background: var(--r-gold); color: var(--r-on-gold); border-color: transparent; font-weight: 600; }
  .session-stats { display: flex; align-items: center; gap: 6px; margin: 8px 2px 0; font-size: 11.5px; color: var(--r-caption); }
  .failures { margin-top: 4px; font-size: 11.5px; }
  .failures > summary { cursor: pointer; list-style: none; color: var(--r-warn); }
  .failures > summary::-webkit-details-marker { display: none; }
  .failures-show { color: var(--r-link); margin-left: 4px; }
  .failures[open] .failures-show { display: none; }
  .fail-list { margin-top: 6px; border-radius: 6px; padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--r-bad) 35%, transparent); background: color-mix(in srgb, var(--r-bad) 7%, transparent); }
  .fail-row { display: grid; grid-template-columns: auto 1fr; gap: 8px; padding: 4px 0; border-top: 1px solid color-mix(in srgb, var(--r-bad) 18%, transparent); }
  .fail-row:first-child { border-top: 0; }
  .fail-at { font-size: 10px; color: var(--r-caption); white-space: nowrap; padding-top: 1px; }
  .fail-cmd { font-family: var(--r-mono); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fail-err { font-size: 10.5px; color: var(--r-bad); }
  .fail-blocked > summary { cursor: pointer; font-size: 10.5px; color: var(--r-caption); padding: 4px 0; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
  .thumb { position: relative; padding: 0; border: 1px solid var(--r-edge); border-radius: 6px; overflow: hidden; width: 96px; height: 54px; background: var(--r-well); cursor: pointer; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: left top; display: block; }
  .thumb-n { position: absolute; right: 3px; bottom: 3px; font-family: var(--r-mono); font-size: 9px; padding: 0 4px; border-radius: 3px; background: var(--r-glass-strong); color: var(--r-text); border: 1px solid var(--r-edge); }
  .seek { margin: 2px 0 8px; }
  .seek-bars { display: flex; align-items: flex-end; gap: 2px; height: 34px; border-bottom: 1px solid var(--r-edge); }
  .seek-bar { height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; display: flex; align-items: flex-end; min-width: 3px; }
  .seek-bar i { display: block; width: 100%; background: var(--r-bar); border-radius: 1.5px 1.5px 0 0; }
  .seek-bar.bad i { box-shadow: inset 0 -3px 0 var(--r-bad); }
  .seek-bar:hover i { background: var(--r-bar-hi); }
  .seek-gap { align-self: stretch; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 8.5px; line-height: 1.1; color: var(--r-caption); border-left: 1px dashed var(--r-edge); border-right: 1px dashed var(--r-edge); }
  .seek-marks { position: relative; height: 27px; }
  .seek-mk.low { top: 15px; }
  .seek-mk { position: absolute; top: 2px; transform: translateX(-50%); box-sizing: border-box; width: 12px; height: 12px; border-radius: 50%; font-family: var(--r-mono); font-size: 7.5px; font-weight: 700; line-height: 10px; text-align: center; color: var(--r-text); background: var(--r-mark); border: 1px solid var(--r-text-2); }
  .seek-mk.sub { border-color: var(--r-caption); color: var(--r-text-2); border-radius: 2px; }
  .seek-mk.ask { border-color: var(--r-warn); color: var(--r-warn); }
  .seek-axis { display: flex; justify-content: space-between; font-family: var(--r-mono); font-size: 9.5px; color: var(--r-caption); }
  .tl-filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 8px; }
  .tl-filter { font-size: 11px; padding: 1px 10px; line-height: 18px; border-radius: 999px; cursor: pointer; border: 1px solid var(--r-edge); background: transparent; color: var(--r-text); }
  .tl-filter.on { background: var(--r-selected); color: var(--r-text); border-color: var(--r-selected-edge); font-weight: 600; }
  .tl-filter em { font-style: normal; opacity: .7; margin-left: 4px; }
  .tl-refresh { background: none; border: 0; padding: 0; color: var(--r-link); cursor: pointer; font-size: inherit; }
  .tl-item { padding: 7px 10px; margin-bottom: 6px; border-radius: 10px; border: 1px solid var(--r-edge); background: var(--r-glass); box-shadow: inset 0 1px 0 var(--r-sheen); }
  .tl-item.bad { background: var(--r-bad-tint); }
  .tl-item-at { font-family: var(--r-mono); font-size: 10px; color: var(--r-caption); }
  .tl-item-text { font-size: 12px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .step.flash { outline: 2px solid var(--r-focus); border-radius: 4px; }
  .subagent { border-radius: 10px; padding: 7px 10px; margin-bottom: 6px; border: 1px solid var(--r-edge); background: var(--r-glass); box-shadow: inset 0 1px 0 var(--r-sheen); }
  .subagent > summary { cursor: pointer; list-style: none; display: flex; gap: 6px; font-size: 12px; }
  .subagent > summary::-webkit-details-marker { display: none; }
  .sub-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--r-ok); }
  .subagent.status-running .sub-dot { background: var(--r-warn); box-shadow: 0 0 0 3px var(--r-warn-tint); }
  .subagent.status-failed .sub-dot { background: var(--r-bad); }
  .sub-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub-status { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--r-caption); }
  .sub-meta { font-size: 10.5px; color: var(--r-caption); margin: 3px 0 0 13px; }
  .sub-result { font-size: 11.5px; margin: 4px 0 0 13px; padding-left: 7px; border-left: 2px solid var(--r-edge); }
  .sub-open { font-size: 11px; margin: 4px 0 0 13px; background: none; border: 0; padding: 0; color: var(--r-link); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  /* ── One session card (owner, 2026-10-12) ─────────────────────────────────
     Title with quick icons, the state, goal, ask and request, the Made shelf,
     then the strip and the feed it filters. Sections inside the card are
     separated by hairlines, not nested cards. */
  .session-card { padding: 9px 11px 8px; }
  .session-card .card { border: 0; background: none; box-shadow: none; padding: 0; margin: 0; }
  .head-btn { width: 24px; height: 24px; border-radius: 6px; border-color: transparent; display: inline-grid; place-items: center; color: var(--r-caption); }
  .head-btn svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .head-btn:hover { color: var(--r-text); }
  .head-menu > summary.head-btn { top: 0; right: 0; width: 24px; height: 24px; line-height: 22px; font-size: 13px; }
  .session-stats { margin: 5px 0 0; }
  .stats-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-stats.state-move { color: var(--r-warn); }
  .session-stats.state-move .stats-text::first-line { font-weight: 600; }
  /* A Running session gone quiet: revealed by its own delay, no timer. */
  .idle-warn { display: flex; align-items: center; gap: 6px; margin: 6px -11px 0; padding: 0 11px; max-height: 0; overflow: hidden; opacity: 0; font-size: 11.5px; color: var(--r-warn); background: var(--r-warn-tint);
    animation: idle-reveal 0s linear var(--idle-delay, 0ms) forwards, idle-pulse 2.4s ease-in-out var(--idle-delay, 0ms) infinite; }
  .idle-warn svg { width: 13px; height: 13px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.6; }
  .idle-open { margin-left: auto; background: none; border: 0; color: var(--r-text); text-decoration: underline; cursor: pointer; font: inherit; }
  @keyframes idle-reveal { to { max-height: 40px; opacity: 1; padding-top: 5px; padding-bottom: 5px; } }
  @keyframes idle-pulse { 50% { background: transparent; } }
  @media (prefers-reduced-motion: reduce) { .idle-warn { animation: idle-reveal 0s linear var(--idle-delay, 0ms) forwards; } }
  .goal-line { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--r-text-2); min-width: 0; }
  .goal-line .goal-txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .request-block { margin-top: 9px; }
  .request-block .request-headline { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
${MADE_CSS}
  /* Back and forward through the sessions this panel showed. */
  .nav-row { display: flex; align-items: center; gap: 2px; margin: 0 2px 6px; min-width: 0; }
  .nav-btn { width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent; color: var(--r-text-2); font-size: 17px; line-height: 1; cursor: pointer; padding: 0; flex: none; }
  .nav-btn:hover:not([disabled]) { background: var(--r-well); color: var(--r-text); }
  .nav-btn[disabled] { opacity: 0.3; cursor: default; }
  .nav-crumb { border: 0; background: transparent; color: var(--r-caption); font: inherit; font-size: 11.5px; cursor: pointer; padding: 2px 4px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nav-crumb:hover { color: var(--r-text); text-decoration: underline; }
  /* The agent's own status posts and its blocked strip. */
  /* The agent's own posts stand out in the feed: gold, with a faint gold ground. */
  .upd { display: grid; grid-template-columns: 10px 1fr auto; gap: 6px; padding: 5px 4px; margin: 0 -4px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, var(--r-gold-line) 9%, transparent); }
  .upd-mk { width: 7px; height: 7px; margin-top: 5px; border-radius: 2px; background: var(--r-gold-line); }
  .upd.blocked { background: var(--r-bad-tint); }
  .latest-upd { margin: 8px 0 2px; padding: 7px 9px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--r-gold-line) 55%, transparent); background: color-mix(in srgb, var(--r-gold-line) 9%, transparent); }
  .latest-k { font-family: var(--r-display); font-size: 10px; letter-spacing: 0.18em; color: var(--r-gold-line); }
  .latest-t { margin-top: 3px; font-size: 12.5px; font-weight: 600; line-height: 1.4; }
  .latest-d { margin-top: 2px; font-size: 12px; color: var(--r-text-2); line-height: 1.4; }
  .upd.blocked .upd-mk { background: var(--r-bad); }
  .upd b { font-weight: 600; } .upd.blocked b { color: var(--r-bad); }
  .upd-d { color: var(--r-caption); }
  .upd-l { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .blocked-strip { margin: 8px -11px 2px; padding: 8px 11px; background: var(--r-bad-tint); border-top: 1px solid var(--r-bad); border-bottom: 1px solid var(--r-bad); }
  .blocked-k { font-family: var(--r-mono); font-size: 10px; letter-spacing: 0.08em; color: var(--r-bad); }
  .blocked-t { margin-top: 3px; font-weight: 600; }
  .blocked-d { margin-top: 2px; font-size: 11.5px; color: var(--r-text-2); }
  /* Related: one line of chips. */
  .rel { display: flex; align-items: center; gap: 7px; margin: 2px 0 0; min-width: 0; }
  .rel-l { flex: none; font-family: var(--r-display); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--r-caption); }
  .rel-s { display: flex; gap: 5px; overflow-x: auto; min-width: 0; scrollbar-width: none;
    -webkit-mask-image: linear-gradient(90deg, var(--r-text) calc(100% - 16px), transparent); mask-image: linear-gradient(90deg, var(--r-text) calc(100% - 16px), transparent); }
  button.rel-c { flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 200px; padding: 1px 8px; border: 1px solid var(--r-edge); border-radius: 999px; background: transparent; color: var(--r-text-2); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button.rel-c:hover { border-color: var(--r-edge-hi); color: var(--r-text); }
  .rel-c .state-dot { width: 6px; height: 6px; }
  /* The strip and the feed it filters. */
  .feed { margin: 8px -11px 0; padding: 8px 11px 0; border-top: 1px solid var(--r-edge); }
  .feed h2 { display: none; }
  .feed .seek { margin-bottom: 6px; }
  .seek-bar.sel i { background: var(--r-bar-hi); }
  .seek-hint { font-family: var(--r-sans); color: var(--r-faint); }
  button.seek-range { font-family: var(--r-sans); font-size: 10.5px; color: var(--r-text); border: 1px solid var(--r-selected-edge); border-radius: 999px; padding: 0 8px; }
  button.timeline-more { display: block; margin: 4px 0; font-size: 11.5px; }
  /* The reply floats over the bottom of the panel, so it is always in reach. */
  .reply-box { position: sticky; bottom: 8px; z-index: 5; margin-top: 12px; border-radius: 12px; background: var(--r-glass-strong);
    box-shadow: inset 0 1px 0 var(--r-sheen), var(--r-float); }
  .reply-box:focus-within { transform: translateY(-1px); }
  @media (prefers-reduced-motion: reduce) { .reply-box:focus-within { transform: none; } }`;
}

// The thumbnail cache both sidebars use (the timeline's artifact tiles and the
// Project panel's card previews). Plain webview JavaScript, no backticks; it reads
// only the document. An <img data-thumb="uri"> gets a 480 px WebP copy once.
// It carries the one escaper, `esc`, for both pages' scripts.
export const THUMB_SCRIPT = `
const esc = ${escapeHtml};
// An agent's renders are often 4000+ px; an <img> keeps the full decode (60+ MB)
// alive for a sidebar preview. Each image is instead fetched once when it scrolls
// near view, downscaled to a WebP wide enough for the full-width hero, and cached for the webview's life.
// Decodes run one at a time so a folder of renders never spikes the machine.
const THUMB_WIDTH = 480;
const THUMB_RETRY_MS = 30000;
const THUMB_CACHE_MAX = 120;
const thumbCache = new Map();
const thumbFailedAt = new Map();
let thumbQueue = Promise.resolve();
const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    queueThumb(entry.target.getAttribute('data-thumb'));
  }
}, { rootMargin: '200px' });

function thumbImg(f) {
  if (f.path.toLowerCase().endsWith('.svg')) return '<img src="' + esc(f.uri) + '" alt="">';
  // No src until the small copy exists: src="" would draw a broken-image icon.
  const ready = thumbCache.get(f.uri);
  return '<img data-thumb="' + esc(f.uri) + '"' + (ready ? ' src="' + esc(ready) + '"' : '') + ' alt="">';
}

function queueThumb(uri) {
  thumbQueue = thumbQueue.then(async () => {
    // A render still being written fails to decode; try again later, not every render.
    if (Date.now() - (thumbFailedAt.get(uri) || 0) < THUMB_RETRY_MS) return;
    if (!thumbCache.has(uri)) {
      try {
        const bitmap = await createImageBitmap(await (await fetch(uri)).blob(), { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        // WebP keeps transparency; JPEG would turn a cutout or logo black.
        thumbCache.set(uri, canvas.toDataURL('image/webp', 0.8));
        // A long session can name hundreds of images; keep the newest copies only.
        while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
      } catch {
        thumbFailedAt.set(uri, Date.now());
        return;
      }
    }
    const url = thumbCache.get(uri);
    for (const img of document.querySelectorAll('img[data-thumb]')) if (img.getAttribute('data-thumb') === uri) img.src = url;
  });
}

// After a redraw: an image whose small copy is cached shows it at once; the rest
// load as they scroll near view. A reused <img> keeps the src it already has.
function observeThumbs(scope) {
  thumbObserver.disconnect();
  for (const img of scope.querySelectorAll('img[data-thumb]')) {
    if (img.hasAttribute('src')) continue;
    const ready = thumbCache.get(img.getAttribute('data-thumb'));
    if (ready) img.src = ready; else thumbObserver.observe(img);
  }
}
`;

// The in-place patch both sidebars use (the Active Session card and the Project
// panel's lists). Plain webview JavaScript inlined into each nonce'd <script>;
// written as it would be inside that template literal (no backticks).
export const PATCH_SCRIPT = `
// Stream updates arrive several times a minute on a busy session. Replacing the
// card's HTML on each one tore down every node: the panel jittered, hover ended
// and a scrolled strip snapped back (owner video, 2026-10-12). patchChildren
// turns the live children into the new markup in place: an unchanged node stays
// the same node. A node is reused only when its tag, id, class and data-*
// attribute names match, so a reused node keeps the handler it was bound with;
// every handler reads its data-* values when clicked. Children pair by position,
// so a fold is keyed by its summary: a fold the viewer opened keeps its open
// state, and rows inserted above it never hand that state to another row. A
// thumbnail keeps the src the observer filled only while it shows the same image.
// A node with data-key moves to its new position instead of being rewritten, and
// one whose data-h (a hash of its markup) is unchanged is not touched at all.
// One marked data-keep keeps its children as the page made them.
function nodeSig(n) {
  if (n.nodeType !== 1) return String(n.nodeType);
  const names = [];
  for (const a of n.attributes) {
    if (a.name === 'class' || a.name === 'id') names.push(a.name + '=' + a.value);
    else if (a.name.indexOf('data-') === 0) names.push(a.name);
  }
  const summary = n.nodeName === 'DETAILS' && n.firstElementChild && n.firstElementChild.nodeName === 'SUMMARY' ? '|' + n.firstElementChild.textContent : '';
  return n.nodeName + '|' + names.sort().join(',') + summary;
}

function patchAttrs(live, next) {
  const sameImage = live.hasAttribute('data-thumb') && live.getAttribute('data-thumb') === next.getAttribute('data-thumb');
  const kept = (name) => (name === 'open' && live.nodeName === 'DETAILS') || (name === 'src' && sameImage);
  for (const a of Array.from(live.attributes)) if (!next.hasAttribute(a.name) && !kept(a.name)) live.removeAttribute(a.name);
  for (const a of Array.from(next.attributes)) if (!kept(a.name) && live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
}

// Once clicked, a checkbox ignores its checked attribute, and isEqualNode compares
// attributes only, so a redraw sets each one to the value it draws.
function syncChecks(live, next) {
  const mine = live.nodeName === 'INPUT' ? [live] : Array.from(live.querySelectorAll('input[type=checkbox]'));
  const drawn = next.nodeName === 'INPUT' ? [next] : Array.from(next.querySelectorAll('input[type=checkbox]'));
  mine.forEach((el, i) => { if (el.type === 'checkbox' && drawn[i]) el.checked = drawn[i].hasAttribute('checked'); });
}

function patchNode(live, next) {
  const now = Array.from(next.childNodes);
  for (let i = 0; i < now.length; i++) {
    const y = now[i];
    let x = live.childNodes[i];
    // A keyed node (a session card) pairs with its own live node even when cards
    // above it were added or removed, so its images are never handed to another card.
    const key = y.nodeType === 1 ? y.getAttribute('data-key') : null;
    if (key && x && !(x.nodeType === 1 && x.getAttribute('data-key') === key)) {
      let found = null;
      for (let j = i + 1; j < live.childNodes.length; j++) {
        const c = live.childNodes[j];
        if (c.nodeType === 1 && c.getAttribute('data-key') === key) { found = c; break; }
      }
      if (found) { live.insertBefore(found, x); x = found; }
      // A new card never takes over another card's node: it goes in before it.
      else if (x.nodeType === 1 && x.hasAttribute('data-key')) { live.insertBefore(y, x); continue; }
    }
    if (!x) { live.appendChild(y); continue; }
    // A node marked data-keep keeps what the page drew inside it (the pinned card's
    // reply box, its Made shelf): a patch updates its attributes only, so a draft,
    // the caret, the mic's state and a scrolled shelf stay.
    if (y.nodeType === 1 && x.nodeType === 1 && x.hasAttribute('data-keep') && nodeSig(x) === nodeSig(y)) { patchAttrs(x, y); continue; }
    // A card whose fields hash is unchanged is left exactly as it is, classes the
    // page added (selection, a flash) included.
    const h = y.nodeType === 1 ? y.getAttribute('data-h') : null;
    if (h && x.nodeType === 1 && x.nodeName === y.nodeName && x.getAttribute('data-h') === h) continue;
    // The same keyed card is patched in place even when the page changed its classes.
    const sameKey = key && x.nodeType === 1 && x.nodeName === y.nodeName && x.getAttribute('data-key') === key;
    if (!sameKey && nodeSig(x) !== nodeSig(y)) { live.replaceChild(y, x); continue; }
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    if (x.isEqualNode(y)) { syncChecks(x, y); continue; }
    patchAttrs(x, y);
    if (x.nodeName === 'INPUT') syncChecks(x, y);
    patchNode(x, y);
  }
  while (live.childNodes.length > now.length) live.removeChild(live.lastChild);
}

function patchChildren(live, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  patchNode(live, t.content);
}

// A patched node keeps its listeners, so each binding runs once per node.
function bindOnce(el, key) {
  const mark = '__bound_' + key;
  if (el[mark]) return false;
  el[mark] = true;
  return true;
}
`;
