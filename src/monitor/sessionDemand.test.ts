// Per-window session-stream demand (PHNX-3939): the union of three sources, with
// change events firing only on a net VALUE flip so a visibility toggle that keeps
// the union true never triggers a redundant report.

import { describe, expect, test } from 'bun:test';
import { SessionStreamDemand } from './sessionDemand';

describe('SessionStreamDemand', () => {
  test('starts with no demand', () => {
    expect(new SessionStreamDemand().demand).toBe(false);
  });

  test('any single source raises demand', () => {
    const d = new SessionStreamDemand();
    d.setDashboardVisible(true);
    expect(d.demand).toBe(true);
    d.setDashboardVisible(false);
    expect(d.demand).toBe(false);
    d.setUnresolvedTuples(true);
    expect(d.demand).toBe(true);
    d.setUnresolvedTuples(false);
    d.setResumePickerOpen(true);
    expect(d.demand).toBe(true);
    d.setResumePickerOpen(false);
    expect(d.demand).toBe(false);
  });

  test('demandSinceMs is when demand turned on, cleared when it turns off', () => {
    let clock = 100;
    const d = new SessionStreamDemand(() => clock);
    expect(d.demandSinceMs).toBeUndefined();
    d.setResumePickerOpen(true);
    clock = 200;
    d.setDashboardVisible(true); // union already on: the start stays put
    expect(d.demandSinceMs).toBe(100);
    d.setResumePickerOpen(false);
    d.setDashboardVisible(false);
    expect(d.demandSinceMs).toBeUndefined();
  });

  test('onChange fires only when the union value flips', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    d.onChange((v) => seen.push(v));

    d.setDashboardVisible(true);   // false -> true : fire true
    d.setSidebarVisible(true);     // union still true : no fire
    d.setDashboardVisible(false);  // union still true (sidebar) : no fire
    d.setSidebarVisible(false);    // true -> false : fire false

    expect(seen).toEqual([true, false]);
  });

  test('unsubscribe stops delivery', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    const off = d.onChange((v) => seen.push(v));
    d.setDashboardVisible(true);
    off();
    d.setDashboardVisible(false);
    expect(seen).toEqual([true]);
  });

  test('a throwing listener never wedges demand tracking', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    d.onChange(() => { throw new Error('boom'); });
    d.onChange((v) => seen.push(v));
    d.setSidebarVisible(true);
    expect(seen).toEqual([true]);
    expect(d.demand).toBe(true);
  });

  test('setting the same value is a no-op (no event)', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    d.onChange((v) => seen.push(v));
    d.setDashboardVisible(false); // already false
    d.setUnresolvedTuples(false); // already false
    expect(seen).toEqual([]);
  });
  test('the Project Sessions view is a demand source of its own (PHNX-4289)', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    d.onChange((v) => seen.push(v));
    d.setProjectSessionsVisible(true);
    expect(d.demand).toBe(true);
    d.setSidebarVisible(true);
    d.setProjectSessionsVisible(false);
    expect(d.demand).toBe(true);
    d.setSidebarVisible(false);
    expect(d.demand).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
