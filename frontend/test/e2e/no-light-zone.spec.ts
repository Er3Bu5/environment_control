/* A zone whose sensors map no light entity has no light reading, and no light sensor isn't darkness: nothing about
   light is drawn, offered or judged for it. A light sensor that's only offline still shows as no data. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, openNav, panelFrame, tab, zoneMenu } from "./helpers";

test.describe("a zone with no light sensor", () => {
  /* Garden's three boards given readings, their light mapped and reporting, mapped and offline, or not mapped at all,
     with Garden set to open its History on Light. Without light, its limits are what a new zone's are: 0 lx. */
  async function garden(page: Page, light: "live" | "offline" | "none"): Promise<Frame> {
    await page.goto(PAGE);
    await page.evaluate(`(() => {
      const light = ${JSON.stringify(light)}, now = new Date().toISOString(), base = { gl: [26.6, 64.2, 1.05, 41200], gr: [27.0, 62.6, 1.12, 40300], gu: [24.9, 71.0, 1.0, 11000] };
      for (const [p, b] of Object.entries(base)) ["t", "h", "v", "l"].forEach((k, i) => {
        const state = k === "l" && light === "offline" ? "unavailable" : String(b[i]);
        fakeHA.states["sensor." + p + "_" + k] = { entity_id: "sensor." + p + "_" + k, state, attributes: {}, context: {}, last_updated: now };
      });
      const cfg = JSON.parse(fakeHA.disk), ids = { "g-left": "gl", "g-right": "gr", "g-under": "gu" }, z = cfg.zones[0];
      for (const s of z.sensors) {
        const p = ids[s.id];
        s.entities = { temperature: "sensor." + p + "_t", humidity: "sensor." + p + "_h", vpd: "sensor." + p + "_v", ...(light === "none" ? {} : { light: "sensor." + p + "_l" }) };
      }
      z.history = { metric: "light", hours: 24 };
      if (light === "none") {
        z.lightLimits = { dayMin: 0, nightMax: 0 };
        if (z.helpers) delete z.helpers.light;
      }
      fakeHA.disk = JSON.stringify(cfg);
      fakeHA.config = cfg;
      fakeHA.knobs.restartMs = 50;
      fakeHA.restart();
    })()`);
    const frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Garden")).toBeVisible();
    return frame;
  }
  const overviewCard = (frame: Frame) => app(frame).locator(".zone-card", { hasText: "Garden" });
  const history = (frame: Frame) => app(frame).locator("section.card", { has: frame.getByRole("heading", { name: "History", exact: true }) });
  const metricChips = (frame: Frame) => history(frame).getByRole("group", { name: "Metric", exact: true });
  const opensOn = (frame: Frame) => app(frame).getByRole("group", { name: "Garden: graph", exact: true });
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  async function targetsPage(frame: Frame): Promise<void> {
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
  }

  test("shows no light value, tile, line or chip, opens History on Temperature, and Targets says why it has no light limits", async ({ page }) => {
    const frame = await garden(page, "none");
    await goTo(frame, "Overview");
    await expect(overviewCard(frame).locator(".mrow", { hasText: "Temperature" })).toContainText("26.2");
    await expect(overviewCard(frame).locator(".mrow")).toHaveCount(3);
    await expect(overviewCard(frame)).not.toContainText("lx");
    await expect(overviewCard(frame).locator(".lspark")).toHaveCount(0);
    await expect(overviewCard(frame)).toContainText(/Lights (on|off)/);

    await goTo(frame, "Garden");
    await expect(app(frame).locator(".tiles .tile")).toHaveCount(3);
    await expect(app(frame).locator(".lcard")).toHaveCount(0);
    await expect(app(frame).locator(".tiles")).not.toContainText("lx");
    await expect(metricChips(frame).getByRole("button")).toHaveText(["Temp", "RH", "VPD"]);
    await expect(metricChips(frame).locator('[aria-pressed="true"]')).toHaveText("Temp");
    await expect(history(frame)).not.toContainText("lx");
    await expect(history(frame)).not.toContainText("Always open on");

    await zoneMenu(frame, "View targets");
    await expect(dialog(frame)).toContainText("No light sensor in this zone, so it has no light limits.");
    await expect(dialog(frame).locator("tr", { hasText: "Light" })).toHaveCount(0);
    await expect(dialog(frame)).not.toContainText("lx");
    await dialog(frame).getByRole("button", { name: "Close" }).click();

    await goTo(frame, "Setup");
    await expect(opensOn(frame).getByRole("button")).toHaveText(["Temp", "RH", "VPD"]);
    await expect(opensOn(frame).locator('[aria-pressed="true"]')).toHaveText("Temp");

    await targetsPage(frame);
    const card = app(frame).locator("#td-targets");
    await expect(card.locator("#vnolight")).toHaveText("No light sensor in this zone, so it has no light limits.");
    await expect(card.locator("#vin-light-0")).toHaveCount(0);
    await expect(card.getByRole("group", { name: /light (Min|Max)/i })).toHaveCount(0);
    await card.getByRole("group", { name: "Period" }).getByRole("button", { name: "Day", exact: true }).click();
    await card.getByLabel("Temperature Low", { exact: true }).fill("24.5");
    await card.getByLabel("Temperature Low", { exact: true }).press("Enter");
    await expect(card.locator(".issues .notice")).toHaveCount(0);
    await app(frame).getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).not.toContainText("lx");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const kept = await page.evaluate<{ bands: { day: { temperature: number[] } } }>(`JSON.parse(fakeHA.disk).zones.find((z) => z.id === "garden")`);
    expect(kept.bands.day.temperature[1]).toBe(24.5);
  });

  test("a zone with light is unchanged: its light row, card, line, chip and limits", async ({ page }) => {
    const frame = await garden(page, "live");
    await goTo(frame, "Overview");
    await expect(overviewCard(frame).locator(".mrow")).toHaveCount(4);
    await expect(overviewCard(frame).locator(".mrow", { hasText: "Light" })).toContainText("30,833");

    await goTo(frame, "Garden");
    await expect(app(frame).locator(".lcard .val")).toContainText("30,833");
    await expect(metricChips(frame).getByRole("button")).toHaveText(["Temp", "RH", "VPD", "Light"]);
    await expect(metricChips(frame).locator('[aria-pressed="true"]')).toHaveText("Light");

    await zoneMenu(frame, "View targets");
    await expect(dialog(frame).locator("tr", { hasText: "Light" }).first()).toContainText("lx");
    await expect(dialog(frame)).not.toContainText("No light sensor");
    await dialog(frame).getByRole("button", { name: "Close" }).click();

    await goTo(frame, "Setup");
    await expect(opensOn(frame).locator('[aria-pressed="true"]')).toHaveText("Light");

    await targetsPage(frame);
    await expect(app(frame).locator("#td-targets #vin-light-0")).toHaveCount(1);
    await expect(app(frame).locator("#td-targets #vnolight")).toHaveCount(0);
  });

  test("an offline light sensor still shows as no data rather than disappearing", async ({ page }) => {
    const frame = await garden(page, "offline");
    await goTo(frame, "Overview");
    await expect(overviewCard(frame).locator(".mrow", { hasText: "Light" })).toContainText("--");

    await goTo(frame, "Garden");
    await expect(app(frame).locator(".lcard .val")).toContainText("--");
    await expect(metricChips(frame).getByRole("button", { name: "Light", exact: true })).toBeVisible();

    await targetsPage(frame);
    await expect(app(frame).locator("#td-targets #vin-light-0")).toHaveCount(1);
  });
});
