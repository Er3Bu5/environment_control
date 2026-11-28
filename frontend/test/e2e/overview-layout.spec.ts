/* Overview's zone cards: how many go across at each width, how wide one card gets on its own, and that the cards in a row
   start their readings level whatever their title line holds (#119). */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

test.describe("overview layout", () => {
  /* Window widths are a desktop matter: the phone project's device emulation pins its own. */
  test.skip(({ isMobile }) => isMobile, "desktop window widths");

  const cards = (frame: Frame) => app(frame).locator(".zone-card");
  const LONG = "A zone with a very long name that runs on well past the width of its card";

  /* What HA has stored, plus empty zones copied from Veg until there are `count`, read back after a restart. */
  async function zones(page: Page, count: number, rename: Record<string, string> = {}): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(cards(frame)).toHaveCount(3);
    await page.evaluate(`(() => {
      fakeHA.knobs.restartMs = 100;
      const next = JSON.parse(fakeHA.disk), veg = next.zones.find((z) => z.id === "veg");
      for (let i = next.zones.length + 1; i <= ${count}; i++) next.zones.push({ ...veg, id: "zone_" + i, name: "Zone " + i, sensors: [], automations: [] });
      for (const z of next.zones) z.name = ${JSON.stringify(rename)}[z.id] ?? z.name;
      fakeHA.disk = JSON.stringify(next);
      fakeHA.restart();
    })()`);
    await expect(cards(frame)).toHaveCount(count);
    return frame;
  }
  /* How many cards share the first card's row. */
  const firstRow = (frame: Frame) =>
    app(frame).evaluate((el) => {
      const tops = [...el.shadowRoot!.querySelectorAll(".zone-card")].map((c) => Math.round(c.getBoundingClientRect().top));
      return tops.filter((t) => t === tops[0]).length;
    });

  test("one card across below two at 520px each, two up to three at 640px each, four on an ultrawide window", async ({ page }) => {
    const frame = await zones(page, 5);
    for (const [width, across] of [[700, 1], [900, 1], [1000, 1], [1100, 2], [1280, 2], [2300, 3], [3440, 4]]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => firstRow(frame), { message: `${width}px wide` }).toBe(across);
    }
  });

  test("one across, a card stops at 700px and sits in the middle", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    const frame = await zones(page, 3);
    const grid = (await app(frame).locator(".cards:has(> .zone-card)").boundingBox())!, card = (await cards(frame).first().boundingBox())!;
    expect(card.width).toBeLessThanOrEqual(700.5);
    expect(card.width).toBeGreaterThan(650);
    expect(Math.abs(card.x - grid.x - (grid.x + grid.width - card.x - card.width))).toBeLessThanOrEqual(1);
  });

  test("two across, a reading's track is never shorter than 150px", async ({ page }) => {
    const frame = await zones(page, 3);
    for (let width = 1100; width <= 1900; width += 200) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => firstRow(frame), { message: `${width}px wide` }).toBe(2);
      const track = (await cards(frame).first().locator(".mrow .track").first().boundingBox())!;
      expect(track.width, `${width}px wide`).toBeGreaterThanOrEqual(150);
    }
  });

  test("a long name wraps, and its neighbour's readings still start level with its own", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await zones(page, 3, { veg: LONG });
    const long = cards(frame).filter({ hasText: LONG }), garden = cards(frame).filter({ hasText: "Garden" });
    await expect.poll(() => firstRow(frame)).toBe(2);
    /* Wrapped onto more than one line, not cut off. */
    expect((await long.locator("h2").boundingBox())!.height).toBeGreaterThan(40);
    await expect(long.locator("h2")).toHaveText(LONG);
    await expect.poll(async () => Math.abs((await long.locator(".mrow").first().boundingBox())!.y - (await garden.locator(".mrow").first().boundingBox())!.y)).toBeLessThanOrEqual(1);
  });

  /* Sensor states as HA would hold them, updated just now. The page declares fakeHA with const: reached as an expression. */
  const setStates = (page: Page, states: Record<string, string>) =>
    page.evaluate(`(() => {
      for (const [e, state] of Object.entries(${JSON.stringify(states)}))
        fakeHA.states[e] = { entity_id: e, state, attributes: {}, context: { user_id: null, parent_id: null }, last_updated: new Date(Date.now() - 5000).toISOString() };
      fakeHA.publish();
    })()`);

  test("how a zone's sensors were combined is said on its name's line", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(PAGE);
    await setStates(page, {
      "sensor.environment_board_air_temp": "24", "sensor.environment_board_humidity": "60", "sensor.environment_board_vpd": "1.2", "sensor.environment_board_light": "40000",
      "sensor.two_probe_top_temp": "22", "sensor.two_probe_low_temp": "21", "sensor.two_probe_humidity": "70",
    });
    const frame = await panelFrame(page), dialog = app(frame).getByRole("dialog");
    const row = (name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog.getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await row("Environment board").getByRole("button").first().click();
    await row("Two probe board").getByRole("button").first().click();
    await row("Two probe board").getByLabel(/^Top temp,/).check();
    for (let i = 0; i < 3; i++) await app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ }).click();
    await dialog.getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await goTo(frame, "Overview");
    const card = cards(frame).filter({ hasText: "Flower tent" }), note = card.locator(".card-head .cardnote");
    await expect(note).toHaveText("Average of 2 sensors");
    const name = (await card.locator("h2").boundingBox())!, said = (await note.boundingBox())!;
    expect(said.y).toBeLessThan(name.y + name.height);
    expect(said.y + said.height).toBeGreaterThan(name.y);
    expect(said.x).toBeGreaterThan(name.x + name.width);
  });
});
