/* Sensor Calibration: each environment sensor's leaf temperature offset, as a draft against what's saved and what the
   boards report. An offset lives in one place: on the sensor's own board, as a number in °C on the same device, or
   kept in Environment Control for a sensor with nowhere to hold one. Where a board has such a number and nobody has
   said yet, it asks rather than guessing. A board's value counts only once the board reports it, so nothing here
   treats a write as done. */
import type { Catalog, CatalogEntity } from "./messages";
import type { Method } from "./mapping";
import type { RawConfig } from "./model";
import { type HaState, type StoredSensor, calcVpd, combine, leafOf, numberOf, readSensor, sensorsOf } from "./readings";

/* The source for an offset kept in Environment Control. Any other source is the entity id of a board's number. */
export const KEPT = "here";
/* The boards' own range, used where nothing says otherwise: an offset kept here, or a board that doesn't report its
   limits. */
export const LEAF_LIMITS: Limits = { min: -5, max: 2, step: 0.1 };
/* How long a board gets to report a new offset before its row says it wasn't confirmed. */
export const LEAF_GIVE_UP_MS = 10_000;
const CELSIUS = ["°C", "℃"];

export interface Limits {
  min: number;
  max: number;
  step: number;
}
/* A number on the sensor's own board that could hold its offset. */
export interface Home {
  entity: string;
  name: string;
  limits: Limits | null;
  value: number | null;
  offline: boolean;
}
export interface LeafRow {
  /* KEPT, a board number's entity id, or "" while nobody has said. */
  src: string;
  mag: number;
  dir: -1 | 1;
  status: "" | "sending" | "stuck";
}
export interface LeafDraft {
  zoneId: string;
  rows: Record<string, LeafRow>;
  /* Which sensor's offset the VPD chart is drawn at, "" for Average. */
  basis: string;
  /* Rows are seeded once Home Assistant's devices are known, since they say which boards have somewhere to hold one. */
  seeded: boolean;
  sending: boolean;
  fromGuide: boolean;
}
export interface LeafChange {
  label: string;
  before: string;
  after: string;
  kind: "src" | "kept" | "board" | "basis";
}
export interface LeafIssue {
  id: string;
  text: string;
  target: string;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function limitsFrom(a: Record<string, unknown> | CatalogEntity | null | undefined): Limits | null {
  if (!a) return null;
  const { min, max, step } = a as Record<string, unknown>;
  return finite(min) && finite(max) && finite(step) && step > 0 && min <= max ? { min, max, step } : null;
}

export const envSensors = (z: Record<string, unknown> | undefined): StoredSensor[] => sensorsOf(z).filter((s) => s.kind === "env");

/* A linked number's live state is forwarded to the frame; one not linked yet is known only from the catalog's snapshot. */
function home(entity: string, name: string, cat: CatalogEntity | null, states: Record<string, HaState>): Home {
  const live = states[entity];
  const value = live ? numberOf(live) : cat?.state ? numberOf({ state: cat.state, attributes: {}, at: null }) : null;
  return { entity, name, limits: limitsFrom(live?.attributes) ?? limitsFrom(cat), value, offline: value === null };
}

/* Where a sensor's offset could live: each number in °C on its own device, and whatever the setup already links. */
export function homesOf(s: StoredSensor, catalog: Catalog | null, states: Record<string, HaState>): Home[] {
  const out: Home[] = [];
  for (const e of catalog?.devices.find((d) => d.id === s.id)?.entities ?? [])
    if (e.domain === "number" && CELSIUS.includes(e.unit ?? "")) out.push(home(e.entity_id, e.name, e, states));
  if (s.leafEntity && !out.some((h) => h.entity === s.leafEntity)) out.push(home(s.leafEntity, s.leafEntity, null, states));
  return out;
}

/* Where the setup holds a sensor's offset now: "" while its board has somewhere and nobody has said. */
export function storedSrc(s: StoredSensor, homes: Home[]): string {
  if (s.leafEntity && !s.leafUnused) return s.leafEntity;
  return s.leafUnused || !homes.length ? KEPT : "";
}

/* What a source holds now: the board's own value, or the one kept here, 0 until either is set. */
export function valueAt(s: StoredSensor, src: string, homes: Home[]): number {
  const h = homes.find((x) => x.entity === src);
  return h ? (h.value ?? 0) : typeof s.leaf === "number" ? s.leaf : 0;
}

export const limitsOf = (src: string, homes: Home[]): Limits => homes.find((h) => h.entity === src)?.limits ?? LEAF_LIMITS;
export const leafValue = (r: LeafRow): number => (r.mag === 0 ? 0 : r.mag * r.dir);
const tidy = (x: number) => Math.round(x * 1e6) / 1e6;
export const split = (v: number): Pick<LeafRow, "mag" | "dir"> => ({ mag: tidy(Math.abs(v)), dir: v > 0 ? 1 : -1 });

/* Decimal places a step needs, so a 0.1 step shows 1.5 and a 0.05 step 1.55. */
export const placesOf = (step: number): number => Math.min(3, Math.max(1, (String(step).split(".")[1] ?? "").length));

export function phrase(x: number, places = 1): string {
  if (Math.abs(x) < 1e-9) return "Same as air";
  return `${Math.abs(x).toFixed(places)} °C ${x < 0 ? "below" : "above"} air`;
}

export function seedRows(z: Record<string, unknown> | undefined, catalog: Catalog | null, states: Record<string, HaState>): Record<string, LeafRow> {
  const rows: Record<string, LeafRow> = {};
  for (const s of envSensors(z)) {
    const homes = homesOf(s, catalog, states), src = storedSrc(s, homes);
    rows[s.id] = { src, ...split(valueAt(s, src, homes)), status: "" };
  }
  return rows;
}

export function openLeaf(z: Record<string, unknown> | undefined, zoneId: string, catalog: Catalog | null, states: Record<string, HaState>, fromGuide: boolean): LeafDraft {
  const basis = typeof z?.leafBasis === "string" ? z.leafBasis : "";
  return { zoneId, rows: catalog ? seedRows(z, catalog, states) : {}, basis, seeded: !!catalog, sending: false, fromGuide };
}

/* Picking a source shows what that source holds, so a board keeps its own offset until you change it. */
export function pickSrc(r: LeafRow, s: StoredSensor, src: string, homes: Home[]): void {
  r.src = src;
  Object.assign(r, split(valueAt(s, src, homes)));
}

/* A typed minus or plus still sets the direction, for anyone with those keys. Blank or not a number keeps the value. */
export function typeInto(r: LeafRow, typed: string): void {
  const t = typed.trim().replace(",", "."), n = t === "" ? Number.NaN : Number(t);
  if (!Number.isFinite(n)) return;
  r.mag = tidy(Math.abs(n));
  if (t.startsWith("-")) r.dir = -1;
  if (t.startsWith("+")) r.dir = 1;
}

const offStep = (v: number, L: Limits) => {
  const steps = (v - L.min) / L.step;
  return Math.abs(steps - Math.round(steps)) > 1e-6;
};

export function leafIssues(d: LeafDraft, sensors: StoredSensor[], homesBy: Record<string, Home[]>): LeafIssue[] {
  const out: LeafIssue[] = [];
  for (const s of sensors) {
    const r = d.rows[s.id];
    if (!r) continue;
    if (r.src === "") {
      out.push({ id: s.id, text: `Say where ${s.name}'s offset is held.`, target: `lsrc-${s.id}` });
      continue;
    }
    const homes = homesBy[s.id] ?? [], h = homes.find((x) => x.entity === r.src);
    if (h?.offline) continue;
    const L = limitsOf(r.src, homes), v = leafValue(r), target = `lin-${s.id}`;
    if (v < L.min - 1e-9) out.push({ id: s.id, text: `${s.name} can be at most ${-L.min} °C below air.`, target });
    else if (v > L.max + 1e-9) out.push({ id: s.id, text: `${s.name} can be at most ${L.max} °C above air.`, target });
    else if (offStep(v, L)) out.push({ id: s.id, text: `${s.name} goes in steps of ${L.step} °C.`, target });
  }
  return out;
}

const srcText = (src: string, homes: Home[]) => {
  if (src === "") return "Not said yet";
  if (src === KEPT) return "Kept in Environment Control";
  return `On the board, ${homes.find((h) => h.entity === src)?.name ?? src}`;
};

/* Sensors the zone's reading counts, which are the ones the chart can be drawn at. */
export const countedOf = (sensors: StoredSensor[]) => sensors.filter((s) => s.avg);
export const basisOf = (sensors: StoredSensor[], basis: string) => (countedOf(sensors).some((s) => s.id === basis) ? basis : "");

export function leafChanges(d: LeafDraft, sensors: StoredSensor[], homesBy: Record<string, Home[]>, storedBasis: string): LeafChange[] {
  const out: LeafChange[] = [];
  for (const s of sensors) {
    const r = d.rows[s.id];
    if (!r) continue;
    const homes = homesBy[s.id] ?? [], before = storedSrc(s, homes);
    if (r.src !== before) out.push({ label: `${s.name}: offset held`, before: srcText(before, homes), after: srcText(r.src, homes), kind: "src" });
    if (r.src === "") continue;
    const h = homes.find((x) => x.entity === r.src);
    if (h?.offline) continue;
    const now = valueAt(s, r.src, homes), v = leafValue(r), places = placesOf(limitsOf(r.src, homes).step);
    if (Math.abs(v - now) > 1e-9) out.push({ label: `${s.name}: leaf temperature offset`, before: phrase(now, places), after: `${phrase(v, places)}${h ? ", on the board" : ""}`, kind: h ? "board" : "kept" });
  }
  const was = basisOf(sensors, storedBasis), now = basisOf(sensors, d.basis);
  const name = (id: string) => (id ? (sensors.find((s) => s.id === id)?.name ?? id) : "Average");
  if (was !== now) out.push({ label: "VPD chart uses", before: name(was), after: name(now), kind: "basis" });
  return out;
}

/* What Environment Control stores: each sensor's source, an offset kept here, and the chart's choice. A board's own
   value isn't stored here at all; it's written to the board afterwards. */
export function applyLeafConfig(c: RawConfig, d: LeafDraft, sensors: StoredSensor[], homesBy: Record<string, Home[]>): void {
  const z = c.zones.find((x) => x.id === d.zoneId);
  if (!z) return;
  for (const raw of Array.isArray(z.sensors) ? z.sensors : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>, r = d.rows[s.id as string];
    if (!r || r.src === "") continue;
    if (r.src === KEPT) {
      delete s.leafEntity;
      /* With a board that could hold one, kept here is a choice, recorded so the screen stops asking. */
      if ((homesBy[s.id as string] ?? []).length) s.leafUnused = true;
      else delete s.leafUnused;
      s.leaf = tidy(leafValue(r));
    } else {
      s.leafEntity = r.src;
      delete s.leafUnused;
    }
  }
  const basis = basisOf(sensors, d.basis);
  if (basis) z.leafBasis = basis;
  else delete z.leafBasis;
}

/* The boards to write after the setup is saved: each row on a board that's online and holds a different value. */
export function boardSends(d: LeafDraft, sensors: StoredSensor[], homesBy: Record<string, Home[]>): { sensor: StoredSensor; entity: string; value: number }[] {
  const out: { sensor: StoredSensor; entity: string; value: number }[] = [];
  for (const s of sensors) {
    const r = d.rows[s.id], h = r && (homesBy[s.id] ?? []).find((x) => x.entity === r.src);
    if (!r || !h || h.offline) continue;
    const value = tidy(leafValue(r));
    if (h.value === null || Math.abs(value - h.value) > 1e-9) out.push({ sensor: s, entity: h.entity, value });
  }
  return out;
}

/* What one sensor would read at an offset: its air, its leaf and its VPD. A board's own VPD is used while the offset is
   still the one it holds. */
export function previewVpd(s: StoredSensor, offset: number, states: Record<string, HaState>, now: number): number | null {
  const r = readSensor(s, states, now), t = r.values.temperature, h = r.values.humidity;
  if (s.entities.vpd && Math.abs(offset - leafOf(s, states)) < 1e-9) return r.values.vpd ?? null;
  return t === null || t === undefined || h === null || h === undefined ? null : calcVpd(t, h, offset);
}

export function previewText(s: StoredSensor, offset: number, states: Record<string, HaState>, now: number): string {
  const t = readSensor(s, states, now).values.temperature, vpd = previewVpd(s, offset, states, now);
  const left = s.avg ? "" : " Not counted in the zone reading.";
  if (t === null || t === undefined) return `No data from this sensor right now.${left}`;
  return `Air ${t.toFixed(1)} °C, leaf ${(t + offset).toFixed(1)} °C${vpd === null ? "" : `, VPD ${vpd.toFixed(2)} kPa`}.${left}`;
}

/* The zone's VPD at the draft's offsets, combined the way its reading is. */
export function zoneVpdAt(d: LeafDraft, sensors: StoredSensor[], method: Method, states: Record<string, HaState>, now: number): number | null {
  const xs = countedOf(sensors)
    .filter((s) => readSensor(s, states, now).health === "ok")
    .map((s) => previewVpd(s, d.rows[s.id] ? leafValue(d.rows[s.id]) : leafOf(s, states), states, now))
    .filter((v): v is number => v !== null);
  return combine(method, xs);
}

/* The one offset the VPD chart is drawn at: the picked sensor's, or the average of those counted. */
export function chartLeaf(d: LeafDraft, sensors: StoredSensor[]): number {
  const used = countedOf(sensors).filter((s) => d.rows[s.id]), basis = basisOf(sensors, d.basis);
  if (basis) return leafValue(d.rows[basis]);
  if (!used.length) return 0;
  return used.reduce((a, s) => a + leafValue(d.rows[s.id]), 0) / used.length;
}
