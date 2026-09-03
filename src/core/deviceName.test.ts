import { describe, test, expect } from 'bun:test';
import { shortenDeviceName } from './deviceName';

describe('shortenDeviceName', () => {
  test('strips a shared hyphen prefix, keeping the unique suffix', () => {
    const roster = ['yosemite-m3', 'yosemite-m2', 'zion'];
    expect(shortenDeviceName('yosemite-m3', roster)).toBe('m3');
    expect(shortenDeviceName('yosemite-m2', roster)).toBe('m2');
    // A peer that shares no prefix is unaffected.
    expect(shortenDeviceName('zion', roster)).toBe('zion');
  });

  test('splits on underscore and space the same way as hyphen', () => {
    expect(shortenDeviceName('yosemite_s1', ['yosemite_s1', 'yosemite_s2'])).toBe('s1');
    expect(shortenDeviceName('yosemite s1', ['yosemite s1', 'yosemite s2'])).toBe('s1');
  });

  test('splits at a camelCase boundary when there is no delimiter', () => {
    expect(shortenDeviceName('yosemiteXYZ', ['yosemiteXYZ', 'yosemiteABC'])).toBe('XYZ');
  });

  test('splits at a letter→digit boundary when there is no delimiter', () => {
    expect(shortenDeviceName('mark1', ['mark1', 'mark2'])).toBe('1');
  });

  test('a delimiter boundary wins over an inner letter→digit boundary', () => {
    // `yosemite-m3` vs `yosemite-m2` share `yosemite-m`; the cut must land on the
    // hyphen (→ `m3`), never on the m→3 transition (→ `3`).
    expect(shortenDeviceName('yosemite-m3', ['yosemite-m3', 'yosemite-m2'])).toBe('m3');
  });

  test('a single device is returned unchanged', () => {
    expect(shortenDeviceName('yosemite-m3', ['yosemite-m3'])).toBe('yosemite-m3');
    expect(shortenDeviceName('yosemite-m3', [])).toBe('yosemite-m3');
  });

  test('no shared prefix leaves the name unchanged', () => {
    expect(shortenDeviceName('zion', ['zion', 'mark', 'bismas-macbook-pro'])).toBe('zion');
  });

  test('never cuts mid-token: peers that diverge before the first delimiter', () => {
    // `mac-mini` and `macbook-air` share only `mac`, which is a mid-token prefix
    // of `macbook` — cutting there would produce `-mini`/`book-air`, so neither
    // is shortened at all.
    const roster = ['mac-mini', 'macbook-air'];
    expect(shortenDeviceName('mac-mini', roster)).toBe('mac-mini');
    expect(shortenDeviceName('macbook-air', roster)).toBe('macbook-air');
  });

  test('strips all shared leading tokens, keeping only the first divergent one', () => {
    expect(shortenDeviceName('yosemite-m3', ['yosemite-m3', 'yosemite-s1'])).toBe('m3');
    expect(shortenDeviceName('a-b-c-x', ['a-b-c-x', 'a-b-c-y'])).toBe('x');
  });

  test('is deterministic and order-independent across a realistic roster', () => {
    const roster = [
      'yosemite-m0', 'yosemite-m1', 'yosemite-m2', 'yosemite-m3',
      'yosemite-s0', 'yosemite-s1', 'zion', 'mark', 'mark-1', 'mark-aws-1',
    ];
    expect(shortenDeviceName('yosemite-m3', roster)).toBe('m3');
    expect(shortenDeviceName('yosemite-m3', [...roster].reverse())).toBe('m3');
    expect(shortenDeviceName('yosemite-s1', roster)).toBe('s1');
    // `mark` diverges from `mark-1` mid-token (`mark` vs `mark-`), and its only
    // boundary lies past the shared span, so it is left whole.
    expect(shortenDeviceName('mark', roster)).toBe('mark');
  });

  test('never renders two distinct devices with the same badge (collision guard)', () => {
    // `prod-m1` and `staging-m1` each share a stem with a same-prefix sibling, so
    // naive per-peer stripping would reduce BOTH to `m1` — indistinguishable in
    // the status bar. The guard keeps the full name for the colliding pair.
    const roster = ['prod-m1', 'prod-m2', 'staging-m1', 'staging-m2'];
    expect(shortenDeviceName('prod-m1', roster)).toBe('prod-m1');
    expect(shortenDeviceName('staging-m1', roster)).toBe('staging-m1');
    // `prod-m2`/`staging-m2` collide the same way, so they keep their full names too.
    expect(shortenDeviceName('prod-m2', roster)).toBe('prod-m2');
  });

  test('falls back to the full name when the suffix collides with a real device name', () => {
    // `pool-web1` would strip to `web1`, but a device literally named `web1`
    // exists — shortening would alias the two, so keep the full name.
    const roster = ['pool-web1', 'pool-web2', 'web1'];
    expect(shortenDeviceName('pool-web1', roster)).toBe('pool-web1');
    expect(shortenDeviceName('pool-web2', roster)).toBe('web2');
  });

  test('an empty name is returned unchanged', () => {
    expect(shortenDeviceName('', ['', 'zion'])).toBe('');
  });
});
