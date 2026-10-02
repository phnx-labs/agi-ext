// Single source of truth for mapping a cloud-run's raw status string onto the
// four floor statuses the UI understands (used by src/vscode/swarm.vscode.ts).
//
// The switch is the UNION of the two tables that previously diverged, matched
// case-insensitively:
//   running   <- running, in_progress, queued, pending, allocating
//   failed    <- failed, error
//   stopped   <- cancelled, canceled, stopped
//   completed <- completed, needs_review (and any unknown status)

export type CloudStatus = 'running' | 'completed' | 'failed' | 'stopped'

export function mapCloudStatus(s: string): CloudStatus {
  switch ((s || '').toLowerCase()) {
    case 'running':
    case 'in_progress':
    case 'queued':
    case 'pending':
    case 'allocating':
      return 'running'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
    case 'stopped':
      return 'stopped'
    case 'completed':
    case 'needs_review':
      return 'completed'
    default:
      return 'completed'
  }
}
