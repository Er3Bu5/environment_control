/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, frameText, goTo, hostDialogOpen, panelFrame, serviceCalls, zoneMenu } from "./helpers";

test.describe("the setting write", () => {
  /* The frame's message, sent raw: the host answers it the same whether the panel's own screen sent it or not. */
  const setting = (frame: Frame, body: Record<string, unknown>) =>
    frame.evaluate(
      (b) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const req = 8000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
          parent.postMessage({ v: 1, type: "setting", req, ...b }, "*");
        }),
      body,
    );
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  const MIN = "input_number.garden_day_temperature_min_threshold";

  test("sets a zone's linked number helper inside its own limits, and HA then reports the value", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22.5 })).toEqual(expect.objectContaining({ ok: true }));
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "input_number", service: "set_value", data: { entity_id: MIN, value: 22.5 } })]);
    await expect.poll(() => page.evaluate<string>(`fakeHA.states[${JSON.stringify(MIN)}].state`)).toBe("22.5");
  });

  test("sets lights on as a time on the zone's time helper", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await setting(frame, { zone: "garden", name: "day", value: "07:30" })).ok).toBe(true);
    expect((await calls(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["input_datetime", "set_datetime", { entity_id: "input_datetime.garden_day_time", time: "07:30:00" }]]);
  });

  test("ignores an entity named by the frame: the write goes to the zone's own link", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22, entity_id: "input_number.veg_day_temperature_min_threshold" })).ok).toBe(true);
    expect((await calls(page)).map((c) => c.data.entity_id)).toEqual([MIN]);
  });

  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a setting the panel doesn't know", { zone: "garden", name: "bands.day.co2.min", value: 1 }, "Not a setting"],
    ["a zone the setup doesn't have", { zone: "kitchen", name: "day", value: "07:00" }, "isn't linked to a helper"],
    ["a limit the zone keeps in Environment Control", { zone: "nursery", name: "bands.day.temperature.min", value: 20 }, "isn't linked to a helper"],
    ["a value past the helper's limits", { zone: "garden", name: "bands.day.temperature.min", value: 80 }, "between -20 and 50"],
    ["a value off the helper's step", { zone: "garden", name: "bands.day.temperature.min", value: 22.55 }, "in steps of 0.1"],
    ["a number for a time", { zone: "garden", name: "day", value: 7 }, "isn't a time"],
    ["a time that isn't one", { zone: "garden", name: "night", value: "25:00" }, "isn't a time"],
    ["text for a number", { zone: "garden", name: "light.dayMin", value: "2000" }, "isn't a number"],
  ];
  for (const [what, body, why] of REFUSED) {
    test(`refuses ${what}`, async ({ page }) => {
      await page.goto(PAGE);
      const frame = await panelFrame(page);
      const r = await setting(frame, body);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(why);
      expect(await serviceCalls(page)).toBe(0);
    });
  }

  test("refuses a time helper that holds a date too, and a helper HA has gone without", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await page.evaluate(`(() => { fakeHA.states["input_datetime.garden_day_time"].attributes.has_date = true; fakeHA.publish(); })()`);
    expect((await setting(frame, { zone: "garden", name: "day", value: "07:00" })).error).toContain("holds a date");
    await page.evaluate(`fakeHA.offline(${JSON.stringify(MIN)}, true)`);
    expect((await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22 })).error).toContain("has no");
    expect(await serviceCalls(page)).toBe(0);
  });
});

test.describe("targets, day and night", () => {
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
  const stored = (page: Page) => page.evaluate<{ zones: Record<string, unknown>[] }>("JSON.parse(fakeHA.disk)");
  const sets = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  async function open(page: Page, zone: string): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
    await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: `Targets, day and night: ${zone}`, exact: true })).toBeVisible();
    return frame;
  }
  const time = (frame: Frame, label: string, value: string) => app(frame).getByLabel(label, { exact: true }).fill(value);
  const source = (frame: Frame, group: string, name: string) => app(frame).getByRole("group", { name: group }).getByRole("button", { name, exact: true }).click();

  test("a time on a helper is sent only on apply, and counts once HA reports it, and the zone then runs by it", async ({ page }) => {
    const frame = await open(page, "Garden");
    await expect(app(frame).getByLabel("Lights on", { exact: true })).toHaveValue("07:00");
    await time(frame, "Lights on", "06:30");
    await expect(bar(frame)).toContainText("Garden · Lights on");
    expect(await serviceCalls(page)).toBe(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("07:00 → 06:30, on your helper");
    await expect(dialog(frame)).toContainText("Light goes from 12h 00m to 12h 30m a day.");
    expect(await serviceCalls(page)).toBe(0);
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["input_datetime", "set_datetime", { entity_id: "input_datetime.garden_day_time", time: "06:30:00" }]]);
    await expect(app(frame).locator(".toast")).toHaveText("Garden saved, on your helpers too.");
    /* Applying stays here, with the saved values showing and nothing left to apply; Back goes where it was opened from. */
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await expect(bar(frame)).toHaveCount(0);
    await expect(app(frame).getByLabel("Lights on", { exact: true })).toHaveValue("06:30");
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await goTo(frame, "Garden");
    await expect(app(frame).locator(".period").first()).toContainText("06:30 - 19:00");
  });

  test("a helper that doesn't report the new value is never shown as saved", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await open(page, "Garden");
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await app(frame).getByLabel("Daylight time (min)").fill("15");
    await app(frame).getByLabel("Daylight time (min)").press("Enter");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toContainText("Daylight time: not confirmed. Home Assistant still reports 10.", { timeout: 15_000 });
    await expect(dialog(frame).getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
  });

  test("set here keeps the times in Environment Control and drops the helper links, sending nothing", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Set here");
    await time(frame, "Lights on", "08:00");
    await time(frame, "Lights off", "20:00");
    await source(frame, "Red lights source", "Not used");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("From a helper → Set here");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = (await stored(page)).zones.find((x) => x.id === "garden") as Record<string, unknown>;
    expect([z.periodMode, z.dayAt, z.nightAt, z.emersonMode, "emerson" in z]).toEqual(["fixed", 480, 1200, "none", false]);
    expect(Object.keys(z.helpers as object)).not.toContain("day");
    expect(Object.keys(z.helpers as object)).not.toContain("morning");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("detected follows the zone's switches, and says so when none of them is reporting", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Detected");
    await app(frame).getByLabel("Search Home Assistant").first().fill("tent");
    await app(frame).locator(".follow", { hasText: "light.tent_light" }).locator("input").check();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = (await stored(page)).zones.find((x) => x.id === "garden") as Record<string, unknown>;
    expect([z.periodMode, z.lights]).toEqual(["detected", ["light.tent_light"]]);
    /* Applying stays here, with the saved values showing and nothing left to apply; Back goes where it was opened from. */
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await expect(bar(frame)).toHaveCount(0);
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await goTo(frame, "Garden");
    await expect(app(frame).locator(".period").first()).toContainText("Lights not reporting");
    await page.evaluate(`(() => { fakeHA.states["light.tent_light"] = { entity_id: "light.tent_light", state: "on", attributes: {}, context: {} }; fakeHA.publish(); })()`);
    await expect(app(frame).locator(".period").first()).toContainText("Lights on");
    await expect(app(frame).locator(".period").first()).toContainText("Following its light switches");
  });

  test("problems stop the review, each with its fix", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Set here");
    await time(frame, "Lights on", "19:00");
    await expect(bar(frame)).toContainText("Fix first: Lights on and lights off need two different times.");
    await expect(bar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await source(frame, "Red lights source", "Set here");
    await app(frame).getByLabel("Evening extension (min)").fill("75");
    await app(frame).getByLabel("Evening extension (min)").press("Enter");
    await app(frame).getByRole("button", { name: /Evening extension has to be between 0 and 59 minutes/ }).click();
    await expect(app(frame).getByLabel("Evening extension (min)")).toBeFocused();
  });

  test("a helper never linked before waits for you in the host's own dialog", async ({ page }) => {
    const frame = await open(page, "Garden");
    await app(frame).locator("#sh-on-q").fill("reservoir");
    await app(frame).locator("#sh-on").getByRole("option", { name: /^Reservoir refill time/ }).click();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Home Assistant asks you to allow each helper this panel hasn't linked before.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("zones sharing lights helpers are named, since changing one moves the other", async ({ page }) => {
    const frame = await open(page, "Veg");
    await expect(app(frame).locator("#s-times")).toContainText("Nursery uses the same helpers, so it moves too.");
    await time(frame, "Lights on", "15:30");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Nursery uses the same helpers, so it moves too.");
  });

  /* Limits. The period on show follows the clock, so each test picks its own. */
  const card = (frame: Frame) => app(frame).locator("#td-targets");
  const pick = (frame: Frame, group: string, name: string) => card(frame).getByRole("group", { name: group }).getByRole("button", { name, exact: true }).click();
  const box = (frame: Frame, label: string) => card(frame).getByLabel(label, { exact: true });
  const type = async (frame: Frame, label: string, value: string) => {
    await box(frame, label).fill(value);
    await box(frame, label).press("Enter");
  };
  const zoneOf = async (page: Page, id: string) => (await stored(page)).zones.find((x) => x.id === id || x.name === id) as Record<string, any>;
  const dayRow = (frame: Frame, reading: string) => app(frame).locator(".tbl-wrap table", { has: frame.locator("th", { hasText: /^Day$/ }) }).locator("tr", { hasText: reading }).locator("td");

  test("a limit on a helper is sent only on apply and counts once HA reports it; Low is stored here; the zone is judged by both", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Temperature Max")).toHaveValue("28");
    await type(frame, "Temperature Max", "29");
    await type(frame, "Temperature Low", "24.5");
    await type(frame, "Light Min", "2500");
    await expect(bar(frame)).toContainText("3 unsaved changes");
    expect(await serviceCalls(page)).toBe(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Day Temperature Max, on your helper");
    await expect(dialog(frame)).toContainText("28° → 29°");
    await expect(dialog(frame)).toContainText("2,000 lx → 2,500 lx");
    await expect(dialog(frame)).toContainText("anything reading them, like your alerts, follows straight away");
    await dialog(frame).getByRole("button", { name: "Apply 3 changes" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => [c.service, c.data.entity_id, c.data.value])).toEqual([
      ["set_value", "input_number.garden_day_temperature_max_threshold", 29],
      ["set_value", "input_number.day_lights_garden_min_threshold", 2500],
    ]);
    expect((await zoneOf(page, "garden")).bands.day.temperature[1]).toBe(24.5);
    /* Applying stays here, with the saved values showing and nothing left to apply; Back goes where it was opened from. */
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await expect(bar(frame)).toHaveCount(0);
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View targets");
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24.5", "25", "27", "29"]);
    /* A limit that doesn't exist reads as a dash, never as a gap. */
    await expect(dayRow(frame, "Light")).toHaveText([/^Light/, "2,500", "-", "-", "-", "-"]);
  });

  test("the zone's table reads a helper live, so it shows what your alerts read", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    /* The limits are a tap away in a dialog, not a card on the page. */
    await expect(app(frame).locator(".tbl-wrap")).toHaveCount(0);
    await zoneMenu(frame, "View targets");
    await expect(dialog(frame).getByRole("heading", { name: "Targets: Garden" })).toBeVisible();
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24", "25", "27", "28"]);
    await page.evaluate(`fakeHA.setState("input_number.garden_day_temperature_min_threshold", "22.5")`);
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "22.5", "24", "25", "27", "28"]);
    await dialog(frame).getByRole("button", { name: "Close" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    /* History leads the page, then the zone's map, then Controls. */
    expect(await app(frame).locator("main h2").allTextContents()).toEqual(["History", "Zone map", "Controls"]);
    await zoneMenu(frame, "View targets");
    await dialog(frame).getByRole("button", { name: "Set targets" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
  });

  test("Back on Targets and on Sensor Calibration is in the bar at the foot of the window, and what's unsaved joins it there", async ({ page }) => {
    const frame = await open(page, "Garden");
    const bar = app(frame).getByRole("region", { name: "Page buttons", exact: true });
    const back = app(frame).getByRole("button", { name: "Back", exact: true });
    const atFoot = async (region = bar) => {
      await expect(back).toHaveCount(1);
      await expect(region.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
      const gap = await region.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(40);
    };
    /* No row of buttons is left on the page itself, at its top or its foot. */
    await expect(app(frame).locator("main").getByRole("button", { name: /^(Back|Confirm|Cancel|Next|Finish)$/ })).toHaveCount(0);
    await atFoot();
    await frame.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await atFoot();
    await back.click();
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Sensor Calibration" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    await expect(app(frame).locator("main").getByRole("button", { name: /^(Back|Confirm|Cancel|Next|Finish)$/ })).toHaveCount(0);
    await atFoot();
    /* With something changed, the same bar counts it, and holds Discard and Review and apply beside Back. */
    const offset = app(frame).getByLabel("Environment left degrees from air");
    await offset.fill("1.5");
    await offset.press("Enter");
    const unsaved = app(frame).getByRole("region", { name: "Unsaved changes", exact: true });
    await expect(bar).toHaveCount(0);
    await atFoot(unsaved);
    await expect(unsaved.getByRole("button")).toHaveText(["Back", "Discard", "Review and apply"]);
    for (const b of await unsaved.getByRole("button").all()) await expect(b).toBeInViewport();
    /* All three on one line, on a phone too. */
    const tops = await Promise.all((await unsaved.getByRole("button").all()).map(async (b) => (await b.boundingBox())!.y));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);
  });

  test("an Athena stage fills the period on show, all stored here with nothing sent", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await pick(frame, "Athena stage", "Flower bulk");
    await expect(box(frame, "Temperature Low")).toHaveValue("23.8");
    await expect(box(frame, "VPD Max")).toHaveValue("1.35");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = await zoneOf(page, "nursery");
    expect(z.bands.day).toEqual({ temperature: [21.8, 23.8, 25.2, 26.6, 28.6], humidity: [55, 60, 65, 70, 75], vpd: [0.85, 1, 1.1, 1.2, 1.35] });
    expect(z.bands.night.temperature).toEqual([18, 19, 21, 23, 25]);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("no target: the boxes show none, the target helpers are unlinked, and nothing is written to them", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await pick(frame, "Target", "No target");
    await expect(card(frame).getByRole("img", { name: "Temperature Target, none" })).toBeVisible();
    await expect(card(frame).getByRole("group", { name: "What to edit" }).getByRole("button", { name: "Target" })).toHaveCount(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("25° → None");
    await dialog(frame).getByRole("button", { name: "Apply 6 changes" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = await zoneOf(page, "garden");
    expect(z.bands.day.temperature[2]).toBeNull();
    expect(z.helpers.bands.day.temperature).toEqual({ min: "input_number.garden_day_temperature_min_threshold", max: "input_number.garden_day_temperature_max_threshold" });
    expect(await serviceCalls(page)).toBe(0);
    /* Applying stays here, with the saved values showing and nothing left to apply; Back goes where it was opened from. */
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await expect(bar(frame)).toHaveCount(0);
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View targets");
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24", "-", "27", "28"]);
  });

  test("a value out of order stops the review, its Fix goes to the box, and the other period's problem is reachable", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Min", "30");
    await expect(bar(frame)).toContainText("Fix first: Temperature Low can't be below Min.");
    await expect(bar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await card(frame).getByRole("button", { name: /Temperature Low can't be below Min/ }).click();
    await expect(box(frame, "Temperature Low")).toBeFocused();
    await type(frame, "Temperature Min", "22");
    await pick(frame, "Period", "Night");
    await type(frame, "Humidity Max", "10");
    await pick(frame, "Period", "Day");
    await card(frame).getByRole("button", { name: /Night has a value to fix/ }).click();
    await expect(card(frame).getByRole("group", { name: "Period" }).getByRole("button", { name: "Night" })).toHaveAttribute("aria-pressed", "true");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("the target is one point: a typed target VPD moves humidity and says so", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Humidity Target")).toHaveValue("62");
    await type(frame, "VPD Target", "0.8");
    await expect(app(frame).locator(".toast")).toContainText(/^Humidity Target moved to [\d.]+% to give that VPD at 25°\.$/);
    await expect(box(frame, "Humidity Target")).not.toHaveValue("62");
  });

  test("dragging on the chart moves the nearest line, no further than its neighbour, and the arrow keys nudge it", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await pick(frame, "What to edit", "Temperature");
    const chart = card(frame).locator("#vwrap svg");
    await chart.scrollIntoViewIfNeeded();
    const r = await chart.boundingBox();
    if (!r) throw new Error("no chart");
    /* The chart's own units: 692 wide, a column of 34 per degree from 16° centred at 55. */
    const x = (t: number) => r.x + ((38 + (t - 16) * 34 + 17) / 692) * r.width, y = r.y + r.height / 2;
    await page.mouse.move(x(28.2), y);
    await page.mouse.down();
    await page.mouse.move(x(30), y, { steps: 4 });
    await page.mouse.up();
    await expect(box(frame, "Temperature Max")).toHaveValue("30");
    await expect(card(frame).locator(".now")).toContainText("Temperature Max 30°");
    await page.keyboard.press("ArrowLeft");
    await expect(box(frame, "Temperature Max")).toHaveValue("29.5");
    await page.mouse.move(x(29.5), y);
    await page.mouse.down();
    await page.mouse.move(x(20), y, { steps: 4 });
    await page.mouse.up();
    await expect(box(frame, "Temperature Max")).toHaveValue("27");
    await card(frame).getByRole("button", { name: "Higher" }).click();
    await expect(box(frame, "Temperature Max")).toHaveValue("27.5");
  });

  test("a picked helper shows what it holds, and HA asks before it's linked for the first time", async ({ page }) => {
    await page.goto(PAGE);
    const helper = "input_number.nursery_day_temperature_min_threshold";
    const frame = await panelFrame(page);
    /* The helper changes in HA after the panel has listed HA's helpers, so the page has to look again when it opens. */
    await goTo(frame, "Devices");
    await expect.poll(() => frameText(frame)).toContain("Environment board");
    await page.evaluate(`(() => { fakeHA.states[${JSON.stringify(helper)}].state = "21"; CATALOG.entities.find((e) => e.entity_id === ${JSON.stringify(helper)}).state = "21"; })()`);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
    await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
    await pick(frame, "Period", "Day");
    await pick(frame, "Limits", "My helpers");
    await expect(bar(frame)).toContainText("Fix first: Link at least one limit to a helper, or choose Set here.");
    await card(frame).locator("#tl-bands-day-temperature-min-q").fill("nursery day temperature min");
    await card(frame).locator("#tl-bands-day-temperature-min").getByRole("option", { name: /nursery_day_temperature_min_threshold\s*21/ }).click();
    await expect(box(frame, "Temperature Min")).toHaveValue("21");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Day temperature Min helper");
    await expect(dialog(frame)).toContainText("Home Assistant asks you to allow each helper this panel hasn't linked before.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("on a phone, a typed box rises to sit just above where the keyboard lands, and the draft bar gets out of its way", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "Touch screens only: a mouse has no on-screen keyboard.");
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Max", "29");
    await expect(bar(frame)).toBeVisible();
    await box(frame, "Humidity Low").focus();
    await expect(bar(frame)).toBeHidden();
    /* With nothing to measure, the keyboard is taken to cover the lower half of the screen. */
    await expect
      .poll(() =>
        frame.evaluate(() => {
          const root = document.querySelector("ec-app")?.shadowRoot, row = root?.activeElement?.closest(".vrow")?.getBoundingClientRect();
          return !!row && row.bottom <= window.innerHeight * 0.5 && row.top >= 0;
        }),
      )
      .toBe(true);
    await box(frame, "Humidity Low").press("Enter");
    await expect(bar(frame)).toBeVisible();
  });

  test("a helper is picked by searching: typing narrows the matches, and the list stays short however many helpers there are", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    const picker = card(frame).locator("#tl-bands-day-humidity-max"), search = card(frame).locator("#tl-bands-day-humidity-max-q");
    await expect(picker).toContainText("Linked: input_number.garden_day_humidity_max_threshold, 70 %");
    await search.focus();
    const options = picker.getByRole("option");
    expect(await options.count()).toBeLessThanOrEqual(7);
    await expect(options.first()).toHaveText(/^\s*Set here/);
    await search.fill("night humidity");
    await expect(options).not.toHaveCount(0);
    for (const t of await options.allTextContents()) expect(t.toLowerCase()).toMatch(/night.*humidity|humidity.*night/);
    await search.fill("nothing like this");
    await expect(picker).toContainText("Nothing matches.");
    await search.fill("garden night humidity max");
    await expect(options).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Linked: input_number.garden_night_humidity_max_threshold, 68 %");
    await expect(picker.getByRole("listbox")).toHaveCount(0);
    await expect(box(frame, "Humidity Max")).toHaveValue("68");
    await search.focus();
    await search.fill("set here");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Set here");
    await expect(bar(frame)).toContainText("unsaved changes");
  });

  test("Escape closes a helper search without changing the link", async ({ page }) => {
    const frame = await open(page, "Garden");
    const search = app(frame).locator("#sh-on-q");
    await search.fill("reservoir");
    await expect(app(frame).locator("#sh-on").getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(app(frame).locator("#sh-on").getByRole("listbox")).toHaveCount(0);
    await expect(app(frame).locator("#sh-on")).toContainText("Linked: input_datetime.garden_day_time");
    await expect(bar(frame)).toHaveCount(0);
  });

  test("the chart's Change goes to Sensor Calibration and back, keeping the page's draft", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Max", "29");
    await card(frame).getByRole("button", { name: "Change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Temperature Max")).toHaveValue("29");
    await expect(bar(frame)).toContainText("Garden · Day Temperature Max, on your helper");
  });

  test("a new zone's 0s can't be confirmed; with its times and limits set it is, and its readings are judged from then on", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).locator("#g-targets").getByRole("button", { name: "Targets, day and night" }).click();
    await expect(app(frame).locator(".notice").first()).toContainText("Not confirmed yet. A new zone's times and limits all start at 0");
    await expect(app(frame).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect(card(frame)).toContainText("Temperature Max has to be above Min.");
    await time(frame, "Lights on", "06:00");
    await time(frame, "Lights off", "18:00");
    for (const p of ["Day", "Night"]) {
      await pick(frame, "Period", p);
      await pick(frame, "Athena stage", "Veg");
    }
    await expect(card(frame).locator(".notice.fix")).toHaveCount(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Applying confirms this step, and Flower tent's readings are judged against these limits from then on.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    /* Applying stays here, with the saved values showing and nothing left to apply; Back goes where it was opened from. */
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Flower tent", exact: true })).toBeVisible();
    await expect(bar(frame)).toHaveCount(0);
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await expect(app(frame).locator("#g-targets .pill.ok")).toHaveText("Done");
    const z = await zoneOf(page, "Flower tent");
    expect([z.dayAt, z.nightAt, z.setup.targets, z.bands.night.vpd]).toEqual([360, 1080, "done", [0.65, 0.8, 0.9, 1, 1.15]]);
    await goTo(frame, "Flower tent");
    await expect(app(frame).locator(".tile", { has: frame.locator(".name", { hasText: /^Temperature$/ }) })).not.toContainText("Targets not set up yet");
    await zoneMenu(frame, "View targets");
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "20.2", "22.2", "24.95", "27.7", "29.7"]);
  });
});
