// Real bounded test double for `agents feed watch --json` (PHNX-3939 tests).
//
// A genuine Node subprocess — spawned over real pipes and reaped like the real
// child — so host.demand.test exercises actual process lifecycle (SIGTERM,
// delayed exit, crash) instead of a hand-rolled EventEmitter that can't leak or
// orphan. Controlled line-by-line over stdin:
//
//   emit <json>   -> write <json> to stdout as one line (a session-CLI event)
//   exit <code>   -> exit immediately with <code> (simulate a crash / clean exit)
//
// On SIGTERM it exits after FAKE_WATCH_SIGTERM_DELAY_MS (default 0) with 143, so a
// test can force the "kill lands, exit is delayed, demand renews meanwhile" race.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function ready(descendantPid) {
  if (process.env.FAKE_WATCH_READY_FILE) writeFileSync(process.env.FAKE_WATCH_READY_FILE,
    JSON.stringify({ pid: process.pid, descendantPid }));
  process.stderr.write('READY\n');
}

const sigtermDelay = Number(process.env.FAKE_WATCH_SIGTERM_DELAY_MS || 0);
process.on('SIGTERM', () => {
  if (process.env.FAKE_WATCH_IGNORE_SIGTERM !== '1') setTimeout(() => process.exit(143), sigtermDelay);
});
// Announce on STDERR (which the stream accumulates but never parses, so it's
// silent) that the SIGTERM handler is now installed. A test that relies on the
// delayed-exit behaviour waits for this before killing — otherwise a SIGTERM
// that lands during Node/bun startup, before this handler exists, kills the child
// immediately with the default disposition and the delay never applies.
if (process.env.FAKE_WATCH_DESCENDANT === '1') {
  const descendant = spawn(process.execPath, [new URL('./watch-descendant.mjs', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  descendant.stdout.once('data', (data) => {
    process.stderr.write(data);
    ready(descendant.pid);
  });
} else ready();

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.startsWith('emit ')) {
      process.stdout.write(line.slice(5) + '\n');
    } else if (line.startsWith('exit ')) {
      process.exit(Number(line.slice(5)) || 0);
    }
  }
});
// Stay alive until stdin closes or we're told to exit / killed.
process.stdin.resume();

// Hard fixture lifetime: a failed test can never leave this producer running forever.
setTimeout(() => process.exit(99), 10_000).unref();
