import { describe, expect, it } from "vitest";
import { readCatalog, readHostMessage, readTheme } from "../../src/frame/messages";

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
