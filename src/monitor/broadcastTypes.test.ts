import { describe, expect, test } from 'bun:test';
import {
  encodeFrame,
  FrameDecoder,
  isMonitorFrame,
  MonitorEvent,
} from './broadcastTypes';

function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    type: 'test.fact',
    payload: { hello: 'world' },
    ts: 1726000000000,
    ...overrides,
  };
}

describe('isMonitorFrame', () => {
  test('accepts each valid frame kind', () => {
    expect(
      isMonitorFrame({ kind: 'event', event: makeEvent() })
    ).toBe(true);
    expect(
      isMonitorFrame({ kind: 'request', id: 1, payload: { op: 'x' } })
    ).toBe(true);
    expect(isMonitorFrame({ kind: 'response', id: 1, payload: 42 })).toBe(true);
    expect(
      isMonitorFrame({ kind: 'response', id: 1, error: 'boom' })
    ).toBe(true);
  });

  test('rejects scalars, unknown discriminants and frames missing required fields', () => {
    for (const bad of [
      null, 42, 'event', [{ kind: 'event' }], {},
      { kind: 'nope', event: makeEvent() },
      { kind: 'event', event: { type: 'x', ts: 1 } }, // no payload
      { kind: 'event', event: { type: 'x', payload: 1, ts: 'now' } }, // ts not numeric
      { kind: 'request', id: '1', payload: 1 },
      { kind: 'response' }, // no id
      { kind: 'response', id: 1, error: 500 }, // error not a string
    ]) {
      expect(isMonitorFrame(bad)).toBe(false);
    }
  });
});

describe('FrameDecoder', () => {
  test('decodes multiple frames from one chunk and preserves order', () => {
    const decoder = new FrameDecoder();
    const line1 = encodeFrame({ kind: 'request', id: 1, payload: 'a' });
    const line2 = encodeFrame({ kind: 'event', event: makeEvent() });
    const frames = decoder.push(line1 + line2);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ kind: 'request', id: 1, payload: 'a' });
    expect(frames[1].kind).toBe('event');
  });

  test('reassembles a frame split across chunks', () => {
    const decoder = new FrameDecoder();
    const line = encodeFrame({ kind: 'response', id: 7, payload: { ok: true } });
    expect(decoder.push(line.slice(0, 5))).toEqual([]);
    expect(decoder.push(line.slice(5, 20))).toEqual([]);
    const frames = decoder.push(line.slice(20));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'response', id: 7, payload: { ok: true } });
  });

  test('drops malformed and structurally invalid lines, skips blank ones, and keeps decoding', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      'not json\n' + JSON.stringify(null) + '\n\n' +
        '{"kind":"request","payload":1}\n' + // missing id
        encodeFrame({ kind: 'request', id: 2, payload: 'b' }) + '\n',
    );
    expect(frames).toEqual([{ kind: 'request', id: 2, payload: 'b' }]);
    expect(decoder.droppedCount).toBe(3);
  });

  test('a large fragmented session-reset-shaped frame decodes across chunks', () => {
    const decoder = new FrameDecoder();
    // Shape mirrors the CLI stream reset replayed to followers: a versioned
    // envelope whose payload carries a full floor of per-session rows. The
    // producer defines no max frame size, so this stays well past 1 MB —
    // the size class that a decoder-side ceiling would have amputated.
    const rows = Array.from({ length: 3500 }, (_, i) => ({
      sessionId: `sess-${i}`,
      phase: 'working',
      label: `Session ${i} doing a reasonably long task label`,
      host: 'zion',
      timeline: Array.from({ length: 12 }, (_, j) => ({
        t: 1726000000000 + j * 1000,
        kind: 'activity',
        text: `step ${j} of the plan with some detail text`,
      })),
      files: Array.from({ length: 8 }, (_, j) => `/tmp/proj/file-${j}.ts`),
    }));
    const resetLine = encodeFrame({
      kind: 'event',
      event: {
        type: 'session.cli',
        payload: { v: 1, type: 'reset', streamId: 'main', sequence: 1, rows },
        ts: 1726000000000,
      },
    });
    expect(resetLine.length).toBeGreaterThan(1024 * 1024);

    // Delivered in 16 KiB chunks like a real socket read pattern.
    const frames: unknown[] = [];
    for (let i = 0; i < resetLine.length; i += 16 * 1024) {
      frames.push(...decoder.push(resetLine.slice(i, i + 16 * 1024)));
    }
    expect(frames).toHaveLength(1);
    const frame = frames[0] as {
      kind: string;
      event: { type: string; payload: { rows: unknown[] } };
    };
    expect(frame.kind).toBe('event');
    expect(frame.event.type).toBe('session.cli');
    expect(frame.event.payload.rows).toHaveLength(3500);
    expect(decoder.droppedCount).toBe(0);
  });
});
