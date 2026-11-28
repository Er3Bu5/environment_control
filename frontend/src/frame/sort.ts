import type { RawConfig } from "./model";

/* Sort on Overview. The order zones are stored in is the order they're shown in everywhere and on every device, so
   sorting only ever reorders the stored list. Linked zones will move as one block (#91): that belongs in moveZone, which
   takes a whole order and gives back a new one so a block can be moved the same way. */

/* One step towards the start (-1) or the end (1). At either end the order comes back as it was. */
export function moveZone(order: readonly string[], id: string, by: -1 | 1): string[] {
  const out = [...order], at = out.indexOf(id), to = at + by;
  if (at < 0 || to < 0 || to >= out.length) return out;
  out.splice(to, 0, ...out.splice(at, 1));
  return out;
}

/* A zone added or removed elsewhere while sorting is taken in rather than lost or kept: a removed one drops out, and a
   new one joins at the end. */
export function inOrder<T extends { id?: unknown }>(list: readonly T[], order: readonly string[]): T[] {
  const rank = (x: T) => {
    const i = order.indexOf(x.id as string);
    return i < 0 ? order.length : i;
  };
  return list.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
}

/* What saving the sort does to the stored setup. */
export function orderZones(c: RawConfig, order: readonly string[]): void {
  c.zones = inOrder(c.zones, order);
}
