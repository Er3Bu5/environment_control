/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, zoneMenu } from "./helpers";

test.describe("zone layout and placement", () => {
  type Zone = { id: string; layout: { w: number; d: number; units: number; rows: number; cols: number }; sensors: { id: string; pos: number[] | null; level?: string; kind?: string }[]; virtual?: { id: string; name: string; pos: number[] }[]; setup?: Record<string, string> };
  type Stored = { revision: number; zones: Zone[]; devices: { id: string; place?: Record<string, number[]> }[] };
  const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const spot = (frame: Frame, name: string) => app(frame).locator(".map").getByRole("button", { name, exact: true }).first();
  const finish = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });

  async function openFromMenu(page: Page, zone: string, item: "Zone layout" | "Device placement"): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
    await app(frame).getByRole("menuitem", { name: item }).click();
    return frame;
  }

  test("Zone layout sets the size, the units and a suggested grid, through a review", async ({ page }) => {
    const frame = await openFromMenu(page, "Veg", "Zone layout");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Zone layout: Veg", exact: true })).toBeVisible();
    await app(frame).getByLabel("Width in metres").fill("2.4");
    await finish(frame).click();
    /* More units than the grid holds re-suggests the grid straight away, as the mock does. */
    await app(frame).getByLabel("Units", { exact: true }).fill("8");
    await expect(app(frame).locator(".stepper").first()).toContainText("2");
    await expect(app(frame).locator(".stepper").last()).toContainText("4");
    await expect(app(frame).getByText(/This grid holds/)).toHaveCount(0);
    await expect(finish(frame)).toBeEnabled();
    await finish(frame).click();
    await expect(dialog(frame)).toContainText("1.2 x 1.2 m");
    await expect(dialog(frame)).toContainText("2.4 x 1.2 m");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await expect.poll(async () => (await stored(page)).zones.find((z) => z.id === "veg")?.layout).toEqual({ w: 2.4, d: 1.2, units: 8, rows: 2, cols: 4 });
  });

  test("Device placement's buttons are pinned to the foot of the window too, with the map still above them", async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 520 });
    const frame = await openFromMenu(page, "Garden", "Device placement");
    const bar = app(frame).getByRole("region", { name: "Steps", exact: true });
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device placement: Garden", exact: true })).toBeVisible();
    expect(await frame.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(100);
    await expect(bar.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    await expect(finish(frame)).toBeInViewport();
    const gap = await bar.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    expect(gap).toBeLessThanOrEqual(40);
    await frame.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const [last, top] = await bar.evaluate((el) => [el.previousElementSibling!.getBoundingClientRect().bottom, el.getBoundingClientRect().top]);
    expect(last).toBeLessThanOrEqual(top);
  });

  test("finishing or cancelling a setup editor goes back where it was opened: Setup from its menu, the zone's page from a link", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    await app(frame).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByLabel("Description, optional").fill("By the window");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View targets");
    await dialog(frame).getByRole("button", { name: "Set targets" }).click();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true })).toBeVisible();
  });

  test("a wizard's step headers go to their step: back freely, forward only past steps that are answered", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    const step = (name: string) => app(frame).locator(".steps").getByRole("button", { name, exact: true });
    const current = app(frame).locator('.steps li[aria-current="step"]');
    await expect(current).toHaveText("1. Size");
    await step("2. Units and labels").click();
    await expect(current).toHaveText("2. Units and labels");
    await step("1. Size").click();
    await expect(current).toHaveText("1. Size");
    await step("2. Units and labels").click();
    /* Fewer units strand a sensor, so placing joins the steps. A grid too small for the units, which Next wouldn't
       pass, holds a jump forward too. */
    await app(frame).getByLabel("Units", { exact: true }).fill("4");
    await app(frame).getByRole("button", { name: "Fewer columns" }).click();
    await expect(app(frame).getByText(/^This grid holds \d+ units, and you have 4\.$/)).toBeVisible();
    await step("3. Sensors and devices").click();
    await expect(current).toHaveText("2. Units and labels");
    await app(frame).getByRole("button", { name: "Suggest a grid" }).click();
    await step("3. Sensors and devices").click();
    await expect(current).toHaveText("3. Sensors and devices");
  });

  test("the zone page's map shows everything placed, with no height filter", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    /* On the zone's page it's the zone's map; putting things on it is the setup step, which keeps its name. */
    await expect(app(frame).getByRole("heading", { name: "Device placement", exact: true })).toHaveCount(0);
    const card = app(frame).locator("section.card", { has: frame.getByRole("heading", { level: 2, name: "Zone map", exact: true }) });
    await expect(card.locator(".map")).toBeVisible();
    await expect(card.getByRole("radio")).toHaveCount(0);
    await expect(card).not.toContainText("Above canopy In canopy");
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Device placement", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device placement: Garden", exact: true })).toBeVisible();
  });

  test("a unit can be given a label, which the map shows in place of its number", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    await finish(frame).click();
    /* In plain sight on the step, under its own heading, not folded away. */
    await expect(app(frame).locator(".steps")).toContainText("2. Units and labels");
    const labels = app(frame).locator(".ulabels");
    await expect(labels.getByRole("heading", { name: "Unit labels" })).toBeVisible();
    await expect(labels.getByRole("textbox")).toHaveCount(12);
    await labels.getByLabel("Label for unit 2", { exact: true }).fill("GG4");
    /* Typed text stays through the redraw every new reading causes. */
    await page.evaluate(`fakeHA.setState("input_number.garden_day_temperature_min_threshold", "22.5")`);
    await expect(labels.getByLabel("Label for unit 2", { exact: true })).toHaveValue("GG4");
    await labels.getByLabel("Label for unit 7", { exact: true }).fill("Blue Dream");
    const units = app(frame).locator(".map svg > text");
    await expect(units.nth(1)).toHaveText("GG4");
    await expect(units.nth(6)).toHaveText("Blue …");
    await expect(units.nth(0)).toHaveText("1");
    /* The keyboard's Next goes on to the next unit, and from the last one it leaves the box, which is what puts a
       phone's keyboard away and brings the bar with Review and apply back. */
    await labels.getByLabel("Label for unit 7", { exact: true }).press("Enter");
    await expect(labels.getByLabel("Label for unit 8", { exact: true })).toBeFocused();
    await labels.getByLabel("Label for unit 12", { exact: true }).press("Enter");
    expect(await frame.evaluate(() => document.querySelector("ec-app")!.shadowRoot!.activeElement)).toBeNull();
    await finish(frame).click();
    await expect(dialog(frame).locator(".review-row")).toHaveText(["Unit 2 labelNone → GG4", "Unit 7 labelNone → Blue Dream"]);
    await dialog(frame).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "garden") as unknown as { layout: { labels?: Record<string, string> } };
    expect(z.layout.labels).toEqual({ 2: "GG4", 7: "Blue Dream" });
    /* The zone's own map shows them too. */
    await goTo(frame, "Garden");
    await expect(app(frame).locator(".map svg > text").nth(1)).toHaveText("GG4");
  });

  test("a grid that strands a placed sensor carries on to the map, and can't save until it's placed again", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    await finish(frame).click();
    await app(frame).getByLabel("Units", { exact: true }).fill("4");
    await expect(app(frame).locator(".steps")).toContainText("3. Sensors and devices");
    await expect(app(frame).getByText(/no longer fits?/).first()).toBeVisible();
    await finish(frame).click();
    await expect(app(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    const fix = app(frame).getByRole("button", { name: /^Place .* to save ›$/ });
    await expect(fix).toBeVisible();
    await spot(frame, "Unit 4").click();
    await expect(app(frame).getByRole("button", { name: "Review and apply" })).toBeEnabled();
  });

  test("a soil probe goes only in a unit, an air sensor anywhere inside at a height, a device or virtual device outside too", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("button", { name: "Device placement", exact: true })).toBeDisabled();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    const row = (name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
    await row("Environment board").getByRole("button").first().click();
    await row("Soil 1").getByRole("button").first().click();
    await row("Soil 1").getByLabel("Soil 1 Substrate Normalised VWC, 85.4 %").check();
    await row("Soil 1").getByLabel("Soil 1 Substrate Pore Water EC, 2.54 mS/cm").check();
    for (let i = 0; i < 3; i++) await finish(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await app(frame).getByRole("button", { name: "Device placement", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device placement: Flower tent", exact: true })).toBeVisible();

    await app(frame).locator(".sensor-opt", { hasText: "Soil 1" }).click();
    await expect(app(frame).getByText("Tap the unit Soil 1 is in.")).toBeVisible();
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Aisle/ })).toHaveCount(0);
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Unit \d$/ })).toHaveCount(4);
    await spot(frame, "Unit 1").click();
    /* Hovering its mark says which unit it's in. */
    await expect(app(frame).locator(".map svg title", { hasText: /^Soil 1/ })).toHaveText("Soil 1, unit 1");
    /* A soil probe is in the substrate, so it's asked no height. */
    await expect(app(frame).getByRole("group", { name: /^Height of Soil 1/ })).toHaveCount(0);
    /* A tap on the one that's picked lets go of it, in the list and on the map. */
    const soil = app(frame).locator(".sensor-opt", { hasText: "Soil 1" }), mark = app(frame).locator(".map").getByRole("button", { name: /^Select Soil 1/ });
    await expect(soil).toHaveAttribute("aria-pressed", "true");
    await soil.click();
    await expect(soil).toHaveAttribute("aria-pressed", "false");
    await expect(app(frame).getByText("Pick a sensor or device.")).toBeVisible();
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Unit \d$/ })).toHaveCount(0);
    await mark.click();
    await expect(soil).toHaveAttribute("aria-pressed", "true");
    await mark.click();
    await expect(soil).toHaveAttribute("aria-pressed", "false");

    await app(frame).locator(".sensor-opt", { hasText: "Environment board" }).click();
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Outside the wall/ })).toHaveCount(0);
    await spot(frame, "Aisle between rows 1 and 2").click();
    /* An air sensor can't be saved until its height is chosen. */
    await expect(app(frame).locator(".sensor-opt", { hasText: "Environment board" })).toContainText("Needs a height");
    await expect(finish(frame)).toBeDisabled();
    await app(frame).getByRole("button", { name: "Set Environment board's height to save" }).click();
    await app(frame).getByLabel("In canopy").check();
    await expect(finish(frame)).toBeEnabled();

    /* Placement only places. Adding, naming and removing a device is Device identification's, a button away, and what's
       been placed so far is still here on the way back. */
    await expect(app(frame).getByLabel("Add a virtual device")).toHaveCount(0);
    await app(frame).getByRole("button", { name: "Add or edit devices" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Flower tent", exact: true })).toBeVisible();
    await expect(app(frame).locator('.steps li[aria-current="step"]')).toHaveText("2. Devices");
    /* In the accent colour, above everything Home Assistant lists, so it's found without scrolling. */
    const add = app(frame).getByRole("button", { name: "Add a virtual device" });
    await expect(add).toHaveClass(/\bprimary\b/);
    expect((await add.boundingBox())!.y).toBeLessThan((await app(frame).getByLabel("Search Home Assistant").boundingBox())!.y);
    await add.click();
    const tank = app(frame).locator(".pickwrap.virt"), name = tank.getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    /* What's in the way of Next is said in the bar, which a touch screen shows once the box is left. */
    await name.press("Enter");
    await expect(finish(frame)).toBeDisabled();
    await expect(app(frame).getByRole("button", { name: "A virtual device needs a name. ›" })).toBeVisible();
    /* A typed name stays in the box through the redraw every new reading causes. */
    await name.fill("Drain");
    await page.evaluate(`fakeHA.setState("input_number.garden_day_temperature_min_threshold", "22.5")`);
    await expect(name).toHaveValue("Drain");
    await name.fill("Drain tank");
    await tank.getByLabel("Tank", { exact: true }).check();
    await app(frame).getByRole("button", { name: "Add a virtual device" }).click();
    await expect(app(frame).locator(".pickwrap.virt")).toHaveCount(2);
    await app(frame).locator(".pickwrap.virt").last().getByRole("button", { name: "Remove this virtual device" }).click();
    await expect(app(frame).locator(".pickwrap.virt")).toHaveCount(1);
    await finish(frame).click();
    await expect(app(frame).locator(".review")).toContainText("1 virtual device");
    await finish(frame).click();
    await expect(dialog(frame)).toContainText("Drain tank, virtual");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device placement: Flower tent", exact: true })).toBeVisible();
    await expect(app(frame).locator(".sensor-opt", { hasText: "Soil 1" })).toContainText("Unit 1");
    await expect(app(frame).locator(".sensor-opt", { hasText: "Environment board" })).toContainText("Aisle between rows 1 and 2");
    await expect(app(frame).locator(".sensor-opt", { hasText: "Drain tank" })).toContainText("Needs placing");
    await expect(app(frame).locator(".sensor-opt", { hasText: "Drain tank" })).toHaveAttribute("aria-pressed", "true");
    await expect(finish(frame)).toBeDisabled();
    await spot(frame, "Outside the wall, by unit 1").click();

    await finish(frame).click();
    await expect(dialog(frame)).toContainText("Soil 1 position");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.setup?.place).toBe("done");
    expect(z?.sensors.map((x) => [x.id, x.kind, x.pos, x.level ?? null])).toEqual([
      ["d-board", "env", [0.5, 0], "in"],
      ["d-soil", "soil", [0, 0], null],
    ]);
    expect(z?.virtual).toEqual([{ id: "v-drain_tank", name: "Drain tank", pos: [-1, -1], type: "Tank" }]);
  });

  test("a zone's page shows its map, and names devices that aren't on it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const map = app(frame).getByRole("group", { name: "Units, sensors and devices in Garden" });
    await expect(map).toBeVisible();
    await expect(map.getByRole("button", { name: /^Select Environment left, / })).toHaveCount(1);
    await expect(app(frame).getByRole("button", { name: "Place devices ›" })).toHaveCount(await app(frame).getByText(/on the map: /).count());
  });
});
