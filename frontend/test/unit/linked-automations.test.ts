/* What a linked zone shows of its parent's automations (#91, #111): every one of the parent's for the chip, read only,
   with the parent's names, an asterisk on the chips that have some, and the words that say where they're changed. */
import { describe, expect, it } from "vitest";
import {
  chipViews,
  editInText,
  fromParentText,
  notHereText,
  parentFailsafeNotice,
  parentHasAutos,
  parentLinks,
  roRow,
  showFromText,
  starText,
} from "../../src/frame/automations";
import { readZones } from "../../src/frame/model";
import type { HaState } from "../../src/frame/readings";

const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: null });
const link = (id: string, object: string, group: string, name?: string) => ({ id, entity: `automation.${object}`, group, ...(name ? { name } : {}) });

const zones = readZones([
  { id: "garden", name: "Garden", automations: [link("a1", "garden_alert", "alert_day")] },
  {
    id: "veg",
    name: "Veg",
    automations: [link("a1", "failsafe_tent_lights_recovery", "failsafe", "Tent lights back"), link("a2", "failsafe_veg_fans_auto_on", "failsafe"), link("a3", "veg_door", "alert_device")],
  },
  { id: "nursery", name: "Nursery", parent: "veg", automations: [link("a1", "nursery_lights_on", "control")] },
]);
const [garden, veg, nursery] = zones;
const states: Record<string, HaState> = {
  "automation.failsafe_tent_lights_recovery": st("on", { friendly_name: "Failsafe Tent Lights Recovery", last_triggered: null }),
  "automation.failsafe_veg_fans_auto_on": st("off", { friendly_name: "Failsafe Veg Fans Auto On", last_triggered: null }),
  "automation.veg_door": st("on", { friendly_name: "Veg door" }),
  "automation.nursery_lights_on": st("on", { friendly_name: "Nursery lights on" }),
};

describe("a linked zone's parent automations", () => {
  it("are every one of the parent's on the chip, and none for a zone that isn't linked or a parent itself", () => {
    expect(parentLinks(zones, nursery, "failsafe").map((a) => a.entity)).toEqual(["automation.failsafe_tent_lights_recovery", "automation.failsafe_veg_fans_auto_on"]);
    expect(parentLinks(zones, nursery, "alert").map((a) => a.entity)).toEqual(["automation.veg_door"]);
    expect(parentLinks(zones, nursery, "control")).toEqual([]);
    expect(parentLinks(zones, garden, "alert")).toEqual([]);
    expect(parentLinks(zones, veg, "failsafe")).toEqual([]);
    expect(parentHasAutos(zones, nursery)).toBe(true);
    expect(parentHasAutos(zones, garden)).toBe(false);
  });

  it("star only the chips the parent has some on, keeping the zone's own count and saying the asterisk in words", () => {
    expect(chipViews(nursery, states, zones)).toEqual([
      { chip: "alert", title: "Alerts", count: "0/0", label: "Alerts, none linked, and Zone: Veg has some that also run here", star: true },
      { chip: "failsafe", title: "Failsafes", count: "0/0", label: "Failsafes, none linked, and Zone: Veg has some that also run here", star: true },
      { chip: "control", title: "Control", count: "1/1", label: "Control, 1 of 1 on", star: false },
    ]);
    expect(chipViews(garden, states, zones).some((c) => c.star)).toBe(false);
  });

  it("draw read only, with the parent's name for each and what HA reports, never locked or waiting", () => {
    const [named, plain] = parentLinks(zones, nursery, "failsafe");
    expect(roRow(named, states[named.entity], 0)).toMatchObject({ name: "Tent lights back", on: true, sub: "On. Never triggered.", ro: true, locked: false, line: null });
    expect(roRow(plain, states[plain.entity], 0)).toMatchObject({ name: "Failsafe Veg Fans Auto On", on: false, sub: "Off. Never triggered.", ro: true });
  });

  it("say where they're changed, naming the zone as Zone: Veg once per paragraph", () => {
    expect(fromParentText("Veg")).toBe("These belong to Zone: Veg and run devices this zone shares. Edit in Veg.");
    expect(notHereText("Veg")).toBe("This automation is associated to Zone: Veg. Please edit it in Veg.");
    expect(starText("Veg")).toBe("Zone: Veg has automations in this group that also run here.");
    expect(showFromText("Veg")).toBe("Show automations from Zone: Veg");
    expect(editInText("Veg")).toBe("Edit in Zone: Veg");
  });

  it("say on the linked zone's page when a failsafe in the parent is off", () => {
    expect(parentFailsafeNotice("Veg", [])).toBeNull();
    expect(parentFailsafeNotice("Veg", [{ name: "Failsafe Veg Fans Auto On" }])).toBe(
      "A failsafe in Zone: Veg is off: Failsafe Veg Fans Auto On. While it's off, nothing puts that hardware back. Edit in Veg.",
    );
    expect(parentFailsafeNotice("Veg", [{ name: "A" }, { name: "B" }])).toBe("2 failsafes in Zone: Veg are off. While they're off, nothing puts that hardware back. Edit in Veg.");
  });
});
