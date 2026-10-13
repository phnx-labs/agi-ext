// Dictation for the reply box: record the microphone of the machine the editor
// runs on with ffmpeg, then transcribe on that machine with whisper.cpp's
// whisper-cli. Nothing leaves the machine. These are the pure parts; the
// process handling is src/vscode/dictation.vscode.ts.

import * as os from 'os';
import * as path from 'path';

/** Long enough for any reply; the recording stops itself here. */
const DICTATION_MAX_SECONDS = 300;

export const DEFAULT_DICTATION_MODEL = '~/.cache/whisper-models/ggml-large-v3-turbo.bin';

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** ffmpeg's arguments for the default microphone as 16 kHz mono WAV, or null where unsupported. */
export function recordArgs(platform: NodeJS.Platform, file: string): string[] | null {
  const input = platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':default']
    : platform === 'linux' ? ['-f', 'pulse', '-i', 'default']
      : null;
  if (!input) return null;
  return ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-t', String(DICTATION_MAX_SECONDS), '-ac', '1', '-ar', '16000', file];
}

export function transcribeArgs(model: string, file: string): string[] {
  return ['-m', model, '-f', file, '-l', 'auto', '-nt', '-np'];
}

/** whisper-cli prints one segment per line; markers like [BLANK_AUDIO] are not words. */
export function transcriptText(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
