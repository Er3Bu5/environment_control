import { describe, expect, it } from "vitest";
import {
  addVirtual,
  noHeight,
  removeVirtual,
  renameVirtual,
  retypeVirtual,
  allowed,
  applyLayout,
  devsOff,
  flowOf,
  layoutChanges,
  layoutIssues,
  openLayout,
  planted,
  posText,
  spotsFor,
  stranded,
  suggestGrid,
  typed,
  zoneItems,
} from "../../src/frame/layout";
import { copyConfig } from "../../src/frame/model";

const L = { w: 2.4, d: 1.2, units: 5, rows: 2, cols: 3 };

describe("where things may go", () => {
  it("a unit is planted only inside the grid and within the unit count", () => {
    expect(planted(L, 0, 0)).toBe(true);
    expect(planted(L, 1, 1)).toBe(true);
    expect(planted(L, 1, 2)).toBe(false);
    expect(planted(L, 0.5, 0)).toBe(false);
  });

  it("an environment sensor goes anywhere inside the wall on the half-steps, never outside it", () => {
    expect(allowed("env", L, 0.5, 1)).toBe(true);
    expect(allowed("env", L, -0.5, -0.5)).toBe(true);
    expect(allowed("env", L, 1, 2)).toBe(true);
    expect(allowed("env", L, -1, 0)).toBe(false);
    expect(allowed("env", L, 0.25, 0)).toBe(false);
  });

  it("a soil probe sits only in a unit", () => {
    expect(allowed("soil", L, 0, 1)).toBe(true);
    expect(allowed("soil", L, 0.5, 1)).toBe(false);
    expect(allowed("soil", L, 1, 2)).toBe(false);
    expect(spotsFor("soil", L)).toHaveLength(5);
  });

  it("a device or virtual device may also go outside the wall, all the way round", () => {
    expect(allowed("device", L, -1, -1)).toBe(true);
    expect(allowed("virtual", L, 2, 3)).toBe(true);
    expect(allowed("device", L, -1.5, 0)).toBe(false);
  });
});

describe("words for a spot", () => {
  it("names units, aisles, the gaps by the wall and outside it", () => {
    expect(posText([0, 1], L)).toBe("Unit 2");
    expect(posText([1, 2], L)).toBe("Where unit 6 would be");
    expect(posText([0.5, 1], L)).toBe("Aisle between rows 1 and 2");
    expect(posText([0, 0.5], L)).toBe("Between unit 1 and unit 2");
    expect(posText([-0.5, 1], L)).toBe("By the wall at unit 2");
    expect(posText([-0.5, -0.5], L)).toBe("Corner by unit 1");
    expect(posText([-1, 0], L)).toBe("Outside the wall, by unit 1");
  });
});

describe("grids", () => {
  it("suggests the grid closest to the zone's shape with the fewest empty spaces", () => {
    expect(suggestGrid(12, 2.4, 1.2)).toEqual([3, 4]);
    expect(suggestGrid(4, 1.2, 1.2)).toEqual([2, 2]);
    expect(suggestGrid(1, 1, 1)).toEqual([1, 1]);
  });

  it("never suggests more than 20 either way, however long and thin the zone", () => {
    const [rows, cols] = suggestGrid(200, 100, 0.1);
    expect(rows <= 20 && cols <= 20 && rows * cols >= 200).toBe(true);
  });

  it("re-suggests the grid as a size or unit count is typed, clamped, and ignores what isn't a positive number", () => {
    const d = { w: 2.4, d: 1.2, units: 4, rows: 2, cols: 2 };
    typed(d, "units", 8);
    expect(d).toEqual({ w: 2.4, d: 1.2, units: 8, rows: 2, cols: 4 });
    typed(d, "units", 12.4);
    expect([d.units, d.rows, d.cols]).toEqual([12, 3, 4]);
    typed(d, "units", 999);
    expect(d.units).toBe(200);
    typed(d, "w", Number.NaN);
    typed(d, "d", -1);
    expect([d.w, d.d]).toEqual([2.4, 1.2]);
    typed(d, "w", 400);
    expect(d.w).toBe(100);
  });

  it("says when sizes, units or the grid can't work", () => {
    const d = openLayout(copyConfig([{ id: "z", name: "Z", layout: L, sensors: [] }], []), "z", [1, 2]);
    expect(layoutIssues(d)).toEqual([]);
    d.rows = 1;
    expect(layoutIssues(d)).toEqual(["This grid holds 3 units, and you have 5."]);
    d.w = 0;
    expect(layoutIssues(d)[0]).toBe("Width and depth go from 0.1 to 100 m.");
  });
});

describe("the draft", () => {
  const config = () =>
    copyConfig(
      [
        {
          id: "z", name: "Z", layout: L, other: 1,
          sensors: [
            { id: "air", name: "Air", kind: "env", pos: [0.5, 1], level: "in" },
            { id: "probe", name: "Probe", kind: "soil", pos: null },
          ],
          virtual: [{ id: "v-tank", name: "Drain tank", pos: [-1, 0] }],
        },
      ],
      [
        { id: "d-heat", name: "Heater", entity: "switch.heater", type: "Heater", zones: ["z"], place: { z: [2, 3] } },
        { id: "d-fan", name: "Fan", entity: "fan.tent", type: "Fan", zones: ["z", "other"], place: { other: [0, 0] } },
        { id: "d-away", name: "Elsewhere", entity: "switch.away", zones: ["other"] },
        { id: "d-board", name: "A sensor board", zones: ["z"] },
      ],
    );

  it("reads the zone's sensors, its devices and its virtual devices, and opens Placement on the first to place", () => {
    const d = openLayout(config(), "z", [3]);
    expect(d.sensors.map((s) => [s.id, s.kind, s.pos])).toEqual([["air", "env", [0.5, 1]], ["probe", "soil", null]]);
    expect(d.devs.map((x) => [x.id, x.pos])).toEqual([["d-heat", [2, 3]], ["d-fan", null]]);
    expect(d.pick).toBe("probe");
    expect(stranded(d).map((s) => s.id)).toEqual(["probe"]);
    expect(devsOff(d).map((x) => x.id)).toEqual(["d-fan"]);
  });

  it("a layout that strands something already placed carries on to the map", () => {
    const d = openLayout(config(), "z", [1, 2]);
    expect(flowOf(d)).toEqual([1, 2]);
    d.cols = 1;
    d.units = 2;
    expect(flowOf(d)).toEqual([1, 2, 3]);
  });

  it("adds a virtual device by a new name only", () => {
    const d = openLayout(config(), "z", [3]);
    d.vname = "drain TANK";
    addVirtual(d);
    expect(d.vissue).toBe("There's already a virtual device called drain TANK.");
    d.vname = "Res lid";
    addVirtual(d);
    expect([d.vissue, d.virt.at(-1)?.id, d.pick]).toEqual(["", "v-res_lid", "v-res_lid"]);
  });

  it("gives a virtual device a type, Other until said, and the new one the type picked when adding", () => {
    const d = openLayout(config(), "z", [3]);
    expect(d.virt[0].type).toBe("Other");
    d.vname = "Res lid";
    d.vtype = "Tank";
    addVirtual(d);
    expect([d.virt.at(-1)?.type, d.vtype]).toEqual(["Tank", "Other"]);
  });

  it("renames a virtual device keeping its id, refusing a blank or taken name, and retypes and removes it", () => {
    const c = config(), d = openLayout(c, "z", [3]);
    renameVirtual(d, "v-tank", "  ");
    expect([d.vissue, d.virt[0].name]).toEqual(["A virtual device needs a name.", "Drain tank"]);
    renameVirtual(d, "v-tank", "Waste tank");
    retypeVirtual(d, "v-tank", "Tank");
    expect([d.vissue, d.virt[0].id, d.virt[0].name, d.virt[0].type]).toEqual(["", "v-tank", "Waste tank", "Tank"]);
    expect(layoutChanges(d, c).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual([
      "Drain tank, virtual, name: Drain tank > Waste tank",
      "Waste tank, virtual, type: Other > Tank",
    ]);
    applyLayout(c, d);
    expect((c.zones[0] as Record<string, unknown>).virtual).toEqual([{ id: "v-tank", name: "Waste tank", pos: [-1, 0], type: "Tank" }]);
    d.pick = "v-tank";
    removeVirtual(d, "v-tank");
    expect([d.virt, d.pick]).toEqual([[], null]);
  });

  it("asks a height of every environment sensor on the map, and of no soil probe", () => {
    const d = openLayout(config(), "z", [3]);
    expect(noHeight(d)).toEqual([]);
    d.sensors[0].level = undefined;
    d.sensors[1].pos = [1, 1];
    expect(noHeight(d).map((s) => s.id)).toEqual(["air"]);
  });

  it("lists every change and applies it to a copy, leaving fields it doesn't know and other zones alone", () => {
    const c = config();
    const d = openLayout(c, "z", [3]);
    d.sensors[1].pos = [1, 1];
    d.sensors[0].level = "above";
    d.devs[1].pos = [-1, 2];
    d.devs[0].pos = null;
    d.virt = [];
    expect(layoutChanges(d, c).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual([
      "Air height: In canopy > Above canopy",
      "Probe position: Not placed > Unit 5",
      "Heater position: Outside the wall > Not placed",
      "Fan position: Not placed > Outside the wall, by unit 3",
      "Drain tank, virtual: Outside the wall, by unit 1 > Removed",
    ]);
    applyLayout(c, d);
    const z = c.zones[0] as Record<string, unknown>;
    expect(z.other).toBe(1);
    expect(z.virtual).toBeUndefined();
    expect((z.sensors as Record<string, unknown>[]).map((s) => [s.pos, s.level])).toEqual([[[0.5, 1], "above"], [[1, 1], undefined]]);
    expect(c.devices.map((x) => x.place)).toEqual([undefined, { other: [0, 0], z: [-1, 2] }, undefined, undefined]);
    expect(layoutChanges(openLayout(c, "z", [3]), c)).toEqual([]);
  });

  it("reads a zone with nothing in it as empty, and a missing layout as the 1.2 x 1.2 m placeholder", () => {
    const c = copyConfig([{ id: "z", name: "Z" }], []);
    expect(zoneItems(c, "z")).toEqual({ sensors: [], devs: [], virt: [] });
    expect(openLayout(c, "z", [1, 2])).toMatchObject({ w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 });
  });
});
