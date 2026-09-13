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

  test('bounds an incomplete frame: oversized buffer is discarded', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 64 });
    const huge = 'x'.repeat(200); // never terminated by a newline
    expect(decoder.push(huge)).toEqual([]);
    // The dangling partial is gone, so a later valid frame still decodes.
    const frames = decoder.push(encodeFrame({ kind: 'request', id: 9, payload: 1 }));
    expect(frames).toHaveLength(1);
    expect(decoder.droppedCount).toBe(1);
  });

  test('a frame exactly at the bound still decodes once terminated', () => {
    const decoder = new FrameDecoder({ maxBufferedChars: 4096 });
    const payload = 'y'.repeat(4000);
    const line = encodeFrame({ kind: 'request', id: 1, payload });
    expect(line.length).toBeGreaterThan(4000);
    expect(decoder.push(line)).toHaveLength(1);
    expect(decoder.droppedCount).toBe(0);
  });
});
