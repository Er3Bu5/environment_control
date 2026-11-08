import { describe, expect, it } from "vitest";
import { readHostMessage, readTheme } from "../../src/frame/messages";

const theme = { appearance: "ha", mode: "dark", colors: { primary: "#F44336" } };
const stored = { revision: 2, zones: [{ id: "garden" }], devices: [] };

describe("messages from the host", () => {
  it("reads an init with the stored setup, states and theme", () => {
    const m = readHostMessage({ v: 1, type: "init", ...stored, states: {}, theme });
    expect(m).toEqual({ type: "init", ...stored, states: {}, theme });
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
