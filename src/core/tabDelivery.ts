/**
 * Text agents-cli asks this editor to type into a session's tab (the row's `delivery`,
 * agents-cli `feed/tab-delivery.ts`). The CLI cannot reach an editor tab, so `agents feed
 * answer` and `agents send` put the text on the session's row and wait for the agent's
 * next prompt as the receipt; the window that binds the session types it once.
 */
export interface TabDelivery {
  id: string;
  sessionId: string;
  text: string;
  enter: boolean;
  at: string;
}

/** agents-cli drops an unreceipted delivery after this; a window never types one older. */
export const TAB_DELIVERY_TTL_MS = 15_000;

function asDelivery(row: unknown): TabDelivery | undefined {
  const d = (row as { delivery?: Partial<TabDelivery> } | null)?.delivery;
  if (!d || typeof d.id !== 'string' || typeof d.sessionId !== 'string' || typeof d.text !== 'string' || typeof d.at !== 'string') return undefined;
  return { id: d.id, sessionId: d.sessionId, text: d.text, enter: d.enter !== false, at: d.at };
}

/** The deliveries a stream event carries: on a reset's rows, or an upserted row. */
export function deliveriesIn(payload: { type?: string; agents?: unknown[]; agent?: unknown }): TabDelivery[] {
  const rows = payload.type === 'reset' ? payload.agents ?? [] : payload.type === 'agent.upsert' ? [payload.agent] : [];
  return rows.flatMap((row) => {
    const d = asDelivery(row);
    return d ? [d] : [];
  });
}

/** Each delivery is typed at most once per window, and never after it expired. */
export class DeliveryGate {
  private readonly typed = new Map<string, number>();

  take(d: TabDelivery, nowMs: number): boolean {
    for (const [id, at] of this.typed) if (nowMs - at > 2 * TAB_DELIVERY_TTL_MS) this.typed.delete(id);
    const age = nowMs - Date.parse(d.at);
    if (!(age <= TAB_DELIVERY_TTL_MS) || this.typed.has(d.id)) return false;
    this.typed.set(d.id, nowMs);
    return true;
  }
}

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** What to write: several lines go in as one bracketed paste so the TUI does not submit at the first line. */
export function deliveryKeystrokes(d: TabDelivery): { text: string; submit: boolean } {
  const text = d.text.includes('\n') ? `${PASTE_START}${d.text}${PASTE_END}` : d.text;
  return { text, submit: d.enter };
}
