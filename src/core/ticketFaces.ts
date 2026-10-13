// What a ticket tile shows beyond its ID: the title and state from a Linear read
// this window already made (the Issues list, or a ticket opened to read). The
// session row carries only the ID, and a tile never reads Linear on its own, so
// a ticket nobody has read yet shows its ID alone.

import type { TicketGroup } from './projectPanel';

export interface TicketFace {
  id: string;
  title?: string;
  state?: string;
}

const faces = new Map<string, { title: string; state: string }>();

function remember(id: string, title: string, state: string): boolean {
  const was = faces.get(id);
  if (was && was.title === title && was.state === state) return false;
  faces.set(id, { title, state });
  return true;
}

/** Record every ticket in an Issues read; true when a tile would change. */
export function rememberTicketGroups(groups: TicketGroup[]): boolean {
  let changed = false;
  for (const g of groups) for (const t of g.tickets) if (remember(t.identifier, t.title, g.state)) changed = true;
  return changed;
}

/** Record one ticket read in full; true when a tile would change. */
export function rememberTicket(t: { identifier: string; title: string; state: string }): boolean {
  return remember(t.identifier, t.title, t.state);
}

export function ticketFace(id: string): TicketFace {
  const f = faces.get(id);
  return f ? { id, title: f.title, state: f.state } : { id };
}
