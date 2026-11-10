/* What the host sends the frame, checked before use. The host is trusted, but a message that isn't the right shape is
   dropped rather than half-used, so a host bug shows as nothing happening instead of a broken page. */

export interface Theme {
  appearance: "ha" | "light" | "dark";
  mode: "light" | "dark";
  colors: Record<string, string>;
}
export interface Stored {
  revision: number;
  zones: unknown[];
  devices: unknown[];
}
export type LinkKind = "ethernet" | "wifi" | "zigbee" | "zwave" | "thread" | "bluetooth" | "derived" | "unknown";
export type PathKind = "local" | "cloud" | "derived" | "unknown";
export interface CatalogEntity {
  entity_id: string;
  name: string;
  domain: string;
  device_class: string | null;
  unit: string | null;
  state: string | null;
  category: string | null;
  area: string | null;
  /* A number's own limits, so Sensor Calibration can hold a value to them before the number is linked. */
  min?: number;
  max?: number;
  step?: number;
  /* A date and time helper's: lights on and off take a time-only one. */
  has_date?: boolean;
  has_time?: boolean;
}
export interface CatalogDevice {
  id: string;
  name: string;
  area: string | null;
  manufacturer: string | null;
  model: string | null;
  integration: string;
  family: string;
  link: LinkKind;
  path: PathKind;
  hub: string | null;
  entities: CatalogEntity[];
}
export interface Catalog {
  devices: CatalogDevice[];
  entities: (CatalogEntity & { integration: string; family: string })[];
}
/* A chart's readings as the backend buckets them: per entity, each bucket's mean, low and high, or null where there
   was no live reading. */
export type Bucket = [number, number, number] | null;
export interface History {
  start: number;
  end: number;
  step: number;
  series: Record<string, { first: number | null; values: Bucket[] }>;
}
export type HostMessage =
  | ({ type: "init"; states: Record<string, unknown>; theme: Theme; narrow: boolean } & Stored)
  | ({ type: "config" } & Stored)
  | { type: "states"; states: Record<string, unknown> }
  | { type: "theme"; theme: Theme }
  | { type: "narrow"; narrow: boolean }
  | { type: "result"; req: number; ok: boolean; error?: string; catalog?: Catalog; stored?: Stored; history?: History };

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
const COLOR_KEYS = ["primary", "bg", "card", "tile", "fg", "muted", "line"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readTheme(t: unknown): Theme | null {
  if (!isObj(t) || !["ha", "light", "dark"].includes(t.appearance as string) || !["light", "dark"].includes(t.mode as string)) return null;
  const colors: Record<string, string> = {};
  /* Checked again here: a colour lands in a style property, so only a plain colour gets through. */
  if (isObj(t.colors)) for (const k of COLOR_KEYS) if (typeof t.colors[k] === "string" && COLOR.test(t.colors[k] as string)) colors[k] = t.colors[k] as string;
  return { appearance: t.appearance as Theme["appearance"], mode: t.mode as Theme["mode"], colors };
}

const LINKS: readonly LinkKind[] = ["ethernet", "wifi", "zigbee", "zwave", "thread", "bluetooth", "derived", "unknown"];
const PATHS: readonly PathKind[] = ["local", "cloud", "derived", "unknown"];
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

function readEntity(e: unknown): CatalogEntity | null {
  if (!isObj(e) || typeof e.entity_id !== "string" || !ENTITY_ID.test(e.entity_id) || typeof e.domain !== "string") return null;
  return {
    entity_id: e.entity_id,
    name: str(e.name) ?? e.entity_id,
    domain: e.domain,
    device_class: str(e.device_class),
    unit: str(e.unit),
    state: str(e.state),
    category: str(e.category),
    area: str(e.area),
    ...Object.fromEntries((["min", "max", "step"] as const).filter((k) => typeof e[k] === "number" && Number.isFinite(e[k])).map((k) => [k, e[k] as number])),
    ...Object.fromEntries((["has_date", "has_time"] as const).filter((k) => typeof e[k] === "boolean").map((k) => [k, e[k] as boolean])),
  };
}

/* An item that isn't the right shape is left out on its own, so one odd device doesn't hide the rest. A link or path
   this frame doesn't know reads as unknown, never as a guess. */
export function readCatalog(c: unknown): Catalog | null {
  if (!isObj(c) || !Array.isArray(c.devices) || !Array.isArray(c.entities)) return null;
  const devices: CatalogDevice[] = [];
  for (const d of c.devices) {
    if (!isObj(d) || typeof d.id !== "string" || typeof d.name !== "string" || !Array.isArray(d.entities)) continue;
    devices.push({
      id: d.id,
      name: d.name,
      area: str(d.area),
      manufacturer: str(d.manufacturer),
      model: str(d.model),
      integration: str(d.integration) ?? "",
      family: str(d.family) ?? str(d.integration) ?? "",
      link: LINKS.includes(d.link as LinkKind) ? (d.link as LinkKind) : "unknown",
      path: PATHS.includes(d.path as PathKind) ? (d.path as PathKind) : "unknown",
      hub: str(d.hub),
      entities: d.entities.map(readEntity).filter((e): e is CatalogEntity => e !== null),
    });
  }
  const entities: Catalog["entities"] = [];
  for (const e of c.entities) {
    const read = readEntity(e);
    if (read && isObj(e)) entities.push({ ...read, integration: str(e.integration) ?? "", family: str(e.family) ?? "" });
  }
  return { devices, entities };
}

function readStored(m: Record<string, unknown>): Stored | null {
  if (!Number.isInteger(m.revision) || !Array.isArray(m.zones) || !Array.isArray(m.devices)) return null;
  return { revision: m.revision as number, zones: m.zones, devices: m.devices };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/* Checked bucket by bucket: anything that isn't three numbers is no data, never a guess. Every series must have one
   bucket per step, or the whole answer is dropped rather than drawn against the wrong times. */
export function readHistory(h: unknown): History | null {
  if (!isObj(h) || !finite(h.start) || !finite(h.end) || !finite(h.step) || h.step <= 0 || h.end <= h.start || !isObj(h.series)) return null;
  const n = Math.round((h.end - h.start) / h.step);
  if (n < 1 || n > 1000) return null;
  const series: History["series"] = {};
  for (const [entity, raw] of Object.entries(h.series)) {
    if (!ENTITY_ID.test(entity) || !isObj(raw) || !Array.isArray(raw.values) || raw.values.length !== n) return null;
    const values = raw.values.map((b): Bucket => (Array.isArray(b) && b.length === 3 && b.every(finite) ? [b[0], b[1], b[2]] : null));
    series[entity] = { first: finite(raw.first) ? raw.first : null, values };
  }
  return { start: h.start, end: h.end, step: h.step, series };
}

export function readHostMessage(data: unknown): HostMessage | null {
  if (!isObj(data) || data.v !== 1 || typeof data.type !== "string") return null;
  switch (data.type) {
    case "init": {
      const stored = readStored(data), theme = readTheme(data.theme);
      return stored && theme && isObj(data.states) ? { type: "init", ...stored, states: data.states, theme, narrow: data.narrow === true } : null;
    }
    case "config": {
      const stored = readStored(data);
      return stored ? { type: "config", ...stored } : null;
    }
    case "states":
      return isObj(data.states) ? { type: "states", states: data.states } : null;
    case "theme": {
      const theme = readTheme(data.theme);
      return theme ? { type: "theme", theme } : null;
    }
    case "narrow":
      return typeof data.narrow === "boolean" ? { type: "narrow", narrow: data.narrow } : null;
    case "result": {
      if (!Number.isInteger(data.req) || typeof data.ok !== "boolean") return null;
      const catalog = "catalog" in data ? readCatalog(data.catalog) : undefined;
      /* A save answers with what the backend stored, which replaces the frame's copy. */
      const stored = "revision" in data ? readStored(data) : null;
      const history = "history" in data ? readHistory(data.history) : null;
      return {
        type: "result",
        req: data.req as number,
        ok: data.ok,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
        ...(catalog ? { catalog } : {}),
        ...(stored ? { stored } : {}),
        ...(history ? { history } : {}),
      };
    }
    default:
      return null;
  }
}
