/* A linked automation's own name in the panel, set on Link automations and shown wherever the panel names it. Home
   Assistant's name stays on the row, and the host's own question names only Home Assistant's automation and entity. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, hostButton, hostDialogOpen, hostDialogText, panelFrame, zoneMenu } from "./helpers";

type Link = { id: string; entity: string; group: string; name?: string };
type Stored = { revision: number; zones: { id: string; automations?: Link[] }[] };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const linkOf = async (page: Page, zone: string, entity: string) => (await stored(page)).zones.find((z) => z.id === zone)?.automations?.find((a) => a.entity === entity);
const restartWith = (page: Page, change: string) =>
  page.evaluate(`(() => { fakeHA.knobs.restartMs = 50; const c = JSON.parse(fakeHA.disk); ${change}; fakeHA.disk = JSON.stringify(c); fakeHA.restart(); })()`);

const DEHU = "automation.failsafe_dehumidifier_mains_auto_on", HA_DEHU = "Failsafe Dehumidifier Mains Auto On";
const PORCH = "automation.porch_light_on";
const heading = (frame: Frame, name: string) => app(frame).getByRole("heading", { level: 1, name, exact: true });
const pick = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator(".pick-text strong", { hasText: new RegExp(`^${name}$`) }) });
/* By entity, since the row's top line becomes the name as it's typed. */
const rowOf = (frame: Frame, entity: string) => app(frame).locator(`#lk-${entity.replace(/[^A-Za-z0-9_-]/g, "_")}`);
const nameBox = (row: ReturnType<typeof pick>) => row.getByRole("textbox", { name: "Name, optional", exact: true });
const draftBar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes", exact: true });
const review = (frame: Frame) => app(frame).getByRole("dialog", { name: "Review changes", exact: true });
const toast = (frame: Frame) => app(frame).locator(".toast");
const autos = (frame: Frame) => app(frame).getByRole("dialog", { name: /^Automations: / });

async function toLinks(frame: Frame, zone: string): Promise<void> {
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: `Set up ${zone}`, exact: true }).click();
  await app(frame).getByRole("menuitem", { name: "Automations", exact: true }).click();
  await expect(heading(frame, `Link automations: ${zone}`)).toBeVisible();
  await expect(app(frame).locator("#link-list")).toBeVisible();
}
async function openLinks(page: Page, zone: string): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await toLinks(frame, zone);
  return frame;
}
/* On a phone a box being typed in hides the foot bar, as the keyboard would cover it, so each is left after typing. */
async function typeName(row: ReturnType<typeof pick>, value: string): Promise<void> {
  await nameBox(row).fill(value);
  await nameBox(row).blur();
}
async function allow(page: Page): Promise<void> {
  await expect.poll(() => hostDialogOpen(page)).toBe(true);
  await page.waitForTimeout(1100);
  const button = await hostButton(page, "allow");
  await page.mouse.click(button!.x, button!.y);
  await expect.poll(() => hostDialogOpen(page)).toBe(false);
}

test.describe("an automation's own name", () => {
  test("typed for a ticked row, it's in the review, saved only on Apply, and names the dialog's row and the failsafe-off question", async ({ page }) => {
    const frame = await openLinks(page, "Garden");
    const row = rowOf(frame, DEHU);
    await expect(pick(frame, HA_DEHU)).toHaveCount(1);
    await expect(nameBox(row)).toHaveValue("");
    await expect(nameBox(row)).toHaveAttribute("placeholder", HA_DEHU);
    await expect(nameBox(row)).toHaveAttribute("maxlength", "100");
    await typeName(row, "  Dehumidifier power ");
    const named = pick(frame, "Dehumidifier power");
    await expect(named.locator(".pick-text .dev-sub")).toHaveText(new RegExp(`^${HA_DEHU}\\. ${DEHU}`));
    await expect(named.getByRole("button", { name: `Put back Home Assistant's name, ${HA_DEHU}`, exact: true })).toBeVisible();
    await expect(draftBar(frame)).toContainText("Garden · Name");
    expect((await linkOf(page, "garden", DEHU))?.name).toBeUndefined();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText([`Name${HA_DEHU} → Dehumidifier power`]);
    expect((await linkOf(page, "garden", DEHU))?.name).toBeUndefined();
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(toast(frame)).toHaveText("Garden's automations saved.");
    expect(await hostDialogOpen(page)).toBe(false);
    expect(await linkOf(page, "garden", DEHU)).toMatchObject({ entity: DEHU, group: "failsafe", name: "Dehumidifier power" });
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View automations");
    await autos(frame).getByRole("group", { name: "Automations", exact: true }).getByRole("button", { name: /^Failsafes,/ }).click();
    await expect(autos(frame).getByRole("switch", { name: HA_DEHU, exact: true })).toHaveCount(0);
    await autos(frame).getByRole("switch", { name: "Dehumidifier power", exact: true }).click();
    const guard = app(frame).getByRole("alertdialog");
    await expect(guard.getByRole("heading", { name: "Switch off Dehumidifier power?", exact: true })).toBeVisible();
    await guard.getByRole("button", { name: "Keep it on", exact: true }).click();
  });

  test("put back, Home Assistant's name returns and the saved link carries no name at all", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await restartWith(page, `c.zones.find((z) => z.id === "garden").automations.find((a) => a.entity === ${JSON.stringify(DEHU)}).name = "Dehumidifier power"`);
    await expect.poll(async () => (await linkOf(page, "garden", DEHU))?.name).toBe("Dehumidifier power");
    await toLinks(frame, "Garden");
    const row = rowOf(frame, DEHU);
    await expect(pick(frame, "Dehumidifier power")).toHaveCount(1);
    await expect(nameBox(row)).toHaveValue("Dehumidifier power");
    await row.getByRole("button", { name: `Put back Home Assistant's name, ${HA_DEHU}`, exact: true }).click();
    const back = rowOf(frame, DEHU);
    await expect(back.locator(".pick-text strong")).toHaveText(HA_DEHU);
    await expect(nameBox(back)).toHaveValue("");
    await expect(nameBox(back)).toBeFocused();
    await expect(back.locator(".reset")).toHaveCount(0);
    await expect(back.locator(".pick-text .dev-sub")).toHaveText(new RegExp(`^${DEHU}`));
    await nameBox(back).blur();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText([`NameDehumidifier power → ${HA_DEHU}`]);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(toast(frame)).toHaveText("Garden's automations saved.");
    const link = await linkOf(page, "garden", DEHU);
    expect(link).toBeDefined();
    expect("name" in link!).toBe(false);
  });

  test("an unticked row has no box, and a name of only spaces or past 100 characters can't be applied, saying why", async ({ page }) => {
    const frame = await openLinks(page, "Nursery");
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("porch");
    const row = rowOf(frame, PORCH);
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await row.locator(".pickrow").click();
    await typeName(row, "   ");
    const spaces = "Spaces alone aren't a name. Type one for Porch Light On, or put Home Assistant's back.";
    await expect(row).toContainText(spaces);
    await expect(nameBox(row)).toHaveAttribute("aria-invalid", "true");
    await expect(draftBar(frame)).toContainText(`Fix first: ${spaces}`);
    await expect(draftBar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    /* The box stops at 100, so a longer name can only come from elsewhere, as script does here. */
    await nameBox(row).evaluate((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }, "x".repeat(101));
    await nameBox(row).blur();
    const long = "The name for Porch Light On is longer than 100 characters.";
    await expect(row).toContainText(long);
    await expect(draftBar(frame)).toContainText(`Fix first: ${long}`);
    await expect(draftBar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await row.locator(".pickrow").click();
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await expect(app(frame).getByRole("region", { name: "Page buttons", exact: true })).toBeVisible();
  });

  test("Home Assistant's question for a newly linked one names Home Assistant's automation and entity, not the panel's name", async ({ page }) => {
    const frame = await openLinks(page, "Nursery");
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("porch");
    const row = rowOf(frame, PORCH);
    await row.locator(".pickrow").click();
    await typeName(row, "Front step lamp");
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Porch Light OnNot linked → Control", "NamePorch Light On → Front step lamp"]);
    await review(frame).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const asked = await hostDialogText(page);
    expect(asked).toContain("Porch Light On");
    expect(asked).toContain(PORCH);
    expect(asked).not.toContain("Front step lamp");
    await allow(page);
    await expect(toast(frame)).toHaveText("Nursery's automations saved.");
    expect(await linkOf(page, "nursery", PORCH)).toMatchObject({ entity: PORCH, group: "control", name: "Front step lamp" });
  });
});
