import { describe, test, expect } from 'bun:test';
import { isDeviceOnline } from './deviceHealth';

describe('isDeviceOnline', () => {
  // Regression: a reachable box (manually registered, or on the sync ignore-list)
  // has no tailscale block. The old `?? false` forced it offline in the picker while
  // the CLI showed it online. It must be treated as online, matching the CLI.
  test('missing tailscale block is online (matches CLI), not offline', () => {
    expect(isDeviceOnline(undefined)).toBe(true);
  });
  test('tailscale online:true is online', () => {
    expect(isDeviceOnline({ online: true })).toBe(true);
  });
  test('tailscale online:false is the only offline case', () => {
    expect(isDeviceOnline({ online: false })).toBe(false);
  });
  test('present block with undefined online is offline (matches CLI truthiness)', () => {
    expect(isDeviceOnline({})).toBe(false);
  });
});
