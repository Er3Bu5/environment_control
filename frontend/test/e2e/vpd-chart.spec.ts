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

