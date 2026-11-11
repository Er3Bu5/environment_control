/* Manual controls: a zone's climate hardware and lights, switched and set from its own page.

   A control never moves on a tap. It moves when Home Assistant reports the device did, and says so when it doesn't: a
   Tuya plug can drop a command without a word, and a failsafe can put a device straight back. Everything a row shows is
   what HA last reported, never what was asked for. The host is what sends, and it checks every request against the
   setup it fetched itself; this only decides what to draw and what a report means. */
import type { RawConfig } from "./model";
import type { HaState } from "./readings";

export const CONTROL_GROUPS = [
  { key: "humidity", title: "Humidity", metric: "humidity", types: ["Dehumidifier", "Humidifier"] },
  { key: "temperature", title: "Temperature", metric: "temperature", types: ["Air conditioner", "Heater"] },
  { key: "airflow", title: "Airflow", metric: null, types: ["Fan"] },
  { key: "lights", title: "Lights", metric: "light", types: ["Light"] },
] as const;
export type GroupKey = (typeof CONTROL_GROUPS)[number]["key"];

/* Gives up on a report after this long. Tuya plugs can take a few seconds to report even a command they took. */
export const CTL_GIVE_UP_MS = 10_000;
/* A change undone within this long is said to be put back. The light watchdogs run every 2 minutes. */
export const CTL_FLIP_MS = 150_000;

export type Action = "turn_on" | "turn_off" | "brightness" | "mode" | "humidity";
export type Kind = "switch" | "dimmer" | "humidifier";

export interface ControlDevice {
  id: string;
  entity: string;
  name: string;
  role: string;
  zones: string[];
  family: string;
  link: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ROLE_GROUP: Record<string, GroupKey> = Object.fromEntries(CONTROL_GROUPS.flatMap((g) => g.types.map((t) => [t, g.key])));

/* The zone's devices by group. One whose role isn't said yet is held back, because a plain plug could be anything; one
   marked Other isn't climate hardware or a light, so it stays on Devices. */
export function zoneControls(c: RawConfig, zoneId: string): { groups: { key: GroupKey; title: string; metric: string | null; devices: ControlDevice[] }[]; unknown: ControlDevice[] } {
  const mine: ControlDevice[] = c.devices
    .filter((d) => isObj(d) && str(d.id) && str(d.entity) && Array.isArray(d.zones) && d.zones.includes(zoneId))
    .map((d) => ({ id: str(d.id), entity: str(d.entity), name: str(d.name) || str(d.entity), role: str(d.type), zones: (d.zones as unknown[]).filter((z): z is string => typeof z === "string"), family: str(d.family), link: str(d.link) }));
  const groups = CONTROL_GROUPS.map((g) => ({ key: g.key, title: g.title, metric: g.metric, devices: mine.filter((d) => ROLE_GROUP[d.role] === g.key) })).filter((g) => g.devices.length);
  return { groups, unknown: mine.filter((d) => !ROLE_GROUP[d.role] && d.role !== "Other") };
}

export interface DeviceView {
  down: boolean;
  on: boolean;
  kind: Kind;
  brightness: number | null;
  mode: string | null;
  modes: string[];
  setpoint: number | null;
  unitRh: number | null;
  minRh: number | null;
  maxRh: number | null;
  /* What the device reports, as a short phrase: Off, On, On, 80%, On, eco mode. */
  text: string;
  /* A mode the device reports that isn't in its own list, as D1's normal isn't. */
  offList: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const pctOf = (b: unknown): number | null => (num(b) ? Math.round((b / 255) * 100) : null);

export function deviceView(entity: string, st: HaState | undefined): DeviceView {
  const domain = entity.split(".")[0], a = st?.attributes ?? {};
  const modesAttr = Array.isArray(a.supported_color_modes) ? (a.supported_color_modes as unknown[]) : [];
  const kind: Kind = domain === "humidifier" ? "humidifier" : domain === "light" && modesAttr.some((m) => m !== "onoff") ? "dimmer" : "switch";
  const down = !st || st.state === "unavailable" || st.state === "unknown";
  const on = !down && st.state === "on";
  const modes = Array.isArray(a.available_modes) ? (a.available_modes as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const mode = typeof a.mode === "string" ? a.mode : null;
  const v: DeviceView = {
    down, on, kind, brightness: on && kind === "dimmer" ? pctOf(a.brightness) : null, mode: kind === "humidifier" ? mode : null, modes,
    setpoint: num(a.humidity) ? a.humidity : null, unitRh: num(a.current_humidity) ? a.current_humidity : null,
    minRh: num(a.min_humidity) ? a.min_humidity : null, maxRh: num(a.max_humidity) ? a.max_humidity : null,
    text: "", offList: kind === "humidifier" && mode !== null && !modes.includes(mode),
  };
  v.text = down ? "Unavailable" : !on ? (st.state === "off" ? "Off" : cap(st.state)) : v.brightness !== null ? `On, ${v.brightness}%` : v.mode ? `On, ${v.mode} mode` : "On";
  return v;
}

/* Target humidity choices: whole percents inside the device's own limits, and whatever it's set to now. */
export function humidityChoices(v: DeviceView): number[] {
  if (v.minRh === null || v.maxRh === null) return v.setpoint === null ? [] : [v.setpoint];
  const out: number[] = [];
  for (let x = Math.ceil(v.minRh); x <= Math.floor(v.maxRh); x++) out.push(x);
  if (v.setpoint !== null && !out.includes(v.setpoint)) out.push(v.setpoint);
  return out.sort((a, b) => a - b);
}

export interface Want {
  state?: "on" | "off";
  brightness?: number;
  mode?: string;
  humidity?: number;
}

export function wantOf(action: Action, value?: number | string): Want {
  if (action === "turn_on") return { state: "on" };
  if (action === "turn_off") return { state: "off" };
  if (action === "brightness") return { state: "on", brightness: Number(value) };
  if (action === "mode") return { mode: String(value) };
  return { humidity: Number(value) };
}

/* Whether HA reports the device doing what was asked. */
export function wanted(st: HaState | undefined, want: Want): boolean {
  if (!st) return false;
  const a = st.attributes;
  if (want.state && st.state !== want.state) return false;
  if (want.brightness !== undefined && pctOf(a.brightness) !== want.brightness) return false;
  if (want.mode !== undefined && a.mode !== want.mode) return false;
  if (want.humidity !== undefined && a.humidity !== want.humidity) return false;
  return true;
}

/* The one number a command asks for, and what the device reports for it. */
const asked = (want: Want): number | undefined => want.brightness ?? want.humidity;
export function valueOf(st: HaState | undefined, want: Want): number | null {
  if (!st) return null;
  if (want.brightness !== undefined) return pctOf(st.attributes.brightness);
  return want.humidity !== undefined && num(st.attributes.humidity) ? st.attributes.humidity : null;
}

/* from is what the device reported for that number when the command went, so a move can be told from no answer.
   asked is set on a done command the device answered with a different number. */
export type Ctl =
  | { status: "sending"; want: Want; since: number; from?: number | null }
  | { status: "stuck"; want: Want; from?: number | null }
  | { status: "done"; want: Want; at: number; asked?: number }
  | { status: "error"; error: string }
  | { status: "back"; by: "automation" | "other" };

const withValue = (want: Want, n: number): Want => (want.brightness !== undefined ? { ...want, brightness: n } : { ...want, humidity: n });

/* What a new report from HA means for a control that was used. A sent or unconfirmed command counts once the device
   reports it, however late. A device may also answer with a number of its own: a light controller that rounds to 5%
   steps reports 80 when asked for 78, and never reports 78 at all. So a number that moved, to anything, is the device's
   answer, and the row says where it went. A confirmed command that's undone soon after, by anything but a person, was
   put back. */
export function onReport(c: Ctl | undefined, st: HaState | undefined, by: string | undefined, now: number): Ctl | undefined {
  if (!c) return c;
  if (c.status === "sending" || c.status === "stuck") {
    if (wanted(st, c.want)) return { status: "done", want: c.want, at: now };
    const want = asked(c.want), got = valueOf(st, c.want);
    if (want !== undefined && got !== null && got !== c.from && (!c.want.state || st?.state === c.want.state)) return { status: "done", want: withValue(c.want, got), at: now, asked: want };
    return c;
  }
  if (c.status !== "done") return c;
  /* A light that reports its way through a fade lands on the number asked a moment later. */
  if (c.asked !== undefined && valueOf(st, c.want) === c.asked) return { status: "done", want: withValue(c.want, c.asked), at: c.at };
  if (now - c.at < CTL_FLIP_MS && !wanted(st, c.want) && by !== "user") return { status: "back", by: by === "automation" ? "automation" : "other" };
  return c;
}

export function ctlLine(c: Ctl | undefined, d: ControlDevice, v: DeviceView): { text: string; tone: "" | "crit" | "warn" } | null {
  if (!c) return null;
  if (c.status === "done") {
    const got = asked(c.want);
    return c.asked === undefined || got === undefined ? null : { text: `Went to ${got}%, not ${c.asked}%. ${d.name} keeps to its own steps and limits.`, tone: "" };
  }
  if (c.status === "sending") return { text: `Sent. Waiting for ${d.name} to report back.`, tone: "" };
  if (c.status === "error") return { text: `Not sent. ${c.error}`, tone: "crit" };
  if (c.status === "stuck") {
    const want = asked(c.want), got = c.want.brightness !== undefined ? v.brightness : v.setpoint;
    /* A number the device won't take leaves it where it was, with no report, which looks the same as a dropped command. */
    if (want !== undefined && got !== null && (!c.want.state || v.on)) return { text: `Not confirmed. ${d.name} still reports ${got}%. It may not take ${want}%, so try another value.`, tone: "crit" };
    const why = /tuya/i.test(d.family) ? "A Tuya plug can drop a command without saying, so try again." : "Try again, or check the device.";
    return { text: `Not confirmed. ${d.name} still reports ${v.text.toLowerCase()}. ${why}`, tone: "crit" };
  }
  return { text: c.by === "automation" ? "Put back by Home Assistant straight after, most likely a failsafe or the light schedule." : `${d.name} went back on its own.`, tone: "warn" };
}
