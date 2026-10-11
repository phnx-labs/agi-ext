import { describe, it, expect } from 'bun:test';
import {
  decodeInjectQuery,
  selectInjectTarget,
  type InjectPayload,
  type InjectTerminal,
} from './inject';

// Encode a payload the way the agents-cli does: JSON -> base64url in the `p`
// param. This exercises the real decode path (no mocks).
function encode(payload: object): string {
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `?p=${p}`;
}

const sessionA = '4a78949e-1111-2222-3333-aaaaaaaaaaaa';
const sessionB = '5b89050f-4444-5555-6666-bbbbbbbbbbbb';

describe('decodeInjectQuery', () => {
  it('decodes a base64url payload, with or without the leading ?, keeping unicode text', () => {
    const text = 'run the "build" && test — ¿listo? 你好';
    expect(decodeInjectQuery(encode({ terminalId: sessionA, text, enter: false, combined: true })))
      .toEqual({ terminalId: sessionA, text, enter: false, combined: true } as InjectPayload);
    expect(decodeInjectQuery(encode({ terminalId: sessionA, text: 'hi' }).slice(1))?.text).toBe('hi');
    // Empty text is accepted: there is no submit-nothing guard here.
    expect(decodeInjectQuery(encode({ terminalId: sessionA, text: '' }))?.text).toBe('');
  });

  it('defaults enter=true and combined=false when omitted or not boolean', () => {
    for (const extra of [{}, { enter: 'yes', combined: 1 }]) {
      const p = decodeInjectQuery(encode({ terminalId: sessionA, text: 'go', ...extra }));
      expect([p?.enter, p?.combined]).toEqual([true, false]);
    }
  });

  it('returns null for anything that is not a payload with a terminalId and string text', () => {
    const notObject = Buffer.from('"just a string"', 'utf8').toString('base64url');
    for (const query of [
      '', '?', '?terminalId=abc&text=hi', '?p=not%20valid%20base64url!!!', `?p=${notObject}`,
      encode({ text: 'hi' }), encode({ terminalId: '', text: 'hi' }),
      encode({ terminalId: sessionA }), encode({ terminalId: sessionA, text: 123 }),
    ]) {
      expect(decodeInjectQuery(query)).toBeNull();
    }
  });
});

describe('selectInjectTarget', () => {
  const terminals: InjectTerminal[] = [
    { id: 'CC-1', sessionId: sessionA },
    { id: 'CX-1', sessionId: sessionB },
    { id: 'SH-1' },
  ];

  it('selects by sessionId (the agents-cli case)', () => {
    expect(selectInjectTarget(terminals, sessionB)?.id).toBe('CX-1');
  });

  it('selects by internal terminal id', () => {
    expect(selectInjectTarget(terminals, 'CC-1')?.id).toBe('CC-1');
  });

  it('returns undefined when nothing matches', () => {
    expect(selectInjectTarget(terminals, 'no-such-id')).toBeUndefined();
  });

  it('does not match a terminal that has no sessionId against a session query', () => {
    expect(selectInjectTarget(terminals, 'undefined')).toBeUndefined();
  });
});
