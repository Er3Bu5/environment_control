import { describe, expect, it } from "vitest";
import { readCatalog, readHistory, readHostMessage, readTheme } from "../../src/frame/messages";

const theme = { appearance: "ha", mode: "dark", colors: { primary: "#F44336" } };
const stored = { revision: 2, zones: [{ id: "garden" }], devices: [] };

describe("messages from the host", () => {
  it("reads an init with the stored setup, states and theme", () => {
    const m = readHostMessage({ v: 1, type: "init", ...stored, states: {}, theme });
    expect(m).toEqual({ type: "init", ...stored, states: {}, theme, narrow: false });
    expect(readHostMessage({ v: 1, type: "init", ...stored, states: {}, theme, narrow: true })).toMatchObject({ narrow: true });
  });

  it("drops anything without version 1", () => {
    expect(readHostMessage({ type: "init", ...stored, states: {}, theme })).toBeNull();
    expect(readHostMessage({ v: 2, type: "theme", theme })).toBeNull();
  });

  it("drops a type it doesn't know", () => {
    expect(readHostMessage({ v: 1, type: "callService", domain: "switch" })).toBeNull();
  });

  it("carries the room's settings with the stored setup, on init, config and a save's answer, and none when none was sent", () => {
    const room = { alertRepeat: "input_number.alert_repeat_rate" };
    expect(readHostMessage({ v: 1, type: "init", ...stored, room, states: {}, theme })).toMatchObject({ type: "init", room });
    expect(readHostMessage({ v: 1, type: "config", ...stored, room: {} })).toEqual({ type: "config", ...stored, room: {} });
    const saved = readHostMessage({ v: 1, type: "result", req: 4, ok: true, ...stored, room });
    expect(saved?.type === "result" && saved.stored).toEqual({ ...stored, room });
    /* No room at all stays no room, so a save sends none and the host keeps what's stored instead of unlinking it. */
    const m = readHostMessage({ v: 1, type: "config", ...stored });
    expect(m && "room" in m).toBe(false);
  });

  it("reads each room setting on its own, leaving out one that isn't a number helper and any it doesn't know", () => {
    for (const alertRepeat of ["switch.alert_repeat", "input_number.Alert", "input_number.", 15, null])
      expect(readHostMessage({ v: 1, type: "config", ...stored, room: { alertRepeat } })).toMatchObject({ room: {} });
    expect(readHostMessage({ v: 1, type: "config", ...stored, room: { alertRepeat: "input_number.repeat", colour: "red" } })).toMatchObject({ room: { alertRepeat: "input_number.repeat" } });
  });

  it("drops a stored setup whose room isn't an object, as it does zones that aren't a list", () => {
    for (const room of [null, "input_number.repeat", ["input_number.repeat"], 1]) {
      expect(readHostMessage({ v: 1, type: "init", ...stored, room, states: {}, theme })).toBeNull();
      expect(readHostMessage({ v: 1, type: "config", ...stored, room })).toBeNull();
      const saved = readHostMessage({ v: 1, type: "result", req: 4, ok: true, ...stored, room });
      expect(saved?.type === "result" && saved.stored).toBeFalsy();
    }
  });

  it("drops a half-formed message rather than using part of it", () => {
    expect(readHostMessage({ v: 1, type: "init", revision: "2", zones: [], devices: [], states: {}, theme })).toBeNull();
    expect(readHostMessage({ v: 1, type: "config", revision: 1, zones: {}, devices: [] })).toBeNull();
    expect(readHostMessage({ v: 1, type: "result", req: 1.5, ok: true })).toBeNull();
    expect(readHostMessage(null)).toBeNull();
    expect(readHostMessage("init")).toBeNull();
  });
});

describe("theme colours", () => {
  it("keeps plain colours", () => {
    const t = readTheme({ appearance: "ha", mode: "light", colors: { primary: "rgb(244, 67, 54)", bg: "#fff", fg: "black" } });
    expect(t?.colors).toEqual({ primary: "rgb(244, 67, 54)", bg: "#fff", fg: "black" });
  });

  it("drops anything that could carry more than a colour into a style", () => {
    const t = readTheme({
      appearance: "ha",
      mode: "light",
      colors: { primary: "url(https://x.test/a.png)", bg: "#fff; background: red", fg: "expression(alert(1))", card: "#123456" },
    });
    expect(t?.colors).toEqual({ card: "#123456" });
  });

  it("drops colour keys it doesn't use", () => {
    expect(readTheme({ appearance: "ha", mode: "light", colors: { evil: "#000" } })?.colors).toEqual({});
  });

  it("refuses an appearance or mode it doesn't know", () => {
    expect(readTheme({ appearance: "neon", mode: "light", colors: {} })).toBeNull();
    expect(readTheme({ appearance: "ha", mode: "dim", colors: {} })).toBeNull();
  });
});

describe("readCatalog", () => {
  const entity = { entity_id: "sensor.board_temp", name: "Air temp", domain: "sensor", device_class: "temperature", unit: "°C", state: "21.5", category: null, area: null };
  const device = { id: "d1", name: "Board", area: "Garden", manufacturer: null, model: null, integration: "esphome", family: "ESPHome", link: "unknown", path: "local", hub: null, entities: [entity] };

  it("keeps a well-formed catalog", () => {
    const c = readCatalog({ devices: [device], entities: [{ ...entity, entity_id: "input_boolean.override", domain: "input_boolean", integration: "input_boolean", family: "Input boolean" }] });
    expect(c?.devices[0].entities[0].entity_id).toBe("sensor.board_temp");
    expect(c?.entities[0].family).toBe("Input boolean");
  });

  it("leaves out one malformed device without hiding the rest", () => {
    const c = readCatalog({ devices: [{ name: "No id", entities: [] }, device], entities: [] });
    expect(c?.devices.map((d) => d.id)).toEqual(["d1"]);
  });

  it("reads a link or path it doesn't know as unknown, never as a guess", () => {
    const c = readCatalog({ devices: [{ ...device, link: "carrier-pigeon", path: "maybe" }], entities: [] });
    expect([c?.devices[0].link, c?.devices[0].path]).toEqual(["unknown", "unknown"]);
  });

  it("drops an entity whose id isn't an entity id", () => {
    const c = readCatalog({ devices: [{ ...device, entities: [entity, { ...entity, entity_id: "not an id" }] }], entities: [] });
    expect(c?.devices[0].entities).toHaveLength(1);
  });

  it("lists Home Assistant's automations, each with only its name, area, state and when it last ran", () => {
    const ran = "2026-11-17T00:05:00+00:00";
    const c = readCatalog({ devices: [], entities: [], automations: [{ entity_id: "automation.garden_lights_on", name: "Garden Lights On", state: "on", area: "Garden", last_triggered: ran, trigger: "time" }] });
    expect(c?.automations).toEqual([{ entity_id: "automation.garden_lights_on", name: "Garden Lights On", state: "on", area: "Garden", last_triggered: ran }]);
  });

  it("leaves out an automation that isn't one, without hiding the rest, and reads what it can't use as nothing", () => {
    const ok = { entity_id: "automation.ok", name: "OK", state: "off", area: null, last_triggered: null };
    const c = readCatalog({
      devices: [],
      entities: [],
      automations: [ok, { ...ok, entity_id: "script.ok" }, { ...ok, entity_id: "automation.Bad" }, { ...ok, entity_id: `automation.${"x".repeat(201)}` }, "automation.ok", null, { ...ok, entity_id: "automation.odd", name: 5, state: 1, area: [], last_triggered: "yesterday" }],
    });
    expect(c?.automations).toEqual([ok, { entity_id: "automation.odd", name: "automation.odd", state: null, area: null, last_triggered: null }]);
  });

  it("keeps the devices and helpers when the automations aren't a list", () => {
    for (const automations of [undefined, "lots", { a: 1 }]) {
      const c = readCatalog({ devices: [device], entities: [], automations });
      expect([c?.devices.length, c?.automations]).toEqual([1, []]);
    }
  });

  it("refuses something that isn't a catalog at all", () => {
    expect(readCatalog({ devices: "lots" })).toBeNull();
    expect(readCatalog(null)).toBeNull();
  });

  it("comes through on a result message, and a broken one is simply absent", () => {
    const ok = readHostMessage({ v: 1, type: "result", req: 3, ok: true, catalog: { devices: [device], entities: [] } });
    expect(ok?.type === "result" && ok.catalog?.devices.length).toBe(1);
    const broken = readHostMessage({ v: 1, type: "result", req: 3, ok: true, catalog: "nope" });
    expect(broken?.type === "result" && broken.catalog).toBeFalsy();
  });
});

describe("history from the host", () => {
  const ok = { start: 0, end: 60, step: 20, series: { "sensor.t": { first: 0, values: [[20, 19, 21], null, [21, 21, 21]] } } };

  it("keeps three numbers as a bucket, and anything else as no data rather than a guess", () => {
    const h = readHistory({ ...ok, series: { "sensor.t": { first: "x", values: [[20, 19, 21], ["21", 1, 2], [1, Number.NaN, 3]] } } });
    expect(h?.series["sensor.t"]).toEqual({ first: null, values: [[20, 19, 21], null, null] });
  });

  it("drops the whole answer when a series doesn't have one bucket per step, or names something that isn't an entity", () => {
    expect(readHistory(ok)).not.toBeNull();
    expect(readHistory({ ...ok, series: { "sensor.t": { first: 0, values: [[20, 19, 21]] } } })).toBeNull();
    expect(readHistory({ ...ok, series: { "<img src=x>": { first: 0, values: [null, null, null] } } })).toBeNull();
    expect(readHistory({ ...ok, step: 0 })).toBeNull();
  });

  it("arrives on a result, and a result without one is still a result", () => {
    const m = readHostMessage({ v: 1, type: "result", req: 3, ok: true, history: ok });
    expect(m && m.type === "result" && m.history?.series["sensor.t"].values.length).toBe(3);
  });
});
