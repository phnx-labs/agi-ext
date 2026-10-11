// Per-window session-stream demand (PHNX-3939).
//
// One window "demands" the canonical `agents feed watch` producer while it is
// actually showing live session state — its Fleet dashboard, its active-session
// sidebar or its Project Sessions view is visible, or its Resume Session picker is open — or while it holds a tracked agent terminal whose identity
// isn't resolved yet (the stream is what attributes it). The elected leader gates
// the single producer on the UNION of every window's demand (host.ts), so an
// idle, hidden window contributes nothing and the watcher stays torn down.
//
// Kept vscode-free (a tiny observable boolean) so it unit-tests without the
// extension host and so settings/agentPanel/extension can share one source of
// truth instead of each hand-rolling a flag.

export class SessionStreamDemand {
  private dashboardVisible = false;
  private sidebarVisible = false;
  private projectSessionsVisible = false;
  private resumePickerOpen = false;
  private unresolvedTuples = false;
  private readonly listeners = new Set<(demand: boolean) => void>();
  private last = false;
  private since: number | undefined;
  constructor(private readonly now: () => number = Date.now) {}

  /** When the net demand last turned on; undefined while this window demands nothing.
   *  Views bound their wait for slow machines from here (src/core/streamWait.ts). */
  get demandSinceMs(): number | undefined {
    return this.since;
  }

  /** True when this window currently needs the producer. */
  get demand(): boolean {
    return this.dashboardVisible || this.sidebarVisible || this.projectSessionsVisible || this.resumePickerOpen || this.unresolvedTuples;
  }

  setDashboardVisible(visible: boolean): void {
    if (this.dashboardVisible === visible) return;
    this.dashboardVisible = visible;
    this.notify();
  }

  setSidebarVisible(visible: boolean): void {
    if (this.sidebarVisible === visible) return;
    this.sidebarVisible = visible;
    this.notify();
  }

  /** The Project container's Sessions view draws stream rows (PHNX-4289). */
  setProjectSessionsVisible(visible: boolean): void {
    if (this.projectSessionsVisible === visible) return;
    this.projectSessionsVisible = visible;
    this.notify();
  }

  /** The "Agents: Resume Session…" picker lists stream rows while it is open. */
  setResumePickerOpen(open: boolean): void {
    if (this.resumePickerOpen === open) return;
    this.resumePickerOpen = open;
    this.notify();
  }

  /** Whether this window holds a tracked agent terminal still awaiting identity. */
  setUnresolvedTuples(unresolved: boolean): void {
    if (this.unresolvedTuples === unresolved) return;
    this.unresolvedTuples = unresolved;
    this.notify();
  }

  /** Fire `cb` only when the net demand VALUE flips, so a visibility toggle that
   *  doesn't change the union (e.g. sidebar hides while dashboard stays visible)
   *  never triggers a redundant report. Returns an unsubscribe. */
  onChange(cb: (demand: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    const now = this.demand;
    if (now === this.last) return;
    this.last = now;
    this.since = now ? this.now() : undefined;
    for (const cb of this.listeners) {
      try { cb(now); } catch { /* a listener must never wedge demand tracking */ }
    }
  }
}

/** Process-singleton — one extension host == one VS Code window. */
export const sessionStreamDemand = new SessionStreamDemand();
