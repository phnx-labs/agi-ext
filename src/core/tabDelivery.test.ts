// What agents-cli hands an editor tab: the deliveries a stream event carries, typed at
// most once per window and never after agents-cli gave up waiting for the receipt.
import { expect, test } from 'bun:test';
import { DeliveryGate, TAB_DELIVERY_TTL_MS, deliveriesIn, deliveryKeystrokes, type TabDelivery } from './tabDelivery';

const AT = Date.parse('2026-10-19T20:00:00.000Z');
const d = (over: Partial<TabDelivery> = {}): TabDelivery => ({ id: 'tab-1', sessionId: 's1', text: 'Ship it', enter: true, at: new Date(AT).toISOString(), ...over });

test('a reset\'s rows and an upserted row carry deliveries; other events and rows without one carry none', () => {
  expect(deliveriesIn({ type: 'reset', agents: [{ sessionId: 's1', delivery: d() }, { sessionId: 's2' }] })).toEqual([d()]);
  expect(deliveriesIn({ type: 'agent.upsert', agent: { sessionId: 's1', delivery: d({ enter: false }) } })).toEqual([d({ enter: false })]);
  expect(deliveriesIn({ type: 'attention.upsert' })).toEqual([]);
  expect(deliveriesIn({ type: 'agent.upsert', agent: { sessionId: 's1', delivery: { id: 'x' } } })).toEqual([]);
});

test('each delivery is typed once, however often the stream repeats the row', () => {
  const gate = new DeliveryGate();
  expect(gate.take(d(), AT + 100)).toBe(true);
  expect(gate.take(d(), AT + 600)).toBe(false);
  expect(gate.take(d({ id: 'tab-2' }), AT + 700)).toBe(true);
});

test('a delivery older than agents-cli waits is never typed, so a late window cannot type an abandoned one', () => {
  expect(new DeliveryGate().take(d(), AT + TAB_DELIVERY_TTL_MS + 1)).toBe(false);
});

test('several lines go in as one bracketed paste; a picker key is left unsubmitted', () => {
  expect(deliveryKeystrokes(d({ text: 'one\ntwo' }))).toEqual({ text: '\u001b[200~one\ntwo\u001b[201~', submit: true });
  expect(deliveryKeystrokes(d({ text: '2', enter: false }))).toEqual({ text: '2', submit: false });
});
