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
