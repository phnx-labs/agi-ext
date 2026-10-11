// The session cards both surfaces draw: the Active Session sidebar
// (src/vscode/agentPanel.vscode.ts) and the Fleet card expanded in place
// (ui/settings/components/mission-control/sessions/SessionCards.tsx).
//
// SESSION_CARDS_SCRIPT is plain webview JavaScript (the timeline with its seek
// strip, phases and filters, and the artifacts gallery, plus the handlers that
// wire them). It is a string because the sidebar inlines it into its nonce'd
// <script>; Fleet evaluates it once per card. Each surface supplies the free
// names it reads: root, viewState, vscode, lastSnapshot and render.
//
// Written exactly as it was inside the sidebar's template literal: a regex
// backslash is doubled, because this literal collapses `\\` to `\` the same way.
// No backticks and no interpolation inside.

export const SESSION_CARDS_SCRIPT = `
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function relTime(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

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

const TIMELINE_SHOWN = 3;

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

// A phase is one stretch of work between idle gaps. Choosing one narrows the
// strip, the steps and the You / Failed lists to that stretch.
function timelinePhases(s) {
  const h = s.activityHistogram;
  if (!h || !h.buckets || !h.buckets.length || !(h.endMs > h.startMs)) return [];
  const bucketMs = (h.endMs - h.startMs) / h.buckets.length;
  const phases = [];
  let cur = null;
  for (const seg of seekSegments(h)) {
    if (seg.gap) { cur = null; continue; }
    const from = h.startMs + seg.i * bucketMs;
    const to = h.startMs + (seg.i + 1) * bucketMs;
    if (cur) cur.endMs = to; else phases.push(cur = { startMs: Math.round(from), endMs: Math.round(to) });
  }
  return phases.length > 1 ? phases : [];
}

// A remembered range applies only while it is still one of this session's phases:
// once the strip is rebucketed or a stretch merges, it lapses instead of leaving
// the strip dimmed with no chip showing why.
function currentRange(s) {
  const r = (viewState.timelineRange || {})[(s && s.fullSessionId) || ''];
  if (!Array.isArray(r) || r.length !== 2) return null;
  return timelinePhases(s).some((p) => p.startMs === r[0] && p.endMs === r[1]) ? { startMs: r[0], endMs: r[1] } : null;
}

function inRange(range, ms) {
  return !range || (Number.isFinite(ms) && ms >= range.startMs && ms < range.endMs);
}

function renderPhaseChips(s) {
  const phases = timelinePhases(s);
  if (!phases.length) return '';
  const range = currentRange(s);
  let lastDay = '';
  return '<div class="tl-phases" role="group" aria-label="Phases">' + phases.map((p) => {
    const on = !!range && range.startMs === p.startMs && range.endMs === p.endMs;
    const tip = clockTime(p.startMs) + ' to ' + clockTime(p.endMs);
    const full = clockTime(p.startMs);
    const time = new Date(p.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = full.slice(0, full.length - time.length).replace(/,?\\s+$/, '');
    const label = day && day !== lastDay ? day + ' ' + time : time;
    lastDay = day;
    return '<button type="button" class="tl-filter tl-phase' + (on ? ' on' : '') + '" data-phase="' + p.startMs + '-' + p.endMs + '" aria-pressed="' + on + '" title="' + esc(tip) + '">' + esc(label) + '</button>';
  }).join('') + '</div>';
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
    '<div class="seek" role="group" aria-label="Session activity">' +
      '<div class="seek-bars">' + bars + '</div>' +
      '<div class="seek-marks">' + marks.join('') + '</div>' +
      '<div class="seek-axis"><span>' + esc(clockTime(h.startMs)) + '</span><span>' + esc(clockTime(h.endMs)) + '</span></div>' +
    '</div>'
  );
}

// Filters swap the default summary for one stream. You and Failed ride the row;
// Agent, Tools and Reasoning are one agents-sessions call per click (cached).
const TIMELINE_FILTERS = [{ id: 'summary', label: 'Summary' }, { id: 'user', label: 'You' }, { id: 'failed', label: 'Failed' }, { id: 'assistant', label: 'Agent' }, { id: 'tools', label: 'Tools' }, { id: 'thinking', label: 'Reasoning' }];
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
  const counts = { user: (s.userTurns || []).length, failed: (s.failures || []).length };
  return '<div class="tl-filters">' + TIMELINE_FILTERS.map((f) => {
    if (f.id === 'user' && !s.userTurns) return '';
    if (f.id === 'failed' && !(s.failures && s.failures.length)) return '';
    if (VERB_FILTERS.indexOf(f.id) >= 0 && !s.sessionLocal) return '';
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

function renderTimelineCard(s) {
  // The stream has not established for this session's scope: say so instead of
  // rendering an empty card that reads as "the agent has done nothing".
  if (s.streamDegraded) {
    return (
      '<h2>Timeline</h2>' +
      '<div class="card"><div class="card-note">' +
        '<strong>Waiting for the session stream…</strong><br>' +
        'No row has arrived for ' + esc(s.streamScope || 'this machine') + ' yet. The elected ' +
        'window runs <code>agents feed watch --json</code> while a session view is open, and ' +
        'this panel renders whatever that stream carries. Nothing here is fetched per click.' +
      '</div></div>'
    );
  }
  const t = s.timeline || timelineFromCheckpoints(s);
  if (!t) return '';
  if (t.state === 'unavailable') {
    return (
      '<h2>Timeline</h2>' +
      '<div class="card"><div class="card-note">' +
        '<strong>Timeline unavailable for this harness</strong>' +
        (t.reason ? '<br>' + esc(t.reason) : '') +
      '</div></div>'
    );
  }
  const steps = (t.steps || []).slice().reverse();   // newest first
  if (!steps.length && !t.earlier.steps) return '';
  const head = [];
  if (s.lastActivityMs) head.push('last active ' + relTime(s.lastActivityMs));
  if (t.tools > 0) head.push(t.tools + ' tools');
  const meta = head.length ? '<span class="head-meta">' + esc(head.join(' · ')) + '</span>' : '';
  const active = currentFilter(s);
  const range = currentRange(s);
  const rangeNote = range
    ? '<div class="tl-range card-note">' + esc(clockTime(range.startMs) + ' to ' + clockTime(range.endMs)) + ' · ' +
        (s.sessionLocal && active !== 'tools' ? '<button type="button" class="tl-refresh" data-filter="tools">Show tool calls</button> · ' : '') +
        '<button type="button" class="tl-refresh" data-phase="">Clear range</button></div>'
    : '';
  const seekAndFilters = renderSeekBar(s) + renderPhaseChips(s) + renderFilterChips(s, active) + rangeNote;
  if (active !== 'summary') {
    return '<h2>Timeline' + meta + '</h2><div class="card">' + seekAndFilters + '<div class="tl-filtered">' + renderFilteredBody(s, active) + '</div></div>';
  }

  const visible = steps.filter((step) => !Number.isFinite(Date.parse(step.at)) || inRange(range, Date.parse(step.at)));
  const none = range && !visible.length
    ? '<div class="card-note">No loaded step falls in this range; older steps are folded into the count below.</div>'
    : '';
  const shown = none + visible.slice(0, TIMELINE_SHOWN).map(renderStep).join('');
  const rest = visible.slice(TIMELINE_SHOWN);
  const more = rest.length
    ? '<details><summary class="timeline-more">' + rest.length + ' more</summary>' +
      rest.map(renderStep).join('') + '</details>'
    : '';
  const earlierBits = [];
  if (t.earlier.steps > 0) {
    earlierBits.push(t.earlier.steps + ' earlier step' + (t.earlier.steps === 1 ? '' : 's'));
    if (t.earlier.tools > 0) earlierBits.push(t.earlier.tools + ' tools');
    if (t.earlier.failed > 0) earlierBits.push(t.earlier.failed + ' failed');
  }
  const earlier = earlierBits.length
    ? '<div class="timeline-earlier">▸ ' + esc(earlierBits.join(' · ')) + '</div>'
    : '';
  const partial = t.state === 'partial'
    ? '<div class="card-note" style="margin-top:6px">Partial: the transcript was capped this tick.</div>'
    : '';
  return (
    '<h2>Timeline' + meta + '</h2>' +
    '<div class="card">' + seekAndFilters + shown + more + earlier + partial + '</div>'
  );
}

// ── Artifacts ───────────────────────────────────────────────────────────────
// Everything the session produced for a person: the CLI's artifacts as a
// gallery (or grouped into their folders by app), the PRs and the ticket. Sort,
// grouping and the folded state are the viewer's choice and persist; the data is
// only what the row carries.
const APP_LABEL = { github: 'GitHub', finder: 'Finder', linear: 'Linear' };
const APP_ICON = {
  github: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  finder: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="3.5" fill="#1E6FF0"/><path d="M8.6 0H12.5A3.5 3.5 0 0116 3.5v9A3.5 3.5 0 0112.5 16H7.4C7.9 12 8.9 9.5 7.2 9.2 6.4 9 7.6 3 8.6 0z" fill="#9DD0FF"/><path d="M4.7 5v1.6M11.3 5v1.6M3.8 11c2.6 1.8 5.8 1.8 8.4 0" stroke="#0B2A5C" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>',
  linear: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#5E6AD2"/><path d="M2.2 9.6l4.2 4.2M2.9 6.8l6.3 6.3M4.4 4.4l7.2 7.2M6.8 2.9l6.3 6.3" stroke="#fff" stroke-width="1.1"/></svg>',
};
const ARTIFACT_SORTS = {
  latest: (a, b) => (b.editedAtMs || 0) - (a.editedAtMs || 0),
  oldest: (a, b) => (a.editedAtMs || 0) - (b.editedAtMs || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

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
  const items = Array.from(folders.values());
  for (const pr of (s.pullRequests || [])) items.push({ app: 'github', key: pr.url, name: pr.ownerRepo + ' #' + pr.number, pr });
  if (s.linearIssue) items.push({ app: 'linear', key: s.linearIssue, name: s.linearIssue, ticket: s.linearIssue });
  return items;
}

// The gallery is the default; Group by app is on only after the viewer turns it on.
// A viewer who never toggled has no stored value, so one click must turn it on.
function artifactGroupOn(stored) { return stored === true; }

function renderArtifactsCard(s) {
  const items = artifactItems(s);
  if (!items.length) return '';
  const sortKey = ARTIFACT_SORTS[viewState.artifactSort] ? viewState.artifactSort : 'latest';
  // Visual first: the gallery is the default; grouping by app is the toggle.
  const grouped = artifactGroupOn(viewState.artifactGroup);
  const collapsed = !!viewState.artifactsCollapsed;
  items.sort(ARTIFACT_SORTS[sortKey]);
  const fileCount = items.reduce((n, it) => n + (it.files ? it.files.length : 0), 0);
  const meta = items.length + (items.length === 1 ? ' item' : ' items') + (fileCount ? ' · ' + fileCount + (fileCount === 1 ? ' file' : ' files') : '');
  const head =
    '<h2><button type="button" class="art-toggle" data-art-toggle aria-expanded="' + !collapsed + '">' +
      '<span class="caret">' + (collapsed ? '▸' : '▾') + '</span>Artifacts</button>' +
      '<span class="head-meta">' + esc(meta) + '</span></h2>';
  if (collapsed) return head + renderArtifactsSummary(items);
  const options = [['latest', 'Latest edited'], ['oldest', 'Oldest first'], ['name', 'Name']]
    .map((o) => '<option value="' + o[0] + '"' + (o[0] === sortKey ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const bar =
    '<div class="art-bar"><label>Sort <select data-art-sort>' + options + '</select></label>' +
    '<button type="button" class="art-group" data-art-group aria-pressed="' + grouped + '">Group by app</button></div>';
  let body = '';
  if (grouped) {
    const apps = [];
    for (const it of items) {
      let group = apps.find((g) => g.app === it.app);
      if (!group) apps.push(group = { app: it.app, items: [] });
      group.items.push(it);
    }
    body = apps.map((g) =>
      '<div class="art-app">' + APP_ICON[g.app] + esc(APP_LABEL[g.app]) + '<span class="art-count">' + g.items.length + '</span></div>' +
      g.items.map((it) => renderArtifactItem(it, s, sortKey, false)).join('')
    ).join('');
  } else {
    const files = [];
    for (const it of items) if (it.files) for (const f of it.files) files.push(f);
    body = renderArtifactGallery(artifactGallery(files, sortKey)) +
      items.filter((it) => !it.files).map((it) => renderArtifactItem(it, s, sortKey, true)).join('');
  }
  return head + '<div class="card art-card">' + bar + body + '</div>';
}

// The gallery: the newest file with a preview leads large, the other previews
// follow as tiles in the viewer's order, and files with no preview (pages,
// documents) close the card as compact tiles marked by their type.
function artifactGallery(files, sortKey) {
  let hero = null;
  for (const f of files) if (f.uri && (!hero || (f.editedAtMs || 0) > (hero.editedAtMs || 0))) hero = f;
  const rest = files.filter((f) => f !== hero).sort(ARTIFACT_SORTS[sortKey] || ARTIFACT_SORTS.latest);
  return { hero: hero, images: rest.filter((f) => f.uri), files: rest.filter((f) => !f.uri) };
}

const FILE_GLYPH = { md: '¶', markdown: '¶', txt: '¶', html: '‹/›', htm: '‹/›', json: '{ }', csv: '▦', pdf: '▤' };

function artifactKind(f) {
  const base = f.path.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'file';
}

function renderArtifactGallery(g) {
  const caption = (f) => {
    const age = f.editedAtMs ? relTime(f.editedAtMs) : '';
    return '<span class="art-kind">' + esc(artifactKind(f)) + '</span>' + (age ? '<span class="art-age">' + esc(age) + '</span>' : '');
  };
  const hero = g.hero
    ? '<button type="button" class="art-hero artifact-open" data-artifact="' + esc(g.hero.path) + '" title="' + esc(g.hero.path) + '">' +
        '<span class="art-hero-img">' + thumbImg(g.hero) + '</span>' +
        '<span class="art-cap"><b>' + esc(g.hero.name) + '</b><span class="art-cap-meta">' + caption(g.hero) + '</span></span></button>'
    : '';
  const images = g.images.length
    ? '<div class="art-grid">' + g.images.map((f) =>
        '<button type="button" class="art-shot artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
          '<span class="art-shot-img">' + thumbImg(f) + '</span><span class="art-shot-cap">' + esc(f.name) + '</span></button>').join('') + '</div>'
    : '';
  const docs = g.files.length
    ? '<div class="art-grid art-docs">' + g.files.map((f) => {
        const kind = artifactKind(f);
        return '<button type="button" class="art-doc artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
          '<span class="art-glyph" aria-hidden="true">' + esc(FILE_GLYPH[kind] || kind.slice(0, 4).toUpperCase()) + '</span>' +
          '<span class="art-doc-text"><span class="art-doc-name">' + esc(f.name) + '</span><span class="art-cap-meta">' + caption(f) + '</span></span></button>';
      }).join('') + '</div>'
    : '';
  return hero + images + docs;
}

function renderArtifactItem(it, s, sortKey, showApp) {
  const icon = showApp ? APP_ICON[it.app] : '';
  if (it.pr) {
    return '<button type="button" class="art-link" data-url="' + esc(it.pr.url) + '" title="' + esc(it.pr.url) + '">' +
      icon + '<span class="art-link-kind">PR</span>' + esc(it.pr.ownerRepo) + ' #' + it.pr.number + '</button>';
  }
  if (it.ticket) {
    const url = 'https://linear.app/issue/' + encodeURIComponent(it.ticket);
    return '<button type="button" class="art-link" data-url="' + esc(url) + '" title="' + esc(url) + '">' +
      icon + '<span class="art-link-kind">Ticket</span>' + esc(it.ticket) + '</button>';
  }
  const open = !!(viewState.openFolders || {})[it.key];
  const files = it.files.slice().sort(ARTIFACT_SORTS[sortKey]);
  const count = it.files.length + (it.files.length === 1 ? ' file' : ' files');
  return (
    '<div class="art-folder' + (open ? ' open' : '') + '">' +
      '<div class="art-folder-head">' +
        '<button type="button" class="art-folder-toggle" data-folder="' + esc(it.key) + '" aria-expanded="' + open + '" title="' + esc(it.key) + '">' +
          '<span class="caret">' + (open ? '▾' : '▸') + '</span>' + icon + '<span class="art-folder-name">' + esc(it.name) + '</span></button>' +
        (s.sessionLocal ? '<button type="button" class="art-reveal" data-reveal="' + esc(it.key) + '" title="Reveal in Finder">↗</button>' : '') +
        (it.editedAtMs ? '<span class="art-time">' + esc(relTime(it.editedAtMs)) + '</span>' : '') +
      '</div>' +
      '<div class="art-meta">' + esc([it.display, count].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="art-files" data-strip="' + esc(it.key) + '">' + files.map(renderArtifactTile).join('') + '</div>' +
    '</div>'
  );
}

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
    for (const img of root.querySelectorAll('img[data-thumb]')) if (img.getAttribute('data-thumb') === uri) img.src = url;
  });
}

function renderArtifactTile(f) {
  const face = f.uri
    ? thumbImg(f)
    : '<span class="art-ext">' + esc((f.path.split('.').pop() || '').toUpperCase()) + '</span>';
  return '<button type="button" class="art-tile artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
    '<span class="art-thumb">' + face + '</span><span class="art-label">' + esc(f.name) + '</span></button>';
}

// The folded section still says what is there: the first thumbnails, which
// apps hold artifacts, and when the newest one changed.
function renderArtifactsSummary(items) {
  const thumbs = [];
  for (const it of items) for (const f of (it.files || [])) if (f.uri && thumbs.length < 3) thumbs.push(thumbImg(f));
  const apps = items.map((it) => it.app).filter((app, i, all) => all.indexOf(app) === i).map((app) => APP_ICON[app]).join('');
  const newest = Math.max(0, ...items.map((it) => it.editedAtMs || 0));
  return '<button type="button" class="art-summary" data-art-toggle>' + thumbs.join('') + '<span class="art-apps">' + apps + '</span>' +
    (newest ? '<span class="art-time">newest ' + esc(relTime(newest)) + '</span>' : '') + '</button>';
}

// Stream updates re-render the cards; a strip the viewer scrolled stays put.
// A surface calls saveStripScroll before replacing root's HTML, then restores.
function saveStripScroll() {
  const at = {};
  for (const el of root.querySelectorAll('[data-strip]')) at[el.getAttribute('data-strip')] = [el.scrollLeft, el.scrollTop];
  return at;
}

function restoreStripScroll(saved) {
  for (const el of root.querySelectorAll('[data-strip]')) {
    const at = saved[el.getAttribute('data-strip')];
    if (at) { el.scrollLeft = at[0]; el.scrollTop = at[1]; }
  }
}

// Wires the timeline and artifact cards rendered into root: their thumbnails,
// filters, phases, seek bar, step folds and links. Reads the surface's own
// root, viewState, vscode, lastSnapshot and render.
function bindSessionCards() {
  thumbObserver.disconnect();
  for (const img of root.querySelectorAll('img[data-thumb]')) if (!img.hasAttribute('src')) thumbObserver.observe(img);
  for (const el of root.querySelectorAll('[data-art-toggle]')) {
    el.addEventListener('click', () => { viewState.artifactsCollapsed = !viewState.artifactsCollapsed; vscode.setState(viewState); render(lastSnapshot); });
  }
  const artSort = root.querySelector('[data-art-sort]');
  if (artSort) artSort.addEventListener('change', () => { viewState.artifactSort = artSort.value; vscode.setState(viewState); render(lastSnapshot); });
  const artGroup = root.querySelector('[data-art-group]');
  if (artGroup) artGroup.addEventListener('click', () => { viewState.artifactGroup = !artifactGroupOn(viewState.artifactGroup); vscode.setState(viewState); render(lastSnapshot); });
  for (const el of root.querySelectorAll('[data-folder]')) {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-folder');
      const open = Object.assign({}, viewState.openFolders);
      if (open[key]) delete open[key]; else open[key] = true;
      viewState.openFolders = open;
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-reveal]')) {
    el.addEventListener('click', () => vscode.postMessage({ type: 'revealCwd', path: el.getAttribute('data-reveal') }));
  }
  for (const el of root.querySelectorAll('.artifact-open')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openArtifact', path: el.getAttribute('data-artifact') });
    });
  }
  for (const el of root.querySelectorAll('[data-filter]')) {
    el.addEventListener('click', () => {
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
    el.addEventListener('click', () => {
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      const value = el.getAttribute('data-phase');
      const next = Object.assign({}, viewState.timelineRange);
      const cur = currentRange(lastSnapshot);
      const parts = value ? value.split('-').map(Number) : null;
      if (!parts || (cur && cur.startMs === parts[0] && cur.endMs === parts[1])) delete next[key];
      else next[key] = parts;
      viewState.timelineRange = next;
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-refresh-filter]')) {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-refresh-filter');
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      requestTimelineFilter(key, id);
      vscode.postMessage({ type: 'loadTimelineFilter', role: id, sessionId: key });
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-seek]')) {
    el.addEventListener('click', () => {
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
    el.addEventListener('click', () => {
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
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: el.getAttribute('data-url') });
    });
  }
}
`;

/** The panel faces. A shadow root ignores @font-face, so a surface hosting the
 *  cards in one declares these on its document instead. */
export function sessionPanelFontFaces(fontJost: string, fontInter: string): string {
  return `  @font-face { font-family: 'Jost'; src: url('${fontJost}') format('woff2'); font-weight: 100 900; font-display: swap; }
  @font-face { font-family: 'Inter'; src: url('${fontInter}') format('woff2'); font-weight: 100 900; font-display: swap; }
`;
}

/** The session panel stylesheet: Rush register tokens, cards, timeline, gallery.
 *  Tokens hang off `body` and its VS Code theme class, so a surface that hosts the
 *  cards in a shadow root gives them a `body` element carrying that class. */
export function sessionPanelCss(fontFaces: string): string {
  return `  /* ── Rush register tokens (rush/DESIGN.md, Day and Altitude) ─────────────
     The ONLY block allowed to hold a color literal; every rule below reads these.
     Dark editor = Altitude (white glass, zinc type), light editor = Day (ivory
     glass, ink type). High-contrast themes keep VS Code's own colors. Gold is the
     one accent: the primary action only. Status stays small: dots, badges, text. */
${fontFaces}  body {
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
    --r-ok-tint: rgba(34, 197, 94, 0.16);
    --r-warn: #fcd34d;
    --r-warn-tint: rgba(245, 158, 11, 0.14);
    --r-bad: #fca5a5;
    --r-bad-tint: rgba(239, 68, 68, 0.12);
    --r-bar: rgba(255, 255, 255, 0.30);
    --r-bar-hi: rgba(255, 255, 255, 0.62);
    --r-focus: rgba(255, 255, 255, 0.45);
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
    --r-ok-tint: rgba(22, 163, 74, 0.12);
    --r-warn: #b45309;
    --r-warn-tint: rgba(217, 119, 6, 0.12);
    --r-bad: #b91c1c;
    --r-bad-tint: rgba(220, 38, 38, 0.08);
    --r-bar: rgba(20, 24, 41, 0.24);
    --r-bar-hi: rgba(20, 24, 41, 0.55);
    --r-focus: rgba(20, 24, 41, 0.45);
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
    --r-ok-tint: transparent;
    --r-warn: var(--vscode-charts-yellow);
    --r-warn-tint: transparent;
    --r-bad: var(--vscode-errorForeground);
    --r-bad-tint: transparent;
    --r-bar: var(--vscode-charts-blue);
    --r-bar-hi: var(--vscode-foreground);
    --r-focus: var(--vscode-focusBorder);
  }
  :root {
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
  .card {
    border: 1px solid var(--r-edge);
    border-radius: 10px;
    padding: 9px 11px;
    background: var(--r-glass);
    box-shadow: inset 0 1px 0 var(--r-sheen);
    margin-top: 4px;
  }
  .agent-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-logo {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
    object-fit: contain;
    background: transparent;
  }
  .agent-head-text { flex: 1; min-width: 0; }
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
  }
  .agent-name { color: var(--r-text); }
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
  .branch-row {
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--r-caption);
  }
  .branch-name {
    font-family: var(--r-mono);
    color: var(--r-text);
    background: transparent;
    border: none;
    padding: 0;
    font-size: inherit;
    cursor: pointer;
  }
  .branch-name:hover { text-decoration: underline; }
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
  .working-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--r-caption);
    font-size: 11.5px;
    padding: 4px 2px;
  }
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
  .row-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin-top: 4px;
  }
  .row-grid dt {
    color: var(--r-caption);
    font-size: 11px;
  }
  .row-grid dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path-link {
    color: var(--r-link);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--r-mono);
    font-size: 11px;
  }
  .path-link:hover { text-decoration: underline; }
  .plan-meta {
    color: var(--r-caption);
    font-size: 11px;
  }
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
  .conv-meta {
    margin-top: 6px;
    color: var(--r-caption);
    font-size: 11px;
  }
  .request-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }
  .attachment-link {
    border: 1px solid var(--r-edge);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .art-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: var(--r-caption); }
  .art-bar select {
    margin-left: 4px; font: inherit; border-radius: 3px; padding: 1px 2px;
    background: var(--r-glass-strong); color: var(--r-text);
    border: 1px solid var(--r-edge);
  }
  button.art-group {
    font: inherit; font-size: 11px; cursor: pointer; border-radius: 999px; padding: 1px 9px;
    border: 1px solid var(--r-edge);
    background: transparent; color: var(--r-caption);
  }
  button.art-group[aria-pressed="true"] { background: var(--r-selected); color: var(--r-text); border-color: var(--r-selected-edge); font-weight: 600; }
  .art-icon { width: 14px; height: 14px; flex: none; }
  .requester { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--r-caption); font-size: 11px; }
  .avatar {
    position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none;
    border-radius: 50%; overflow: hidden; font-size: 10px; font-weight: 600;
    background: var(--r-selected); color: var(--r-text);
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .art-app { display: flex; align-items: center; gap: 6px; margin: 10px 0 2px; font-size: 11.5px; font-weight: 600; }
  .art-count { color: var(--r-caption); font-weight: 400; }
  .art-folder { padding: 5px 0 6px; }
  .art-folder-head { display: flex; align-items: center; gap: 4px; }
  button.art-folder-toggle { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; }
  .art-folder-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { width: 10px; flex: none; color: var(--r-caption); font-size: 9px; }
  .art-folder-head button.art-reveal { color: var(--r-caption); padding: 0 4px; }
  .art-time { margin-left: auto; color: var(--r-caption); font-size: 11px; white-space: nowrap; }
  .art-meta { margin: 1px 0 5px 15px; color: var(--r-caption); font-size: 11px; overflow-wrap: anywhere; }
  .art-files { display: flex; gap: 6px; margin-left: 15px; padding-bottom: 4px; overflow-x: auto; }
  .art-folder.open .art-files { flex-wrap: wrap; overflow-x: hidden; overflow-y: auto; max-height: 260px; }
  button.art-tile { flex: none; width: 88px; }
  .art-folder.open button.art-tile { width: calc(50% - 3px); }
  .art-thumb {
    display: flex; align-items: center; justify-content: center; aspect-ratio: 3 / 2; overflow: hidden; border-radius: 6px;
    border: 1px solid var(--r-edge); background: var(--r-well);
  }
  .art-thumb img { width: 100%; height: 100%; object-fit: cover; }
  button.art-tile:hover .art-thumb { border-color: var(--r-focus); }
  .art-ext { color: var(--r-caption); font-size: 10px; font-weight: 600; letter-spacing: 0.05em; }
  .art-label {
    display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--r-caption); font-family: var(--r-mono); font-size: 10.5px;
  }
  .art-card button.art-link {
    display: flex; align-items: center; gap: 6px; width: 100%; margin: 3px 0; padding: 6px 9px; border-radius: 8px;
    border: 1px solid var(--r-edge); color: var(--r-link); box-sizing: border-box;
  }
  .art-link-kind { color: var(--r-caption); font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; }
  button.art-summary { display: flex; align-items: center; gap: 6px; width: 100%; }
  .art-summary img { width: 32px; height: 21px; object-fit: cover; border-radius: 2px; border: 1px solid var(--r-edge); }
  .art-apps { display: flex; gap: 3px; }
  button.art-toggle { display: inline-flex; align-items: center; gap: 4px; text-transform: inherit; letter-spacing: inherit; color: inherit; font-weight: inherit; }
  /* Gallery: the newest preview full width, the rest as 2-up tiles, then
     files with no preview as compact tiles marked by their type. */
  .art-card button.art-hero { display: block; width: 100%; padding: 0; margin: 2px 0 6px; overflow: hidden; border-radius: 10px; border: 1px solid var(--r-edge); background: var(--r-well); cursor: zoom-in; }
  .art-hero-img { display: block; aspect-ratio: 16 / 10; overflow: hidden; }
  .art-hero-img img, .art-shot-img img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
  .art-cap { display: grid; gap: 1px; padding: 6px 9px 7px; background: var(--r-glass); border-top: 1px solid var(--r-edge); }
  .art-cap b { font-size: 12.5px; font-weight: 600; color: var(--r-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .art-cap-meta { display: flex; gap: 6px; align-items: baseline; font-family: var(--r-mono); font-size: 10px; color: var(--r-caption); white-space: nowrap; }
  .art-kind { text-transform: uppercase; letter-spacing: 0.06em; color: var(--r-faint); }
  .art-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 6px; }
  .art-card button.art-shot { display: block; min-width: 0; padding: 0; overflow: hidden; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--r-well); cursor: zoom-in; }
  .art-shot-img { display: block; aspect-ratio: 4 / 3; overflow: hidden; }
  .art-shot-cap { display: block; padding: 3px 6px 4px; font-size: 11px; color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-top: 1px solid var(--r-edge); background: var(--r-glass); }
  .art-card button.art-doc { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 6px 7px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--r-glass); }
  .art-glyph { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 5px; background: var(--r-well); color: var(--r-caption); font-family: var(--r-mono); font-size: 10px; font-weight: 600; }
  .art-doc-text { display: grid; min-width: 0; }
  .art-doc-name { font-size: 11.5px; color: var(--r-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .art-card button.art-hero:hover, .art-card button.art-shot:hover, .art-card button.art-doc:hover { border-color: var(--r-focus); }
  button.art-hero:focus-visible, button.art-shot:focus-visible, button.art-doc:focus-visible, button.pr-bar-btn:focus-visible { outline: 1px solid var(--r-focus); outline-offset: 1px; }
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
  .activity-kind {
    width: 56px;
    flex-shrink: 0;
    color: var(--r-caption);
    text-transform: lowercase;
    font-size: 10.5px;
  }
  .activity-summary {
    color: var(--r-text);
    word-break: break-word;
  }
  /* ◈ Goal (PHNX-3939) — teal accent label, the clean one-line read. */
  .goal-card {
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
  /* Progress checkpoints — amber marker for the live now-line, newest on top. */
  .checkpoint {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .checkpoint-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
    background: var(--r-warn);
  }
  .checkpoint-txt { color: var(--r-text); word-break: break-word; }
  .checkpoint-at {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--r-caption);
    font-size: 10.5px;
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
    padding: 3px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
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
  .reply-box { margin-top: 14px; }
  .reply-box textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 30px;
    background: var(--r-glass);
    color: var(--r-text);
    border: 1px solid var(--r-edge);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
  }
  .reply-box textarea:focus {
    outline: 1px solid var(--r-focus);
    outline-offset: -1px;
  }
  .reply-err {
    color: var(--r-bad);
    font-size: 10.5px;
    margin-top: 4px;
  }
  /* Header actions — Focus / Resume, the two verbs the removed Fleet rail owned. */
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
  .actions-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
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
  .slash-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 5px;
  }
  .action-btn.slash {
    flex: none;
    font-family: var(--r-mono);
    font-size: 11.5px;
    padding: 5px 8px;
    text-align: left;
  }
  .actions-pr {
    margin-bottom: 8px;
  }
  .actions-hint {
    margin-top: 8px;
    color: var(--r-caption);
    font-size: 10.5px;
  }
  .prompt-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prompt-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--r-text);
    border: 1px solid var(--r-edge);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .prompt-btn:hover {
    background: var(--r-glass-hover);
  }
  .prompt-title {
    font-weight: 500;
    flex: 0 0 auto;
  }
  .prompt-preview {
    color: var(--r-caption);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .prompt-star {
    color: var(--r-warn);
    font-size: 10px;
    margin-right: 2px;
  }
  .links-list { display: flex; flex-direction: column; gap: 4px; }
  .link-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
  }
  .link-row a {
    color: var(--r-link);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--r-mono);
  }
  .link-row a:hover { text-decoration: underline; }
  .link-tag {
    color: var(--r-caption);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
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
  .wt-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--r-caption);
    opacity: 0.5;
    flex-shrink: 0;
  }
  .wt-dot.active {
    background: var(--r-ok);
    opacity: 1;
  }
  .wt-name {
    color: var(--r-link);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--r-mono);
  }
  .wt-name:hover { text-decoration: underline; }
  .wt-name.active { font-weight: 600; }
  .wt-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--r-caption);
    background: var(--r-selected);
    padding: 0 5px;
    border-radius: 6px;
  }
  .wt-branch {
    color: var(--r-caption);
    font-family: var(--r-mono);
    font-size: 10.5px;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .team {
    margin-top: 6px;
    border: 1px solid var(--r-edge);
    border-radius: 10px;
    padding: 6px 8px;
    background: var(--r-glass);
  }
  .team-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .team-name { font-weight: 600; }
  .team-counts {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--r-caption);
  }
  .mate {
    display: grid;
    grid-template-columns: 14px 1fr auto auto;
    align-items: center;
    gap: 6px;
    padding: 2px 0 2px 4px;
    font-size: 11.5px;
  }
  .mate-dot {
    width: 6px; height: 6px; border-radius: 50%;
    justify-self: center;
  }
  .mate-dot.running   { background: var(--r-ok); }
  .mate-dot.completed { background: var(--r-caption); }
  .mate-dot.pending   { background: var(--r-warn); }
  .mate-dot.failed    { background: var(--r-bad); }
  .mate-dot.stopped   { background: var(--r-caption); opacity: 0.5; }
  .mate-name { font-family: var(--r-mono); }
  .mate-agent {
    color: var(--r-caption);
    font-size: 10.5px;
  }
  .mate-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--r-caption);
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
  button.path-link, button.step, button.session-chunk, button.art-toggle, button.art-folder-toggle,
  button.art-reveal, button.art-tile, button.art-link, button.art-summary,
  button.art-hero, button.art-shot, button.art-doc, button.pr-bar-btn, button.pr-run {
    background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  button.path-link { color: var(--r-link); padding: 0; }
  button.step { width: 100%; }
  /* Header: title line, then model · account · host; the ⋯ menu opens a drawer
     inside the card (no overlay, so nothing floats over the session). */
  .head-card { position: relative; }
  .title-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .title-line .session-title { flex: 1; min-width: 0; }
  .head-menu > summary { list-style: none; position: absolute; top: 8px; right: 10px; }
  .head-menu > summary::-webkit-details-marker { display: none; }
  .head-menu[open] > summary { background: var(--r-selected); border-color: var(--r-selected-edge); }
  .head-card .head-actions { margin-right: 26px; }
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
  .state-waiting .state-dot { background: var(--r-warn); box-shadow: 0 0 0 3px var(--r-warn-tint); }
  .state-failed .state-dot { background: var(--r-bad); }
  /* Timeline phases: the strip dims outside the chosen stretch. */
  .seek-bar.out i { opacity: 0.22; }
  .tl-phases { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
  .tl-range { margin: -2px 0 8px; }
  .sub-label { margin: 7px 0 2px 13px; font-family: var(--r-display); font-size: 9.5px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: var(--r-caption); }
  .sub-asked { margin: 0 0 0 13px; padding: 6px 8px; border-radius: 8px; background: var(--r-well); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  /* Zoomed lane for one phase: a tick per tool call. */
  .range-lane { margin: 2px 0 10px; }
  .lane-marks { position: relative; height: 15px; }
  .lane-track { position: relative; height: 26px; border-bottom: 1px solid var(--r-edge); }
  .lane-tick { position: absolute; bottom: 0; width: 2px; height: 18px; margin-left: -1px; border-radius: 1px; background: var(--r-bar-hi); }
  .lane-tick.bad { background: var(--r-bad); height: 24px; }
  /* Pull request card: a state ring and one word, then one icon strip
     (segmented checks, review, merge); the checks fold under the bar. */
  .pr-head { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
  .pr-text { min-width: 0; }
  .pr-title { font-weight: 600; color: var(--r-text); line-height: 1.35; overflow-wrap: anywhere; }
  .pr-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin-top: 2px; font-size: 11px; }
  .pr-word { font-weight: 600; color: var(--r-caption); }
  .pr-tone-ok { color: var(--r-ok); }
  .pr-tone-warn { color: var(--r-warn); }
  .pr-tone-bad { color: var(--r-bad); }
  .pr-branch { font-family: var(--r-mono); font-size: 10.5px; color: var(--r-caption); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .pr-ring { width: 18px; height: 18px; display: block; margin-top: 1px; }
  .pr-ring svg { width: 18px; height: 18px; display: block; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .pr-ring .trk { stroke: var(--r-edge-hi); }
  .pr-ring .arc { stroke: var(--r-warn); stroke-dasharray: 14 40; transform-origin: 9px 9px; animation: pr-spin 1s linear infinite; }
  .pr-ring.ok .arc { stroke: var(--r-ok); stroke-dasharray: 44 0; animation: none; }
  .pr-ring.bad .arc { stroke: var(--r-bad); stroke-dasharray: 44 0; animation: none; }
  .pr-ring.draft .arc { stroke: var(--r-faint); stroke-dasharray: 3 3; animation: none; }
  .pr-ring.none .arc { stroke: transparent; animation: none; }
  .pr-ring .chk { stroke: var(--r-ok); stroke-width: 1.8; stroke-dasharray: 12; stroke-dashoffset: 0; }
  .pr-ring .x { stroke: var(--r-bad); stroke-width: 1.6; }
  .just-ready .pr-ring.ok .arc { animation: pr-close .45s ease both; }
  .just-ready .pr-ring.ok .chk { animation: pr-draw .35s .3s ease both; }
  @keyframes pr-spin { to { transform: rotate(360deg); } }
  @keyframes pr-close { from { stroke-dasharray: 14 40; } to { stroke-dasharray: 44 0; } }
  @keyframes pr-draw { from { stroke-dashoffset: 12; } to { stroke-dashoffset: 0; } }
  .pr-strip { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
  .pr-bar-btn { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 3px 0; border-radius: 4px; }
  button.pr-bar-btn:hover .pr-bar { box-shadow: 0 0 0 1px var(--r-focus); }
  .pr-bar { flex: 1; min-width: 0; display: flex; gap: 2px; height: 6px; border-radius: 3px; overflow: hidden; }
  .pr-bar .seg { flex: 1; min-width: 2px; background: var(--r-edge-hi); }
  .pr-bar .seg.passed { background: var(--r-ok); }
  .pr-bar .seg.running { background: var(--r-warn); }
  .pr-bar .seg.failed { background: var(--r-bad); }
  .pr-bar .seg.skipped { background: var(--r-edge); }
  .pr-frac { flex: none; font-family: var(--r-mono); font-size: 10px; color: var(--r-caption); }
  .pr-glyph { flex: none; width: 16px; height: 16px; color: var(--r-faint); }
  .pr-glyph svg { width: 16px; height: 16px; display: block; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .pr-glyph.ok { color: var(--r-ok); }
  .pr-glyph.bad { color: var(--r-bad); }
  .pr-glyph .badge { stroke-width: 1.8; }
  .pr-checks { margin-top: 6px; padding-top: 4px; border-top: 1px solid var(--r-edge); }
  .pr-check { display: flex; gap: 7px; align-items: baseline; padding: 2px 0; font-size: 11.5px; }
  .pr-check-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-mark { width: 10px; flex: none; font-family: var(--r-mono); color: var(--r-caption); }
  .pr-passed .pr-mark { color: var(--r-ok); }
  .pr-failed .pr-mark { color: var(--r-bad); }
  .pr-running .pr-mark { color: var(--r-warn); }
  button.pr-run { flex: none; font-family: var(--r-mono); font-size: 10.5px; color: var(--r-caption); padding: 0; }
  button.pr-run:hover { color: var(--r-link); text-decoration: underline; }
  .pr-actions { margin-top: 9px; }
  .pr-note { margin-top: 6px; }
  @media (prefers-reduced-motion: reduce) {
    .pr-ring .arc, .pr-ring .chk { animation: none !important; }
  }
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
  .path-link, button.path-link, .link-row a, .wt-name, .footer button, .tl-refresh, .timeline-more, .failures-show {
    text-decoration: underline; text-decoration-color: var(--r-edge-hi); text-underline-offset: 2px;
  }
  .path-link:hover, button.path-link:hover, .link-row a:hover, .wt-name:hover, .footer button:hover, .tl-refresh:hover, .timeline-more:hover {
    text-decoration-color: currentColor;
  }
  /* Glance header (v3): title, model, id, where it runs. */
  .session-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .model-name { font-weight: 600; color: var(--r-text); }
  .id-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
  .id-row .session-chunk { font-size: 10.5px; opacity: .8; }
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
  .sub-open { font-size: 11px; margin: 4px 0 0 13px; background: none; border: 0; padding: 0; color: var(--r-link); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }`;
}
