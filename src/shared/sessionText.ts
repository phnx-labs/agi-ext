// What a session list says about one session, derived once from its stream row:
// your latest message, the agent's own latest words, and where it runs. The Fleet
// row (ui/…/recapModel.ts sessionRowView) and the Resume Session picker
// (src/core/sessionPicker.ts) both read these, so the two never disagree.

/** First non-blank string, trimmed; '' when none. */
export function firstText(...values: Array<string | null | undefined>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** First non-blank line of `text`, trimmed. */
export function firstLineOf(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

/** Your latest message: the newest recorded turn, else the CLI's latest request,
 *  else the first turn. '' when the row carries none of them (never a label). */
export function latestUserText(s: {
  userTurns?: ReadonlyArray<{ text: string }>;
  latestRequest?: string | null;
  firstUserMessage?: string | null;
}): string {
  return firstText(s.userTurns?.[s.userTurns.length - 1]?.text, s.latestRequest, s.firstUserMessage);
}

interface TimelineLike {
  steps: ReadonlyArray<{ text: string; source: string }>;
}

/** The newest step the agent itself said (narration or thinking), or ''. */
function latestAgentStep(timeline: TimelineLike | undefined | null): string {
  const steps = timeline?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if ((step.source === 'narration' || step.source === 'thinking') && step.text.trim()) return step.text.trim();
  }
  return '';
}

/** The agent's own latest words: the first reply the row carries, else its newest
 *  narration step. Never the task label; '' when the row has neither. */
export function agentWords(replies: Array<string | null | undefined>, timeline?: TimelineLike | null): string {
  return firstText(...replies, latestAgentStep(timeline));
}

/** `/Users/me/src/github.com/me/repo` -> `~/…/me/repo`; short paths stay whole. */
export function shortFolder(cwd: string | null | undefined): string {
  const raw = (cwd ?? '').trim().replace(/[/\\]+$/, '');
  if (!raw) return '';
  const home = raw.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\[HOME\])(?=\/|$)/, '~');
  const segs = home.split('/').filter(Boolean);
  if (segs.length <= 3) return home;
  return `${home.startsWith('~') ? '~/' : '/'}…/${segs.slice(-2).join('/')}`;
}
