/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, serviceCalls } from "./helpers";

test.describe("appearance", () => {
  test("Appearance says what each zone's History opens on, and a choice there is reviewed and kept with the zone", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    const group = (zone: string, what: "graph" | "range") => app(frame).getByRole("group", { name: `${zone}: ${what}`, exact: true });
    const chosen = (zone: string, what: "graph" | "range") => group(zone, what).locator('[aria-pressed="true"]');
    const kept = (id: string) => page.evaluate<unknown>(`JSON.parse(fakeHA.disk).zones.find((z) => z.id === "${id}").history ?? null`);
    const dialog = app(frame).getByRole("dialog");
    for (const zone of ["Garden", "Veg", "Nursery"]) {
      await expect(chosen(zone, "graph")).toHaveText("Temp");
      await expect(chosen(zone, "range")).toHaveText("24h");
    }
    await group("Veg", "graph").getByRole("button", { name: "VPD", exact: true }).click();
    await expect(dialog.locator(".review-row")).toHaveText(["Veg's History opens onTemperature, 24h → VPD, 24h"]);
    /* Nothing is kept, and nothing shows as chosen, until it's applied. */
    await expect(chosen("Veg", "graph")).toHaveText("Temp");
    expect(await kept("veg")).toBeNull();
    await dialog.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).locator(".toast")).toHaveText("Veg's History now opens on VPD, 24h.");
    await expect(chosen("Veg", "graph")).toHaveText("VPD");
    expect(await kept("veg")).toEqual({ metric: "vpd", hours: 24 });
    /* The range is chosen the same way, and keeps the graph. */
    await group("Veg", "range").getByRole("button", { name: "7d", exact: true }).click();
    await expect(dialog.locator(".review-row")).toHaveText(["Veg's History opens onVPD, 24h → VPD, 7d"]);
    await dialog.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(chosen("Veg", "range")).toHaveText("7d");
    expect(await kept("veg")).toEqual({ metric: "vpd", hours: 168 });
    /* Each zone keeps its own, and the one already chosen asks nothing. */
    await expect(chosen("Garden", "graph")).toHaveText("Temp");
    expect(await kept("garden")).toBeNull();
    await group("Veg", "graph").getByRole("button", { name: "VPD", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await serviceCalls(page)).toBe(0);
    /* And that zone's page opens on it. */
    await goTo(frame, "Veg");
    const card = app(frame).locator("section.card", { has: frame.getByRole("heading", { name: "History", exact: true }) });
    await expect(card.getByRole("button", { name: "VPD", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByRole("button", { name: "7d", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("HA's primary colour reaches the frame, and one that isn't a plain colour doesn't", async ({ page }) => {
    await page.goto(PAGE);
    let frame = await panelFrame(page);
    const primary = () => frame.evaluate(() => getComputedStyle(document.querySelector("ec-app") as Element).getPropertyValue("--primary").trim());
    await expect.poll(primary).toBe("#F44336");
    await page.goto(`${PAGE}?primary=${encodeURIComponent("url(https://x.test/a.png)")}`);
    frame = await panelFrame(page);
    await expect.poll(primary).toBe("#03A9F4");
  });

  test("an appearance picked in the frame is kept by the host and survives reopening the panel", async ({ page }) => {
    await page.goto(PAGE);
    let frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect(app(frame).getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => (window as unknown as { reopenPanel(): void }).reopenPanel());
    await expect.poll(() => page.frames().length).toBe(2);
    frame = page.frames()[1];
    await frame.waitForSelector("ec-app");
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  });

  test("an appearance the host doesn't know is refused", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await frame.evaluate(() => parent.postMessage({ v: 1, type: "appearance", value: "neon", req: 9 }, "*"));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => localStorage.getItem("environment-control-appearance"))).toBeNull();
  });
});
