import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTO_CHIPS,
  CHIP,
  GROUP,
  LINK_FOUND_MAX,
  REPEAT_LIKELY,
  alertsCardText,
  applyLinks,
  autoAnswered,
  autoGiveUp,
  autoLine,
  autoName,
  autoReported,
  autoRow,
  autoSend,
  autoState,
  autosReported,
  chipViews,
  countOf,
  countWords,
  emptyText,
  failsafeNotice,
  failsafesOff,
  groupViews,
  groupsOf,
  linkChanges,
  linkIssue,
  linkList,
  linkName,
  linkNote,
  linksOf,
  linksToSave,
  offQuestion,
  openLinks,
  ranWords,
  removeRow,
  repeatCard,
  repeatChanges,
  repeatHelperOptions,
  repeatLimits,
  repeatNote,
  repeatProblem,
  repeatRefused,
  repeatStuck,
  setLinkGroup,
  setLinkName,
  linkStanding,
  otherZoneText,
  hiddenWords,
  suggestGroup,
  toggleLink,
} from "../../src/frame/automations";
import type { Catalog, CatalogAutomation } from "../../src/frame/messages";
import { AUTOMATION_GROUPS, type AutomationLink, copyConfig, readZones } from "../../src/frame/model";
import type { HaState } from "../../src/frame/readings";

const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: null });
const auto = (state: string, name: string, last: string | null = null) => st(state, { friendly_name: name, last_triggered: last });
const link = (id: string, object: string, group: string) => ({ id, entity: `automation.${object}`, group });

/* Each zone links its own, since an automation belongs to one zone. Veg has one named for Nursery. */
const zones = readZones([
  {
    id: "garden",
    name: "Garden",
    automations: [
      link("a1", "critical_garden_temperature_high_day", "alert_day"),
      link("a2", "critical_garden_humidity_high_day", "alert_day"),
      link("a3", "critical_garden_temperature_low_night", "alert_night"),
      link("a4", "failsafe_garden_lights_recovery", "failsafe"),
      link("a5", "failsafe_dehumidifier_mains_auto_on", "failsafe"),
    ],
  },
  { id: "veg", name: "Veg", automations: [link("a1", "failsafe_tent_lights_recovery", "failsafe"), link("a2", "tent_lights_on", "control"), link("a3", "nursery_door_alert", "alert_device")] },
  {
    id: "nursery",
    name: "Nursery",
    automations: [link("a1", "critical_nursery_temperature_high_day", "alert_day"), link("a2", "failsafe_nursery_fans_auto_on", "failsafe"), link("a3", "nursery_lights_on", "control")],
  },
]);
const [garden, veg] = zones;
const states: Record<string, HaState> = {
  "automation.critical_garden_temperature_high_day": auto("on", "Critical Garden Temperature High Day"),
  "automation.critical_garden_humidity_high_day": auto("off", "Critical Garden Humidity High Day"),
  "automation.critical_garden_temperature_low_night": auto("unavailable", "Critical Garden Temperature Low Night"),
  "automation.failsafe_garden_lights_recovery": auto("off", "Failsafe Garden Lights Recovery"),
  "automation.failsafe_dehumidifier_mains_auto_on": auto("on", "Failsafe Dehumidifier Mains Auto On"),
  "automation.failsafe_tent_lights_recovery": auto("on", "Failsafe Tent Lights Recovery"),
  "automation.tent_lights_on": auto("on", "Tent Lights On"),
  "automation.critical_nursery_temperature_high_day": auto("on", "Critical Nursery Temperature High Day"),
  "automation.failsafe_nursery_fans_auto_on": auto("on", "Failsafe Nursery Fans Auto On"),
  "automation.nursery_lights_on": auto("on", "Nursery Lights On"),
};

describe("groups and chips", () => {
  it("puts every group under one of the three chips, in the order the page shows them", () => {
    expect(AUTO_CHIPS.map((c) => [CHIP[c].title, CHIP[c].icon, groupsOf(c).map((g) => GROUP[g].title)])).toEqual([
      ["Alerts", "bell", ["Day alerts", "Night alerts", "Device alerts"]],
      ["Failsafes", "shield", ["Failsafes"]],
      ["Control", "clock", ["Control"]],
    ]);
    expect(AUTO_CHIPS.flatMap(groupsOf).sort()).toEqual([...AUTOMATION_GROUPS].sort());
    expect(CHIP.failsafe.about).toBe("Home Assistant's failsafes for this zone. Each puts hardware back when something goes wrong, such as a fan plug turning off. While one is off, nothing does that.");
  });

  it("picks out a zone's links on one chip", () => {
    expect(linksOf(garden, "alert").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(linksOf(garden, "control")).toEqual([]);
    expect(linksOf(garden)).toHaveLength(5);
  });

  it("suggests a group from the automation's name, and anything it can't tell is control", () => {
    const cases: [string, string][] = [
      ["automation.failsafe_veg_fans_auto_on", "failsafe"],
      ["automation.startup_reservoir_pump_off", "failsafe"],
      ["automation.critical_garden_temperature_high_day", "alert_day"],
      ["automation.warning_veg_humidity_low_night", "alert_night"],
      ["automation.critical_garden_dehumidifier_full", "alert_device"],
      /* The sample room keeps this one with its device alerts: the name only suggests. */
      ["automation.critical_garden_light_controller_overhead_off_day", "alert_day"],
      ["automation.garden_lights_on", "control"],
      ["automation.daytime_failsafe_check", "control"],
    ];
    for (const [entity, group] of cases) expect([entity, suggestGroup(entity)]).toEqual([entity, group]);
  });
});

describe("when an automation last ran", () => {
  /* A zone with daylight saving, so the day count can be shown not to slip across a change. Node takes a new TZ at once.
     The frame's types leave Node's out, so its environment is reached untyped. */
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env, tz = env.TZ;
  beforeAll(() => {
    env.TZ = "Pacific/Auckland";
  });
  afterAll(() => {
    if (tz === undefined) delete env.TZ;
    else env.TZ = tz;
  });
  const now = Date.parse("2026-11-17T13:30:00+13:00");

  it("says today or yesterday, and otherwise the day and month, with a 24 hour time in the viewer's own zone", () => {
    expect(ranWords("2026-11-17T00:05:00Z", now)).toBe("today at 13:05");
    expect(ranWords("2026-11-17T00:01:00+13:00", now)).toBe("today at 00:01");
    expect(ranWords("2026-11-16T23:59:00+13:00", now)).toBe("yesterday at 23:59");
    expect(ranWords("2026-11-15T23:59:00+13:00", now)).toBe("15 Nov at 23:59");
    expect(ranWords("2026-01-02T08:00:00+13:00", now)).toBe("2 Jan at 08:00");
  });

  it("says the year only when it isn't this one, and nothing for a time that isn't one", () => {
    expect(ranWords("2025-11-12T09:00:00+13:00", now)).toBe("12 Nov 2025 at 09:00");
    expect(ranWords("soon", now)).toBe("");
  });

  it("still calls the day before a daylight saving change yesterday", () => {
    expect(ranWords("2026-09-27T01:00:00+12:00", Date.parse("2026-09-28T01:00:00+13:00"))).toBe("yesterday at 01:00");
    expect(ranWords("2026-04-05T01:00:00+13:00", Date.parse("2026-04-06T01:00:00+12:00"))).toBe("yesterday at 01:00");
  });
});

describe("an automation's row", () => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  it("reads only on and off as switchable, anything else as unavailable, and a missing state as gone", () => {
    expect([st("on"), st("off"), st("unavailable"), st("unknown"), undefined].map(autoState)).toEqual(["on", "off", "unavailable", "unavailable", "gone"]);
  });

  it("names it as Home Assistant does, or by its entity id when HA has no name for it", () => {
    expect(autoName("automation.x", auto("on", "Lights On"))).toBe("Lights On");
    expect(autoName("automation.x", st("on", { friendly_name: " " }))).toBe("automation.x");
    expect(autoName("automation.x", undefined)).toBe("automation.x");
  });

  it("says what HA reports and when it last ran, and no other zone, since an automation has only one", () => {
    const r = autoRow(veg.automations[0], auto("on", "Failsafe Tent Lights Recovery", at(1)), undefined, now);
    expect(r).toMatchObject({ name: "Failsafe Tent Lights Recovery", state: "on", on: true, locked: false, line: null });
    expect(r.sub).toMatch(/^On\. Last triggered (today|yesterday) at \d\d:\d\d\.$/);
    expect(autoRow(veg.automations[1], auto("off", "Tent Lights On"), undefined, now).sub).toBe("Off. Never triggered.");
  });

  it("can't be switched while unavailable or gone, and says which", () => {
    const down = autoRow(garden.automations[2], st("unavailable", { friendly_name: "Low Night" }), undefined, now);
    expect([down.sub, down.locked, down.on]).toEqual(["Unavailable in Home Assistant.", true, false]);
    const gone = autoRow(garden.automations[2], undefined, undefined, now);
    expect([gone.name, gone.sub, gone.locked]).toEqual(["automation.critical_garden_temperature_low_night", "Home Assistant doesn't have it any more.", true]);
  });

  it("doesn't claim one never ran unless HA says so", () => {
    expect(autoRow(veg.automations[1], st("on", { friendly_name: "Tent Lights On", last_triggered: 5 }), undefined, now).sub).toBe("On.");
    expect(autoRow(veg.automations[1], st("on", { friendly_name: "Tent Lights On" }), undefined, now).sub).toBe("On.");
  });

  it("is held while a tap waits for its report, and free again once it gives up or is refused", () => {
    const row = (c: Parameters<typeof autoRow>[2]) => autoRow(veg.automations[1], auto("off", "Tent Lights On"), c, now);
    expect(row(autoSend(true)).locked).toBe(true);
    expect(row({ status: "stuck", want: "on" }).locked).toBe(false);
    expect(row({ status: "error", error: "No." }).locked).toBe(false);
  });

});

describe("a switch after a tap", () => {
  it("waits for HA to report the new state, never assuming it", () => {
    const c = autoSend(false);
    expect(c).toEqual({ status: "sending", want: "off" });
    expect(autoAnswered(c, { ok: true }, st("on"))).toBe(c);
    expect(autoAnswered(c, { ok: true }, st("off"))).toBeUndefined();
    expect(autoReported(c, st("on"))).toBe(c);
    expect(autoReported(c, st("off"))).toBeUndefined();
  });

  it("says the host's reason when the host refuses, or that HA didn't take it when it gives none", () => {
    expect(autoAnswered(autoSend(true), { ok: false, error: "That zone doesn't link that automation." }, st("off"))).toEqual({ status: "error", error: "That zone doesn't link that automation." });
    expect(autoAnswered(autoSend(true), { ok: false }, st("off"))).toEqual({ status: "error", error: "Home Assistant didn't take it." });
  });

  it("an answer that comes after giving up still counts: a refusal says why, a yes leaves it waiting for the report", () => {
    const stuck = autoGiveUp(autoSend(true));
    expect(autoAnswered(stuck, { ok: false, error: "No." }, st("off"))).toEqual({ status: "error", error: "No." });
    expect(autoAnswered(stuck, { ok: true }, st("off"))).toBe(stuck);
    expect(autoAnswered(stuck, { ok: true }, st("on"))).toBeUndefined();
  });

  it("gives up after the wait, and still counts a report that comes after that", () => {
    const stuck = autoGiveUp(autoSend(true));
    expect(stuck).toEqual({ status: "stuck", want: "on" });
    expect(autoReported(stuck, st("off"))).toBe(stuck);
    expect(autoReported(stuck, st("on"))).toBeUndefined();
    const error = { status: "error", error: "No." } as const;
    expect(autoGiveUp(stuck)).toBe(stuck);
    expect(autoGiveUp(error)).toBe(error);
    expect(autoReported(error, st("on"))).toBe(error);
  });

  it("says what it's waiting for, what HA still reports, and why it wasn't sent", () => {
    expect(autoLine(autoSend(true), st("off"))).toEqual({ text: "Sent. Waiting for Home Assistant to report it on.", tone: "" });
    expect(autoLine(autoSend(false), st("on"))?.text).toBe("Sent. Waiting for Home Assistant to report it off.");
    expect(autoLine({ status: "stuck", want: "on" }, st("off"))).toEqual({ text: "Not confirmed. Home Assistant still reports it off. Try again.", tone: "crit" });
    expect(autoLine({ status: "stuck", want: "on" }, undefined)?.text).toBe("Not confirmed. Home Assistant still reports it missing. Try again.");
    expect(autoLine({ status: "error", error: "It's unavailable in Home Assistant." }, st("off"))).toEqual({ text: "Not sent. It's unavailable in Home Assistant.", tone: "crit" });
    expect(autoLine(undefined, st("on"))).toBeNull();
  });

  it("settles only the switches a report reaches, leaving the others and the old record alone", () => {
    const ctl = { "automation.a": autoSend(true), "automation.b": autoSend(true) };
    const now = { "automation.a": st("on"), "automation.b": st("on") };
    expect(autosReported(ctl, now, ["automation.c"])).toBeNull();
    expect(autosReported(ctl, { "automation.a": st("off") }, ["automation.a"])).toBeNull();
    expect(autosReported(ctl, now, ["automation.a"])).toEqual({ "automation.b": autoSend(true) });
    expect(Object.keys(ctl)).toEqual(["automation.a", "automation.b"]);
  });
});

describe("switching a failsafe off", () => {
  it("asks first, saying nothing will put the hardware back", () => {
    expect(offQuestion(veg.automations[0], states["automation.failsafe_tent_lights_recovery"])).toEqual({
      title: "Switch off Failsafe Tent Lights Recovery?",
      text: "It's a failsafe: it puts hardware back when something goes wrong. While it's off, Home Assistant won't do that. You can switch it on again here.",
      keep: "Keep it on",
      go: "Switch off",
    });
  });

  it("doesn't ask to switch one on, or anything that isn't a failsafe", () => {
    expect(offQuestion(garden.automations[3], states["automation.failsafe_garden_lights_recovery"])).toBeNull();
    expect(offQuestion(garden.automations[0], states["automation.critical_garden_temperature_high_day"])).toBeNull();
    expect(offQuestion(veg.automations[1], states["automation.tent_lights_on"])).toBeNull();
  });
});

describe("counts", () => {
  it("counts what HA reports on, with unavailable and gone in the total", () => {
    expect(countOf(linksOf(garden, "alert"), states)).toEqual({ on: 1, total: 3 });
    expect(countWords({ on: 1, total: 3 })).toBe("1 of 3 on");
    expect(countWords({ on: 0, total: 0 })).toBe("None linked");
  });

  it("gives each chip its count, and says it in words for a screen reader", () => {
    expect(chipViews(garden, states)).toEqual([
      { chip: "alert", title: "Alerts", count: "1/3", label: "Alerts, 1 of 3 on", star: false },
      { chip: "failsafe", title: "Failsafes", count: "1/2", label: "Failsafes, 1 of 2 on", star: false },
      { chip: "control", title: "Control", count: "0/0", label: "Control, none linked", star: false },
    ]);
  });

  it("makes a card only for a group that links anything, and says when a chip links nothing", () => {
    expect(groupViews(garden, "alert", states).map((g) => [g.title, g.count, g.links.map((a) => a.id)])).toEqual([
      ["Day alerts", "1 of 2 on", ["a1", "a2"]],
      ["Night alerts", "0 of 1 on", ["a3"]],
    ]);
    expect(groupViews(garden, "control", states)).toEqual([]);
    expect(emptyText("control", "Garden")).toBe("No control linked to Garden yet");
    expect(emptyText("alert", "Veg")).toBe("No alerts linked to Veg yet");
  });
});

describe("failsafes that are off", () => {
  it("finds those HA reports off, leaving out one that's unavailable or gone", () => {
    expect(failsafesOff(garden, states).map((x) => x.name)).toEqual(["Failsafe Garden Lights Recovery"]);
    expect(failsafesOff(garden, { ...states, "automation.failsafe_garden_lights_recovery": st("unavailable") })).toEqual([]);
    expect(failsafesOff(garden, {})).toEqual([]);
  });

  it("names one, counts several, and says nothing when none is off", () => {
    expect(failsafeNotice([{ name: "Failsafe Garden Lights Recovery" }])).toBe("A failsafe is off: Failsafe Garden Lights Recovery. While it's off, nothing puts that hardware back.");
    expect(failsafeNotice([{ name: "A" }, { name: "B" }])).toBe("2 failsafes are off. While they're off, nothing puts that hardware back.");
    expect(failsafeNotice([])).toBeNull();
  });
});

describe("the alert repeat", () => {
  const helper = st("15", { friendly_name: "Alert repeat rate", min: 0, max: 120, step: 1, unit_of_measurement: "min" });
  const room = { alertRepeat: "input_number.alert_repeat_rate" };
  const live = { "input_number.alert_repeat_rate": helper };

  it("reads the helper's own limits, and none it doesn't say or that make no sense", () => {
    expect(repeatLimits(helper)).toEqual({ min: 0, max: 120, step: 1 });
    expect(repeatLimits(st("15", { min: 0, max: 120 }))).toBeNull();
    expect(repeatLimits(st("15", { min: 0, max: 120, step: 0 }))).toBeNull();
    expect(repeatLimits(st("15", { min: 10, max: 1, step: 1 }))).toBeNull();
    expect(repeatLimits(undefined)).toBeNull();
  });

  it("holds a typed value to a number inside the helper's min, max and step", () => {
    const L = { min: 0, max: 120, step: 5 };
    expect(["", "  ", "abc", "1e"].map((v) => repeatProblem(v, L))).toEqual(Array(4).fill("Type a number of minutes."));
    for (const v of ["-5", "125", "7"]) expect(repeatProblem(v, L)).toBe("It has to be between 0 and 120, in steps of 5, as your helper allows.");
    expect(["0", " 120 ", "35"].map((v) => repeatProblem(v, L))).toEqual(["", "", ""]);
    expect(repeatProblem("1.5", { min: 0.5, max: 5, step: 0.5 })).toBe("");
    expect(repeatProblem("1.25", { min: 0.5, max: 5, step: 0.5 })).not.toBe("");
    expect([repeatProblem("999", null), repeatProblem("x", null)]).toEqual(["", "Type a number of minutes."]);
  });

  it("offers a link while none is linked, says so while HA doesn't have the helper, and otherwise shows the box", () => {
    expect(repeatCard({}, live, undefined)).toEqual({ kind: "unlinked" });
    expect(repeatCard(undefined, live, undefined)).toEqual({ kind: "unlinked" });
    expect(repeatCard(room, {}, undefined)).toEqual({ kind: "missing", entity: "input_number.alert_repeat_rate" });
    expect(repeatCard(room, { "input_number.alert_repeat_rate": st("unavailable") }, "20")).toEqual({ kind: "missing", entity: "input_number.alert_repeat_rate" });
    expect(repeatCard(room, live, undefined)).toEqual({ kind: "ready", entity: "input_number.alert_repeat_rate", value: "15", limits: { min: 0, max: 120, step: 1 }, problem: "" });
    expect(repeatCard(room, live, "500")).toMatchObject({ value: "500", problem: "It has to be between 0 and 120, in steps of 1, as your helper allows." });
  });

  it("is one change while the box differs from what the helper reports, and none for the same number written another way", () => {
    expect(repeatChanges(room, live, "20")).toEqual([{ label: "Alert repeat", before: "15 min", after: "20 min" }]);
    expect(repeatChanges(room, live, " 20 ")).toEqual([{ label: "Alert repeat", before: "15 min", after: "20 min" }]);
    expect(repeatChanges(room, live, "15.0")).toEqual([]);
    expect(repeatChanges(room, live, undefined)).toEqual([]);
    expect(repeatChanges(room, live, "")).toHaveLength(1);
    expect(repeatChanges(room, { "input_number.alert_repeat_rate": st("15", {}) }, "20")).toEqual([{ label: "Alert repeat", before: "15", after: "20" }]);
  });

  it("has nothing to apply while HA doesn't have the helper or none is linked", () => {
    expect(repeatChanges(room, {}, "20")).toEqual([]);
    expect(repeatChanges(room, { "input_number.alert_repeat_rate": st("unavailable") }, "20")).toEqual([]);
    expect(repeatChanges({}, live, "20")).toEqual([]);
  });

  it("tells the review it changes every alert, and says what HA still reports when it doesn't take", () => {
    expect(repeatNote("input_number.alert_repeat_rate")).toBe(
      "This changes every alert in Home Assistant, not just this zone's. On your helper, input_number.alert_repeat_rate. Every alert follows it straight away.",
    );
    expect(repeatRefused("The alert repeat rate isn't linked to a helper.")).toBe("Alert repeat wasn't changed. The alert repeat rate isn't linked to a helper.");
    expect([repeatStuck(helper), repeatStuck(undefined)]).toEqual(["Alert repeat: Home Assistant still reports 15.", "Alert repeat: Home Assistant still reports nothing."]);
  });
});

describe("Setup's Alerts card", () => {
  it("offers Home Assistant's number helpers, with what each holds, for the helper search box", () => {
    const num = (entity_id: string, name: string, state: string, unit: string | null) => ({ entity_id, name, domain: "input_number", device_class: null, unit, state, category: null, area: null, integration: "input_number", family: "Helper" });
    const catalog: Catalog = {
      devices: [],
      entities: [num("input_number.alert_repeat_rate", "Alert repeat rate", "15", "min"), { ...num("input_datetime.lights_on", "Lights on", "07:00:00", null), domain: "input_datetime" }, num("input_number.spare", "Spare", "1", null)],
      automations: [],
    };
    expect(repeatHelperOptions(catalog)).toEqual([
      { entity: "input_number.alert_repeat_rate", name: "Alert repeat rate", state: "15", unit: "min" },
      { entity: "input_number.spare", name: "Spare", state: "1", unit: null },
    ]);
    expect(repeatHelperOptions(null)).toEqual([]);
    expect(REPEAT_LIKELY).toEqual(["repeat", "alert"]);
  });

  it("says what the linked helper holds and where it's changed, or that HA doesn't have it right now", () => {
    const e = "input_number.alert_repeat_rate";
    expect(alertsCardText(e, st("15", { unit_of_measurement: "min" }))).toBe("15 min. On your helper, input_number.alert_repeat_rate. Change it on any zone's Automations page, under Alerts.");
    for (const s of [undefined, st("unavailable")])
      expect(alertsCardText(e, s)).toBe("Home Assistant doesn't have it right now. On your helper, input_number.alert_repeat_rate. Change it on any zone's Automations page, under Alerts.");
  });
});

describe("Link automations", () => {
  const ha = (entity_id: string, name: string, area: string | null = null, state = "on"): CatalogAutomation => ({ entity_id: `automation.${entity_id}`, name, state, area, last_triggered: null });
  const catalog = [
    ha("tent_lights_on", "Tent Lights On", "Veg"),
    ha("failsafe_tent_lights_recovery", "Failsafe Tent Lights Recovery", "Veg"),
    ha("nursery_door_alert", "Nursery Door Alert", "Veg"),
    ha("critical_nursery_temperature_high_day", "Critical Nursery Temperature High Day", "Nursery"),
    ha("failsafe_nursery_fans_auto_on", "Failsafe Nursery Fans Auto On", "Nursery"),
    ha("nursery_lights_on", "Nursery Lights On"),
    ha("critical_nursery_vpd_high_day", "Critical Nursery VPD High Day"),
    ha("nursery_fan_kick", "Fan kick", "Garden", "off"),
    ha("day_humidity_upper_limit", "Day Humidity Upper Limit", "Garden", "off"),
    ha("porch_light_on", "Porch Light On"),
    ha("nurseryman_reminder", "Reminder"),
    ha("veg_heat_alarm", "Heat alarm", " nursery "),
  ];
  const nursery = zones[2];
  const saved = { "automation.critical_nursery_temperature_high_day": "alert_day", "automation.failsafe_nursery_fans_auto_on": "failsafe", "automation.nursery_lights_on": "control" };

  it("opens on what the zone links as saved, and ticks a new automation in the group its name suggests", () => {
    const d = openLinks(nursery, "failsafe");
    expect([d.was, d.pick, d.q, d.others, d.from]).toEqual([saved, saved, "", false, "failsafe"]);
    toggleLink(d, "automation.critical_nursery_vpd_high_day");
    expect(d.pick["automation.critical_nursery_vpd_high_day"]).toBe("alert_day");
    d.pick.x = "control";
    expect(d.was).not.toHaveProperty("x");
  });

  it("puts one the zone had saved back in its own group when it's unticked and ticked again", () => {
    const d = openLinks(nursery, null);
    setLinkGroup(d, "automation.nursery_lights_on", "alert_device");
    toggleLink(d, "automation.nursery_lights_on");
    expect(d.pick).not.toHaveProperty("automation.nursery_lights_on");
    setLinkGroup(d, "automation.nursery_lights_on", "failsafe");
    expect(d.pick).not.toHaveProperty("automation.nursery_lights_on");
    toggleLink(d, "automation.nursery_lights_on");
    expect(d.pick["automation.nursery_lights_on"]).toBe("control");
  });

  it("with nothing typed lists what the zone links, its area's automations and those named for it, and counts the rest", () => {
    const { rows, more } = linkList(openLinks(nursery, null), zones, catalog, states);
    expect(rows.map((r) => r.name)).toEqual(["Critical Nursery Temperature High Day", "Critical Nursery VPD High Day", "Failsafe Nursery Fans Auto On", "Fan kick", "Heat alarm", "Nursery Lights On"]);
    expect(more).toBe(5);
  });

  it("splits automations into the zone's own, free ones, and another zone's, by what's saved", () => {
    const d = openLinks(nursery, null);
    expect(linkStanding(d, zones, "automation.nursery_lights_on")).toEqual({ kind: "own" });
    expect(linkStanding(d, zones, "automation.porch_light_on")).toEqual({ kind: "free" });
    expect(linkStanding(d, zones, "automation.nursery_door_alert")).toEqual({ kind: "other", zone: "Veg" });
    /* A draft elsewhere is nobody's: unticking one here doesn't make it another zone's, nor free it in Veg. */
    toggleLink(d, "automation.nursery_lights_on");
    expect(linkStanding(d, zones, "automation.nursery_lights_on")).toEqual({ kind: "own" });
    expect(linkStanding(openLinks(veg, null), zones, "automation.nursery_lights_on")).toEqual({ kind: "other", zone: "Nursery" });
    /* A setup from before the rule with one in two zones: each zone's own stays its own, so it can be unlinked. */
    const both = readZones([{ id: "a", name: "A", automations: [link("a1", "x", "control")] }, { id: "b", name: "B", automations: [link("a1", "x", "control")] }]);
    expect(linkStanding(openLinks(both[0], null), both, "automation.x")).toEqual({ kind: "own" });
  });

  it("hides another zone's and counts them, and with the toggle on lists them where they fall, marked and never ticked", () => {
    const d = openLinks(nursery, null);
    const off = linkList(d, zones, catalog, states);
    expect(off.rows.map((r) => r.entity)).not.toContain("automation.nursery_door_alert");
    expect([off.elsewhere, off.hidden]).toEqual([1, 1]);
    expect(hiddenWords(1)).toBe("1 is hidden because another zone has it.");
    expect(hiddenWords(3)).toBe("3 are hidden because another zone has them.");
    d.others = true;
    const on = linkList(d, zones, catalog, states);
    expect([on.elsewhere, on.hidden, on.more]).toEqual([1, 0, off.more]);
    expect(on.rows.map((r) => r.name)).toEqual(["Critical Nursery Temperature High Day", "Critical Nursery VPD High Day", "Failsafe Nursery Fans Auto On", "Fan kick", "Heat alarm", "Nursery Door Alert", "Nursery Lights On"]);
    expect(on.rows.find((r) => r.name === "Nursery Door Alert")).toEqual({ entity: "automation.nursery_door_alert", name: "Nursery Door Alert", sub: "In Zone: Veg", pill: "On", group: null, other: "Veg", haName: "Nursery Door Alert", typed: "", issue: "" });
    expect(otherZoneText("Veg")).toBe("This automation is already associated to Zone: Veg. Please remove it before associating it with a new zone.");
    /* With none to hide, there's no toggle and no line. */
    expect(linkList(openLinks(garden, null), zones, catalog, states)).toMatchObject({ elsewhere: 0, hidden: 0 });
  });

  it("searches what's shown: another zone's stay hidden while the toggle is off, counted in the line, not as more", () => {
    const d = openLinks(nursery, null);
    d.q = "lights";
    expect(linkList(d, zones, catalog, states)).toMatchObject({ rows: [expect.objectContaining({ entity: "automation.nursery_lights_on" })], more: 0, elsewhere: 2, hidden: 2 });
    d.others = true;
    expect(linkList(d, zones, catalog, states).rows.map((r) => [r.name, r.other])).toEqual([
      ["Failsafe Tent Lights Recovery", "Veg"],
      ["Nursery Lights On", null],
      ["Tent Lights On", "Veg"],
    ]);
  });

  it("says where each one is, whether it's on, and the group of one that's ticked", () => {
    const rows = Object.fromEntries(linkList(openLinks(nursery, null), zones, catalog, states).rows.map((r) => [r.entity, r]));
    expect(rows["automation.nursery_lights_on"]).toEqual({ entity: "automation.nursery_lights_on", name: "Nursery Lights On", sub: "automation.nursery_lights_on", pill: "On", group: "control", other: null, haName: "Nursery Lights On", typed: "", issue: "" });
    expect(rows["automation.nursery_fan_kick"]).toMatchObject({ sub: "automation.nursery_fan_kick, Garden area", pill: "Off", group: null });
  });

  it("searches every automation by each word typed, in its name or entity id, and counts none as more", () => {
    const d = openLinks(nursery, null);
    d.q = "  PORCH ";
    expect(linkList(d, zones, catalog, states)).toEqual({ rows: [expect.objectContaining({ entity: "automation.porch_light_on" })], more: 0, elsewhere: 0, hidden: 0 });
    d.q = "day upper";
    expect(linkList(d, zones, catalog, states).rows.map((r) => r.name)).toEqual(["Day Humidity Upper Limit"]);
    d.q = "lights nursery";
    expect(linkList(d, zones, catalog, states).rows.map((r) => r.name)).toEqual(["Nursery Lights On"]);
    d.q = "nothing like it";
    expect(linkList(d, zones, catalog, states).rows).toEqual([]);
  });

  it("shows a search's first few matches by name and counts the rest, so one letter can't draw every automation", () => {
    const many = Array.from({ length: LINK_FOUND_MAX + 7 }, (_, i) => ha(`porch_${String(i).padStart(2, "0")}`, `Porch ${String(i).padStart(2, "0")}`));
    const d = openLinks(nursery, null);
    d.q = "p";
    const { rows, more } = linkList(d, zones, [...catalog, ...many], states);
    expect(rows).toHaveLength(LINK_FOUND_MAX);
    expect(more).toBe(11);
    expect(rows[0].name).toBe("Critical Nursery Temperature High Day");
    d.q = "porch_1";
    expect(linkList(d, zones, [...catalog, ...many], states).rows.map((r) => r.name)).toEqual(["Porch 10", "Porch 11", "Porch 12", "Porch 13", "Porch 14", "Porch 15", "Porch 16"]);
  });

  it("keeps a linked automation Home Assistant no longer lists, so it can still be unlinked", () => {
    const d = openLinks(garden, "alert");
    const rows = linkList(d, zones, catalog, {}).rows;
    expect(rows.map((r) => r.entity)).toContain("automation.critical_garden_temperature_low_night");
    expect(rows.find((r) => r.entity === "automation.critical_garden_temperature_low_night")).toMatchObject({ name: "automation.critical_garden_temperature_low_night", pill: "Missing", group: "alert_night" });
    expect(linkList(d, zones, catalog, states).rows.find((r) => r.entity === "automation.critical_garden_temperature_low_night")).toMatchObject({ name: "Critical Garden Temperature Low Night", pill: "Unavailable" });
  });

  it("lists every change for the review, as the group before and after", () => {
    const d = openLinks(veg, "control");
    toggleLink(d, "automation.critical_nursery_vpd_high_day");
    toggleLink(d, "automation.failsafe_tent_lights_recovery");
    setLinkGroup(d, "automation.tent_lights_on", "alert_device");
    expect(linkChanges(d, catalog, states)).toEqual([
      { label: "Failsafe Tent Lights Recovery", before: "Failsafes", after: "Not linked" },
      { label: "Tent Lights On", before: "Control", after: "Device alerts" },
      { label: "Critical Nursery VPD High Day", before: "Not linked", after: "Day alerts" },
    ]);
    expect(linkChanges(openLinks(veg, null), catalog, states)).toEqual([]);
    const gone = openLinks(garden, null);
    toggleLink(gone, "automation.critical_garden_temperature_low_night");
    expect(linkChanges(gone, [], {})).toEqual([{ label: "automation.critical_garden_temperature_low_night", before: "Night alerts", after: "Not linked" }]);
  });

  it("says Home Assistant asks first whenever something is newly linked", () => {
    const d = openLinks(nursery, null);
    expect(linkNote(d)).toBe("Only Environment Control changes, and Home Assistant keeps running every automation as it is.");
    toggleLink(d, "automation.nursery_lights_on");
    toggleLink(d, "automation.nursery_lights_on");
    expect(linkNote(d)).toBe("Only Environment Control changes, and Home Assistant keeps running every automation as it is.");
    toggleLink(d, "automation.porch_light_on");
    expect(linkNote(d)).toBe(
      "Only Environment Control changes, and Home Assistant keeps running every automation as it is. Home Assistant asks you before a newly linked one can be switched from here.",
    );
  });
});

describe("saving links", () => {
  const had: AutomationLink[] = [
    { id: "a1", entity: "automation.one", group: "alert_day" },
    { id: "a4", entity: "automation.four", group: "failsafe" },
    { id: "custom", entity: "automation.custom", group: "control" },
  ];

  it("keeps the id of a link that stays, in its saved place, with its group as picked", () => {
    expect(linksToSave(had, { "automation.four": "control", "automation.one": "alert_day", "automation.custom": "control" }, {})).toEqual([
      { id: "a1", entity: "automation.one", group: "alert_day" },
      { id: "a4", entity: "automation.four", group: "control" },
      { id: "custom", entity: "automation.custom", group: "control" },
    ]);
  });

  it("gives a new link a fresh id past the highest the zone had, never one a removed link had", () => {
    expect(linksToSave(had, { "automation.one": "alert_day", "automation.new": "control", "automation.newer": "failsafe" }, {})).toEqual([
      { id: "a1", entity: "automation.one", group: "alert_day" },
      { id: "a5", entity: "automation.new", group: "control" },
      { id: "a6", entity: "automation.newer", group: "failsafe" },
    ]);
    expect(linksToSave([], { "automation.x": "control" }, {})).toEqual([{ id: "a1", entity: "automation.x", group: "control" }]);
    expect(linksToSave([{ id: "a01", entity: "automation.y", group: "control" }, { id: "a2x", entity: "automation.z", group: "control" }], { "automation.x": "control" }, {})).toEqual([
      { id: "a2", entity: "automation.x", group: "control" },
    ]);
  });

  it("applies to the zone as it's stored when saving, and stores no list for a zone that links nothing", () => {
    const c = copyConfig([{ id: "veg", name: "Veg", automations: had, extra: 1 }, { id: "garden", name: "Garden" }], []);
    applyLinks(c, "veg", { "automation.four": "failsafe", "automation.new": "alert_night" }, {});
    expect(c.zones[0]).toEqual({ id: "veg", name: "Veg", extra: 1, automations: [{ id: "a4", entity: "automation.four", group: "failsafe" }, { id: "a5", entity: "automation.new", group: "alert_night" }] });
    applyLinks(c, "veg", {}, {});
    expect("automations" in c.zones[0]).toBe(false);
    applyLinks(c, "garden", { "automation.x": "control" }, {});
    expect(c.zones[1].automations).toEqual([{ id: "a1", entity: "automation.x", group: "control" }]);
    applyLinks(c, "gone", { "automation.x": "control" }, {});
    expect(c.zones).toHaveLength(2);
  });
});

describe("a link's own name", () => {
  const named = readZones([
    {
      id: "veg",
      name: "Veg",
      automations: [
        { id: "a1", entity: "automation.failsafe_tent_lights_recovery", group: "failsafe", name: "Tent lights back on" },
        { id: "a2", entity: "automation.tent_lights_on", group: "control" },
        { id: "a3", entity: "automation.nursery_door_alert", group: "alert_device", name: "" },
      ],
    },
  ])[0];
  const haStates: Record<string, HaState> = {
    "automation.failsafe_tent_lights_recovery": auto("on", "Failsafe Tent Lights Recovery"),
    "automation.tent_lights_on": auto("on", "Tent Lights On"),
  };
  const haList: CatalogAutomation[] = [
    { entity_id: "automation.failsafe_tent_lights_recovery", name: "Failsafe Tent Lights Recovery", state: "on", area: null, last_triggered: null },
    { entity_id: "automation.tent_lights_on", name: "Tent Lights On", state: "on", area: null, last_triggered: null },
    { entity_id: "automation.nursery_door_alert", name: "Nursery Door Alert", state: "off", area: null, last_triggered: null },
  ];

  it("is the panel's name, else Home Assistant's, else the entity id", () => {
    expect(linkName({ entity: "automation.x", name: "Mine" }, auto("on", "Theirs"))).toBe("Mine");
    expect(linkName({ entity: "automation.x", name: "  " }, auto("on", "Theirs"))).toBe("Theirs");
    expect(linkName({ entity: "automation.x" }, auto("on", "Theirs"))).toBe("Theirs");
    expect(linkName({ entity: "automation.x" }, undefined)).toBe("automation.x");
  });

  it("is read only when the backend would have stored it", () => {
    expect(named.automations.map((a) => a.name)).toEqual(["Tent lights back on", undefined, undefined]);
    expect("name" in named.automations[2]).toBe(false);
  });

  it("names the row, the failsafe-off question and the notice", () => {
    const fs = named.automations[0];
    expect(autoRow(fs, haStates[fs.entity], undefined, Date.now()).name).toBe("Tent lights back on");
    expect(offQuestion(fs, haStates[fs.entity])?.title).toBe("Switch off Tent lights back on?");
    expect(failsafeNotice(failsafesOff(named, { ...haStates, [fs.entity]: auto("off", "Failsafe Tent Lights Recovery") }))).toBe(
      "A failsafe is off: Tent lights back on. While it's off, nothing puts that hardware back.",
    );
    expect(autoRow(named.automations[1], haStates["automation.tent_lights_on"], undefined, Date.now()).name).toBe("Tent Lights On");
  });

  it("shows on a ticked row with Home Assistant's name below it, and not on an unticked one", () => {
    const d = openLinks(named, null);
    const row = (e: string) => linkList(d, [named], haList, haStates).rows.find((r) => r.entity === e);
    expect(row("automation.failsafe_tent_lights_recovery")).toMatchObject({ name: "Tent lights back on", haName: "Failsafe Tent Lights Recovery", typed: "Tent lights back on", sub: "Failsafe Tent Lights Recovery. automation.failsafe_tent_lights_recovery" });
    toggleLink(d, "automation.failsafe_tent_lights_recovery");
    expect(row("automation.failsafe_tent_lights_recovery")).toMatchObject({ name: "Failsafe Tent Lights Recovery", typed: "", sub: "automation.failsafe_tent_lights_recovery" });
  });

  it("lists a rename in the review, from the name it went by to the one it will, and back", () => {
    const d = openLinks(named, null);
    setLinkName(d, "automation.tent_lights_on", "  Lights on  ");
    setLinkName(d, "automation.failsafe_tent_lights_recovery", "");
    expect(linkChanges(d, haList, haStates)).toEqual([
      { label: "Name", before: "Tent lights back on", after: "Failsafe Tent Lights Recovery" },
      { label: "Name", before: "Tent Lights On", after: "Lights on" },
    ]);
    toggleLink(d, "automation.nursery_door_alert");
    toggleLink(d, "automation.tent_lights_on");
    expect(linkChanges(d, haList, haStates)).toEqual([
      { label: "Tent Lights On", before: "Control", after: "Not linked" },
      { label: "Nursery Door Alert", before: "Device alerts", after: "Not linked" },
      { label: "Name", before: "Tent lights back on", after: "Failsafe Tent Lights Recovery" },
    ]);
    const fresh = openLinks(named, null);
    toggleLink(fresh, "automation.new_one");
    setLinkName(fresh, "automation.new_one", "New");
    expect(linkChanges(fresh, haList, {})).toContainEqual({ label: "Name", before: "automation.new_one", after: "New" });
  });

  it("holds the save back for a name of only spaces or past 100 characters", () => {
    const d = openLinks(named, null);
    expect(linkIssue(d, haList, haStates)).toBe("");
    setLinkName(d, "automation.tent_lights_on", "   ");
    expect(linkIssue(d, haList, haStates)).toBe("Spaces alone aren't a name. Type one for Tent Lights On, or put Home Assistant's back.");
    setLinkName(d, "automation.tent_lights_on", "x".repeat(101));
    expect(linkIssue(d, haList, haStates)).toBe("The name for Tent Lights On is longer than 100 characters.");
    setLinkName(d, "automation.tent_lights_on", ` ${"x".repeat(100)} `);
    expect(linkIssue(d, haList, haStates)).toBe("");
    toggleLink(d, "automation.tent_lights_on");
    setLinkName(d, "automation.tent_lights_on", "   ");
    expect(linkIssue(d, haList, haStates)).toBe("");
  });

  it("is saved trimmed, and left out when there's none rather than stored empty", () => {
    const had = named.automations;
    expect(linksToSave(had, { "automation.failsafe_tent_lights_recovery": "failsafe", "automation.tent_lights_on": "control", "automation.new": "alert_day" }, { "automation.failsafe_tent_lights_recovery": "", "automation.tent_lights_on": " On ", "automation.new": "Fresh" })).toEqual([
      { id: "a1", entity: "automation.failsafe_tent_lights_recovery", group: "failsafe" },
      { id: "a2", entity: "automation.tent_lights_on", group: "control", name: "On" },
      { id: "a4", entity: "automation.new", group: "alert_day", name: "Fresh" },
    ]);
    const c = copyConfig([{ id: "veg", name: "Veg", automations: had }], []);
    applyLinks(c, "veg", { "automation.failsafe_tent_lights_recovery": "failsafe" }, { "automation.failsafe_tent_lights_recovery": "Tent lights back on" });
    expect(c.zones[0].automations).toEqual([{ id: "a1", entity: "automation.failsafe_tent_lights_recovery", group: "failsafe", name: "Tent lights back on" }]);
  });
});

describe("removing a zone", () => {
  it("says its links go and the automations keep running, or nothing when it links none", () => {
    expect(removeRow(zones[0])).toEqual(["Automations", "5 unlinked. They keep running in Home Assistant"]);
    expect(removeRow({ ...zones[1], automations: [zones[1].automations[0]] })).toEqual(["Automations", "1 unlinked. It keeps running in Home Assistant"]);
    expect(removeRow({ ...zones[1], automations: [] })).toEqual(["Automations", ""]);
  });
});
