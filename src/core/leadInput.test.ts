import { describe, expect, test } from 'bun:test';
import { LeadMic, PressGate, type MicPost, type MicState, type Recorder } from './leadInput';

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

/** The reply box's recorder, in memory: one recording, owned by whichever post started it. */
class MemoryRecorder implements Recorder {
  post: MicPost | undefined;
  phase: MicState = 'idle';
  cancelled = 0;
  state(): MicState { return this.phase; }
  async start(post: MicPost): Promise<void> { this.post = post; this.phase = 'listening'; post({ state: 'listening' }); }
  async stop(): Promise<void> { this.phase = 'transcribing'; this.post?.({ state: 'transcribing' }); }
  finish(text: string): void { const p = this.post; this.phase = 'idle'; this.post = undefined; p?.({ state: 'idle', text }); }
  cancelFor(post: MicPost): void { if (this.post === post && this.phase === 'listening') { this.post = undefined; this.phase = 'idle'; this.cancelled++; } }
}

function setup() {
  const rec = new MemoryRecorder();
  const sent: Array<[string, number]> = [];
  const errors: string[] = [];
  let now = 1000;
  const mic = new LeadMic(rec, { text: (t, s) => sent.push([t, s]), error: (e) => errors.push(e), change: () => undefined }, () => now);
  return { rec, mic, sent, errors, advance: (ms: number) => { now += ms; } };
}

describe('LeadMic', () => {
  test('toggle starts, toggle again stops and sends with the spoken seconds', async () => {
    const { rec, mic, sent, advance } = setup();
    expect(await mic.toggle('overlay')).toBe('started');
    expect(mic.state).toBe('listening');
    advance(4000);
    expect(await mic.toggle('overlay')).toBe('stopped');
    expect(mic.state).toBe('transcribing');
    rec.finish('what is waiting');
    expect(sent).toEqual([['what is waiting', 4]]);
    expect(mic.state).toBe('idle');
  });

  test('Esc while listening cancels: the recording is dropped and nothing is sent', async () => {
    const { rec, mic, sent } = setup();
    await mic.toggle('overlay');
    expect(mic.cancel('overlay')).toBe(true);
    expect(rec.cancelled).toBe(1);
    expect(mic.state).toBe('idle');
    rec.finish('late words');
    expect(sent).toEqual([]);
  });

  test('Esc while transcribing drops the result when it lands', async () => {
    const { rec, mic, sent } = setup();
    await mic.toggle('overlay');
    await mic.toggle('overlay');
    const owner = rec.post!;
    expect(mic.cancel('overlay')).toBe(true);
    owner({ state: 'idle', text: 'too late' });
    expect(sent).toEqual([]);
  });

  test('Esc in the overlay leaves a recording the tab started alone', async () => {
    const { mic } = setup();
    await mic.toggle('tab');
    expect(mic.cancel('overlay')).toBe(false);
    expect(mic.state).toBe('listening');
  });

  test("never takes over the reply box's recording", async () => {
    const { rec, mic, errors } = setup();
    const replyBox: MicPost = () => undefined;
    await rec.start(replyBox);
    expect(await mic.toggle('overlay')).toBe('busy');
    expect(rec.post).toBe(replyBox);
    expect(errors[0]).toContain('reply box');
    expect(mic.cancel()).toBe(false);
    expect(rec.post).toBe(replyBox);
  });
});
