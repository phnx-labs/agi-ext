// The one terminal-reply rail.
//
// Delivering text INTO a running agent through its editor-tab terminal has one
// gotcha and two callers. The gotcha: Claude Code's Ink TUI ignores the newline
// `sendText(_, true)` appends and needs an explicit carriage return, while every
// other harness submits on the newline. The callers used to be the Fleet detail
// rail's reply box (settings.vscode.ts `replyToAgent`) and the sidebar's slash
// chips; the rail is gone and the sidebar's reply field took its place, so both
// go through here instead of each re-deriving the rule.

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
export function sendReplyToTerminal(entry: ReplyTerminal, text: string, keystroke?: string): void {
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
