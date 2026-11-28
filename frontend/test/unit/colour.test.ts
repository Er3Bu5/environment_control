import { describe, expect, it } from "vitest";
import { onColor } from "../../src/frame/colour";
import { PALETTES } from "../../src/frame/styles";

describe("onColor", () => {
  it("puts near-black on HA's default blue and on a red accent, where white falls short of 4.5:1", () => {
    expect(onColor("#03A9F4")).toBe("#111111");
    expect(onColor("#F44336")).toBe("#111111");
    expect(onColor("rgb(255, 235, 59)")).toBe("#111111");
  });
  it("puts white on a dark primary", () => {
    expect(onColor("#1A237E")).toBe("#FFFFFF");
    expect(onColor("#000")).toBe("#FFFFFF");
  });
  it("is what the built-in palettes carry", () => {
    for (const p of Object.values(PALETTES)) expect(p["on-primary"]).toBe(onColor(p.primary));
  });
});
