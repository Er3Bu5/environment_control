import { describe, expect, it } from "vitest";
import { deviceElsewhere } from "../../src/frame/mapping";
import { type RawConfig, readZones } from "../../src/frame/model";
import { inOrder, moveFamily, moveZone, orderZones } from "../../src/frame/sort";

const order = ["garden", "nursery", "veg"];

describe("moveZone with linked zones", () => {
  const zones = [{ id: "garden" }, { id: "veg" }, { id: "nursery", parent: "veg" }, { id: "seedlings", parent: "veg" }, { id: "tent" }];
  const all = zones.map((z) => z.id);

  it("steps a zone in a family only inside it, so the family is never split", () => {
    expect(moveZone(all, "nursery", -1, zones)).toEqual(["garden", "nursery", "veg", "seedlings", "tent"]);
    expect(moveZone(all, "seedlings", 1, zones)).toEqual(all);
    expect(moveZone(all, "veg", -1, zones)).toEqual(all);
    expect(moveZone(all, "veg", 1, zones)).toEqual(["garden", "nursery", "veg", "seedlings", "tent"]);
  });

  it("steps a zone on its own past a whole family in one press", () => {
    expect(moveZone(all, "garden", 1, zones)).toEqual(["veg", "nursery", "seedlings", "garden", "tent"]);
    expect(moveZone(all, "tent", -1, zones)).toEqual(["garden", "tent", "veg", "nursery", "seedlings"]);
    expect(moveZone(all, "tent", 1, zones)).toEqual(all);
  });
});

describe("moveFamily", () => {
  const zones = [{ id: "garden" }, { id: "veg" }, { id: "nursery", parent: "veg" }, { id: "seedlings", parent: "veg" }, { id: "tent" }, { id: "flower" }, { id: "clones", parent: "flower" }];
  const all = zones.map((z) => z.id);

  it("steps a whole family past a zone on its own, keeping its order inside", () => {
    expect(moveFamily(all, "veg", -1, zones)).toEqual(["veg", "nursery", "seedlings", "garden", "tent", "flower", "clones"]);
    expect(moveFamily(all, "veg", 1, zones)).toEqual(["garden", "tent", "veg", "nursery", "seedlings", "flower", "clones"]);
    const inside = ["garden", "seedlings", "veg", "nursery", "tent", "flower", "clones"];
    expect(moveFamily(inside, "veg", -1, zones)).toEqual(["seedlings", "veg", "nursery", "garden", "tent", "flower", "clones"]);
  });

  it("steps a whole family past another family in one press", () => {
    expect(moveFamily(all, "flower", -1, zones)).toEqual(["garden", "veg", "nursery", "seedlings", "flower", "clones", "tent"]);
    const next = ["garden", "veg", "nursery", "seedlings", "flower", "clones", "tent"];
    expect(moveFamily(next, "veg", 1, zones)).toEqual(["garden", "flower", "clones", "veg", "nursery", "seedlings", "tent"]);
    expect(moveFamily(next, "flower", -1, zones)).toEqual(["garden", "flower", "clones", "veg", "nursery", "seedlings", "tent"]);
  });

  it("leaves a family at either end where it is, and ignores one that isn't in the order", () => {
    expect(moveFamily(all, "flower", 1, zones)).toEqual(all);
    const first = ["veg", "nursery", "seedlings", "garden", "tent", "flower", "clones"];
    expect(moveFamily(first, "veg", -1, zones)).toEqual(first);
    expect(moveFamily(all, "nowhere", 1, zones)).toEqual(all);
    expect(all).toEqual(zones.map((z) => z.id));
  });
});

describe("moveZone", () => {
  it("steps a zone one place towards the start or the end", () => {
    expect(moveZone(order, "nursery", -1)).toEqual(["nursery", "garden", "veg"]);
    expect(moveZone(order, "nursery", 1)).toEqual(["garden", "veg", "nursery"]);
  });
  it("leaves the first zone first and the last zone last", () => {
    expect(moveZone(order, "garden", -1)).toEqual(order);
    expect(moveZone(order, "veg", 1)).toEqual(order);
  });
  it("undoes a move with the opposite one, and never changes the list it was given", () => {
    const moved = moveZone(order, "veg", -1);
    expect(moveZone(moved, "veg", 1)).toEqual(order);
    expect(order).toEqual(["garden", "nursery", "veg"]);
  });
  it("ignores a zone that isn't in the order", () => {
    expect(moveZone(order, "gone", 1)).toEqual(order);
  });
});

describe("inOrder", () => {
  it("drops a zone removed while sorting and puts a new one at the end", () => {
    const zones = [{ id: "new" }, { id: "veg" }, { id: "garden" }];
    expect(inOrder(zones, order).map((z) => z.id)).toEqual(["garden", "veg", "new"]);
  });
});

describe("the stored order", () => {
  const config = (): RawConfig => ({
    zones: order.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
    devices: [{ id: "fan", entity: "fan.shared", zones: ["garden", "veg"] }],
  });
  it("is the order the page menu lists zones in once it's saved", () => {
    const c = config();
    orderZones(c, ["veg", "garden", "nursery"]);
    expect(readZones(c.zones).map((z) => z.name)).toEqual(["Veg", "Garden", "Nursery"]);
  });
  it("is the order a message lists zones in", () => {
    const c = config();
    expect(deviceElsewhere(c, "nursery", "fan.shared")).toEqual(["Garden", "Veg"]);
    orderZones(c, ["veg", "nursery", "garden"]);
    expect(deviceElsewhere(c, "nursery", "fan.shared")).toEqual(["Veg", "Garden"]);
  });
});
