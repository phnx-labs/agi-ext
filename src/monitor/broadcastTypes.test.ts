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

  test('rejects JSON scalars that parse cleanly: null, numbers, strings', () => {
    expect(isMonitorFrame(null)).toBe(false);
    expect(isMonitorFrame(42)).toBe(false);
    expect(isMonitorFrame('event')).toBe(false);
    expect(isMonitorFrame(true)).toBe(false);
    expect(isMonitorFrame([{ kind: 'event' }])).toBe(false);
  });

  test('rejects unknown or missing discriminants', () => {
    expect(isMonitorFrame({ kind: 'nope', event: makeEvent() })).toBe(false);
    expect(isMonitorFrame({ event: makeEvent() })).toBe(false);
    expect(isMonitorFrame({})).toBe(false);
  });

  test('rejects frames missing required fields', () => {
    expect(isMonitorFrame({ kind: 'event', event: null })).toBe(false);
    expect(
      isMonitorFrame({ kind: 'event', event: { type: 'x', ts: 1 } })
    ).toBe(false); // no payload
    expect(
      isMonitorFrame({
        kind: 'event',
        event: { type: 'x', payload: 1, ts: 'now' },
      })
    ).toBe(false); // ts not numeric
    expect(isMonitorFrame({ kind: 'request', payload: 1 })).toBe(false); // no id
    expect(isMonitorFrame({ kind: 'request', id: '1', payload: 1 })).toBe(false);
    expect(isMonitorFrame({ kind: 'response' })).toBe(false); // no id
    expect(
      isMonitorFrame({ kind: 'response', id: 1, error: 500 })
    ).toBe(false); // error not a string
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

  test('drops malformed lines without tearing down later frames', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      'not json\n' +
        JSON.stringify(null) +
        '\n' +
        encodeFrame({ kind: 'request', id: 2, payload: 'b' })
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('request');
    expect(decoder.droppedCount).toBe(2);
  });

  test('drops structurally invalid frames and counts them', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      '{"kind":"request","payload":1}\n' + // missing id
        '{"kind":"response","id":3,"payload":"ok"}\n'
    );
    expect(frames).toHaveLength(1);
    expect(decoder.droppedCount).toBe(1);
  });

  test('skips blank lines between frames', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      '\n' + encodeFrame({ kind: 'request', id: 1, payload: 'x' }) + '\n\n'
    );
    expect(frames).toHaveLength(1);
    expect(decoder.droppedCount).toBe(0);
  });

  test('complete lines are never size-limited, whatever the bound', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 64 });
    const payload = 'y'.repeat(4000);
    const line = encodeFrame({ kind: 'request', id: 1, payload });
    expect(line.length).toBeGreaterThan(4000);
    const frames = decoder.push(line);
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: string }).payload).toBe(payload);
    expect(decoder.droppedCount).toBe(0);
  });

  test('coalesced valid frames totaling far more than the bound all decode', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 64 });
    const lines = Array.from({ length: 8 }, (_, i) =>
      encodeFrame({ kind: 'request', id: i, payload: 'z'.repeat(2048) })
    );
    const blob = lines.join('');
    expect(blob.length).toBeGreaterThan(16 * 1024);
    const frames = decoder.push(blob);
    expect(frames).toHaveLength(8);
    expect(frames.map((f) => (f as { id: number }).id)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(decoder.droppedCount).toBe(0);
  });

  test('a large fragmented session-reset-shaped frame decodes across chunks', () => {
    const decoder = new FrameDecoder();
    // Shape mirrors the CLI stream reset replayed to followers: a versioned
    // envelope whose payload carries a full floor of per-session rows.
    const rows = Array.from({ length: 600 }, (_, i) => ({
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
    expect(resetLine.length).toBeGreaterThan(64 * 1024);

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
    expect(frame.event.payload.rows).toHaveLength(600);
    expect(decoder.droppedCount).toBe(0);
  });

  test('an oversized incomplete tail is discarded and framing recovers through its newline', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 64 });
    // Unterminated partial far past the bound: dropped immediately.
    expect(decoder.push('x'.repeat(200))).toEqual([]);
    expect(decoder.droppedCount).toBe(1);

    // The peer eventually terminates the junk line; the residue is discarded
    // through its newline (not double-counted, not parsed) and the valid frame
    // after it still decodes.
    const frames = decoder.push(
      'rest-of-junk\n' + encodeFrame({ kind: 'request', id: 1, payload: 'ok' })
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('request');
    expect(decoder.droppedCount).toBe(1);
  });

  test('a second oversized partial counts separately', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 64 });
    decoder.push('a'.repeat(100)); // first oversized partial, no newline
    const frames = decoder.push(
      '\n' + // terminates the first partial (already counted)
        encodeFrame({ kind: 'request', id: 1, payload: 'ok' }) +
        'b'.repeat(100) // second oversized partial, no newline yet
    );
    expect(frames).toHaveLength(1);
    expect(decoder.droppedCount).toBe(2);
    // And its newline clears the residue without a third count.
    expect(decoder.push('\n')).toEqual([]);
    expect(decoder.droppedCount).toBe(2);
    expect(
      decoder.push(encodeFrame({ kind: 'request', id: 2, payload: 'fine' }))
    ).toHaveLength(1);
  });

  test('an incomplete tail just under the bound still decodes once terminated', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 4096 });
    const payload = 'y'.repeat(4000);
    const line = encodeFrame({ kind: 'request', id: 1, payload });
    // Deliver without the trailing newline first: under the bound, buffered.
    expect(decoder.push(line.slice(0, -1))).toEqual([]);
    expect(decoder.push('\n')).toHaveLength(1);
    expect(decoder.droppedCount).toBe(0);
  });
});
