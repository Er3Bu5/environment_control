/* Every list that drops from a control lies over the page and closes when you leave it (#160): helper search boxes,
   Device identification's entity search and the menus, through the one mechanism in droplist.ts. */
import { type Frame, type Locator, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

async function targets(page: Page): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: "Set up Garden" }).click();
  await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
  return frame;
}

const scrollHeight = (frame: Frame) => frame.evaluate(() => document.documentElement.scrollHeight);
const y = async (l: Locator) => (await l.boundingBox())?.y ?? NaN;
/* Where a list sits in the frame's own window, which is what it's fixed to. */
const inFrame = (l: Locator) => l.evaluate((el) => ({ ...el.getBoundingClientRect().toJSON(), view: window.innerHeight }));

/* Opening and closing a list moves nothing: the page is as tall as before and the line under the box stays put. */
async function liesOver(frame: Frame, picker: Locator): Promise<void> {
  const under = picker.locator(":scope > p"), search = picker.getByRole("combobox");
  /* A phone gives the page room below a focused search box and moves the box up, on purpose, so there it's the gap
     between the box and the line under it that must not change. */
  const phone = await frame.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const tall = await scrollHeight(frame), gap = (await y(under)) - (await y(search));
  await search.focus();
  await expect(picker.getByRole("listbox")).toBeVisible();
  expect(await picker.getByRole("option").count()).toBeGreaterThan(1);
  if (!phone) expect(await scrollHeight(frame)).toBe(tall);
  await frame.page().waitForTimeout(400);
  expect((await y(under)) - (await y(search))).toBe(gap);
  const list = await picker.getByRole("listbox").boundingBox(), box = await search.boundingBox(), at = await y(under);
  /* Laid over the line under its box, not beside it. */
  expect(list && box && list.y >= box.y + box.height - 1 && list.y < at + 4).toBe(true);
}

test.describe("lists dropped from a control", () => {
  test("a helper picker lies over the page, and only one is ever open", async ({ page }) => {
    const frame = await targets(page);
    const on = app(frame).locator("#sh-on"), off = app(frame).locator("#sh-off");
    await liesOver(frame, on);
    await off.getByRole("combobox").click();
    await expect(off.getByRole("listbox")).toBeVisible();
    await expect(app(frame).getByRole("listbox")).toHaveCount(1);
    await expect(on.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });

  test("a click on the page, Escape, a pick and Tab each close it", async ({ page }) => {
    const frame = await targets(page);
    const on = app(frame).locator("#sh-on"), search = on.getByRole("combobox"), list = on.getByRole("listbox");
    await search.click();
    await expect(list).toBeVisible();
    await app(frame).getByRole("heading", { level: 1 }).click();
    await expect(list).toHaveCount(0);

    await search.click();
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-expanded", "false");
    /* The arrow opens it again from the box, and moves through it with focus still there. */
    await page.keyboard.press("ArrowDown");
    await expect(list).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-activedescendant", "sh-on-o0");

    await page.keyboard.press("Tab");
    await expect(list).toHaveCount(0);
    expect(await app(frame).evaluate((el) => el.shadowRoot?.activeElement?.getAttribute("role") ?? "")).not.toBe("listbox");

    await search.click();
    await list.getByRole("option").nth(1).click();
    await expect(list).toHaveCount(0);
  });

  test("near the foot of the window it opens upwards, wholly in view", async ({ page }, info) => {
    test.skip(info.project.name === "phone", "a phone moves a focused search box to the top of the window, so its list drops below");
    const frame = await targets(page);
    const picker = app(frame).locator("#sh-on"), search = picker.getByRole("combobox");
    /* A window just tall enough to show the box, near its foot. */
    const page0 = await search.boundingBox();
    await page.setViewportSize({ width: 1280, height: Math.round((page0?.y ?? 0) + (page0?.height ?? 0) + 40) });
    const box = await inFrame(search);
    expect(box.bottom).toBeGreaterThan(box.view - 120);
    await search.focus();
    const list = await inFrame(picker.getByRole("listbox"));
    expect(list.bottom).toBeLessThanOrEqual(box.top);
    expect(list.top).toBeGreaterThanOrEqual(0);
    /* It follows its box when the page scrolls, and closes once the box has left the view. */
    await frame.evaluate(() => window.scrollBy(0, 20));
    await expect.poll(async () => Math.round((await inFrame(picker.getByRole("listbox"))).bottom)).toBe(Math.round(list.bottom - 20));
    await frame.evaluate(() => window.scrollBy(0, 2000));
    await expect(picker.getByRole("listbox")).toHaveCount(0);
  });

  test("Device identification's entity search lies over the page too", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await app(frame).getByRole("dialog").getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    const row = (name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
    await row("Environment board").getByRole("button").first().click();
    await row("Two probe board").getByRole("button").first().click();
    await row("Two probe board").getByLabel("Top temp, 23 °C").check();
    await app(frame).getByRole("button", { name: "Next", exact: true }).click();
    await row("Spare Plug").getByRole("button").first().click();
    const picker = app(frame).locator("#swap-md-switch_spare_plug");
    await expect(picker.getByRole("combobox")).toHaveAttribute("placeholder", "Search to move it to another entity");
    await liesOver(frame, picker);
    await app(frame).getByRole("heading", { level: 1 }).click();
    await expect(picker.getByRole("listbox")).toHaveCount(0);
  });

  test("a menu closes when a picker opens, and a picker when a menu opens", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    const alerts = app(frame).locator("#room-alerts");
    await alerts.getByRole("button", { name: /^Link (a helper|another)$/ }).click();
    const search = alerts.getByRole("combobox"), list = alerts.getByRole("listbox");
    const burger = app(frame).getByRole("button", { name: "Set up Garden" }), menu = app(frame).locator(`#${await burger.getAttribute("aria-controls")}`);
    await burger.click();
    await expect(menu).toBeVisible();
    /* Reached by the keyboard as much as by a press. */
    await search.focus();
    await expect(list).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(burger).toHaveAttribute("aria-expanded", "false");
    await burger.click();
    await expect(menu).toBeVisible();
    await expect(list).toHaveCount(0);
  });
});
