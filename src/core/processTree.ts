// Shared process-group teardown for the one-shot CLI helpers (commitgen,
// draftPrompt, prewarm.simple).
//
// `child.kill()` only signals the direct pid. In the agents-cli 1.22.85
// incident an `agents run claude` child fork-bombed `secrets __serve`; every
// caller below killed only the direct pid, so the runaway grandchildren were
// orphaned instead of reaped -> swap exhaustion -> crash. Every caller that
// spawns a killable `agents`/harness child MUST pass `detached: true` on
// POSIX (making the child its own process-group leader) so this helper can
// reclaim the whole subtree instead of just the one process.
//
// This is deliberately a lighter contract than sessionCliStream.ts's own
// `terminateProducer`/`signalGroup`: that stream is a long-lived producer
// whose stop() must await full OS reap before releasing ownership. The
// callers here are bounded one-shot helpers that already run under their own
// overall timeout, so a fire-and-forget best-effort group kill is enough —
// no caller needs to await this settling before moving on.

import type { ChildProcess } from 'child_process';

export function killProcessTree(child: ChildProcess, graceMs = 500): void {
  const pid = child.pid;
  if (!pid) return;

  const signal = (sig: NodeJS.Signals): void => {
    try {
      // Negative pid targets the whole process group `detached: true` made
      // this child the leader of. Windows has no such semantics — killing the
      // direct process is all `child.kill()` there can do (see the win32
      // branch in sessionCliStream.ts's terminateProducer).
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return; // already gone
      // EPERM or another surprise: fall back to the direct pid so at least
      // that one process is reclaimed instead of throwing out of a kill path.
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };

  signal('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signal('SIGKILL');
  }, graceMs);
  timer.unref?.();
}
