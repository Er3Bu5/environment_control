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
  /* A mode the device has that Home Assistant doesn't list, reached by moving its target one step and back. */
  extraMode: string;
  /* Modes the device has that its row leaves out. */
  hiddenModes: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const DIAL_DOMAINS = /^(light|humidifier)\./;
const ROLE_GROUP: Record<string, GroupKey> = Object.fromEntries(CONTROL_GROUPS.flatMap((g) => g.types.map((t) => [t, g.key])));

/* The zone's devices by group. One whose role isn't said yet is held back, because a plain plug could be anything; one
   marked Other isn't climate hardware or a light, so it stays on Devices. */
export function zoneControls(c: RawConfig, zoneId: string): { groups: { key: GroupKey; title: string; metric: string | null; devices: ControlDevice[] }[]; unknown: ControlDevice[] } {
  const mine: ControlDevice[] = c.devices
    .filter((d) => isObj(d) && str(d.id) && str(d.entity) && Array.isArray(d.zones) && d.zones.includes(zoneId))
    .map((d) => ({ id: str(d.id), entity: str(d.entity), name: str(d.name) || str(d.entity), role: str(d.type), zones: (d.zones as unknown[]).filter((z): z is string => typeof z === "string"), family: str(d.family), link: str(d.link), extraMode: str(d.nudgeMode).trim(), hiddenModes: Array.isArray(d.hiddenModes) ? d.hiddenModes.filter((m): m is string => typeof m === "string") : [] }));
  /* In a group, what can have a dial comes first: a light controller, a dehumidifier. Its row is tall and a plug's is
     short, so on a screen wide enough for two columns the tall rows pair up and a plug isn't stretched beside a dial.
     Told by the kind of entity, which doesn't change, never by what it reports, so a row never moves. */
  const dialFirst = (list: ControlDevice[]) => [...list.filter((d) => DIAL_DOMAINS.test(d.entity)), ...list.filter((d) => !DIAL_DOMAINS.test(d.entity))];
  const groups = CONTROL_GROUPS.map((g) => ({ key: g.key, title: g.title, metric: g.metric, devices: dialFirst(mine.filter((d) => ROLE_GROUP[d.role] === g.key)) })).filter((g) => g.devices.length);
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
  /* The step the device says its target moves in, where it says. This room's dehumidifiers step by 5, and take a
     target between two steps without a word and without changing anything. */
  stepRh: number | null;
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
    minRh: num(a.min_humidity) ? a.min_humidity : null, maxRh: num(a.max_humidity) ? a.max_humidity : null, stepRh: num(a.target_humidity_step) && a.target_humidity_step > 0 ? a.target_humidity_step : null,
    text: "", offList: kind === "humidifier" && mode !== null && !modes.includes(mode),
  };
  v.text = down ? "Unavailable" : !on ? (st.state === "off" ? "Off" : cap(st.state)) : v.brightness !== null ? `On, ${v.brightness}%` : v.mode ? `On, ${v.mode} mode` : "On";
  return v;
}

/* Target humidity choices: the device's own steps from its lowest, or whole percents where it names no step, inside its
   limits, and whatever it's set to now. */
export function humidityChoices(v: DeviceView): number[] {
  if (v.minRh === null || v.maxRh === null) return v.setpoint === null ? [] : [v.setpoint];
  const out: number[] = [], step = v.stepRh ?? 1;
  for (let x = v.stepRh === null ? Math.ceil(v.minRh) : v.minRh; x <= v.maxRh + 1e-9; x += step) if (Number.isInteger(x)) out.push(x);
  if (v.setpoint !== null && !out.includes(v.setpoint)) out.push(v.setpoint);
  return out.sort((a, b) => a - b);
}
/* The choice nearest a number, for a dial turned to somewhere between two of the device's steps. */
export const nearestChoice = (choices: number[], n: number): number => choices.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), choices[0] ?? n);

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
  | { status: "sending"; want: Want; since: number; from?: number | null; note?: string }
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
  if (c.status === "sending") return { text: c.note ?? `Sent. Waiting for ${d.name} to report back.`, tone: "" };
  if (c.status === "error") return { text: `Not sent. ${c.error}`, tone: "crit" };
  if (c.status === "stuck") {
    const want = asked(c.want), got = c.want.brightness !== undefined ? v.brightness : v.setpoint;
    /* A number the device won't take leaves it where it was, with no report, which looks the same as a dropped command. */
    if (want !== undefined && got !== null && (!c.want.state || v.on)) return { text: `Not confirmed. ${d.name} still reports ${got}%. It may not take ${want}%, so try another value.`, tone: "crit" };
    /* The extra mode has no command of its own, so nothing was dropped: the device took its target and stayed put. */
    if (c.want.mode !== undefined && c.want.mode === d.extraMode && !v.modes.includes(d.extraMode))
      return { text: `Not confirmed. ${d.name} still reports ${v.text.toLowerCase()}. Moving its target didn't put it in ${d.extraMode} mode.`, tone: "crit" };
    const why = /tuya/i.test(d.family) ? "A Tuya plug can drop a command without saying, so try again." : "Try again, or check the device.";
    return { text: `Not confirmed. ${d.name} still reports ${v.text.toLowerCase()}. ${why}`, tone: "crit" };
  }
  return { text: c.by === "automation" ? "Put back by Home Assistant straight after, most likely a failsafe or the light schedule." : `${d.name} went back on its own.`, tone: "warn" };
}

/* The dial a number is set on: a 270 degree arc, open at the bottom, in a 120 unit box. t runs 0 to 1 along it. */
const DIAL = { mid: 60, r: 48, from: 135, sweep: 270 };
const unit = (t: number) => Math.min(1, Math.max(0, t));
export const dialT = (n: number, min: number, max: number) => (max > min ? unit((n - min) / (max - min)) : 0);
export function dialAt(t: number): [number, number] {
  const a = ((DIAL.from + DIAL.sweep * unit(t)) * Math.PI) / 180;
  return [DIAL.mid + DIAL.r * Math.cos(a), DIAL.mid + DIAL.r * Math.sin(a)];
}
export function dialArc(t0: number, t1: number): string {
  const [x0, y0] = dialAt(t0), [x1, y1] = dialAt(t1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${DIAL.r} ${DIAL.r} 0 ${(unit(t1) - unit(t0)) * DIAL.sweep > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
/* The number under a point in the dial's box. A point in the gap at the bottom goes to whichever end is nearer, so a
   drag past either end stops there and never jumps to the other. */
export function dialValue(x: number, y: number, min: number, max: number): number {
  const deg = ((Math.atan2(y - DIAL.mid, x - DIAL.mid) * 180) / Math.PI + 360) % 360, rel = (deg - DIAL.from + 360) % 360;
  const t = rel <= DIAL.sweep ? rel / DIAL.sweep : rel > (DIAL.sweep + 360) / 2 ? 0 : 1;
  return Math.round(min + t * (max - min));
}
/* The plus and minus buttons go to the next whole step, so 78 goes up to 80 and down to 75 in steps of 5. */
export const stepUp = (n: number, step: number, max: number) => Math.min(max, Math.floor(n / step) * step + step);
export const stepDown = (n: number, step: number, min: number) => Math.max(min, Math.ceil(n / step) * step - step);
/* A light controller is set in 5% steps, as the boards here round to; a target humidity in whole percents. A drag or
   the arrow keys still reach any whole percent. */
export const DIAL_STEP = { brightness: 5, humidity: 1 } as const;
/* The next choice up or down from a number, for a dial whose device takes only some numbers. */
export const choiceUp = (choices: number[], n: number) => choices.find((c) => c > n) ?? n;
export const choiceDown = (choices: number[], n: number) => [...choices].reverse().find((c) => c < n) ?? n;
/* The buttons and keys send once they've been left alone this long, so five presses are one command, not five. */
export const DIAL_SETTLE_MS = 700;

/* The modes a device is offered: Home Assistant's own list, then the extra one set for it, if HA doesn't list that. */
/* The modes a row offers: Home Assistant's list and the extra one, less any left out in Device identification. The
   mode the device is in is always there, left out or not, so the row never shows a device in no mode at all. */
export const modeChoices = (v: DeviceView, extra: string, hidden: string[] = []): string[] =>
  (extra && !v.modes.includes(extra) ? [...v.modes, extra] : v.modes).filter((m) => m === v.mode || !hidden.includes(m));

/* Some dehumidifiers have a mode their integration can't ask for, which the device drops into when its target is
   changed: here, by moving the target one of the device's own steps and back. The two targets to ask for, in order,
   or null when the device has no target to move or no room to move it. */
export function nudgeTargets(v: DeviceView): [number, number] | null {
  if (v.setpoint === null || v.minRh === null || v.maxRh === null) return null;
  const steps = humidityChoices({ ...v, setpoint: null });
  if (!steps.length) return null;
  const back = nearestChoice(steps, v.setpoint), at = steps.indexOf(back), other = steps[at + 1] ?? steps[at - 1];
  return other === undefined ? null : [other, back];
}
