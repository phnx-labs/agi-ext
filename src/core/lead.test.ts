import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LeadClient, ageText, answerLines, applyLeadEvent, linkify, newTurn, parseLeadHistory, parseLeadLine,
  isWebUrl, nextSurface, parseLeadStatus, parseSurface, readSurface, readSurfaceFile, summaryOf, uniqueRefs, watchSurface, writeSurface,
  type LeadEvent, type LeadRef,
} from './lead';

const STUB = path.join(import.meta.dir, 'testdata', 'lead-bin', 'agents');
const stubBin = () => Promise.resolve(STUB);

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

describe('parseLeadLine: the ask --json stream', () => {
  test('parses every event type in the contract', () => {
    const lines = [
      '{"type":"turn","turn":"t_1","project":"rush","session":"s1","engine":"warm"}',
      '{"type":"status","state":"thinking"}',
      '{"type":"tool","id":"u1","label":"agents ps","cmd":"agents ps --json","state":"run"}',
      '{"type":"tool","id":"u1","label":"agents ps","state":"ok","secs":1.24}',
      '{"type":"text","delta":"Two "}',
      '{"type":"confirm","token":"c_1","action":"stop","sessionId":"abc","label":"Stop “x”"}',
      '{"type":"done","turn":"t_1","text":"Two wait.","summary":"Two wait.","refs":[{"kind":"ticket","id":"PHNX-1"},{"kind":"pr","repo":"o/r","number":7,"url":"https://github.com/o/r/pull/7"},{"kind":"session","id":"s9","title":"T","host":"m6"}],"timing":{"boot":0,"model":1.45,"tools":1.24}}',
      '{"type":"error","message":"boom"}',
    ];
    const events = lines.map(parseLeadLine);
    expect(events.map((e) => e?.type)).toEqual(['turn', 'status', 'tool', 'tool', 'text', 'confirm', 'done', 'error']);
    const done = events[6] as Extract<LeadEvent, { type: 'done' }>;
    expect(done.refs).toEqual([
      { kind: 'ticket', id: 'PHNX-1' },
      { kind: 'pr', repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
      { kind: 'session', id: 's9', title: 'T', host: 'm6' },
    ]);
    expect(done.timing).toEqual({ boot: 0, model: 1.45, tools: 1.24 });
  });

  test('drops what is not a contract event', () => {
    for (const l of ['', 'hello', '{bad json', '[]', '{"type":"nope"}', '{"type":"status","state":"dancing"}', '{"type":"tool","id":"x","state":"maybe"}', '{"type":"confirm","label":"no token"}']) {
      expect(parseLeadLine(l)).toBeNull();
    }
  });

  test('drops malformed refs and derives a missing summary', () => {
    const e = parseLeadLine('{"type":"done","turn":"t","text":"First sentence. Second.","refs":[{"kind":"pr","repo":"o/r"},{"kind":"ticket"},null,{"kind":"ticket","id":"A-1"}]}');
    expect(e).toEqual({ type: 'done', turn: 't', text: 'First sentence. Second.', summary: 'First sentence.', refs: [{ kind: 'ticket', id: 'A-1' }] });
  });
});

test('summaryOf keeps the first sentence, at most 80 characters', () => {
  expect(summaryOf('Created 3 in Rush. Say more.')).toBe('Created 3 in Rush.');
  expect(summaryOf('x'.repeat(200)).length).toBe(80);
});

test('applyLeadEvent builds the turn: tool rows update in place, text accumulates, done finishes it', () => {
  const t = newTurn('what is waiting?', 1000);
  const evs = [
    '{"type":"turn","turn":"t_1","project":"rush","session":"s1","engine":"cold"}',
    '{"type":"tool","id":"u1","label":"agents ps","state":"run"}',
    '{"type":"text","delta":"Hello "}',
    '{"type":"tool","id":"u1","label":"agents ps","state":"ok","secs":1.2}',
    '{"type":"text","delta":"world."}',
    '{"type":"confirm","token":"c","action":"stop","label":"Stop it"}',
    '{"type":"confirm","token":"c","action":"stop","label":"Stop it"}',
  ].map((l) => parseLeadLine(l)!);
  for (const e of evs) applyLeadEvent(t, e, 2000);
  expect(t.tools).toEqual([{ id: 'u1', label: 'agents ps', state: 'ok', secs: 1.2 }]);
  expect(t.text).toBe('Hello world.');
  expect(t.engine).toBe('cold');
  expect(t.confirms.length).toBe(1);
  expect(t.finished).toBe(false);
  applyLeadEvent(t, { type: 'done', turn: 't_1', text: 'Hello world.', summary: 'Hello world.', refs: [] }, 3000);
  expect(t.finished).toBe(true);
  expect(t.endedAt).toBe(3000);
});

describe('linkify', () => {
  const refs: LeadRef[] = [
    { kind: 'ticket', id: 'PHNX-4365', url: 'https://linear.app/x/PHNX-4365' },
    { kind: 'pr', repo: 'phnx-labs/agents', number: 3607 },
    { kind: 'session', id: 'abc', title: 'E2B Pro upgrade', host: 'm6' },
  ];

  test('links ticket ids, PR numbers in refs and session titles, and keeps the text around them', () => {
    const segs = linkify('E2B Pro upgrade waits on PHNX-4365 (#3607), and PHNX-9 too.', refs);
    expect(segs.map((s) => s.kind === 'ref' ? `[${s.text}]` : s.text).join('')).toBe('[E2B Pro upgrade] waits on [PHNX-4365] ([#3607]), and [PHNX-9] too.');
    const tk = segs.find((s) => s.kind === 'ref' && s.text === 'PHNX-4365');
    expect(tk && tk.kind === 'ref' && tk.ref).toEqual(refs[0]);
    const bare = segs.find((s) => s.kind === 'ref' && s.text === 'PHNX-9');
    expect(bare && bare.kind === 'ref' && bare.ref).toEqual({ kind: 'ticket', id: 'PHNX-9' });
  });

  test('a PR number with no ref stays text; so does a hash inside a word', () => {
    const segs = linkify('See #12 and abc#3607.', refs);
    expect(segs.every((s) => s.kind === 'text')).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe('See #12 and abc#3607.');
  });

  test('names that look like ids stay text unless the turn named one with that prefix', () => {
    const text = 'UTF-8, SHA-256, GPT-4 and HTTP-2 are fine; PHNX-12 is next.';
    expect(linkify(text, []).every((s) => s.kind === 'text')).toBe(true);
    const linked = linkify(text, refs).filter((s) => s.kind === 'ref').map((s) => s.text);
    expect(linked).toEqual(['PHNX-12']);
    expect(linkify('ENG-7 and ENG-8', [], ['ENG']).filter((s) => s.kind === 'ref').map((s) => s.text)).toEqual(['ENG-7', 'ENG-8']);
  });

  test('round-trips the text exactly', () => {
    const text = 'PHNX-4365PHNX-1 #3607 E2B Pro upgradeE2B Pro upgrade';
    expect(linkify(text, refs).map((s) => s.text).join('')).toBe(text);
  });

  test('uniqueRefs keeps one row per ref', () => {
    expect(uniqueRefs([...refs, { kind: 'ticket', id: 'PHNX-4365' }]).length).toBe(3);
  });
});

test('answerLines splits the answer into one row per sentence', () => {
  expect(answerLines('Two wait on you. One is stuck!\nAsk me?')).toEqual(['Two wait on you.', 'One is stuck!', 'Ask me?']);
  expect(answerLines('v1.2 shipped')).toEqual(['v1.2 shipped']);
});

test('ageText', () => {
  expect(ageText(1000)).toBe('now');
  expect(ageText(42_000)).toBe('42s');
  expect(ageText(5 * 60_000)).toBe('5m');
  expect(ageText(3 * 3600_000)).toBe('3h');
  expect(ageText(2 * 86400_000)).toBe('2d');
});

test('parseLeadHistory accepts NDJSON, an array or { turns }', () => {
  const one = { turn: 't', at: '2026-10-13T08:00:00Z', ask: 'q', text: 'PHNX-1 done. More.', refs: [{ kind: 'ticket', id: 'PHNX-1' }], tools: [{ label: 'linear', state: 'ok', secs: 0.7 }] };
  for (const out of [JSON.stringify(one) + '\n' + JSON.stringify(one), JSON.stringify([one, one]), JSON.stringify({ turns: [one, one] })]) {
    const h = parseLeadHistory(out);
    expect(h.length).toBe(2);
    expect(h[0].summary).toBe('PHNX-1 done.');
    expect(h[0].at).toBe(Date.parse('2026-10-13T08:00:00Z'));
    expect(h[0].tools[0]).toEqual({ id: '0', label: 'linear', state: 'ok', secs: 0.7 });
  }
  expect(parseLeadHistory('')).toEqual([]);
});

test('parseLeadStatus reads one project, from an object or a list', () => {
  const s = parseLeadStatus(JSON.stringify({ project: 'rush', state: 'warm', session: 's', engine: 'warm', brief: 'a\n- b', memory: ['m'], allowedTools: ['agents ps'] }), 'rush');
  expect(s).toEqual({ project: 'rush', state: 'warm', session: 's', engine: 'warm', brief: ['a', 'b'], memory: ['m'], tools: ['agents ps'] });
  expect(parseLeadStatus(JSON.stringify([{ project: 'x', state: 'warm' }, { project: 'rush', state: 'cold' }]), 'rush')?.state).toBe('cold');
  expect(parseLeadStatus('nope', 'rush')).toBeNull();
});

test('refs keep only http(s) urls and owner/repo PRs', () => {
  expect(isWebUrl('https://linear.app/x')).toBe(true);
  for (const u of ['mailto:a@b.c', 'command:workbench.action.reloadWindow', 'file:///etc/passwd', 'javascript:alert(1)', 'nope']) expect(isWebUrl(u)).toBe(false);
  const e = parseLeadLine('{"type":"done","turn":"t","text":"x","refs":[{"kind":"ticket","id":"A-1","url":"command:x"},{"kind":"pr","repo":"../evil","number":1}]}');
  expect(e && e.type === 'done' && e.refs).toEqual([{ kind: 'ticket', id: 'A-1' }]);
});

describe('the surface switch', () => {
  test('a malformed file keeps the last known surface; no file means docked', () => {
    expect(nextSurface('invalid', 'bubble')).toBe('bubble');
    expect(nextSurface('absent', 'bubble')).toBe('docked');
    expect(nextSurface('docked', 'bubble')).toBe('docked');
  });

  test('the watcher keeps the last value through a malformed write', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-surface-'));
    try {
      writeSurface('bubble', home);
      const seen: string[] = [];
      const w = watchSurface((s) => seen.push(s), home, { absentPollMs: 30 });
      const file = path.join(home, '.agents', 'lead', 'surface.json');
      fs.writeFileSync(file, '{"surface":"bub');
      expect(readSurfaceFile(home)).toBe('invalid');
      await Bun.sleep(150);
      expect(seen).toEqual([]);
      fs.writeFileSync(file, '{"surface":"docked"}');
      for (let i = 0; i < 50 && !seen.length; i++) await Bun.sleep(20);
      expect(seen).toEqual(['docked']);
      w.dispose();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing folder is not created; the watcher notices when it appears, and after it is removed and recreated', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-surface-'));
    try {
      const seen: string[] = [];
      const w = watchSurface((s) => seen.push(s), home, { absentPollMs: 30, rearmMs: 30 });
      await Bun.sleep(80);
      expect(fs.existsSync(path.join(home, '.agents', 'lead'))).toBe(false);
      writeSurface('bubble', home);
      for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(20);
      expect(seen).toEqual(['bubble']);
      fs.rmSync(path.join(home, '.agents', 'lead'), { recursive: true, force: true });
      for (let i = 0; i < 100 && seen.length < 2; i++) await Bun.sleep(20);
      expect(seen).toEqual(['bubble', 'docked']);
      writeSurface('bubble', home);
      for (let i = 0; i < 100 && seen.length < 3; i++) await Bun.sleep(20);
      expect(seen).toEqual(['bubble', 'docked', 'bubble']);
      w.dispose();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('parseSurface accepts only the two surfaces', () => {
    expect(parseSurface('{"surface":"bubble"}')).toBe('bubble');
    expect(parseSurface('{"surface":"docked"}')).toBe('docked');
    expect(parseSurface('{"surface":"orb"}')).toBeNull();
    expect(parseSurface('')).toBeNull();
  });

  test('no file means docked; writing bubble is read back and announced to a watcher', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-surface-'));
    try {
      expect(readSurface(home)).toBe('docked');
      const seen: string[] = [];
      const w = watchSurface((s) => seen.push(s), home, { absentPollMs: 30 });
      writeSurface('bubble', home);
      expect(JSON.parse(fs.readFileSync(path.join(home, '.agents', 'lead', 'surface.json'), 'utf8'))).toEqual({ surface: 'bubble' });
      expect(readSurface(home)).toBe('bubble');
      for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(20);
      expect(seen).toEqual(['bubble']);
      // Another client docks it again.
      fs.writeFileSync(path.join(home, '.agents', 'lead', 'surface.json'), '{"surface":"docked"}');
      for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(20);
      expect(seen).toEqual(['bubble', 'docked']);
      w.dispose();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('LeadClient against the fake `agents lead`', () => {
  test('ask streams a turn, keeps the last summary and passes the contract argv', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lead-log-')), 'argv');
    await withEnv({ LEAD_STUB_LOG: log }, async () => {
      const client = new LeadClient({ resolveBin: stubBin, now: () => 5000 });
      const busy: boolean[] = [];
      client.onChange((s) => busy.push(s.busy));
      const turn = await client.ask('rush', '-what is waiting', 6);
      expect(turn.error).toBeUndefined();
      expect(turn.finished).toBe(true);
      expect(turn.tools).toEqual([{ id: 'u1', label: 'agents ps', cmd: 'agents ps --json', state: 'ok', secs: 1.24 }]);
      expect(turn.text).toContain('You asked: -what is waiting');
      expect(turn.refs.length).toBe(3);
      expect(client.snapshot().last).toEqual({ summary: 'Two sessions wait on you.', at: 5000 });
      expect(client.snapshot().session).toBe('lead-sess-1');
      expect(client.busy).toBe(false);
      expect(busy[0]).toBe(true);
      expect(busy[busy.length - 1]).toBe(false);
      const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim());
      expect(argv).toEqual(['lead', 'ask', '--project', 'rush', '--voice', '6.0', '--json', '--', '-what is waiting']);
    });
  });

  test('a Confirm runs `agents lead confirm <token> --json` and marks its row done', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lead-log-')), 'argv');
    await withEnv({ LEAD_STUB_LOG: log }, async () => {
      const client = new LeadClient({ resolveBin: stubBin });
      const asked = await client.ask('rush', 'stop the stuck one');
      expect(asked.confirms).toEqual([{ token: 'c_9', action: 'stop', sessionId: 'abc12345', label: 'Stop “E2B Pro upgrade”', state: 'open' }]);
      const done = await client.confirm('c_9');
      expect(done.text).toBe('Stopped E2B Pro upgrade.');
      expect(asked.confirms[0].state).toBe('done');
      expect(client.snapshot().turns.length).toBe(1);
      expect(client.snapshot().last?.summary).toBe('Stopped E2B Pro upgrade.');
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(calls[1]).toEqual(['lead', 'confirm', 'c_9', '--json']);
    });
  });

  test('an expired token fails its Confirm row with the CLI message', async () => {
    const client = new LeadClient({ resolveBin: stubBin });
    const done = await client.confirm('c_old');
    expect(done.error).toBe('confirm token c_old expired');
  });

  test('a CLI that dies mid-turn ends the turn with its stderr, never hangs', async () => {
    await withEnv({ LEAD_STUB_MODE: 'crash' }, async () => {
      const turn = await new LeadClient({ resolveBin: stubBin }).ask('rush', 'hi');
      expect(turn.finished).toBe(true);
      expect(turn.error).toBe('lead host socket closed');
    });
  });

  test('a CLI without the lead noun is an upgrade error', async () => {
    await withEnv({ LEAD_STUB_MODE: 'nolead' }, async () => {
      const turn = await new LeadClient({ resolveBin: stubBin }).ask('rush', 'hi');
      expect(turn.error).toContain('Upgrade agents-cli');
      await expect(new LeadClient({ resolveBin: stubBin }).history('rush')).rejects.toThrow('Upgrade agents-cli');
    });
  });

  test('history and status read the stub', async () => {
    const client = new LeadClient({ resolveBin: stubBin });
    const h = await client.history('rush', 5);
    expect(h.map((t) => t.summary)).toEqual(['PHNX-4371 is new.']);
    const s = await client.status('rush');
    expect(s?.session).toBe('lead-sess-1');
    expect(s?.memory).toEqual(['Text only, no speech.', 'Stop needs a click.']);
  });

  test('a line split across stdout chunks is parsed once whole', async () => {
    await withEnv({ LEAD_STUB_MODE: 'chunked' }, async () => {
      const turn = await new LeadClient({ resolveBin: stubBin }).ask('rush', 'hi');
      expect(turn.error).toBeUndefined();
      expect(turn.text).toBe('Split PHNX-1 line.');
      expect(turn.refs).toEqual([{ kind: 'ticket', id: 'PHNX-1' }]);
    });
  });

  test('a child killed by a signal ends the turn and names the signal', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lead-pid-')), 'pid');
    await withEnv({ LEAD_STUB_MODE: 'hang', LEAD_STUB_PID: pidFile }, async () => {
      const client = new LeadClient({ resolveBin: stubBin });
      const asked = client.ask('rush', 'hi');
      for (let i = 0; i < 100 && !client.snapshot().current?.turn; i++) await Bun.sleep(20);
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      const turn = await asked;
      expect(turn.finished).toBe(true);
      expect(turn.error).toContain('SIGKILL');
    });
  });

  test('a silent child is killed after the idle timeout', async () => {
    await withEnv({ LEAD_STUB_MODE: 'hang' }, async () => {
      const t0 = Date.now();
      const turn = await new LeadClient({ resolveBin: stubBin, idleMs: 200 }).ask('rush', 'hi');
      expect(turn.error).toContain('printed nothing');
      expect(Date.now() - t0).toBeLessThan(5000);
    });
  });

  test('the overall cap stops a turn that keeps running', async () => {
    await withEnv({ LEAD_STUB_MODE: 'hang' }, async () => {
      const turn = await new LeadClient({ resolveBin: stubBin, maxMs: 200 }).ask('rush', 'hi');
      expect(turn.error).toContain('ran past');
    });
  });

  test('dispose SIGTERMs an unfinished child', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lead-pid-')), 'pid');
    await withEnv({ LEAD_STUB_MODE: 'hang', LEAD_STUB_PID: pidFile }, async () => {
      const client = new LeadClient({ resolveBin: stubBin });
      const asked = client.ask('rush', 'hi');
      for (let i = 0; i < 100 && !client.snapshot().current?.turn; i++) await Bun.sleep(20);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      client.dispose();
      const turn = await asked;
      expect(turn.error).toContain('window closed');
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  test('hasOpenConfirm knows only open rows of known turns', async () => {
    const client = new LeadClient({ resolveBin: stubBin });
    expect(client.hasOpenConfirm('c_9')).toBe(false);
    await client.ask('rush', 'stop it');
    expect(client.hasOpenConfirm('c_9')).toBe(true);
    expect(client.hasOpenConfirm('c_forged')).toBe(false);
    await client.confirm('c_9');
    expect(client.hasOpenConfirm('c_9')).toBe(false);
  });

  test('a second ask while busy is refused', async () => {
    const client = new LeadClient({ resolveBin: stubBin });
    const first = client.ask('rush', 'one');
    await expect(client.ask('rush', 'two')).rejects.toThrow('still working');
    await first;
  });
});
