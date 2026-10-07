// A harness writes some turns on its own behalf: a background task reporting back
// (`<task-notification>`), a reminder it injects (`<system-reminder>`), the echo of a
// local slash command. They reach the row as user turns, timeline steps or the live
// now-line, but they are neither your words nor the agent's work, so the panel and
// Fleet never present them as such.
const ENVELOPE = /^<(task-notification|system-reminder|local-command-(stdout|stderr|caveat))\b/;

export function isHarnessEnvelope(text: string): boolean {
  return ENVELOPE.test(text.trimStart());
}
