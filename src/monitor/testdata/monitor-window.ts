// One actual extension-host process: real elector, gate, host, socket, producer,
// started through the same `runMonitorHostOnLeader` the extension activates.
//
//   argv: <dir> <selfId> [startAtEpochMs]
//
// A start time lets several windows begin their first election in the same
// millisecond. Every spawned producer appends its pid to `<dir>/producers.log`.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { electLeader, disposeLeader, isLeader, onLeadershipChange } from '../leader';
import { runMonitorHostOnLeader } from '../host';

const [dir, selfId, startAt] = process.argv.slice(2);
const emit = (event: object) => process.stdout.write(JSON.stringify({ selfId, at: Date.now(), ...event }) + '\n');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const producersLog = path.join(dir, 'producers.log');
const livePeerProducer = () => (fs.existsSync(producersLog) ? fs.readFileSync(producersLog, 'utf8') : '')
  .split('\n').filter(Boolean).map(Number).some(alive);

if (startAt) while (Date.now() < Number(startAt)) { /* align the first election tick */ }
electLeader({ selfId, pid: process.pid, leaseFile: path.join(dir, 'lease.json'), heartbeatMs: 10, ttlMs: 60 });
// The first tick runs inside electLeader, before anyone can subscribe.
const leadership = (leader: boolean) => { emit({ type: leader ? 'leader' : 'follower' }); };
leadership(isLeader());
onLeadershipChange(leadership);
const gate = runMonitorHostOnLeader({ socketPath: path.join(dir, 'feed.sock'), sessionStream: {
  enabled: true,
  stopDebounceMs: 50,
  spawnWatch: () => {
    const overlap = livePeerProducer();
    const child = spawn('node', [path.join(__dirname, 'fake-watch.mjs')], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_WATCH_IGNORE_SIGTERM: '1' },
    });
    fs.appendFileSync(producersLog, `${child.pid}\n`);
    child.stderr.on('data', (data) => {
      if (String(data).includes('READY')) {
        emit({ type: 'producer', pid: child.pid, overlap });
        child.stdin.write(`emit ${JSON.stringify({ v: 1, type: 'reset', streamId: 'w', sequence: 1, capturedAt: 1, scope: 'local', agents: [], attention: [] })}\n`);
      }
    });
    child.once('exit', () => emit({ type: 'reaped', pid: child.pid }));
    return child;
  },
} });
emit({ type: 'window', pid: process.pid });
let disposal: Promise<void> | undefined;
const drain = (gateFirst: boolean) => {
  if (!disposal) {
    emit({ type: 'draining' });
    if (gateFirst) void gate.dispose();
    disposal = disposeLeader();
    void disposal.then(() => emit({ type: 'disposed' }), (error) => emit({ type: 'error', message: String(error) }));
  }
  return disposal;
};
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.startsWith('drain')) void drain(line === 'drain gate-first');
  if (line === 'exit') void drain(false).then(() => process.exit(0));
});
process.on('SIGTERM', () => { void drain(false).then(() => process.exit(0)); });
setTimeout(() => { void drain(false).finally(() => process.exit(99)); }, 12_000).unref();
