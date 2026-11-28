/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, dialogFoot, goTo, hostDialogOpen, hostDialogText, leaveAsks, panelFrame, serviceCalls } from "./helpers";

test.describe("map devices", () => {
  type Stored = { revision: number; zones: { id: string; sensors: Record<string, unknown>[]; setup?: Record<string, string>; combine?: { env: string } }[]; devices: Record<string, unknown>[] };
  const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const row = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
  const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });

  /* A zone added through the panel, then its setup guide's Map devices. */
  async function newZoneMap(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Flower tent", exact: true })).toBeVisible();
    return frame;
  }

  async function pickAll(frame: Frame): Promise<void> {
    await row(frame, "Environment board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByLabel("Top temp, 23 °C").check();
    await next(frame).click();
    await row(frame, "Spare Plug").getByRole("button").first().click();
    await row(frame, "Spare Plug").getByLabel("Heater").check();
    await row(frame, "Garden Dehumidifier").getByRole("button").first().click();
    /* It's Garden's too, so it asks first. */
    await app(frame).getByRole("alertdialog").getByRole("button", { name: "Add", exact: true }).click();
    await next(frame).click();
  }

  test("a board's readings are matched for it, two candidates ask, and Next waits for every answer", async ({ page }) => {
    const frame = await newZoneMap(page);
    await expect(next(frame)).toBeDisabled();
    await row(frame, "Environment board").getByRole("button").first().click();
    const board = row(frame, "Environment board");
    await expect(board.getByLabel("Air temp, 24.1 °C")).toBeChecked();
    await expect(board.getByLabel("Light, 41,200 lx")).toBeChecked();
    await expect(board.getByLabel("Chip temp, 41 °C")).toHaveCount(0);
    await expect(board.getByText("Leaf temperature offset")).toHaveCount(0);
    await expect(next(frame)).toBeEnabled();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await expect(row(frame, "Two probe board")).toContainText("Pick one");
    await expect(next(frame)).toBeDisabled();
    await expect(app(frame).getByRole("button", { name: "Two probe board: pick which Temperature entity to use. ›" })).toBeVisible();
    await row(frame, "Two probe board").getByLabel("Low temp, 21.4 °C").check();
    await expect(next(frame)).toBeEnabled();
    await expect(app(frame).getByText("How should these 2 environment sensors combine into the zone's reading?")).toBeVisible();
    await next(frame).click();
    await row(frame, "Spare Plug").getByRole("button").first().click();
    await expect(row(frame, "Spare Plug")).toContainText("What is it?");
    await expect(next(frame)).toBeDisabled();
    await row(frame, "Spare Plug").getByLabel("Heater").check();
    await row(frame, "Garden Dehumidifier").getByRole("button").first().click();
    await app(frame).getByRole("alertdialog").getByRole("button", { name: "Add", exact: true }).click();
    await expect(row(frame, "Garden Dehumidifier").getByLabel("Dehumidifier")).toBeChecked();
    await next(frame).click();
    await expect(app(frame).locator(".review")).toContainText("Spare Plug (Heater), Garden Dehumidifier (Dehumidifier)");
  });

  test("a long review keeps its title and buttons in the window, and its list scrolls between them", async ({ page }) => {
    const frame = await newZoneMap(page);
    await pickAll(frame);
    await page.setViewportSize({ width: 740, height: 360 });
    await next(frame).click();
    const box = dialog(frame);
    expect(await box.locator(".review-scroll").evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);
    await expect(box.getByRole("heading", { name: "Review changes" })).toBeInViewport({ ratio: 1 });
    await dialogFoot(box, ["Back to editing", /^Apply \d+ changes$/]);
  });

  test("ticking a device another zone has asks first, and only Add ticks it; the review and Home Assistant's question follow as before", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    await next(frame).click();
    const dehu = row(frame, "Garden Dehumidifier").locator(".pickrow"), ask = app(frame).getByRole("alertdialog");
    await dehu.click();
    /* The title is the device's own name: the question only says "This device". */
    await expect(ask.getByRole("heading", { name: "Garden Dehumidifier", exact: true })).toBeFocused();
    await expect(ask.locator("#dlg-text")).toHaveText("This device is already associated to Zone: Garden. Are you sure you want to duplicate it here?");
    await expect(ask.locator("#dlg-more")).toHaveText("This means that controls are in sync in both zones. Automations from Garden may affect the device state.");
    await dialogFoot(ask, ["Cancel", "Add"]);
    /* Adding loses nothing, so it's the usual button, not the red one. */
    await expect(ask.getByRole("button", { name: "Add", exact: true })).not.toHaveClass(/danger/);
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    /* Cancel, Escape and the back gesture all leave it out. */
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(ask).toHaveCount(0);
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    await dehu.click();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    await dehu.click();
    await expect(ask).toHaveCount(1);
    await page.evaluate(() => history.back());
    await expect(ask).toHaveCount(0);
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Flower tent", exact: true })).toBeVisible();
    await dehu.click();
    await ask.getByRole("button", { name: "Add", exact: true }).click();
    await expect(ask).toHaveCount(0);
    await expect(dehu).toHaveAttribute("aria-pressed", "true");
    await expect(row(frame, "Garden Dehumidifier")).toContainText("Shared. Also in Garden.");
    /* Unticking never asks, and neither does a device no other zone has. */
    await dehu.click();
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    await row(frame, "Spare Plug").locator(".pickrow").click();
    await expect(ask).toHaveCount(0);
    await expect(row(frame, "Spare Plug").locator(".pickrow")).toHaveAttribute("aria-pressed", "true");
    await row(frame, "Spare Plug").getByLabel("Heater").check();
    await dehu.click();
    await ask.getByRole("button", { name: "Add", exact: true }).click();
    expect(await serviceCalls(page)).toBe(0);
    await next(frame).click();
    await expect(app(frame).locator(".review")).toContainText("Spare Plug (Heater), Garden Dehumidifier (Dehumidifier)");
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    /* Home Assistant still asks before the newly switchable plug is saved. */
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.waitForTimeout(1100);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    /* Applying stays on the step, with nothing left to apply; Finish goes back to the guide. */
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const saved = await stored(page);
    expect(saved.devices.find((d) => d.entity === "humidifier.garden_dehumidifier")?.zones).toEqual(["garden", "flower_tent"]);
    /* Now Flower tent has it saved, that sharing was agreed to: unticked and ticked again, it doesn't ask. */
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await app(frame).locator(".steps").getByRole("button", { name: "2. Devices", exact: true }).click();
    await expect(dehu).toHaveAttribute("aria-pressed", "true");
    await dehu.click();
    await expect(dehu).toHaveAttribute("aria-pressed", "false");
    await dehu.click();
    await expect(dehu).toHaveAttribute("aria-pressed", "true");
    await expect(ask).toHaveCount(0);
  });

  test("a sensor another zone has asks first too, as a sensor", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    for (let i = 0; i < 3; i++) await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    /* Applying stays on the step, with nothing left to apply; Finish goes back to the guide. */
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Device identification", exact: true }).click();
    const board = row(frame, "Environment board").locator(".pickrow"), ask = app(frame).getByRole("alertdialog");
    await board.click();
    await expect(ask.getByRole("heading", { name: "Environment board", exact: true })).toBeVisible();
    await expect(ask.locator("#dlg-text")).toHaveText("This sensor is already associated to Zone: Flower tent. Are you sure you want to duplicate it here?");
    await expect(ask.locator("#dlg-more")).toHaveText("This means that data is in sync in both zones.");
    await dialogFoot(ask, ["Cancel", "Add"]);
    await expect(board).toHaveAttribute("aria-pressed", "false");
    await ask.getByRole("button", { name: "Add", exact: true }).click();
    await expect(board).toHaveAttribute("aria-pressed", "true");
  });

  test("a soil probe is detected as Soil and asked for moisture, EC and temperature, not humidity, VPD or light", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Soil 1").getByRole("button").first().click();
    const soil = row(frame, "Soil 1");
    await expect(soil.locator("fieldset", { hasText: "Class" }).getByLabel("Soil, detected")).toBeChecked();
    for (const reading of ["Moisture (VWC), pick one", "pwEC, pick one", "Temperature"]) await expect(soil.locator("legend", { hasText: reading })).toHaveCount(1);
    for (const reading of ["Humidity", "VPD", "Light"]) await expect(soil.locator("legend", { hasText: new RegExp(`^${reading}`) })).toHaveCount(0);
    await soil.getByLabel("Soil 1 Substrate Normalised VWC, 85.4 %").check();
    await soil.getByLabel("Soil 1 Substrate Pore Water EC, 2.54 mS/cm").check();
    await expect(soil.getByLabel("Soil 1 Substrate Temperature, 20.8 °C")).toBeChecked();
    await expect(next(frame)).toBeEnabled();
    /* Changed to Environment it asks that class's readings instead, keeping the temperature already picked. */
    await soil.locator("fieldset", { hasText: "Class" }).getByLabel("Environment").check();
    await expect(soil.locator("legend", { hasText: /^Humidity/ })).toHaveCount(1);
    await expect(soil.locator("legend", { hasText: /^Moisture/ })).toHaveCount(0);
    await expect(soil.getByLabel("Soil 1 Substrate Temperature, 20.8 °C")).toBeChecked();
  });

  test("any sensor on the device can go to any reading, and Not used is always there", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Two probe board").getByRole("button").first().click();
    const two = row(frame, "Two probe board"), light = two.locator("fieldset", { hasText: "Light" });
    await expect(light.getByLabel("Not used")).toBeChecked();
    await two.getByRole("button", { name: /From this device/ }).last().click();
    await light.getByLabel("Low temp, 21.4 °C").check();
    await expect(light.getByLabel("Low temp, 21.4 °C")).toBeChecked();
    await expect(light.getByLabel("Top temp, 23 °C")).toHaveCount(0);
    for (const reading of ["Temperature", "Humidity", "VPD"]) await two.locator("fieldset", { hasText: reading }).getByLabel("Not used").check();
    await light.getByLabel("Not used").check();
    await expect(app(frame).getByRole("button", { name: "Two probe board: pick at least one reading, or leave this sensor out. ›" })).toBeVisible();
    await expect(next(frame)).toBeDisabled();
  });

  test("applying waits for the host's own dialog; once you allow it, the mapping is stored and the step is done", async ({ page }) => {
    const frame = await newZoneMap(page);
    await pickAll(frame);
    await next(frame).click();
    await expect(dialog(frame)).toContainText("Spare Plug is a");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    /* Allow is off for a second after the dialog appears, so a stray tap can't land on it. */
    await page.waitForTimeout(1100);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    /* Applying stays on the step, with nothing left to apply; Finish goes back to the guide. */
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.setup?.devices).toBe("done");
    expect(z?.combine).toEqual({ env: "mean", soil: "mean" });
    expect(z?.sensors.map((s) => [s.id, s.entities])).toEqual([
      ["d-board", { temperature: "sensor.environment_board_air_temp", humidity: "sensor.environment_board_humidity", vpd: "sensor.environment_board_vpd", light: "sensor.environment_board_light" }],
      ["d-two", { temperature: "sensor.two_probe_top_temp", humidity: "sensor.two_probe_humidity" }],
    ]);
    /* The leaf temperature offset is Sensor Calibration's, so mapping writes nothing about it. */
    expect(z?.sensors.some((s) => "leafEntity" in s || "leafUnused" in s || "leaf" in s)).toBe(false);
    const devices = (await stored(page)).devices.filter((d) => (d.zones as string[]).includes("flower_tent"));
    expect(devices.map((d) => [d.entity, d.type]).sort()).toEqual([
      ["humidifier.garden_dehumidifier", "Dehumidifier"],
      ["switch.spare_plug", "Heater"],
    ]);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("the host's dialog reads an entity's area from its device when the entity has none of its own", async ({ page }) => {
    const frame = await newZoneMap(page);
    await page.evaluate(`fakeHA.registry.entities["switch.spare_plug"] = { entity_id: "switch.spare_plug", platform: "tuya_local", area_id: null, device_id: "d-spare" };
      fakeHA.registry.devices["d-spare"] = { id: "d-spare", area_id: "reservoir" };`);
    await pickAll(frame);
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const text = await hostDialogText(page);
    expect(text).toContain("switch.spare_plug");
    expect(text).toContain("In the Reservoir area in Home Assistant, not in the Flower tent area.");
    expect(text).not.toContain("Has no area in Home Assistant.");
    await page.keyboard.press("Escape");
  });

  test("cancelling the host's dialog stores nothing, and the review says so", async ({ page }) => {
    const frame = await newZoneMap(page);
    const before = (await stored(page)).revision;
    await pickAll(frame);
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect((await stored(page)).revision).toBe(before);
  });

  test("Device identification's step headers move between its steps", async ({ page }) => {
    const frame = await newZoneMap(page);
    const step = (name: string) => app(frame).locator(".steps").getByRole("button", { name, exact: true });
    const current = app(frame).locator('.steps li[aria-current="step"]');
    await expect(current).toHaveText("1. Sensors");
    /* With something still to answer, a jump forward stops where Next would. */
    await row(frame, "Two probe board").getByRole("button").first().click();
    await step("3. Check").click();
    await expect(current).toHaveText("1. Sensors");
    await row(frame, "Two probe board").getByRole("button").first().click();
    await pickAll(frame);
    await expect(current).toHaveText("3. Check");
    await step("1. Sensors").click();
    await expect(current).toHaveText("1. Sensors");
    await step("3. Check").click();
    await expect(current).toHaveText("3. Check");
    await step("2. Devices").click();
    await expect(current).toHaveText("2. Devices");
  });

  test("a wizard's Back and Next ride in a bar pinned to the foot of the window, which counts what's unsaved and covers nothing", async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 520 });
    const frame = await newZoneMap(page);
    const bar = app(frame).getByRole("region", { name: "Steps", exact: true });
    const pinned = async () => {
      const gap = await bar.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(40);
    };
    /* The step runs well past the foot of the window, and its buttons are in view without scrolling. */
    expect(await frame.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(100);
    expect(await frame.evaluate(() => scrollY)).toBe(0);
    await expect(bar.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    await expect(next(frame)).toBeInViewport();
    await pinned();
    await expect(bar.locator(".draft-count")).toHaveCount(0);
    /* Something picked is counted there. */
    await row(frame, "Environment board").getByRole("button").first().click();
    await expect(bar.locator(".draft-count")).toHaveText(/^[1-9]\d*$/);
    await expect(bar).toContainText("nothing changes until you apply");
    /* On a touch screen it's out of the way while a box is typed in, as the draft bar is, and back once the box is left. */
    const name = app(frame).locator("#ms-d-board").getByLabel("Name", { exact: true });
    const touch = await frame.evaluate(() => matchMedia("(pointer: coarse)").matches);
    await name.click();
    if (touch) await expect(bar).toBeHidden();
    else await expect(bar).toBeVisible();
    await name.press("Enter");
    await expect(bar).toBeVisible();
    /* And back when the keyboard is put away with the box still focused, which a touch screen shows as the window growing. */
    if (touch) {
      await name.click();
      await expect(bar).toBeHidden();
      await page.setViewportSize({ width: page.viewportSize()!.width, height: 820 });
      await expect(bar).toBeVisible();
      await expect(name).toBeFocused();
      await name.press("Enter");
      await page.setViewportSize({ width: page.viewportSize()!.width, height: 520 });
    }
    /* Scrolled to its end, the step's last line clears the bar. */
    await frame.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const [last, top] = await bar.evaluate((el) => [el.previousElementSibling!.getBoundingClientRect().bottom, el.getBoundingClientRect().top]);
    expect(last).toBeLessThanOrEqual(top);
    await pinned();
    await next(frame).click();
    await expect(app(frame).locator(".steps [aria-current]")).toHaveText("2. Devices");
    expect(await frame.evaluate(() => scrollY)).toBe(0);
    await expect(bar.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
    await pinned();
  });

  test("a name given here is kept in place of Home Assistant's, and a device moved to another entity keeps its name and type", async ({ page }) => {
    const frame = await newZoneMap(page);
    const allow = async () => {
      await expect.poll(() => hostDialogOpen(page)).toBe(true);
      await page.waitForTimeout(1100);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect.poll(() => hostDialogOpen(page)).toBe(false);
    };
    await row(frame, "Environment board").getByRole("button").first().click();
    const board = app(frame).locator("#ms-d-board"), name = board.getByLabel("Name", { exact: true });
    await expect(name).toHaveValue("Environment board");
    await name.fill("Canopy left");
    /* A redraw, as every new reading causes, leaves what's typed alone. */
    await page.evaluate(`fakeHA.setState("input_number.garden_day_temperature_min_threshold", "22.5")`);
    await expect(name).toHaveValue("Canopy left");
    await expect(board.locator("strong").first()).toHaveText("Canopy left");
    await expect(board).toContainText("Home Assistant calls it Environment board. Its name there isn't changed.");
    await name.fill("");
    await name.press("Enter");
    await expect(next(frame)).toBeDisabled();
    await board.getByRole("button", { name: "Put back Home Assistant's name, Environment board" }).click();
    await expect(name).toHaveValue("Environment board");
    await expect(board).not.toContainText("Home Assistant calls it");
    await name.fill("Canopy left");
    /* On a touch screen the bar with Next is out of the way while a box is typed in, and Enter leaves the box. */
    await name.press("Enter");
    await next(frame).click();

    await row(frame, "Spare Plug").getByRole("button").first().click();
    const plug = app(frame).locator("#md-switch_spare_plug");
    await plug.getByLabel("Heater", { exact: true }).check();
    await plug.getByLabel("Name", { exact: true }).fill("Tent heater");
    await plug.getByLabel("Name", { exact: true }).press("Enter");
    await next(frame).click();
    await expect(app(frame).locator(".review")).toContainText("Canopy left (environment)");
    await expect(app(frame).locator(".review")).toContainText("Tent heater (Heater)");
    await next(frame).click();
    await expect(dialog(frame)).toContainText("Environment board name");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await allow();
    /* Applying stays on the step, with nothing left to apply; Finish goes back to the guide. */
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    let saved = await stored(page);
    expect(saved.zones.find((x) => x.id === "flower_tent")?.sensors.map((x) => [x.id, x.name, x.nameSource])).toEqual([["d-board", "Canopy left", "confirmed"]]);
    expect(saved.devices.filter((d) => (d.zones as string[]).includes("flower_tent")).map((d) => [d.entity, d.name, d.nameSource, d.type])).toEqual([["switch.spare_plug", "Tent heater", "confirmed", "Heater"]]);

    /* Moved to another of Home Assistant's entities, it's one change, and Home Assistant asks before the new one can be switched. */
    await page.evaluate(`fakeHA.setState("light.tent_light", "on", { friendly_name: "Tent light" })`);
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await app(frame).locator(".steps").getByRole("button", { name: "2. Devices", exact: true }).click();
    const swap = app(frame).locator("#swap-md-switch_spare_plug");
    await expect(swap).toContainText("On: Spare Plug, switch.spare_plug");
    await swap.getByRole("combobox").fill("tent");
    await swap.getByRole("option", { name: /^Tent light/ }).click();
    const moved = app(frame).locator("#md-light_tent_light");
    await expect(moved.locator("strong").first()).toHaveText("Tent heater");
    await expect(moved.getByLabel("Heater", { exact: true })).toBeChecked();
    await expect(app(frame).locator("#md-switch_spare_plug .pickrow")).toHaveAttribute("aria-pressed", "false");
    await next(frame).click();
    await next(frame).click();
    await expect(dialog(frame).locator(".review-row")).toHaveText(["Tent heater entityswitch.spare_plug → light.tent_light"]);
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await allow();
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    saved = await stored(page);
    expect(saved.devices.filter((d) => (d.zones as string[]).includes("flower_tent")).map((d) => [d.entity, d.name, d.type])).toEqual([["light.tent_light", "Tent heater", "Heater"]]);
    expect(saved.devices.some((d) => d.entity === "switch.spare_plug" && (d.zones as string[]).includes("flower_tent"))).toBe(false);
  });

  test("leaving Map devices with picks made asks first", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await app(frame).getByRole("button", { name: "Cancel" }).click();
    await expect(app(frame).getByRole("alertdialog")).toContainText("Discard unsaved changes?");
    await app(frame).getByRole("alertdialog").getByRole("button", { name: "Discard and continue" }).click();
    await expect.poll(() => leaveAsks(page)).toBe(false);
  });

  test("a board HA can't say the link of is asked about on Setup, and the answer is kept", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    await next(frame).click();
    await next(frame).click();
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    /* Applying stays on the step, with nothing left to apply; Finish goes back to the guide. */
    await expect(next(frame)).toHaveText("Finish");
    await next(frame).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await goTo(frame, "Setup");
    const questions = app(frame).locator("section", { hasText: "Questions for you" });
    const ask = questions.locator(".task", { hasText: "Environment board" });
    await ask.getByRole("button", { name: "Ethernet" }).click();
    await expect(ask).toHaveCount(0);
    const s = (await stored(page)).zones.find((x) => x.id === "flower_tent")?.sensors[0];
    expect([s?.link, s?.linkSource]).toEqual(["ethernet", "confirmed"]);
  });
});
