/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

test.describe("live readings", () => {
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const row = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
  const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });
  const tile = (frame: Frame, label: string) => app(frame).locator(".tile", { has: frame.locator(".name", { hasText: label }) });
  /* Sensor states as HA would hold them, updated just now unless told otherwise. */
  /* The page declares fakeHA with const, so it is a global but not a window property: reached as an expression. */
  const setStates = (page: Page, states: Record<string, [string, number?]>) =>
    page.evaluate(`(() => {
      for (const [e, [state, ageMs]] of Object.entries(${JSON.stringify(states)}))
        fakeHA.states[e] = { entity_id: e, state, attributes: {}, context: { user_id: null, parent_id: null }, last_updated: new Date(Date.now() - (ageMs ?? 5000)).toISOString() };
      fakeHA.publish();
    })()`);

  /* A zone with the environment board and the two probe board mapped. */
  async function twoSensorZone(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    await setStates(page, {
      "sensor.environment_board_air_temp": ["24"], "sensor.environment_board_humidity": ["60"], "sensor.environment_board_vpd": ["1.2"], "sensor.environment_board_light": ["40000"],
      "sensor.two_probe_top_temp": ["22"], "sensor.two_probe_low_temp": ["21"], "sensor.two_probe_humidity": ["70"],
    });
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await row(frame, "Environment board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByLabel(/^Top temp,/).check();
    for (let i = 0; i < 3; i++) await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await goTo(frame, "Flower tent");
    return frame;
  }

  test("a zone's tiles combine its live sensors and say how, and Overview shows the same numbers", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("23.0");
    await expect(tile(frame, "Temperature")).toContainText("Average of 2: Environment board 24.0, Two probe board 22.0.");
    await expect(tile(frame, "Humidity").locator(".val")).toContainText("65.0");
    await expect(tile(frame, "Temperature")).toContainText("Targets not set up yet");
    await expect(app(frame).locator(".lcard .val")).toContainText("40,000");
    await goTo(frame, "Overview");
    const card = app(frame).locator(".zone-card", { hasText: "Flower tent" });
    await expect(card.locator(".mrow", { hasText: "Temperature" })).toContainText("23.0");
    await expect(card).toContainText("No targets yet");
  });

  test("a dead sensor is never a number: it is left out and named", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await setStates(page, { "sensor.environment_board_air_temp": ["unavailable"] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("22.0");
    await expect(tile(frame, "Temperature")).toContainText("Environment board has no data, left out.");
    await setStates(page, { "sensor.two_probe_top_temp": ["unknown"] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("--");
  });

  test("a reading that stopped updating is stale, left out and named", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await setStates(page, { "sensor.two_probe_top_temp": ["22", 20 * 60_000] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("24.0");
    await expect(tile(frame, "Temperature")).toContainText("Two probe board is stale, left out.");
  });

  test("tapping a sensor on the map says where it is, what it reads and when it last reported", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    await app(frame).locator(".map").getByRole("button", { name: /^Select Environment under, / }).click();
    await expect(app(frame).locator(".detail")).toContainText("Environment under");
    await expect(app(frame).locator(".detail")).toContainText("Under canopy.");
  });

  test("Devices lists each mapped device and sensor with its link and state", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await goTo(frame, "Devices");
    const table = app(frame).locator("table");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Environment sensor");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Online");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Link not known");
    await app(frame).getByLabel("WiFi").check();
    await expect(table.locator("tr", { hasText: "Environment board" })).toHaveCount(0);
  });
});
