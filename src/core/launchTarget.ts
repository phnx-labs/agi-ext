// Where a `New <Harness>` command runs — the one place the setting is read and
// turned into launch options (no VS Code import, so it is unit-testable).
//
// The extension does NOT score devices. `auto` emits `--device auto` and the
// CLI answers it from the automatic-placement pool, which is an allowlist over
// the devices marked `agents devices role <name> worker` (see the CLI's
// lib/devices/pool.ts). That keeps one placement rule for the whole fleet
// instead of a second, drifting copy in the UI layer.

import { buildAgentLaunchCommand } from './agents';

/** The configured default target for the per-harness New commands. */
export type LaunchTarget = 'auto' | 'local' | 'ask';

/** The default when the setting is unset: rotate over the fleet's worker pool. */
export const DEFAULT_LAUNCH_TARGET: LaunchTarget = 'auto';

const TARGETS: readonly LaunchTarget[] = ['auto', 'local', 'ask'];

/**
 * Read a configured value into a target. Anything unrecognized (including an
 * unset setting) falls to {@link DEFAULT_LAUNCH_TARGET} — a launch the user just
 * triggered must not be blocked by a typo in settings.json, and `auto` is the
 * documented default behavior.
 */
export function resolveLaunchTarget(value: unknown): LaunchTarget {
  return typeof value === 'string' && (TARGETS as readonly string[]).includes(value)
    ? (value as LaunchTarget)
    : DEFAULT_LAUNCH_TARGET;
}

/** The subset of LaunchAgentOpts a target decides. */
export interface LaunchTargetOpts {
  local?: boolean;
  pickHost?: boolean;
  /**
   * Show a project quickpick and land the agent in the picked project's path on
   * an auto-selected worker (`--device auto` + `--project <slug>`). It never
   * prompts for a host — placement stays automatic — so it is orthogonal to
   * {@link pickHost}. launchAgent resolves the slug from the pick and threads it
   * through as the launch's `--project`; the CLI owns the remote cwd from there.
   */
  pickProject?: boolean;
}

export type HarnessLaunchVariant =
  | 'default'
  | 'pick-host'
  | 'auto'
  | 'pick-project'
  | 'pick-account';

/** Launch choices layered on top of placement for per-harness palette commands. */
export interface HarnessLaunchOpts extends LaunchTargetOpts {
  accountPicker?: true;
}

/** Inputs shared by every command that routes through the extension's one launch engine. */
export interface NewAgentLaunchOpts extends LaunchTargetOpts {
  agentKey?: string;
  host?: string;
  accountPicker?: boolean;
}

export interface HarnessLaunchRegistration {
  commandId: string;
  variant: HarnessLaunchVariant;
  launchOptions: () => NewAgentLaunchOpts;
}

/**
 * Launch options for a target. `auto` sets neither flag: that is what makes
 * buildAgentLaunchCommand emit `--device auto` (see launchAgent's `isLocal`).
 */
export function launchOptsForTarget(target: LaunchTarget): LaunchTargetOpts {
  switch (target) {
    case 'local':
      return { local: true };
    case 'ask':
      return { pickHost: true };
    case 'auto':
      return {};
  }
}

/**
 * Keep the five per-harness command variants distinct. Pick Host and Pick Account
 * are the orthogonal pair — each pins ONE placement axis and lets the CLI balance
 * the other:
 *
 * - default: configured placement, balanced account — no prompt at all;
 * - pick-host: ask for the DEVICE, then balance the account on it — `--strategy
 *   balanced`, no account prompt. Balancing weighs each account's usage headroom
 *   where the CLI can read it and falls back to an unverified weight on a worker
 *   whose long-term setup-token exposes no usage;
 * - auto: let agents-cli choose both the device and account without a prompt;
 * - pick-project: auto device + balanced account (like auto), but first ask
 *   which project to land in — the only prompt is the project quickpick, never
 *   a host prompt;
 * - pick-account: pin the ACCOUNT and auto-pick the device — the trailing-`@`
 *   account picker on `--device auto`. The CLI routes to a picker-eligible worker
 *   and shows its interactive account picker there; a sign-in-required account is
 *   selectable and authenticates in place. Orthogonal to pick-host, which pins the
 *   device instead.
 *
 * The bare `New <Harness>` is the command bound to a keybinding and pressed
 * dozens of times a day, so it must open an agent, not a question: RUSH-2961
 * put the account picker on it and every launch then stopped on a seven-row
 * prompt. Explicit choice lives on `(Pick Host)` / `(Pick Account)`, which are
 * already the "I am being specific about this launch" routes.
 */
export function launchOptsForHarnessCommand(
  variant: HarnessLaunchVariant,
  defaultTarget: LaunchTarget = DEFAULT_LAUNCH_TARGET,
): HarnessLaunchOpts {
  switch (variant) {
    case 'default':
      return { ...launchOptsForTarget(defaultTarget) };
    case 'pick-host':
      return { pickHost: true };
    case 'auto':
      return {};
    case 'pick-project':
      return { pickProject: true };
    case 'pick-account':
      return { accountPicker: true };
  }
}

/**
 * The five registered commands for one harness. The default target is read by
 * the callback so a settings change applies without reloading the editor.
 * Pick Account is appended last so the existing positional order (default,
 * pick-host, auto, pick-project) that callers and tests index into is unchanged.
 */
export function harnessLaunchRegistrations(
  agentKey: string,
  commandId: string,
  getDefaultTarget: () => LaunchTarget,
): HarnessLaunchRegistration[] {
  return [
    {
      commandId,
      variant: 'default',
      launchOptions: () => ({
        agentKey,
        ...launchOptsForHarnessCommand('default', getDefaultTarget()),
      }),
    },
    {
      commandId: `${commandId}PickHost`,
      variant: 'pick-host',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('pick-host') }),
    },
    {
      commandId: `${commandId}Auto`,
      variant: 'auto',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('auto') }),
    },
    {
      commandId: `${commandId}PickProject`,
      variant: 'pick-project',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('pick-project') }),
    },
    {
      commandId: `${commandId}PickAccount`,
      variant: 'pick-account',
      launchOptions: () => ({ agentKey, ...launchOptsForHarnessCommand('pick-account') }),
    },
  ];
}

/** Build the final shell command used by launchAgent after any host prompt resolves. */
export function buildNewAgentLaunchCommand(
  options: NewAgentLaunchOpts,
  context: {
    defaultModel?: string;
    cwd?: string;
    projectSlug?: string;
    /**
     * Caller-minted session id (Claude only). buildAgentLaunchCommand emits
     * `--session-id` for it, which is what arms the auto-label poller and lets the
     * status bar / Resume / Fork key off the tab from the first tick (PHNX-2553).
     * Left null for harnesses that coin their own id.
     */
    sessionId?: string | null;
  } = {},
): string {
  const agent = options.agentKey ?? 'auto';
  const isLocal = options.local === true || (options.pickHost === true && !options.host);
  // A project is a destination the user explicitly selected, never an
  // attribution inferred from the open workspace. Keeping this authorization
  // check here prevents any caller from silently narrowing a monorepo cwd.
  const project = options.pickProject === true ? context.projectSlug : undefined;
  return buildAgentLaunchCommand(
    agent,
    context.sessionId ?? null,
    context.defaultModel,
    undefined,
    undefined,
    options.accountPicker ? undefined : 'balanced',
    'auto',
    {
      host: options.host,
      local: isLocal,
      accountPicker: options.accountPicker,
      project,
      cwd: project ? undefined : context.cwd,
    },
  );
}
