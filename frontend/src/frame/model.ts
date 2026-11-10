/* The stored setup as the frame uses it. The backend checks every save, but the frame still reads what it is given
   field by field: a zone it can't make sense of is left out of the screens rather than breaking them. */

export const SETUP_STEPS = ["details", "devices", "layout", "place", "calibrate", "targets"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type StepState = "done" | "todo" | "later";

export interface Layout {
  w: number;
  d: number;
  units: number;
  rows: number;
  cols: number;
}
export interface Zone {
  id: string;
  name: string;
  description: string | null;
  layout: Layout | null;
  sensors: { id: string; placed: boolean }[];
  setup: Partial<Record<SetupStep, StepState>>;
}
export interface Device {
  id: string;
  name: string;
  zones: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readLayout(v: unknown): Layout | null {
  if (!isObj(v) || ![v.w, v.d, v.units, v.rows, v.cols].every(num)) return null;
  return { w: v.w as number, d: v.d as number, units: v.units as number, rows: v.rows as number, cols: v.cols as number };
}

export function readZones(list: unknown[]): Zone[] {
  const out: Zone[] = [];
  for (const z of list) {
    if (!isObj(z) || typeof z.id !== "string" || typeof z.name !== "string") continue;
    const setup: Zone["setup"] = {};
    if (isObj(z.setup)) for (const k of SETUP_STEPS) if (["done", "todo", "later"].includes(z.setup[k] as string)) setup[k] = z.setup[k] as StepState;
    const sensors = Array.isArray(z.sensors)
      ? z.sensors.filter(isObj).filter((s) => typeof s.id === "string").map((s) => ({ id: s.id as string, placed: Array.isArray(s.pos) }))
      : [];
    out.push({ id: z.id, name: z.name, description: typeof z.description === "string" ? z.description : null, layout: readLayout(z.layout), sensors, setup });
  }
  return out;
}

export function readDevices(list: unknown[]): Device[] {
  return list
    .filter(isObj)
    .filter((d) => typeof d.id === "string" && typeof d.name === "string" && Array.isArray(d.zones))
    .map((d) => ({ id: d.id as string, name: d.name as string, zones: (d.zones as unknown[]).filter((z): z is string => typeof z === "string") }));
}

/* A zone made before setup steps were recorded counts as set up, so only steps marked to do or later are left. */
export const stepsLeft = (z: Zone): SetupStep[] => SETUP_STEPS.filter((k) => z.setup[k] === "todo" || z.setup[k] === "later");

/* Editing. Every change works on a copy of what is stored, and the copy is only kept once the backend has saved it, so
   fields this frame doesn't know about yet pass through untouched. */
export type RawConfig = { zones: Record<string, unknown>[]; devices: Record<string, unknown>[] };

export const copyConfig = (zones: unknown[], devices: unknown[]): RawConfig => structuredClone({
  zones: zones.filter(isObj),
  devices: devices.filter(isObj),
});

export const STEP_TITLE: Record<SetupStep, string> = {
  details: "Zone details",
  devices: "Map devices",
  layout: "Zone layout",
  place: "Placement",
  calibrate: "Sensor Calibration",
  targets: "Targets, day and night",
};
export const STEP_TEXT: Record<SetupStep, string> = {
  details: "Its name, and a description if you want one.",
  devices: "Pick its sensors and devices from Home Assistant.",
  layout: "Its size, and how many units it holds in what grid.",
  place: "Put its sensors on the map at their height, and any devices you want to see there.",
  calibrate: "Each sensor's leaf temperature offset.",
  targets: "When it's day, and the limits its readings are judged against. Readings aren't judged until this is confirmed.",
};

export const MAX_ZONE_NAME = 40;
export const MAX_DESCRIPTION = 200;

export function zoneNameIssue(name: string, zones: Zone[], self: string | null): string {
  const n = name.trim();
  if (!n) return "Name this zone to continue";
  return zones.some((z) => z.id !== self && z.name.toLowerCase() === n.toLowerCase()) ? `There's already a zone called ${n}` : "";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);

/* A new zone starts at 0 everywhere rather than on anyone's guess, so nothing about it looks set up until each step has
   been confirmed. It keeps a 1.2 x 1.2 m, 4 unit layout until Zone layout sets one, because a map of no size can't be drawn. */
export function addZone(c: RawConfig, name: string, description: string): string {
  const base = slug(name) || "zone";
  const taken = new Set(c.zones.map((z) => z.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  const zero = () => Object.fromEntries(["temperature", "humidity", "vpd"].map((k) => [k, [0, 0, 0, 0, 0]]));
  const zone: Record<string, unknown> = {
    id,
    name: name.trim(),
    dayAt: 0,
    nightAt: 0,
    periodMode: "fixed",
    bands: { day: zero(), night: zero() },
    linked: false,
    lightLimits: { dayMin: 0, nightMax: 0 },
    layout: { w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 },
    sensors: [],
    setup: Object.fromEntries(SETUP_STEPS.map((k) => [k, k === "details" ? "done" : "todo"])),
  };
  if (description.trim()) zone.description = description.trim();
  c.zones.push(zone);
  return id;
}

export function setDetails(c: RawConfig, id: string, name: string, description: string): void {
  const z = c.zones.find((x) => x.id === id);
  if (!z) return;
  z.name = name.trim();
  if (description.trim()) z.description = description.trim();
  else delete z.description;
}

export function markStep(c: RawConfig, id: string, step: SetupStep, state: StepState): void {
  const z = c.zones.find((x) => x.id === id);
  if (!z) return;
  z.setup = { ...(isObj(z.setup) ? z.setup : {}), [step]: state };
}

/* Only Environment Control's own record goes. Sensors and devices are still in Home Assistant, so they can be mapped to
   another zone, and a device shared with other zones stays in those. */
export function removeZone(c: RawConfig, id: string): void {
  c.zones = c.zones.filter((z) => z.id !== id);
  for (const d of c.devices) {
    if (Array.isArray(d.zones)) d.zones = d.zones.filter((z) => z !== id);
    if (isObj(d.place)) {
      delete d.place[id];
      if (!Object.keys(d.place).length) delete d.place;
    }
  }
}

/* HA can't tell how some devices are connected, ESPHome boards above all, so Setup asks and keeps the answer, marked as
   confirmed so a later look at the catalog doesn't overwrite it. A sensor in several zones takes the answer in each. */
export function confirmLink(c: RawConfig, id: string, link: "ethernet" | "wifi"): void {
  for (const z of c.zones)
    for (const s of Array.isArray(z.sensors) ? z.sensors.filter(isObj) : [])
      if (s.id === id) Object.assign(s, { link, linkSource: "confirmed" });
  for (const d of c.devices) if (d.id === id) Object.assign(d, { link, linkSource: "confirmed" });
}

/* Sensors and devices in a zone whose link is still unknown: the questions Setup puts to you. */
export function unknownLinks(c: RawConfig): { id: string; name: string; kind: "sensor" | "device" }[] {
  const out: { id: string; name: string; kind: "sensor" | "device" }[] = [];
  for (const z of c.zones)
    for (const s of Array.isArray(z.sensors) ? z.sensors.filter(isObj) : [])
      if (s.link === "unknown" && typeof s.id === "string" && !out.some((x) => x.id === s.id)) out.push({ id: s.id, name: typeof s.name === "string" ? s.name : s.id, kind: "sensor" });
  for (const d of c.devices)
    if (d.link === "unknown" && typeof d.id === "string" && Array.isArray(d.zones) && d.zones.length)
      out.push({ id: d.id, name: typeof d.name === "string" ? d.name : d.id, kind: "device" });
  return out;
}
