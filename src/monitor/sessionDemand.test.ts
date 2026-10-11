// Per-window session-stream demand (PHNX-3939): the union of its sources, with
// change events firing only on a net VALUE flip so a visibility toggle that keeps
// the union true never triggers a redundant report.

import { describe, expect, test } from 'bun:test';
import { SessionStreamDemand } from './sessionDemand';

describe('SessionStreamDemand', () => {
  test('any single source raises demand', () => {
    const d = new SessionStreamDemand();
    expect(d.demand).toBe(false);
    for (const set of [
      (v: boolean) => d.setSidebarVisible(v),
      (v: boolean) => d.setProjectSessionsVisible(v),
      (v: boolean) => d.setResumePickerOpen(v),
      (v: boolean) => d.setUnresolvedTuples(v),
    ]) {
      set(true);
      expect(d.demand).toBe(true);
      set(false);
      expect(d.demand).toBe(false);
    }
  });

  test('demandSinceMs is when demand turned on, cleared when it turns off', () => {
    let clock = 100;
    const d = new SessionStreamDemand(() => clock);
    expect(d.demandSinceMs).toBeUndefined();
    d.setResumePickerOpen(true);
    clock = 200;
    d.setSidebarVisible(true); // union already on: the start stays put
    expect(d.demandSinceMs).toBe(100);
    d.setResumePickerOpen(false);
    d.setSidebarVisible(false);
    expect(d.demandSinceMs).toBeUndefined();
  });

  test('onChange fires only when the union value flips, and stops after unsubscribe', () => {
    const d = new SessionStreamDemand();
    const seen: boolean[] = [];
    const off = d.onChange((v) => seen.push(v));
    d.setProjectSessionsVisible(true); // false -> true : fire true
    d.setSidebarVisible(true);         // union still true : no fire
    d.setProjectSessionsVisible(false);// union still true (sidebar) : no fire
    d.setSidebarVisible(false);        // true -> false : fire false
    expect(seen).toEqual([true, false]);
    off();
    d.setSidebarVisible(true);
    expect(seen).toEqual([true, false]);
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
});
