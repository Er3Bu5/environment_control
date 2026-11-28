/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { PAGE, app, goTo, panelFrame } from "./helpers";

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
});
