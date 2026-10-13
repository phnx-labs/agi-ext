import { describe, expect, test } from 'bun:test';
import { MIC_IDLE, PressGate, nextMic, type MicEffect, type MicEvent, type MicMachine, type MicUpdate } from './leadInput';

describe('PressGate: a held key is one press', () => {
  test('a repeat stream after the OS initial delay is one press, however long', () => {
    const g = new PressGate(200, 600);
    expect(g.press(0)).toBe(true);
    // macOS: first repeat after ~500 ms, then every ~33 ms, for 3 s.
    expect(g.press(500)).toBe(false);
    for (let t = 533; t < 3500; t += 33) expect(g.press(t)).toBe(false);
  });

  test('dropped repeats still slide the window', () => {
    const g = new PressGate(200, 600);
    g.press(0);
    for (let t = 400; t <= 2000; t += 150) expect(g.press(t)).toBe(false);
    expect(g.press(2050)).toBe(false);
  });

  test('a deliberate second press after a real gap toggles', () => {
    const g = new PressGate(200, 600);
    expect(g.press(0)).toBe(true);
    expect(g.press(1500)).toBe(true);
    // Held, released, pressed again.
    expect(g.press(1950)).toBe(false);
    expect(g.press(1980)).toBe(false);
    expect(g.press(2600)).toBe(true);
  });
});

function run(events: MicEvent[], from: MicMachine = MIC_IDLE): { state: MicMachine; effects: MicEffect[][] } {
  let state = from;
  const effects: MicEffect[][] = [];
  for (const e of events) { const r = nextMic(state, e); state = r.state; effects.push(r.effects); }
  return { state, effects };
}

const toggle = (origin: 'overlay' | 'tab', now: number, recorderBusy = false): MicEvent => ({ kind: 'toggle', origin, now, recorderBusy });
const update = (id: number, u: MicUpdate, now = 0): MicEvent => ({ kind: 'update', id, update: u, now });

describe('nextMic: the Lead mic as a pure machine', () => {
  test('toggle starts, toggle again stops, the words are sent with the spoken seconds', () => {
    const r = run([
      toggle('overlay', 1000),
      update(1, { state: 'listening' }),
      toggle('overlay', 5000),
      update(1, { state: 'transcribing' }),
      update(1, { state: 'idle', text: 'what is waiting' }, 5000),
    ]);
    expect(r.effects).toEqual([[{ kind: 'start', id: 1 }], [], [{ kind: 'stop' }], [], [{ kind: 'send', text: 'what is waiting', secs: 4 }]]);
    expect(r.state).toEqual({ phase: 'idle', startedAt: 0, nextId: 2 });
  });

  test('Esc while listening cancels that recording; its late words are dropped, not sent', () => {
    const r = run([toggle('overlay', 0), update(1, { state: 'listening' }), { kind: 'cancel', origin: 'overlay' }, update(1, { state: 'idle', text: 'late words' })]);
    expect(r.effects).toEqual([[{ kind: 'start', id: 1 }], [], [{ kind: 'cancel', id: 1 }], [{ kind: 'drop' }]]);
    expect(r.state.phase).toBe('idle');
    expect(r.state.active).toBeUndefined();
  });

  test('Esc while transcribing drops the result when it lands', () => {
    const r = run([toggle('overlay', 0), toggle('overlay', 10), update(1, { state: 'transcribing' }), { kind: 'cancel', origin: 'overlay' }, update(1, { state: 'idle', text: 'too late' })]);
    expect(r.effects.flat().some((fx) => fx.kind === 'send')).toBe(false);
    expect(r.effects[4]).toEqual([{ kind: 'drop' }]);
  });

  test('Esc in the overlay leaves a recording the tab started alone', () => {
    const r = run([toggle('tab', 0), { kind: 'cancel', origin: 'overlay' }]);
    expect(r.effects[1]).toEqual([]);
    expect(r.state.phase).toBe('listening');
    expect(run([toggle('tab', 0), { kind: 'cancel' }]).effects[1]).toEqual([{ kind: 'cancel', id: 1 }]);
  });

  test("never starts over the reply box's recording", () => {
    const r = run([toggle('overlay', 0, true)]);
    expect(r.effects[0]).toEqual([{ kind: 'error', message: 'The microphone is recording for the reply box; stop that first.' }]);
    expect(r.state).toEqual(MIC_IDLE);
    // And a cancel with nothing of ours running touches nothing.
    expect(run([{ kind: 'cancel' }]).effects[0]).toEqual([]);
  });

  test('a toggle while transcribing does nothing; a new recording gets a new id', () => {
    const r = run([toggle('overlay', 0), toggle('overlay', 1), update(1, { state: 'transcribing' }), toggle('overlay', 2), update(1, { state: 'idle', error: 'no words' }), toggle('overlay', 3)]);
    expect(r.effects[3]).toEqual([]);
    expect(r.effects[4]).toEqual([{ kind: 'error', message: 'no words' }]);
    expect(r.effects[5]).toEqual([{ kind: 'start', id: 2 }]);
  });
});
