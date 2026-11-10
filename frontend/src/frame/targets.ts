/* Targets: a zone's limits, day and night. Every reading has five values in order, Min, Low, Target, High and Max: Low
   to High is the ideal zone, Min and Max are critical, and the Target is optional, one choice for the whole zone. Light
   has one limit a period, a floor by day and a ceiling by night.

   A limit lives in one place. Min, Target, Max and the light limits can each sit on one of your number helpers, so your
   alerts and this panel read the same number; Low and High, and anything without a helper, are stored here. A helper's
   value is what HA reports, never what was typed, and a write to one counts only once HA reports it. The same
   functions give every screen its limits, so a tile, a chart and this page can't disagree. */
import type { Catalog } from "./messages";
import type { RawConfig } from "./model";
import { type HaState, calcVpd, leafOf, numberOf, sensorsOf } from "./readings";
import { helperEntity } from "./schedule";

export type Period = "day" | "night";
export type BandKey = "temperature" | "humidity" | "vpd";
export type Edit = "target" | BandKey;
export const PERIODS: [Period, string][] = [["day", "Day"], ["night", "Night"]];
export const BAND_KEYS: BandKey[] = ["temperature", "humidity", "vpd"];
export const VNAME: Record<BandKey, string> = { temperature: "Temperature", humidity: "Humidity", vpd: "VPD" };
export const VUNIT: Record<BandKey, string> = { temperature: "°", humidity: "%", vpd: " kPa" };
/* Drag steps. Typed values are kept as typed, since exact figures such as Athena's 22.2 are why you'd type. */
export const VSNAP: Record<BandKey, number> = { temperature: 0.5, humidity: 1, vpd: 0.05 };
/* Wider than the chart: a Max of 36° is a sensible limit even though the axis stops at 34. */
export const VRANGE: Record<BandKey, [number, number]> = { temperature: [0, 50], humidity: [0, 100], vpd: [0, 5] };
export const VDECIMALS = { temperature: 1, humidity: 1, vpd: 2, light: 0 } as const;
export const SLOT_NAME = ["Min", "Low", "Target", "High", "Max"] as const;
export const HANDLES = [0, 1, 3, 4] as const;
export const T_MIN = 16, T_MAX = 34, RH_TOP = 90, RH_LOW = 30;
/* Athena's Optimal Environment table sets Low and High. Athena gives no critical limits, so Min and Max start a margin
   outside. */
export const STAGES: Record<string, { label: string } & Record<BandKey, [number, number]>> = {
  veg: { label: "Veg", temperature: [22.2, 27.7], humidity: [58, 75], vpd: [0.8, 1.0] },
  stretch: { label: "Flower stretch", temperature: [25.5, 27.7], humidity: [60, 72], vpd: [1.0, 1.2] },
  bulk: { label: "Flower bulk", temperature: [23.8, 26.6], humidity: [60, 70], vpd: [1.0, 1.2] },
  finish: { label: "Flower finish", temperature: [18.3, 22.2], humidity: [50, 60], vpd: [1.2, 1.4] },
};
export const STAGE_MARGIN: Record<BandKey, number> = { temperature: 2, humidity: 5, vpd: 0.15 };
/* What the zone's light sensor is held to: lux, and nothing on the light controller reads them. */
export const LIGHT_LIMIT: Record<Period, { key: "dayMin" | "nightMax"; slot: "Min" | "Max"; column: 0 | 4 }> = {
  day: { key: "dayMin", slot: "Min", column: 0 },
  night: { key: "nightMax", slot: "Max", column: 4 },
};
/* A light limit kept here. One on a helper follows the helper's own limits instead. */
export const LIGHT_RANGE = { min: 0, max: 10000, step: 10 };
/* HA writes Celsius both ways: °C, and the single character ℃. */
export const LINK_UNITS: Record<BandKey | "light", string[]> = { temperature: ["°C", "℃"], humidity: ["%"], vpd: ["kPa"], light: ["lx"] };
const LINK_UNIT_NAME: Record<BandKey | "light", string> = { temperature: "°C", humidity: "%", vpd: "kPa", light: "lx" };
const SLOTS = { min: 0, target: 2, max: 4 } as const;
type Slot = keyof typeof SLOTS;

export type PeriodBands = Record<BandKey, (number | null)[]> & { light: number };
export type Bands = Record<Period, PeriodBands>;

export interface TargetsDraft {
  zoneId: string;
  /* helpers: limits may sit on your helpers, each picked below; here: all stored in Environment Control. */
  source: "helpers" | "here";
  /* Every limit that can sit on a helper, by name, and the helper it's linked to, "" for kept here. */
  links: Record<string, string>;
  bands: Bands;
  /* What's on show and being edited. None of it is saved. */
  period: Period;
  edit: Edit;
  sel: number | null;
  stage: string | null;
}
export interface TargetChange {
  label: string;
  before: string;
  after: string;
  kind: "src" | "here" | "helper";
}
export interface TargetIssue {
  text: string;
  /* The box or picker that fixes it. */
  target?: string;
  edit?: BandKey | "light";
  slot?: number;
  /* Fixed on Sensor Calibration: no conditions fit at this leaf temperature offset. */
  calibrate?: boolean;
  /* The problem is in the period not on show. */
  switchTo?: Period;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const round2 = (x: number) => Math.round(x * 100) / 100;
export const stepped = (x: number) => Math.round(x * 20) / 20;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const snapTo = (x: number, step: number) => round2(Math.round(x / step) * step);
const differs = (a: number | null, b: number | null) => (a === null || b === null ? a !== b : Math.abs(a - b) > 1e-9);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* Names: bands.day.temperature.min, light.dayMin. The host knows the same names and no others. */
export const bandName = (p: Period, k: BandKey, slot: Slot) => `bands.${p}.${k}.${slot}`;
export const lightName = (p: Period) => `light.${LIGHT_LIMIT[p].key}`;
export const limitNames = (p: Period) => [...BAND_KEYS.flatMap((k) => (Object.keys(SLOTS) as Slot[]).map((s) => bandName(p, k, s))), lightName(p)];
export const allLimitNames = () => [...limitNames("day"), ...limitNames("night")];
export const linkKind = (n: string): BandKey | "light" => (n.startsWith("light.") ? "light" : (n.split(".")[2] as BandKey));
export const isTargetLink = (n: string) => n.endsWith(".target");
export const linkTarget = (n: string) => `tl-${n.replace(/\./g, "-")}`;
export function linkLabel(n: string): string {
  const [a, p, k, s] = n.split(".");
  if (a === "light") return p === "dayMin" ? "Day light Min" : "Night light Max";
  return `${cap(p)} ${k === "vpd" ? "VPD" : k} ${cap(s)}`;
}
const linkAt = (z: Record<string, unknown> | undefined, n: string): string => {
  const e = n.split(".").reduce<unknown>((o, key) => (isObj(o) ? o[key] : undefined), isObj(z?.helpers) ? z.helpers : {});
  return typeof e === "string" ? e : "";
};
/* Where each limit of a period sits in its five values, or on the light limit. */
function place(n: string): { p: Period; k: BandKey | "light"; i: number } {
  const [a, p, k, s] = n.split(".");
  if (a === "light") return { p: p === "dayMin" ? "day" : "night", k: "light", i: 0 };
  return { p: p as Period, k: k as BandKey, i: SLOTS[s as Slot] };
}
const getAt = (b: Bands, n: string): number | null => {
  const { p, k, i } = place(n);
  return k === "light" ? b[p].light : b[p][k][i];
};
const setAt = (b: Bands, n: string, v: number | null): void => {
  const { p, k, i } = place(n);
  if (k === "light") b[p].light = v ?? 0;
  else b[p][k][i] = v;
};

/* The limits as stored here. Anything that isn't five numbers reads as 0s, which can't be confirmed. */
export function storedBands(z: Record<string, unknown> | undefined): Bands {
  const five = (v: unknown): (number | null)[] => {
    const a = Array.isArray(v) && v.length === 5 ? v : [0, 0, 0, 0, 0];
    return a.map((x, i) => (typeof x === "number" && Number.isFinite(x) ? x : i === 2 && x === null ? null : 0));
  };
  const bands = isObj(z?.bands) ? z.bands : {}, light = isObj(z?.lightLimits) ? z.lightLimits : {};
  const period = (p: Period): PeriodBands => {
    const b = isObj(bands[p]) ? (bands[p] as Record<string, unknown>) : {}, l = light[LIGHT_LIMIT[p].key];
    return { temperature: five(b.temperature), humidity: five(b.humidity), vpd: five(b.vpd), light: typeof l === "number" && Number.isFinite(l) ? l : 0 };
  };
  return { day: period("day"), night: period("night") };
}
export const storedLinks = (z: Record<string, unknown> | undefined): Record<string, string> => Object.fromEntries(allLimitNames().map((n) => [n, linkAt(z, n)]));

/* What a helper holds: its live state once it's linked, or what HA's list said when the page opened. */
function helperValue(entity: string, states: Record<string, HaState>, catalog: Catalog | null): number | null {
  if (!entity) return null;
  const live = numberOf(states[entity]);
  if (live !== null || states[entity]) return live;
  return numberOf({ state: helperEntity(catalog, entity)?.state ?? "", attributes: {}, at: null });
}
export function helperRange(entity: string, states: Record<string, HaState>, catalog: Catalog | null): { min: number; max: number; step: number } | null {
  const a = states[entity]?.attributes ?? {}, c = helperEntity(catalog, entity);
  const pick = (k: "min" | "max" | "step") => (typeof a[k] === "number" ? (a[k] as number) : c?.[k]);
  const min = pick("min"), max = pick("max"), step = pick("step");
  return typeof min === "number" && typeof max === "number" && typeof step === "number" && step > 0 ? { min, max, step } : null;
}
const helperUnit = (entity: string, states: Record<string, HaState>, catalog: Catalog | null) => {
  const u = states[entity]?.attributes.unit_of_measurement;
  return typeof u === "string" ? u : (helperEntity(catalog, entity)?.unit ?? "");
};

export const hasTarget = (bands: Bands) => PERIODS.some(([p]) => BAND_KEYS.some((k) => bands[p][k][2] !== null));

/* Limits under a set of links: each linked one as its helper reports it, the rest as stored. With no target, target
   helpers aren't read. A helper with no number to give falls back to what's stored, the last known. */
function bandsUnder(links: Record<string, string>, useLinks: boolean, aim: boolean, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null): Bands {
  const b = storedBands(z);
  if (!useLinks) return b;
  for (const n of allLimitNames()) {
    if (!links[n] || (isTargetLink(n) && !aim)) continue;
    const v = helperValue(links[n], states, catalog);
    if (v !== null) setAt(b, n, v);
  }
  return b;
}

/* A zone's limits as every screen judges by them. */
export function liveBands(z: Record<string, unknown> | undefined, states: Record<string, HaState>): Bands {
  const stored = storedBands(z);
  return bandsUnder(storedLinks(z), true, hasTarget(stored), z, states, null);
}
/* The zone with those limits in place of its stored ones, for code that reads a zone's bands. */
export function withLiveLimits(z: Record<string, unknown> | undefined, states: Record<string, HaState>): Record<string, unknown> | undefined {
  if (!z) return z;
  const b = liveBands(z, states), strip = (p: PeriodBands) => ({ temperature: p.temperature, humidity: p.humidity, vpd: p.vpd });
  return { ...z, bands: { day: strip(b.day), night: strip(b.night) }, lightLimits: { dayMin: b.day.light, nightMax: b.night.light } };
}

/* The one offset the VPD chart is drawn at: the picked sensor's, or the average of those counted, to 0.1. */
export function zoneLeaf(z: Record<string, unknown> | undefined, states: Record<string, HaState>): number {
  const envs = sensorsOf(z).filter((s) => s.kind === "env"), counted = envs.filter((s) => s.avg);
  const picked = counted.find((s) => s.id === z?.leafBasis);
  if (picked) return leafOf(picked, states);
  const used = counted.length ? counted : envs;
  return used.length ? Math.round((used.reduce((a, s) => a + leafOf(s, states), 0) / used.length) * 10) / 10 : 0;
}

const sourceOf = (z: Record<string, unknown> | undefined) => (Object.values(storedLinks(z)).some(Boolean) ? "helpers" : "here");

export function openTargets(z: Record<string, unknown> | undefined, zoneId: string, states: Record<string, HaState>, catalog: Catalog | null, period: Period): TargetsDraft {
  const links = storedLinks(z), source = sourceOf(z), aim = hasTarget(storedBands(z));
  const bands = bandsUnder(links, source === "helpers", aim, z, states, catalog);
  return { zoneId, source, links, bands, period, edit: hasTarget(bands) ? "target" : "temperature", sel: null, stage: null };
}

/* Links that count as things stand: only while the zone uses its helpers, and a target's only while it aims for one. */
export const linksInUse = (d: TargetsDraft) => (d.source === "helpers" ? allLimitNames().filter((n) => d.links[n] && (hasTarget(d.bands) || !isTargetLink(n))) : []);

/* Picking a helper shows what it holds, and editing that box then writes there. Unlinking keeps the number, here. */
export function pickLink(d: TargetsDraft, n: string, entity: string, states: Record<string, HaState>, catalog: Catalog | null): void {
  d.links[n] = entity;
  const v = entity ? helperValue(entity, states, catalog) : null;
  if (v !== null && (hasTarget(d.bands) || !isTargetLink(n))) setAt(d.bands, n, v);
}
/* Changing where limits come from keeps the numbers on show, except that a linked helper brings its own. */
export function setSource(d: TargetsDraft, source: "helpers" | "here", states: Record<string, HaState>, catalog: Catalog | null): void {
  d.source = source;
  if (source !== "helpers") return;
  for (const n of linksInUse(d)) {
    const v = helperValue(d.links[n], states, catalog);
    if (v !== null) setAt(d.bands, n, v);
  }
}

function midTarget(b: PeriodBands): void {
  b.temperature[2] = round2(((b.temperature[1] ?? 0) + (b.temperature[3] ?? 0)) / 2);
  b.humidity[2] = Math.round(((b.humidity[1] ?? 0) + (b.humidity[3] ?? 0)) / 2);
  b.vpd[2] = stepped(((b.vpd[1] ?? 0) + (b.vpd[3] ?? 0)) / 2);
}
/* A target is one choice per zone: a zone with none holds none in either period. Turning one on starts it midway
   between Low and High. */
export function setTarget(d: TargetsDraft, aim: boolean): void {
  for (const [p] of PERIODS) {
    if (aim) midTarget(d.bands[p]);
    else for (const k of BAND_KEYS) d.bands[p][k][2] = null;
  }
  if (!aim && d.edit === "target") d.edit = "temperature";
  if (aim) d.edit = "target";
  d.sel = null;
}
/* An Athena stage fills the period on show: Low and High from the table, Min and Max a margin outside. Light is left. */
export function applyStage(d: TargetsDraft, id: string): void {
  const b = d.bands[d.period], s = STAGES[id], aim = hasTarget(d.bands);
  if (!s) return;
  for (const k of BAND_KEYS) {
    const [lo, hi] = s[k], m = STAGE_MARGIN[k];
    b[k] = [round2(lo - m), lo, null, hi, round2(hi + m)];
  }
  if (aim) midTarget(b);
  d.stage = id;
  d.sel = null;
}

/* The chart: temperature across, humidity down, each cell its leaf VPD. */
export const rhAt = (t: number, vp: number, leaf: number) => {
  const svp = (x: number) => 0.6108 * Math.exp((17.27 * x) / (x + 237.3));
  return ((svp(t + leaf) - vp) / svp(t)) * 100;
};
/* Athena's ranges: under 0.8 outside, 0.8 to 1.0 veg, 1.0 to 1.2 flower stretch and bulk, 1.2 to 1.4 finish, over outside. */
export const vzone = (v: number) => (v < 0.8 ? 0 : v < 1.0 ? 1 : v < 1.2 ? 2 : v < 1.4 ? 3 : 4);
export function vGeom() {
  const cw = 34, ch = 30, L = 38, T = 46, cols = T_MAX - T_MIN + 1, rows = (RH_TOP - RH_LOW) / 5 + 1;
  return {
    cw, ch, L, T, cols, rows, W: L + cols * cw + 8, H: T + rows * ch + 22, right: L + cols * cw, bottom: T + rows * ch,
    X: (t: number) => L + (t - T_MIN) * cw + cw / 2,
    Y: (rh: number) => T + ((RH_TOP - rh) / 5) * ch + ch / 2,
    invX: (px: number) => (px - L - cw / 2) / cw + T_MIN,
    invY: (py: number) => RH_TOP - ((py - T - ch / 2) / ch) * 5,
  };
}
/* How many conditions sit inside every ideal range at once. None is a conflict: nothing can ever read ideal. */
export function idealCount(b: PeriodBands, leaf: number): number {
  let n = 0;
  const [tl, th, hl, hh, vl, vh] = [b.temperature[1], b.temperature[3], b.humidity[1], b.humidity[3], b.vpd[1], b.vpd[3]].map((x) => x ?? 0);
  for (let rh = RH_TOP; rh >= RH_LOW; rh -= 1)
    for (let t = T_MIN; t <= T_MAX; t += 0.5) {
      const p = calcVpd(t, rh, leaf);
      if (t >= tl && t <= th && rh >= hl && rh <= hh && p >= vl && p <= vh) n++;
    }
  return n;
}

/* A line stops at its neighbours, so dragging can't break the order. With no target, Low and High are neighbours. */
export function placeHandle(b: PeriodBands, k: BandKey, i: number, val: number): void {
  const before = b[k].slice(0, i).filter((x): x is number => x !== null), after = b[k].slice(i + 1).filter((x): x is number => x !== null);
  const lo = before.length ? before[before.length - 1] : VRANGE[k][0], hi = after.length ? after[0] : VRANGE[k][1];
  b[k][i] = round2(clamp(val, lo, hi));
}
export const canNudge = (d: TargetsDraft) => d.edit !== "target" && d.sel !== null;
export function nudge(d: TargetsDraft, dir: number): void {
  if (d.edit === "target" || d.sel === null) return;
  placeHandle(d.bands[d.period], d.edit, d.sel, (d.bands[d.period][d.edit][d.sel] ?? 0) + dir * VSNAP[d.edit]);
}
/* A press picks the nearest line of the kind being edited, then moves it; the target is one point, moved whole and
   kept inside the ideal zone. px and py are in the chart's own units. */
export function moveOnChart(d: TargetsDraft, leaf: number, px: number, py: number, start: boolean): void {
  const g = vGeom(), b = d.bands[d.period];
  const t = clamp(g.invX(px), T_MIN, T_MAX), rh = clamp(g.invY(py), RH_LOW, RH_TOP);
  if (d.edit === "target") {
    if (b.temperature[2] === null) return;
    b.temperature[2] = round2(clamp(snapTo(t, VSNAP.temperature), b.temperature[1] ?? 0, b.temperature[3] ?? 0));
    b.humidity[2] = round2(clamp(snapTo(rh, VSNAP.humidity), b.humidity[1] ?? 0, b.humidity[3] ?? 0));
    b.vpd[2] = stepped(calcVpd(b.temperature[2], b.humidity[2], leaf));
    return;
  }
  const k = d.edit, at = (i: number) => b[k][i] ?? 0;
  const dist = (i: number) => (k === "temperature" ? Math.abs(g.X(at(i)) - px) : k === "humidity" ? Math.abs(g.Y(at(i)) - py) : Math.abs(g.Y(rhAt(t, at(i), leaf)) - py));
  if (start || d.sel === null) d.sel = HANDLES.reduce<number>((a, c) => (dist(c) < dist(a) ? c : a), HANDLES[0]);
  const raw = k === "temperature" ? t : k === "humidity" ? rh : calcVpd(t, rh, leaf);
  placeHandle(b, k, d.sel, snapTo(raw, VSNAP[k]));
}

/* A typed value, kept as typed. Blank or not a number keeps the old one. Target temperature, humidity and VPD are one
   point on the chart, so changing one moves another; what moved is said. */
export function typeBox(d: TargetsDraft, k: BandKey | "light", i: number, typed: string, leaf: number): string {
  const b = d.bands[d.period], t = typed.trim().replace(",", "."), n = t === "" ? Number.NaN : Number(t);
  if (!Number.isFinite(n)) return "";
  const val = Number(n.toFixed(VDECIMALS[k]));
  if (k === "light") {
    b.light = val;
    return "";
  }
  if (val === b[k][i]) return "";
  b[k][i] = val;
  if (i !== 2) return "";
  const T = b.temperature[2], RH = b.humidity[2];
  if (k === "vpd" && T !== null) {
    b.humidity[2] = Number(rhAt(T, val, leaf).toFixed(VDECIMALS.humidity));
    return `Humidity Target moved to ${b.humidity[2]}% to give that VPD at ${T}°.`;
  }
  if (T !== null && RH !== null) b.vpd[2] = round2(calcVpd(T, RH, leaf));
  return "";
}

/* The target is one point, so a new leaf temperature offset gives it a new VPD. If that leaves the VPD's ideal range,
   moving only the VPD would break humidity instead, so the point moves to the nearest place inside every ideal range. */
export function followLeaf(d: TargetsDraft, leaf: number): boolean {
  let moved = false;
  for (const [p] of PERIODS) {
    const b = d.bands[p], T = b.temperature[2], RH = b.humidity[2];
    if (T === null || RH === null) continue;
    const here = stepped(calcVpd(T, RH, leaf)), [vl, vh] = [b.vpd[1] ?? 0, b.vpd[3] ?? 0];
    b.vpd[2] = here;
    if (here >= vl && here <= vh) continue;
    let best: [number, number, number] | null = null, gap = Number.POSITIVE_INFINITY;
    for (let t = b.temperature[1] ?? 0; t <= (b.temperature[3] ?? 0) + 1e-9; t += 0.1)
      for (let rh = b.humidity[1] ?? 0; rh <= (b.humidity[3] ?? 0) + 1e-9; rh += 0.5) {
        const v = stepped(calcVpd(t, rh, leaf)), dist = (t - T) ** 2 + (rh - RH) ** 2;
        if (v >= vl && v <= vh && dist < gap) [gap, best] = [dist, [Number(t.toFixed(1)), Number(rh.toFixed(1)), v]];
      }
    if (!best) continue;
    [b.temperature[2], b.humidity[2], b.vpd[2]] = best;
    moved = true;
  }
  return moved;
}

const linked = (d: TargetsDraft, n: string) => (linksInUse(d).includes(n) ? d.links[n] : "");

function periodProblems(d: TargetsDraft, p: Period, states: Record<string, HaState>, catalog: Catalog | null, leaf: number): TargetIssue[] {
  const b = d.bands[p], out: TargetIssue[] = [];
  for (const k of BAND_KEYS) {
    const [lo, hi] = VRANGE[k], v = b[k], box = (i: number) => ({ target: `vin-${k}-${i}`, edit: k, slot: i });
    const prev = (n: number) => (v[n - 1] === null ? v[n - 2] : v[n - 1]);
    const outside = v.findIndex((x) => x !== null && (x < lo || x > hi));
    const early = v.findIndex((x, n) => n > 0 && x !== null && x < (prev(n) ?? x));
    if (outside >= 0) out.push({ text: `${VNAME[k]} ${SLOT_NAME[outside]} has to be between ${lo} and ${hi}${VUNIT[k]}.`, ...box(outside) });
    else if (early > 0) out.push({ text: `${VNAME[k]} ${SLOT_NAME[early]} can't be below ${SLOT_NAME[v[early - 1] === null ? early - 2 : early - 1]}. They run Min, Low, Target, High, Max.`, ...box(early) });
    else if ((v[0] ?? 0) >= (v[4] ?? 0)) out.push({ text: `${VNAME[k]} Max has to be above Min.`, ...box(4) });
  }
  /* A value going to a helper has to fit the helper: its own limits and step. */
  const fits = (n: string, x: number | null, label: string, at: Pick<TargetIssue, "target" | "edit" | "slot">) => {
    const e = linked(d, n), a = e ? helperRange(e, states, catalog) : null;
    if (!a || x === null) return true;
    const steps = (x - a.min) / a.step;
    if (x >= a.min && x <= a.max && Math.abs(steps - Math.round(steps)) <= 1e-6) return true;
    out.push({ text: `${label} goes to your helper, which takes ${a.min} to ${a.max} in steps of ${a.step}.`, ...at });
    return false;
  };
  for (const k of BAND_KEYS) for (const slot of Object.keys(SLOTS) as Slot[]) fits(bandName(p, k, slot), b[k][SLOTS[slot]], `${VNAME[k]} ${SLOT_NAME[SLOTS[slot]]}`, { target: `vin-${k}-${SLOTS[slot]}`, edit: k, slot: SLOTS[slot] });
  const light = { target: "vin-light-0", edit: "light" as const, slot: 0 };
  if (linked(d, lightName(p))) fits(lightName(p), b.light, "Light limit", light);
  else if (b.light < LIGHT_RANGE.min || b.light > LIGHT_RANGE.max) out.push({ text: `Light limit has to be between ${LIGHT_RANGE.min} and ${LIGHT_RANGE.max.toLocaleString()} lx.`, ...light });
  else if (b.light % LIGHT_RANGE.step) out.push({ text: `Light limit goes in steps of ${LIGHT_RANGE.step} lx.`, ...light });
  if (!out.length && !idealCount(b, leaf)) out.push({ text: "No conditions fit all of your ideal zone at this leaf temperature offset. Change the offset or widen a limit.", calibrate: true });
  return out;
}

/* Everything that stops a review. Both periods count, since both are judged by: the one on show lists its problems,
   and the other says it has one, with a way there. */
export function targetIssues(d: TargetsDraft, states: Record<string, HaState>, catalog: Catalog | null, leaf: number): TargetIssue[] {
  const out: TargetIssue[] = [];
  if (d.source === "helpers") {
    const used = linksInUse(d), seen: Record<string, string> = {};
    if (!used.length) out.push({ text: "Link at least one limit to a helper, or choose Set here.", target: linkTarget(bandName(d.period, "temperature", "min")) });
    for (const n of used) {
      const e = d.links[n], kind = linkKind(n), u = helperUnit(e, states, catalog), target = linkTarget(n), switchTo = place(n).p === d.period ? undefined : place(n).p;
      const add = (text: string) => out.push(switchTo ? { text, switchTo } : { text, target });
      if (catalog && !helperEntity(catalog, e) && !states[e]) add(`${linkLabel(n)}: ${e} isn't in Home Assistant. Pick another helper.`);
      else if (u && !LINK_UNITS[kind].includes(u)) add(`${linkLabel(n)}: ${e} is in ${u}, not ${LINK_UNIT_NAME[kind]}.`);
      if (seen[e]) add(`${e} is linked to both ${linkLabel(seen[e])} and ${linkLabel(n)}. Pick one helper for each.`);
      else seen[e] = n;
    }
  }
  out.push(...periodProblems(d, d.period, states, catalog, leaf));
  const other = PERIODS.find(([p]) => p !== d.period && periodProblems(d, p, states, catalog, leaf).length);
  if (other) out.push({ text: `${other[1]} has a value to fix.`, switchTo: other[0] });
  return out;
}

const helperText = (e: string, states: Record<string, HaState>, catalog: Catalog | null) => {
  const name = helperEntity(catalog, e)?.name, v = helperValue(e, states, catalog), u = helperUnit(e, states, catalog);
  return `${name && name !== e ? `${name} (${e})` : e}${v === null ? "" : `, ${v}${u ? ` ${u}` : ""}`}`;
};
const said = (k: BandKey, n: number | null) => (n === null ? "None" : `${round2(n)}${VUNIT[k]}`);

/* What the page would change, against what's saved and what the helpers report under the links as drafted. */
export function targetChanges(d: TargetsDraft, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null): TargetChange[] {
  const out: TargetChange[] = [], wasSource = sourceOf(z), wasLinks = storedLinks(z), aim = hasTarget(d.bands);
  const add = (label: string, before: string, after: string, kind: TargetChange["kind"]) => before !== after && out.push({ label, before, after, kind });
  const words = { helpers: "From your helpers", here: "Set here" };
  add("Limits", words[wasSource], words[d.source], "src");
  if (d.source === "helpers")
    for (const n of allLimitNames()) {
      if (isTargetLink(n) && !aim) continue;
      const was = wasSource === "helpers" ? wasLinks[n] : "";
      add(`${linkLabel(n)} helper`, was ? helperText(was, states, catalog) : "Set here", d.links[n] ? helperText(d.links[n], states, catalog) : "Set here", "src");
    }
  const now = bandsUnder(d.links, d.source === "helpers", aim, z, states, catalog);
  for (const [p, day] of PERIODS)
    for (const k of BAND_KEYS)
      d.bands[p][k].forEach((x, i) => {
        const slot = (Object.keys(SLOTS) as Slot[]).find((s) => SLOTS[s] === i), onHelper = !!slot && !!linked(d, bandName(p, k, slot)) && x !== null;
        if (differs(x, now[p][k][i])) out.push({ label: `${day} ${VNAME[k]} ${SLOT_NAME[i]}${onHelper ? ", on your helper" : ""}`, before: said(k, now[p][k][i]), after: said(k, x), kind: onHelper ? "helper" : "here" });
      });
  for (const [p, day] of PERIODS) {
    const onHelper = !!linked(d, lightName(p)), lx = (n: number) => `${Math.round(n).toLocaleString()} lx`;
    if (differs(d.bands[p].light, now[p].light)) out.push({ label: `${day} Light ${LIGHT_LIMIT[p].slot}${onHelper ? ", on your helper" : ""}`, before: lx(now[p].light), after: lx(d.bands[p].light), kind: onHelper ? "helper" : "here" });
  }
  return out;
}

/* What Environment Control stores: where limits come from, the links in use and only those, and every value, a
   helper's as the last known. With no target, a target helper is no longer read or written, so its link goes. */
export function applyTargetsConfig(c: RawConfig, d: TargetsDraft): void {
  const z = c.zones.find((x) => x.id === d.zoneId);
  if (!z) return;
  const strip = (p: PeriodBands) => ({ temperature: [...p.temperature], humidity: [...p.humidity], vpd: [...p.vpd] });
  z.bands = { day: strip(d.bands.day), night: strip(d.bands.night) };
  z.lightLimits = { dayMin: d.bands.day.light, nightMax: d.bands.night.light };
  z.linked = d.source === "helpers";
  const h: Record<string, unknown> = { ...(isObj(z.helpers) ? z.helpers : {}) }, bands: Record<string, Record<string, Record<string, string>>> = {}, light: Record<string, string> = {};
  for (const n of linksInUse(d)) {
    const [a, p, k, s] = n.split(".");
    if (a === "light") light[p] = d.links[n];
    else ((bands[p] ??= {})[k] ??= {})[s] = d.links[n];
  }
  if (Object.keys(bands).length) h.bands = bands;
  else delete h.bands;
  if (Object.keys(light).length) h.light = light;
  else delete h.light;
  z.helpers = h;
}

/* The helpers to write once the setup is saved: each linked limit whose helper holds something different. */
export function targetSends(d: TargetsDraft, states: Record<string, HaState>, catalog: Catalog | null): { name: string; value: number; entity: string; label: string }[] {
  const out: { name: string; value: number; entity: string; label: string }[] = [];
  for (const n of linksInUse(d)) {
    const x = getAt(d.bands, n), held = helperValue(d.links[n], states, catalog);
    if (x !== null && differs(x, held)) out.push({ name: n, value: x, entity: d.links[n], label: linkLabel(n) });
  }
  return out;
}

/* Number helpers a limit could sit on: the ones in its unit first, the likeliest by name at the top. */
export function limitHelpers(n: string, zoneWords: string[], catalog: Catalog | null): { entity: string; name: string; state: string | null; unit: string | null; fits: boolean }[] {
  const kind = linkKind(n), { p, i } = place(n);
  const words = [...zoneWords, p, kind === "light" ? "light" : kind, kind === "light" ? LIGHT_LIMIT[p].slot.toLowerCase() : ["min", "", "target", "", "max"][i]].filter(Boolean);
  const score = (e: { entity_id: string; name: string }) => words.filter((w) => `${e.entity_id} ${e.name}`.toLowerCase().includes(w)).length;
  return (catalog?.entities ?? [])
    .filter((e) => e.domain === "input_number")
    .map((e) => ({ e, fits: LINK_UNITS[kind].includes(e.unit ?? ""), score: score(e) }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || b.score - a.score || a.e.name.localeCompare(b.e.name))
    .map(({ e, fits }) => ({ entity: e.entity_id, name: e.name, state: e.state, unit: e.unit, fits }));
}
