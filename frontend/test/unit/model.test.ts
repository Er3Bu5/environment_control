import { describe, expect, it } from "vitest";
import { addZone, copyConfig, markStep, readZones, removeZone, setDetails, stepsLeft, zoneNameIssue } from "../../src/frame/model";

const base = () =>
  copyConfig(
    [
      { id: "veg", name: "Veg", layout: { w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 }, sensors: [], extra: { kept: true } },
      { id: "nursery", name: "Nursery", sensors: [] },
    ],
    [
      { id: "lamp", name: "Lamp", zones: ["veg", "nursery"], place: { veg: [0, 0], nursery: [1, 1] } },
      { id: "fan", name: "Fan", zones: ["nursery"], place: { nursery: [0, 1] } },
    ],
  );

describe("zone names", () => {
  it("needs a name, and a new one, ignoring case and spaces at the ends", () => {
    const zones = readZones(base().zones);
    expect(zoneNameIssue("  ", zones, null)).toBe("Name this zone to continue");
    expect(zoneNameIssue(" veg ", zones, null)).toBe("There's already a zone called veg");
    expect(zoneNameIssue("Veg", zones, "veg")).toBe("");
    expect(zoneNameIssue("Flower", zones, null)).toBe("");
  });
});

describe("adding a zone", () => {
  it("gives it a slug id that doesn't collide, zeroed targets, a placeholder layout and every step but details to do", () => {
    const c = base();
    const id = addZone(c, "Veg!", "");
    expect(id).toBe("veg_2");
    const z = c.zones.find((x) => x.id === id) as Record<string, unknown>;
    expect(z.name).toBe("Veg!");
    expect(z.description).toBeUndefined();
    expect(z.layout).toEqual({ w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 });
    expect((z.bands as { day: Record<string, number[]> }).day.temperature).toEqual([0, 0, 0, 0, 0]);
    expect(stepsLeft(readZones([z])[0])).toEqual(["devices", "layout", "place", "calibrate", "targets"]);
  });

  it("falls back to zone when the name has no letters or digits", () => {
    expect(addZone(base(), "!!!", "Odd")).toBe("zone");
  });
});

describe("editing", () => {
  it("renames and drops an emptied description, keeping fields it doesn't know", () => {
    const c = base();
    setDetails(c, "veg", " Veg tent ", "x");
    setDetails(c, "veg", "Veg tent", "   ");
    const z = c.zones[0];
    expect([z.name, z.description, z.extra]).toEqual(["Veg tent", undefined, { kept: true }]);
  });

  it("marks one step without touching the others", () => {
    const c = base();
    markStep(c, "veg", "layout", "later");
    markStep(c, "veg", "devices", "done");
    expect(c.zones[0].setup).toEqual({ layout: "later", devices: "done" });
  });

  it("works on a copy, so what's stored isn't touched until a save comes back", () => {
    const zones = [{ id: "veg", name: "Veg" }];
    const c = copyConfig(zones, []);
    setDetails(c, "veg", "Changed", "");
    expect(zones[0].name).toBe("Veg");
  });
});

describe("removing a zone", () => {
  it("takes it out of every device and forgets its spots, leaving other zones as they were", () => {
    const c = base();
    removeZone(c, "nursery");
    expect(c.zones.map((z) => z.id)).toEqual(["veg"]);
    expect(c.devices).toEqual([
      { id: "lamp", name: "Lamp", zones: ["veg"], place: { veg: [0, 0] } },
      { id: "fan", name: "Fan", zones: [] },
    ]);
  });
});

describe("reading zones", () => {
  it("counts a zone stored before setup steps were recorded as set up, and leaves out one it can't read", () => {
    const zones = readZones([{ id: "old", name: "Old" }, { name: "No id" }, "junk"]);
    expect(zones.map((z) => z.id)).toEqual(["old"]);
    expect(stepsLeft(zones[0])).toEqual([]);
  });
});
