import { describe, expect, it } from "vitest";
import type { Catalog } from "../../src/frame/messages";
import type { HaState } from "../../src/frame/readings";
import {
  applySchedConfig,
  emersonLine,
  helperSends,
  openSched,
  periodModeOf,
  periodOf,
  reports,
  reseed,
  schedChanges,
  schedIssues,
  sharing,
  timeHelpers,
  timesOf,
} from "../../src/frame/schedule";

const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: null });
const helper = (entity_id: string, domain: string, state: string, more: Record<string, unknown> = {}) => ({ entity_id, name: entity_id.split(".")[1], domain, device_class: null, unit: null, state, category: null, area: null, integration: domain, family: "Helper", ...more });
const catalog: Catalog = {
  devices: [{ id: "d", name: "Tent plug", area: null, manufacturer: null, model: null, integration: "tuya_local", family: "Tuya", link: "wifi", path: "local", hub: null,
    entities: [{ entity_id: "switch.tent_lights", name: "Tent lights", domain: "switch", device_class: null, unit: null, state: "on", category: null, area: null }] }],
  entities: [
    helper("input_datetime.garden_on", "input_datetime", "07:00:00", { has_date: false, has_time: true }),
    helper("input_datetime.garden_off", "input_datetime", "19:00:00", { has_date: false, has_time: true }),
    helper("input_datetime.other_on", "input_datetime", "06:30:00", { has_date: false, has_time: true }),
    helper("input_datetime.last_refill", "input_datetime", "2026-11-03 09:12:00", { has_date: true, has_time: true }),
    helper("input_number.morning", "input_number", "5", { min: 0, max: 59, step: 1, unit: "min" }),
    helper("input_number.daylight", "input_number", "10", { min: 0, max: 59, step: 1, unit: "min" }),
    helper("input_number.evening", "input_number", "5", { min: 0, max: 59, step: 1, unit: "min" }),
  ],
};
const garden = () => ({
  id: "garden",
  helpers: { day: "input_datetime.garden_on", night: "input_datetime.garden_off", morning: "input_number.morning", daylight: "input_number.daylight", evening: "input_number.evening" },
  dayAt: 420,
  nightAt: 1140,
});
const states: Record<string, HaState> = {
  "input_datetime.garden_on": st("07:00:00"),
  "input_datetime.garden_off": st("19:00:00"),
  "input_number.morning": st("5", { min: 0, max: 59, step: 1 }),
  "input_number.daylight": st("10", { min: 0, max: 59, step: 1 }),
  "input_number.evening": st("5", { min: 0, max: 59, step: 1 }),
};

describe("where a zone's times come from", () => {
  it("reads helpers when a zone links them, and times set here otherwise", () => {
    expect(periodModeOf(garden())).toBe("helper");
    expect(periodModeOf({ id: "new", periodMode: "fixed", dayAt: 0, nightAt: 0 })).toBe("fixed");
    const d = openSched(garden(), "garden", catalog, states, false);
    expect([d.period, d.day, d.night, d.em, d.emerson]).toEqual(["helper", "07:00", "19:00", "helper", { morning: 5, daylight: 10, evening: 5 }]);
  });

  it("offers only time-only date and time helpers for lights on and off", () => {
    expect(timeHelpers(catalog).map((e) => e.entity_id)).toEqual(["input_datetime.garden_on", "input_datetime.garden_off", "input_datetime.other_on"]);
  });

  it("shows what a newly picked helper holds, from HA's list before it's linked", () => {
    const d = openSched(garden(), "garden", catalog, states, false);
    d.onHelper = "input_datetime.other_on";
    reseed(d, garden(), states, catalog, "period");
    expect(d.day).toBe("06:30");
  });
});

describe("the draft", () => {
  it("asks for both helpers, two different times, and limits the extensions to whole minutes under an hour", () => {
    const d = openSched({ id: "z", periodMode: "fixed", dayAt: 0, nightAt: 0, emersonMode: "fixed", emerson: { morning: 0, daylight: 75, evening: 2.5 } }, "z", catalog, {}, false);
    expect(schedIssues(d, {}, catalog).map((i) => i.text)).toEqual([
      "Lights on and lights off need two different times.",
      "Daylight time has to be between 0 and 59 minutes.",
      "Evening extension goes in steps of 1 minutes.",
    ]);
    d.period = "helper";
    expect(schedIssues(d, {}, catalog).slice(0, 2).map((i) => i.target)).toEqual(["sh-on", "sh-off"]);
    d.period = "detected";
    expect(schedIssues(d, {}, catalog)[0].text).toBe("Pick at least one light for day and night to follow.");
  });

  it("lists sources and values against what's saved and what the helpers report, marking what lands on a helper", () => {
    const d = openSched(garden(), "garden", catalog, states, false);
    expect(schedChanges(d, garden(), states, catalog)).toEqual([]);
    d.day = "06:00";
    d.emerson.daylight = 15;
    expect(schedChanges(d, garden(), states, catalog)).toEqual([
      { label: "Lights on", before: "07:00", after: "06:00, on your helper", kind: "helper" },
      { label: "Daylight time", before: "10 min", after: "15 min, on your helper", kind: "helper" },
    ]);
    expect(helperSends(d, garden(), states, catalog)).toEqual([
      { name: "day", value: "06:00", entity: "input_datetime.garden_on" },
      { name: "daylight", value: 15, entity: "input_number.daylight" },
    ]);
  });

  it("stores the source, only the links in use and values kept here, and writes nothing a helper holds itself", () => {
    const d = openSched(garden(), "garden", catalog, states, false);
    d.period = "fixed";
    d.day = "08:00";
    d.night = "20:30";
    d.em = "none";
    const c = { zones: [garden() as Record<string, unknown>], devices: [] };
    applySchedConfig(c, d);
    const z = c.zones[0];
    expect([z.periodMode, z.dayAt, z.nightAt, z.emersonMode, "emerson" in z]).toEqual(["fixed", 480, 1230, "none", false]);
    expect(z.helpers).toEqual({});
    expect(helperSends(d, garden(), states, catalog)).toEqual([]);
  });

  it("counts a helper's value only once HA reports it: a time to the minute, a number exactly", () => {
    expect(reports("input_datetime.garden_on", "07:00", states)).toBe(true);
    expect(reports("input_datetime.garden_on", "06:00", states)).toBe(false);
    expect(reports("input_number.daylight", 10, states)).toBe(true);
    expect(reports("input_number.daylight", 15, states)).toBe(false);
  });
});

describe("day or night now", () => {
  it("takes the helpers' live times, crossing midnight too, and falls back to what's stored", () => {
    expect(timesOf(garden(), states)).toEqual({ dayAt: 420, nightAt: 1140 });
    expect(periodOf(garden(), states, 12 * 60)).toBe("day");
    const veg = { ...garden(), helpers: { day: "input_datetime.v_on", night: "input_datetime.v_off" } };
    const vegStates = { "input_datetime.v_on": st("16:00:00"), "input_datetime.v_off": st("10:00:00") };
    expect([periodOf(veg, vegStates, 2 * 60), periodOf(veg, vegStates, 12 * 60)]).toEqual(["day", "night"]);
    expect(timesOf(veg, {})).toEqual({ dayAt: 420, nightAt: 1140 });
  });

  it("follows the zone's switches by its rule, and doesn't guess when none of them reports", () => {
    const z = { id: "z", periodMode: "detected", lights: ["switch.a", "switch.b"], rule: "any" };
    const s = { "switch.a": st("on"), "switch.b": st("off") };
    expect(periodOf(z, s, 0)).toBe("day");
    expect(periodOf({ ...z, rule: "all" }, s, 0)).toBe("night");
    expect(periodOf(z, { "switch.a": st("unavailable") }, 0)).toBeNull();
    expect(timesOf(z, s)).toBeNull();
  });

  it("works the red light windows out by the failsafe's own sum", () => {
    expect(emersonLine("07:00", "19:00", { morning: 5, daylight: 10, evening: 5 })).toBe("Red lights 06:55 - 07:10 and 18:50 - 19:05");
    expect(emersonLine("00:02", "16:00", { morning: 5, daylight: 0, evening: 0 })).toBe("Red lights 23:57 - 00:02 and 16:00 - 16:00");
  });

  it("names the other zones sharing a zone's lights on helper", () => {
    const zones = [garden(), { id: "veg", helpers: { day: "input_datetime.v_on", night: "input_datetime.v_off" } }, { id: "nursery", helpers: { day: "input_datetime.v_on", night: "input_datetime.v_off" } }];
    expect(sharing(zones, "veg").map((z) => z.id)).toEqual(["nursery"]);
    expect(sharing(zones, "garden")).toEqual([]);
  });
});
