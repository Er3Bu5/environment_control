/* Zone layout and Placement, as the design mock has them: a zone's size and its grid of units, and where its sensors,
   devices and virtual devices sit on the map.

   A spot is [row, column] in half-steps, so 0.5 is the aisle between the first two rows and -0.5 the gap between the
   first row and the wall; -1 or rows is outside the wall. An environment sensor goes anywhere inside the wall. A soil
   probe sits in a unit, always at substrate height. Devices and virtual devices can also go outside the wall, all the way
   round, and placing a device is optional. Nothing here is saved: it builds a draft, lists what it would change, and
   applies it to a copy of the stored setup. */
import type { RawConfig } from "./model";

export interface Layout {
  w: number;
  d: number;
  units: number;
  rows: number;
  cols: number;
}
export type Level = "above" | "in" | "under";
export const LEVELS: Record<Level, string> = { above: "Above canopy", in: "In canopy", under: "Under canopy" };
export type ItemKind = "env" | "soil" | "device" | "virtual";
export type Spot = [number, number];
export interface Item {
  id: string;
  name: string;
  kind: ItemKind;
  pos: Spot | null;
  level?: Level;
  /* A device's role, which decides its icon and colour. */
  type?: string;
}

/* What a virtual device is. It only decides its mark: the same icon and colour as a real device of that role, a tank, or
   a plain cube, always dashed. */
export const VIRTUAL_TYPES = ["Dehumidifier", "Humidifier", "Air conditioner", "Heater", "Fan", "Light", "Tank", "Other"] as const;
export type VirtualType = (typeof VIRTUAL_TYPES)[number];

export const MAX_UNITS = 200;
export const MAX_GRID = 20;
export const MAX_VIRTUAL = 30;
export const MAX_SIZE_M = 100;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const halfStep = (x: number) => Number.isInteger(x * 2);

export const planted = (L: Layout, r: number, c: number) =>
  Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < L.rows && c < L.cols && r * L.cols + c < L.units;
export const beyondWall = (p: Spot, L: Layout) => p[0] < -0.5 || p[0] > L.rows - 0.5 || p[1] < -0.5 || p[1] > L.cols - 0.5;
export const onMapOnly = (k: ItemKind) => k === "device" || k === "virtual";

/* Where each kind may go. */
export function allowed(kind: ItemKind, L: Layout, r: number, c: number): boolean {
  if (kind === "soil") return planted(L, r, c);
  const e = onMapOnly(kind) ? 1 : 0.5;
  return halfStep(r) && halfStep(c) && r >= -e && c >= -e && r <= L.rows - 1 + e && c <= L.cols - 1 + e;
}
export const fits = (s: Item, L: Layout) => !!s.pos && allowed(s.kind, L, s.pos[0], s.pos[1]);

/* Every spot an item may take, in reading order. */
export function spotsFor(kind: ItemKind, L: Layout): Spot[] {
  const e = onMapOnly(kind) ? 1 : 0.5, out: Spot[] = [];
  for (let r = -e; r <= L.rows - 1 + e; r += 0.5) for (let c = -e; c <= L.cols - 1 + e; c += 0.5) if (allowed(kind, L, r, c)) out.push([r, c]);
  return out;
}

/* The grid closest to the zone's shape that holds every unit with the fewest empty spaces, never more than 20 either way. */
export function suggestGrid(n: number, w: number, d: number): [number, number] {
  let best: [number, number] = [Math.ceil(n / MAX_GRID), MAX_GRID], score = Infinity;
  for (let cols = 1; cols <= Math.min(n, MAX_GRID); cols++) {
    const rows = Math.ceil(n / cols);
    if (rows > MAX_GRID) continue;
    const s = Math.abs(Math.log(cols / rows / (w / d))) + ((cols * rows - n) / n) * 2;
    if (s < score - 1e-9) [score, best] = [s, [rows, cols]];
  }
  return best;
}

/* A size or unit count typed in, as the mock takes it: clamped, ignored until it is a positive number, and the grid
   suggested again straight away, so typing more units than the grid holds never leaves it too small. The steppers can
   still change the grid after. */
export function typed(d: Layout, key: "w" | "d" | "units", n: number): void {
  if (!Number.isFinite(n) || n <= 0) return;
  if (key === "units") d.units = Math.min(MAX_UNITS, Math.round(n));
  else d[key] = Math.min(MAX_SIZE_M, n);
  [d.rows, d.cols] = suggestGrid(d.units, d.w, d.d);
}

/* Spots are evenly spaced right out to the band beyond the wall, with the wall midway between the last two. A mark is an
   icon small enough to sit in that gap without touching the wall. */
export function geom(L: Layout, outer: boolean) {
  const cw = 130, ch = 112, toWallX = 65 + 32, toWallY = 56 + 28, outX = 33, outY = 28;
  const px = toWallX + (outer ? 60 : 8), py = toWallY + (outer ? outY + 24 : 8);
  const W = px * 2 + (L.cols - 1) * cw, H = py * 2 + (L.rows - 1) * ch, wx = px - toWallX, wy = py - toWallY;
  const X = (c: number) => (c < -0.5 ? wx - outX : c > L.cols - 0.5 ? W - wx + outX : px + c * cw);
  const Y = (r: number) => (r < -0.5 ? wy - outY : r > L.rows - 0.5 ? H - wy + outY : py + r * ch);
  return { R: 32, W, H, X, Y, wx, wy };
}

const unitName = (L: Layout, r: number, c: number) => (planted(L, r, c) ? `unit ${r * L.cols + c + 1}` : "");

/* A spot in words, for the list, the review and a screen reader. */
export function posText(p: Spot, L: Layout): string {
  const [r, c] = p, offR = r < 0 || r > L.rows - 1, offC = c < 0 || c > L.cols - 1, rr = clamp(r, 0, L.rows - 1), cc = clamp(c, 0, L.cols - 1);
  const at = (u: string) => (u ? ` at ${u}` : "");
  if (beyondWall(p, L)) {
    const u = unitName(L, clamp(Math.round(r), 0, L.rows - 1), clamp(Math.round(c), 0, L.cols - 1));
    return `Outside the wall${u ? `, by ${u}` : ""}`;
  }
  if (offR && offC) return `Corner${unitName(L, rr, cc) ? ` by ${unitName(L, rr, cc)}` : ""}`;
  if (offC) return Number.isInteger(r) ? `By the wall${at(unitName(L, r, cc))}` : `By the wall at the end of the aisle between rows ${r + 0.5} and ${r + 1.5}`;
  if (offR) {
    if (Number.isInteger(c)) return `By the wall${at(unitName(L, rr, c))}`;
    const a = unitName(L, rr, c - 0.5), b = unitName(L, rr, c + 0.5);
    return a && b ? `By the wall between ${a} and ${b}` : `By the wall${at(a || b)}`;
  }
  if (!Number.isInteger(r)) return `Aisle between rows ${r + 0.5} and ${r + 1.5}`;
  if (!Number.isInteger(c)) {
    const a = unitName(L, r, c - 0.5), b = unitName(L, r, c + 0.5);
    return a && b ? `Between ${a} and ${b}` : a || b ? `Beside ${a || b}` : "Between units";
  }
  return planted(L, r, c) ? `Unit ${r * L.cols + c + 1}` : `Where unit ${r * L.cols + c + 1} would be`;
}

/* The draft: a zone's layout and every mark. flow is the steps this opening covers: 1 size, 2 units and grid, 3 the map. */
export interface LayoutDraft extends Layout {
  zoneId: string;
  flow: (1 | 2 | 3)[];
  step: 1 | 2 | 3;
  sensors: Item[];
  devs: Item[];
  virt: Item[];
  pick: string | null;
}

const spot = (v: unknown): Spot | null => (Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) ? [v[0], v[1]] : null);
const LEVEL_KEYS = Object.keys(LEVELS) as Level[];
const DEFAULT_LAYOUT: Layout = { w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 };

export function storedLayout(z: Record<string, unknown> | undefined): Layout {
  const l = z && isObj(z.layout) ? z.layout : {};
  return [l.w, l.d, l.units, l.rows, l.cols].every(num) ? { w: l.w as number, d: l.d as number, units: l.units as number, rows: l.rows as number, cols: l.cols as number } : { ...DEFAULT_LAYOUT };
}

/* What a zone's map shows: its sensors, its devices that are placed or can be, and its virtual devices. Only climate
   hardware and lights are placed as devices, the entries with an entity to control; sensor boards are placed as sensors. */
export function zoneItems(c: RawConfig, zoneId: string): { sensors: Item[]; devs: Item[]; virt: Item[] } {
  const z = c.zones.find((x) => x.id === zoneId);
  const sensors = (Array.isArray(z?.sensors) ? z.sensors.filter(isObj) : [])
    .filter((s) => typeof s.id === "string")
    .map((s): Item => ({
      id: s.id as string,
      name: typeof s.name === "string" ? s.name : (s.id as string),
      kind: s.kind === "soil" ? "soil" : "env",
      pos: spot(s.pos),
      ...(LEVEL_KEYS.includes(s.level as Level) ? { level: s.level as Level } : {}),
    }));
  const devs = c.devices
    .filter((d) => typeof d.id === "string" && typeof d.entity === "string" && Array.isArray(d.zones) && d.zones.includes(zoneId))
    .map((d): Item => ({
      id: d.id as string,
      name: typeof d.name === "string" ? d.name : typeof d.entity === "string" ? d.entity : (d.id as string),
      kind: "device",
      pos: isObj(d.place) ? spot(d.place[zoneId]) : null,
      ...(typeof d.type === "string" ? { type: d.type } : {}),
    }));
  const virt = (Array.isArray(z?.virtual) ? z.virtual.filter(isObj) : [])
    .filter((v) => typeof v.id === "string" && typeof v.name === "string")
    .map((v): Item => ({ id: v.id as string, name: v.name as string, kind: "virtual", pos: spot(v.pos), type: (VIRTUAL_TYPES as readonly string[]).includes(v.type as string) ? (v.type as string) : "Other" }));
  return { sensors, devs, virt };
}

/* Something that has to be on the map before saving: a sensor or a virtual device that isn't, or no longer fits. */
export const stranded = (d: LayoutDraft) => [...d.sensors, ...d.virt].filter((s) => !fits(s, d));
/* A device that isn't on the map, which is fine: placing one is optional. */
export const devsOff = (d: LayoutDraft) => d.devs.filter((x) => !fits(x, d));

/* A layout that strands something carries on to the map, since it can't save with a sensor left off it. */
export const flowOf = (d: LayoutDraft): (1 | 2 | 3)[] => (d.flow.includes(2) && !d.flow.includes(3) && (d.step === 3 || stranded(d).some((s) => s.pos)) ? [...d.flow, 3] : d.flow);

export function openLayout(c: RawConfig, zoneId: string, flow: (1 | 2 | 3)[]): LayoutDraft {
  const z = c.zones.find((x) => x.id === zoneId);
  const items = zoneItems(c, zoneId);
  const draft: LayoutDraft = { zoneId, flow, step: flow[0], ...storedLayout(z), ...items, pick: null };
  if (flow[0] === 3) draft.pick = firstToPlace(draft);
  return draft;
}

/* A placement draft carried across a visit to Device identification: the zone's sensors and devices as they now are,
   each where the draft had put it. One that's gone is dropped, a new one waits to be placed, and a sensor whose class
   changed is placed again, since a soil probe and an air sensor can't sit in the same spots. */
export function carryPlacement(now: LayoutDraft, held: LayoutDraft): LayoutDraft {
  const carry = (list: Item[], was: Item[]) => {
    for (const it of list) {
      const old = was.find((x) => x.id === it.id);
      if (!old || old.kind !== it.kind) continue;
      it.pos = old.pos ? [old.pos[0], old.pos[1]] : null;
      if (old.level) it.level = old.level;
    }
  };
  carry(now.sensors, held.sensors);
  carry(now.devs, held.devs);
  carry(now.virt, held.virt);
  Object.assign(now, { flow: held.flow, step: 3, w: held.w, d: held.d, units: held.units, rows: held.rows, cols: held.cols });
  now.pick = (stranded(now)[0] ?? null)?.id ?? null;
  return now;
}

export function firstToPlace(d: LayoutDraft): string | null {
  return (stranded(d)[0] ?? d.sensors[0] ?? devsOff(d)[0] ?? d.devs[0] ?? null)?.id ?? null;
}

/* Environment sensors on the map with no height yet. Height decides which readings mean what, so every one needs it
   chosen before saving; a soil probe is in the substrate and needs none. */
export const noHeight = (d: LayoutDraft) => d.sensors.filter((s) => s.kind === "env" && s.pos && !s.level);

export const itemOf = (d: LayoutDraft, id: string | null) => [...d.sensors, ...d.devs, ...d.virt].find((x) => x.id === id);

export function layoutIssues(d: LayoutDraft): string[] {
  const out: string[] = [];
  if (!(d.w >= 0.1 && d.w <= MAX_SIZE_M && d.d >= 0.1 && d.d <= MAX_SIZE_M)) out.push(`Width and depth go from 0.1 to ${MAX_SIZE_M} m.`);
  if (!(Number.isInteger(d.units) && d.units >= 1 && d.units <= MAX_UNITS)) out.push(`Units go from 1 to ${MAX_UNITS}, whole numbers.`);
  else if (d.rows * d.cols < d.units) out.push(`This grid holds ${d.rows * d.cols} units, and you have ${d.units}.`);
  return out;
}

export interface Change {
  label: string;
  before: string;
  after: string;
}

export function layoutChanges(d: LayoutDraft, c: RawConfig): Change[] {
  const z = c.zones.find((x) => x.id === d.zoneId), was = storedLayout(z), items = zoneItems(c, d.zoneId), out: Change[] = [];
  const add = (label: string, before: string, after: string) => before !== after && out.push({ label, before, after });
  const where = (p: Spot | null, L: Layout) => (p ? posText(p, L) : "Not placed");
  add("Size", `${was.w} x ${was.d} m`, `${d.w} x ${d.d} m`);
  add("Units", String(was.units), String(d.units));
  add("Grid", `${was.rows} rows, ${was.cols} columns`, `${d.rows} rows, ${d.cols} columns`);
  for (const s of d.sensors) {
    const old = items.sensors.find((x) => x.id === s.id);
    add(`${s.name} position`, where(old?.pos ?? null, was), fits(s, d) ? where(s.pos, d) : "Not placed");
    if (s.kind === "env") add(`${s.name} height`, old?.level ? LEVELS[old.level] : "Not set", s.level ? LEVELS[s.level] : "Not set");
  }
  for (const x of d.devs) {
    const old = items.devs.find((y) => y.id === x.id);
    add(`${x.name} position`, where(old?.pos ?? null, was), fits(x, d) ? where(x.pos, d) : "Not placed");
  }
  /* Virtual devices are added, named and removed in Device identification. Here they're only placed. */
  for (const v of d.virt) {
    const old = items.virt.find((y) => y.id === v.id);
    add(`${v.name}, virtual`, where(old?.pos ?? null, was), fits(v, d) ? where(v.pos, d) : "Not placed");
  }
  return out;
}

export function applyLayout(c: RawConfig, d: LayoutDraft): void {
  const z = c.zones.find((x) => x.id === d.zoneId);
  if (!z) return;
  const L: Layout = { w: d.w, d: d.d, units: d.units, rows: d.rows, cols: d.cols };
  z.layout = L;
  for (const s of Array.isArray(z.sensors) ? z.sensors.filter(isObj) : []) {
    const drafted = d.sensors.find((x) => x.id === s.id);
    if (!drafted) continue;
    s.pos = fits(drafted, L) ? [...(drafted.pos as Spot)] : null;
    if (drafted.kind === "env" && drafted.level) s.level = drafted.level;
    if (drafted.kind === "soil") delete s.level;
  }
  /* One not on the map yet, or no longer on it, stays in the zone with no spot, to be placed. */
  const virt = d.virt.map((v) => ({ id: v.id, name: v.name, type: v.type ?? "Other", ...(fits(v, L) ? { pos: [...(v.pos as Spot)] } : {}) }));
  if (virt.length) z.virtual = virt;
  else delete z.virtual;
  for (const dev of c.devices) {
    const drafted = d.devs.find((x) => x.id === dev.id);
    if (!drafted) continue;
    const place: Record<string, unknown> = isObj(dev.place) ? { ...dev.place } : {};
    if (fits(drafted, L)) place[d.zoneId] = [...(drafted.pos as Spot)];
    else delete place[d.zoneId];
    if (Object.keys(place).length) dev.place = place;
    else delete dev.place;
  }
}
