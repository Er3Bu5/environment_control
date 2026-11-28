/* After Review and apply succeeds, the person stays on the page or step they applied from, with what was saved showing
   (#156). Back still goes wherever the page was opened from, and only Add zone, Remove zone and a step that has to carry
   on still leave. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, zoneMenu } from "./helpers";

const dialog = (frame: Frame) => app(frame).getByRole("dialog");
const heading = (frame: Frame, name: string) => app(frame).getByRole("heading", { level: 1, name, exact: true });
const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
const back = (frame: Frame) => app(frame).getByRole("button", { name: "Back", exact: true });
const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });
const toast = (frame: Frame) => app(frame).locator(".toast");
const apply = (frame: Frame) => dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
const focused = (frame: Frame) =>
  frame.evaluate(() => {
    const el = document.querySelector("ec-app")?.shadowRoot?.activeElement as HTMLElement | null;
    return el ? `${el.tagName} ${el.textContent?.trim()}` : "";
  });

async function setup(page: Page): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Setup");
  return frame;
}

async function fromMenu(page: Page, zone: string, item: string): Promise<Frame> {
  const frame = await setup(page);
  await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
  await app(frame).getByRole("menuitem", { name: item, exact: true }).click();
  return frame;
}

test("Targets opened from the zone's page stays after applying, with the saved time and focus on its heading; Back returns to the zone", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, "Garden");
  await zoneMenu(frame, "View targets");
  await dialog(frame).getByRole("button", { name: "Set targets" }).click();
  await expect(heading(frame, "Targets, day and night: Garden")).toBeVisible();
  await app(frame).getByLabel("Lights on", { exact: true }).fill("06:30");
  await bar(frame).getByRole("button", { name: "Review and apply" }).click();
  await apply(frame);
  await expect(toast(frame)).toHaveText("Garden saved, on your helpers too.");
  await expect(heading(frame, "Targets, day and night: Garden")).toBeVisible();
  await expect(app(frame).getByLabel("Lights on", { exact: true })).toHaveValue("06:30");
  await expect(bar(frame)).toHaveCount(0);
  expect(await focused(frame)).toBe("H1 Targets, day and night: Garden");
  await back(frame).click();
  await expect(heading(frame, "Garden")).toBeVisible();
  await expect(app(frame).locator(".period").first()).toContainText("06:30 - 19:00");
});

test("Sensor Calibration opened from the chart's Change stays after applying; Back returns to the chart with its draft", async ({ page }) => {
  const frame = await fromMenu(page, "Garden", "Targets, day and night");
  const card = app(frame).locator("#td-targets");
  await card.getByRole("group", { name: "Period" }).getByRole("button", { name: "Day", exact: true }).click();
  await card.getByLabel("Temperature Max", { exact: true }).fill("29");
  await card.getByLabel("Temperature Max", { exact: true }).press("Enter");
  await card.getByRole("button", { name: "Change" }).click();
  await expect(heading(frame, "Sensor Calibration: Garden")).toBeVisible();
  const offset = app(frame).getByLabel("Environment under degrees from air");
  await offset.fill("1");
  await offset.press("Enter");
  await bar(frame).getByRole("button", { name: "Review and apply" }).click();
  await apply(frame);
  await expect(dialog(frame)).toHaveCount(0);
  await expect(toast(frame)).toContainText("Leaf temperature offsets saved.");
  await expect(heading(frame, "Sensor Calibration: Garden")).toBeVisible();
  await expect(offset).toHaveValue("1.0");
  await expect(bar(frame)).toHaveCount(0);
  await back(frame).click();
  await expect(heading(frame, "Targets, day and night: Garden")).toBeVisible();
  await card.getByRole("group", { name: "Period" }).getByRole("button", { name: "Day", exact: true }).click();
  await expect(card.getByLabel("Temperature Max", { exact: true })).toHaveValue("29");
  await expect(bar(frame)).toContainText("unsaved changes");
});

test("Add zone still opens the new zone's guide; a step opened from the guide stays after applying, is done, and Finish returns to the guide quietly", async ({ page }) => {
  const frame = await setup(page);
  await app(frame).getByRole("button", { name: "Add zone" }).click();
  await app(frame).getByLabel("Zone name").fill("Flower tent");
  await app(frame).getByLabel("Zone name").press("Enter");
  await app(frame).getByRole("button", { name: "Review and apply" }).click();
  await apply(frame);
  await expect(heading(frame, "Set up Flower tent")).toBeVisible();
  await app(frame).locator("#g-details").getByRole("button", { name: "Zone details" }).click();
  await app(frame).getByLabel("Description, optional").fill("By the window");
  await app(frame).getByRole("button", { name: "Review and apply" }).click();
  await apply(frame);
  await expect(toast(frame)).toHaveText("Zone details saved.");
  await expect(heading(frame, "Zone details")).toBeVisible();
  await expect(app(frame).getByLabel("Description, optional")).toHaveValue("By the window");
  await expect(next(frame)).toHaveText("Finish");
  expect(await focused(frame)).toBe("BUTTON Finish");
  await next(frame).click();
  await expect(heading(frame, "Set up Flower tent")).toBeVisible();
  await expect(app(frame).locator("#g-details .pill.ok")).toHaveText("Done");
  await expect(toast(frame)).not.toHaveText("Nothing changed.");
});

test("a grid that strands a sensor still carries on to the map, and applying there stays on that step; Back goes to the step before", async ({ page }) => {
  const frame = await fromMenu(page, "Garden", "Zone layout");
  await next(frame).click();
  await app(frame).getByLabel("Units", { exact: true }).fill("4");
  await expect(app(frame).locator(".steps")).toContainText("3. Sensors and devices");
  await next(frame).click();
  await app(frame).locator(".map").getByRole("button", { name: "Unit 4", exact: true }).first().click();
  await next(frame).click();
  await apply(frame);
  await expect(toast(frame)).toHaveText("Zone layout saved.");
  await expect(heading(frame, "Zone layout: Garden")).toBeVisible();
  await expect(app(frame).locator('.steps li[aria-current="step"]')).toHaveText("3. Sensors and devices");
  await expect(next(frame)).toHaveText("Finish");
  await app(frame).getByRole("button", { name: "Back", exact: true }).click();
  await expect(app(frame).locator('.steps li[aria-current="step"]')).toHaveText("2. Units and labels");
  await expect(app(frame).getByLabel("Units", { exact: true })).toHaveValue("4");
});

test("Zone layout stays after applying a unit label, and Finish leaves for Setup, where it was opened", async ({ page }) => {
  const frame = await fromMenu(page, "Garden", "Zone layout");
  await next(frame).click();
  await app(frame).getByLabel("Label for unit 12", { exact: true }).fill("GG4");
  await app(frame).getByLabel("Label for unit 12", { exact: true }).press("Enter");
  await next(frame).click();
  await apply(frame);
  await expect(heading(frame, "Zone layout: Garden")).toBeVisible();
  await expect(app(frame).getByLabel("Label for unit 12", { exact: true })).toHaveValue("GG4");
  await expect(next(frame)).toHaveText("Finish");
  await next(frame).click();
  await expect(heading(frame, "Setup")).toBeVisible();
  await expect(toast(frame)).not.toHaveText("Nothing changed.");
});

test("Remove zone still returns to Setup", async ({ page }) => {
  const frame = await fromMenu(page, "Nursery", "Remove zone");
  const alert = app(frame).getByRole("alertdialog");
  await alert.getByLabel("Type Nursery to confirm").fill("Nursery");
  await alert.getByRole("button", { name: "Remove zone" }).click();
  await expect(toast(frame)).toHaveText("Nursery removed.");
  await expect(heading(frame, "Setup")).toBeVisible();
  await expect(app(frame).getByRole("button", { name: "Set up Nursery" })).toHaveCount(0);
});
