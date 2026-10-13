import { test, expect } from 'bun:test';
import { expandHome, recordArgs, transcribeArgs, transcriptText } from './dictation';

test('records the default microphone per platform as 16 kHz mono, and refuses an unsupported one', () => {
  expect(recordArgs('darwin', '/tmp/a.wav')).toEqual(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', ':default', '-t', '300', '-ac', '1', '-ar', '16000', '/tmp/a.wav']);
  expect(recordArgs('linux', '/tmp/a.wav')?.slice(4, 8)).toEqual(['-f', 'pulse', '-i', 'default']);
  expect(recordArgs('win32', '/tmp/a.wav')).toBeNull();
});

test('transcribes without timestamps or progress, and keeps only the words', () => {
  expect(transcribeArgs('/m.bin', '/tmp/a.wav')).toEqual(['-m', '/m.bin', '-f', '/tmp/a.wav', '-l', 'auto', '-nt', '-np']);
  expect(transcriptText(' Show the checks count on the PR card.\n and open GitHub when I click it.\n')).toBe('Show the checks count on the PR card. and open GitHub when I click it.');
  expect(transcriptText('[BLANK_AUDIO]\n')).toBe('');
  expect(transcriptText(' (wind blowing)\n')).toBe('');
});

test('a model path may start at home', () => {
  expect(expandHome('~/.cache/m.bin', '/Users/me')).toBe('/Users/me/.cache/m.bin');
  expect(expandHome('/abs/m.bin', '/Users/me')).toBe('/abs/m.bin');
});
