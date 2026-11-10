import { describe, expect, it } from "vitest";
import type { Catalog } from "../../src/frame/messages";
import { type HaState, calcVpd } from "../../src/frame/readings";
import {
  type TargetsDraft,
  applyStage,
  applyTargetsConfig,
  followLeaf,
  hasTarget,
  idealCount,
  limitHelpers,
  liveBands,
  moveOnChart,
  nudge,
  openTargets,
  pickLink,
  setSource,
  setTarget,
  storedBands,
  targetChanges,
  targetIssues,
  targetSends,
  typeBox,
  vGeom,
  withLiveLimits,
  zoneLeaf,
} from "../../src/frame/targets";

const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: null });
const num = (entity_id: string, state: string, unit: string, min = 0, max = 100, step = 0.1) => ({ entity_id, name: entity_id.split(".")[1], domain: "input_number", device_class: null, unit, state, category: null, area: null, integration: "input_number", family: "Helper", min, max, step });
const catalog: Catalog = {
  devices: [],
  entities: [
    num("input_number.garden_day_temperature_min_threshold", "23", "°C", -20, 50),
    num("input_number.garden_day_temperature_max_threshold", "28", "℃", -20, 50),
    num("input_number.garden_day_temperature_target", "25", "°C", -20, 50),
    num("input_number.day_lights_garden_min_threshold", "2000", "lx", 0, 10000, 10),
    num("input_number.spare_humidity", "40", "%"),
    num("input_number.reservoir_target_ec", "1.8", "mS/cm", 0, 5),
  ],
};
const MIN = "input_number.garden_day_temperature_min_threshold", MAX = "input_number.garden_day_temperature_max_threshold", TGT = "input_number.garden_day_temperature_target";
const bands = () => ({
  day: { temperature: [23, 24, 25, 27, 28], humidity: [55, 60, 64, 67, 70], vpd: [0.8, 0.95, 1.1, 1.2, 1.3] },
  night: { temperature: [16, 20, 23, 25, 26], humidity: [55, 58, 62, 65, 68], vpd: [0.7, 0.85, 1.0, 1.1, 1.2] },
});
const garden = (over: Record<string, unknown> = {}) => ({
  id: "garden",
  name: "Garden",
  bands: bands(),
  lightLimits: { dayMin: 2000, nightMax: 200 },
  helpers: { bands: { day: { temperature: { min: MIN, target: TGT, max: MAX } } }, light: { dayMin: "input_number.day_lights_garden_min_threshold" } },
  ...over,
});
const here = (over: Record<string, unknown> = {}) => garden({ helpers: {}, ...over });
const states: Record<string, HaState> = {
  [MIN]: st("22.5", { min: -20, max: 50, step: 0.1, unit_of_measurement: "°C" }),
  [MAX]: st("28", { min: -20, max: 50, step: 0.1, unit_of_measurement: "℃" }),
  [TGT]: st("25", { min: -20, max: 50, step: 0.1, unit_of_measurement: "°C" }),
  "input_number.day_lights_garden_min_threshold": st("2000", { min: 0, max: 10000, step: 10, unit_of_measurement: "lx" }),
};
const LEAF = -0.8;
const open = (z: Record<string, unknown> = garden(), s = states): TargetsDraft => openTargets(z, "garden", s, catalog, "day");

describe("a zone's limits", () => {
  it("reads a linked limit from its helper, live, and the rest as stored, so every screen judges by the same number", () => {
    expect(liveBands(garden(), states).day.temperature).toEqual([22.5, 24, 25, 27, 28]);
    expect(liveBands(garden(), states).day.light).toBe(2000);
    expect((withLiveLimits(garden(), states)?.bands as ReturnType<typeof bands>).day.temperature[0]).toBe(22.5);
    expect(liveBands(here(), states).day.temperature[0]).toBe(23);
  });

  it("falls back to the last known value when a helper has no number to give", () => {
    expect(liveBands(garden(), { ...states, [MIN]: st("unavailable") }).day.temperature[0]).toBe(23);
  });

  it("reads anything that isn't five numbers as 0s, and a missing target as none", () => {
    expect(storedBands({ id: "z" }).day.temperature).toEqual([0, 0, 0, 0, 0]);
    expect(storedBands({ bands: { day: { temperature: [20, 22, null, 26, 28] } } }).day.temperature).toEqual([20, 22, null, 26, 28]);
  });

  it("draws the chart at the picked sensor's offset, or the counted sensors' average", () => {
    const z = { sensors: [{ id: "a", kind: "env", leaf: -1 }, { id: "b", kind: "env", leaf: -0.6 }, { id: "c", kind: "env", leaf: 2, avg: false }] };
    expect(zoneLeaf(z, {})).toBe(-0.8);
    expect(zoneLeaf({ ...z, leafBasis: "b" }, {})).toBe(-0.6);
    expect(zoneLeaf({ ...z, leafBasis: "c" }, {})).toBe(-0.8);
    expect(zoneLeaf({}, {})).toBe(0);
  });
});

describe("the draft", () => {
  it("opens on the zone's helpers where it links any, showing what they hold", () => {
    const d = open();
    expect([d.source, d.links["bands.day.temperature.min"], d.bands.day.temperature[0], d.edit]).toEqual(["helpers", MIN, 22.5, "target"]);
    expect(open(here()).source).toBe("here");
  });

  it("shows what a newly picked helper holds, and keeps the number when a limit comes back here", () => {
    const d = open(here());
    setSource(d, "helpers", states, catalog);
    pickLink(d, "bands.day.temperature.min", MIN, states, catalog);
    expect(d.bands.day.temperature[0]).toBe(22.5);
    pickLink(d, "bands.day.temperature.min", "", states, catalog);
    expect(d.bands.day.temperature[0]).toBe(22.5);
  });

  it("has one target choice for the whole zone, starting midway between Low and High", () => {
    const d = open();
    setTarget(d, false);
    expect([hasTarget(d.bands), d.bands.day.temperature[2], d.bands.night.vpd[2], d.edit]).toEqual([false, null, null, "temperature"]);
    setTarget(d, true);
    expect([d.bands.day.temperature[2], d.bands.day.humidity[2], d.bands.night.vpd[2]]).toEqual([25.5, 64, 1]);
  });

  it("fills the period on show from an Athena stage, Min and Max a margin outside, leaving light and the other period", () => {
    const d = open(here());
    applyStage(d, "veg");
    expect(d.bands.day.temperature).toEqual([20.2, 22.2, 24.95, 27.7, 29.7]);
    expect(d.bands.day.vpd).toEqual([0.65, 0.8, 0.9, 1, 1.15]);
    expect([d.bands.day.light, d.bands.night.temperature[1], d.stage]).toEqual([2000, 20, "veg"]);
  });

  it("keeps a typed value as typed, and moves the target as one point", () => {
    const d = open(here());
    expect(typeBox(d, "temperature", 1, "22,2", LEAF)).toBe("");
    expect(d.bands.day.temperature[1]).toBe(22.2);
    typeBox(d, "temperature", 2, "26", LEAF);
    expect(d.bands.day.vpd[2]).toBe(Math.round(calcVpd(26, 64, LEAF) * 100) / 100);
    expect(typeBox(d, "vpd", 2, "1.0", LEAF)).toMatch(/^Humidity Target moved to [\d.]+% to give that VPD at 26°\.$/);
    expect(calcVpd(26, d.bands.day.humidity[2] as number, LEAF)).toBeCloseTo(1.0, 1);
    typeBox(d, "temperature", 0, "", LEAF);
    expect(d.bands.day.temperature[0]).toBe(23);
  });

  it("drags a line no further than its neighbours, picks the nearest on a press, and nudges by its step", () => {
    const d = open(here()), g = vGeom();
    d.edit = "temperature";
    moveOnChart(d, LEAF, g.X(28.2), g.Y(60), true);
    expect(d.sel).toBe(4);
    moveOnChart(d, LEAF, g.X(20), g.Y(60), false);
    expect(d.bands.day.temperature[4]).toBe(27);
    nudge(d, 1);
    expect(d.bands.day.temperature[4]).toBe(27.5);
    d.edit = "target";
    moveOnChart(d, LEAF, g.X(40), g.Y(10), true);
    expect([d.bands.day.temperature[2], d.bands.day.humidity[2]]).toEqual([27, 60]);
  });

  it("with no target, Low and High stop at each other", () => {
    const d = open(here());
    setTarget(d, false);
    d.edit = "humidity";
    d.sel = 3;
    nudge(d, -20);
    expect(d.bands.day.humidity[3]).toBe(60);
  });
});

describe("problems", () => {
  const texts = (d: TargetsDraft, s = states, leaf = LEAF) => targetIssues(d, s, catalog, leaf).map((i) => i.text);

  it("has none for a sound zone", () => {
    expect(texts(open())).toEqual([]);
  });

  it("holds every value to its range and the order Min, Low, Target, High, Max, in both periods", () => {
    const d = open(here());
    d.bands.day.temperature[0] = 24.5;
    d.bands.day.humidity[4] = 120;
    d.bands.night.vpd[3] = 0.5;
    expect(texts(d)).toEqual(["Temperature Low can't be below Min. They run Min, Low, Target, High, Max.", "Humidity Max has to be between 0 and 100%.", "Night has a value to fix."]);
    expect(targetIssues(d, states, catalog, LEAF)[0]).toEqual(expect.objectContaining({ target: "vin-temperature-1", edit: "temperature", slot: 1 }));
  });

  it("won't take a new zone's 0s", () => {
    const d = open({ id: "garden", bands: { day: {}, night: {} } });
    expect(texts(d)[0]).toBe("Temperature Max has to be above Min.");
  });

  it("holds a value going to a helper to the helper's own limits and step, and a light limit kept here to 10 lx steps", () => {
    const d = open();
    d.bands.day.temperature[0] = 22.55;
    expect(texts(d)).toEqual(["Temperature Min goes to your helper, which takes -20 to 50 in steps of 0.1."]);
    const h = open(here());
    h.bands.day.light = 2005;
    expect(texts(h)).toEqual(["Light limit goes in steps of 10 lx."]);
  });

  it("says when no conditions fit the ideal zone at this offset, as Athena's flower finish at 1 °C below air", () => {
    const d = open(here());
    applyStage(d, "finish");
    expect(idealCount(d.bands.day, -1)).toBe(0);
    expect(idealCount(d.bands.day, 0)).toBeGreaterThan(0);
    expect(targetIssues(d, states, catalog, -1)[0]).toEqual({ text: "No conditions fit all of your ideal zone at this leaf temperature offset. Change the offset or widen a limit.", calibrate: true });
    expect(texts(d, states, 0)).toEqual([]);
  });

  it("asks for at least one helper, in the limit's own unit, used once", () => {
    const d = open(here());
    setSource(d, "helpers", states, catalog);
    expect(texts(d)[0]).toBe("Link at least one limit to a helper, or choose Set here.");
    pickLink(d, "bands.day.temperature.min", "input_number.spare_humidity", states, catalog);
    pickLink(d, "bands.day.temperature.max", "input_number.spare_humidity", states, catalog);
    expect(texts(d).slice(0, 2)).toEqual([
      "Day temperature Min: input_number.spare_humidity is in %, not °C.",
      "Day temperature Max: input_number.spare_humidity is in %, not °C.",
    ]);
    expect(texts(d)[2]).toContain("is linked to both Day temperature Min and Day temperature Max");
  });
});

describe("what applying does", () => {
  it("lists nothing for an untouched zone, and marks what lands on a helper", () => {
    const d = open();
    expect(targetChanges(d, garden(), states, catalog)).toEqual([]);
    d.bands.day.temperature[0] = 22;
    d.bands.day.temperature[1] = 24.5;
    d.bands.day.light = 2500;
    expect(targetChanges(d, garden(), states, catalog)).toEqual([
      { label: "Day Temperature Min, on your helper", before: "22.5°", after: "22°", kind: "helper" },
      { label: "Day Temperature Low", before: "24°", after: "24.5°", kind: "here" },
      { label: "Day Light Min, on your helper", before: "2,000 lx", after: "2,500 lx", kind: "helper" },
    ]);
    expect(targetSends(d, states, catalog).map((s) => [s.name, s.value, s.entity])).toEqual([
      ["bands.day.temperature.min", 22, MIN],
      ["light.dayMin", 2500, "input_number.day_lights_garden_min_threshold"],
    ]);
  });

  it("with no target, drops the target helper's link without writing to it", () => {
    const d = open();
    setTarget(d, false);
    expect(targetSends(d, states, catalog)).toEqual([]);
    const c = { zones: [garden() as Record<string, unknown>], devices: [] };
    applyTargetsConfig(c, d);
    const z = c.zones[0] as { helpers: { bands: { day: { temperature: Record<string, string> } } }; bands: ReturnType<typeof bands> };
    expect(z.helpers.bands.day.temperature).toEqual({ min: MIN, max: MAX });
    expect(z.bands.day.temperature[2]).toBeNull();
    expect(targetChanges(d, garden(), states, catalog).find((x) => x.label === "Day Temperature Target")).toEqual({ label: "Day Temperature Target", before: "25°", after: "None", kind: "here" });
  });

  it("set here stores every value and no links; a newly linked helper is a source change with nothing to send", () => {
    const d = open();
    setSource(d, "here", states, catalog);
    const c = { zones: [garden() as Record<string, unknown>], devices: [] };
    applyTargetsConfig(c, d);
    expect([c.zones[0].linked, c.zones[0].helpers, (c.zones[0].bands as ReturnType<typeof bands>).day.temperature[0]]).toEqual([false, {}, 22.5]);
    expect(targetSends(d, states, catalog)).toEqual([]);
    const n = open(here());
    setSource(n, "helpers", states, catalog);
    pickLink(n, "bands.day.temperature.min", MIN, states, catalog);
    expect(targetChanges(n, here(), states, catalog).map((x) => [x.label, x.kind])).toEqual([
      ["Limits", "src"],
      ["Day temperature Min helper", "src"],
    ]);
    expect(targetSends(n, states, catalog)).toEqual([]);
  });

  it("moves the target with a new leaf offset, to the nearest place inside every ideal range", () => {
    const d = open(here());
    expect(followLeaf(d, LEAF)).toBe(false);
    d.bands.day.vpd = [0.8, 1.1, 1.15, 1.2, 1.3];
    expect(followLeaf(d, -3)).toBe(false);
    const moved = followLeaf(d, -1.5), b = d.bands.day;
    expect(moved).toBe(true);
    const v = calcVpd(b.temperature[2] as number, b.humidity[2] as number, -1.5);
    expect(v).toBeGreaterThanOrEqual(1.075);
    expect(v).toBeLessThanOrEqual(1.225);
  });
});

describe("helpers offered for a limit", () => {
  it("puts the ones in the limit's unit first, the likeliest name at the top", () => {
    const list = limitHelpers("bands.day.temperature.min", ["garden"], catalog);
    expect(list[0].entity).toBe(MIN);
    expect(list.filter((x) => x.fits).map((x) => x.entity).sort()).toEqual([MAX, MIN, TGT].sort());
    expect(limitHelpers("light.dayMin", ["garden"], catalog)[0].entity).toBe("input_number.day_lights_garden_min_threshold");
  });
});
