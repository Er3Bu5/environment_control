/* Live readings, as the plan's accuracy rules have them. A dead sensor is never a number: unknown, unavailable or
   anything that isn't one reads as no data, is left out of every combined reading and is named. A reading that hasn't
   updated for a while is stale and treated the same way, so an ESP that stops polling while it stays connected can't
   pass an old number off as the zone's. One function combines a zone's readings, so Overview, a zone's tiles and later
   its charts can never disagree. */
import type { Method } from "./mapping";

export interface HaState {
  state: string;
  attributes: Record<string, unknown>;
  at: string | null;
}

/* The boards report every 10 seconds; one silent for this long has stopped, whatever it last said. */
export const STALE_MS = 10 * 60 * 1000;

export type Metric = "temperature" | "humidity" | "vpd" | "light";
export const METRIC = {
  temperature: { label: "Temperature", short: "Temp", unit: "°C", dp: 1 },
  humidity: { label: "Humidity", short: "RH", unit: "%", dp: 1 },
  vpd: { label: "VPD", short: "VPD", unit: "kPa", dp: 2 },
  light: { label: "Light", short: "Light", unit: "lx", dp: 0 },
} as const;

export type Health = "ok" | "dead" | "stale";

export function readState(raw: unknown): HaState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string") return null;
  const attributes = typeof r.attributes === "object" && r.attributes !== null && !Array.isArray(r.attributes) ? (r.attributes as Record<string, unknown>) : {};
  return { state: r.state, attributes, at: typeof r.at === "string" ? r.at : null };
}

/* A number from a state, or null for anything that isn't one. */
export function numberOf(st: HaState | null | undefined): number | null {
  if (!st || st.state.trim() === "") return null;
  const x = Number(st.state);
  return Number.isFinite(x) ? x : null;
}

export function healthOf(st: HaState | null | undefined, now: number): Health {
  if (numberOf(st) === null) return "dead";
  if (st?.at && now - Date.parse(st.at) > STALE_MS) return "stale";
  return "ok";
}

/* Leaf VPD by Tetens, the same sum the boards use. */
const svp = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
export const calcVpd = (t: number, rh: number, leafOffset: number) => svp(t + leafOffset) - (rh / 100) * svp(t);

export interface SensorReading {
  id: string;
  name: string;
  counted: boolean;
  health: Health;
  values: Partial<Record<Metric, number | null>>;
  at: string | null;
}

export interface StoredSensor {
  id: string;
  name: string;
  kind: "env" | "soil";
  entities: Partial<Record<string, string>>;
  leafEntity?: string;
  leafUnused?: boolean;
  leaf?: number;
  avg: boolean;
}

/* A sensor's offset: what its board reports, or the one kept in Environment Control, 0 until either is set. */
export function leafOf(s: StoredSensor, states: Record<string, HaState>): number {
  if (s.leafEntity && !s.leafUnused) {
    const live = numberOf(states[s.leafEntity]);
    if (live !== null) return live;
  }
  return typeof s.leaf === "number" ? s.leaf : 0;
}

/* One environment sensor's readings. Its health is its temperature and humidity's, the two everything else rests on;
   VPD comes from its own VPD entity where it has one, and otherwise from its temperature, humidity and offset. */
export function readSensor(s: StoredSensor, states: Record<string, HaState>, now: number): SensorReading {
  const st = (k: string) => (s.entities[k] ? states[s.entities[k] as string] : undefined);
  const core = (["temperature", "humidity"] as const).filter((k) => s.entities[k]);
  const healths = core.map((k) => healthOf(st(k), now));
  const health: Health = healths.includes("dead") ? "dead" : healths.includes("stale") ? "stale" : core.length ? "ok" : healthOf(st("light") ?? st("vpd"), now);
  const usable = (k: Metric) => (s.entities[k] && healthOf(st(k), now) === "ok" ? numberOf(st(k)) : null);
  const t = usable("temperature"), h = usable("humidity");
  const vpd = s.entities.vpd ? usable("vpd") : t !== null && h !== null ? calcVpd(t, h, leafOf(s, states)) : null;
  const ats = ["temperature", "humidity", "vpd", "light"].map((k) => st(k)?.at).filter((x): x is string => !!x).sort();
  return {
    id: s.id,
    name: s.name,
    counted: s.avg,
    health,
    values: { temperature: t, humidity: h, vpd, light: usable("light") },
    at: ats.length ? ats[ats.length - 1] : null,
  };
}

export function combine(method: Method, xs: number[]): number | null {
  if (!xs.length) return null;
  if (method === "highest") return Math.max(...xs);
  if (method === "lowest") return Math.min(...xs);
  if (method === "median") {
    const s = [...xs].sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface ZoneReading {
  value: number | null;
  method: Method;
  used: SensorReading[];
  /* Counted sensors with no usable reading for this metric, named rather than averaged in as 0. */
  missing: SensorReading[];
  /* Sensors left out by choice. */
  notCounted: SensorReading[];
}

export function zoneReading(sensors: SensorReading[], k: Metric, method: Method): ZoneReading {
  const has = (s: SensorReading) => s.values[k] !== null && s.values[k] !== undefined;
  const counted = sensors.filter((s) => s.counted);
  const used = counted.filter(has);
  return {
    value: combine(method, used.map((s) => s.values[k] as number)),
    method,
    used,
    missing: counted.filter((s) => !has(s)),
    notCounted: sensors.filter((s) => !s.counted && has(s)),
  };
}

export const fmt = (k: Metric, v: number | null | undefined) =>
  v === null || v === undefined ? "--" : k === "light" ? Math.round(v).toLocaleString() : v.toFixed(METRIC[k].dp);

/* How long ago, in words a glance takes in. */
export function ago(at: string | null, now: number): string {
  if (!at) return "never reported";
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return `reported ${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `reported ${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `reported ${h} hour${h === 1 ? "" : "s"} ago` : `reported ${Math.round(h / 24)} days ago`;
}

/* Wrap-safe: a photoperiod can cross midnight, as the veg's 16:00 to 10:00 does. Minutes from midnight. */
export function isDay(dayAt: number, nightAt: number, minute: number): boolean {
  const t = ((minute % 1440) + 1440) % 1440;
  return dayAt < nightAt ? t >= dayAt && t < nightAt : t >= dayAt || t < nightAt;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/* A zone's sensors as stored, read field by field. */
export function sensorsOf(z: Record<string, unknown> | undefined): StoredSensor[] {
  return (Array.isArray(z?.sensors) ? z.sensors.filter(isObj) : [])
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      name: typeof s.name === "string" ? s.name : (s.id as string),
      kind: s.kind === "soil" ? ("soil" as const) : ("env" as const),
      entities: isObj(s.entities) ? (Object.fromEntries(Object.entries(s.entities).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {},
      ...(typeof s.leafEntity === "string" ? { leafEntity: s.leafEntity } : {}),
      ...(s.leafUnused === true ? { leafUnused: true } : {}),
      ...(typeof s.leaf === "number" ? { leaf: s.leaf } : {}),
      avg: s.avg !== false,
    }));
}

/* A zone's limits for one period and metric: Min, Low, Target, High, Max, as stored. */
export function bandsOf(z: Record<string, unknown> | undefined, period: "day" | "night", k: Metric): (number | null)[] | null {
  const b = isObj(z?.bands) && isObj(z.bands[period]) ? (z.bands[period] as Record<string, unknown>)[k] : null;
  return Array.isArray(b) && b.length === 5 && b.every((x) => x === null || typeof x === "number") ? (b as (number | null)[]) : null;
}

export type BandState = "ok" | "low" | "high" | "critlow" | "crithigh" | "dead" | "unset";
export const BAND_WORDS: Record<BandState, string> = { ok: "Ideal", low: "Low", high: "High", critlow: "Critical", crithigh: "Critical", dead: "No data", unset: "No targets yet" };

/* Green between Low and High, grey to Min and Max where devices ramp up, red beyond. Only judged once Targets is
   confirmed: a new zone's limits are all 0, and judging against them would only cry critical. */
export function bandState(band: (number | null)[] | null, v: number | null, judged: boolean): BandState {
  if (!judged || !band) return "unset";
  if (v === null) return "dead";
  const [mn, lo, , hi, mx] = band.map((x) => x ?? 0);
  return v < mn ? "critlow" : v > mx ? "crithigh" : v < lo ? "low" : v > hi ? "high" : "ok";
}
