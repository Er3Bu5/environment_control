/* Linked zones (#91), first piece: the link in Zone details, a family kept together in the zone order, and a sensor
   shared only inside a family. The sample room has Nursery linked to Veg, and the fake HA checks every save as the
   backend does. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, dialogFoot, goTo, panelFrame } from "./helpers";

type Stored = { revision: number; zones: { id: string; name: string; parent?: string; sensors: { id: string }[] }[] };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const dialog = (frame: Frame) => app(frame).getByRole("dialog");
const alert = (frame: Frame) => app(frame).getByRole("alertdialog");
const linkBox = (frame: Frame) => app(frame).getByLabel("This is a linked zone");
const linkedTo = (frame: Frame) => app(frame).locator("fieldset", { has: frame.locator("legend", { hasText: /^Linked to$/ }) });
const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Page buttons", exact: true });
const row = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });

async function open(page: Page, zone: string, item: string): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
  await app(frame).getByRole("menuitem", { name: item, exact: true }).click();
  return frame;
}

test.describe("linked zones", () => {
  test("linking a zone saves its parent, moves it next to its parent, and a later save keeps the link", async ({ page }) => {
    const frame = await open(page, "Garden", "Zone details");
    await expect(linkBox(frame)).not.toBeChecked();
    await expect(linkedTo(frame)).toHaveCount(0);
    await linkBox(frame).check();
    /* Nursery is itself linked and Garden can't be its own parent, so Veg is the only choice. */
    await expect(linkedTo(frame).getByRole("radio")).toHaveCount(1);
    await expect(linkedTo(frame).getByLabel("Zone: Veg", { exact: true })).toBeVisible();
    await expect(app(frame).getByRole("button", { name: "Pick the zone it's linked to ›" })).toBeVisible();
    await expect(bar(frame).getByRole("button", { name: "Finish" })).toBeDisabled();
    await linkedTo(frame).getByLabel("Zone: Veg", { exact: true }).check();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame).locator(".review-row")).toHaveCount(1);
    await expect(dialog(frame).locator(".review-row")).toContainText("Linked to");
    await expect(dialog(frame).locator(".review-row")).toContainText("Not linked");
    await expect(dialog(frame).locator(".review-row b")).toHaveText("Zone: Veg");
    await expect(dialog(frame)).toContainText("Garden moves next to Veg and the zones linked to it on Overview, in the menu and on Setup.");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("status").filter({ hasText: "Zone details saved." })).toBeVisible();
    await expect(bar(frame).getByRole("button", { name: "Finish" })).toBeEnabled();
    let saved = await stored(page);
    expect(saved.zones.map((z) => z.id)).toEqual(["veg", "nursery", "garden"]);
    expect(saved.zones.find((z) => z.id === "garden")?.parent).toBe("veg");

    /* A rename is a save of something else, and keeps the link. */
    await app(frame).getByLabel("Zone name").fill("Garden tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame).locator(".review-row")).toHaveCount(1);
    await expect(dialog(frame)).not.toContainText("moves next to");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(bar(frame).getByRole("button", { name: "Finish" })).toBeEnabled();
    saved = await stored(page);
    expect(saved.zones.find((z) => z.id === "garden")).toMatchObject({ name: "Garden tent", parent: "veg" });
    expect(saved.zones.map((z) => z.id)).toEqual(["veg", "nursery", "garden"]);
  });

  test("unticking unlinks, leaving the key out and the zone where it is", async ({ page }) => {
    const frame = await open(page, "Nursery", "Zone details");
    await expect(linkBox(frame)).toBeChecked();
    await expect(linkedTo(frame).getByLabel("Zone: Veg", { exact: true })).toBeChecked();
    await expect(linkedTo(frame).getByLabel("Zone: Garden", { exact: true })).toBeVisible();
    await linkBox(frame).uncheck();
    await expect(linkedTo(frame)).toHaveCount(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame).locator(".review-row")).toContainText("Zone: Veg");
    await expect(dialog(frame).locator(".review-row b")).toHaveText("Not linked");
    await expect(dialog(frame)).not.toContainText("moves next to");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("status").filter({ hasText: "Zone details saved." })).toBeVisible();
    const saved = await stored(page);
    expect(saved.zones.map((z) => z.id)).toEqual(["garden", "veg", "nursery"]);
    expect("parent" in (saved.zones.find((z) => z.id === "nursery") ?? {})).toBe(false);
  });

  test("a zone with zones linked to it can't be linked, and removing it says its linked zones are unlinked", async ({ page }) => {
    const frame = await open(page, "Veg", "Zone details");
    await expect(linkBox(frame)).toHaveCount(0);
    await expect(app(frame).locator("#wiz-linked")).toHaveText("Zone: Nursery is linked to this zone, so it can't be linked to another.");
    await bar(frame).getByRole("button", { name: "Finish" }).click();
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    await expect(alert(frame)).toContainText("Linked zones");
    await expect(alert(frame)).toContainText("Nursery is unlinked");
    await alert(frame).getByLabel("Type Veg to confirm").fill("Veg");
    await alert(frame).getByRole("button", { name: "Remove zone" }).click();
    await expect(app(frame).getByRole("status").filter({ hasText: "Veg removed." })).toBeVisible();
    const saved = await stored(page);
    expect(saved.zones.map((z) => z.id)).toEqual(["garden", "nursery"]);
    expect("parent" in (saved.zones.find((z) => z.id === "nursery") ?? {})).toBe(false);
  });

  /* The sample's own zones hold sensors the fake catalog doesn't list, so their Device identification can't be applied:
     the family here is made of zones added in the test. */
  test("a sensor is shared only inside a family: the parent's is asked about, another zone's is refused", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const board = () => row(frame, "Environment board").locator(".pickrow");
    const fromSetup = async (zone: string, item: string) => {
      await goTo(frame, "Setup");
      await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
      await app(frame).getByRole("menuitem", { name: item, exact: true }).click();
    };
    const addZone = async (name: string, parent = "") => {
      await goTo(frame, "Setup");
      await app(frame).getByRole("button", { name: "Add zone" }).click();
      await app(frame).getByLabel("Zone name").fill(name);
      await app(frame).getByLabel("Zone name").press("Enter");
      if (parent) {
        await linkBox(frame).check();
        await linkedTo(frame).getByLabel(`Zone: ${parent}`, { exact: true }).check();
      }
      await bar(frame).getByRole("button", { name: "Review and apply" }).click();
      if (parent) await expect(dialog(frame).locator(".review-row", { hasText: "Linked to" }).locator("b")).toHaveText(`Zone: ${parent}`);
      await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
      await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
      await expect(app(frame).getByRole("heading", { level: 1, name: `Device identification: ${name}`, exact: true })).toBeVisible();
    };
    const apply = async () => {
      for (let i = 0; i < 3 && !(await dialog(frame).isVisible()); i++) await next(frame).click();
      await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
      await expect(next(frame)).toHaveText("Finish");
      await next(frame).click();
    };
    const refusedInGarden = async (text: string) => {
      await fromSetup("Garden", "Device identification");
      await board().click();
      const told = alert(frame);
      await expect(told.getByRole("heading", { name: "Environment board", exact: true })).toBeVisible();
      await expect(told.locator("#dlg-text")).toHaveText(text);
      await dialogFoot(told, ["OK"]);
      await told.getByRole("button", { name: "OK" }).click();
      await expect(told).toHaveCount(0);
      await expect(board()).toHaveAttribute("aria-pressed", "false");
      await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Garden", exact: true })).toBeVisible();
      await app(frame).getByRole("button", { name: "Cancel", exact: true }).click();
    };

    await addZone("Flower tent");
    await board().click();
    await apply();
    await refusedInGarden("This sensor is already associated to Zone: Flower tent. If you want a duplicate here, this zone must be linked to Flower tent. This can be done in the Zone details section of Setup.");

    /* Linked to Flower tent, its sensor is asked about, as any shared sensor was before linked zones. */
    await addZone("Seedlings", "Flower tent");
    expect((await stored(page)).zones.find((z) => z.id === "seedlings")?.parent).toBe("flower_tent");
    await board().click();
    await expect(alert(frame).locator("#dlg-text")).toHaveText("This sensor is already associated to Zone: Flower tent. Are you sure you want to duplicate it here?");
    await alert(frame).getByRole("button", { name: "Add", exact: true }).click();
    await expect(board()).toHaveAttribute("aria-pressed", "true");
    const before = (await stored(page)).revision;
    await apply();
    let saved = await stored(page);
    expect(saved.revision).toBe(before + 1);
    expect(saved.zones.find((z) => z.id === "seedlings")).toMatchObject({ parent: "flower_tent", sensors: [{ id: "d-board" }] });
    await refusedInGarden("This sensor is already associated to Zones: Flower tent, Seedlings. If you want a duplicate here, this zone must be linked to Flower tent. This can be done in the Zone details section of Setup.");

    /* Unlinking while that sensor is shared across the link is refused by the backend, said in the review, and saves nothing. */
    await fromSetup("Seedlings", "Zone details");
    await linkBox(frame).uncheck();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toContainText("Take it out of Seedlings before unlinking it.");
    saved = await stored(page);
    expect(saved.revision).toBe(before + 1);
    expect(saved.zones.find((z) => z.id === "seedlings")?.parent).toBe("flower_tent");
    await dialog(frame).getByRole("button", { name: "Back to editing" }).click();
    await linkBox(frame).check();
    await linkedTo(frame).getByLabel("Zone: Flower tent", { exact: true }).check();
    await bar(frame).getByRole("button", { name: "Finish" }).click();

    /* So is removing the parent while it is. */
    await fromSetup("Flower tent", "Remove zone");
    await expect(alert(frame)).toContainText("Seedlings is unlinked");
    await alert(frame).getByLabel("Type Flower tent to confirm").fill("Flower tent");
    await alert(frame).getByRole("button", { name: "Remove zone" }).click();
    await expect(app(frame).getByRole("status").filter({ hasText: "Take it out of Seedlings before removing Flower tent." })).toBeVisible();
    saved = await stored(page);
    expect(saved.revision).toBe(before + 1);
    expect(saved.zones.map((z) => z.id)).toEqual(["garden", "veg", "nursery", "flower_tent", "seedlings"]);
  });
});
