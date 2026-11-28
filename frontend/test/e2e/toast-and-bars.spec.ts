/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, zoneMenu } from "./helpers";

/* A page whose foot bar shows as soon as it opens: Sensor Calibration's Back and Confirm. */
async function openCalibration(page: Page, query = ""): Promise<Frame> {
  await page.goto(PAGE + query);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: "Set up Garden" }).click();
  await app(frame).getByRole("menuitem", { name: "Sensor Calibration" }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
  await expect(app(frame).locator(".draftbar")).toBeVisible();
  return frame;
}

/* A page whose bar carries the going-on button from the start: Add zone's Review and apply. */
async function openAddZone(page: Page, query = "", mode?: "Light" | "Dark"): Promise<Frame> {
  await page.goto(PAGE + query);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  if (mode) {
    await app(frame).getByRole("group", { name: "Appearance" }).getByRole("button", { name: mode, exact: true }).click();
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe(mode.toLowerCase());
  }
  await app(frame).getByRole("button", { name: "Add zone" }).click();
  await expect(app(frame).locator(".draftbar .draft-review")).toBeVisible();
  return frame;
}

/* Any toast will do, so the one the panel's own code shows is raised straight away rather than by a save. */
const showToast = (frame: Frame, text: string) =>
  frame.evaluate((t) => (document.querySelector("ec-app") as unknown as { toast(t: string): void }).toast(t), text);

const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const luminance = (c: string) => {
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const colours = (frame: Frame, selector: string) =>
  frame.evaluate((sel) => {
    const host = document.querySelector("ec-app") as HTMLElement;
    const el = host.shadowRoot?.querySelector(sel) as HTMLElement;
    const probe = document.createElement("i");
    probe.style.color = getComputedStyle(host).getPropertyValue("--primary");
    document.body.append(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    return { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color, page: getComputedStyle(host).backgroundColor, primary };
  }, selector);

test.describe("toast and bars", () => {
  test("a toast drops in at the top of the view, clear of the foot bar", async ({ page }) => {
    const frame = await openCalibration(page);
    await showToast(frame, "Saved.");
    const toast = app(frame).locator(".toast");
    await expect(toast).toHaveText("Saved.");
    await expect(toast).toHaveAttribute("role", "status");
    await expect(toast).toHaveAttribute("aria-live", "polite");
    await page.waitForTimeout(300);
    const t = (await toast.boundingBox())!, bar = (await app(frame).locator(".draftbar").boundingBox())!, view = page.viewportSize()!;
    expect(t.y + t.height).toBeLessThan(view.height / 3);
    expect(t.y + t.height <= bar.y || t.y >= bar.y + bar.height).toBe(true);
    /* It still goes by itself. */
    await expect(toast).toHaveCount(0, { timeout: 5000 });
  });

  test("a tap on what the toast lies over still lands there", async ({ page }) => {
    const frame = await openCalibration(page);
    await showToast(frame, "A message long enough to lie over something under it.");
    const toast = app(frame).locator(".toast");
    await page.waitForTimeout(300);
    const under = await frame.evaluate(() => {
      const root = document.querySelector("ec-app")!.shadowRoot!;
      const r = root.querySelector(".toast")!.getBoundingClientRect();
      const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) ?? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit.closest(".toast")) return "toast";
      (window as unknown as { tapped: boolean }).tapped = false;
      hit.addEventListener("click", (e) => { (window as unknown as { tapped: boolean }).tapped = true; e.preventDefault(); e.stopPropagation(); }, { once: true });
      return hit.tagName;
    });
    expect(under).not.toBe("toast");
    const box = (await toast.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await frame.evaluate(() => (window as unknown as { tapped: boolean }).tapped)).toBe(true);
  });

  const animation = (frame: Frame) =>
    frame.evaluate(() => getComputedStyle(document.querySelector("ec-app")!.shadowRoot!.querySelector(".toast")!).animationName);

  test("the toast slides down into view", async ({ page }) => {
    const frame = await openCalibration(page);
    await showToast(frame, "Saved.");
    expect(await animation(frame)).toBe("toast-in");
  });

  test("with reduced motion the toast appears without sliding", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const frame = await openCalibration(page);
    await showToast(frame, "Saved.");
    await expect(app(frame).locator(".toast")).toBeVisible();
    expect(await animation(frame)).toBe("none");
  });

  for (const mode of ["Light", "Dark"] as const) {
    test(`in ${mode.toLowerCase()} the foot bar is a grey of its own, not a white or black slab`, async ({ page }) => {
      const frame = await openAddZone(page, "", mode);
      const { bg, page: ground } = await colours(frame, ".draftbar");
      expect(rgb(bg)).not.toEqual([255, 255, 255]);
      expect(rgb(bg)).not.toEqual([0, 0, 0]);
      /* Close to the page it stands on, not a band of the other theme. */
      expect(contrast(bg, ground)).toBeLessThan(2);
    });
  }

  for (const primary of ["#FFEB3B", "#1A237E", "#03A9F4", "#F44336"]) {
    test(`the going-on button is the primary colour ${primary} with readable text on it`, async ({ page }) => {
      const frame = await openAddZone(page, `?primary=${encodeURIComponent(primary)}`);
      const c = await colours(frame, ".draftbar .draft-review");
      expect(c.bg).toBe(c.primary);
      expect(contrast(c.bg, c.fg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("a dialog's foot sits under a divider, on the dialog's own background", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View activity");
    const foot = app(frame).getByRole("dialog").locator(".dlgfoot");
    await expect(foot).toBeVisible();
    const look = await foot.evaluate((el) => {
      const s = getComputedStyle(el), close = getComputedStyle(el.querySelector("button")!);
      return { width: s.borderTopWidth, style: s.borderTopStyle, pad: s.paddingTop, close: close.backgroundColor };
    });
    expect(look).toMatchObject({ width: "1px", style: "solid", pad: "12px", close: "rgba(0, 0, 0, 0)" });
  });
});
