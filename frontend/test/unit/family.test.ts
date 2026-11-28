import { describe, expect, it } from "vitest";
import { familyOf, familyOrder, linkedOrder, linkedZones, moveWords, parentChoices, sameFamily, sensorRefusal, setParent } from "../../src/frame/family";
import { sensorShare } from "../../src/frame/mapping";
import { copyConfig, readZones } from "../../src/frame/model";

const Z = (id: string, parent?: string) => ({ id, name: id[0].toUpperCase() + id.slice(1), ...(parent ? { parent } : {}) });
const ids = (list: { id: string }[]) => list.map((z) => z.id);

describe("families", () => {
  const list = [Z("garden"), Z("veg"), Z("nursery", "veg"), Z("seedlings", "veg"), Z("tent")];

  it("a family is a parent and the zones linked to it, one level deep", () => {
    expect(ids(familyOf(list, "nursery"))).toEqual(["veg", "nursery", "seedlings"]);
    expect(ids(familyOf(list, "veg"))).toEqual(["veg", "nursery", "seedlings"]);
    expect(ids(familyOf(list, "garden"))).toEqual(["garden"]);
    expect(ids(familyOf(list, "gone"))).toEqual([]);
    expect(sameFamily(list[2], list[3])).toBe(true);
    expect(sameFamily(list[1], list[2])).toBe(true);
    expect(sameFamily(list[0], list[2])).toBe(false);
    expect(ids(linkedZones(list, "veg"))).toEqual(["nursery", "seedlings"]);
    expect(linkedZones(list, "garden")).toEqual([]);
  });

  it("offers as a parent only a zone that isn't itself linked, and never the zone itself", () => {
    expect(ids(parentChoices(list, "garden"))).toEqual(["veg", "tent"]);
    expect(ids(parentChoices(list, null))).toEqual(["garden", "veg", "tent"]);
  });

  it("reads the parent from what's stored, and null when there's none", () => {
    expect(readZones(list).map((z) => z.parent)).toEqual([null, null, "veg", "veg", null]);
  });
});

describe("familyOrder", () => {
  it("pulls each stray to just after its parent's family, and leaves a contiguous order alone", () => {
    expect(ids(familyOrder([Z("nursery", "veg"), Z("garden"), Z("veg")]))).toEqual(["garden", "veg", "nursery"]);
    expect(ids(familyOrder([Z("veg"), Z("garden"), Z("nursery", "veg"), Z("tent"), Z("seedlings", "veg")]))).toEqual(["veg", "nursery", "seedlings", "garden", "tent"]);
    const fine = [Z("garden"), Z("nursery", "veg"), Z("veg"), Z("tent")];
    expect(ids(familyOrder(fine))).toEqual(["garden", "nursery", "veg", "tent"]);
  });

  it("lets a zone linked to one that's gone stand on its own", () => {
    expect(ids(familyOrder([Z("nursery", "veg"), Z("garden")]))).toEqual(["nursery", "garden"]);
  });
});

describe("linking", () => {
  it("moves the zone to the end of its parent's family, and unlinking leaves it where it is with no key", () => {
    const c = copyConfig([Z("garden"), Z("veg"), Z("nursery", "veg"), Z("tent")], []);
    setParent(c, "garden", "veg");
    expect(ids(c.zones as { id: string }[])).toEqual(["veg", "nursery", "garden", "tent"]);
    expect(c.zones[2].parent).toBe("veg");
    setParent(c, "garden", "");
    expect(ids(c.zones as { id: string }[])).toEqual(["veg", "nursery", "garden", "tent"]);
    expect("parent" in c.zones[2]).toBe(false);
    expect(ids(linkedOrder([Z("veg"), Z("tent")], Z("new"), "veg"))).toEqual(["veg", "new", "tent"]);
  });

  it("the review says when the zone will move, in the mock's words", () => {
    const list = [Z("garden"), Z("veg"), Z("nursery", "veg")];
    expect(moveWords(list, list[0], "veg", "Garden")).toBe("Garden moves next to Veg and the zones linked to it on Overview, in the menu and on Setup.");
    const two = [Z("veg"), Z("garden"), Z("nursery")];
    expect(moveWords(two, two[2], "veg", "Nursery")).toBe("Nursery moves next to Veg on Overview, in the menu and on Setup.");
    /* Already where linking puts it, or already linked to that parent: nothing moves, so nothing is said. */
    expect(moveWords(two, two[1], "veg", "Garden")).toBe("");
    expect(moveWords(list, list[2], "veg", "Nursery")).toBe("");
  });
});

describe("sharing a sensor", () => {
  const withSensor = (zones: Record<string, unknown>[], holders: string[]) =>
    copyConfig(zones.map((z) => ({ ...z, sensors: holders.includes(z.id as string) ? [{ id: "board1" }] : [] })), []);

  it("inside a family it's asked about as before", () => {
    const zones = [Z("garden"), Z("veg"), Z("nursery", "veg"), Z("seedlings", "veg")];
    expect(sensorShare(withSensor(zones, ["veg"]), "nursery", "board1")).toEqual({ others: ["Veg"], refusal: "" });
    expect(sensorShare(withSensor(zones, ["nursery"]), "veg", "board1")).toEqual({ others: ["Nursery"], refusal: "" });
    expect(sensorShare(withSensor(zones, ["veg", "nursery"]), "seedlings", "board1")).toEqual({ others: ["Veg", "Nursery"], refusal: "" });
  });

  it("outside a family it's refused, in the stakeholder's words", () => {
    const zones = [Z("garden"), Z("veg"), Z("nursery", "veg")];
    expect(sensorShare(withSensor(zones, ["veg"]), "garden", "board1").refusal).toBe(
      "This sensor is already associated to Zone: Veg. If you want a duplicate here, this zone must be linked to Veg. This can be done in the Zone details section of Setup.",
    );
    expect(sensorShare(withSensor(zones, ["veg", "nursery"]), "garden", "board1").refusal).toBe(
      "This sensor is already associated to Zones: Veg, Nursery. If you want a duplicate here, this zone must be linked to Veg. This can be done in the Zone details section of Setup.",
    );
  });

  it("says why when linking to the holder couldn't work either", () => {
    const zones = [Z("garden"), Z("veg"), Z("nursery", "veg"), Z("tent", "garden")];
    expect(sensorRefusal(zones, "veg", ["garden"])).toBe("This sensor is already associated to Zone: Garden. Zone: Nursery is linked to this zone, so it can't be linked to another.");
    expect(sensorRefusal(zones, "nursery", ["garden"])).toBe("This sensor is already associated to Zone: Garden. This zone is already linked to Zone: Veg, and a zone is linked to one other zone only.");
    expect(sensorRefusal([Z("veg"), Z("garden"), Z("tent", "garden")], "veg", ["tent"])).toBe(
      "This sensor is already associated to Zone: Tent. Tent is itself linked to Zone: Garden, so it can't be this zone's parent.",
    );
  });
});
