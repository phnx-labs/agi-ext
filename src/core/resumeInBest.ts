// Shared logic for resuming sessions into agent terminals: builds the /continue
// input for the resume flows; buildAgentLaunchCommand composes the launch. Lives
// in core/ so it can be unit-tested without VS Code.
//
// NOTE: version PICKING for rotations no longer lives here — the resume paths
// delegate host/harness/account selection to `agents run auto` (RUSH-2132).

/**
 * Convert the central `continue.md` body into a self-contained prompt for
 * versions that don't have the slash command synced to their home dir.
 * Strips the YAML frontmatter and substitutes `$ARGUMENTS` with the session
 * id. Callers prefix with a resume marker so the agent treats it as one
 * continuation task.
 */
export function inlineContinueInstructions(
  continueMdBody: string,
  sessionId: string
): string {
  const withoutFrontmatter = continueMdBody.replace(/^---[\s\S]*?\n---\s*\n/, '');
  return withoutFrontmatter.replace(/\$ARGUMENTS/g, sessionId).trim();
}

/**
 * Build the text the resume flow types into the agent's TUI prompt to make
 * it load the OLD session's transcript. Prefers the `/continue` slash
 * command when it's synced to the target version's home; falls back to the
 * inlined body of the central continue.md; last resort is a terse
 * instruction string.
 */
export function buildResumeInput(
  oldSessionId: string,
  hasContinueCmd: boolean,
  centralContinueMdBody: string | null
): string {
  if (hasContinueCmd) {
    return `/continue ${oldSessionId}`;
  }
  if (centralContinueMdBody) {
    return inlineContinueInstructions(centralContinueMdBody, oldSessionId);
  }
  return `Resume previous work by loading session ${oldSessionId}. Run \`sessions ${oldSessionId} --markdown\` to load the transcript, assess current state, then continue working.`;
}
