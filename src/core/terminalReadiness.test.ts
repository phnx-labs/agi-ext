import { describe, test, expect } from 'bun:test';
import {
  createEntry,
  markEvent,
  resetFrom,
  waitFor,
  dispose,
  hasFired,
  READINESS_ORDER,
} from './terminalReadiness';

describe('terminalReadiness', () => {
  test('a mark cascades to every lower event and never overwrites an earlier timestamp', () => {
    const e = createEntry();
    for (const ev of READINESS_ORDER) expect(hasFired(e, ev)).toBe(false);
    markEvent(e, 'tabReady', 100);
    markEvent(e, 'promptReady', 300);
    markEvent(e, 'promptReady', 5000);
    expect(e.state).toMatchObject({ tabReadyAt: 100, shellReadyAt: 300, promptReadyAt: 300, agentReadyAt: null });
    markEvent(e, 'agentReady', 2000);
    expect(e.state.agentReadyAt).toBe(2000);
  });

  test('waitFor resolves at once for a fired event, else every waiter on the fire', async () => {
    const e = createEntry();
    const waiters = [waitFor(e, 'agentReady'), waitFor(e, 'agentReady')];
    markEvent(e, 'promptReady');
    await expect(waitFor(e, 'shellReady')).resolves.toBeUndefined();
    setTimeout(() => markEvent(e, 'agentReady'), 5);
    await Promise.all(waiters);
  });

  test('waitFor rejects on timeout, unless the event fires first', async () => {
    await expect(waitFor(createEntry(), 'promptReady', { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    const e = createEntry();
    setTimeout(() => markEvent(e, 'promptReady'), 5);
    await expect(waitFor(e, 'promptReady', { timeoutMs: 100 })).resolves.toBeUndefined();
  });

  test('resetFrom clears the given event and all higher ones, and a later waitFor re-arms', async () => {
    const e = createEntry();
    markEvent(e, 'agentReady', 100);
    resetFrom(e, 'promptReady');
    expect(e.state).toMatchObject({ tabReadyAt: 100, shellReadyAt: 100, promptReadyAt: null, agentReadyAt: null });
    let resolved = false;
    const p = waitFor(e, 'agentReady').then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    markEvent(e, 'agentReady');
    await p;
    expect(resolved).toBe(true);
  });

  test('dispose rejects pending and later waiters, and later marks are no-ops', async () => {
    const e = createEntry();
    const pending = waitFor(e, 'agentReady');
    dispose(e, 'terminal closed');
    await expect(pending).rejects.toThrow(/terminal closed/);
    await expect(waitFor(e, 'tabReady')).rejects.toThrow();
    markEvent(e, 'promptReady');
    expect(e.state.promptReadyAt).toBe(null);
  });
});
