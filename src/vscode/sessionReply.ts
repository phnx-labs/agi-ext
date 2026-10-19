// The one terminal-reply rail.
//
// Delivering text INTO a running agent through its editor-tab terminal has one
// gotcha: Claude Code's Ink TUI ignores the newline `sendText(_, true)` appends
// and needs an explicit carriage return, while every other harness submits on the
// newline. The Active Session sidebar's reply box and the Project panel's front
// card reply box both go through `deliverReply` instead of re-deriving the rule.

import type * as vscode from 'vscode';

/** The minimum an agent terminal must expose to receive a reply. */
export interface ReplyTerminal {
  terminal: Pick<vscode.Terminal, 'sendText' | 'show'>;
  agentType?: string;
}

/**
 * Send one reply into an agent's terminal and focus it.
 *
 * `keystroke` is for an interactive select-list prompt (permission / plan review
 * / AskUserQuestion), where the agent wants a SELECTION, not the option label it
 * would ignore: a digit picks then confirms, 'esc' cancels or denies with no CR.
 */
function sendReplyToTerminal(entry: ReplyTerminal, text: string, keystroke?: string): void {
  const term = entry.terminal;
  if (keystroke) {
    if (keystroke === 'esc') {
      term.sendText('\x1b', false);
    } else {
      term.sendText(keystroke, false);
      term.sendText('\r', false);
    }
  } else if (entry.agentType === 'claude') {
    // Ink needs the explicit CR; the appended newline alone is swallowed.
    term.sendText(text, false);
    term.sendText('\r', false);
  } else {
    term.sendText(text, true);
  }
  term.show();
}

/**
 * A reply box's Enter: send the words into the session's tab, or say why not.
 * null when they went. Both sidebars' reply boxes come here; a session with no
 * tab in this window has no channel, which is said rather than dropped.
 */
export function deliverReply(entry: ReplyTerminal | undefined, text: string): string | null {
  const body = text.trim();
  if (!body) return 'Reply text is empty';
  if (!entry) return 'This session has no terminal here — press Focus first, then reply.';
  try {
    sendReplyToTerminal(entry, body);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
