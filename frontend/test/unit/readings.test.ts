import { describe, expect, it } from "vitest";
import { type HaState, type StoredSensor, ago, calcVpd, combine, healthOf, isDay, leafOf, numberOf, readSensor, zoneReading } from "../../src/frame/readings";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const fresh = new Date(NOW - 10_000).toISOString();
const old = new Date(NOW - 20 * 60_000).toISOString();
const st = (state: string, at: string | null = fresh): HaState => ({ state, attributes: {}, at });

const board = (over: Partial<StoredSensor> = {}): StoredSensor => ({
  id: "b1",
  name: "Left",
  kind: "env",
  entities: { temperature: "sensor.t", humidity: "sensor.h", light: "sensor.l" },
  avg: true,
  ...over,
});

describe("a reading is a number or no data", () => {
  it("never turns unknown, unavailable, empty or text into a number", () => {
    for (const s of ["unknown", "unavailable", "", "on"]) expect(numberOf(st(s))).toBeNull();
    expect(numberOf(st("24.1"))).toBe(24.1);
    expect(numberOf(undefined)).toBeNull();
  });

  it("calls a reading that hasn't updated for ten minutes stale", () => {
    expect(healthOf(st("24", fresh), NOW)).toBe("ok");
    expect(healthOf(st("24", old), NOW)).toBe("stale");
    expect(healthOf(st("unavailable"), NOW)).toBe("dead");
  });
});

describe("one sensor", () => {
  it("works out VPD from its temperature, humidity and offset when it has no VPD entity", () => {
    const states = { "sensor.t": st("25"), "sensor.h": st("60"), "sensor.l": st("41200") };
    const r = readSensor(board({ leaf: -1 }), states, NOW);
    expect(r.health).toBe("ok");
    expect(r.values.vpd).toBeCloseTo(calcVpd(25, 60, -1), 6);
    expect(r.values.light).toBe(41200);
  });

  it("takes its board's VPD and offset where it has them", () => {
    const states = { "sensor.t": st("25"), "sensor.h": st("60"), "sensor.v": st("1.11"), "number.o": st("-1.5") };
    const s = board({ entities: { temperature: "sensor.t", humidity: "sensor.h", vpd: "sensor.v" }, leafEntity: "number.o", leaf: 0.5 });
    expect(readSensor(s, states, NOW).values.vpd).toBe(1.11);
    expect(leafOf(s, states)).toBe(-1.5);
    expect(leafOf({ ...s, leafUnused: true }, states)).toBe(0.5);
    expect(leafOf(board(), states)).toBe(0);
  });

  it("is dead when its temperature or humidity is, and then gives no VPD either", () => {
    const states = { "sensor.t": st("unavailable"), "sensor.h": st("60") };
    const r = readSensor(board(), states, NOW);
    expect([r.health, r.values.temperature, r.values.humidity, r.values.vpd]).toEqual(["dead", null, 60, null]);
  });

  it("is stale when a reading stopped updating, and a stale reading counts for nothing", () => {
    const states = { "sensor.t": st("25", old), "sensor.h": st("60") };
    const r = readSensor(board(), states, NOW);
    expect([r.health, r.values.temperature, r.values.vpd]).toEqual(["stale", null, null]);
  });
});

describe("a zone", () => {
  it("combines its counted live sensors by its method, naming the dead and the left out", () => {
    const a = { id: "a", name: "A", counted: true, health: "ok" as const, values: { temperature: 24 }, at: fresh };
    const b = { id: "b", name: "B", counted: true, health: "ok" as const, values: { temperature: 26 }, at: fresh };
    const c = { id: "c", name: "C", counted: true, health: "dead" as const, values: { temperature: null }, at: fresh };
    const d = { id: "d", name: "D", counted: false, health: "ok" as const, values: { temperature: 30 }, at: fresh };
    const z = zoneReading([a, b, c, d], "temperature", "mean");
    expect(z.value).toBe(25);
    expect([z.used.map((s) => s.id), z.missing.map((s) => s.id), z.notCounted.map((s) => s.id)]).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(zoneReading([c], "temperature", "mean").value).toBeNull();
  });

  it("combines by average, median, highest or lowest", () => {
    expect(combine("mean", [1, 2, 6])).toBe(3);
    expect(combine("median", [1, 2, 6])).toBe(2);
    expect(combine("median", [1, 2, 4, 6])).toBe(3);
    expect(combine("highest", [1, 2, 6])).toBe(6);
    expect(combine("lowest", [1, 2, 6])).toBe(1);
    expect(combine("mean", [])).toBeNull();
  });
});

describe("time", () => {
  it("tells day from night when the photoperiod crosses midnight, and when it doesn't", () => {
    expect(isDay(7 * 60, 19 * 60, 12 * 60)).toBe(true);
    expect(isDay(7 * 60, 19 * 60, 20 * 60)).toBe(false);
    expect(isDay(16 * 60, 10 * 60, 2 * 60)).toBe(true);
    expect(isDay(16 * 60, 10 * 60, 12 * 60)).toBe(false);
  });

  it("says how long ago in words", () => {
    expect(ago(fresh, NOW)).toBe("reported 10 seconds ago");
    expect(ago(old, NOW)).toBe("reported 20 minutes ago");
    expect(ago(null, NOW)).toBe("never reported");
  });
});
