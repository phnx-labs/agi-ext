// The Lead's two inputs that need care, as pure logic: the ⌥Space key, which VS
// Code delivers as a stream of repeats while held (there is no key-up), and the
// microphone, which is shared with the reply box. src/vscode/lead.vscode.ts feeds
// them timestamps and recorder updates and performs the mic's effects on
// src/vscode/dictation.vscode.ts.

/**
 * One physical press of a key, from a stream of command invocations. Every
 * invocation, dropped or not, slides the window, so a held key is one press
 * however long it is held. The first repeat comes after the OS's initial delay
 * (macOS 225 ms to 2 s, commonly about 500 ms), so the window after a press is
 * `firstRepeatMs`; between repeats it is `repeatMs`.
 */
export class PressGate {
  private lastAt = -Infinity;
  private repeating = false;

  constructor(private readonly repeatMs = 200, private readonly firstRepeatMs = 600) {}

  /** True for a new press; false for a repeat of the one before. */
  press(now: number): boolean {
    const gap = now - this.lastAt;
    const window = this.repeating ? this.repeatMs : this.firstRepeatMs;
    this.lastAt = now;
    if (gap <= window) { this.repeating = true; return false; }
    this.repeating = false;
    return true;
  }
}

type MicState = 'idle' | 'listening' | 'transcribing';
export interface MicUpdate { state: MicState; text?: string; error?: string }
export type MicOrigin = 'overlay' | 'tab';

/**
 * The Lead's use of the shared microphone (the reply box's dictation), as a pure
 * transition: `nextMic(state, event)` returns the next state and the effects the
 * vscode layer performs against the real recorder. Each recording has an id, so a
 * late update from a cancelled one is dropped, and the Lead never starts while the
 * reply box is recording.
 */
export interface MicMachine {
  phase: MicState;
  /** The id of the Lead's recording in progress, if any. */
  active?: number;
  origin?: MicOrigin;
  startedAt: number;
  nextId: number;
}

export type MicEvent =
  /** The mic button or ⌥Space; `recorderBusy` is true when the recorder is busy with someone else's recording. */
  | { kind: 'toggle'; origin: MicOrigin; now: number; recorderBusy: boolean }
  /** Esc (from `origin`), or teardown (any origin). */
  | { kind: 'cancel'; origin?: MicOrigin }
  /** What the recorder said about recording `id`. */
  | { kind: 'update'; id: number; update: MicUpdate; now: number };

export type MicEffect =
  | { kind: 'start'; id: number }
  | { kind: 'stop' }
  | { kind: 'cancel'; id: number }
  | { kind: 'send'; text: string; secs: number }
  | { kind: 'error'; message: string }
  | { kind: 'drop' };

export const MIC_IDLE: MicMachine = { phase: 'idle', startedAt: 0, nextId: 1 };

export function nextMic(s: MicMachine, e: MicEvent): { state: MicMachine; effects: MicEffect[] } {
  switch (e.kind) {
    case 'toggle':
      if (s.active !== undefined) return s.phase === 'listening' ? { state: s, effects: [{ kind: 'stop' }] } : { state: s, effects: [] };
      if (e.recorderBusy) return { state: s, effects: [{ kind: 'error', message: 'The microphone is recording for the reply box; stop that first.' }] };
      return { state: { phase: 'listening', active: s.nextId, origin: e.origin, startedAt: e.now, nextId: s.nextId + 1 }, effects: [{ kind: 'start', id: s.nextId }] };
    case 'cancel':
      if (s.active === undefined || (e.origin && e.origin !== s.origin)) return { state: s, effects: [] };
      return { state: { phase: 'idle', startedAt: 0, nextId: s.nextId }, effects: [{ kind: 'cancel', id: s.active }] };
    case 'update': {
      if (e.id !== s.active) return { state: s, effects: [{ kind: 'drop' }] };
      if (e.update.state !== 'idle') return { state: { ...s, phase: e.update.state }, effects: [] };
      const idle: MicMachine = { phase: 'idle', startedAt: 0, nextId: s.nextId };
      if (e.update.text) return { state: idle, effects: [{ kind: 'send', text: e.update.text, secs: (e.now - s.startedAt) / 1000 }] };
      return { state: idle, effects: e.update.error ? [{ kind: 'error', message: e.update.error }] : [] };
    }
  }
}
