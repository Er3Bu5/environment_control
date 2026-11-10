/* Map devices: which of Home Assistant's devices are a zone's sensors, and which of its entities the zone runs.

   Candidates come from the backend's catalog. A sensor is one physical device, and its readings are matched to slots by
   HA's own device class and unit, never by name. Where a device has two candidates for a slot, Setup asks; where it has
   none, the slot is not used. Nothing here is saved: it builds a draft, lists what the draft would change, and applies
   it to a copy of the stored setup that the host then saves, asking you first about anything newly controllable. */
import type { Catalog, CatalogDevice, CatalogEntity, LinkKind, PathKind } from "./messages";
import type { RawConfig } from "./model";

export const SLOTS = ["temperature", "humidity", "vpd", "light", "leaf"] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_NAME: Record<Slot, string> = { temperature: "Temperature", humidity: "Humidity", vpd: "VPD", light: "Light", leaf: "Leaf temperature offset" };
const REQUIRED: readonly Slot[] = ["temperature", "humidity"];

export const ROLES = ["Dehumidifier", "Humidifier", "Air conditioner", "Heater", "Fan", "Light", "Other"] as const;
export type Role = (typeof ROLES)[number];
const CONTROL_DOMAINS = ["switch", "light", "fan", "humidifier"];

export const METHODS = { mean: "Average", median: "Median", highest: "Highest", lowest: "Lowest" } as const;
export type Method = keyof typeof METHODS;

export interface Option {
  entity: string;
  reading: string;
}
export interface SensorCandidate {
  id: string;
  name: string;
  area: string | null;
  family: string;
  link: LinkKind;
  path: PathKind;
  slots: Record<Slot, Option[]>;
}
export interface ControlCandidate {
  entity: string;
  name: string;
  area: string | null;
  family: string;
  link: LinkKind;
  path: PathKind;
  hub: string | null;
  detected: Role | "";
}

const CELSIUS = ["°C", "℃"];
const reading = (e: CatalogEntity) => (e.state === null ? "no reading" : e.unit ? `${e.state} ${e.unit}` : e.state);

/* Which slot an entity can fill, from HA's device class and unit. */
function slotOf(e: CatalogEntity): Slot | null {
  if (e.domain === "number") return e.unit && CELSIUS.includes(e.unit) ? "leaf" : null;
  if (e.domain !== "sensor") return null;
  if (e.device_class === "temperature") return "temperature";
  if (e.device_class === "humidity") return "humidity";
  if (e.device_class === "illuminance") return "light";
  if (e.unit === "kPa") return "vpd";
  return null;
}

/* A device's own diagnostics, like a board's chip temperature, are offered only when it has nothing else for that slot,
   so a board with one real reading isn't asked to choose between it and its own chip. */
function slotsOf(d: CatalogDevice): Record<Slot, Option[]> {
  const out = Object.fromEntries(SLOTS.map((s) => [s, [] as CatalogEntity[]])) as Record<Slot, CatalogEntity[]>;
  for (const e of d.entities) {
    const slot = slotOf(e);
    if (slot) out[slot].push(e);
  }
  return Object.fromEntries(
    SLOTS.map((s) => {
      const primary = out[s].filter((e) => e.category !== "diagnostic" || s === "leaf");
      return [s, (primary.length ? primary : out[s]).map((e) => ({ entity: e.entity_id, reading: reading(e) }))];
    }),
  ) as Record<Slot, Option[]>;
}

export function sensorCandidates(c: Catalog): SensorCandidate[] {
  return c.devices
    .map((d) => ({ id: d.id, name: d.name, area: d.area, family: d.family, link: d.link, path: d.path, slots: slotsOf(d) }))
    .filter((s) => s.slots.temperature.length || s.slots.humidity.length);
}

function detectedRole(e: CatalogEntity): Role | "" {
  if (e.domain === "light") return "Light";
  if (e.domain === "fan") return "Fan";
  if (e.domain === "humidifier") return e.device_class === "humidifier" ? "Humidifier" : e.device_class === "dehumidifier" ? "Dehumidifier" : "";
  /* A plug says nothing about what is plugged into it. */
  return "";
}

export function controlCandidates(c: Catalog): ControlCandidate[] {
  const out: ControlCandidate[] = [];
  for (const d of c.devices)
    for (const e of d.entities)
      if (CONTROL_DOMAINS.includes(e.domain))
        out.push({ entity: e.entity_id, name: e.name, area: e.area ?? d.area, family: d.family, link: d.link, path: d.path, hub: d.hub, detected: detectedRole(e) });
  for (const e of c.entities)
    if (CONTROL_DOMAINS.includes(e.domain))
      out.push({ entity: e.entity_id, name: e.name, area: e.area, family: e.family, link: "derived", path: "derived", hub: null, detected: detectedRole(e) });
  return out;
}

/* The draft. A slot holds an entity, "none" for not used, or "" while it waits for an answer. */
export interface MapDraft {
  zoneId: string;
  step: 1 | 2 | 3;
  q: string;
  sensors: Record<string, Record<Slot, string>>;
  avg: Record<string, boolean>;
  combine: Method;
  controls: Record<string, Role | "">;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/* A new pick takes the only candidate for each slot, leaves a slot with none unused, and waits on one with several. */
export function seedSlots(s: SensorCandidate): Record<Slot, string> {
  return Object.fromEntries(SLOTS.map((k) => [k, s.slots[k].length === 1 ? s.slots[k][0].entity : s.slots[k].length ? "" : "none"])) as Record<Slot, string>;
}

export function openMap(c: RawConfig, zoneId: string): MapDraft {
  const z = c.zones.find((x) => x.id === zoneId);
  const draft: MapDraft = { zoneId, step: 1, q: "", sensors: {}, avg: {}, combine: "mean", controls: {} };
  if (!z) return draft;
  for (const s of Array.isArray(z.sensors) ? z.sensors.filter(isObj) : []) {
    const id = str(s.id), ents = isObj(s.entities) ? s.entities : {};
    if (!id) continue;
    draft.sensors[id] = Object.fromEntries(
      SLOTS.map((k) => [k, k === "leaf" ? (s.leafUnused || !s.leafEntity ? "none" : str(s.leafEntity)) : str(ents[k]) || "none"]),
    ) as Record<Slot, string>;
    if (s.avg === false) draft.avg[id] = false;
  }
  if (isObj(z.combine) && str(z.combine.env) in METHODS) draft.combine = z.combine.env as Method;
  for (const d of c.devices) if (Array.isArray(d.zones) && d.zones.includes(zoneId) && str(d.entity)) draft.controls[str(d.entity)] = (ROLES as readonly string[]).includes(str(d.type)) ? (d.type as Role) : "";
  return draft;
}

export interface Issue {
  text: string;
  step: 1 | 2;
  target: string;
}

export const sensorTarget = (id: string) => `ms-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
export const controlTarget = (entity: string) => `md-${entity.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function mapIssues(d: MapDraft, sensors: SensorCandidate[], controls: ControlCandidate[] = []): Issue[] {
  const out: Issue[] = [];
  const picked = Object.keys(d.sensors);
  for (const id of picked) {
    const s = sensors.find((x) => x.id === id), slots = d.sensors[id], name = s?.name ?? "A sensor";
    for (const k of SLOTS) if (slots[k] === "") out.push({ text: `${name}: pick which ${SLOT_NAME[k]} entity to use.`, step: 1, target: sensorTarget(id) });
    const missing = REQUIRED.filter((k) => slots[k] === "none");
    if (missing.length)
      out.push({ text: `${name}: an environment sensor needs ${missing.map((k) => SLOT_NAME[k].toLowerCase()).join(" and ")}. Pick ${missing.length > 1 ? "them" : "it"}, or leave this sensor out.`, step: 1, target: sensorTarget(id) });
  }
  if (!picked.length) out.push({ text: "Add at least one environment sensor, so this zone has readings to show.", step: 1, target: "map-q" });
  for (const [entity, role] of Object.entries(d.controls))
    if (!role) out.push({ text: `${controls.find((x) => x.entity === entity)?.name ?? entity}: say what it is.`, step: 2, target: controlTarget(entity) });
  return out;
}

export const countedSensors = (d: MapDraft) => Object.keys(d.sensors).filter((id) => d.avg[id] !== false).length;

export interface Change {
  label: string;
  before: string;
  after: string;
}

export function mapChanges(d: MapDraft, c: RawConfig, sensors: SensorCandidate[], controls: ControlCandidate[]): Change[] {
  const was = openMap(c, d.zoneId), out: Change[] = [];
  const add = (label: string, before: string, after: string) => before !== after && out.push({ label, before, after });
  const sensorName = (id: string) => sensors.find((s) => s.id === id)?.name ?? storedName(c, d.zoneId, id) ?? id;
  for (const id of new Set([...Object.keys(was.sensors), ...Object.keys(d.sensors)])) {
    const had = was.sensors[id], has = d.sensors[id], name = sensorName(id);
    add(name, had ? "Mapped" : "Not mapped", has ? "Mapped" : "Not mapped");
    if (!had || !has) continue;
    for (const k of SLOTS) add(`${name} ${SLOT_NAME[k].toLowerCase()}`, slotWords(k, had[k]), slotWords(k, has[k]));
    add(`${name} average`, was.avg[id] === false ? "Excluded" : "Included", d.avg[id] === false ? "Excluded" : "Included");
  }
  if (countedSensors(d) >= 2 || countedSensors(was) >= 2) add("Environment sensors combine by", METHODS[was.combine], METHODS[d.combine]);
  const controlName = (e: string) => controls.find((x) => x.entity === e)?.name ?? e;
  for (const e of new Set([...Object.keys(was.controls), ...Object.keys(d.controls)])) {
    const had = e in was.controls, has = e in d.controls;
    add(controlName(e), had ? "In this zone" : "Not in this zone", has ? "In this zone" : "Not in this zone");
    if (has) add(`${controlName(e)} is a`, had ? was.controls[e] || "Not set" : "Not set", d.controls[e] || "Not set");
  }
  return out;
}

const slotWords = (k: Slot, v: string) => (v === "none" ? (k === "leaf" ? "Kept in Environment Control" : "Not used") : v || "Not picked");

function storedName(c: RawConfig, zoneId: string, id: string): string | undefined {
  const z = c.zones.find((x) => x.id === zoneId), s = Array.isArray(z?.sensors) ? z.sensors.filter(isObj).find((x) => x.id === id) : undefined;
  return s && typeof s.name === "string" ? s.name : undefined;
}

/* A short id for a device entry, the same for the same entity, made only of the characters the host accepts. */
export function deviceId(entity: string): string {
  let h = 0x811c9dc5;
  for (const ch of entity) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `d-${h.toString(16).padStart(8, "0")}`;
}

export function applyMap(c: RawConfig, d: MapDraft, sensors: SensorCandidate[], controls: ControlCandidate[]): void {
  const z = c.zones.find((x) => x.id === d.zoneId);
  if (!z) return;
  const before = Array.isArray(z.sensors) ? z.sensors.filter(isObj) : [];
  z.sensors = Object.entries(d.sensors).map(([id, slots]) => {
    const had = before.find((x) => x.id === id), cand = sensors.find((x) => x.id === id);
    const entry: Record<string, unknown> = had ? { ...had } : { id, name: cand?.name ?? id, kind: "env", pos: null };
    if (cand) Object.assign(entry, { name: cand.name, family: cand.family, link: had?.linkSource === "confirmed" ? had.link : cand.link, linkSource: had?.linkSource === "confirmed" ? "confirmed" : "detected" });
    entry.entities = Object.fromEntries((["temperature", "humidity", "vpd", "light"] as const).filter((k) => slots[k] && slots[k] !== "none").map((k) => [k, slots[k]]));
    if (slots.leaf && slots.leaf !== "none") {
      entry.leafEntity = slots.leaf;
      entry.leafUnused = false;
    } else {
      /* Kept here from now on. One that was on the board starts from what the board last said; a new one starts at 0. */
      const board = had && !had.leafUnused && typeof had.leafEntity === "string" ? cand?.slots.leaf.find((o) => o.entity === had.leafEntity) : undefined;
      const fromBoard = board ? Number.parseFloat(board.reading) : NaN;
      if (typeof had?.leaf !== "number" || board) entry.leaf = Number.isFinite(fromBoard) ? fromBoard : 0;
      delete entry.leafEntity;
      entry.leafUnused = true;
    }
    entry.avg = d.avg[id] !== false;
    return entry;
  });
  z.combine = { env: d.combine };

  const picked = new Set(Object.keys(d.controls));
  for (const dev of c.devices) {
    const zones = Array.isArray(dev.zones) ? dev.zones : [];
    if (zones.includes(d.zoneId) && !picked.has(str(dev.entity))) {
      dev.zones = zones.filter((x) => x !== d.zoneId);
      if (isObj(dev.place)) {
        delete dev.place[d.zoneId];
        if (!Object.keys(dev.place).length) delete dev.place;
      }
    }
  }
  for (const entity of picked) {
    const cand = controls.find((x) => x.entity === entity);
    let dev = c.devices.find((x) => x.entity === entity);
    if (!dev) {
      dev = { id: deviceId(entity), entity, zones: [] };
      c.devices.push(dev);
    }
    const zones = Array.isArray(dev.zones) ? dev.zones : [];
    if (!zones.includes(d.zoneId)) dev.zones = [...zones, d.zoneId];
    dev.type = d.controls[entity];
    const confirmed = dev.linkSource === "confirmed";
    if (cand) Object.assign(dev, { name: cand.name, family: cand.family, link: confirmed ? dev.link : cand.link, linkSource: confirmed ? "confirmed" : "detected", path: cand.path, hub: cand.hub });
  }
  /* A device in no zone isn't mapped, so its entry goes. */
  c.devices = c.devices.filter((x) => !Array.isArray(x.zones) || x.zones.length);
}
