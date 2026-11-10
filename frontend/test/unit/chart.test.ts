import { describe, expect, it } from "vitest";
import { combinedLine, endingNow, entitiesFor, extremes, keptNote, nightRuns, sensorLine, yRange } from "../../src/frame/chart";
import type { History } from "../../src/frame/messages";
import { type StoredSensor, calcVpd, combine, zoneReading } from "../../src/frame/readings";

const board = (id: string, entities: Record<string, string>, over: Partial<StoredSensor> = {}): StoredSensor => ({ id, name: id, kind: "env", entities, avg: true, ...over });
/* Six 10 minute buckets ending at a fixed time. */
const END = Date.parse("2026-11-10T12:00:00Z") / 1000;
const hist = (series: History["series"]): History => ({ start: END - 3600, end: END, step: 600, series });

describe("a sensor's line", () => {
  it("asks for its own entity, or temperature and humidity for a VPD it doesn't report", () => {
    expect(entitiesFor(board("a", { temperature: "sensor.t", vpd: "sensor.v" }), "vpd")).toEqual(["sensor.v"]);
    expect(entitiesFor(board("a", { temperature: "sensor.t", humidity: "sensor.h" }), "vpd")).toEqual(["sensor.t", "sensor.h"]);
    expect(entitiesFor(board("a", { temperature: "sensor.t" }), "light")).toEqual([]);
  });

  it("draws each bucket's mean, keeps its spread, and leaves a gap where there was no live reading", () => {
    const h = hist({ "sensor.t": { first: END - 3600, values: [[20, 19, 21], null, [22, 22, 22], [23, 23, 23], [24, 24, 24], [25, 25, 25]] } });
    const line = sensorLine(board("a", { temperature: "sensor.t" }), "temperature", h, {});
    expect(line?.map((p) => p.v)).toEqual([20, null, 22, 23, 24, 25]);
    expect(line?.[0]).toEqual({ t: END - 3300, v: 20, lo: 19, hi: 21 });
  });

  it("works VPD out from temperature and humidity at the sensor's offset when it has no VPD of its own", () => {
    const h = hist({
      "sensor.t": { first: null, values: [[25, 25, 25], null, null, null, null, null] },
      "sensor.h": { first: null, values: [[60, 60, 60], [60, 60, 60], null, null, null, null] },
    });
    const line = sensorLine(board("a", { temperature: "sensor.t", humidity: "sensor.h" }, { leaf: -1 }), "vpd", h, {});
    expect(line?.[0].v).toBeCloseTo(calcVpd(25, 60, -1), 9);
    expect(line?.[1].v).toBeNull();
  });

  it("ends on the live reading, and on a gap when the sensor is dead or stale", () => {
    const line = [{ t: 1, v: 20, lo: 19, hi: 21 }, { t: 2, v: 21, lo: 20, hi: 22 }];
    expect(endingNow(line, 24.5).at(-1)).toEqual({ t: 2, v: 24.5, lo: 24.5, hi: 24.5 });
    expect(endingNow(line, null).at(-1)?.v).toBeNull();
  });
});

describe("the combined line", () => {
  const a = [{ t: 1, v: 20, lo: 19, hi: 21 }, { t: 2, v: 22, lo: 22, hi: 22 }, { t: 3, v: null, lo: null, hi: null }];
  const b = [{ t: 1, v: 24, lo: 23, hi: 25 }, { t: 2, v: null, lo: null, hi: null }, { t: 3, v: null, lo: null, hi: null }];
  const c = [{ t: 1, v: 40, lo: 40, hi: 40 }, { t: 2, v: 40, lo: 40, hi: 40 }, { t: 3, v: 40, lo: 40, hi: 40 }];

  it("combines counted sensors bucket by bucket, leaving out a dead one, and skips those not counted", () => {
    const m = combinedLine([a, b, c], [true, true, false], "mean");
    expect(m.map((p) => p.v)).toEqual([22, 22, null]);
    expect(m[0]).toEqual({ t: 1, v: 22, lo: 21, hi: 23 });
  });

  it("ends on the same value as the zone's tile, for every method", () => {
    for (const method of ["mean", "median", "highest", "lowest"] as const) {
      const lines = [endingNow(a, 24), endingNow(b, 26), endingNow(c, 21)];
      const tile = zoneReading(
        [24, 26, 21].map((v, i) => ({ id: String(i), name: String(i), counted: true, health: "ok" as const, values: { temperature: v }, at: null })),
        "temperature",
        method,
      ).value;
      expect(combinedLine(lines, [true, true, true], method).at(-1)?.v).toBe(tile);
      expect(tile).toBe(combine(method, [24, 26, 21]));
    }
  });
});

describe("reading a range", () => {
  it("takes Min and Max from each bucket's own low and high, with when", () => {
    const line = [{ t: 1, v: 20, lo: 18, hi: 21 }, { t: 2, v: null, lo: null, hi: null }, { t: 3, v: 22, lo: 21.5, hi: 30 }];
    expect(extremes(line)).toEqual({ min: { v: 18, t: 1 }, max: { v: 30, t: 3 } });
    expect(extremes([{ t: 1, v: null, lo: null, hi: null }])).toEqual({ min: null, max: null });
  });

  it("pads the y range, includes the zone's limits, and keeps light at 0 or above", () => {
    const [lo, hi] = yRange([[{ t: 1, v: 20, lo: 20, hi: 20 }, { t: 2, v: 30, lo: 30, hi: 30 }]], "temperature", [16, 32]);
    expect(lo).toBeLessThan(16);
    expect(hi).toBeGreaterThan(32);
    expect(yRange([[{ t: 1, v: 0, lo: 0, hi: 0 }, { t: 2, v: 40000, lo: 40000, hi: 40000 }]], "light", [])[0]).toBe(0);
  });

  it("shades after lights off, also when the photoperiod crosses midnight", () => {
    const local = (h: number) => new Date(2026, 10, 10, h, 30).getTime() / 1000;
    const pts = [1, 5, 9, 13, 17, 21].map((h) => ({ t: local(h), v: 1, lo: 1, hi: 1 }));
    expect(nightRuns(pts, 7 * 60, 19 * 60)).toEqual([[0, 1], [5, 5]]);
    expect(nightRuns(pts, 16 * 60, 10 * 60)).toEqual([[3, 3]]);
  });

  it("says when Home Assistant keeps less than the range asked for", () => {
    expect(keptNote(hist({ "sensor.t": { first: END - 3600, values: [] } }), 1)).toBe("");
    expect(keptNote(hist({ "sensor.t": { first: END - 1800, values: [] } }), 1)).toMatch(/^Home Assistant has kept under an hour of these readings, back to /);
    expect(keptNote(hist({ "sensor.t": { first: null, values: [] } }), 1)).toBe("Home Assistant has no recorded readings for this range.");
  });
});
