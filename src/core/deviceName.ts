// Pure presentation helpers for device (machine) names shown in the UI.
//
// The status bar shows the executing device for an offloaded/remote session. A
// fleet often names its boxes with a shared stem — `yosemite-m1`, `yosemite-m2`,
// `yosemite-s1` — so the stem is pure noise in a badge. `shortenDeviceName`
// strips the prefix that a device shares with at least one PEER, cutting only at
// a real token boundary so a name is never sliced mid-token.
//
// Thin-client rule (AGENTS.md): pure, deterministic, no I/O. The caller supplies
// the known-device roster it already holds; this file never fetches anything.

function isDelimiter(ch: string): boolean {
  return ch === '-' || ch === '_' || ch === ' ';
}

/**
 * Token-start indices in `name` (0 < i < name.length) reached by crossing a
 * delimiter run — `-`, `_`, or space. Stripping up to such an index removes the
 * trailing delimiter too, so `yosemite-m3` cut here yields `m3`, never `-m3`.
 */
function delimiterCuts(name: string): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < name.length; i++) {
    if (isDelimiter(name[i - 1]) && !isDelimiter(name[i])) cuts.push(i);
  }
  return cuts;
}

/**
 * Token-start indices at a camelCase (lower/digit → upper) or letter→digit
 * transition, i.e. the boundaries that exist when a name has NO delimiter
 * (`yosemiteXYZ` → `yosemite|XYZ`, `mark1` → `mark|1`). Only consulted when a
 * delimiter boundary is absent from the shared span, so a delimited name's
 * inner digit boundary (the `3` of `yosemite-m3`) never overrides its delimiter.
 */
function softCuts(name: string): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < name.length; i++) {
    const prev = name[i - 1];
    const cur = name[i];
    if (isDelimiter(prev) || isDelimiter(cur)) continue;
    const camel = /[a-z0-9]/.test(prev) && /[A-Z]/.test(cur);
    const letterToDigit = /[A-Za-z]/.test(prev) && /[0-9]/.test(cur);
    if (camel || letterToDigit) cuts.push(i);
  }
  return cuts;
}

/** Length of the longest common character prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * The largest boundary index `<= limit` at which `name`'s shared prefix can be
 * cut. Delimiter boundaries win outright; a soft boundary is used only when the
 * shared span holds no delimiter boundary at all.
 */
function boundaryCutWithin(delims: number[], softs: number[], limit: number): number {
  let best = 0;
  for (const cut of delims) {
    if (cut <= limit && cut > best) best = cut;
  }
  if (best > 0) return best;
  for (const cut of softs) {
    if (cut <= limit && cut > best) best = cut;
  }
  return best;
}

/**
 * Shorten a device name by stripping the prefix it shares with a PEER device,
 * cut at a real token boundary (delimiter, camelCase, or letter→digit).
 *
 * - `{yosemite-m3, yosemite-m2, zion}` → `yosemite-m3` shows as `m3`.
 * - `yosemite_s1` / `yosemite s1` split the same way → `s1`.
 * - `yosemiteXYZ` (no delimiter) splits at the case boundary → `XYZ`.
 * - One device, or no shared prefix (`{mac-mini, macbook-air}`, which diverge
 *   before any delimiter) → the full name, unchanged. Never a mid-token slice.
 *
 * Deterministic: the same roster always yields the same result.
 */
export function shortenDeviceName(name: string, allNames: readonly string[]): string {
  if (!name) return name;
  const peers = allNames.filter((other) => other && other !== name);
  if (peers.length === 0) return name;

  const delims = delimiterCuts(name);
  const softs = softCuts(name);

  let cut = 0;
  for (const peer of peers) {
    const shared = commonPrefixLength(name, peer);
    if (shared === 0) continue;
    const peerCut = boundaryCutWithin(delims, softs, shared);
    if (peerCut > cut) cut = peerCut;
  }

  if (cut === 0) return name;
  const suffix = name.slice(cut).replace(/^[-_ ]+/, '');
  return suffix || name;
}
