/* The VPD chart on Targets: which limit is selected, axes that fit the zone's limits, and grabbing the right line. */
import { type Frame, type Locator, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

async function open(page: Page, zone: string, dark = false): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  if (dark) await app(frame).getByRole("button", { name: "Dark", exact: true }).click();
  await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
  await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: `Targets, day and night: ${zone}`, exact: true })).toBeVisible();
  return frame;
}
const card = (frame: Frame) => app(frame).locator("#td-targets");
const chart = (frame: Frame) => card(frame).locator("#vwrap svg");
const pick = (frame: Frame, group: string, name: string) => card(frame).getByRole("group", { name: group }).getByRole("button", { name, exact: true }).click();
const box = (frame: Frame, label: string) => card(frame).getByLabel(label, { exact: true });
const type = async (frame: Frame, label: string, value: string) => {
  await box(frame, label).fill(value);
  await box(frame, label).press("Enter");
};
/* The stakeholder's limits: Min 13 sat off the old 16 to 34 degree axis, on top of Low. */
async function stakeholderLimits(frame: Frame) {
  await pick(frame, "Period", "Day");
  await pick(frame, "Target", "No target");
  await type(frame, "Temperature Min", "13");
  await type(frame, "Temperature Low", "16");
  await type(frame, "Temperature High", "21");
  await type(frame, "Temperature Max", "21");
  await pick(frame, "What to edit", "Temperature");
  await centred(frame);
}
/* Centred, clear of the bar of unsaved changes along the foot of a phone's window. */
const centred = (frame: Frame) => chart(frame).evaluate((el) => el.scrollIntoView({ block: "center" }));
const ticks = (frame: Frame) => chart(frame).locator("[data-vtick]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-vtick"))));
const centre = async (l: Locator) => {
  const r = await l.boundingBox();
  if (!r) throw new Error("not drawn");
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
/* Page x of a temperature, read off the axis labels as drawn now, since the axis follows the limits. */
async function xOf(frame: Frame) {
  const t = chart(frame).locator("[data-vtick]"), [a, b] = [await centre(t.nth(0)), await centre(t.nth(1))];
  const [ta, tb] = (await ticks(frame)).slice(0, 2);
  return (deg: number) => a.x + ((deg - ta) * (b.x - a.x)) / (tb - ta);
}
const lineX = async (frame: Frame, i: number) => (await centre(chart(frame).locator(`[data-vline="temperature:${i}"]`))).x;

test("with Min 13, Low 16, High 21 and Max 21 the axis runs 8 to 26 and every limit has its own place inside the plot", async ({ page }) => {
  const frame = await open(page, "Nursery");
  await stakeholderLimits(frame);
  const t = await ticks(frame);
  expect([t[0], t[t.length - 1]]).toEqual([8, 26]);
  const r = await chart(frame).boundingBox();
  if (!r) throw new Error("no chart");
  const [min, low, high, max] = [await lineX(frame, 0), await lineX(frame, 1), await lineX(frame, 3), await lineX(frame, 4)];
  const x = await xOf(frame);
  for (const v of [min, low, high, max]) expect(v).toBeGreaterThan(x(8) - 1), expect(v).toBeLessThan(x(26) + 1);
  expect(min).toBeLessThan(low - 20);
  expect(low).toBeLessThan(high - 20);
  expect(Math.abs(high - max)).toBeLessThan(1);
  expect(Math.abs(min - x(13))).toBeLessThan(2);
});

test("the selected limit's label is in the accent colour and the others are not", async ({ page }) => {
  const frame = await open(page, "Nursery");
  await stakeholderLimits(frame);
  const x = await xOf(frame), mid = (await chart(frame).boundingBox())!;
  await page.mouse.click(x(16), mid.y + mid.height / 2);
  await expect(card(frame).locator(".now")).toContainText("Temperature Low 16°");
  const fills = await chart(frame).evaluate((svg) => {
    const probe = document.createElement("i");
    probe.style.color = "var(--primary)";
    svg.parentElement?.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { accent, flags: [0, 1, 3, 4].map((i) => getComputedStyle(svg.querySelector(`[data-vflag="${i}"] rect`) as Element).fill) };
  });
  expect(fills.flags[1]).toBe(fills.accent);
  for (const i of [0, 2, 3]) expect(fills.flags[i]).not.toBe(fills.accent);
  expect(await chart(frame).locator('[data-vline="temperature:1"]').getAttribute("stroke")).toBe("var(--primary)");
  expect(await chart(frame).locator('[data-vline="temperature:0"]').getAttribute("stroke")).toBe("var(--vline)");
});

test("the axis holds still through a drag and makes room once the line is let go at the edge; the arrow keys carry on", async ({ page }) => {
  const frame = await open(page, "Nursery");
  await pick(frame, "Period", "Day");
  await pick(frame, "What to edit", "Temperature");
  await centred(frame);
  const before = await ticks(frame), x = await xOf(frame), r = (await chart(frame).boundingBox())!, y = r.y + r.height / 2;
  expect([before[0], before[before.length - 1]]).toEqual([16, 34]);
  await page.mouse.move(x(28), y);
  await page.mouse.down();
  await page.mouse.move(x(34.4), y, { steps: 6 });
  await expect(box(frame, "Temperature Max")).toHaveValue("34");
  expect(await ticks(frame)).toEqual(before);
  await page.mouse.up();
  await expect.poll(async () => (await ticks(frame)).at(-1)).toBeGreaterThan(34);
  await page.keyboard.press("ArrowRight");
  await expect(box(frame, "Temperature Max")).toHaveValue("34.5");
});

test("a press on coinciding High and Max moves the selected one, or else Max; a press on a label takes its limit", async ({ page }) => {
  const frame = await open(page, "Nursery");
  await stakeholderLimits(frame);
  const x = await xOf(frame), r = (await chart(frame).boundingBox())!, y = r.y + r.height * 0.6;
  const high = await centre(chart(frame).locator('[data-vflag="3"]'));
  await page.mouse.click(high.x, high.y);
  await expect(card(frame).locator(".now")).toContainText("Temperature High 21°");
  await expect(box(frame, "Temperature High")).toHaveValue("21");
  await page.mouse.move(x(21), y);
  await page.mouse.down();
  await page.mouse.move(x(19), y, { steps: 4 });
  await page.mouse.up();
  await expect(box(frame, "Temperature High")).toHaveValue("19");
  await expect(box(frame, "Temperature Max")).toHaveValue("21");
  await type(frame, "Temperature High", "21");
  await pick(frame, "What to edit", "Humidity");
  await pick(frame, "What to edit", "Temperature");
  await centred(frame);
  const x2 = await xOf(frame), r2 = (await chart(frame).boundingBox())!, y2 = r2.y + r2.height * 0.6;
  await page.mouse.move(x2(21), y2);
  await page.mouse.down();
  await page.mouse.move(x2(23), y2, { steps: 4 });
  await page.mouse.up();
  await expect(box(frame, "Temperature Max")).toHaveValue("23");
  await expect(box(frame, "Temperature High")).toHaveValue("21");
});

/* WCAG contrast of two computed colours; Chromium gives a color-mix() result as color(srgb r g b) in 0 to 1. */
const contrast = (fg: string, bg: string) => {
  const rgb = (c: string) => {
    const n = (c.match(/[\d.]+/g) ?? []).map(Number);
    return c.startsWith("color(") ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3);
  };
  const lum = (c: string) => {
    const [r, g, b] = rgb(c).map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

for (const dark of [false, true])
  for (const width of [1280, 500])
    test(`the leaf offset line sits at the left right above the chart, in the accent text colour, ${dark ? "dark" : "light"} at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const frame = await open(page, "Nursery", dark);
      await centred(frame);
      const leaf = card(frame).locator("#vleaf"), button = leaf.getByRole("button", { name: "Change the leaf temperature offset", exact: true });
      await expect(leaf.locator("span")).toHaveText("Leaf 1.0 °C below air");
      await expect(button).toHaveText("Change ›");
      const [l, c, g] = [await leaf.boundingBox(), await card(frame).boundingBox(), await chart(frame).boundingBox()];
      if (!l || !c || !g) throw new Error("not drawn");
      expect(l.x - c.x).toBeLessThan(c.width / 3);
      expect(g.y - (l.y + l.height)).toBeGreaterThanOrEqual(0);
      expect(g.y - l.y).toBeLessThan(80);
      const seen = await leaf.evaluate((el) => {
        const probe = document.createElement("i");
        probe.style.color = "var(--primary-text)";
        el.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        const btn = el.querySelector("button") as Element, text = el.querySelector("span") as Element, cardEl = el.closest(".card") as Element;
        return { want, text: getComputedStyle(text).color, label: getComputedStyle(btn).color, border: getComputedStyle(btn).borderTopColor, card: getComputedStyle(cardEl).backgroundColor };
      });
      expect([seen.text, seen.label, seen.border]).toEqual([seen.want, seen.want, seen.want]);
      expect(contrast(seen.want, seen.card)).toBeGreaterThanOrEqual(4.5);
      if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    });

test("the leaf offset Change opens Sensor Calibration, keeping the chart's unsaved edits, and Back returns to the chart", async ({ page }) => {
  const frame = await open(page, "Nursery");
  await pick(frame, "Period", "Day");
  await type(frame, "Temperature Max", "29");
  await card(frame).getByRole("button", { name: "Change the leaf temperature offset", exact: true }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Nursery", exact: true })).toBeVisible();
  await app(frame).getByRole("button", { name: "Back", exact: true }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Nursery", exact: true })).toBeVisible();
  await pick(frame, "Period", "Day");
  await expect(box(frame, "Temperature Max")).toHaveValue("29");
  await expect(chart(frame)).toBeVisible();
});
