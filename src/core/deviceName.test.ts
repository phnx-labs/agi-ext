import { describe, test, expect } from 'bun:test';
import { shortenDeviceName, deviceBadge } from './deviceName';

describe('shortenDeviceName', () => {
  test('strips every shared leading token at a hyphen, underscore, space, camelCase or letter→digit boundary', () => {
    const cases: Array<[string, string[], string]> = [
      ['yosemite-m3', ['yosemite-m3', 'yosemite-m2', 'zion'], 'm3'],
      ['zion', ['yosemite-m3', 'yosemite-m2', 'zion'], 'zion'],
      ['yosemite_s1', ['yosemite_s1', 'yosemite_s2'], 's1'],
      ['yosemite s1', ['yosemite s1', 'yosemite s2'], 's1'],
      ['yosemiteXYZ', ['yosemiteXYZ', 'yosemiteABC'], 'XYZ'],
      ['mark1a', ['mark1a', 'mark2a'], '1a'],
      ['a-b-c-x', ['a-b-c-x', 'a-b-c-y'], 'x'],
      // A delimiter boundary wins over the inner m→3 transition.
      ['yosemite-m3', ['yosemite-m3', 'yosemite-s1'], 'm3'],
    ];
    for (const [name, roster, badge] of cases) expect(shortenDeviceName(name, roster)).toBe(badge);
  });

  test('leaves a name whole when alone, empty, or when peers diverge mid-token', () => {
    expect(shortenDeviceName('yosemite-m3', ['yosemite-m3'])).toBe('yosemite-m3');
    expect(shortenDeviceName('yosemite-m3', [])).toBe('yosemite-m3');
    expect(shortenDeviceName('', ['', 'zion'])).toBe('');
    // `mac` is a mid-token prefix of `macbook`: cutting there would produce `-mini`/`book-air`.
    expect(shortenDeviceName('mac-mini', ['mac-mini', 'macbook-air'])).toBe('mac-mini');
  });

  test('never reduces a device to an all-digit badge', () => {
    // `mark1`/`mark2` would cut to `1`/`2`; `$(vm) 1` names no machine a user can act on.
    expect(shortenDeviceName('mark1', ['mark1', 'mark2'])).toBe('mark1');
    expect(shortenDeviceName('mark2', ['mark', 'mark2'])).toBe('mark2');
    const fleet = ['mark', 'mark-1', 'mark-aws-1'];
    expect(shortenDeviceName('mark-1', fleet)).toBe('mark-1');
    expect(shortenDeviceName('mark-aws-1', fleet)).toBe('aws-1');
  });

  test('is deterministic and order-independent across a realistic roster', () => {
    const roster = [
      'yosemite-m0', 'yosemite-m1', 'yosemite-m2', 'yosemite-m3',
      'yosemite-s0', 'yosemite-s1', 'zion', 'mark', 'mark-1', 'mark-aws-1',
    ];
    expect(shortenDeviceName('yosemite-m3', roster)).toBe('m3');
    expect(shortenDeviceName('yosemite-m3', [...roster].reverse())).toBe('m3');
    // `mark` diverges from `mark-1` mid-token, so it is left whole.
    expect(shortenDeviceName('mark', roster)).toBe('mark');
  });

  test('never renders two devices with the same badge, or a badge that is another device\'s name', () => {
    // Naive per-peer stripping would reduce both prod-m1 and staging-m1 to `m1`.
    const roster = ['prod-m1', 'prod-m2', 'staging-m1', 'staging-m2'];
    expect(shortenDeviceName('prod-m1', roster)).toBe('prod-m1');
    expect(shortenDeviceName('staging-m1', roster)).toBe('staging-m1');
    // `pool-web1` would strip to `web1`, which is a real device.
    expect(shortenDeviceName('pool-web1', ['pool-web1', 'pool-web2', 'web1'])).toBe('pool-web1');
    expect(shortenDeviceName('pool-web2', ['pool-web1', 'pool-web2', 'web1'])).toBe('web2');
  });
});

describe('deviceBadge', () => {
  const roster = ['yosemite-m1', 'yosemite-m2', 'zion'];

  test('shortens against the roster the caller holds, even for a host the cache has not seen', () => {
    expect(deviceBadge('yosemite-m1', roster)).toBe('m1');
    // `yosemite-m9` registered after the last roster refresh: it still collapses the stem.
    expect(deviceBadge('yosemite-m9', roster)).toBe('m9');
    expect(deviceBadge('yosemite-m9', [])).toBe('yosemite-m9');
  });

  test('does not mutate the caller\'s roster', () => {
    const held = [...roster];
    deviceBadge('yosemite-m9', held);
    expect(held).toEqual(roster);
  });
});
