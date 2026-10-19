// The reply box's mic: one recording at a time, on the machine the editor runs
// on. Start spawns ffmpeg on the default microphone; stop asks it to finish the
// file ('q' on stdin), runs whisper-cli on it, and hands back the words. Every
// failure is reported in the reply box in full; nothing is retried.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { resolveExecutable } from '../core/binResolve';
import { DEFAULT_DICTATION_MODEL, expandHome, recordArgs, transcribeArgs, transcriptText } from '../core/dictation';

const execFileAsync = promisify(execFile);

type DictationUpdate = { state: 'listening' | 'transcribing' | 'idle'; text?: string; error?: string };
type Post = (u: DictationUpdate) => void;

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).pop() ?? '';

interface Recording { child: ChildProcess; file: string; stderr: string; exited: Promise<number | null>; post: Post; phase: 'recording' | 'transcribing' }

class Dictation {
  private rec: Recording | undefined;

  /** The mic's state, for a webview that was rebuilt mid-recording. */
  state(): DictationUpdate['state'] {
    return !this.rec ? 'idle' : this.rec.phase === 'recording' ? 'listening' : 'transcribing';
  }

  async start(post: Post): Promise<void> {
    // One recording at a time; a second start (a rebuilt webview) re-syncs it instead.
    if (this.rec) { this.rec.post = post; post({ state: this.state() }); return; }
    const fail = (error: string) => post({ state: 'idle', error });
    const ffmpeg = resolveExecutable('ffmpeg');
    if (!ffmpeg) return fail('Dictation needs ffmpeg. Install it with: brew install ffmpeg');
    const file = path.join(os.tmpdir(), `agents-dictation-${process.pid}-${Date.now()}.wav`);
    const args = recordArgs(process.platform, file);
    if (!args) return fail(`Dictation does not support ${process.platform} yet.`);
    const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin?.on('error', () => undefined);
    const rec: Recording = { child, file, stderr: '', exited: new Promise<number | null>((resolve) => { child.on('exit', resolve); child.on('error', () => resolve(-1)); }), post, phase: 'recording' };
    child.stderr?.on('data', (d: Buffer) => { rec.stderr += d.toString(); });
    this.rec = rec;
    post({ state: 'listening' });
    void rec.exited.then((code) => {
      if (this.rec !== rec || rec.phase !== 'recording') return;
      // The recording reached its cap: transcribe what it has.
      if (code === 0) { void this.finish(rec); return; }
      // ffmpeg that cannot open the microphone exits at once; say why.
      this.rec = undefined;
      fs.promises.rm(file, { force: true }).catch(() => undefined);
      rec.post({ state: 'idle', error: `The microphone could not be recorded (ffmpeg exited ${code}): ${lastLine(rec.stderr) || 'no reason given'}. On macOS, allow the editor in System Settings → Privacy & Security → Microphone.` });
    });
  }

  async stop(): Promise<void> {
    const rec = this.rec;
    if (!rec || rec.phase !== 'recording') return;
    rec.child.stdin?.end('q');
    const timer = setTimeout(() => rec.child.kill('SIGINT'), 5000);
    await this.finish(rec);
    clearTimeout(timer);
  }

  private async finish(rec: Recording): Promise<void> {
    if (rec.phase !== 'recording') return;
    rec.phase = 'transcribing';
    rec.post({ state: 'transcribing' });
    try {
      await rec.exited;
      const words = await this.transcribe(rec.file);
      rec.post(words
        ? { state: 'idle', text: words }
        : { state: 'idle', error: 'No words were heard. Check the default microphone, and on macOS that the editor may use it (System Settings → Privacy & Security → Microphone).' });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      rec.post({ state: 'idle', error: `Transcription failed: ${lastLine(err.stderr ?? '') || err.message || String(e)}` });
    } finally {
      if (this.rec === rec) this.rec = undefined;
      fs.promises.rm(rec.file, { force: true }).catch(() => undefined);
    }
  }

  /** Drop the recording `post` owns (the Lead's, on Esc) without transcribing; anyone else's is left alone.
   *  A transcription already running finishes, and its owner ignores the words. */
  cancelFor(post: Post): void {
    const rec = this.rec;
    if (!rec || rec.post !== post || rec.phase !== 'recording') return;
    this.cancel();
  }

  /** The extension is going away: end a recording without transcribing it. */
  cancel(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = undefined;
    rec.phase = 'transcribing';
    rec.child.kill('SIGINT');
    fs.promises.rm(rec.file, { force: true }).catch(() => undefined);
  }

  private async transcribe(file: string): Promise<string> {
    const whisper = resolveExecutable('whisper-cli');
    if (!whisper) throw new Error('Dictation needs whisper.cpp. Install it with: brew install whisper-cpp');
    const setting = vscode.workspace.getConfiguration('agents').get<string>('dictation.model') || DEFAULT_DICTATION_MODEL;
    const model = expandHome(setting);
    if (!fs.existsSync(model)) throw new Error(`No whisper model at ${model}. Download one (for example ggml-large-v3-turbo.bin) or set agents.dictation.model.`);
    const { stdout } = await execFileAsync(whisper, transcribeArgs(model, file), { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return transcriptText(stdout);
  }
}

export const dictation = new Dictation();

/** A reply box's mic, from either sidebar: `dictationState` asks where a recording
 *  stands (a rebuilt box), `dictate` starts (`on: true`) or stops one. The words go
 *  back to the webview that started it. */
export function dictationMessage(msg: { type?: unknown; on?: unknown }, webview: vscode.Webview): void {
  if (msg.type === 'dictationState') void webview.postMessage({ type: 'dictation', state: dictation.state() });
  else if (msg.type === 'dictate' && msg.on === true) void dictation.start((update) => { void webview.postMessage({ type: 'dictation', ...update }); });
  else if (msg.type === 'dictate' && msg.on === false) void dictation.stop();
}
