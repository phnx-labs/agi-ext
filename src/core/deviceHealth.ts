/**
 * Whether a registry device should be treated as online for the "run on…" picker
 * and host lists.
 *
 * Mirrors the CLI exactly (`apps/cli/src/commands/ssh.ts` renderDeviceTable:
 * `offline = d.tailscale && !d.tailscale.online`): a device is offline ONLY when it
 * carries a tailscale block reporting online:false. A device with NO tailscale block
 * — e.g. one registered manually or on the `agents devices sync` ignore-list, which
 * never gets tailscale metadata stamped — is unknown-not-offline, not offline.
 *
 * The previous `d.tailscale?.online ?? false` forced those to offline, diverging from
 * the CLI and showing genuinely-reachable boxes as offline in the picker.
 */
export function isDeviceOnline(tailscale?: { online?: boolean }): boolean {
  return !tailscale || Boolean(tailscale.online)
}
