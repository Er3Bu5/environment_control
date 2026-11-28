/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, expect, test } from "@playwright/test";
import { PAGE, app, goTo, hostButton, hostDialogOpen, hostDialogText, leaveAsks, openNav, panelFrame, route, tab } from "./helpers";

test.describe("layout", () => {
  test("the frame fills the window, less the safe areas, inside a container with no height as HA mounts it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const windowHeight = await page.evaluate(() => window.innerHeight);
    /* The page sets the top and bottom safe areas to 10px and 20px. */
    expect(await frame.evaluate(() => window.innerHeight)).toBe(windowHeight - 30);
  });

  test("the menu button rests at the foot of the heading and scrolls away with it, never riding over the page", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const button = app(frame).getByRole("navigation").getByRole("button", { name: "Menu", exact: true });
    const rect = () => button.evaluate((el) => (({ top, left, bottom }) => ({ top, left, bottom }))(el.getBoundingClientRect()));
    const headFoot = () => app(frame).locator(".navmenu + *").evaluate((el) => el.getBoundingClientRect().bottom);
    const rest = await rect();
    expect(Math.abs(rest.bottom - (await headFoot()))).toBeLessThan(1);
    /* Far down the page it has gone up with its heading: still at the heading's foot, and out of the window. */
    await frame.evaluate(() => scrollTo(0, 900));
    expect(await frame.evaluate(() => scrollY)).toBe(900);
    expect((await rect()).top).toBe(rest.top - 900);
    expect(Math.abs((await rect()).bottom - (await headFoot()))).toBeLessThan(1);
    await expect(button).not.toBeInViewport();
    /* Back at the top it's where it was, and the menu opens from it. */
    await frame.evaluate(() => scrollTo(0, 0));
    expect((await rect()).top).toBe(rest.top);
    await button.click();
    await expect(tab(frame, "Overview")).toBeInViewport();
    await expect(tab(frame, "Setup")).toBeInViewport();
  });
});

test.describe("after an update", () => {
  test("a page that stayed open asks for a reload in a dialog, and Later keeps it working and quiet for a while", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Overview")).toBeVisible();
    expect(await hostDialogOpen(page)).toBe(false);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page.evaluate(`panelModuleUrl = "/environment_control_static/0.1.0b6/host.js"; fakeHA.publish()`);
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await hostDialogText(page)).toBe("Environment Control was updated Reload to use the new version. Later Reload");
    const later = await hostButton(page, "later");
    await page.mouse.click(later!.x, later!.y);
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    /* The old panel carries on underneath, and isn't asked about again straight away. */
    await goTo(frame, "Setup");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await page.evaluate("fakeHA.publish()");
    await page.waitForTimeout(300);
    expect(await hostDialogOpen(page)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
  });

  test("Reload in that dialog reloads the page, and with a draft open it says the draft would be lost", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    /* The frame tells the host a draft is open a moment after it's drawn. */
    await expect.poll(() => page.evaluate<boolean>("panel.draftOpen")).toBe(true);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page.evaluate(`panelModuleUrl = "/environment_control_static/0.1.0b6/host.js"; fakeHA.publish()`);
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await hostDialogText(page)).toContain("You have changes that aren't applied yet, and reloading discards them: choose Later to apply them first.");
    const reload = await hostButton(page, "reload");
    await Promise.all([page.waitForEvent("load"), page.mouse.click(reload!.x, reload!.y)]);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBeUndefined();
    await panelFrame(page);
  });

  test("with the release HA registers, or no panel list at all, nothing asks for a reload", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Overview")).toBeVisible();
    await page.evaluate(`panelModuleUrl = location.origin + "/custom_components/environment_control/frontend/host.js"; fakeHA.publish()`);
    await page.waitForTimeout(200);
    expect(await hostDialogOpen(page)).toBe(false);
    await page.evaluate(`panelModuleUrl = undefined; fakeHA.publish()`);
    await page.waitForTimeout(200);
    expect(await hostDialogOpen(page)).toBe(false);
  });
});

test.describe("narrow window", () => {
  test("with HA's sidebar hidden, the menu button opens it, and only then is there one", async ({ page }) => {
    await page.goto(`${PAGE}?narrow=1`);
    let frame = await panelFrame(page);
    await openNav(frame);
    await app(frame).getByRole("menuitem", { name: "Open Home Assistant's sidebar" }).click();
    await expect.poll(() => page.evaluate<number>("sidebarToggles")).toBe(1);
    await page.goto(PAGE);
    frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Overview")).toBeVisible();
    await expect(app(frame).getByRole("menuitem", { name: "Open Home Assistant's sidebar" })).toHaveCount(0);
  });

  test("the host passes a change of width on, so the button comes and goes", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await openNav(frame);
    await expect(tab(frame, "Overview")).toBeVisible();
    await page.evaluate("panel.narrow = true");
    await expect(app(frame).getByRole("menuitem", { name: "Open Home Assistant's sidebar" })).toBeVisible();
    await page.evaluate("panel.narrow = false");
    await expect(app(frame).getByRole("menuitem", { name: "Open Home Assistant's sidebar" })).toHaveCount(0);
  });
});

test.describe("leaving with a draft open", () => {
  const draft = (frame: Frame, open: unknown) => frame.evaluate((o) => parent.postMessage({ v: 1, type: "draft", open: o }, "*"), open);

  test("closing the page asks only while the frame says a draft is open, and only true or false counts", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await leaveAsks(page)).toBe(false);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await draft(frame, "no");
    await page.waitForTimeout(100);
    expect(await leaveAsks(page)).toBe(true);
    await draft(frame, false);
    await expect.poll(() => leaveAsks(page)).toBe(false);
  });

  test("HA's sidebar is held and the host asks; Keep editing stays, Discard and leave goes", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    const overview = page.locator('ha-sidebar a[data-route="/lovelace"]');
    await overview.click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await overview.click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await page.evaluate(() => document.querySelector("environment-control-panel"))).toBeNull();
  });

  test("a navigation with no click, such as a notification tap, is held the same way", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    expect(await page.evaluate(() => location.hash)).toBe("#/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await page.evaluate(() => location.hash)).toBe("#/lovelace");
    expect(await page.evaluate(() => document.querySelector("environment-control-panel"))).toBeNull();
  });

  test("the back gesture is held too, and Discard and leave goes back", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => route(page)).toBe("/lovelace");
    await page.evaluate("haNavigate('/environment-control')");
    await expect.poll(() => route(page)).toBe("/environment-control");
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    /* A real gesture gives the page a user activation, which Chromium asks for before it lets a page cancel going back. */
    await page.mouse.click(5, 120);
    await page.evaluate(() => history.back());
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await page.mouse.click(5, 120);
    await page.evaluate(() => history.back());
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
  });

  test("with nothing unsaved, navigation with no click and going back go straight through", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await hostDialogOpen(page)).toBe(false);
    await page.evaluate(() => history.back());
    await expect.poll(() => route(page)).toBe("/environment-control");
    await panelFrame(page);
  });

  test("with nothing unsaved, the sidebar goes straight away, and coming back opens the panel fresh", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.locator('ha-sidebar a[data-route="/lovelace"]').click();
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await hostDialogOpen(page)).toBe(false);
    await page.locator('ha-sidebar a[data-route="/environment-control"]').click();
    await expect.poll(() => route(page)).toBe("/environment-control");
    await expect.poll(() => page.frames().length).toBe(2);
    expect(await leaveAsks(page)).toBe(false);
  });
});
