// Pure, vscode-free predicates that gate what a webview message is allowed to
// make the extension host do. Webview messages are untrusted input — if the
// React UI is ever injected with hostile content (an XSS, a crafted PR title,
// an agent-supplied path), these allowlists are what stop a single message from
// opening a `file:`/`command:` URL or running an arbitrary VS Code command.
// Kept here (not in src/vscode) so they can be unit-tested without a VS Code
// host.

import { webviewLaunchCommandIds } from './agents';

// Schemes a webview is permitted to open externally. Anything else — `file:`,
// `command:`, `vscode:`, `javascript:`, `data:` — is refused.
const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

// True only if `rawUrl` is a non-empty string that parses to an allowed scheme.
export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.has(scheme);
}

// The dashboard webview only ever dispatches a fixed set of commands: the
// light/dark theme toggle and the registered `agents.new<Harness>` agent-spawn
// commands. Gate the generic `executeCommand` message to exactly that set so an
// injected message cannot run an arbitrary VS Code command (which would include
// shell-spawning ones) — and, just as important, so it cannot fire an
// UNREGISTERED command (a deprecated harness like `agents.newGemini`, or a typo)
// that VS Code answers with a "command not found" toast. The old
// `startsWith('agents.new')` matched both hazards; this exact allowlist matches
// neither. The launch ids come from the same registry the extension registers
// against (webviewLaunchCommandIds → non-deprecated, non-shell harnesses), so
// the allowlist can never drift from what is actually registered.
const ALLOWED_WEBVIEW_COMMANDS: ReadonlySet<string> = new Set<string>([
  'workbench.action.toggleLightDarkThemes',
  ...webviewLaunchCommandIds(),
]);

export function isAllowedWebviewCommand(command: string): boolean {
  return ALLOWED_WEBVIEW_COMMANDS.has(command);
}
