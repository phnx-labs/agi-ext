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
 * The boundary-safe suffix of `name` after stripping the longest prefix it
 * shares with any PEER, without regard to whether that suffix is unique. The
 * public `shortenDeviceName` layers a collision guard on top of this.
 */
function sharedPrefixSuffix(name: string, allNames: readonly string[]): string {
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
 * Collision guard: the whole point of the badge is to say WHICH box, so a
 * shortening is only applied when it stays unambiguous. If the stripped suffix
 * would collide with another device's suffix or full name — e.g. `prod-m1` and
 * `staging-m1` both reducing to `m1` — every colliding name keeps its full name
 * instead. Deterministic: the same roster always yields the same result.
 *
 * Information guard: a badge has to be readable as a machine, so an all-digit
 * suffix is rejected too. `{mark, mark-1}` would strip to `1`, and `$(vm) 1`
 * names nothing a user can act on, so `mark-1` stays whole. The letter→digit
 * boundary still cuts wherever it leaves a letter behind (`mark1a` → `1a`).
 */
/**
 * The status-bar badge for a remote session's executing device: the shortened
 * name, resolved against the roster the caller already holds. The caller owns
 * the "is this actually a remote device?" question — this is pure presentation.
 */
export function deviceBadge(host: string, rosterNames: readonly string[]): string {
  // A host absent from the roster cache (a peer registered since the last
  // refresh) still has to shorten against its peers, so count it as its own
  // peer rather than shortening against a roster it is missing from.
  const names = rosterNames.includes(host) ? rosterNames : [...rosterNames, host];
  return shortenDeviceName(host, names);
}

export function shortenDeviceName(name: string, allNames: readonly string[]): string {
  if (!name) return name;
  const suffix = sharedPrefixSuffix(name, allNames);
  if (suffix === name) return name;
  if (!/[A-Za-z]/.test(suffix)) return name;

  for (const other of allNames) {
    if (!other || other === name) continue;
    // Collides with a real device's own name, or with the suffix that device
    // would itself display — either way the badge would no longer identify the
    // box, so fall back to the unambiguous full name.
    if (other === suffix || sharedPrefixSuffix(other, allNames) === suffix) {
      return name;
    }
  }
  return suffix;
}
