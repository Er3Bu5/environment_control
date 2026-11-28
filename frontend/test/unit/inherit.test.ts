import { describe, expect, it } from "vitest";
import { effectiveZone, takesOf } from "../../src/frame/inherit";
import { bandState, bandsOf } from "../../src/frame/readings";
import { periodOf, timesOf } from "../../src/frame/schedule";
import { withLiveLimits } from "../../src/frame/targets";

const five = (lo: number, hi: number) => [lo - 2, lo, null, hi, hi + 2];
const bands = (lo: number, hi: number) => ({ day: { temperature: five(lo, hi), humidity: five(50, 60), vpd: five(1, 1.2) }, night: { temperature: five(lo - 4, hi - 4), humidity: five(50, 60), vpd: five(0.8, 1) } });
const env = (id: string) => ({ id, kind: "env", entities: { temperature: `sensor.${id}_t` } });
const veg = {
  id: "veg", name: "Veg", sensors: [env("veg_board")], bands: bands(24, 26), lightLimits: { dayMin: 500, nightMax: 20 },
  periodMode: "fixed", dayAt: 16 * 60, nightAt: 10 * 60, emersonMode: "fixed", emerson: { morning: 15, daylight: 0, evening: 15 }, helpers: { bands: { day: { temperature: { max: "input_number.veg_t_max" } } } },
};
const child = (sensors: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "nursery", name: "Nursery", parent: "veg", sensors, bands: bands(20, 30), lightLimits: { dayMin: 100, nightMax: 50 },
  periodMode: "fixed", dayAt: 6 * 60, nightAt: 18 * 60, emersonMode: "none", helpers: {}, ...extra,
});
const dev = (id: string, type: string, zones: string[]) => ({ id, entity: `switch.${id}`, name: id, type, zones });

describe("what a linked zone takes from its parent", () => {
  it("shares a sensor: any one environment sensor of the parent's, even beside its own", () => {
    const z = child([env("nursery_board"), env("veg_board")]);
    const t = takesOf([veg, z], [], z);
    expect([t.sensor, t.lights, t.devices.size, t.parent?.id]).toEqual([true, false, 0, "veg"]);
  });
  it("shares lights: a Light device in both zones", () => {
    const z = child([env("nursery_board")]);
    const t = takesOf([veg, z], [dev("lamp", "Light", ["veg", "nursery"]), dev("fan", "Fan", ["veg", "nursery"])], z);
    expect([t.sensor, t.lights, [...t.devices].sort()]).toEqual([false, true, ["fan", "lamp"]]);
  });
  it("shares a device: only devices the parent also has", () => {
    const z = child([env("nursery_board")]);
    const t = takesOf([veg, z, { id: "garden" }], [dev("fan", "Fan", ["veg", "nursery"]), dev("dehu", "Dehumidifier", ["garden", "nursery"])], z);
    expect([t.lights, [...t.devices]]).toEqual([false, ["fan"]]);
  });
  it("shares nothing: its own sensor and devices only the parent has", () => {
    const z = child([env("nursery_board")]);
    const t = takesOf([veg, z], [dev("lamp", "Light", ["veg"])], z);
    expect([t.sensor, t.lights, t.devices.size]).toEqual([false, false, 0]);
    expect(effectiveZone([veg, z], [], z)).toBe(z);
  });
  it("a zone with no parent, or whose parent is gone, takes nothing and comes back as it is", () => {
    const lone = { ...child([env("veg_board")]), parent: null }, orphan = child([env("veg_board")], { parent: "gone" });
    expect(takesOf([veg, lone], [dev("lamp", "Light", ["veg", "nursery"])], lone).parent).toBeNull();
    expect(effectiveZone([veg, lone], [dev("lamp", "Light", ["veg", "nursery"])], lone)).toBe(lone);
    expect(effectiveZone([veg, orphan], [], orphan)).toBe(orphan);
    expect(effectiveZone([veg], [], veg)).toBe(veg);
  });
});

describe("a zone's effective limits, day and night and red lights", () => {
  it("shares a sensor: the parent's limits and their helpers, its own schedule", () => {
    const z = child([env("veg_board")]), e = effectiveZone([veg, z], [], z)!;
    expect([bandsOf(e, "day", "temperature"), e.lightLimits]).toEqual([five(24, 26), { dayMin: 500, nightMax: 20 }]);
    expect(e.helpers).toEqual({ bands: veg.helpers.bands });
    expect([e.dayAt, e.emersonMode]).toEqual([6 * 60, "none"]);
    expect(e.sensors).toBe(z.sensors);
  });
  it("shares lights: the parent's day and night and red lights, its own limits", () => {
    const z = child([env("nursery_board")]), e = effectiveZone([veg, z], [dev("lamp", "Light", ["veg", "nursery"])], z)!;
    expect(timesOf(e, {})).toEqual({ dayAt: 16 * 60, nightAt: 10 * 60 });
    expect([e.emersonMode, e.emerson]).toEqual(["fixed", veg.emerson]);
    expect(periodOf(e, {}, 20 * 60)).toBe("day");
    expect(periodOf(z, {}, 20 * 60)).toBe("night");
    expect(bandsOf(e, "day", "temperature")).toEqual(five(20, 30));
  });
  it("never changes the stored zone", () => {
    const z = child([env("veg_board")]), copy = structuredClone(z);
    effectiveZone([veg, z], [dev("lamp", "Light", ["veg", "nursery"])], z);
    expect(z).toEqual(copy);
  });
});

describe("judging a linked zone", () => {
  /* 27 degrees is Ideal by the child's own 20 to 30 and High by the parent's 24 to 26. */
  const judge = (z: Record<string, unknown>) => bandState(bandsOf(withLiveLimits(effectiveZone([veg, z], [], z), {}), "day", "temperature"), 27, true);
  it("reads High by the parent's limits when it shares a sensor", () => expect(judge(child([env("veg_board")]))).toBe("high"));
  it("reads Ideal by its own limits when it shares none", () => expect(judge(child([env("nursery_board")]))).toBe("ok"));
});
