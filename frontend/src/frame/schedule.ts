/* Day and night, and red lights: where a zone's times come from and what they are, as a draft against what's saved
   and what its helpers report. Lights on and off come from two time helpers, are set here, or follow the zone's light
   switches. The Emerson effect's three extensions come from three number helpers, are set here, follow red light
   switches, or aren't used. A helper's value counts only once HA reports it, so nothing here treats a write as done.
   The same functions say whether it's day now, so every screen agrees. */
import type { Catalog, CatalogEntity } from "./messages";
import type { RawConfig } from "./model";
import { type HaState, isDay, numberOf } from "./readings";

export type PeriodMode = "helper" | "fixed" | "detected";
export type EmMode = "none" | "helper" | "fixed" | "detected";
export const PERIOD_MODES: Record<PeriodMode, string> = { helper: "From a helper", fixed: "Set here", detected: "Detected" };
export const EM_MODES: Record<EmMode, string> = { none: "Not used", helper: "From a helper", fixed: "Set here", detected: "Detected" };
export const EM_KEYS = ["morning", "daylight", "evening"] as const;
export type EmKey = (typeof EM_KEYS)[number];
export const EM_NAME: Record<EmKey, string> = { morning: "Morning extension", daylight: "Daylight time", evening: "Evening extension" };
/* Extensions set here: whole minutes, under an hour, as the dashboards' helpers have them. */
export const EM_LIMITS = { min: 0, max: 59, step: 1 };

export interface SchedDraft {
  zoneId: string;
  period: PeriodMode;
  onHelper: string;
  offHelper: string;
  /* HH:MM. */
  day: string;
  night: string;
  lights: string[];
  rule: "any" | "all";
  em: EmMode;
  emHelpers: Record<EmKey, string>;
  emerson: Record<EmKey, number>;
  red: string[];
  /* The page waits for HA's helper list, which says what each helper holds. */
  seeded: boolean;
  sending: boolean;
  fromGuide: boolean;
}
export interface SchedChange {
  label: string;
  before: string;
  after: string;
  /* src: where a value comes from; here: a value stored in Environment Control; helper: a value written to a helper. */
  kind: "src" | "here" | "helper";
}
export interface SchedIssue {
  text: string;
  target: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const ON_OFF = /^(switch|light|input_boolean)\.[a-z0-9_]+$/;

export const hhmm = (m: number) => {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
export const toMin = (t: string) => {
  const m = /^(\d\d):(\d\d)/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};
export const span = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
export const dayLength = (on: number, off: number) => span((((off - on) % 1440) + 1440) % 1440);

/* The red light windows, by the same sum as the dashboards' red lights failsafe: morning extension before lights on
   to daylight time after it, and daylight time before lights off to evening extension after it. */
export function emersonLine(day: string, night: string, e: Record<EmKey, number>): string {
  const on = toMin(day), off = toMin(night);
  return `Red lights ${hhmm(on - e.morning)} - ${hhmm(on + e.daylight)} and ${hhmm(off - e.daylight)} - ${hhmm(off + e.evening)}`;
}

const helpersOf = (z: Record<string, unknown> | undefined): Record<string, unknown> => (isObj(z?.helpers) ? (z.helpers as Record<string, unknown>) : {});
const listOf = (v: unknown) => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && ON_OFF.test(e)) : []);

export function periodModeOf(z: Record<string, unknown> | undefined): PeriodMode {
  const m = z?.periodMode, h = helpersOf(z);
  if (m === "helper" || m === "fixed" || m === "detected") return m;
  return h.day && h.night ? "helper" : "fixed";
}
export function emModeOf(z: Record<string, unknown> | undefined): EmMode {
  const m = z?.emersonMode, h = helpersOf(z);
  if (m === "none" || m === "helper" || m === "fixed" || m === "detected") return m;
  return h.morning ? "helper" : isObj(z?.emerson) ? "fixed" : "none";
}

/* A helper as HA has it: its live state once it's linked, or what HA's list said when the page opened. */
export function helperEntity(catalog: Catalog | null, entity: string): CatalogEntity | undefined {
  return catalog?.entities.find((e) => e.entity_id === entity);
}
export function helperState(entity: string, states: Record<string, HaState>, catalog: Catalog | null): string | null {
  if (!entity) return null;
  return states[entity]?.state ?? helperEntity(catalog, entity)?.state ?? null;
}
export function helperLimits(entity: string, states: Record<string, HaState>, catalog: Catalog | null) {
  const a = states[entity]?.attributes ?? {}, c = helperEntity(catalog, entity);
  const pick = (k: "min" | "max" | "step") => (typeof a[k] === "number" ? (a[k] as number) : c?.[k]);
  const min = pick("min"), max = pick("max"), step = pick("step");
  return typeof min === "number" && typeof max === "number" && typeof step === "number" && step > 0 ? { min, max, step } : EM_LIMITS;
}
const helperTime = (entity: string, states: Record<string, HaState>, catalog: Catalog | null) => {
  const s = helperState(entity, states, catalog);
  return s && /^\d\d:\d\d/.test(s) ? s.slice(0, 5) : null;
};
const helperNumber = (entity: string, states: Record<string, HaState>, catalog: Catalog | null) =>
  numberOf({ state: helperState(entity, states, catalog) ?? "", attributes: {}, at: null });

/* Time-only date and time helpers, for lights on and off. */
export const timeHelpers = (catalog: Catalog | null) => (catalog?.entities ?? []).filter((e) => e.domain === "input_datetime" && e.has_time === true && e.has_date === false);
/* Number helpers, minutes first, for the red light extensions. */
export const minuteHelpers = (catalog: Catalog | null) =>
  (catalog?.entities ?? [])
    .filter((e) => e.domain === "input_number")
    .sort((a, b) => Number(/^min/.test(b.unit ?? "")) - Number(/^min/.test(a.unit ?? "")) || a.name.localeCompare(b.name));
/* Everything that's on or off, for a zone that follows its switches. */
export function onOffChoices(catalog: Catalog | null): { entity: string; name: string; device: string | null; state: string | null }[] {
  const out: { entity: string; name: string; device: string | null; state: string | null }[] = [];
  for (const d of catalog?.devices ?? []) for (const e of d.entities) if (ON_OFF.test(e.entity_id)) out.push({ entity: e.entity_id, name: e.name, device: d.name, state: e.state });
  for (const e of catalog?.entities ?? []) if (ON_OFF.test(e.entity_id)) out.push({ entity: e.entity_id, name: e.name, device: null, state: e.state });
  return out;
}

/* What a source holds now: the helpers' values, or what's stored here. */
function timesFrom(d: Pick<SchedDraft, "period" | "onHelper" | "offHelper">, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null) {
  const stored = { day: hhmm(Number(z?.dayAt ?? 0)), night: hhmm(Number(z?.nightAt ?? 0)) };
  if (d.period !== "helper") return stored;
  return { day: helperTime(d.onHelper, states, catalog) ?? stored.day, night: helperTime(d.offHelper, states, catalog) ?? stored.night };
}
function emersonFrom(d: Pick<SchedDraft, "em" | "emHelpers">, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null) {
  const stored = isObj(z?.emerson) ? (z.emerson as Record<string, unknown>) : {};
  const out = {} as Record<EmKey, number>;
  for (const k of EM_KEYS) {
    const kept = typeof stored[k] === "number" ? (stored[k] as number) : 0;
    out[k] = d.em === "helper" ? (helperNumber(d.emHelpers[k], states, catalog) ?? kept) : kept;
  }
  return out;
}

export function openSched(z: Record<string, unknown> | undefined, zoneId: string, catalog: Catalog | null, states: Record<string, HaState>, fromGuide: boolean): SchedDraft {
  const h = helpersOf(z), period = periodModeOf(z), em = emModeOf(z);
  const base = {
    period,
    onHelper: period === "helper" ? str(h.day) : "",
    offHelper: period === "helper" ? str(h.night) : "",
    em,
    emHelpers: Object.fromEntries(EM_KEYS.map((k) => [k, em === "helper" ? str(h[k]) : ""])) as Record<EmKey, string>,
  };
  return {
    zoneId,
    ...base,
    ...timesFrom(base, z, states, catalog),
    lights: listOf(z?.lights),
    rule: z?.rule === "all" ? "all" : "any",
    emerson: emersonFrom(base, z, states, catalog),
    red: listOf(z?.redLights),
    seeded: !!catalog,
    sending: false,
    fromGuide,
  };
}

/* A changed source brings in what that source holds, so a newly picked helper shows its own value. */
export function reseed(d: SchedDraft, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null, what: "period" | "emerson"): void {
  if (what === "period") Object.assign(d, timesFrom(d, z, states, catalog));
  else d.emerson = emersonFrom(d, z, states, catalog);
}

export const timesApply = (d: SchedDraft) => d.period === "fixed" || (d.period === "helper" && !!d.onHelper && !!d.offHelper);
export const emersonApplies = (d: SchedDraft) => d.em === "fixed" || (d.em === "helper" && EM_KEYS.every((k) => d.emHelpers[k]));

export function schedIssues(d: SchedDraft, states: Record<string, HaState>, catalog: Catalog | null): SchedIssue[] {
  const out: SchedIssue[] = [];
  if (d.period === "helper") {
    if (!d.onHelper) out.push({ text: "Pick the lights on helper.", target: "sh-on" });
    if (!d.offHelper) out.push({ text: "Pick the lights off helper.", target: "sh-off" });
  }
  if (timesApply(d) && d.day === d.night) out.push({ text: "Lights on and lights off need two different times.", target: "sin-night" });
  if (d.period === "detected" && !d.lights.length) out.push({ text: "Pick at least one light for day and night to follow.", target: "s-lights" });
  if (d.em === "helper") for (const k of EM_KEYS) if (!d.emHelpers[k]) out.push({ text: `Pick the ${EM_NAME[k].toLowerCase()} helper.`, target: `seh-${k}` });
  if (emersonApplies(d))
    for (const k of EM_KEYS) {
      const L = d.em === "helper" ? helperLimits(d.emHelpers[k], states, catalog) : EM_LIMITS, v = d.emerson[k], steps = (v - L.min) / L.step;
      if (!Number.isFinite(v) || v < L.min || v > L.max) out.push({ text: `${EM_NAME[k]} has to be between ${L.min} and ${L.max} minutes.`, target: `sem-${k}` });
      else if (Math.abs(steps - Math.round(steps)) > 1e-6) out.push({ text: `${EM_NAME[k]} goes in steps of ${L.step} minutes.`, target: `sem-${k}` });
    }
  if (d.em === "detected" && !d.red.length) out.push({ text: "Pick at least one red light to follow.", target: "s-red" });
  return out;
}

const nameOf = (entity: string, catalog: Catalog | null) => {
  if (!entity) return "None";
  const e = helperEntity(catalog, entity) ?? catalog?.devices.flatMap((d) => d.entities).find((x) => x.entity_id === entity);
  return e && e.name !== entity ? `${e.name} (${entity})` : entity;
};
const names = (list: string[], catalog: Catalog | null) => (list.length ? [...list].sort().map((e) => nameOf(e, catalog)).join(", ") : "None");

/* Every difference from what's saved and what the helpers report, worked out as the review lists it. */
export function schedChanges(d: SchedDraft, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null): SchedChange[] {
  const out: SchedChange[] = [], was = openSched(z, d.zoneId, catalog, states, d.fromGuide);
  const add = (label: string, before: string, after: string, kind: SchedChange["kind"]) => before !== after && out.push({ label, before, after, kind });
  add("Day and night", PERIOD_MODES[was.period], PERIOD_MODES[d.period], "src");
  if (d.period === "helper") {
    add("Lights on helper", nameOf(was.period === "helper" ? was.onHelper : "", catalog), nameOf(d.onHelper, catalog), "src");
    add("Lights off helper", nameOf(was.period === "helper" ? was.offHelper : "", catalog), nameOf(d.offHelper, catalog), "src");
  }
  if (d.period === "detected") {
    add("Lights it follows", names(was.period === "detected" ? was.lights : [], catalog), names(d.lights, catalog), "src");
    if (d.lights.length > 1) add("It's day when", was.rule === "all" ? "All are on" : "Any is on", d.rule === "all" ? "All are on" : "Any is on", "src");
  }
  if (timesApply(d)) {
    const now = timesFrom(d, z, states, catalog), kind = d.period === "helper" ? "helper" : "here", where = d.period === "helper" ? ", on your helper" : "";
    add("Lights on", now.day, `${d.day}${now.day === d.day ? "" : where}`, kind);
    add("Lights off", now.night, `${d.night}${now.night === d.night ? "" : where}`, kind);
  }
  add("Red lights", EM_MODES[was.em], EM_MODES[d.em], "src");
  if (d.em === "helper") for (const k of EM_KEYS) add(`${EM_NAME[k]} helper`, nameOf(was.em === "helper" ? was.emHelpers[k] : "", catalog), nameOf(d.emHelpers[k], catalog), "src");
  if (d.em === "detected") add("Red lights it follows", names(was.em === "detected" ? was.red : [], catalog), names(d.red, catalog), "src");
  if (emersonApplies(d)) {
    const now = emersonFrom(d, z, states, catalog), kind = d.em === "helper" ? "helper" : "here", where = d.em === "helper" ? ", on your helper" : "";
    for (const k of EM_KEYS) add(EM_NAME[k], `${now[k]} min`, `${d.emerson[k]} min${now[k] === d.emerson[k] ? "" : where}`, kind);
  }
  return out;
}

/* What Environment Control stores: each source, the links in use and only those, and the values kept here. Times from
   helpers are kept too, as the last known ones, but it's the helpers that hold them. */
export function applySchedConfig(c: RawConfig, d: SchedDraft): void {
  const z = c.zones.find((x) => x.id === d.zoneId);
  if (!z) return;
  const h = { ...helpersOf(z) };
  z.periodMode = d.period;
  if (d.period === "helper") Object.assign(h, { day: d.onHelper, night: d.offHelper });
  else {
    delete h.day;
    delete h.night;
  }
  if (timesApply(d)) Object.assign(z, { dayAt: toMin(d.day), nightAt: toMin(d.night) });
  z.lights = d.period === "detected" ? [...d.lights] : [];
  z.rule = d.rule;
  z.emersonMode = d.em;
  for (const k of EM_KEYS) {
    if (d.em === "helper") h[k] = d.emHelpers[k];
    else delete h[k];
  }
  if (emersonApplies(d)) z.emerson = { ...d.emerson };
  else delete z.emerson;
  z.redLights = d.em === "detected" ? [...d.red] : [];
  z.helpers = h;
}

/* The helpers to write after the setup is saved: each value on a helper that holds something different. */
export function helperSends(d: SchedDraft, z: Record<string, unknown> | undefined, states: Record<string, HaState>, catalog: Catalog | null): { name: string; value: string | number; entity: string }[] {
  const out: { name: string; value: string | number; entity: string }[] = [];
  if (d.period === "helper" && timesApply(d)) {
    const now = timesFrom(d, z, states, catalog);
    if (now.day !== d.day) out.push({ name: "day", value: d.day, entity: d.onHelper });
    if (now.night !== d.night) out.push({ name: "night", value: d.night, entity: d.offHelper });
  }
  if (d.em === "helper" && emersonApplies(d)) {
    const now = emersonFrom(d, z, states, catalog);
    for (const k of EM_KEYS) if (now[k] !== d.emerson[k]) out.push({ name: k, value: d.emerson[k], entity: d.emHelpers[k] });
  }
  return out;
}

/* Whether a helper now reports a value, compared the way it's written: a time to the minute, a number exactly. */
export function reports(entity: string, value: string | number, states: Record<string, HaState>): boolean {
  const s = states[entity]?.state;
  if (typeof value === "string") return !!s && s.slice(0, 5) === value;
  const n = numberOf(states[entity]);
  return n !== null && Math.abs(n - value) < 1e-9;
}

/* A zone's times now: from its helpers' live values, or what's stored here. A zone that follows its switches has none. */
export function timesOf(z: Record<string, unknown> | undefined, states: Record<string, HaState>): { dayAt: number; nightAt: number } | null {
  const mode = periodModeOf(z);
  if (mode === "detected") return null;
  const stored = { dayAt: Number(z?.dayAt ?? 0), nightAt: Number(z?.nightAt ?? 0) };
  if (mode === "fixed") return stored;
  const h = helpersOf(z), on = states[str(h.day)]?.state, off = states[str(h.night)]?.state;
  const a = on ? toMin(on) : Number.NaN, b = off ? toMin(off) : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? { dayAt: a, nightAt: b } : stored;
}

/* Day or night now, by the zone's own source. A zone following its switches is day when any (or all) of them are on,
   and unknown when none of them is reporting. */
export function periodOf(z: Record<string, unknown> | undefined, states: Record<string, HaState>, minute: number): "day" | "night" | null {
  if (periodModeOf(z) === "detected") {
    const known = listOf(z?.lights).map((e) => states[e]?.state).filter((s) => s === "on" || s === "off");
    if (!known.length) return null;
    const on = z?.rule === "all" ? known.every((s) => s === "on") : known.some((s) => s === "on");
    return on ? "day" : "night";
  }
  const t = timesOf(z, states);
  return t && isDay(t.dayAt, t.nightAt, minute) ? "day" : "night";
}

/* Other zones linked to the same lights on helper, which a change here moves too. */
export function sharing(zones: Record<string, unknown>[], id: string): Record<string, unknown>[] {
  const me = zones.find((z) => z.id === id), link = periodModeOf(me) === "helper" ? str(helpersOf(me).day) : "";
  return link ? zones.filter((o) => o.id !== id && periodModeOf(o) === "helper" && str(helpersOf(o).day) === link) : [];
}
