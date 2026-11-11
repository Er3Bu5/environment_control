import { describe, expect, it } from "vitest";
import type { Catalog, CatalogEntity } from "../../src/frame/messages";
import {
  addVirtual,
  applyMap,
  controlCandidates,
  deviceId,
  mapChanges,
  mapIssues,
  nameIt,
  openMap,
  removeVirtual,
  seedSlots,
  sensorCandidates,
  shownName,
  swapControl,
} from "../../src/frame/mapping";
import { copyConfig } from "../../src/frame/model";

const ent = (entity_id: string, extra: Partial<CatalogEntity> = {}): CatalogEntity => ({
  entity_id,
  name: entity_id,
  domain: entity_id.split(".")[0],
  device_class: null,
  unit: null,
  state: "1",
  category: null,
  area: null,
  ...extra,
});

const catalog: Catalog = {
  devices: [
    {
      id: "board1", name: "Left board", area: "Garden", manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [
        ent("sensor.left_temp", { device_class: "temperature", unit: "°C", state: "24.1" }),
        ent("sensor.left_chip", { device_class: "temperature", unit: "°C", category: "diagnostic" }),
        ent("sensor.left_rh", { device_class: "humidity", unit: "%" }),
        ent("sensor.left_vpd", { unit: "kPa" }),
        ent("sensor.left_lux", { device_class: "illuminance", unit: "lx", state: "14849.5224609375" }),
        ent("sensor.left_pressure", { device_class: "pressure", unit: "hPa", state: "1013.2" }),
        ent("number.left_offset", { unit: "°C", state: "-1.5", category: "config" }),
      ],
    },
    {
      id: "board2", name: "Two temps", area: null, manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [ent("sensor.a_temp", { device_class: "temperature" }), ent("sensor.b_temp", { device_class: "temperature" }), ent("sensor.two_rh", { device_class: "humidity" })],
    },
    {
      id: "soil", name: "Soil 1", area: "Garden", manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [
        ent("sensor.soil_temp", { device_class: "temperature", unit: "°C" }),
        ent("sensor.soil_vwc", { device_class: "moisture", unit: "%" }),
        ent("sensor.soil_raw", { device_class: "moisture", unit: "%" }),
        ent("sensor.soil_ec", { device_class: "conductivity", unit: "mS/cm" }),
      ],
    },
    {
      id: "plug", name: "Heater plug", area: "Garden", manufacturer: null, model: null, integration: "tuya_local", family: "Tuya Local", link: "wifi", path: "local", hub: null,
      entities: [ent("switch.heater_plug", { device_class: "outlet", name: "Heater plug" })],
    },
    {
      id: "dehu", name: "Dehumidifier", area: "Garden", manufacturer: null, model: null, integration: "tuya_local", family: "Tuya Local", link: "wifi", path: "local", hub: null,
      entities: [ent("humidifier.dehu", { device_class: "dehumidifier" }), ent("fan.dehu_fan")],
    },
  ],
  entities: [{ ...ent("light.group_lights"), integration: "group", family: "Group" }],
};

describe("candidates", () => {
  it("matches slots by device class and unit, offering a board's own diagnostics only when it has nothing else", () => {
    const [left, two] = sensorCandidates(catalog);
    expect(left.slots.temperature.map((o) => o.entity)).toEqual(["sensor.left_temp"]);
    expect(left.slots.vpd.map((o) => o.entity)).toEqual(["sensor.left_vpd"]);
    expect(left.slots.light.map((o) => o.entity)).toEqual(["sensor.left_lux"]);
    expect(two.slots.temperature).toHaveLength(2);
    expect(sensorCandidates(catalog).map((s) => s.id)).toEqual(["board1", "board2", "soil"]);
  });

  it("keeps every sensor on the device for any reading, its own diagnostics last, and never a number", () => {
    const left = sensorCandidates(catalog)[0];
    expect(left.all.map((o) => o.entity)).toEqual(["sensor.left_temp", "sensor.left_rh", "sensor.left_vpd", "sensor.left_lux", "sensor.left_pressure", "sensor.left_chip"]);
  });

  it("rounds a reading to what its size deserves", () => {
    const left = sensorCandidates(catalog)[0];
    expect(left.slots.light[0].reading).toBe(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(14849.5224609375)} lx`);
    expect(left.slots.temperature[0].reading).toBe(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(24.1)} °C`);
  });

  it("lists every switch, light, fan and humidifier, filling the role only where HA says what it is", () => {
    const c = controlCandidates(catalog);
    expect(c.map((x) => [x.entity, x.detected])).toEqual([
      ["switch.heater_plug", ""],
      ["humidifier.dehu", "Dehumidifier"],
      ["fan.dehu_fan", "Fan"],
      ["light.group_lights", "Light"],
    ]);
    expect(c.find((x) => x.entity === "light.group_lights")?.link).toBe("derived");
  });
});

describe("sensor classes", () => {
  const sensors = sensorCandidates(catalog), controls = controlCandidates(catalog);
  const soil = sensors.find((s) => s.id === "soil")!;

  it("detects a soil probe from moisture or conductivity, and asks it for moisture, EC and temperature", () => {
    expect(sensors.map((s) => [s.id, s.detected])).toEqual([["board1", "env"], ["board2", "env"], ["soil", "soil"]]);
    expect(seedSlots(soil)).toEqual({ temperature: "sensor.soil_temp", humidity: "none", vpd: "none", light: "none", moisture: "", ec: "sensor.soil_ec" });
  });

  it("changing class asks for the new class's readings and keeps one already picked", () => {
    const asEnv = seedSlots(soil, "env", seedSlots(soil));
    expect(asEnv).toEqual({ temperature: "sensor.soil_temp", humidity: "none", vpd: "none", light: "none", moisture: "none", ec: "none" });
  });

  it("stores the class and only its readings, places a sensor that changes class again, and combines each class on its own", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [{ id: "soil", name: "Soil 1", kind: "env", pos: [1, 1], entities: { temperature: "sensor.soil_temp" } }] }], []);
    const d = openMap(c, "garden");
    expect(d.cls.soil).toBe("env");
    d.cls.soil = "soil";
    d.sensors.soil = { ...seedSlots(soil, "soil", d.sensors.soil), moisture: "sensor.soil_vwc" };
    d.combine.soil = "median";
    applyMap(c, d, sensors, controls);
    const s = (c.zones[0].sensors as Record<string, unknown>[])[0];
    expect([s.kind, s.pos, s.entities]).toEqual(["soil", null, { moisture: "sensor.soil_vwc", ec: "sensor.soil_ec", temperature: "sensor.soil_temp" }]);
    expect(c.zones[0].combine).toEqual({ env: "mean", soil: "median" });
    expect(mapChanges(openMap(c, "garden"), c, sensors, controls)).toEqual([]);
  });
});

describe("the draft", () => {
  const sensors = sensorCandidates(catalog), controls = controlCandidates(catalog);

  it("takes a single candidate, waits on several, and leaves a missing slot unused", () => {
    const no = { moisture: "none", ec: "none" };
    expect(seedSlots(sensors[0])).toEqual({ temperature: "sensor.left_temp", humidity: "sensor.left_rh", vpd: "sensor.left_vpd", light: "sensor.left_lux", ...no });
    expect(seedSlots(sensors[1])).toEqual({ temperature: "", humidity: "sensor.two_rh", vpd: "none", light: "none", ...no });
  });

  it("names every answer still owed, and needs at least one sensor", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [] }], []);
    const d = openMap(c, "garden");
    expect(mapIssues(d, sensors).map((i) => i.text)).toEqual(["Add at least one environment sensor, so this zone has readings to show."]);
    d.sensors.board2 = seedSlots(sensors[1]);
    d.controls["switch.heater_plug"] = "";
    expect(mapIssues(d, sensors, controls).map((i) => i.text)).toEqual(["Two temps: pick which Temperature entity to use.", "Heater plug: say what it is."]);
    d.sensors.board2 = { temperature: "none", humidity: "none", vpd: "none", light: "none", moisture: "none", ec: "none" };
    expect(mapIssues(d, sensors).map((i) => i.text)).toContain("Two temps: pick at least one reading, or leave this sensor out.");
    d.sensors.board2.temperature = "sensor.two_rh";
    expect(mapIssues(d, sensors).filter((i) => i.step === 1)).toEqual([]);
  });

  it("applies to a copy: sensors with their entities, devices with their role, and nothing else touched", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [], other: 1 }], []);
    const d = openMap(c, "garden");
    d.sensors.board1 = seedSlots(sensors[0]);
    d.controls["switch.heater_plug"] = "Heater";
    d.controls["humidifier.dehu"] = "Dehumidifier";
    expect(mapChanges(d, c, sensors, controls).map((x) => x.label)).toContain("Heater plug is a");
    applyMap(c, d, sensors, controls);
    const z = c.zones[0] as Record<string, unknown>;
    expect(z.other).toBe(1);
    expect(z.sensors).toEqual([
      {
        id: "board1", name: "Left board", kind: "env", pos: null, family: "ESPHome", link: "unknown", linkSource: "detected",
        entities: { temperature: "sensor.left_temp", humidity: "sensor.left_rh", vpd: "sensor.left_vpd", light: "sensor.left_lux" },
        avg: true,
      },
    ]);
    expect(c.devices.map((x) => [x.id, x.entity, x.type, x.zones])).toEqual([
      [deviceId("switch.heater_plug"), "switch.heater_plug", "Heater", ["garden"]],
      [deviceId("humidifier.dehu"), "humidifier.dehu", "Dehumidifier", ["garden"]],
    ]);
    expect(deviceId("switch.heater_plug")).toMatch(/^d-[0-9a-f]{8}$/);
  });

  it("reopens what it saved unchanged, so a second look lists no changes", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [] }], []);
    const d = openMap(c, "garden");
    d.sensors.board1 = seedSlots(sensors[0]);
    d.controls["switch.heater_plug"] = "Heater";
    applyMap(c, d, sensors, controls);
    expect(mapChanges(openMap(c, "garden"), c, sensors, controls)).toEqual([]);
  });

  it("keeps a name given here in place of Home Assistant's, and follows HA's again once it's put back", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [] }], []);
    let d = openMap(c, "garden");
    d.sensors.board1 = seedSlots(sensors[0]);
    d.controls["switch.heater_plug"] = "Heater";
    nameIt(d, "board1", "Canopy left", "Left board");
    nameIt(d, "switch.heater_plug", " Heater ", "Heater plug");
    expect([shownName(d, "board1", "Left board"), shownName(d, "humidifier.dehu", "Dehu")]).toEqual(["Canopy left", "Dehu"]);
    expect(mapChanges(d, c, sensors, controls).filter((x) => x.label.endsWith("name")).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual([
      "Left board name: Left board > Canopy left",
      "Heater plug name: Heater plug > Heater",
    ]);
    applyMap(c, d, sensors, controls);
    const sensor = () => (c.zones[0].sensors as Record<string, unknown>[])[0];
    expect([sensor().name, sensor().nameSource, c.devices[0].name, c.devices[0].nameSource]).toEqual(["Canopy left", "confirmed", "Heater", "confirmed"]);
    /* Reopened, the names are still its own, and a second apply doesn't hand them back to Home Assistant. */
    d = openMap(c, "garden");
    expect(d.names).toEqual({ board1: "Canopy left", "switch.heater_plug": "Heater" });
    expect(mapChanges(d, c, sensors, controls)).toEqual([]);
    applyMap(c, d, sensors, controls);
    expect(sensor().name).toBe("Canopy left");
    /* Typed back to what Home Assistant calls it, there's nothing to keep, and the name follows HA's again. */
    nameIt(d, "board1", "Left board", "Left board");
    delete d.names["switch.heater_plug"];
    applyMap(c, d, sensors, controls);
    expect([sensor().name, sensor().nameSource, c.devices[0].name, c.devices[0].nameSource]).toEqual(["Left board", undefined, "Heater plug", undefined]);
  });

  it("won't apply a name left blank", () => {
    const d = openMap(copyConfig([{ id: "garden", name: "Garden", sensors: [] }], []), "garden");
    d.sensors.board1 = seedSlots(sensors[0]);
    d.controls["humidifier.dehu"] = "Dehumidifier";
    nameIt(d, "board1", "  ", "Left board");
    nameIt(d, "humidifier.dehu", "", "Dehu");
    expect(mapIssues(d, sensors, controls).map((i) => [i.step, i.text])).toEqual([
      [1, "Left board: give it a name, or put Home Assistant's back."],
      [2, `${controls.find((x) => x.entity === "humidifier.dehu")?.name}: give it a name, or put Home Assistant's back.`],
    ]);
  });

  it("moves a device to another entity as one change, keeping its name, its type and its place on the map", () => {
    const c = copyConfig(
      [{ id: "garden", name: "Garden", sensors: [{ id: "board1", entities: { temperature: "sensor.left_temp" } }] }, { id: "veg", name: "Veg", sensors: [] }],
      [{ id: deviceId("switch.heater_plug"), entity: "switch.heater_plug", name: "Heater", nameSource: "confirmed", type: "Heater", zones: ["garden", "veg"], place: { garden: [0, 1], veg: [1, 1] } }],
    );
    const d = openMap(c, "garden");
    swapControl(d, "switch.heater_plug", "fan.dehu_fan");
    expect([d.controls, d.names["fan.dehu_fan"], d.swap]).toEqual([{ "fan.dehu_fan": "Heater" }, "Heater", { "fan.dehu_fan": "switch.heater_plug" }]);
    expect(mapChanges(d, c, sensors, controls).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual(["Heater entity: switch.heater_plug > fan.dehu_fan"]);
    applyMap(c, d, sensors, controls);
    expect(c.devices.map((x) => [x.id, x.entity, x.name, x.type, x.zones, x.place])).toEqual([
      [deviceId("fan.dehu_fan"), "fan.dehu_fan", "Heater", "Heater", ["garden", "veg"], { garden: [0, 1], veg: [1, 1] }],
    ]);
    /* Moved on again and then back to where it started, nothing has changed. */
    const again = openMap(c, "garden");
    swapControl(again, "fan.dehu_fan", "light.group_lights");
    swapControl(again, "light.group_lights", "fan.dehu_fan");
    expect([again.swap, mapChanges(again, c, sensors, controls)]).toEqual([{}, []]);
    /* It can't take the place of a device that's already in the zone. */
    again.controls["humidifier.dehu"] = "Dehumidifier";
    swapControl(again, "fan.dehu_fan", "humidifier.dehu");
    expect(Object.keys(again.controls)).toEqual(["fan.dehu_fan", "humidifier.dehu"]);
  });

  it("adds, names, retypes and removes virtual devices, keeping the spot of one already placed", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [{ id: "board1", entities: { temperature: "sensor.left_temp" } }], virtual: [{ id: "v-tank", name: "Drain tank", type: "Tank", pos: [-1, 0] }] }], []);
    const d = openMap(c, "garden");
    expect(d.virt).toEqual([{ id: "v-tank", name: "Drain tank", type: "Tank" }]);
    const id = addVirtual(d) as string;
    expect(mapIssues(d, sensors, controls).map((i) => [i.step, i.text])).toEqual([[2, "A virtual device needs a name."]]);
    const fresh = d.virt.find((v) => v.id === id) as (typeof d.virt)[number];
    fresh.name = "drain TANK";
    expect(mapIssues(d, sensors, controls).map((i) => i.text)).toEqual(["There's already a virtual device called drain TANK."]);
    Object.assign(fresh, { name: " Res lid ", type: "Other" });
    d.virt[0].name = "Waste tank";
    expect(mapChanges(d, c, sensors, controls).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual([
      "Drain tank, virtual, name: Drain tank > Waste tank",
      "Res lid, virtual: Not added > Added, Other",
    ]);
    applyMap(c, d, sensors, controls);
    expect(c.zones[0].virtual).toEqual([
      { id: "v-tank", name: "Waste tank", type: "Tank", pos: [-1, 0] },
      { id: "v-res_lid", name: "Res lid", type: "Other" },
    ]);
    const next = openMap(c, "garden");
    expect(mapChanges(next, c, sensors, controls)).toEqual([]);
    removeVirtual(next, "v-tank");
    expect(mapChanges(next, c, sensors, controls).map((x) => `${x.label}: ${x.before} > ${x.after}`)).toEqual(["Waste tank, virtual: On the map > Removed"]);
    removeVirtual(next, "v-res_lid");
    applyMap(c, next, sensors, controls);
    expect(c.zones[0].virtual).toBeUndefined();
  });

  it("keeps a dehumidifier's extra mode with the device, and never on anything else", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [{ id: "board1", entities: { temperature: "sensor.left_temp" } }] }], []);
    const d = openMap(c, "garden");
    d.controls["humidifier.dehu"] = "Dehumidifier";
    d.controls["switch.heater_plug"] = "Heater";
    d.extra["humidifier.dehu"] = " normal ";
    d.extra["switch.heater_plug"] = "normal";
    expect(mapChanges(d, c, sensors, controls).filter((x) => x.label.endsWith("extra mode")).map((x) => `${x.before} > ${x.after}`)).toContain("None > normal");
    applyMap(c, d, sensors, controls);
    expect(c.devices.map((x) => [x.entity, x.nudgeMode])).toEqual([["humidifier.dehu", "normal"], ["switch.heater_plug", undefined]]);
    const again = openMap(c, "garden");
    expect(again.extra).toEqual({ "humidifier.dehu": "normal" });
    /* Moved to a fan, the mode isn't the fan's to have. */
    swapControl(again, "humidifier.dehu", "fan.dehu_fan");
    expect(again.extra).toEqual({});
    const cleared = openMap(c, "garden");
    delete cleared.extra["humidifier.dehu"];
    applyMap(c, cleared, sensors, controls);
    expect(c.devices[0].nudgeMode).toBeUndefined();
  });

  it("leaves a sensor's leaf temperature offset alone, which is Sensor Calibration's", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [{ id: "board1", name: "Left board", leafEntity: "number.left_offset", leafUnused: false, leaf: 0.5, entities: { temperature: "sensor.left_temp", humidity: "sensor.left_rh" } }] }], []);
    const d = openMap(c, "garden");
    d.sensors.board1.humidity = "sensor.left_pressure";
    applyMap(c, d, sensors, controls);
    const s = (c.zones[0].sensors as Record<string, unknown>[])[0];
    expect([s.leafEntity, s.leafUnused, s.leaf]).toEqual(["number.left_offset", false, 0.5]);
    expect(s.entities).toEqual({ temperature: "sensor.left_temp", humidity: "sensor.left_pressure" });
  });

  it("takes a device out of this zone only, and drops its entry once it is in no zone", () => {
    const c = copyConfig(
      [{ id: "veg", name: "Veg", sensors: [] }, { id: "nursery", name: "Nursery", sensors: [] }],
      [
        { id: "d1", entity: "switch.tent_lights", type: "Light", zones: ["veg", "nursery"], place: { veg: [0, 0], nursery: [1, 1] } },
        { id: "d2", entity: "switch.heater_plug", type: "Heater", zones: ["veg"] },
      ],
    );
    const d = openMap(c, "veg");
    expect(d.controls).toEqual({ "switch.tent_lights": "Light", "switch.heater_plug": "Heater" });
    d.controls = {};
    applyMap(c, d, sensors, controls);
    expect(c.devices).toEqual([{ id: "d1", entity: "switch.tent_lights", type: "Light", zones: ["nursery"], place: { nursery: [1, 1] } }]);
  });
});
