import type { ChildProcess } from 'child_process';
import { createInterface } from 'readline';

type FixtureEvent = 'READY' | 'SIGTERM' | 'close';
const observed = new WeakMap<ChildProcess, {
  events: Record<FixtureEvent, Promise<void>>;
  closed: boolean;
  stderr: string;
}>();

/** Attach at spawn time: pipe chunks are not necessarily complete READY lines. */
export function observeFixture(child: ChildProcess): void {
  const resolve = {} as Record<FixtureEvent, () => void>;
  const events = Object.fromEntries(['READY', 'SIGTERM', 'close'].map((event) => [
    event, new Promise<void>((done) => { resolve[event as FixtureEvent] = done; }),
  ])) as Record<FixtureEvent, Promise<void>>;
  const state = { events, closed: false, stderr: '' };
  observed.set(child, state);
  const lines = child.stderr ? createInterface({ input: child.stderr }) : undefined;
  lines?.on('line', (line) => {
    state.stderr = (state.stderr + line + '\n').slice(-4096);
    if (line === 'READY' || line === 'SIGTERM') resolve[line]();
  });
  child.once('close', () => {
    state.closed = true;
    lines?.close();
    resolve.close();
  });
}

/** Deadlines fail the test; progress is driven only by real child/pipe events. */
export async function fixtureEvent(child: ChildProcess, event: FixtureEvent): Promise<void> {
  const state = observed.get(child);
  if (!state) throw new Error('Fixture must be observed immediately after spawn');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      state.events[event],
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Fixture ${child.pid}: no ${event}; exit=${child.exitCode}, signal=${child.signalCode}, stderr=${state.stderr}`,
        )), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Failure cleanup also waits for stdio/close, so nothing spills into the next test. */
export async function disposeFixture(child: ChildProcess): Promise<void> {
  if (!observed.get(child)?.closed && child.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  await fixtureEvent(child, 'close');
}
