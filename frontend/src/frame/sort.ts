import { type Kin, familyRuns } from "./family";
import type { RawConfig } from "./model";

/* Sort on Overview. The order zones are stored in is the order they're shown in everywhere and on every device, so
   sorting only ever reorders the stored list. */

/* One step towards the start (-1) or the end (1). At either end the order comes back as it was. A family is never split
   (#91): a zone in one steps only inside it, and a zone on its own steps past a whole family in one press. */
export function moveZone(order: readonly string[], id: string, by: -1 | 1, zones: readonly Kin[] = []): string[] {
  const runs = familyRuns(order.map((x) => zones.find((z) => z.id === x) ?? { id: x }));
  const ids = (list: readonly Kin[]) => list.map((z) => z.id as string);
  const at = runs.findIndex((r) => r.zones.some((z) => z.id === id));
  if (at < 0) return [...order];
  const run = runs[at];
  if (run.zones.length > 1) {
    const inner = ids(run.zones), i = inner.indexOf(id), to = i + by;
    if (to < 0 || to >= inner.length) return [...order];
    inner.splice(to, 0, ...inner.splice(i, 1));
    return runs.flatMap((r, n) => (n === at ? inner : ids(r.zones)));
  }
  const to = at + by;
  if (to < 0 || to >= runs.length) return [...order];
  runs.splice(to, 0, ...runs.splice(at, 1));
  return runs.flatMap((r) => ids(r.zones));
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
