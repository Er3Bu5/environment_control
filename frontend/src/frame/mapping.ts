/* Device identification: which of Home Assistant's devices are a zone's sensors, and which of its entities the zone runs.

   Candidates come from the backend's catalog. A sensor is one physical device, and its readings are matched to slots by
   HA's own device class and unit, never by name. Where a device has two candidates for a slot, Setup asks; where it has
   none, the slot is not used. Nothing here is saved: it builds a draft, lists what the draft would change, and applies
   it to a copy of the stored setup that the host then saves, asking you first about anything newly controllable. */
import { MAX_VIRTUAL, VIRTUAL_TYPES, type VirtualType } from "./layout";
import type { Catalog, CatalogDevice, CatalogEntity, LinkKind, PathKind } from "./messages";
import type { RawConfig } from "./model";

/* A sensor has a class, as the design mock has it, and its class decides the readings it is asked for: an environment
   board gives temperature, humidity, VPD and light, a soil probe moisture, EC and temperature. Calibration values, a
   board's leaf temperature offset and a probe's full saturation and field capacity, are Sensor Calibration's, not
   mapping's: a mapping leaves whatever is stored about them alone. */
export const CLASSES = { env: "Environment", soil: "Soil" } as const;
export type SensorClass = keyof typeof CLASSES;
export const SLOTS = ["temperature", "humidity", "vpd", "light", "moisture", "ec"] as const;
export type Slot = (typeof SLOTS)[number];
export const CLASS_SLOTS: Record<SensorClass, readonly Slot[]> = { env: ["temperature", "humidity", "vpd", "light"], soil: ["moisture", "ec", "temperature"] };
/* A soil probe's EC is its pore water EC, pwEC as Athena's handbook calls it: the EC of the water within the substrate's
   pores. HA gives it no device class of its own, so every conductivity sensor on the probe is offered for it. */
export const SLOT_NAME: Record<Slot, string> = { temperature: "Temperature", humidity: "Humidity", vpd: "VPD", light: "Light", moisture: "Moisture (VWC)", ec: "pwEC" };
const EC_UNITS = ["mS/cm", "µS/cm", "μS/cm", "uS/cm", "dS/m"];

export const ROLES = ["Dehumidifier", "Humidifier", "Air conditioner", "Heater", "Fan", "Light", "Other"] as const;
export type Role = (typeof ROLES)[number];
const CONTROL_DOMAINS = ["switch", "light", "fan", "humidifier"];

export const METHODS = { mean: "Average", median: "Median", highest: "Highest", lowest: "Lowest" } as const;
export type Method = keyof typeof METHODS;

export interface Option {
  entity: string;
  name: string;
  reading: string;
}
export interface SensorCandidate {
  id: string;
  name: string;
  area: string | null;
  family: string;
  link: LinkKind;
  path: PathKind;
  /* The class its readings suggest: soil when it measures moisture or conductivity. */
  detected: SensorClass;
  /* What HA's device classes suggest for each reading. */
  slots: Record<Slot, Option[]>;
  /* Every sensor on the device, so any of them can be put to any reading. */
  all: Option[];
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

/* A reading as a person would say it: rounded to what the size of the number deserves. */
function reading(e: CatalogEntity): string {
  if (e.state === null || e.state === "unknown" || e.state === "unavailable") return e.state ?? "no reading";
  const x = Number(e.state);
  const value = Number.isFinite(x) && e.state.trim() !== ""
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2 }).format(x)
    : e.state;
  return e.unit ? `${value} ${e.unit}` : value;
}
const option = (e: CatalogEntity): Option => ({ entity: e.entity_id, name: e.name, reading: reading(e) });

/* Which reading HA's device class and unit suggest an entity for. A suggestion only: any sensor can be picked for any. */
function slotOf(e: CatalogEntity): Slot | null {
  if (e.domain !== "sensor") return null;
  if (e.device_class === "temperature") return "temperature";
  if (e.device_class === "humidity") return "humidity";
  if (e.device_class === "illuminance") return "light";
  if (e.device_class === "moisture") return "moisture";
  if (e.device_class === "conductivity" || (e.unit && EC_UNITS.includes(e.unit))) return "ec";
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
      const primary = out[s].filter((e) => e.category !== "diagnostic");
      return [s, (primary.length ? primary : out[s]).map(option)];
    }),
  ) as Record<Slot, Option[]>;
}

/* A device counts as a sensor when HA suggests it for any reading. Its own diagnostics come last in its full list. */
export function sensorCandidates(c: Catalog): SensorCandidate[] {
  return c.devices
    .map((d) => {
      const sensors = d.entities.filter((e) => e.domain === "sensor");
      const all = [...sensors.filter((e) => e.category !== "diagnostic"), ...sensors.filter((e) => e.category === "diagnostic")].map(option);
      const slots = slotsOf(d), detected: SensorClass = slots.moisture.length || slots.ec.length ? "soil" : "env";
      return { id: d.id, name: d.name, area: d.area, family: d.family, link: d.link, path: d.path, detected, slots, all };
    })
    .filter((s) => SLOTS.some((k) => s.slots[k].length));
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

/* The draft. A slot holds an entity, "none" for not used, or "" while it waits for an answer between several. */
export interface MapDraft {
  zoneId: string;
  step: 1 | 2 | 3;
  q: string;
  sensors: Record<string, Record<Slot, string>>;
  cls: Record<string, SensorClass>;
  avg: Record<string, boolean>;
  combine: Record<SensorClass, Method>;
  controls: Record<string, Role | "">;
  /* A name given here in place of Home Assistant's, by sensor id or by a device's entity. One with no entry goes by
     HA's name and follows it when that changes. */
  names: Record<string, string>;
  /* Virtual devices: things worth seeing on the map that Home Assistant doesn't have. fresh marks one added in this
     draft, whose id is made from its name once it's applied. */
  virt: { id: string; name: string; type: VirtualType; fresh?: boolean }[];
  /* A device moved to another of Home Assistant's entities: the new entity, and the one it took over from. The device
     keeps its name, its type and its place on the map. */
  swap: Record<string, string>;
  /* A mode a humidifier or dehumidifier has that Home Assistant doesn't list, by its entity. */
  extra: Record<string, string>;
}
export const MAX_MODE_NAME = 40;

export const MAX_NAME = 100;
export const MAX_VIRTUAL_NAME = 40;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/* A new pick takes the only suggestion for each of its class's readings, leaves one with none unused, and waits on one
   with several. Readings outside its class are not used. A reading picked before, under either class, is kept. */
export function seedSlots(s: SensorCandidate, cls: SensorClass = s.detected, kept: Partial<Record<Slot, string>> = {}): Record<Slot, string> {
  return Object.fromEntries(
    SLOTS.map((k) => {
      if (!CLASS_SLOTS[cls].includes(k)) return [k, "none"];
      if (kept[k] && kept[k] !== "none") return [k, kept[k]];
      return [k, s.slots[k].length === 1 ? s.slots[k][0].entity : s.slots[k].length ? "" : "none"];
    }),
  ) as Record<Slot, string>;
}
export const classSlots = (d: MapDraft, id: string): readonly Slot[] => CLASS_SLOTS[d.cls[id] ?? "env"];

export function openMap(c: RawConfig, zoneId: string): MapDraft {
  const z = c.zones.find((x) => x.id === zoneId);
  const draft: MapDraft = { zoneId, step: 1, q: "", sensors: {}, cls: {}, avg: {}, combine: { env: "mean", soil: "mean" }, controls: {}, names: {}, virt: [], swap: {}, extra: {} };
  if (!z) return draft;
  const named = (x: Record<string, unknown>, key: string) => {
    if (x.nameSource === "confirmed" && str(x.name)) draft.names[key] = str(x.name);
  };
  for (const s of Array.isArray(z.sensors) ? z.sensors.filter(isObj) : []) {
    const id = str(s.id), ents = isObj(s.entities) ? s.entities : {};
    if (!id) continue;
    const cls: SensorClass = s.kind === "soil" ? "soil" : "env";
    draft.cls[id] = cls;
    draft.sensors[id] = Object.fromEntries(SLOTS.map((k) => [k, CLASS_SLOTS[cls].includes(k) ? str(ents[k]) || "none" : "none"])) as Record<Slot, string>;
    if (s.avg === false) draft.avg[id] = false;
    named(s, id);
  }
  for (const v of Array.isArray(z.virtual) ? z.virtual.filter(isObj) : [])
    if (str(v.id) && str(v.name)) draft.virt.push({ id: str(v.id), name: str(v.name), type: (VIRTUAL_TYPES as readonly string[]).includes(str(v.type)) ? (v.type as VirtualType) : "Other" });
  if (isObj(z.combine)) for (const k of Object.keys(CLASSES) as SensorClass[]) if (str(z.combine[k]) in METHODS) draft.combine[k] = z.combine[k] as Method;
  for (const d of c.devices)
    if (Array.isArray(d.zones) && d.zones.includes(zoneId) && str(d.entity)) {
      draft.controls[str(d.entity)] = (ROLES as readonly string[]).includes(str(d.type)) ? (d.type as Role) : "";
      named(d, str(d.entity));
      if (str(d.nudgeMode).trim()) draft.extra[str(d.entity)] = str(d.nudgeMode).trim();
    }
  return draft;
}

/* A name typed for a sensor or device. Typed back to Home Assistant's own name, there's nothing to keep. */
export function nameIt(d: MapDraft, key: string, typed: string, haName: string): void {
  if (typed === haName) delete d.names[key];
  else d.names[key] = typed.slice(0, MAX_NAME);
}
export const shownName = (d: MapDraft, key: string, haName: string) => d.names[key] ?? haName;

const virtualTarget = (id: string) => `mv-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
export { virtualTarget };

export function addVirtual(d: MapDraft): string | null {
  if (d.virt.length >= MAX_VIRTUAL) return null;
  let n = 1;
  while (d.virt.some((v) => v.id === `v-new_${n}`)) n++;
  d.virt.push({ id: `v-new_${n}`, name: "", type: "Other", fresh: true });
  return `v-new_${n}`;
}
export function removeVirtual(d: MapDraft, id: string): void {
  d.virt = d.virt.filter((v) => v.id !== id);
}

/* Moves a device in this zone from one of Home Assistant's entities to another. Its type and any name given here go
   with it; its place on the map follows when it's applied. Moved back to where it started, nothing has changed. */
export function swapControl(d: MapDraft, from: string, to: string): void {
  if (!(from in d.controls) || to in d.controls || from === to) return;
  const origin = d.swap[from] ?? from;
  d.controls[to] = d.controls[from];
  delete d.controls[from];
  delete d.swap[from];
  if (origin !== to) d.swap[to] = origin;
  if (from in d.names) {
    d.names[to] = d.names[from];
    delete d.names[from];
  }
  /* The extra mode is the hardware's, so it goes along only to another humidifier or dehumidifier. */
  if (from in d.extra && takesExtraMode(to)) d.extra[to] = d.extra[from];
  delete d.extra[from];
}
export const takesExtraMode = (entity: string) => entity.startsWith("humidifier.");

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
    const own = classSlots(d, id);
    for (const k of own) if (slots[k] === "") out.push({ text: `${name}: pick which ${SLOT_NAME[k]} entity to use.`, step: 1, target: sensorTarget(id) });
    if (own.every((k) => slots[k] === "none")) out.push({ text: `${name}: pick at least one reading, or leave this sensor out.`, step: 1, target: sensorTarget(id) });
  }
  if (!picked.length) out.push({ text: "Add at least one environment sensor, so this zone has readings to show.", step: 1, target: "map-q" });
  for (const id of picked) if (id in d.names && !d.names[id].trim()) out.push({ text: `${sensors.find((x) => x.id === id)?.name ?? "A sensor"}: give it a name, or put Home Assistant's back.`, step: 1, target: sensorTarget(id) });
  for (const [entity, role] of Object.entries(d.controls)) {
    const name = controls.find((x) => x.entity === entity)?.name ?? entity;
    if (!role) out.push({ text: `${name}: say what it is.`, step: 2, target: controlTarget(entity) });
    if (entity in d.names && !d.names[entity].trim()) out.push({ text: `${name}: give it a name, or put Home Assistant's back.`, step: 2, target: controlTarget(entity) });
  }
  d.virt.forEach((v, i) => {
    const name = v.name.trim();
    if (!name) out.push({ text: "A virtual device needs a name.", step: 2, target: virtualTarget(v.id) });
    else if (d.virt.findIndex((x) => x.name.trim().toLowerCase() === name.toLowerCase()) !== i) out.push({ text: `There's already a virtual device called ${name}.`, step: 2, target: virtualTarget(v.id) });
  });
  return out;
}

export const countedSensors = (d: MapDraft, cls: SensorClass = "env") => Object.keys(d.sensors).filter((id) => (d.cls[id] ?? "env") === cls && d.avg[id] !== false).length;

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
    if (has) add(`${name} name`, was.names[id] ?? name, d.names[id]?.trim() ?? name);
    if (!had || !has) continue;
    add(`${name} class`, CLASSES[was.cls[id] ?? "env"], CLASSES[d.cls[id] ?? "env"]);
    for (const k of new Set([...classSlots(was, id), ...classSlots(d, id)])) add(`${name} ${SLOT_NAME[k].toLowerCase()}`, slotWords(k, had[k]), slotWords(k, has[k]));
    add(`${name} average`, was.avg[id] === false ? "Excluded" : "Included", d.avg[id] === false ? "Excluded" : "Included");
  }
  for (const cls of Object.keys(CLASSES) as SensorClass[])
    if (countedSensors(d, cls) >= 2 || countedSensors(was, cls) >= 2) add(`${CLASSES[cls]} sensors combine by`, METHODS[was.combine[cls]], METHODS[d.combine[cls]]);
  const controlName = (e: string) => controls.find((x) => x.entity === e)?.name ?? e;
  /* A device moved to another entity is one change, not one device leaving and another arriving. */
  const moved = Object.entries(d.swap).filter(([to, from]) => from in was.controls && to in d.controls);
  const skip = new Set(moved.flat());
  for (const [to, from] of moved) {
    const name = was.names[from] ?? controlName(from);
    add(`${name} entity`, from, to);
    add(`${name} is a`, was.controls[from] || "Not set", d.controls[to] || "Not set");
    add(`${name} extra mode`, was.extra[from] ?? "None", d.extra[to]?.trim() || "None");
    add(`${name} name`, was.names[from] ?? controlName(from), d.names[to]?.trim() ?? controlName(to));
  }
  for (const e of new Set([...Object.keys(was.controls), ...Object.keys(d.controls)])) {
    if (skip.has(e)) continue;
    const had = e in was.controls, has = e in d.controls;
    add(controlName(e), had ? "In this zone" : "Not in this zone", has ? "In this zone" : "Not in this zone");
    if (has) add(`${controlName(e)} is a`, had ? was.controls[e] || "Not set" : "Not set", d.controls[e] || "Not set");
    if (has) add(`${controlName(e)} name`, was.names[e] ?? controlName(e), d.names[e]?.trim() ?? controlName(e));
    if (has) add(`${controlName(e)} extra mode`, was.extra[e] ?? "None", d.extra[e]?.trim() || "None");
  }
  for (const v of d.virt) {
    const old = was.virt.find((x) => x.id === v.id), name = v.name.trim() || "Virtual device";
    if (!old) {
      add(`${name}, virtual`, "Not added", `Added, ${v.type}`);
      continue;
    }
    add(`${old.name}, virtual, name`, old.name, name);
    add(`${name}, virtual, type`, old.type, v.type);
  }
  for (const v of was.virt) if (!d.virt.some((x) => x.id === v.id)) add(`${v.name}, virtual`, "On the map", "Removed");
  return out;
}

const slotWords = (_k: Slot, v: string) => (v === "none" ? "Not used" : v || "Not picked");

function storedName(c: RawConfig, zoneId: string, id: string): string | undefined {
  const z = c.zones.find((x) => x.id === zoneId), s = Array.isArray(z?.sensors) ? z.sensors.filter(isObj).find((x) => x.id === id) : undefined;
  return s && typeof s.name === "string" ? s.name : undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);

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
  /* A name given here is kept as confirmed, so Home Assistant's name no longer replaces it. One put back follows HA's. */
  const rename = (entry: Record<string, unknown>, key: string) => {
    const given = d.names[key]?.trim();
    if (given) Object.assign(entry, { name: given.slice(0, MAX_NAME), nameSource: "confirmed" });
    else delete entry.nameSource;
  };
  z.sensors = Object.entries(d.sensors).map(([id, slots]) => {
    const had = before.find((x) => x.id === id), cand = sensors.find((x) => x.id === id);
    const cls = d.cls[id] ?? "env";
    const entry: Record<string, unknown> = had ? { ...had } : { id, name: cand?.name ?? id, kind: cls, pos: null };
    /* Where a sensor may sit depends on its class, so one that changes class is placed again. */
    if (had && (had.kind === "soil" ? "soil" : "env") !== cls) Object.assign(entry, { kind: cls, pos: null });
    if (cand) Object.assign(entry, { name: cand.name, family: cand.family, link: had?.linkSource === "confirmed" ? had.link : cand.link, linkSource: had?.linkSource === "confirmed" ? "confirmed" : "detected" });
    rename(entry, id);
    entry.entities = Object.fromEntries(CLASS_SLOTS[cls].filter((k) => slots[k] && slots[k] !== "none").map((k) => [k, slots[k]]));
    entry.avg = d.avg[id] !== false;
    return entry;
  });
  z.combine = { ...d.combine };

  const stored = Array.isArray(z.virtual) ? z.virtual.filter(isObj) : [];
  const taken = new Set(d.virt.filter((v) => !v.fresh).map((v) => v.id));
  const virtual = d.virt.map((v) => {
    const name = v.name.trim().slice(0, MAX_VIRTUAL_NAME), had = stored.find((x) => x.id === v.id);
    let id = v.id;
    if (v.fresh) {
      const base = `v-${slug(name) || "device"}`;
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      taken.add(id);
    }
    return { id, name, type: v.type, ...(had && Array.isArray(had.pos) ? { pos: had.pos } : {}) };
  });
  if (virtual.length) z.virtual = virtual;
  else delete z.virtual;

  /* A device moved to another entity keeps its entry, and with it its place on the map in every zone it's in. Its id
     is made from its entity, so that moves too, and the entity it left can be mapped afresh later. */
  for (const [to, from] of Object.entries(d.swap)) {
    const dev = c.devices.find((x) => x.entity === from);
    if (!dev || !(to in d.controls) || c.devices.some((x) => x.entity === to)) continue;
    Object.assign(dev, { entity: to, id: deviceId(to) });
  }
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
    rename(dev, entity);
    const extra = takesExtraMode(entity) ? (d.extra[entity]?.trim().slice(0, MAX_MODE_NAME) ?? "") : "";
    if (extra) dev.nudgeMode = extra;
    else delete dev.nudgeMode;
  }
  /* A device in no zone isn't mapped, so its entry goes. */
  c.devices = c.devices.filter((x) => !Array.isArray(x.zones) || x.zones.length);
}
