/* Linked zones (#91). A zone may name one parent zone, one level deep, and a parent with the zones linked to it is a
   family. The parent link is the only way one zone's data may ever show in another, so everything that crosses zones
   asks these. Each takes zones as stored (or as read), so it works the same on a save's copy and on what's shown. */

export interface Kin {
  id?: unknown;
  name?: unknown;
  parent?: unknown;
}

const parentId = (z: Kin): string => (typeof z.parent === "string" ? z.parent : "");
const idOf = (z: Kin): string => (typeof z.id === "string" ? z.id : "");
const nameOf = (z: Kin): string => (typeof z.name === "string" ? z.name : idOf(z));

export const familyRoot = (z: Kin): string => parentId(z) || idOf(z);
export const sameFamily = (a: Kin, b: Kin): boolean => familyRoot(a) === familyRoot(b);
export const parentOf = <T extends Kin>(list: readonly T[], z: Kin): T | null => (parentId(z) ? list.find((o) => o.id === parentId(z)) ?? null : null);
export const linkedZones = <T extends Kin>(list: readonly T[], id: string): T[] => list.filter((o) => parentId(o) === id);
export function familyOf<T extends Kin>(list: readonly T[], id: string): T[] {
  const z = list.find((o) => o.id === id);
  return z ? list.filter((o) => sameFamily(o, z)) : [];
}

/* One level only: a zone that's linked can't be a parent, and a zone can't be its own. */
export const parentChoices = <T extends Kin>(list: readonly T[], self: string | null): T[] => list.filter((o) => o.id !== self && !parentId(o));

/* A parent that isn't in the list counts for nothing, so a zone linked to one that's gone stands on its own. */
const rootIn = (list: readonly Kin[], z: Kin): string => (parentId(z) && list.some((o) => o.id === parentId(z)) ? parentId(z) : idOf(z));
const kin = (z: unknown): Kin => (z && typeof z === "object" ? (z as Kin) : {});

/* A family sits together in the zone order, so it's together on Overview, in the menu, on Setup and in every list of
   zones, in any order inside it. The panel never saves a family split, but an order that splits one can still arrive
   (older setups, a save made elsewhere), so each stray is pulled to just after its parent's family. */
export function familyOrder<T>(list: readonly T[]): T[] {
  const all = list.map(kin);
  let out = [...list];
  const fam = (root: string) => (z: T) => rootIn(all, kin(z)) === root;
  for (const p of list.filter((z) => all.some((o) => o !== kin(z) && idOf(kin(z)) && rootIn(all, o) === idOf(kin(z))))) {
    const inIt = fam(idOf(kin(p))), at = out.indexOf(p);
    let s = at, e = at;
    while (s > 0 && inIt(out[s - 1])) s--;
    while (e < out.length - 1 && inIt(out[e + 1])) e++;
    const run = out.slice(s, e + 1), strays = out.filter((z, i) => (i < s || i > e) && inIt(z)), rest = out.filter((z) => !run.includes(z) && !strays.includes(z));
    const before = out.slice(0, s).filter((z) => !strays.includes(z)).length;
    out = [...rest.slice(0, before), ...run, ...strays, ...rest.slice(before)];
  }
  return out;
}

/* Linking a zone moves it to the end of its parent's family, wherever it was. */
export function linkedOrder<T extends Kin>(list: readonly T[], z: T, parent: string): T[] {
  const out = list.filter((o) => o !== z && o.id !== z.id);
  const last = out.reduce((n, o, i) => (o.id === parent || parentId(o) === parent ? i : n), out.length - 1);
  out.splice(last + 1, 0, z);
  return out;
}

/* The runs of one family each, in order: a zone on its own is a run of one. */
export function familyRuns<T extends Kin>(list: readonly T[]): { root: string; zones: T[] }[] {
  const runs: { root: string; zones: T[] }[] = [];
  for (const z of list) {
    const r = rootIn(list, z), at = runs[runs.length - 1];
    if (at && at.root === r) at.zones.push(z);
    else runs.push({ root: r, zones: [z] });
  }
  return runs;
}

const zoneList = (list: readonly Kin[]) => list.map((o) => `Zone: ${nameOf(o)}`).join(", ");

/* A sensor in two zones shows one zone's readings in another, which only the parent link may do, so every zone a sensor
   is in has to be one family. Empty when sharing is allowed, else what to tell the person: and where linking to the
   holder couldn't work either, why, rather than sending them to try something that will be refused. */
export function sensorRefusal<T extends Kin>(list: readonly T[], zoneId: string, holderIds: readonly string[]): string {
  const z = list.find((o) => o.id === zoneId), holders = holderIds.map((id) => list.find((o) => o.id === id)).filter((o): o is T => !!o);
  if (!z || !holders.length || new Set([z, ...holders].map(familyRoot)).size === 1) return "";
  const target = holders.length === 1 ? holders[0] : list.find((o) => o.id === familyRoot(holders[0])) ?? holders[0];
  const said = `This sensor is already associated to ${holders.length > 1 ? "Zones" : "Zone"}: ${holders.map(nameOf).join(", ")}.`;
  const kids = linkedZones(list, zoneId), p = parentOf(list, z), tp = parentOf(list, target);
  if (kids.length) return `${said} ${zoneList(kids)} ${kids.length === 1 ? "is" : "are"} linked to this zone, so it can't be linked to another.`;
  if (p) return `${said} This zone is already linked to Zone: ${nameOf(p)}, and a zone is linked to one other zone only.`;
  if (tp) return `${said} ${nameOf(target)} is itself linked to Zone: ${nameOf(tp)}, so it can't be this zone's parent.`;
  return `${said} If you want a duplicate here, this zone must be linked to ${nameOf(target)}. This can be done in the Zone details section of Setup.`;
}

/* What Zone details saves for the link. Linking moves the zone to its parent's family; unlinking leaves it where it is
   and leaves the key out, since the backend refuses a null parent. */
export function setParent(c: { zones: Record<string, unknown>[] }, id: string, parent: string): void {
  const z = c.zones.find((x) => x.id === id);
  if (!z) return;
  if (!parent) {
    delete z.parent;
    return;
  }
  if (z.parent !== parent) c.zones = linkedOrder(c.zones, z, parent);
  z.parent = parent;
}

/* The review's line when linking moves the zone, since where a zone sits shows on every page. */
export function moveWords<T extends Kin>(list: readonly T[], z: T, parent: string, name: string): string {
  const p = list.find((o) => o.id === parent);
  if (!p || parentId(z) === parent) return "";
  const before = list.includes(z) ? list : [...list, z], after = linkedOrder(before, z, parent);
  if (before.every((o, i) => o === after[i])) return "";
  const others = linkedZones(list, parent).filter((o) => o.id !== z.id).length;
  return `${name || "This zone"} moves next to ${nameOf(p)}${others ? " and the zones linked to it" : ""} on Overview, in the menu and on Setup.`;
}
