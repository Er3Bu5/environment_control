/* Charts: a zone's readings over a range, from the backend's buckets, by the same rules as its tiles. Every sensor gets
   a line, and with two or more the combined line is worked out bucket by bucket with the zone's own method. The last
   point is always now, taken from the live readings, so a chart ends on exactly the value its tile shows. */
import type { Method } from "./mapping";
import type { Bucket, History } from "./messages";
import { type HaState, type Metric, type StoredSensor, calcVpd, combine, isDay, leafOf } from "./readings";

/* The History card's ranges, in hours, with the bucket count each is drawn at: 5 minute steps up to a day, then 15
   and 30 minutes, as the mock has them. The light card's line is the last 4 hours in 5 minute steps. */
export const RANGES: { hours: number; label: string; buckets: number }[] = [
  { hours: 6, label: "6h", buckets: 72 },
  { hours: 24, label: "24h", buckets: 288 },
  { hours: 72, label: "72h", buckets: 288 },
  { hours: 168, label: "7d", buckets: 336 },
];
export const LIGHT_LINE = { hours: 4, buckets: 48 };

/* Sensor line colours, the mock's blue, orange and violet first, stepped and ordered so each neighbour stays apart
   for colour vision deficiency on each palette's card (checked with the dataviz palette validator). Red and green
   are left out: on this panel they mean critical and ideal. A seventh sensor and beyond is drawn grey rather than
   repeating a colour; the table under the chart names every line either way. */
export const LINE_COLORS = {
  light: ["#2A78D6", "#EB6834", "#6250D6", "#1BAF7A", "#EDA100", "#E87BA4"],
  dark: ["#3987E5", "#D95926", "#9085E9", "#199E70", "#C98500", "#D55181"],
} as const;
export const lineColor = (mode: "light" | "dark", i: number) => LINE_COLORS[mode][i] ?? "var(--muted)";

export interface Point {
  /* Seconds since the epoch, the middle of its bucket. */
  t: number;
  v: number | null;
  lo: number | null;
  hi: number | null;
}
const gap = (t: number): Point => ({ t, v: null, lo: null, hi: null });

/* What a metric needs from a sensor: its own entity, or, for VPD with none, its temperature and humidity. */
export function entitiesFor(s: StoredSensor, k: Metric): string[] {
  const e = s.entities;
  if (e[k]) return [e[k] as string];
  if (k === "vpd" && e.temperature && e.humidity) return [e.temperature, e.humidity];
  return [];
}

export const bucketCount = (h: History) => Math.round((h.end - h.start) / h.step);

/* One sensor's line. VPD worked out from temperature and humidity uses the sensor's offset as it is now, since the
   offset it had then isn't recorded, and is a line of means with no spread of its own. */
export function sensorLine(s: StoredSensor, k: Metric, h: History, states: Record<string, HaState>): Point[] | null {
  const n = bucketCount(h), at = (i: number) => h.start + (i + 0.5) * h.step;
  const point = (b: Bucket, i: number): Point => (b ? { t: at(i), v: b[0], lo: b[1], hi: b[2] } : gap(at(i)));
  const own = s.entities[k] ? h.series[s.entities[k] as string] : undefined;
  if (own) return own.values.slice(0, n).map(point);
  if (k !== "vpd" || !s.entities.temperature || !s.entities.humidity) return null;
  const T = h.series[s.entities.temperature], H = h.series[s.entities.humidity];
  if (!T || !H) return null;
  const leaf = leafOf(s, states);
  return T.values.slice(0, n).map((bt, i) => {
    const bh = H.values[i];
    if (!bt || !bh) return gap(at(i));
    const v = calcVpd(bt[0], bh[0], leaf);
    return { t: at(i), v, lo: v, hi: v };
  });
}

/* The last point is now: the live reading, or a gap when the sensor is dead or stale, exactly as its tile has it. */
export function endingNow(line: Point[], live: number | null | undefined): Point[] {
  if (!line.length) return line;
  const v = live ?? null;
  return [...line.slice(0, -1), { t: line[line.length - 1].t, v, lo: v, hi: v }];
}

/* The combined line, bucket by bucket over the counted sensors that have a reading there, by the zone's method. */
export function combinedLine(lines: Point[][], counted: boolean[], method: Method): Point[] {
  const used = lines.filter((_, i) => counted[i]);
  if (!used.length) return [];
  return used[0].map((p, i) => {
    const live = used.map((l) => l[i]).filter((x): x is Point & { v: number; lo: number; hi: number } => !!x && x.v !== null);
    if (!live.length) return gap(p.t);
    return { t: p.t, v: combine(method, live.map((x) => x.v)), lo: combine(method, live.map((x) => x.lo)), hi: combine(method, live.map((x) => x.hi)) };
  });
}

/* A range's Min and Max, from each bucket's own low and high so a spike still counts on a long range. */
export function extremes(line: Point[]): { min: { v: number; t: number } | null; max: { v: number; t: number } | null } {
  let min: { v: number; t: number } | null = null, max: { v: number; t: number } | null = null;
  for (const p of line) {
    if (p.v === null || p.lo === null || p.hi === null) continue;
    if (!min || p.lo < min.v) min = { v: p.lo, t: p.t };
    if (!max || p.hi > max.v) max = { v: p.hi, t: p.t };
  }
  return { min, max };
}

/* The y range to draw: every reading and, when the zone's limits are judged, its Min and Max, padded a little.
   Light never goes below 0. */
export function yRange(lines: Point[][], k: Metric, limits: number[]): [number, number] {
  const vals = [...lines.flat().flatMap((p) => (p.v === null ? [] : [p.v])), ...limits];
  if (!vals.length) return [0, 1];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, k === "vpd" ? 0.05 : 1);
  return [k === "light" ? Math.max(0, lo - pad) : lo - pad, hi + pad];
}

/* Runs of buckets in one period, day or night, as [first, last] index pairs: limits change with the period, and the
   night runs are shaded. Times are minutes from midnight, local, wrap-safe like every day test here. */
export function periodRuns(points: Point[], dayAt: number, nightAt: number): { from: number; to: number; day: boolean }[] {
  const out: { from: number; to: number; day: boolean }[] = [];
  points.forEach((p, i) => {
    const d = new Date(p.t * 1000), day = isDay(dayAt, nightAt, d.getHours() * 60 + d.getMinutes());
    const last = out[out.length - 1];
    if (last && last.day === day) last.to = i;
    else out.push({ from: i, to: i, day });
  });
  return out;
}
export const nightRuns = (points: Point[], dayAt: number, nightAt: number): [number, number][] =>
  periodRuns(points, dayAt, nightAt).filter((r) => !r.day).map((r) => [r.from, r.to]);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/* A time in words a glance takes in: the clock within a day, the weekday and clock beyond. */
export function whenWords(t: number, hours: number): string {
  const d = new Date(t * 1000);
  return hours <= 24 ? hhmm(d) : `${DOW[d.getDay()]} ${hhmm(d)}`;
}
export function tickWords(t: number, hours: number): string {
  const d = new Date(t * 1000);
  return hours <= 24 ? hhmm(d) : `${d.getDate()} ${MON[d.getMonth()]}`;
}

/* Said when Home Assistant keeps less than the range asked for, so a short line isn't mistaken for a quiet one. */
export function keptNote(h: History, hours: number): string {
  const firsts = Object.values(h.series).map((s) => s.first).filter((x): x is number => x !== null);
  if (!firsts.length) return "Home Assistant has no recorded readings for this range.";
  const first = Math.min(...firsts);
  if (first <= h.start + h.step) return "";
  const held = (h.end - first) / 3600, d = new Date(first * 1000);
  const span = held >= 48 ? `${Math.floor(held / 24)} days` : held >= 1 ? `${Math.floor(held)} hours` : "under an hour";
  return `Home Assistant has kept ${span} of these readings, back to ${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${hhmm(d)}, of the ${hours} hours asked for.`;
}
