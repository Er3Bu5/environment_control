/* Linked zones on Overview (#91), second piece: a family drawn as one joined card with a seam and a link tab, its Parent
   badge and linked lines on the name's line, its halves kept level, and Sort moving a family as one block. The sample
   room has Nursery linked to Veg, after Garden on its own. */
import { type Frame, type Locator, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

const cards = (frame: Frame) => app(frame).locator(".zone-card");
const card = (frame: Frame, name: string) => cards(frame).filter({ has: frame.locator("h2", { hasText: new RegExp(`^${name}`) }) });
const names = (frame: Frame) => app(frame).locator(".zone-card h2").allTextContents();
const box = async (l: Locator) => (await l.boundingBox())!;
const button = (frame: Frame, name: string) => app(frame).getByRole("button", { name, exact: true });
const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
const dialog = (frame: Frame) => app(frame).getByRole("dialog");
const stored = (page: Page) => page.evaluate<{ zones: { id: string }[] }>("JSON.parse(JSON.stringify(fakeHA.config))");

/* What HA has stored, with zones renamed, read back after a restart. */
async function room(page: Page, rename: Record<string, string> = {}): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await expect(cards(frame)).toHaveCount(3);
  if (Object.keys(rename).length) {
    await page.evaluate(`(() => {
      fakeHA.knobs.restartMs = 100;
      const next = JSON.parse(fakeHA.disk);
      for (const z of next.zones) z.name = ${JSON.stringify(rename)}[z.id] ?? z.name;
      fakeHA.disk = JSON.stringify(next);
      fakeHA.restart();
    })()`);
    for (const name of Object.values(rename)) await expect(app(frame).locator(".zone-card h2", { hasText: name })).toHaveCount(1);
  }
  return frame;
}

/* Where a card's first reading row starts, inside its border and padding: a card has more padding on the seam side. */
const readingsStart = (c: Locator) =>
  c.evaluate((el) => {
    const cs = getComputedStyle(el);
    return Math.round(el.querySelector(".mrow")!.getBoundingClientRect().top - el.getBoundingClientRect().top - parseFloat(cs.borderTopWidth) - parseFloat(cs.paddingTop));
  });

test.describe("linked zones on Overview", () => {
  /* Window widths are a desktop matter: the phone project's device emulation pins its own. */
  test.skip(({ isMobile }) => isMobile, "desktop window widths");

  test("a family's cards touch on a 2px seam with the link tab on it, side by side at 1280px and stacked at 1000px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await room(page);
    const veg = card(frame, "Veg"), nursery = card(frame, "Nursery"), garden = card(frame, "Garden");
    const tab = app(frame).getByRole("img", { name: "Zone: Nursery is linked to Zone: Veg", exact: true });
    await expect(tab).toHaveAttribute("title", "Zone: Nursery is linked to Zone: Veg");
    await expect(app(frame).getByRole("group", { name: "Veg and Nursery, linked" })).toBeVisible();

    let v = await box(veg), n = await box(nursery);
    const t = await box(tab);
    const g = await box(garden);
    expect(Math.abs(v.y - n.y), "side by side").toBeLessThanOrEqual(1);
    expect(n.x - (v.x + v.width), "touching, sharing the seam").toBeLessThanOrEqual(0);
    expect(n.x - (v.x + v.width)).toBeGreaterThanOrEqual(-2.5);
    expect(v.y - (g.y + g.height), "a card on its own stands apart").toBeGreaterThanOrEqual(8);
    expect(await veg.evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("2px");
    expect(await nursery.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("2px");
    expect(await tab.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderLeftWidth])).toEqual(["2px", "2px"]);
    expect([Math.round(t.width), Math.round(t.height)]).toEqual([28, 28]);
    /* The tab sits on the seam and clears the state chips on one side and the readings' icons on the other. */
    expect(Math.abs(t.x + t.width / 2 - (n.x + 1))).toBeLessThanOrEqual(1.5);
    const clear = await app(frame).evaluate((el) => {
      const [a, b] = [...el.shadowRoot!.querySelectorAll(".fam .zone-card")], t = el.shadowRoot!.querySelector(".linktab")!.getBoundingClientRect();
      const rects = (c: Element, sel: string) => [...c.querySelectorAll(sel)].map((k) => k.getBoundingClientRect());
      return { chip: Math.min(...rects(a, ".pillcell .pill").map((r) => t.left - r.right)), icon: Math.min(...rects(b, ".mrow .ic").map((r) => r.left - t.right)) };
    });
    expect(clear.chip, "clear of the state chips").toBeGreaterThanOrEqual(10);
    expect(clear.icon, "clear of the readings' icons").toBeGreaterThanOrEqual(10);

    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => Math.round((await box(nursery)).x - (await box(veg)).x), { message: "stacked" }).toBe(0);
    v = await box(veg);
    n = await box(nursery);
    expect(n.y - (v.y + v.height), "still joined, the seam running across").toBeLessThanOrEqual(0);
    expect(n.y - (v.y + v.height)).toBeGreaterThanOrEqual(-2.5);
    expect(await veg.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("2px");
    expect(await nursery.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("2px");
    /* Measured inside the panel's frame, where the tab and both cards' text share one viewport. */
    const gaps = await app(frame).evaluate((el) => {
      const [a, b] = [...el.shadowRoot!.querySelectorAll(".fam .zone-card")], t = el.shadowRoot!.querySelector(".linktab")!.getBoundingClientRect();
      const kids = (c: Element) => [...c.children].filter((k) => !k.classList.contains("linktab")).map((k) => k.getBoundingClientRect());
      return { above: t.top - Math.max(...kids(a).map((k) => k.bottom)), below: Math.min(...kids(b).map((k) => k.top)) - t.bottom };
    });
    expect(gaps.above, "clear of the text above").toBeGreaterThanOrEqual(6);
    expect(gaps.below, "clear of the text below").toBeGreaterThanOrEqual(6);
  });

  test("the parent carries a Parent badge, and both halves say how they're linked on the name's line", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await room(page);
    const veg = card(frame, "Veg"), nursery = card(frame, "Nursery");
    await expect(veg.locator(".card-head .parentbadge")).toHaveText("Parent");
    await expect(nursery.locator(".parentbadge")).toHaveCount(0);
    await expect(card(frame, "Garden").locator(".parentbadge")).toHaveCount(0);
    await expect(card(frame, "Garden").locator(".zlinked")).toHaveCount(0);
    for (const [c, said] of [[veg, "Zone: Nursery is linked to this zone"], [nursery, "Linked to Zone: Veg"]] as const) {
      const line = c.locator(".card-head .cardnote .zlinked");
      await expect(line).toHaveText(said);
      const name = await box(c.locator("h2")), at = await box(line);
      expect(at.y, said).toBeLessThan(name.y + name.height);
      expect(at.y + at.height, said).toBeGreaterThan(name.y);
      expect(at.x, said).toBeGreaterThan(name.x + name.width);
    }
    const badge = await box(veg.locator(".parentbadge")), name = await box(veg.locator("h2"));
    expect(badge.x).toBeGreaterThan(name.x + name.width);
    expect(badge.y).toBeLessThan(name.y + name.height);
  });

  test("Setup's zone rows and a zone's own heading say how it's linked, as Overview does", async ({ page }) => {
    const frame = await room(page);
    await goTo(frame, "Setup");
    const row = (name: string) => app(frame).locator(".task", { has: frame.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
    await expect(row("Veg").locator(".zlinked")).toHaveText("Zone: Nursery is linked to this zone");
    await expect(row("Nursery").locator(".zlinked")).toHaveText("Linked to Zone: Veg");
    await expect(row("Garden").locator(".zlinked")).toHaveCount(0);
    await goTo(frame, "Overview");
    await card(frame, "Nursery").click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Nursery", exact: true })).toBeVisible();
    await expect(app(frame).locator(".pagehead .zlinked")).toHaveText("Linked to Zone: Veg");
  });

  test("the halves start their first reading row level, side by side and stacked, also when a name wraps on one half only", async ({ page }) => {
    const frame = await room(page, { nursery: "Nursery bench by the door" });
    const level = async () => [await readingsStart(card(frame, "Veg")), await readingsStart(card(frame, "Nursery"))];
    for (const width of [1000, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => { const [a, b] = await level(); return a - b; }, { message: `${width}px wide` }).toBe(0);
    }
    const long = await room(page, { nursery: "Nursery bench by the back door on the left shelf under the window" });
    await page.setViewportSize({ width: 1280, height: 900 });
    const veg = card(long, "Veg"), nursery = card(long, "Nursery");
    /* The long name wraps on its half, so the head there is taller than the parent's would be on its own. */
    await expect.poll(async () => (await box(nursery.locator("h2"))).height).toBeGreaterThan(40);
    await expect.poll(async () => (await readingsStart(veg)) - (await readingsStart(nursery))).toBe(0);
  });

  test("in Sort a family moves as one block by its strip, a card in it moves only within it, and Apply saves what was shown", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await room(page);
    await app(frame).locator(".pagehead").getByRole("button", { name: "Sort", exact: true }).click();
    const strip = app(frame).locator(".fam .fambar");
    await expect(strip).toContainText("Veg and Nursery");
    await expect(strip.getByRole("button")).toHaveCount(2);
    await expect(strip.getByRole("button", { name: "Move Veg and Nursery to previous", exact: true })).toBeEnabled();
    await expect(strip.getByRole("button", { name: "Move Veg and Nursery to next", exact: true })).toBeDisabled();
    /* Joined to the top of the family's cards. */
    const s = await box(strip), v = await box(card(frame, "Veg")), n = await box(card(frame, "Nursery"));
    expect(Math.abs(v.y - (s.y + s.height))).toBeLessThanOrEqual(1);
    expect(s.width).toBeGreaterThanOrEqual(n.x + n.width - v.x - 1);

    await expect(button(frame, "Move Veg to previous in its group")).toBeDisabled();
    await expect(button(frame, "Move Veg to next in its group")).toBeEnabled();
    await expect(button(frame, "Move Nursery to previous in its group")).toBeEnabled();
    await expect(button(frame, "Move Nursery to next in its group")).toBeDisabled();
    await expect(button(frame, "Move Garden to next")).toBeEnabled();

    await button(frame, "Move Veg and Nursery to previous").click();
    await expect.poll(() => names(frame)).toEqual(["Veg", "Nursery", "Garden"]);
    await expect(button(frame, "Move Veg and Nursery to previous")).toBeDisabled();
    await button(frame, "Move Nursery to previous in its group").click();
    await expect.poll(() => names(frame)).toEqual(["Nursery", "Veg", "Garden"]);
    /* At the family's start, a card can't step out of it. */
    await expect(button(frame, "Move Nursery to previous in its group")).toBeDisabled();
    await expect(button(frame, "Move Veg to next in its group")).toBeDisabled();
    await expect(app(frame).getByRole("img", { name: "Zone: Nursery is linked to Zone: Veg", exact: true })).toBeVisible();

    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame).locator(".review-row b")).toHaveText("Nursery, Veg, Garden");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("status").filter({ hasText: "Zone order saved." })).toBeVisible();
    expect((await stored(page)).zones.map((z) => z.id)).toEqual(["nursery", "veg", "garden"]);
    expect(await names(frame)).toEqual(["Nursery", "Veg", "Garden"]);
    await expect(app(frame).locator(".fambar")).toHaveCount(0);
  });

  test("a family moves as one block from the keyboard alone", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await room(page);
    await app(frame).locator(".pagehead").getByRole("button", { name: "Sort", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(app(frame).getByText("Sorting the cards: move them with the arrows.")).toBeFocused();
    /* Garden's previous is off, so the stops are its next, then the family's previous (its next is off at the end). */
    await page.keyboard.press("Tab");
    await expect(button(frame, "Move Garden to next")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button(frame, "Move Veg and Nursery to previous")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => names(frame)).toEqual(["Veg", "Nursery", "Garden"]);
    /* At the start its previous is off, so focus moves to its next rather than being lost. */
    await expect(button(frame, "Move Veg and Nursery to next")).toBeFocused();
    await bar(frame).getByRole("button", { name: "Review and apply" }).focus();
    await page.keyboard.press("Enter");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).focus();
    await page.keyboard.press("Enter");
    await expect(app(frame).getByRole("status").filter({ hasText: "Zone order saved." })).toBeVisible();
    expect((await stored(page)).zones.map((z) => z.id)).toEqual(["veg", "nursery", "garden"]);
  });
});
