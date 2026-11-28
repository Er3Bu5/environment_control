/* Link automations and the rule that an automation belongs to one zone: another zone's are hidden behind a toggle,
   listed but never tickable with it on, and a tap on one says to remove it there first. Against the sample room, where
   the three Tent Lights automations are Veg's and Porch Light On is no zone's. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, hostButton, hostDialogOpen, hostDialogText, panelFrame } from "./helpers";

type Stored = { revision: number; zones: { id: string; automations?: { entity: string }[] }[] };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const linked = async (page: Page, zone: string) => ((await stored(page)).zones.find((z) => z.id === zone)?.automations ?? []).map((a) => a.entity);
/* What's stored, changed as another window would change it, which this page hears when HA comes back. */
const restartWith = (page: Page, change: string) =>
  page.evaluate(`(() => { fakeHA.knobs.restartMs = 50; const c = JSON.parse(fakeHA.disk); ${change}; fakeHA.disk = JSON.stringify(c); fakeHA.restart(); })()`);
async function allow(page: Page): Promise<void> {
  await expect.poll(() => hostDialogOpen(page)).toBe(true);
  /* Allow is off for a second after the dialog appears, so a stray tap can't land on it. */
  await page.waitForTimeout(1100);
  const button = await hostButton(page, "allow");
  await page.mouse.click(button!.x, button!.y);
  await expect.poll(() => hostDialogOpen(page)).toBe(false);
}

const heading = (frame: Frame) => app(frame).getByRole("heading", { level: 1, name: "Link automations: Garden", exact: true });
const search = (frame: Frame) => app(frame).getByRole("searchbox", { name: "Search Home Assistant" });
const toggle = (frame: Frame) => app(frame).getByRole("button", { name: "Show automations in other zones", exact: true });
const names = (frame: Frame) => app(frame).locator("#link-list .pick-text strong");
const hiddenLine = (frame: Frame) => app(frame).locator("#link-hidden");
const pick = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator(".pick-text strong", { hasText: new RegExp(`^${name}$`) }) });
const draftBar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes", exact: true });
const review = (frame: Frame) => app(frame).getByRole("dialog", { name: "Review changes", exact: true });
const told = (frame: Frame) => app(frame).getByRole("alertdialog");

async function openLinks(page: Page): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: "Set up Garden", exact: true }).click();
  await app(frame).getByRole("menuitem", { name: "Automations", exact: true }).click();
  await expect(heading(frame)).toBeVisible();
  await expect(app(frame).locator("#link-list")).toBeVisible();
  return frame;
}

test.describe("Link automations, an automation in another zone", () => {
  test("is left out of the list and search and counted under it, and the toggle, off at first, lists it marked and unticked", async ({ page }) => {
    const frame = await openLinks(page);
    await search(frame).fill("tent lights");
    await expect(app(frame).locator("#link-list")).toContainText("No automation matches.");
    await expect(hiddenLine(frame)).toHaveText("3 are hidden because another zone has them.");
    await expect(toggle(frame)).toHaveAttribute("aria-pressed", "false");
    await search(frame).fill("tent_lights_on");
    await expect(hiddenLine(frame)).toHaveText("1 is hidden because another zone has it.");
    await toggle(frame).click();
    await expect(toggle(frame)).toHaveAttribute("aria-pressed", "true");
    await expect(hiddenLine(frame)).toHaveCount(0);
    const tent = pick(frame, "Tent Lights On");
    await expect(tent.locator(".dev-sub")).toHaveText("In Zone: Veg");
    await expect(tent.locator(".pickrow")).toHaveAttribute("aria-disabled", "true");
    await expect(tent.locator(".pickrow")).toHaveAttribute("aria-pressed", "false");
    /* The toggle lasts as long as the page: a new search keeps showing them. */
    await search(frame).fill("tent lights");
    await expect(names(frame)).toHaveText(["Failsafe Tent Lights Recovery", "Tent Lights Off", "Tent Lights On"]);
    /* A search that finds none of another zone's has no toggle to offer. */
    await search(frame).fill("porch");
    await expect(names(frame)).toHaveText(["Porch Light On"]);
    await expect(toggle(frame)).toHaveCount(0);
    await expect(hiddenLine(frame)).toHaveCount(0);
  });

  test("a tap on one says to remove it from that zone first, in a dialog with one OK, and ticks and opens nothing", async ({ page }) => {
    const frame = await openLinks(page);
    await search(frame).fill("tent_lights_on");
    await toggle(frame).click();
    const row = pick(frame, "Tent Lights On").locator(".pickrow");
    for (const close of ["OK", "Escape"]) {
      /* aria-disabled holds Playwright's own click back, but a person's tap still lands on it, so the tap is forced. */
      await row.click({ force: true });
      await expect(told(frame).getByRole("heading", { name: "Tent Lights On", exact: true })).toBeVisible();
      await expect(told(frame)).toContainText("This automation is already associated to Zone: Veg. Please remove it before associating it with a new zone.");
      await expect(told(frame).getByRole("button")).toHaveText(["OK"]);
      if (close === "OK") await told(frame).getByRole("button", { name: "OK" }).click();
      else await page.keyboard.press("Escape");
      await expect(told(frame)).toHaveCount(0);
      await expect(heading(frame)).toBeVisible();
      await expect(row).toHaveAttribute("aria-pressed", "false");
      await expect(pick(frame, "Tent Lights On").getByRole("group", { name: "Group" })).toHaveCount(0);
      await expect(draftBar(frame)).toHaveCount(0);
    }
    expect(await hostDialogOpen(page)).toBe(false);
  });

  test("leaves the zone's own and free automations as they were, and a save never includes another zone's", async ({ page }) => {
    const frame = await openLinks(page);
    const high = pick(frame, "Critical Garden Temperature High Day").locator(".pickrow");
    await expect(high).toHaveAttribute("aria-pressed", "true");
    await expect(high).not.toHaveAttribute("aria-disabled", "true");
    await search(frame).fill("tent_lights_on");
    await toggle(frame).click();
    await pick(frame, "Tent Lights On").locator(".pickrow").click({ force: true });
    await told(frame).getByRole("button", { name: "OK" }).click();
    await search(frame).fill("porch");
    await pick(frame, "Porch Light On").locator(".pickrow").click();
    await expect(pick(frame, "Porch Light On").getByRole("radio", { name: "Control" })).toBeChecked();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Porch Light OnNot linked → Control"]);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const asked = await hostDialogText(page);
    expect(asked).toContain("automation.porch_light_on");
    expect(asked).not.toContain("tent_lights");
    await allow(page);
    await expect(app(frame).locator(".toast")).toHaveText("Garden's automations saved.");
    expect(await linked(page, "garden")).toContain("automation.porch_light_on");
    expect(await linked(page, "garden")).not.toContain("automation.tent_lights_on");
    expect(await linked(page, "veg")).toContain("automation.tent_lights_on");
  });

  test("one ticked here that another window links meanwhile is hidden as another zone's, and its save is refused with the reason", async ({ page }) => {
    const frame = await openLinks(page);
    await search(frame).fill("porch");
    await pick(frame, "Porch Light On").locator(".pickrow").click();
    await expect(draftBar(frame)).toContainText("Garden · Porch Light On");
    await restartWith(page, `c.zones.find((z) => z.id === "veg").automations.push({ id: "a99", entity: "automation.porch_light_on", group: "control" })`);
    await expect(hiddenLine(frame)).toHaveText("1 is hidden because another zone has it.");
    await expect(names(frame)).toHaveCount(0);
    /* As the mock does, the draft keeps it: the backend has the last word, and its refusal is shown as it comes. */
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await allow(page);
    await expect(review(frame).getByRole("alert")).toContainText("An automation can only be linked to one zone.");
    expect(await linked(page, "garden")).not.toContain("automation.porch_light_on");
  });
});
