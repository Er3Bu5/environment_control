import { describe, expect, it } from "vitest";
import type { Catalog, CatalogEntity } from "../../src/frame/messages";
import {
  applyMap,
  controlCandidates,
  deviceId,
  mapChanges,
  mapIssues,
  openMap,
  seedSlots,
  sensorCandidates,
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
        ent("sensor.left_lux", { device_class: "illuminance", unit: "lx" }),
        ent("number.left_offset", { unit: "°C", state: "-1.5", category: "config" }),
      ],
    },
    {
      id: "board2", name: "Two temps", area: null, manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null,
      entities: [ent("sensor.a_temp", { device_class: "temperature" }), ent("sensor.b_temp", { device_class: "temperature" }), ent("sensor.two_rh", { device_class: "humidity" })],
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
    expect(left.slots.leaf.map((o) => o.entity)).toEqual(["number.left_offset"]);
    expect(two.slots.temperature).toHaveLength(2);
    expect(sensorCandidates(catalog).map((s) => s.id)).toEqual(["board1", "board2"]);
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

describe("the draft", () => {
  const sensors = sensorCandidates(catalog), controls = controlCandidates(catalog);

  it("takes a single candidate, waits on several, and leaves a missing slot unused", () => {
    expect(seedSlots(sensors[0])).toEqual({ temperature: "sensor.left_temp", humidity: "sensor.left_rh", vpd: "sensor.left_vpd", light: "sensor.left_lux", leaf: "number.left_offset" });
    expect(seedSlots(sensors[1])).toMatchObject({ temperature: "", humidity: "sensor.two_rh", vpd: "none", light: "none", leaf: "none" });
  });

  it("names every answer still owed, and needs at least one sensor", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [] }], []);
    const d = openMap(c, "garden");
    expect(mapIssues(d, sensors).map((i) => i.text)).toEqual(["Add at least one environment sensor, so this zone has readings to show."]);
    d.sensors.board2 = seedSlots(sensors[1]);
    d.controls["switch.heater_plug"] = "";
    expect(mapIssues(d, sensors, controls).map((i) => i.text)).toEqual(["Two temps: pick which Temperature entity to use.", "Heater plug: say what it is."]);
    d.sensors.board2.humidity = "none";
    expect(mapIssues(d, sensors).some((i) => i.text.includes("needs humidity"))).toBe(true);
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
        leafEntity: "number.left_offset", leafUnused: false, avg: true,
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

  it("keeps a board's offset going when it moves into Environment Control, starting from what the board said", () => {
    const c = copyConfig([{ id: "garden", name: "Garden", sensors: [{ id: "board1", name: "Left board", leafEntity: "number.left_offset", leafUnused: false, entities: { temperature: "sensor.left_temp", humidity: "sensor.left_rh" } }] }], []);
    const d = openMap(c, "garden");
    d.sensors.board1.leaf = "none";
    applyMap(c, d, sensors, controls);
    const s = (c.zones[0].sensors as Record<string, unknown>[])[0];
    expect([s.leafEntity, s.leafUnused, s.leaf]).toEqual([undefined, true, -1.5]);
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
