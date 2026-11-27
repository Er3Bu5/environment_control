/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, dialogFoot, goTo, hostDialogOpen, leaveAsks, openNav, panelFrame, serviceCalls, tab, zoneMenu } from "./helpers";

test.describe("zones", () => {
  const stored = (page: Page) => page.evaluate<{ revision: number; zones: { id: string; name: string; description?: string; setup?: Record<string, string> }[]; devices: { id: string; zones: string[] }[] }>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const alert = (frame: Frame) => app(frame).getByRole("alertdialog");

  test("adding a zone needs a new name, shows what it saves, and opens its setup guide", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    const name = app(frame).getByLabel("Zone name"), review = app(frame).getByRole("button", { name: "Review and apply" });
    await expect(review).toBeDisabled();
    await name.fill("veg");
    /* Said under the box as it's typed, and in the bar, where it's a link back to the box, once the box is left. */
    await expect(app(frame).getByRole("status").filter({ hasText: /^There's already a zone called veg$/ })).toBeVisible();
    await name.press("Enter");
    await expect(review).toBeDisabled();
    await expect(app(frame).getByRole("button", { name: "There's already a zone called veg ›" })).toBeVisible();
    await name.fill("Flower tent");
    await expect(app(frame).getByRole("status").filter({ hasText: "already a zone" })).toHaveCount(0);
    await app(frame).getByLabel("Description, optional").fill("By the window");
    await review.click();
    await expect(dialog(frame)).toContainText("Zone name");
    await expect(dialog(frame)).toContainText("Flower tent");
    await expect(dialog(frame)).toContainText("By the window");
    await dialog(frame).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await openNav(frame);
    await expect(tab(frame, "Flower tent")).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.description).toBe("By the window");
    expect(z?.setup).toEqual({ details: "done", devices: "todo", layout: "todo", place: "todo", calibrate: "todo", targets: "todo" });
    expect(await serviceCalls(page)).toBe(0);
  });

  test("leaving with a draft asks first, and the host knows a draft is open", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Seedlings");
    await app(frame).getByLabel("Zone name").press("Enter");
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await goTo(frame, "Overview");
    await expect(alert(frame)).toContainText("Discard unsaved changes?");
    await alert(frame).getByRole("button", { name: "Keep editing" }).click();
    await expect(app(frame).getByLabel("Zone name")).toHaveValue("Seedlings");
    await goTo(frame, "Overview");
    await alert(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(app(frame).locator(".zone-card")).toHaveCount(3);
    await expect.poll(() => leaveAsks(page)).toBe(false);
    expect((await stored(page)).zones.map((z) => z.id)).not.toContain("seedlings");
  });

  test("a dialog's buttons are its own foot, leaving first, and the page's bar stays pinned to the window", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByLabel("Zone name").fill("Veg tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    /* A page with a draft keeps its bar at the foot of the window. */
    const unsaved = app(frame).getByRole("region", { name: "Page buttons", exact: true });
    const pinned = async () => {
      const gap = await unsaved.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(40);
    };
    await pinned();
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialogFoot(dialog(frame), ["Back to editing", "Apply 1 change"]);
    await dialog(frame).getByRole("button", { name: "Back to editing" }).click();
    await pinned();
    await goTo(frame, "Overview");
    await dialogFoot(alert(frame), ["Keep editing", "Discard and continue"]);
    await alert(frame).getByRole("button", { name: "Discard and continue" }).click();
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View targets");
    await dialogFoot(dialog(frame), ["Close", "Set targets"]);
    await dialog(frame).getByRole("button", { name: "Close" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    await zoneMenu(frame, "View activity");
    await dialogFoot(dialog(frame), ["Close"]);
    await dialog(frame).getByRole("button", { name: "Close" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    await alert(frame).getByLabel("Type Nursery to confirm").fill("Nursery");
    await expect(alert(frame).getByLabel("Type Nursery to confirm")).toBeFocused();
    await dialogFoot(alert(frame), ["Keep zone", "Remove zone"]);
    await alert(frame).getByRole("button", { name: "Keep zone" }).click();
    expect((await stored(page)).zones.map((z) => z.id)).toEqual(["garden", "veg", "nursery"]);
  });

  test("a dialog taller than the window scrolls its middle, and its title and buttons stay in view", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    for (const size of [{ width: 360, height: 480 }, { width: 740, height: 360 }]) {
      await page.setViewportSize(size);
      await zoneMenu(frame, "View targets");
      const box = dialog(frame);
      expect(await box.locator(".review-scroll").evaluate((el) => el.scrollHeight > el.clientHeight + 20)).toBe(true);
      await expect(box.getByRole("heading", { name: "Targets: Garden" })).toBeInViewport({ ratio: 1 });
      await dialogFoot(box, ["Close", "Set targets"]);
      await box.getByRole("button", { name: "Close" }).click();
    }
  });

  test("on a phone with the keyboard up, the box in Remove zone and the dialog's buttons are both above it", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "Touch screens only: a mouse has no on-screen keyboard.");
    for (const size of [null, { width: 839, height: 412 }]) {
      if (size) await page.setViewportSize(size);
      await page.goto(PAGE);
      const frame = await panelFrame(page);
      await goTo(frame, "Setup");
      await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
      await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
      const field = alert(frame).getByLabel("Type Nursery to confirm");
      await field.fill("Nursery");
      await expect(field).toBeFocused();
      /* With nothing to measure, the keyboard is taken to cover the lower half of the screen, more of it lying down. */
      const keysAt = await frame.evaluate(() => innerHeight * (innerHeight > innerWidth ? 0.5 : 0.38));
      const at = () =>
        frame.evaluate(() => {
          const root = document.querySelector("ec-app")!.shadowRoot!, r = (sel: string) => root.querySelector(sel)!.getBoundingClientRect().toJSON() as DOMRect;
          return { dialog: r(".dialog"), field: r("#dlg-confirm"), foot: r(".dlgfoot") };
        });
      await expect.poll(async () => (await at()).dialog.bottom).toBeLessThanOrEqual(keysAt);
      /* The dialog scrolls the box clear of its buttons, where it can't show everything at once. */
      await expect.poll(async () => { const x = await at(); return x.foot.top - x.field.bottom; }).toBeGreaterThanOrEqual(0);
      const { field: f, foot: b } = await at();
      expect(f.top).toBeGreaterThanOrEqual(0);
      expect(f.bottom).toBeLessThanOrEqual(b.top);
      expect(b.bottom).toBeLessThanOrEqual(keysAt);
      await alert(frame).getByRole("button", { name: "Keep zone" }).click();
    }
  });

  test("the setup guide's bar goes on to the next step still to do", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const bar = app(frame).getByRole("region", { name: "Page buttons", exact: true });
    await expect(bar.getByRole("button")).toHaveText(["Finish for now", "Continue"]);
    await bar.getByRole("button", { name: "Continue" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Flower tent", exact: true })).toBeVisible();
  });

  test("Zone details renames from the menu, and Finish with nothing changed saves nothing", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByLabel("Zone name").fill("Veg tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await openNav(frame);
    await expect(tab(frame, "Veg tent")).toBeVisible();
    const revision = (await stored(page)).revision;
    expect((await stored(page)).zones.find((z) => z.id === "veg")?.name).toBe("Veg tent");
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg tent" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByRole("button", { name: "Finish" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    expect((await stored(page)).revision).toBe(revision);
  });

  test("removing a zone needs its name typed exactly, and shared devices stay in their other zones", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    const remove = alert(frame).getByRole("button", { name: "Remove zone" });
    await expect(alert(frame)).toContainText("Remove Nursery?");
    await expect(remove).toBeDisabled();
    await alert(frame).getByLabel("Type Nursery to confirm").fill("nursery");
    await expect(remove).toBeDisabled();
    await alert(frame).getByLabel("Type Nursery to confirm").fill("Nursery");
    await remove.click();
    await openNav(frame);
    await expect(tab(frame, "Nursery")).toHaveCount(0);
    const after = await stored(page);
    expect(after.zones.map((z) => z.id)).toEqual(["garden", "veg"]);
    expect(after.devices.find((d) => d.id === "lc-tent")?.zones).toEqual(["veg"]);
    expect(after.devices.every((d) => !d.zones.includes("nursery"))).toBe(true);
  });

  test("Escape keeps the zone, and a zone named with markup is drawn as text", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill('<img src=x onerror="window.pwned=1">');
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await openNav(frame);
    await expect(tab(frame, '<img src=x onerror="window.pwned=1">')).toBeVisible();
    expect(await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.querySelectorAll("img").length)).toBe(0);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    await page.keyboard.press("Escape");
    await expect(alert(frame)).toHaveCount(0);
    await openNav(frame);
    await expect(tab(frame, "Veg")).toBeVisible();
  });

  test("a save that would make a device controllable waits for you, in the host's own dialog", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const answer = frame.evaluate(
      (config) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === 777 && resolve(e.data));
          const devices = config.devices.map((d: { id: string; zones: string[] }) => (d.id === "spare-plug" ? { ...d, zones: ["garden"] } : d));
          parent.postMessage({ v: 1, type: "save", req: 777, base: config.revision, config: { zones: config.zones, devices } }, "*");
        }),
      before,
    );
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await answer).toEqual(expect.objectContaining({ ok: false, error: "Not allowed, so nothing was saved." }));
    expect((await stored(page)).revision).toBe(before.revision);
  });
});
