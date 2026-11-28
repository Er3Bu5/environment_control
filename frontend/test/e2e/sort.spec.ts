/* Sort on Overview: the order zones are stored in, moved card by card, as a draft that's saved through the review. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, leaveAsks, openNav, panelFrame, serviceCalls } from "./helpers";

const NAMES = ["Garden", "Veg", "Nursery"];
const stored = (page: Page) => page.evaluate<{ revision: number; zones: { id: string }[] }>("JSON.parse(JSON.stringify(fakeHA.config))");
const cards = (frame: Frame) => app(frame).locator(".zone-card h2").allTextContents();
const sortButton = (frame: Frame) => app(frame).locator(".pagehead").getByRole("button", { name: "Sort", exact: true });
/* Veg and Nursery are a family, so their own buttons say they move within it (#91). */
const move = (frame: Frame, name: string, to: "previous" | "next") => app(frame).getByRole("button", { name: new RegExp(`^Move ${name} to ${to}( in its group)?$`) });
const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
const dialog = (frame: Frame) => app(frame).getByRole("dialog");
const alert = (frame: Frame) => app(frame).getByRole("alertdialog");
const inMenu = async (frame: Frame) => (await app(frame).getByRole("navigation").getByRole("menuitem").allTextContents()).map((t) => t.trim()).filter((t) => NAMES.includes(t));
const inSetup = async (frame: Frame) => (await app(frame).locator(".task > div > strong").allTextContents()).filter((t) => NAMES.includes(t));

async function startSort(page: Page): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await expect.poll(() => cards(frame)).toEqual(NAMES);
  await sortButton(frame).click();
  return frame;
}

test.describe("sort", () => {
  test("Sort is offered only with two zones or more", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(sortButton(frame)).toBeVisible();
    /* What's stored, changed as another device would change it, which this page hears when HA comes back. */
    await page.evaluate(`(() => {
      fakeHA.knobs.restartMs = 50;
      const c = JSON.parse(fakeHA.disk);
      c.zones = c.zones.filter((z) => z.id === "garden");
      c.devices = c.devices.map((d) => ({ ...d, zones: d.zones.filter((z) => z === "garden") })).filter((d) => d.zones.length);
      for (const d of c.devices) if (d.place) d.place = { garden: d.place.garden };
      fakeHA.disk = JSON.stringify(c);
      fakeHA.restart();
    })()`);
    await expect.poll(() => cards(frame)).toEqual(["Garden"]);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Overview", exact: true })).toBeVisible();
    await expect(sortButton(frame)).toHaveCount(0);
  });

  test("Sort gives every card a move to previous and next, and a card opens nothing while sorting", async ({ page }) => {
    const frame = await startSort(page);
    await expect(app(frame).getByText("Sorting the cards: move them with the arrows.")).toBeFocused();
    await expect(sortButton(frame)).toHaveCount(0);
    for (const name of NAMES) {
      await expect(move(frame, name, "previous")).toBeVisible();
      await expect(move(frame, name, "next")).toBeVisible();
    }
    await expect(move(frame, "Garden", "previous")).toBeDisabled();
    await expect(move(frame, "Garden", "next")).toBeEnabled();
    await expect(move(frame, "Nursery", "previous")).toBeEnabled();
    await expect(move(frame, "Nursery", "next")).toBeDisabled();
    await app(frame).locator(".zone-card").first().locator("h2").click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Overview", exact: true })).toBeVisible();
    await expect(app(frame).locator(".zone-card")).toHaveCount(3);
    /* Nothing to apply yet, so the foot holds Back alone. */
    await expect(app(frame).getByRole("region", { name: "Page buttons" }).getByRole("button")).toHaveText(["Back"]);
  });

  test("a move is a draft until it's applied, and then Overview, the menu and Setup all follow it", async ({ page }) => {
    const frame = await startSort(page);
    const before = await stored(page);
    await move(frame, "Nursery", "previous").click();
    await expect.poll(() => cards(frame)).toEqual(["Garden", "Nursery", "Veg"]);
    await expect(bar(frame)).toContainText("Overview · Zone order");
    await expect(bar(frame).getByRole("button")).toHaveText(["Back", "Discard", "Review and apply"]);
    expect(await leaveAsks(page)).toBe(true);
    expect(await stored(page)).toEqual(before);

    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("This changes only the order zones are listed in.");
    await expect(dialog(frame).locator(".review-row")).toHaveCount(1);
    await expect(dialog(frame).locator(".review-row")).toContainText("Zone order");
    await expect(dialog(frame).locator(".review-row")).toContainText("Garden, Veg, Nursery");
    await expect(dialog(frame).locator(".review-row b")).toHaveText("Garden, Nursery, Veg");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();

    await expect(app(frame).getByRole("status").filter({ hasText: "Zone order saved." })).toBeVisible();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Overview", exact: true })).toBeVisible();
    await expect(sortButton(frame)).toBeFocused();
    await expect(move(frame, "Garden", "next")).toHaveCount(0);
    await expect(app(frame).getByText("Sorting the cards")).toHaveCount(0);
    expect(await cards(frame)).toEqual(["Garden", "Nursery", "Veg"]);
    const after = await stored(page);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.zones.map((z) => z.id)).toEqual(["garden", "nursery", "veg"]);
    expect(await leaveAsks(page)).toBe(false);
    expect(await serviceCalls(page)).toBe(0);

    await openNav(frame);
    expect(await inMenu(frame)).toEqual(["Garden", "Nursery", "Veg"]);
    await goTo(frame, "Setup");
    await expect.poll(() => inSetup(frame)).toEqual(["Garden", "Nursery", "Veg"]);
  });

  test("Discard puts the order back, and leaving with a draft asks first", async ({ page }) => {
    const frame = await startSort(page);
    const before = await stored(page);
    /* Nursery is linked to Veg, so Garden steps past the pair in one press rather than splitting them (#91). */
    await move(frame, "Garden", "next").click();
    await expect.poll(() => cards(frame)).toEqual(["Veg", "Nursery", "Garden"]);
    await bar(frame).getByRole("button", { name: "Discard" }).click();
    await expect.poll(() => cards(frame)).toEqual(NAMES);
    await expect(bar(frame)).toHaveCount(0);
    await expect(move(frame, "Garden", "next")).toBeVisible();

    await move(frame, "Veg", "next").click();
    await goTo(frame, "Devices");
    await expect(alert(frame)).toContainText("Discard unsaved changes?");
    await expect(alert(frame)).toContainText("in Overview");
    await alert(frame).getByRole("button", { name: "Keep editing" }).click();
    expect(await cards(frame)).toEqual(["Garden", "Nursery", "Veg"]);

    await bar(frame).getByRole("button", { name: "Back" }).click();
    await alert(frame).getByRole("button", { name: "Keep editing" }).click();
    await goTo(frame, "Devices");
    await alert(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Devices", exact: true })).toBeVisible();
    await goTo(frame, "Overview");
    await expect.poll(() => cards(frame)).toEqual(NAMES);
    await expect(sortButton(frame)).toBeVisible();
    expect(await stored(page)).toEqual(before);
  });

  test("the cards can be sorted and applied from the keyboard alone", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await sortButton(frame).focus();
    await page.keyboard.press("Enter");
    await expect(app(frame).getByText("Sorting the cards: move them with the arrows.")).toBeFocused();
    /* Garden's previous is off, so the first stop is its next. */
    await page.keyboard.press("Tab");
    await expect(move(frame, "Garden", "next")).toBeFocused();
    await page.keyboard.press("Enter");
    /* Nursery is linked to Veg, so Garden steps past the pair in one press (#91). */
    await expect.poll(() => cards(frame)).toEqual(["Veg", "Nursery", "Garden"]);
    /* At the end its next is off, so focus moves to its previous rather than being lost. */
    await expect(move(frame, "Garden", "next")).toBeDisabled();
    await expect(move(frame, "Garden", "previous")).toBeFocused();
    await bar(frame).getByRole("button", { name: "Review and apply" }).focus();
    await page.keyboard.press("Enter");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).focus();
    await page.keyboard.press("Enter");
    await expect(app(frame).getByRole("status").filter({ hasText: "Zone order saved." })).toBeVisible();
    expect((await stored(page)).zones.map((z) => z.id)).toEqual(["veg", "nursery", "garden"]);
  });
});
