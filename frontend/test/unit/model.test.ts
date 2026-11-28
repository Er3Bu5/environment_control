import { describe, expect, it } from "vitest";
import { HISTORY_DEFAULT, addZone, andList, confirmLink, copyConfig, markStep, readZones, removeZone, setAlertRepeat, setDetails, setHistory, shareAsk, stepsLeft, unknownLinks, zoneNameIssue } from "../../src/frame/model";

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

  it("keeps what a zone's History opens on, reads only a graph and range the card has, and stores nothing for what every zone starts with", () => {
    const c = base();
    setHistory(c, "veg", { metric: "humidity", hours: 72 });
    expect(c.zones[0].history).toEqual({ metric: "humidity", hours: 72 });
    expect(readZones(c.zones).map((z) => z.history)).toEqual([{ metric: "humidity", hours: 72 }, null]);
    setHistory(c, "veg", HISTORY_DEFAULT);
    expect("history" in c.zones[0]).toBe(false);
    expect(c.zones[0].extra).toEqual({ kept: true });
    for (const bad of [{ metric: "pressure", hours: 24 }, { metric: "vpd", hours: 48 }, { metric: "vpd" }, "vpd", null])
      expect(readZones([{ id: "x", name: "X", history: bad }])[0].history).toBeNull();
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

describe("links HA can't tell", () => {
  it("asks once per board, only for mapped devices, and keeps an answer as confirmed in every zone", () => {
    const c = copyConfig(
      [
        { id: "a", name: "A", sensors: [{ id: "b1", name: "Board", link: "unknown" }, { id: "b2", name: "Wired", link: "ethernet" }] },
        { id: "b", name: "B", sensors: [{ id: "b1", name: "Board", link: "unknown" }] },
      ],
      [
        { id: "d1", name: "Plug", link: "unknown", zones: ["a"] },
        { id: "d2", name: "Spare", link: "unknown", zones: [] },
      ],
    );
    expect(unknownLinks(c)).toEqual([
      { id: "b1", name: "Board", kind: "sensor" },
      { id: "d1", name: "Plug", kind: "device" },
    ]);
    confirmLink(c, "b1", "ethernet");
    expect(c.zones.map((z) => (z.sensors as Record<string, unknown>[])[0])).toEqual([
      { id: "b1", name: "Board", link: "ethernet", linkSource: "confirmed" },
      { id: "b1", name: "Board", link: "ethernet", linkSource: "confirmed" },
    ]);
    expect(unknownLinks(c).map((x) => x.id)).toEqual(["d1"]);
  });
});

describe("a zone's automations", () => {
  const link = (id: string, entity: string, group: string) => ({ id, entity: `automation.${entity}`, group });

  it("reads each link to an automation, in its group, in the order saved", () => {
    const [z] = readZones([{ id: "veg", name: "Veg", automations: [link("a2", "tent_lights_on", "control"), link("a1", "failsafe_veg_fans_auto_on", "failsafe")] }]);
    expect(z.automations).toEqual([
      { id: "a2", entity: "automation.tent_lights_on", group: "control" },
      { id: "a1", entity: "automation.failsafe_veg_fans_auto_on", group: "failsafe" },
    ]);
  });

  it("leaves out a link that isn't the right shape, or that repeats an id or an automation, and keeps the rest", () => {
    const [z] = readZones([
      {
        id: "veg",
        name: "Veg",
        automations: [
          link("a1", "ok", "alert_day"),
          link("a2", "ok", "alert_night"),
          link("a1", "other", "alert_night"),
          { id: "a3", entity: "script.ok", group: "control" },
          link("A4", "upper_id", "control"),
          link("a5", "odd_group", "alerts"),
          { id: "a6", entity: "automation.no_group" },
          "automation.bare",
          link("a7", "last", "alert_device"),
        ],
      },
    ]);
    expect(z.automations.map((a) => a.id)).toEqual(["a1", "a7"]);
    for (const automations of [undefined, "automation.x", { a1: "automation.x" }]) expect(readZones([{ id: "veg", name: "Veg", automations }])[0].automations).toEqual([]);
  });
});

describe("the room's settings", () => {
  it("ride along on a copy only when given, so a save without them leaves the host keeping what's stored", () => {
    const room = { alertRepeat: "input_number.alert_repeat_rate" };
    const c = copyConfig([], [], room);
    expect(c.room).toEqual(room);
    c.room = {};
    expect(room).toEqual({ alertRepeat: "input_number.alert_repeat_rate" });
    expect("room" in copyConfig([], [])).toBe(false);
  });

  it("link, change and unlink the alert repeat helper, unlinking as an empty room rather than none", () => {
    const c = copyConfig([], [], {});
    setAlertRepeat(c, "input_number.alert_repeat_rate");
    expect(c.room).toEqual({ alertRepeat: "input_number.alert_repeat_rate" });
    setAlertRepeat(c, "input_number.other");
    expect(c.room).toEqual({ alertRepeat: "input_number.other" });
    setAlertRepeat(c, null);
    expect(c.room).toEqual({});
    const fresh = copyConfig([], []);
    setAlertRepeat(fresh, null);
    expect(fresh.room).toEqual({});
  });
});

describe("adding something another zone has", () => {
  it("asks about a sensor by its name, naming the zone that has it once", () => {
    expect(shareAsk("sensor", "Soil 1", ["Garden"])).toEqual({
      title: "Soil 1",
      text: "This sensor is already associated to Zone: Garden. Are you sure you want to duplicate it here?",
      more: "This means that data is in sync in both zones.",
      keep: "Cancel",
      go: "Add",
    });
  });
  it("says a device's controls are shared, and names the zone bare the second time", () => {
    expect(shareAsk("device", "Dehumidifier", ["Garden"])).toEqual({
      title: "Dehumidifier",
      text: "This device is already associated to Zone: Garden. Are you sure you want to duplicate it here?",
      more: "This means that controls are in sync in both zones. Automations from Garden may affect the device state.",
      keep: "Cancel",
      go: "Add",
    });
  });
  it("lists several zones as given, then joins the bare names as a sentence", () => {
    const two = shareAsk("device", "Dehumidifier", ["Garden", "Veg"]);
    expect(two.text).toBe("This device is already associated to Zones: Garden, Veg. Are you sure you want to duplicate it here?");
    expect(two.more).toBe("This means that controls are in sync in all of these zones. Automations from Garden and Veg may affect the device state.");
    const three = shareAsk("device", "Dehumidifier", ["Garden", "Nursery", "Veg"]);
    expect(three.text).toBe("This device is already associated to Zones: Garden, Nursery, Veg. Are you sure you want to duplicate it here?");
    expect(three.more).toBe("This means that controls are in sync in all of these zones. Automations from Garden, Nursery and Veg may affect the device state.");
    expect(shareAsk("sensor", "Soil 1", ["Veg", "Garden"]).text).toBe("This sensor is already associated to Zones: Veg, Garden. Are you sure you want to duplicate it here?");
    expect(shareAsk("sensor", "Soil 1", ["Veg", "Garden"]).more).toBe("This means that data is in sync in all of these zones.");
  });
});

describe("bare zone names in a sentence", () => {
  it("reads as a sentence does", () => {
    expect(andList([])).toBe("");
    expect(andList(["Veg"])).toBe("Veg");
    expect(andList(["Garden", "Veg"])).toBe("Garden and Veg");
    expect(andList(["Garden", "Nursery", "Veg"])).toBe("Garden, Nursery and Veg");
    expect(andList(["A", "B", "C", "D"])).toBe("A, B, C and D");
  });
});
