import { describe, expect, it } from "vitest";
import { levelledHeights } from "../../src/frame/heads";

describe("levelledHeights", () => {
  it("gives every head in a row the tallest one's height", () => {
    expect(levelledHeights([{ top: 100, height: 24 }, { top: 100.3, height: 48 }, { top: 100, height: 24 }])).toEqual([48, null, 48]);
  });
  it("levels each row on its own", () => {
    expect(levelledHeights([{ top: 100, height: 24 }, { top: 100, height: 30 }, { top: 400, height: 50 }, { top: 400, height: 24 }])).toEqual([30, null, null, 50]);
  });
  it("leaves heads alone that differ by under half a pixel, so rounding never sets a height", () => {
    expect(levelledHeights([{ top: 0, height: 24 }, { top: 0, height: 24.4 }])).toEqual([null, null]);
  });
  it("has nothing to do for no heads or one", () => {
    expect(levelledHeights([])).toEqual([]);
    expect(levelledHeights([{ top: 0, height: 24 }])).toEqual([null]);
  });
});
