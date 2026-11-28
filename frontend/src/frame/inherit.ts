/* What a linked zone takes from its parent (#91). The one rule: a linked zone that shares hardware with its parent is
   the same space for what that hardware measures or does, so the parent's settings for it apply. Any environment
   sensor brings the targets and light limits, any light the day and night and red lights, and every shared device is
   switched only in the parent. It goes by hardware, never by which helper a number sits on, and it's the only way one
   zone's settings ever show in another. */
import { parentOf } from "./family";
import { sensorsOf } from "./readings";

type Raw = Record<string, unknown>;

export interface Takes {
  parent: Raw | null;
  /* Its targets and light limits are the parent's. */
  sensor: boolean;
  /* Its day and night and red lights are the parent's. */
  lights: boolean;
  /* The devices it has that the parent has too. */
  devices: Set<string>;
}

const NONE: Takes = { parent: null, sensor: false, lights: false, devices: new Set() };
const zonesOfDevice = (d: Raw): unknown[] => (Array.isArray(d.zones) ? d.zones : []);
const envIds = (z: Raw | undefined) => new Set(sensorsOf(z).filter((s) => s.kind === "env").map((s) => s.id));

export function takesOf(zones: readonly Raw[], devices: readonly Raw[], z: Raw | undefined): Takes {
  const p = z ? parentOf(zones, z) : null;
  if (!z || !p) return NONE;
  const mine = envIds(z), theirs = envIds(p);
  const both = devices.filter((d) => typeof d.id === "string" && zonesOfDevice(d).includes(z.id) && zonesOfDevice(d).includes(p.id));
  return {
    parent: p,
    sensor: [...mine].some((id) => theirs.has(id)),
    lights: both.some((d) => d.type === "Light"),
    devices: new Set(both.map((d) => d.id as string)),
  };
}

/* What a zone's limits and its day and night are stored in, so the parent's can stand in for them as one piece. */
const TARGET_FIELDS = ["bands", "lightLimits", "linked"] as const;
const TARGET_HELPERS = ["bands", "light"] as const;
const SCHEDULE_FIELDS = ["periodMode", "dayAt", "nightAt", "lights", "rule", "emersonMode", "emerson", "redLights"] as const;
const SCHEDULE_HELPERS = ["day", "night", "morning", "daylight", "evening"] as const;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
function carry(to: Raw, from: Raw, fields: readonly string[], helpers: readonly string[]): void {
  for (const f of fields) {
    if (f in from) to[f] = from[f];
    else delete to[f];
  }
  const mine: Raw = { ...(isObj(to.helpers) ? to.helpers : {}) }, theirs = isObj(from.helpers) ? from.helpers : {};
  for (const h of helpers) {
    if (h in theirs) mine[h] = theirs[h];
    else delete mine[h];
  }
  to.helpers = mine;
}

/* The zone as it's judged and shown: its own record, with the parent's limits where it shares a sensor and the
   parent's day and night where it shares lights. Everything else, its sensors and readings included, stays its own.
   A zone with no parent comes back as it is. Never saved: it's for reading only. */
export function effectiveZone(zones: readonly Raw[], devices: readonly Raw[], z: Raw | undefined): Raw | undefined {
  const t = takesOf(zones, devices, z);
  if (!z || !t.parent || (!t.sensor && !t.lights)) return z;
  const out: Raw = { ...z };
  if (t.sensor) carry(out, t.parent, TARGET_FIELDS, TARGET_HELPERS);
  if (t.lights) carry(out, t.parent, SCHEDULE_FIELDS, SCHEDULE_HELPERS);
  return out;
}

/* A tap on anything read only that a linked zone shows from its parent answers in a one-button dialog: never a toast,
   and never a way to the parent. */
export const notHereText = {
  device: (p: string) => `This device runs on Zone: ${p}'s automations. Please control it in ${p}.`,
  setting: (p: string) => `These settings are Zone: ${p}'s. Please edit them in ${p}.`,
};
export const editIn = (p: string) => `Edit in Zone: ${p}`;
