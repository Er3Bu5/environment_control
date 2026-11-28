import { describe, expect, it } from "vitest";
import { dropControlGone, placeDrop } from "../../src/frame/droplist";

const view = { top: 0, h: 800, w: 1280 };
const box = (top: number, left = 100, width = 300) => ({ top, bottom: top + 40, left, right: left + width, width });

describe("placeDrop", () => {
  it("drops below its control when there's room", () => {
    const at = placeDrop(box(100), view, { full: 200, row: 40, width: 300 });
    expect(at).toEqual({ top: 144, left: 100, maxHeight: 200, up: false });
  });

  it("opens upwards near the bottom, ending just above its control", () => {
    const at = placeDrop(box(700), view, { full: 200, row: 40, width: 300 });
    expect(at.up).toBe(true);
    expect(at.top + at.maxHeight).toBe(696);
    expect(at.top).toBeGreaterThanOrEqual(0);
  });

  it("caps a long list at 40% of what can be seen, so it scrolls inside itself", () => {
    const at = placeDrop(box(50), view, { full: 2000, row: 40, width: 300 });
    expect(at.maxHeight).toBe(320);
  });

  it("keeps at least four rows where they fit, on a short view", () => {
    const at = placeDrop(box(20), { top: 0, h: 300, w: 400 }, { full: 2000, row: 40, width: 300 });
    expect(at.maxHeight).toBe(170);
  });

  it("is clamped inside the view's width", () => {
    expect(placeDrop(box(100, 1200, 60), view, { full: 100, row: 40, width: 300 }).left).toBe(972);
    expect(placeDrop(box(100, -50), view, { full: 100, row: 40, width: 300 }).left).toBe(8);
  });

  it("lines a menu's right edge up with its button's", () => {
    expect(placeDrop(box(100, 600, 40), view, { full: 100, row: 40, width: 220 }, true).left).toBe(420);
  });

  it("stays above a phone's keyboard, inside the visible part of the window", () => {
    const keys = { top: 0, h: 400, w: 400 };
    const at = placeDrop(box(330, 16, 360), keys, { full: 400, row: 40, width: 360 });
    expect(at.up).toBe(true);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.top + at.maxHeight).toBeLessThanOrEqual(330);
  });
});

describe("dropControlGone", () => {
  it("is true once the control has scrolled out of view or isn't laid out", () => {
    expect(dropControlGone(box(100), view)).toBe(false);
    expect(dropControlGone(box(-60), view)).toBe(true);
    expect(dropControlGone(box(900), view)).toBe(true);
    expect(dropControlGone({ ...box(100), width: 0 }, view)).toBe(true);
  });
});
