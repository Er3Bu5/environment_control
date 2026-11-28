import { describe, expect, it } from "vitest";
import { deviceElsewhere } from "../../src/frame/mapping";
import { type RawConfig, readZones } from "../../src/frame/model";
import { inOrder, moveZone, orderZones } from "../../src/frame/sort";

const order = ["garden", "nursery", "veg"];

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
