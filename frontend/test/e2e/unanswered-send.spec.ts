/* A tap the host never answers, as while Home Assistant's connection is coming back. The wait for a report runs from
   the send, so the row still ends on Not confirmed and can be tapped again, and the first tap's answer, when it does
   come, belongs to an older tap and changes nothing. The clock is moved past the wait rather than waited out. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, zoneMenu } from "./helpers";

/* fakeHA is declared with const, so it's a global but not a window property: reached as an expression. Each held call
   keeps its settle functions, for answering it late. */
const holdCalls = (page: Page) =>
  page.evaluate(`(() => { fakeHA.held = []; fakeHA.callService = (domain, service, data) => new Promise((resolve, reject) => fakeHA.held.push({ resolve, reject, service, data })); })()`);
const refuseHeld = (page: Page, i: number) => page.evaluate(`fakeHA.held[${i}].reject(new Error("Took too long."))`);
const heldCount = (page: Page) => page.evaluate<number>("fakeHA.held.length");
const GIVE_UP_MS = 10_000;

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("an automation switch the host never answers is not confirmed after the wait, and the late answer changes nothing", async ({ page }) => {
  const name = "Critical Garden Temperature High Day";
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Garden");
  await zoneMenu(frame, "View automations");
  await expect(app(frame).getByRole("heading", { level: 1, name: "Automations: Garden", exact: true })).toBeVisible();
  const sw = app(frame).getByRole("switch", { name, exact: true });
  const status = app(frame).locator(".dev", { has: frame.getByRole("switch", { name, exact: true }) }).getByRole("status");
  await holdCalls(page);
  await sw.click();
  await expect(status).toHaveText("Sent. Waiting for Home Assistant to report it off.");
  await expect(sw).toBeDisabled();
  await page.clock.fastForward(GIVE_UP_MS + 500);
  await expect(status).toHaveText("Not confirmed. Home Assistant still reports it on. Try again.");
  await expect(sw).toBeEnabled();
  await sw.click();
  await expect(status).toHaveText("Sent. Waiting for Home Assistant to report it off.");
  await expect.poll(() => heldCount(page)).toBe(2);
  await refuseHeld(page, 0);
  await page.waitForTimeout(300);
  await expect(status).toHaveText("Sent. Waiting for Home Assistant to report it off.");
  await expect(sw).toBeDisabled();
});

test("a device control the host never answers is not confirmed after the wait, and the late answer changes nothing", async ({ page }) => {
  await page.goto(PAGE);
  const frame: Frame = await panelFrame(page);
  await goTo(frame, "Garden");
  const controls = app(frame).locator("#controls");
  await expect(controls).toBeVisible();
  const sw = controls.getByRole("switch", { name: "Heater", exact: true });
  const status = controls.locator(".dev", { has: frame.locator(".dev-name", { hasText: /^Heater$/ }) }).getByRole("status");
  await holdCalls(page);
  await sw.click();
  await expect(status).toHaveText("Sent. Waiting for Heater to report back.");
  await expect(sw).toBeDisabled();
  await page.clock.fastForward(GIVE_UP_MS + 500);
  await expect(status).toHaveText("Not confirmed. Heater still reports off. A Tuya plug can drop a command without saying, so try again.");
  await expect(sw).toBeEnabled();
  await sw.click();
  await expect(status).toHaveText("Sent. Waiting for Heater to report back.");
  await expect.poll(() => heldCount(page)).toBe(2);
  await refuseHeld(page, 0);
  await page.waitForTimeout(300);
  await expect(status).toHaveText("Sent. Waiting for Heater to report back.");
  await expect(sw).toBeDisabled();
});
