import { describe, expect, it } from "vitest";
import {
  KEPT,
  applyLeafConfig,
  boardSends,
  chartLeaf,
  homesOf,
  leafChanges,
  leafIssues,
  openLeaf,
  phrase,
  pickSrc,
  previewText,
  seedRows,
  typeInto,
} from "../../src/frame/calibration";
import type { Catalog } from "../../src/frame/messages";
import { type HaState, type StoredSensor, calcVpd, sensorsOf } from "../../src/frame/readings";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const fresh = new Date(NOW - 10_000).toISOString();
const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: fresh });
const LIMITS = { min: -5, max: 2, step: 0.1, unit_of_measurement: "°C" };

/* Left's board has an offset number and the setup links it; right's board has one nobody has linked; the Zigbee sensor
   has nowhere to hold one. */
const catalog: Catalog = {
  devices: [
    { id: "left", name: "Left", area: null, manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [{ entity_id: "number.left_offset", name: "Left offset", domain: "number", device_class: null, unit: "°C", state: "-1.0", category: "config", area: null, min: -5, max: 2, step: 0.1 }] },
    { id: "right", name: "Right", area: null, manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [
        { entity_id: "number.right_offset", name: "Right offset", domain: "number", device_class: null, unit: "℃", state: "-1.5", category: "config", area: null, min: -5, max: 2, step: 0.1 },
        { entity_id: "number.right_brightness", name: "Brightness", domain: "number", device_class: null, unit: "%", state: "50", category: "config", area: null, min: 0, max: 100, step: 1 },
      ] },
    { id: "zig", name: "Zigbee sensor", area: null, manufacturer: null, model: null, integration: "zha", family: "ZHA", link: "zigbee", path: "local", hub: null, entities: [] },
  ],
  entities: [],
};
const zone = (over: Record<string, unknown> = {}) => ({
  id: "garden",
  sensors: [
    { id: "left", name: "Left", kind: "env", entities: { temperature: "sensor.lt", humidity: "sensor.lh" }, leafEntity: "number.left_offset", avg: true },
    { id: "right", name: "Right", kind: "env", entities: { temperature: "sensor.rt", humidity: "sensor.rh" }, avg: true },
    { id: "zig", name: "Zigbee sensor", kind: "env", entities: { temperature: "sensor.zt", humidity: "sensor.zh" }, avg: false },
    { id: "soil", name: "Probe", kind: "soil", entities: { moisture: "sensor.m" } },
  ],
  ...over,
});
const states: Record<string, HaState> = {
  "number.left_offset": st("-1.0", LIMITS),
  "sensor.lt": st("25"), "sensor.lh": st("60"), "sensor.rt": st("26"), "sensor.rh": st("58"), "sensor.zt": st("24"), "sensor.zh": st("70"),
};
const envs = (z = zone()) => sensorsOf(z).filter((s) => s.kind === "env");
const homesBy = (sensors: StoredSensor[], s = states) => Object.fromEntries(sensors.map((x) => [x.id, homesOf(x, catalog, s)]));

describe("where an offset lives", () => {
  it("offers only numbers in °C on the sensor's own device, either way HA writes Celsius", () => {
    const [left, right, zig] = envs();
    expect(homesOf(left, catalog, states).map((h) => h.entity)).toEqual(["number.left_offset"]);
    expect(homesOf(right, catalog, states).map((h) => h.entity)).toEqual(["number.right_offset"]);
    expect(homesOf(zig, catalog, states)).toEqual([]);
  });

  it("keeps the linked board, asks where a board has one nobody linked, and keeps it here where there's nowhere else", () => {
    const rows = seedRows(zone(), catalog, states);
    expect(rows.left).toEqual(expect.objectContaining({ src: "number.left_offset", mag: 1, dir: -1 }));
    expect(rows.right.src).toBe("");
    expect(rows.zig.src).toBe(KEPT);
    expect(rows.soil).toBeUndefined();
  });

  it("waits for HA's devices before seeding, since they say which boards could hold one", () => {
    const d = openLeaf(zone(), "garden", null, states, false);
    expect([d.seeded, Object.keys(d.rows)]).toEqual([false, []]);
  });

  it("shows what a board holds when it's picked, from its live state once linked and the catalog before", () => {
    const [, right] = envs(), d = openLeaf(zone(), "garden", catalog, states, false);
    pickSrc(d.rows.right, right, "number.right_offset", homesOf(right, catalog, states));
    expect(d.rows.right).toEqual(expect.objectContaining({ mag: 1.5, dir: -1 }));
  });
});

describe("typing an offset", () => {
  it("holds the size in the box and the direction on the buttons, and a typed sign still sets it", () => {
    const r = { src: KEPT, mag: 1, dir: -1 as const, status: "" as const };
    typeInto(r, "0,5");
    expect([r.mag, r.dir]).toEqual([0.5, -1]);
    typeInto(r, "+1.2");
    expect([r.mag, r.dir]).toEqual([1.2, 1]);
    typeInto(r, "-2");
    expect([r.mag, r.dir]).toEqual([2, -1]);
    typeInto(r, "abc");
    expect([r.mag, r.dir]).toEqual([2, -1]);
  });

  it("marks a value past the board's own limits or off its step, and an unanswered source", () => {
    const sensors = envs(), d = openLeaf(zone(), "garden", catalog, states, false);
    d.rows.left = { ...d.rows.left, mag: 5.5, dir: -1 };
    d.rows.zig = { ...d.rows.zig, mag: 0.25, dir: 1 };
    const issues = leafIssues(d, sensors, homesBy(sensors));
    expect(issues.map((i) => [i.id, i.text])).toEqual([
      ["left", "Left can be at most 5 °C below air."],
      ["right", "Say where Right's offset is held."],
      ["zig", "Zigbee sensor goes in steps of 0.1 °C."],
    ]);
  });

  it("says a direction in words", () => {
    expect(phrase(-1.5)).toBe("1.5 °C below air");
    expect(phrase(0.5)).toBe("0.5 °C above air");
    expect(phrase(0)).toBe("Same as air");
  });
});

describe("what applying does", () => {
  it("lists every difference against what's saved and what the boards report, and nothing when nothing changed", () => {
    const sensors = envs(), hb = homesBy(sensors), d = openLeaf(zone(), "garden", catalog, states, false);
    const quiet = leafChanges({ ...d, rows: { ...d.rows, right: { ...d.rows.right, src: KEPT } } }, sensors, hb, "");
    expect(quiet.map((c) => c.kind)).toEqual(["src"]);
    d.rows.left = { ...d.rows.left, mag: 1.5 };
    pickSrc(d.rows.right, sensors[1], "number.right_offset", hb.right);
    d.rows.zig = { ...d.rows.zig, mag: 0.5, dir: -1 };
    d.basis = "right";
    expect(leafChanges(d, sensors, hb, "")).toEqual([
      { label: "Left: leaf temperature offset", before: "1.0 °C below air", after: "1.5 °C below air, on the board", kind: "board" },
      { label: "Right: offset held", before: "Not said yet", after: "On the board, Right offset", kind: "src" },
      { label: "Zigbee sensor: leaf temperature offset", before: "Same as air", after: "0.5 °C below air", kind: "kept" },
      { label: "VPD chart uses", before: "Average", after: "Right", kind: "basis" },
    ]);
  });

  it("stores sources, kept offsets and the chart's choice, and never a board's own value", () => {
    const sensors = envs(), hb = homesBy(sensors), d = openLeaf(zone(), "garden", catalog, states, false);
    d.rows.left = { ...d.rows.left, mag: 1.5 };
    pickSrc(d.rows.right, sensors[1], KEPT, hb.right);
    d.rows.right.mag = 0.8;
    d.rows.zig = { ...d.rows.zig, mag: 0.5, dir: -1 };
    d.basis = "left";
    const c: { zones: Record<string, unknown>[]; devices: Record<string, unknown>[] } = { zones: [zone()], devices: [] };
    applyLeafConfig(c, d, sensors, hb);
    const [left, right, zig] = c.zones[0].sensors as Record<string, unknown>[];
    expect(left).toEqual(expect.objectContaining({ leafEntity: "number.left_offset" }));
    expect("leaf" in left).toBe(false);
    expect(right).toEqual(expect.objectContaining({ leafUnused: true, leaf: -0.8 }));
    expect("leafEntity" in right).toBe(false);
    expect(zig).toEqual(expect.objectContaining({ leaf: -0.5 }));
    expect("leafUnused" in zig).toBe(false);
    expect((c.zones[0] as Record<string, unknown>).leafBasis).toBe("left");
  });

  it("writes only boards that are online and hold something different", () => {
    const sensors = envs(), d = openLeaf(zone(), "garden", catalog, states, false);
    expect(boardSends(d, sensors, homesBy(sensors))).toEqual([]);
    d.rows.left = { ...d.rows.left, mag: 1.5 };
    expect(boardSends(d, sensors, homesBy(sensors)).map((x) => [x.entity, x.value])).toEqual([["number.left_offset", -1.5]]);
    const offline = { ...states, "number.left_offset": st("unavailable", LIMITS) };
    expect(boardSends(d, sensors, homesBy(sensors, offline))).toEqual([]);
    expect(leafChanges(d, sensors, homesBy(sensors, offline), "")).toEqual([]);
  });

  it("falls back to Average for a chart sensor no longer counted, without calling it a change", () => {
    const sensors = envs(), d = openLeaf(zone({ leafBasis: "zig" }), "garden", catalog, states, false);
    expect(leafChanges({ ...d, rows: { ...d.rows, right: { ...d.rows.right, src: KEPT } } }, sensors, homesBy(sensors), "zig").map((c) => c.kind)).toEqual(["src"]);
    expect(chartLeaf(d, sensors)).toBeCloseTo(-0.5, 9);
  });
});

describe("previews", () => {
  it("shows a sensor's air, leaf and VPD at the typed offset", () => {
    const [left, , zig] = envs();
    expect(previewText(left, -1.5, states, NOW)).toBe(`Air 25.0 °C, leaf 23.5 °C, VPD ${calcVpd(25, 60, -1.5).toFixed(2)} kPa.`);
    expect(previewText(zig, 0, states, NOW)).toContain("Not counted in the zone reading.");
    expect(previewText(left, 0, { ...states, "sensor.lt": st("unavailable") }, NOW)).toBe("No data from this sensor right now.");
  });
});
