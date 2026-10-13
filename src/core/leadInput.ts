// The Lead's two inputs that need care, without vscode: the ⌥Space key, which
// VS Code delivers as a stream of repeats while held (there is no key-up), and the
// microphone, which is shared with the reply box. src/vscode/lead.vscode.ts wires
// them to the keybinding and to src/vscode/dictation.vscode.ts.

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

export type MicState = 'idle' | 'listening' | 'transcribing';
interface MicUpdate { state: MicState; text?: string; error?: string }
export type MicPost = (u: MicUpdate) => void;

/** The shared recorder (the reply box's dictation), as the Lead sees it. */
export interface Recorder {
  state(): MicState;
  start(post: MicPost): Promise<void>;
  stop(): Promise<void>;
  /** End the recording `post` owns without transcribing; leave anyone else's alone. */
  cancelFor(post: MicPost): void;
}

export type MicOrigin = 'overlay' | 'tab';

/**
 * The Lead's use of the microphone. Toggle starts or stops-and-sends; cancel
 * drops the recording (and any transcription still running) so nothing is sent.
 * Each recording has its own `post`, so a late result from a cancelled one is
 * ignored, and the reply box's recording is never touched.
 */
export class LeadMic {
  state: MicState = 'idle';
  private post: MicPost | undefined;
  private origin: MicOrigin | undefined;

  constructor(
    private readonly rec: Recorder,
    private readonly on: { text(text: string, secs: number): void; error(message: string): void; change(): void },
    private readonly now: () => number = Date.now,
  ) {}

  async toggle(origin: MicOrigin): Promise<'started' | 'stopped' | 'ignored' | 'busy'> {
    if (this.post && this.state === 'listening') { await this.rec.stop(); return 'stopped'; }
    if (this.post) return 'ignored';
    if (this.rec.state() !== 'idle') { this.on.error('The microphone is recording for the reply box; stop that first.'); return 'busy'; }
    const startedAt = this.now();
    const post: MicPost = (u) => {
      if (this.post !== post) return;
      this.state = u.state;
      if (u.state === 'idle') {
        this.post = undefined;
        this.origin = undefined;
        if (u.text) this.on.text(u.text, (this.now() - startedAt) / 1000);
        else if (u.error) this.on.error(u.error);
      }
      this.on.change();
    };
    this.post = post;
    this.origin = origin;
    await this.rec.start(post);
    return 'started';
  }

  /** Drop the Lead's recording started from `origin` (any, when omitted); true when one was dropped. */
  cancel(origin?: MicOrigin): boolean {
    const post = this.post;
    if (!post || (origin && this.origin !== origin)) return false;
    this.post = undefined;
    this.origin = undefined;
    this.state = 'idle';
    this.rec.cancelFor(post);
    this.on.change();
    return true;
  }
}
