/* Automations: the Home Assistant automations behind a zone's alerts, failsafes and light schedule, which the panel
   switches on and off. Home Assistant keeps running them, and nothing here changes what one does.

   A switch shows only what HA reports, as a Controls row does: after a tap it says the command was sent, then shows the
   report, and says so when none comes. The zone's links and the room's alert repeat helper are edited as drafts against
   what's saved, and the helper's value counts only once HA reports it. This only decides what to draw and what a report
   means; the host is what sends, and it checks every request against the setup it fetched itself. */
import type { Catalog, CatalogAutomation, Room } from "./messages";
import { AUTOMATION_GROUPS, type AutomationGroup, type AutomationLink, MAX_LINK_NAME, type RawConfig, type Zone, andList, readLinks } from "./model";
import { type HaState, numberOf } from "./readings";

/* The Automations page's three chips, and the groups each one holds. */
export const AUTO_CHIPS = ["alert", "failsafe", "control"] as const;
export type AutoChip = (typeof AUTO_CHIPS)[number];
export type AutoIcon = "bell" | "shield" | "clock";
export const CHIP: Record<AutoChip, { title: string; icon: AutoIcon; about: string }> = {
  alert: { title: "Alerts", icon: "bell", about: "Home Assistant's alerts for this zone. Switched off, an alert stops notifying you until it's switched on again." },
  failsafe: {
    title: "Failsafes",
    icon: "shield",
    about: "Home Assistant's failsafes for this zone. Each puts hardware back when something goes wrong, such as a fan plug turning off. While one is off, nothing does that.",
  },
  control: {
    title: "Control",
    icon: "clock",
    about: "The automations that switch this zone's hardware, such as its lights on their schedule. Switched off, the hardware stays as it is until something else moves it.",
  },
};
export const GROUP: Record<AutomationGroup, { chip: AutoChip; title: string }> = {
  alert_day: { chip: "alert", title: "Day alerts" },
  alert_night: { chip: "alert", title: "Night alerts" },
  alert_device: { chip: "alert", title: "Device alerts" },
  failsafe: { chip: "failsafe", title: "Failsafes" },
  control: { chip: "control", title: "Control" },
};

export const groupsOf = (chip: AutoChip): AutomationGroup[] => AUTOMATION_GROUPS.filter((g) => GROUP[g].chip === chip);
export const linksOf = (z: Zone, chip?: AutoChip): AutomationLink[] => z.automations.filter((a) => !chip || GROUP[a.group].chip === chip);

/* The Automations page while it's open: the zone, the chip picked, and the alert repeat box's draft, undefined while
   it holds what the helper reports. */
export interface AutosPage {
  zoneId: string;
  chip: AutoChip;
  repeat?: string;
}

/* What a review lists, in the shape main.ts's reviews take. */
export interface AutoChange {
  label: string;
  before: string;
  after: string;
}
/* A question the panel's own guard dialog puts before going on. */
export interface Question {
  title: string;
  text: string;
  keep: string;
  go: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* Only a suggestion. Names follow no rule Home Assistant enforces, and a dashboard can keep an alert named ..._day with
   its device alerts, so the group can always be changed. */
export function suggestGroup(entity: string): AutomationGroup {
  const n = entity.split(".")[1] ?? "";
  if (/^(failsafe|startup)_/.test(n)) return "failsafe";
  if (/^(critical|warning)_/.test(n)) return /_day$/.test(n) ? "alert_day" : /_night$/.test(n) ? "alert_night" : "alert_device";
  return "control";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/* When an automation last ran, in the viewer's own time against the real clock. Days are counted between midnights,
   so a daylight saving change doesn't move yesterday. A year is only said when it isn't this one. */
export function ranWords(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t), at = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `today at ${at}`;
  if (days === 1) return `yesterday at ${at}`;
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} at ${at}`;
}

/* An automation as its row shows it. Only on and off can be switched: anything else HA reports is unavailable, so a
   state it passes through while starting up is never taken for off, and one it no longer has is gone. */
export type AutoState = "on" | "off" | "unavailable" | "gone";
export function autoState(st: HaState | undefined): AutoState {
  if (!st) return "gone";
  return st.state === "on" || st.state === "off" ? st.state : "unavailable";
}
export function autoName(entity: string, st: HaState | undefined): string {
  const n = st?.attributes.friendly_name;
  return typeof n === "string" && n.trim() ? n : entity;
}
/* The name an automation goes by in the panel. Only a zone's link can carry one of the panel's own, so an automation no
   zone links is named as Home Assistant names it. */
export function linkName(link: { entity: string; name?: string }, st: HaState | undefined): string {
  return link.name?.trim() || autoName(link.entity, st);
}
const STATE_WORDS: Record<AutoState, string> = { on: "On.", off: "Off.", unavailable: "Unavailable in Home Assistant.", gone: "Home Assistant doesn't have it any more." };

/* Other zones that link the same automation, by name. An automation belongs to one zone, so Link automations names
   the one that has it, and saving it here too is refused. */
export function sharedWith(zones: Zone[], zoneId: string, entity: string): string[] {
  return zones.filter((o) => o.id !== zoneId && o.automations.some((a) => a.entity === entity)).map((o) => o.name);
}

/* A switch after a tap. Absent, the row shows what HA reports and says nothing more. A sent command waits for the
   report however late it comes, after giving up included, and a refused one says why. */
export type AutoWant = "on" | "off";
export type AutoCtl = { status: "sending"; want: AutoWant } | { status: "stuck"; want: AutoWant } | { status: "error"; error: string };

export const autoSend = (on: boolean): AutoCtl => ({ status: "sending", want: on ? "on" : "off" });

/* The host's answer. A yes means HA took the call, not that the automation changed, so it goes on waiting unless the
   report is already in. */
export function autoAnswered(c: AutoCtl, r: { ok: boolean; error?: string }, st: HaState | undefined): AutoCtl | undefined {
  /* A refusal that comes after giving up still says why: the switch was never sent. */
  if (c.status === "error") return c;
  if (!r.ok) return { status: "error", error: r.error ?? "Home Assistant didn't take it." };
  return st?.state === c.want ? undefined : c;
}
export function autoReported(c: AutoCtl | undefined, st: HaState | undefined): AutoCtl | undefined {
  return c && c.status !== "error" && st?.state === c.want ? undefined : c;
}
/* Called once CTL_GIVE_UP_MS has passed with the same command still waiting, the wait Controls use. */
export const autoGiveUp = (c: AutoCtl): AutoCtl => (c.status === "sending" ? { status: "stuck", want: c.want } : c);

/* A report from HA for the automations in it: the switches it settles, or null when it settles none. */
export function autosReported(ctl: Record<string, AutoCtl>, states: Record<string, HaState>, entities: string[]): Record<string, AutoCtl> | null {
  let next: Record<string, AutoCtl> | null = null;
  for (const e of entities) {
    const was = ctl[e];
    if (!was) continue;
    const now = autoReported(was, states[e]);
    if (now === was) continue;
    next ??= { ...ctl };
    if (now) next[e] = now;
    else delete next[e];
  }
  return next;
}

export interface AutoLine {
  text: string;
  tone: "" | "crit";
}
export function autoLine(c: AutoCtl | undefined, st: HaState | undefined): AutoLine | null {
  if (!c) return null;
  if (c.status === "sending") return { text: `Sent. Waiting for Home Assistant to report it ${c.want}.`, tone: "" };
  if (c.status === "error") return { text: `Not sent. ${c.error}`, tone: "crit" };
  return { text: `Not confirmed. Home Assistant still reports it ${st?.state ?? "missing"}. Try again.`, tone: "crit" };
}

export interface AutoRow {
  link: AutomationLink;
  name: string;
  state: AutoState;
  on: boolean;
  /* Held while a tap waits for its report, and on anything that can't be switched. */
  locked: boolean;
  sub: string;
  line: AutoLine | null;
}
export function autoRow(link: AutomationLink, st: HaState | undefined, ctl: AutoCtl | undefined, now: number): AutoRow {
  const state = autoState(st), last = st?.attributes.last_triggered;
  const ran = typeof last === "string" ? ranWords(last, now) : "";
  /* HA says null for one that never ran. Anything else that isn't a time says nothing, rather than claiming that. */
  const when = ran ? `Last triggered ${ran}.` : last === null ? "Never triggered." : "";
  const sub = [STATE_WORDS[state], when].filter(Boolean).join(" ");
  return { link, name: linkName(link, st), state, on: state === "on", locked: (state !== "on" && state !== "off") || ctl?.status === "sending", sub, line: autoLine(ctl, st) };
}

/* Switching a failsafe off is a safety decision, so it asks first. Switching one on, and alerts and control either way,
   don't. Asked only while HA reports it on, since that's the only time the tap switches it off. */
export function offQuestion(link: AutomationLink, st: HaState | undefined): Question | null {
  if (link.group !== "failsafe" || autoState(st) !== "on") return null;
  return {
    title: `Switch off ${linkName(link, st)}?`,
    text: "It's a failsafe: it puts hardware back when something goes wrong. While it's off, Home Assistant won't do that. You can switch it on again here.",
    keep: "Keep it on",
    go: "Switch off",
  };
}

/* Counts of what HA reports on. Unavailable and gone count in the total, so a dead one isn't hidden from it. */
export interface AutoCount {
  on: number;
  total: number;
}
export function countOf(links: AutomationLink[], states: Record<string, HaState>): AutoCount {
  return { on: links.filter((a) => autoState(states[a.entity]) === "on").length, total: links.length };
}
export const countWords = (c: AutoCount) => (c.total ? `${c.on} of ${c.total} on` : "None linked");

export interface ChipView {
  chip: AutoChip;
  title: string;
  /* The small count beside the name, and the whole button said in words. */
  count: string;
  label: string;
}
export function chipViews(z: Zone, states: Record<string, HaState>): ChipView[] {
  return AUTO_CHIPS.map((chip) => {
    const c = countOf(linksOf(z, chip), states), title = CHIP[chip].title;
    return { chip, title, count: `${c.on}/${c.total}`, label: `${title}, ${c.total ? `${c.on} of ${c.total} on` : "none linked"}` };
  });
}

/* A chip's groups that link anything, each a card with its count. */
export interface GroupView {
  group: AutomationGroup;
  title: string;
  count: string;
  links: AutomationLink[];
}
export function groupViews(z: Zone, chip: AutoChip, states: Record<string, HaState>): GroupView[] {
  return groupsOf(chip)
    .map((group) => {
      const links = z.automations.filter((a) => a.group === group);
      return { group, title: GROUP[group].title, count: countWords(countOf(links, states)), links };
    })
    .filter((g) => g.links.length);
}
export const emptyText = (chip: AutoChip, zoneName: string) => `No ${CHIP[chip].title.toLowerCase()} linked to ${zoneName} yet`;

/* Failsafes HA reports off: the zone page says so, since while one is off nothing puts that hardware back. One that's
   unavailable or gone isn't counted, because it couldn't be switched on from here anyway, and its own row says why. */
export function failsafesOff(z: Zone, states: Record<string, HaState>): { link: AutomationLink; name: string }[] {
  return linksOf(z, "failsafe")
    .filter((a) => autoState(states[a.entity]) === "off")
    .map((link) => ({ link, name: linkName(link, states[link.entity]) }));
}
export function failsafeNotice(off: { name: string }[]): string | null {
  if (!off.length) return null;
  return off.length === 1
    ? `A failsafe is off: ${off[0].name}. While it's off, nothing puts that hardware back.`
    : `${off.length} failsafes are off. While they're off, nothing puts that hardware back.`;
}

/* The alert repeat: one Home Assistant helper shared by every alert, linked once for the room on Setup and changed on
   any zone's Automations page. */
export interface RepeatLimits {
  min: number;
  max: number;
  step: number;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function repeatLimits(st: HaState | undefined): RepeatLimits | null {
  const { min, max, step } = st?.attributes ?? {};
  return finite(min) && finite(max) && finite(step) && step > 0 && min <= max ? { min, max, step } : null;
}
const unitOf = (st: HaState | undefined) => (typeof st?.attributes.unit_of_measurement === "string" && st.attributes.unit_of_measurement ? ` ${st.attributes.unit_of_measurement}` : "");
/* A helper that doesn't say its limits is still held to being a number; the host holds it to the rest. */
export function repeatProblem(typed: string, L: RepeatLimits | null): string {
  const t = typed.trim(), n = Number(t);
  if (t === "" || !Number.isFinite(n)) return "Type a number of minutes.";
  if (!L) return "";
  const steps = (n - L.min) / L.step;
  if (n < L.min || n > L.max || Math.abs(steps - Math.round(steps)) > 1e-6) return `It has to be between ${L.min} and ${L.max}, in steps of ${L.step}, as your helper allows.`;
  return "";
}

/* What the Alert repeat card shows: a way to link one, a helper HA doesn't have right now, or the box. */
export type RepeatCard =
  | { kind: "unlinked" }
  | { kind: "missing"; entity: string }
  | { kind: "ready"; entity: string; value: string; limits: RepeatLimits | null; problem: string };
const usable = (st: HaState | undefined): st is HaState => !!st && st.state !== "unavailable" && st.state !== "unknown";
export function repeatCard(room: Room | undefined, states: Record<string, HaState>, typed: string | undefined): RepeatCard {
  const entity = room?.alertRepeat, st = entity ? states[entity] : undefined;
  if (!entity) return { kind: "unlinked" };
  if (!usable(st)) return { kind: "missing", entity };
  const limits = repeatLimits(st), value = typed ?? st.state;
  return { kind: "ready", entity, value, limits, problem: repeatProblem(value, limits) };
}

/* The box differs from what the helper reports. The same number written differently, 15.0 for 15, is no change. */
export function repeatChanges(room: Room | undefined, states: Record<string, HaState>, typed: string | undefined): AutoChange[] {
  const entity = room?.alertRepeat, st = entity ? states[entity] : undefined;
  if (!entity || typed === undefined || !usable(st)) return [];
  const t = typed.trim(), n = Number(t), now = numberOf(st);
  if (t === st.state || (t !== "" && Number.isFinite(n) && now !== null && Math.abs(n - now) < 1e-9)) return [];
  const unit = unitOf(st);
  return [{ label: "Alert repeat", before: `${st.state}${unit}`, after: `${t}${unit}` }];
}
export const repeatValue = (typed: string) => Number(typed.trim());
export const repeatNote = (entity: string) =>
  `This changes every alert in Home Assistant, not just this zone's. On your helper, ${entity}. Every alert follows it straight away.`;
export const repeatRefused = (error: string) => `Alert repeat wasn't changed. ${error}`;
export const repeatStuck = (st: HaState | undefined) => `Alert repeat: Home Assistant still reports ${st?.state ?? "nothing"}.`;

/* Setup's Alerts card: the room's one helper. Linking, changing and unlinking it save straight away, since none of them
   changes a value anywhere. */
export const REPEAT_LIKELY = ["repeat", "alert"];
export function repeatHelperOptions(catalog: Catalog | null): { entity: string; name: string; state: string | null; unit: string | null }[] {
  return (catalog?.entities ?? []).filter((e) => e.domain === "input_number").map((e) => ({ entity: e.entity_id, name: e.name, state: e.state, unit: e.unit }));
}
export function alertsCardText(entity: string, st: HaState | undefined): string {
  return `${usable(st) ? `${st.state}${unitOf(st)}.` : "Home Assistant doesn't have it right now."} On your helper, ${entity}. Change it on any zone's Automations page, under Alerts.`;
}
export const SAID = {
  repeatLinked: "Alert repeat linked.",
  repeatUnlinked: "Alert repeat unlinked. Your helper stays as it is.",
  repeatChanged: "Alert repeat changed.",
  linksSaved: (zone: string) => `${zone}'s automations saved.`,
} as const;

/* Link automations: which of HA's automations a zone switches, and in which group. Only Environment Control's own
   record changes, and a newly linked automation can be switched only once a person allows it in the host's dialog. */
export interface LinkDraft {
  zoneId: string;
  /* By automation: what the zone links as saved, and the draft of it. */
  was: Record<string, AutomationGroup>;
  pick: Record<string, AutomationGroup>;
  /* By automation: the panel's names as saved, and as typed. Only a ticked one's counts. */
  wasNames: Record<string, string>;
  names: Record<string, string>;
  q: string;
  /* The Automations page's chip it was opened from, to go back to; null when opened from Setup. */
  from: AutoChip | null;
}
export function openLinks(z: Zone, from: AutoChip | null): LinkDraft {
  const was = Object.fromEntries(z.automations.map((a) => [a.entity, a.group]));
  const wasNames = Object.fromEntries(z.automations.flatMap((a) => (a.name ? [[a.entity, a.name]] : [])));
  return { zoneId: z.id, was, pick: { ...was }, wasNames, names: { ...wasNames }, q: "", from };
}
/* Ticked again, one the zone had saved goes back to its own group; a new one starts in the group its name suggests. */
export function toggleLink(d: LinkDraft, entity: string): void {
  if (d.pick[entity] !== undefined) delete d.pick[entity];
  else d.pick[entity] = d.was[entity] ?? suggestGroup(entity);
}
export function setLinkGroup(d: LinkDraft, entity: string, group: AutomationGroup): void {
  if (d.pick[entity] !== undefined) d.pick[entity] = group;
}
/* Emptied, it's Home Assistant's name again, as the put back button makes it. */
export function setLinkName(d: LinkDraft, entity: string, typed: string): void {
  if (typed === "") delete d.names[entity];
  else d.names[entity] = typed;
}
const typedName = (d: LinkDraft, entity: string) => d.names[entity]?.trim() ?? "";

/* A typed name the backend wouldn't store holds the save back and says why, naming the automation as Home Assistant
   does, since the name typed is the trouble. The box stops at 100, so a longer one has come from somewhere else. */
export function linkNameIssue(d: LinkDraft, entity: string, haName: string): string {
  const typed = d.names[entity];
  if (d.pick[entity] === undefined || typed === undefined) return "";
  if (!typed.trim()) return `Spaces alone aren't a name. Type one for ${haName}, or put Home Assistant's back.`;
  if (typed.trim().length > MAX_LINK_NAME) return `The name for ${haName} is longer than ${MAX_LINK_NAME} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(typed)) return `The name for ${haName} has a character a name can't hold.`;
  return "";
}
export function linkIssue(d: LinkDraft, automations: CatalogAutomation[], states: Record<string, HaState>): string {
  for (const e of Object.keys(d.pick)) {
    const why = linkNameIssue(d, e, haNameOf(e, automations, states));
    if (why) return why;
  }
  return "";
}

export interface LinkRow {
  entity: string;
  name: string;
  /* Home Assistant's name, the box's hint; and the box as typed, while the row is ticked. */
  haName: string;
  typed: string;
  issue: string;
  sub: string;
  pill: string;
  group: AutomationGroup | null;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const pillOf = (state: string | null | undefined) => (!state ? "Missing" : state === "on" ? "On" : state === "off" ? "Off" : cap(state));

/* A search shows this many at most, as the helper search box does, so one letter typed into a Home Assistant with
   hundreds of automations doesn't draw them all. */
export const LINK_FOUND_MAX = 10;

/* With nothing typed: what the zone links or has ticked, and automations in its Home Assistant area or with its name as
   a word in their entity id. The rest, the house's included, come up only by searching, and are counted. Typing
   searches them all by name or entity id, and counts the matches past the first few. A linked automation HA no longer
   lists is still there, so it can be unlinked. */
export function linkList(d: LinkDraft, zones: Zone[], automations: CatalogAutomation[], states: Record<string, HaState>): { rows: LinkRow[]; more: number } {
  const z = zones.find((x) => x.id === d.zoneId), zname = z?.name.trim().toLowerCase() ?? "", word = slug(z?.name ?? "");
  const listed = new Set(automations.map((a) => a.entity_id));
  const kept = [...new Set([...Object.keys(d.was), ...Object.keys(d.pick)])].filter((e) => !listed.has(e));
  const items = [
    ...automations.map((a) => ({ entity: a.entity_id, name: states[a.entity_id] ? autoName(a.entity_id, states[a.entity_id]) : a.name, area: a.area, state: states[a.entity_id]?.state ?? a.state, listed: true })),
    ...kept.map((e) => ({ entity: e, name: autoName(e, states[e]), area: null, state: states[e]?.state ?? null, listed: false })),
  ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.entity.localeCompare(b.entity));
  const words = d.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const near = (it: (typeof items)[number]) =>
    d.pick[it.entity] !== undefined ||
    d.was[it.entity] !== undefined ||
    (!!it.area && it.area.trim().toLowerCase() === zname) ||
    (!!word && `_${it.entity.split(".")[1]}_`.includes(`_${word}_`));
  const found = items.filter((it) => (words.length ? words.every((w) => `${it.entity} ${it.name}`.toLowerCase().includes(w)) : near(it)));
  const shown = words.length ? found.slice(0, LINK_FOUND_MAX) : found;
  const rows = shown.map((it) => {
    const shared = sharedWith(zones, d.zoneId, it.entity);
    const where = [it.entity, it.area ? `${it.area} area` : "", shared.length ? `linked in ${andList(shared)}` : ""].filter(Boolean).join(", ");
    /* A name of the panel's own never hides which automation it is: Home Assistant's stays on the line below. */
    const ticked = d.pick[it.entity] !== undefined, own = ticked ? typedName(d, it.entity) : "";
    return {
      entity: it.entity,
      name: own || it.name,
      haName: it.name,
      typed: ticked ? (d.names[it.entity] ?? "") : "",
      issue: linkNameIssue(d, it.entity, it.name),
      sub: own ? `${it.name}. ${where}` : where,
      pill: pillOf(it.state),
      group: d.pick[it.entity] ?? null,
    };
  });
  return { rows, more: words.length ? found.length - shown.length : automations.length - shown.filter((it) => it.listed).length };
}

export const linkLabel = (g: AutomationGroup | undefined) => (g === undefined ? "Not linked" : GROUP[g].title);

const haNameOf = (e: string, automations: CatalogAutomation[], states: Record<string, HaState>) => automations.find((a) => a.entity_id === e)?.name ?? autoName(e, states[e]);

/* Every automation whose group differs from what's saved, Not linked included, then every ticked one whose name does,
   as the review lists them. A group change names the automation as the zone knows it now. A rename reads from the name
   it went by to the one it will, Home Assistant's at either end when the panel has none. */
export function linkChanges(d: LinkDraft, automations: CatalogAutomation[], states: Record<string, HaState>): AutoChange[] {
  const out: AutoChange[] = [];
  for (const e of new Set([...Object.keys(d.was), ...Object.keys(d.pick)])) {
    const before = linkLabel(d.was[e]), after = linkLabel(d.pick[e]);
    if (before !== after) out.push({ label: d.wasNames[e] || haNameOf(e, automations, states), before, after });
  }
  for (const e of Object.keys(d.pick)) {
    const ha = haNameOf(e, automations, states), before = (d.was[e] !== undefined && d.wasNames[e]) || ha, after = typedName(d, e) || ha;
    if (before !== after) out.push({ label: "Name", before, after });
  }
  return out;
}

/* The host asks before a newly linked automation can be switched. */
export function linkNote(d: LinkDraft): string {
  const fresh = Object.keys(d.pick).some((e) => d.was[e] === undefined);
  return `Only Environment Control changes, and Home Assistant keeps running every automation as it is.${fresh ? " Home Assistant asks you before a newly linked one can be switched from here." : ""}`;
}

/* A link that stays keeps its id, so the frame never names a different automation by an id it used before. A new one
   gets a fresh a<number> past the highest the zone had, never one it had. */
export function linksToSave(had: AutomationLink[], pick: Record<string, AutomationGroup>, names: Record<string, string>): AutomationLink[] {
  const used = new Set(had.map((a) => a.id));
  let n = had.reduce((m, a) => Math.max(m, /^a\d+$/.test(a.id) ? Number(a.id.slice(1)) : 0), 0);
  /* The backend refuses an empty name, so one left empty is no name at all rather than "". */
  const named = (entity: string) => (names[entity]?.trim() ? { name: names[entity].trim() } : {});
  const kept = had.filter((a) => pick[a.entity] !== undefined).map((a) => ({ id: a.id, entity: a.entity, group: pick[a.entity], ...named(a.entity) }));
  const fresh = Object.keys(pick)
    .filter((e) => !had.some((a) => a.entity === e))
    .map((entity) => {
      let id: string;
      do id = `a${++n}`;
      while (used.has(id));
      used.add(id);
      return { id, entity, group: pick[entity], ...named(entity) };
    });
  return [...kept, ...fresh];
}

/* Applied to the zone as saved at the moment of saving, so ids come from what's stored, not from when the page opened. */
export function applyLinks(c: RawConfig, zoneId: string, pick: Record<string, AutomationGroup>, names: Record<string, string>): void {
  const z = c.zones.find((x) => x.id === zoneId);
  if (!z) return;
  const links = linksToSave(readLinks(z.automations), pick, names);
  if (links.length) z.automations = links;
  else delete z.automations;
}

/* The Remove zone dialog's row: the links go with the zone, and the automations stay in Home Assistant. */
export function removeRow(z: Zone): [string, string] {
  const n = z.automations.length;
  return ["Automations", !n ? "" : n === 1 ? "1 unlinked. It keeps running in Home Assistant" : `${n} unlinked. They keep running in Home Assistant`];
}
