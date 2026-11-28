/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { expect, test } from "@playwright/test";
import { PAGE, app, frameText, goTo, leaveAsks, moreButton, openNav, panelFrame, serviceCalls, tab, zoneMenu } from "./helpers";

test.describe("talking to HA", () => {
  test("the frame shows what HA has stored: a tab and a card per zone, and the release on Setup", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await openNav(frame);
    for (const name of ["Garden", "Veg", "Nursery"]) await expect(tab(frame, name)).toBeVisible();
    await expect(app(frame).locator(".zone-card")).toHaveCount(3);
    await goTo(frame, "Setup");
    await expect.poll(() => frameText(frame)).toContain("Installed, version 0.0.0.");
  });

  test("a zone's tab opens its page, and Overview's card does too", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Veg");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Veg", exact: true })).toBeVisible();
    await openNav(frame);
    await expect(tab(frame, "Veg")).toHaveAttribute("aria-current", "page");
    await goTo(frame, "Overview");
    /* By its name: Veg's card names Nursery too, as the zone linked to it. */
    await app(frame).locator(".zone-card", { has: frame.locator("h2", { hasText: "Nursery" }) }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Nursery", exact: true })).toBeVisible();
  });

  test("the pages are in a menu behind one button, in place of a title bar and tabs, and a page's heading is centred", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const button = app(frame).getByRole("navigation").getByRole("button", { name: "Menu", exact: true }), items = app(frame).getByRole("navigation").getByRole("menuitem");
    await expect(app(frame).locator(".topbar, .tabs")).toHaveCount(0);
    await expect(items).toHaveCount(0);
    await button.click();
    await expect(items).toHaveText(["Overview", "Garden", "Veg", "Nursery", "Devices", "Setup"]);
    await expect(tab(frame, "Overview")).toHaveAttribute("aria-current", "page");
    /* Escape and a tap elsewhere both close it. */
    await page.keyboard.press("Escape");
    await expect(items).toHaveCount(0);
    await button.click();
    const view = page.viewportSize()!;
    await page.mouse.click(view.width - 20, view.height - 20);
    await expect(items).toHaveCount(0);
    await goTo(frame, "Garden");
    await expect(items).toHaveCount(0);
    const head = app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true });
    const [h, w] = [await head.boundingBox(), await app(frame).locator(".wrap").boundingBox()];
    expect(Math.abs(h!.x + h!.width / 2 - (w!.x + w!.width / 2))).toBeLessThan(2);
    /* The menu button at the left edge and the zone's own menu at the right, both level with the foot of the heading block. */
    const [m, t, block] = [await button.boundingBox(), await moreButton(frame).boundingBox(), await app(frame).locator(".pagehead").boundingBox()];
    const foot = (b: { y: number; height: number }) => b.y + b.height;
    expect(Math.abs(foot(m!) - foot(block!))).toBeLessThan(2);
    expect(Math.abs(foot(t!) - foot(block!))).toBeLessThan(2);
    expect(foot(m!)).toBeGreaterThan(foot(h!));
    expect(Math.abs(m!.x - w!.x)).toBeLessThan(2);
    expect(Math.abs(t!.x + t!.width - (w!.x + w!.width))).toBeLessThan(2);
    /* The zone's cards each take the page's full width, one under the other. */
    const card = (name: string) => app(frame).locator("section.card", { has: frame.getByRole("heading", { name, exact: true }) });
    const [place, controls] = [await card("Zone map").boundingBox(), await card("Controls").boundingBox()];
    expect([Math.round(place!.width), Math.round(controls!.width)]).toEqual([Math.round(w!.width), Math.round(w!.width)]);
    expect(controls!.y).toBeGreaterThan(place!.y + place!.height);
    /* A dehumidifier's modes sit under its name, so on a wide page its row is no taller than its dial. */
    if (w!.width > 900) expect((await card("Controls").locator(".dev", { hasText: "Auxiliary dehumidifier" }).boundingBox())!.height).toBeLessThan(175);
  });

  test("a zone's targets and activity are in a menu at the right of its heading, in place of a View targets button", async ({ page }) => {
    await page.goto(PAGE);
    if (page.viewportSize()!.width < 600) await page.setViewportSize({ width: 390, height: 844 });
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const more = moreButton(frame), items = app(frame).locator(".pagehead").getByRole("menuitem");
    await expect(app(frame).getByRole("button", { name: "View targets" })).toHaveCount(0);
    await expect(more).toHaveAttribute("aria-haspopup", "menu");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(items).toHaveCount(0);
    /* Activity was a line at the foot of the page; it's in its own dialog now. */
    expect(await frameText(frame)).not.toContain("Activity arrives in a release that follows.");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(items).toHaveText(["View targets", "View activity", "View automations"]);
    await expect(items.first()).toBeFocused();
    /* It opens on the screen, a phone's included. */
    const view = page.viewportSize()!, box = (await app(frame).locator(".pagehead .menu").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);

    await app(frame).getByRole("menuitem", { name: "View targets", exact: true }).click();
    await expect(app(frame).getByRole("dialog").getByRole("heading", { name: "Targets: Garden" })).toBeVisible();
    await app(frame).getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(app(frame).getByRole("dialog")).toHaveCount(0);
    await expect(more).toBeFocused();

    await zoneMenu(frame, "View activity");
    const dialog = app(frame).getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Activity: Garden", exact: true })).toBeVisible();
    await expect(dialog).toContainText("Activity arrives in a release that follows.");
    await expect(dialog.locator(".dlgfoot").getByRole("button")).toHaveText(["Close"]);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(more).toBeFocused();
    /* A tap outside the dialog closes it too. */
    await zoneMenu(frame, "View activity");
    await app(frame).locator(".modal").click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
  });

  test("the zone page's menu closes on Escape, on a tap elsewhere and on the back gesture", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const more = moreButton(frame), items = app(frame).locator(".pagehead").getByRole("menuitem");
    await more.click();
    await expect(items).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(items).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    const view = page.viewportSize()!;
    await page.mouse.click(20, view.height - 20);
    await expect(items).toHaveCount(0);
    await more.click();
    await expect(items).toHaveCount(3);
    await page.evaluate(() => history.back());
    await expect(items).toHaveCount(0);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true })).toBeVisible();
  });

  test("the back gesture goes back a step inside the panel, and leaves it only from where it started", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const h1 = (name: string) => app(frame).getByRole("heading", { level: 1, name, exact: true });
    /* The page keeps one history entry of its own in front while the panel has somewhere to go back to. */
    const held = () => page.evaluate(() => !!(history.state && (history.state as { ecBack?: boolean }).ecBack));
    const back = () => page.evaluate(() => history.back());
    await expect(h1("Overview")).toBeVisible();
    expect(await held()).toBe(false);
    await goTo(frame, "Garden");
    await expect(h1("Garden")).toBeVisible();
    await expect.poll(held).toBe(true);
    await goTo(frame, "Setup");
    await expect(h1("Setup")).toBeVisible();
    const entries = await page.evaluate(() => history.length);
    await back();
    await expect(h1("Garden")).toBeVisible();
    await expect.poll(held).toBe(true);
    await back();
    await expect(h1("Overview")).toBeVisible();
    /* Back where it started, nothing is held, so the next back gesture is Home Assistant's. */
    await expect.poll(held).toBe(false);
    expect(await page.evaluate(() => history.length)).toBe(entries);

    /* A menu closes, an editor steps back, and unsaved changes are asked about before anything is lost. */
    await openNav(frame);
    await expect(tab(frame, "Setup")).toBeVisible();
    await back();
    await expect(app(frame).getByRole("navigation").getByRole("menuitem")).toHaveCount(0);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await back();
    await expect(app(frame).getByRole("alertdialog")).toContainText("Discard unsaved changes?");
    await back();
    await expect(app(frame).getByRole("alertdialog")).toHaveCount(0);
    await expect(app(frame).getByLabel("Zone name")).toHaveValue("Flower tent");
    await back();
    await app(frame).getByRole("alertdialog").getByRole("button", { name: "Discard and continue" }).click();
    await expect(h1("Setup")).toBeVisible();
    await back();
    await expect(h1("Overview")).toBeVisible();
    await expect.poll(held).toBe(false);
  });

  test("after HA restarts, the panel reads what's stored again", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Nursery")).toBeVisible();
    await page.evaluate(`(() => {
      fakeHA.knobs.restartMs = 100;
      const next = JSON.parse(fakeHA.disk);
      next.zones = next.zones.slice(0, 1);
      fakeHA.disk = JSON.stringify(next);
      fakeHA.restart();
    })()`);
    /* Looked for with the menu open: closed, no page is listed, so there'd be nothing to wait for. */
    await openNav(frame);
    await expect(tab(frame, "Nursery")).toHaveCount(0);
    await expect(app(frame).locator(".zone-card")).toHaveCount(1);
  });

  test("a message the host doesn't know, or from anywhere but the frame, is dropped, and nothing is ever sent to HA", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await frame.evaluate(() => {
      for (const m of [
        { v: 1, type: "switch", entity_id: "switch.heater_mains", action: "turn_on", req: 1 },
        { v: 1, type: "calibrate", sensor: "s1", value: 0, req: 2 },
        { v: 1, type: "setting", zone: "nursery", name: "bands.day.temperature.min", value: 20, req: 3 },
        { v: 1, type: "save", base: 0, config: { zones: [], devices: [] }, req: 4 },
        { v: 1, type: "callService", domain: "switch", service: "turn_on" },
      ]) parent.postMessage(m, "*");
    });
    await page.evaluate(() => window.postMessage({ v: 1, type: "draft", open: true }, "*"));
    await page.waitForTimeout(200);
    expect(await serviceCalls(page)).toBe(0);
    expect(await page.evaluate<number>("fakeHA.saves.length")).toBe(0);
    expect(await leaveAsks(page)).toBe(false);
  });
});

test.describe("what Home Assistant has", () => {
  test("the catalog shows each device by area with how it is connected, and says so when that isn't known", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Devices");
    await expect.poll(() => frameText(frame)).toContain("Environment board");
    const text = await frameText(frame);
    for (const want of ["Garden", "Veg", "No area", "WiFi", "Zigbee", "Through Hue bridge", "Link not known", "Cloud", "entities, such as helpers and templates", "Spare plug"]) {
      expect(text).toContain(want);
    }
    expect(await serviceCalls(page)).toBe(0);
  });

  test("a device named with markup is drawn as text, never run", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Devices");
    await expect.poll(() => frameText(frame)).toContain('<img src=x onerror="window.pwned=1">');
    expect(await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.querySelectorAll("img").length)).toBe(0);
  });

  test("when Home Assistant can't list its devices the panel says so, and Try again asks again", async ({ page }) => {
    await page.goto(`${PAGE}?catalog=fail`);
    const frame = await panelFrame(page);
    await goTo(frame, "Devices");
    await app(frame).getByText("Everything in Home Assistant").click();
    await expect.poll(() => frameText(frame)).toContain("couldn't list its devices");
    await page.evaluate("catalogDown = false");
    await frame.locator("ec-app").getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => frameText(frame)).toContain("Environment board");
  });
});
