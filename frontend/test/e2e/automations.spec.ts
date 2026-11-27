/* The Automations pages: a zone's Home Assistant automations, switched from its own page and linked on Link
   automations, and the one alert repeat helper on Setup. Against the sample room: Garden links 16 alerts, 3 failsafes
   and 4 control automations, and an automation belongs to one zone. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, dialogFoot, goTo, hostButton, hostDialogOpen, hostDialogText, leaveAsks, moreButton, panelFrame, zoneMenu } from "./helpers";

type Link = { id: string; entity: string; group: string };
type Stored = { revision: number; zones: { id: string; name: string; automations?: Link[] }[]; devices: unknown[]; room?: { alertRepeat?: string } };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
/* The page declares fakeHA with const, so it's a global but not a window property: reached as an expression. */
const setState = (page: Page, entity: string, state: string, attributes: Record<string, unknown> = {}) =>
  page.evaluate(`fakeHA.setState(${JSON.stringify(entity)}, ${JSON.stringify(state)}, ${JSON.stringify(attributes)})`);
/* What's stored, changed as another device would change it, which this page hears when HA comes back. */
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

const HIGH = "automation.critical_garden_temperature_high_day";
const heading = (frame: Frame, name: string) => app(frame).getByRole("heading", { level: 1, name, exact: true });
const chips = (frame: Frame) => app(frame).getByRole("group", { name: "Automations", exact: true });
const chip = (frame: Frame, name: string) => chips(frame).getByRole("button", { name: new RegExp(`^${name},`) });
const sw = (frame: Frame, name: string) => app(frame).getByRole("switch", { name, exact: true });
const row = (frame: Frame, name: string) => app(frame).locator(".dev", { has: frame.getByRole("switch", { name, exact: true }) });
const card = (frame: Frame, name: string) => app(frame).locator("section.card", { has: frame.getByRole("heading", { level: 2, name, exact: true }) });
const pageBar = (frame: Frame) => app(frame).getByRole("region", { name: "Page buttons", exact: true });
const draftBar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes", exact: true });
const guard = (frame: Frame) => app(frame).getByRole("alertdialog");
const review = (frame: Frame) => app(frame).getByRole("dialog");
const toast = (frame: Frame) => app(frame).locator(".toast");
const repeatBox = (frame: Frame) => app(frame).getByRole("textbox", { name: "Minutes between buzzes", exact: true });
const pick = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator(".pick-text strong", { hasText: new RegExp(`^${name.replace(/[<>"=]/g, ".")}$`) }) });
/* The back gesture reaches the panel only through the history entry the host keeps in front while the panel has
   somewhere to go back to. The host lays it again after each step, so each step waits for it first. */
async function back(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => !!(history.state && (history.state as { ecBack?: boolean }).ecBack))).toBe(true);
  await page.evaluate(() => history.back());
}

async function openAutos(page: Page, zone = "Garden"): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await goTo(frame, zone);
  await zoneMenu(frame, "View automations");
  await expect(heading(frame, `Automations: ${zone}`)).toBeVisible();
  return frame;
}
/* A box typed in on a phone hides the foot bar until it's left, as the keyboard would cover it. */
async function typeRepeat(frame: Frame, value: string): Promise<void> {
  await repeatBox(frame).fill(value);
  await repeatBox(frame).blur();
}
async function openLinks(page: Page, zone = "Nursery", from = "Alerts"): Promise<Frame> {
  const frame = await openAutos(page, zone);
  if (from !== "Alerts") await chip(frame, from).click();
  await app(frame).getByRole("button", { name: "Link automations", exact: true }).click();
  await expect(heading(frame, `Link automations: ${zone}`)).toBeVisible();
  await expect(app(frame).locator("#link-list")).toBeVisible();
  return frame;
}

test.describe("a zone's Automations page", () => {
  test("is the third item in the zone's menu, and opens on Alerts with its repeat card and a card per group", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    await moreButton(frame).click();
    await expect(app(frame).locator(".pagehead").getByRole("menuitem").nth(2)).toHaveText("View automations");
    await app(frame).getByRole("menuitem", { name: "View automations", exact: true }).click();
    await expect(heading(frame, "Automations: Garden")).toBeVisible();
    await expect(app(frame)).toContainText("Home Assistant runs these. Here you switch them on and off.");
    await expect(chip(frame, "Alerts")).toHaveAttribute("aria-pressed", "true");
    await expect(app(frame)).toContainText("Home Assistant's alerts for this zone. Switched off, an alert stops notifying you until it's switched on again.");
    await expect(card(frame, "Alert repeat")).toContainText("On your helper, input_number.alert_repeat_rate.");
    await expect(repeatBox(frame)).toHaveValue("15");
    for (const [name, count] of [["Day alerts", "7 of 7 on"], ["Night alerts", "4 of 5 on"], ["Device alerts", "4 of 4 on"]]) await expect(card(frame, name).locator(".card-head")).toContainText(count);
    await expect(row(frame, "Critical Garden VPD Low Night")).toContainText("Off. Last triggered");
    await expect(row(frame, "Critical Garden Temperature Low Day")).toContainText("On. Never triggered.");
    await expect(row(frame, "Critical Garden Temperature High Day").locator(".dev-sub")).toHaveText(/^On\. Last triggered (today|yesterday|\d{1,2} [A-Z][a-z]{2}( \d{4})?) at \d\d:\d\d\.$/);
    /* The page's own action sits at the right of its heading, level with the page menu, on every chip and never at
       the foot of the page. */
    const link = app(frame).getByRole("button", { name: "Link automations", exact: true });
    for (const c of ["Alerts", "Failsafes", "Control"]) {
      await chip(frame, c).click();
      await expect(link).toHaveCount(1);
      await expect(app(frame).locator(".pagehead").getByRole("button", { name: "Link automations", exact: true })).toBeVisible();
    }
    const menu = (await app(frame).getByRole("button", { name: "Menu", exact: true }).boundingBox())!, at = (await link.boundingBox())!;
    expect(Math.abs(at.y + at.height - (menu.y + menu.height))).toBeLessThanOrEqual(3);
    await chip(frame, "Alerts").click();
    /* Back rides in the bar at the foot of the window, and returns to the zone's page. */
    await pageBar(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(heading(frame, "Garden")).toBeVisible();
  });

  test("its chips count what Home Assistant reports on, say it in words, and follow a report", async ({ page }) => {
    const frame = await openAutos(page);
    await expect(chips(frame).getByRole("button")).toHaveText(["Alerts 15/16", "Failsafes 3/3", "Control 4/4"]);
    await expect(chip(frame, "Alerts")).toHaveAccessibleName("Alerts, 15 of 16 on");
    await expect(chip(frame, "Failsafes")).toHaveAccessibleName("Failsafes, 3 of 3 on");
    await setState(page, "automation.critical_garden_vpd_low_night", "on");
    await expect(chip(frame, "Alerts")).toHaveAccessibleName("Alerts, 16 of 16 on");
    await expect(card(frame, "Night alerts").locator(".card-head")).toContainText("5 of 5 on");
    await chip(frame, "Failsafes").click();
    await expect(chip(frame, "Failsafes")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(frame, "Alerts")).toHaveAttribute("aria-pressed", "false");
    await expect(app(frame)).toContainText("Home Assistant's failsafes for this zone. Each puts hardware back when something goes wrong");
    await expect(card(frame, "Alert repeat")).toHaveCount(0);
    await expect(app(frame).locator("section.card[data-agroup]")).toHaveCount(1);
    await expect(card(frame, "Failsafes").locator(".card-head")).toContainText("3 of 3 on");
    /* A chip that links nothing says so, in its count and in words. */
    await restartWith(page, `c.zones.find((z) => z.id === "garden").automations = c.zones.find((z) => z.id === "garden").automations.filter((a) => a.group !== "control")`);
    await expect(chip(frame, "Control")).toHaveAccessibleName("Control, none linked");
    await expect(chip(frame, "Control")).toHaveText("Control 0/0");
    await chip(frame, "Control").click();
    await expect(app(frame).locator(".notice.calm")).toContainText("No control linked to Garden yet");
    await expect(app(frame).getByRole("button", { name: "Link automations", exact: true })).toHaveCount(1);
    await app(frame).locator(".notice.calm").getByRole("button", { name: "Link automations" }).click();
    await expect(heading(frame, "Link automations: Garden")).toBeVisible();
  });

  test("a switch moves only once Home Assistant reports it, and says what it's waiting for meanwhile", async ({ page }) => {
    const frame = await openAutos(page);
    await page.evaluate("fakeHA.knobs.reportMs = 1500");
    await sw(frame, "Critical Garden Temperature High Day").click();
    await expect(row(frame, "Critical Garden Temperature High Day").getByRole("status")).toHaveText("Sent. Waiting for Home Assistant to report it off.");
    await expect(sw(frame, "Critical Garden Temperature High Day")).toBeDisabled();
    await expect(sw(frame, "Critical Garden Temperature High Day")).toHaveAttribute("aria-checked", "true");
    await expect(chip(frame, "Alerts")).toHaveAccessibleName("Alerts, 15 of 16 on");
    /* Switching an alert off never asks. */
    await expect(guard(frame)).toHaveCount(0);
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "automation", service: "turn_off", data: { entity_id: HIGH } })]);
    await expect(sw(frame, "Critical Garden Temperature High Day")).toHaveAttribute("aria-checked", "false");
    await expect(row(frame, "Critical Garden Temperature High Day").getByRole("status")).toHaveCount(0);
    await expect(row(frame, "Critical Garden Temperature High Day").locator(".dev-sub")).toContainText(/^Off\./);
    await expect(chip(frame, "Alerts")).toHaveAccessibleName("Alerts, 14 of 16 on");
    await expect(sw(frame, "Critical Garden Temperature High Day")).toBeEnabled();
  });

  test("one Home Assistant doesn't report is not confirmed after the wait, and a late report still counts", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await openAutos(page);
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await sw(frame, "Critical Garden Temperature High Day").click();
    const status = row(frame, "Critical Garden Temperature High Day").getByRole("status");
    await expect(status).toHaveText("Sent. Waiting for Home Assistant to report it off.");
    await expect(status).toHaveText("Not confirmed. Home Assistant still reports it on. Try again.", { timeout: 15_000 });
    await expect(sw(frame, "Critical Garden Temperature High Day")).toHaveAttribute("aria-checked", "true");
    await expect(sw(frame, "Critical Garden Temperature High Day")).toBeEnabled();
    await setState(page, HIGH, "off");
    await expect(status).toHaveCount(0);
    await expect(sw(frame, "Critical Garden Temperature High Day")).toHaveAttribute("aria-checked", "false");
  });

  test("a send Home Assistant refuses says why, and the switch stays as reported", async ({ page }) => {
    const frame = await openAutos(page);
    await page.evaluate("fakeHA.callService = async () => { throw new Error('Home Assistant is busy') }");
    await chip(frame, "Control").click();
    await sw(frame, "Garden Lights On").click();
    await expect(row(frame, "Garden Lights On").getByRole("status")).toHaveText("Not sent. Home Assistant is busy");
    await expect(sw(frame, "Garden Lights On")).toHaveAttribute("aria-checked", "true");
    await expect(sw(frame, "Garden Lights On")).toBeEnabled();
  });

  test("switching a failsafe off asks first; Keep it on, Escape and Back leave it on, and switching it on doesn't ask", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    /* A setup stored before an automation could belong to only one zone links Garden's failsafe in Veg too. Neither the
       row nor the question speaks of sharing it any more. */
    await restartWith(page, `c.zones.find((z) => z.id === "veg").automations.push({ id: "a99", entity: "automation.failsafe_dehumidifier_mains_auto_on", group: "failsafe" })`);
    await goTo(frame, "Veg");
    await zoneMenu(frame, "View automations");
    await chip(frame, "Failsafes").click();
    const name = "Failsafe Dehumidifier Mains Auto On";
    await expect(row(frame, name).locator(".dev-sub")).toHaveText(/^On\. Last triggered [^.]+\.$/);
    await sw(frame, name).click();
    await expect(guard(frame).getByRole("heading", { name: `Switch off ${name}?`, exact: true })).toBeFocused();
    await expect(guard(frame).locator("#dlg-text")).toHaveText("It's a failsafe: it puts hardware back when something goes wrong. While it's off, Home Assistant won't do that. You can switch it on again here.");
    await dialogFoot(guard(frame), ["Keep it on", "Switch off"]);
    await expect(guard(frame).getByRole("button", { name: "Switch off" })).toHaveClass(/danger/);
    await guard(frame).getByRole("button", { name: "Keep it on" }).click();
    await expect(guard(frame)).toHaveCount(0);
    await sw(frame, name).click();
    await page.keyboard.press("Escape");
    await expect(guard(frame)).toHaveCount(0);
    await sw(frame, name).click();
    await expect(guard(frame)).toHaveCount(1);
    await back(page);
    await expect(guard(frame)).toHaveCount(0);
    await expect(heading(frame, "Automations: Veg")).toBeVisible();
    expect(await calls(page)).toEqual([]);
    await sw(frame, name).click();
    await guard(frame).getByRole("button", { name: "Switch off" }).click();
    await expect(sw(frame, name)).toHaveAttribute("aria-checked", "false");
    expect((await calls(page)).map((c) => [c.service, c.data])).toEqual([["turn_off", { entity_id: "automation.failsafe_dehumidifier_mains_auto_on" }]]);
    await sw(frame, name).click();
    await expect(guard(frame)).toHaveCount(0);
    await expect(sw(frame, name)).toHaveAttribute("aria-checked", "true");
  });

  test("an unavailable automation, and one Home Assistant no longer has, can't be switched and say which", async ({ page }) => {
    const frame = await openAutos(page);
    await page.evaluate(`fakeHA.offline(${JSON.stringify(HIGH)}, true)`);
    await expect(row(frame, "Critical Garden Temperature High Day").locator(".dev-sub")).toHaveText(/^Unavailable in Home Assistant\. Last triggered /);
    await expect(sw(frame, "Critical Garden Temperature High Day")).toBeDisabled();
    await page.evaluate(`(() => { delete fakeHA.states["automation.critical_garden_humidity_high_day"]; fakeHA.publish(); })()`);
    const gone = "automation.critical_garden_humidity_high_day";
    await expect(row(frame, gone).locator(".dev-sub")).toHaveText("Home Assistant doesn't have it any more.");
    await expect(sw(frame, gone)).toBeDisabled();
    await expect(chip(frame, "Alerts")).toHaveAccessibleName("Alerts, 13 of 16 on");
    expect(await calls(page)).toEqual([]);
  });

  test("an automation named as markup is drawn as text", async ({ page }) => {
    const frame = await openAutos(page);
    const evil = '<img src=x onerror="window.pwned=1">';
    await setState(page, HIGH, "on", { friendly_name: evil });
    await expect(sw(frame, evil)).toBeVisible();
    await expect(row(frame, evil).locator(".dev-name")).toHaveText(evil);
    expect(await frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.querySelectorAll("img").length)).toBe(0);
    expect(await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  });
});

test.describe("the zone page's failsafe notice", () => {
  test("appears while a failsafe is off, names one or counts several, and opens the Automations page on Failsafes", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const notice = app(frame).locator("button.notice.fix", { hasText: "failsafe" });
    await expect(notice).toHaveCount(0);
    await setState(page, "automation.failsafe_garden_lights_recovery", "off");
    await expect(notice).toContainText("A failsafe is off: Failsafe Garden Lights Recovery. While it's off, nothing puts that hardware back.");
    await expect(notice).toContainText("Failsafes ›");
    await setState(page, "automation.failsafe_dehumidifier_mains_auto_on", "off");
    await expect(notice).toContainText("2 failsafes are off. While they're off, nothing puts that hardware back.");
    /* One that's unavailable can't be switched on from here, so it isn't counted. */
    await page.evaluate(`fakeHA.offline("automation.failsafe_dehumidifier_mains_auto_on", true)`);
    await expect(notice).toContainText("A failsafe is off: Failsafe Garden Lights Recovery.");
    await notice.click();
    await expect(heading(frame, "Automations: Garden")).toBeVisible();
    await expect(chip(frame, "Failsafes")).toHaveAttribute("aria-pressed", "true");
    await expect(sw(frame, "Failsafe Garden Lights Recovery")).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("the alert repeat", () => {
  test("holds the box to the helper's own limits and step, and the bar at the foot holds the draft", async ({ page }) => {
    const frame = await openAutos(page);
    await expect(pageBar(frame)).toBeVisible();
    await typeRepeat(frame, "500");
    await expect(repeatBox(frame)).toHaveAttribute("aria-invalid", "true");
    await expect(app(frame).locator("#repeat-bad")).toHaveText("It has to be between 0 and 120, in steps of 1, as your helper allows.");
    await expect(draftBar(frame)).toContainText("Fix first: It has to be between 0 and 120, in steps of 1, as your helper allows.");
    await expect(draftBar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await typeRepeat(frame, "abc");
    await expect(app(frame).locator("#repeat-bad")).toHaveText("Type a number of minutes.");
    /* The helper's step is the helper's: changed in Home Assistant, the box follows. */
    await setState(page, "input_number.alert_repeat_rate", "15", { step: 5 });
    await typeRepeat(frame, "22");
    await expect(app(frame).locator("#repeat-bad")).toHaveText("It has to be between 0 and 120, in steps of 5, as your helper allows.");
    await typeRepeat(frame, "20");
    await expect(app(frame).locator("#repeat-bad")).toBeHidden();
    await expect(draftBar(frame)).toContainText("Garden · Alert repeat");
    await expect(draftBar(frame).getByRole("button")).toHaveText(["Back", "Discard", "Review and apply"]);
    await expect(draftBar(frame).getByRole("button", { name: "Review and apply" })).toBeEnabled();
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await draftBar(frame).getByRole("button", { name: "Discard" }).click();
    await expect(repeatBox(frame)).toHaveValue("15");
    await expect(pageBar(frame)).toBeVisible();
    await expect.poll(() => leaveAsks(page)).toBe(false);
  });

  test("its review says it changes every alert, and applying waits for the helper to report the value", async ({ page }) => {
    const frame = await openAutos(page);
    await typeRepeat(frame, "20");
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Alert repeat15 min → 20 min"]);
    await expect(review(frame)).toContainText("This changes every alert in Home Assistant, not just this zone's. On your helper, input_number.alert_repeat_rate. Every alert follows it straight away.");
    await page.evaluate("fakeHA.knobs.reportMs = 1500");
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(review(frame).getByRole("button", { name: "Applying and verifying..." })).toBeDisabled();
    await expect(review(frame)).toHaveCount(0);
    await expect(toast(frame)).toHaveText("Alert repeat changed.");
    expect((await calls(page)).map((c) => [`${c.domain}.${c.service}`, c.data])).toEqual([["input_number.set_value", { entity_id: "input_number.alert_repeat_rate", value: 20 }]]);
    await expect(repeatBox(frame)).toHaveValue("20");
    await expect(pageBar(frame)).toBeVisible();
  });

  test("a helper that doesn't take the value says what Home Assistant still reports, and keeps the change to try again", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await openAutos(page);
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await typeRepeat(frame, "20");
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(review(frame).getByRole("alert")).toContainText("Alert repeat: Home Assistant still reports 15.", { timeout: 15_000 });
    await expect(review(frame).locator(".review-row")).toHaveText(["Alert repeat15 min → 20 min"]);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(review(frame)).toHaveCount(0);
    await expect(toast(frame)).toHaveText("Alert repeat changed.");
  });

  test("leaving with the draft open asks first, and so does picking another chip", async ({ page }) => {
    const frame = await openAutos(page);
    await typeRepeat(frame, "20");
    await chip(frame, "Failsafes").click();
    await expect(guard(frame).getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await expect(guard(frame)).toContainText("You have 1 unsaved change in Garden.");
    await guard(frame).getByRole("button", { name: "Keep editing" }).click();
    await expect(chip(frame, "Alerts")).toHaveAttribute("aria-pressed", "true");
    await expect(repeatBox(frame)).toHaveValue("20");
    await draftBar(frame).getByRole("button", { name: "Back" }).click();
    await expect(guard(frame)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await back(page);
    await expect(guard(frame)).toHaveCount(1);
    await guard(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(heading(frame, "Garden")).toBeVisible();
    expect(await calls(page)).toEqual([]);
    await zoneMenu(frame, "View automations");
    await typeRepeat(frame, "20");
    await chip(frame, "Control").click();
    await guard(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(chip(frame, "Control")).toHaveAttribute("aria-pressed", "true");
    await chip(frame, "Alerts").click();
    await expect(repeatBox(frame)).toHaveValue("15");
  });

  test("with no helper linked it says to link one on Setup, and takes you there; one Home Assistant doesn't have can't be changed", async ({ page }) => {
    const frame = await openAutos(page);
    await restartWith(page, `c.room = { alertRepeat: "input_number.gone" }`);
    await expect(card(frame, "Alert repeat")).toContainText("Home Assistant doesn't have input_number.gone right now, so it can't be changed.");
    await expect(repeatBox(frame)).toHaveCount(0);
    await restartWith(page, `c.room = {}`);
    await expect(card(frame, "Alert repeat")).toContainText("How often an alert may buzz your phone comes from one Home Assistant helper shared by every alert. Link it on Setup to change it here.");
    await card(frame, "Alert repeat").getByRole("button", { name: "Link it on Setup ›" }).click();
    await expect(heading(frame, "Setup")).toBeVisible();
    await expect(app(frame).locator("#room-alerts")).toBeInViewport();
  });
});

test.describe("Link automations", () => {
  test("with nothing typed lists what the zone links and what's in its area or named for it, and counts the rest", async ({ page }) => {
    const frame = await openLinks(page);
    const rows = app(frame).locator("#link-list .pickwrap");
    await expect(rows.locator(".pick-text strong")).toHaveText([
      "Critical Nursery Environment Sensor Unavailable",
      "Critical Nursery Temperature High Day",
      "Critical Nursery Temperature Low Night",
      "Critical Nursery VPD High Day",
      "Failsafe Nursery Dome Fan Auto On",
      "Failsafe Nursery Heat Mat Auto Off",
      "Nursery Heat Mat Off",
      "Nursery Heat Mat On",
    ]);
    await expect(rows.locator(".pickrow[aria-pressed='true']")).toHaveCount(7);
    await expect(pick(frame, "Critical Nursery VPD High Day").locator(".pickrow")).toHaveAttribute("aria-pressed", "false");
    await expect(pick(frame, "Failsafe Nursery Dome Fan Auto On").locator(".dev-sub")).toHaveText("automation.failsafe_nursery_dome_fan_auto_on, Nursery area");
    await expect(app(frame).locator("#link-more")).toHaveText("36 more in Home Assistant. Search to find them.");
    await expect(pageBar(frame).getByRole("button")).toHaveText(["Back"]);
  });

  test("searches every automation by name or entity id, and shows the first ten of many, counting the rest", async ({ page }) => {
    const frame = await openLinks(page, "Garden");
    const search = app(frame).getByRole("searchbox", { name: "Search Home Assistant" });
    await search.fill("porch");
    await expect(app(frame).locator("#link-list .pick-text strong")).toHaveText(["Porch Light On"]);
    await expect(app(frame).locator("#link-more")).toHaveCount(0);
    await search.fill("reservoir_refill");
    await expect(app(frame).locator("#link-list .pick-text strong")).toHaveText(["Reservoir Refill Reminder"]);
    /* Every entity id holds an a, so one letter matches all 44. */
    await search.fill("a");
    await expect(app(frame).locator("#link-list .pickwrap")).toHaveCount(10);
    await expect(app(frame).locator("#link-more")).toHaveText("34 more match. Type more of the name to narrow them down.");
    await search.fill("nothing like this");
    await expect(app(frame).locator("#link-list")).toContainText("No automation matches.");
  });

  test("a ticked automation's group is suggested from its name and picked with chips, and the review lists every change", async ({ page }) => {
    const frame = await openLinks(page, "Nursery", "Failsafes");
    const vpd = pick(frame, "Critical Nursery VPD High Day");
    await vpd.locator(".pickrow").click();
    await expect(vpd.locator(".pickrow")).toHaveAttribute("aria-pressed", "true");
    const group = vpd.getByRole("group", { name: "Group" });
    await expect(group.getByRole("radio")).toHaveCount(5);
    await expect(vpd.locator(".chip")).toHaveText(["Day alerts", "Night alerts", "Device alerts", "Failsafes", "Control"]);
    await expect(vpd.getByRole("radio", { name: "Day alerts" })).toBeChecked();
    await vpd.getByText("Device alerts", { exact: true }).click();
    await expect(vpd.getByRole("radio", { name: "Device alerts" })).toBeChecked();
    await pick(frame, "Nursery Heat Mat Off").locator(".pickrow").click();
    await pick(frame, "Nursery Heat Mat On").getByText("Failsafes", { exact: true }).click();
    await expect(draftBar(frame)).toContainText("3 unsaved changes");
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Nursery Heat Mat OnControl → Failsafes", "Nursery Heat Mat OffControl → Not linked", "Critical Nursery VPD High DayNot linked → Device alerts"]);
    await expect(review(frame)).toContainText(
      "Only Environment Control changes, and Home Assistant keeps running every automation as it is. Home Assistant asks you before a newly linked one can be switched from here.",
    );
    const before = await stored(page);
    await review(frame).getByRole("button", { name: "Apply 3 changes" }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await hostDialogText(page)).toContain("automation.critical_nursery_vpd_high_day");
    await allow(page);
    await expect(toast(frame)).toHaveText("Nursery's automations saved.");
    /* Back where it was opened from, on the same chip. */
    await expect(heading(frame, "Automations: Nursery")).toBeVisible();
    await expect(chip(frame, "Failsafes")).toHaveAttribute("aria-pressed", "true");
    const was = before.zones.find((z) => z.id === "nursery")!.automations!, now = (await stored(page)).zones.find((z) => z.id === "nursery")!.automations!;
    const id = (entity: string, list: Link[]) => list.find((a) => a.entity === entity)?.id;
    for (const e of ["automation.critical_nursery_temperature_high_day", "automation.failsafe_nursery_heat_mat_auto_off", "automation.nursery_heat_mat_on"]) expect(id(e, now)).toBe(id(e, was));
    expect(now.find((a) => a.entity === "automation.nursery_heat_mat_on")?.group).toBe("failsafe");
    expect(now.find((a) => a.entity === "automation.nursery_heat_mat_off")).toBeUndefined();
    expect(now.find((a) => a.entity === "automation.critical_nursery_vpd_high_day")).toEqual({ id: "a8", entity: "automation.critical_nursery_vpd_high_day", group: "alert_device" });
    await expect(card(frame, "Failsafes").locator(".card-head")).toContainText("3 of 3 on");
  });

  test("Home Assistant's own question comes before a newly linked automation is saved, and saying no saves nothing", async ({ page }) => {
    const frame = await openLinks(page);
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("porch");
    await pick(frame, "Porch Light On").locator(".pickrow").click();
    await expect(pick(frame, "Porch Light On").getByRole("radio", { name: "Control" })).toBeChecked();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Porch Light OnNot linked → Control"]);
    const before = await stored(page);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await hostDialogText(page)).toContain("Allow 1 automation");
    await page.keyboard.press("Escape");
    await expect(review(frame).getByRole("alert")).toContainText("Not allowed, so nothing was saved.");
    expect((await stored(page)).revision).toBe(before.revision);
    await review(frame).getByRole("button", { name: "Back to editing" }).click();
    await expect(heading(frame, "Link automations: Nursery")).toBeVisible();
    await expect(draftBar(frame)).toContainText("Nursery · Porch Light On");
  });

  test("an automation another zone has says so, and saving it here too is refused with the reason", async ({ page }) => {
    const frame = await openLinks(page, "Garden");
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("tent lights on");
    const tent = pick(frame, "Tent Lights On");
    await expect(tent.locator(".dev-sub")).toHaveText("automation.tent_lights_on, Veg area, linked in Veg");
    await tent.locator(".pickrow").click();
    /* No question here: an automation can't be shared, so it's the save that says no. */
    await expect(app(frame).getByRole("alertdialog")).toHaveCount(0);
    await expect(tent.locator(".pickrow")).toHaveAttribute("aria-pressed", "true");
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["Tent Lights OnNot linked → Control"]);
    const before = await stored(page);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    /* Home Assistant's own question comes first, for anything newly linked; the backend's refusal after it. */
    await allow(page);
    await expect(review(frame).getByRole("alert")).toContainText("An automation can only be linked to one zone.");
    expect((await stored(page)).revision).toBe(before.revision);
    expect((await stored(page)).zones.find((z) => z.id === "garden")!.automations!.map((a) => a.entity)).not.toContain("automation.tent_lights_on");
  });

  test("a linked automation Home Assistant no longer lists keeps its row, so it can still be unlinked", async ({ page }) => {
    await page.goto(PAGE);
    await page.evaluate(`(() => { delete fakeHA.registry.entities["automation.critical_garden_vpd_low_night"]; delete fakeHA.states["automation.critical_garden_vpd_low_night"]; fakeHA.publish(); })()`);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    await zoneMenu(frame, "View automations");
    await app(frame).getByRole("button", { name: "Link automations", exact: true }).click();
    const gone = pick(frame, "automation.critical_garden_vpd_low_night");
    await expect(gone.locator(".pill")).toHaveText("Missing");
    await expect(gone.locator(".pickrow")).toHaveAttribute("aria-pressed", "true");
    await expect(gone.getByRole("radio", { name: "Night alerts" })).toBeChecked();
    await gone.locator(".pickrow").click();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(review(frame).locator(".review-row")).toHaveText(["automation.critical_garden_vpd_low_nightNight alerts → Not linked"]);
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(toast(frame)).toHaveText("Garden's automations saved.");
    expect((await stored(page)).zones.find((z) => z.id === "garden")!.automations!.map((a) => a.entity)).not.toContain("automation.critical_garden_vpd_low_night");
  });

  test("from a zone's menu on Setup, it comes back to Setup", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg", exact: true }).click();
    await app(frame).getByRole("menuitem", { name: "Link automations", exact: true }).click();
    await expect(heading(frame, "Link automations: Veg")).toBeVisible();
    await pick(frame, "Tent Lights Off").locator(".pickrow").click();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(toast(frame)).toHaveText("Veg's automations saved.");
    await expect(heading(frame, "Setup")).toBeVisible();
  });
});

test.describe("Setup's Alerts card", () => {
  test("links the room's helper through the search box behind Home Assistant's own question, links another, and unlinks", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await restartWith(page, `c.room = {}`);
    await goTo(frame, "Setup");
    const box = app(frame).locator("#room-alerts");
    await expect(box.getByRole("heading", { name: "Alerts" })).toBeVisible();
    await expect(app(frame).locator("section.card").filter({ has: frame.getByRole("heading", { level: 2 }) }).locator("h2")).toContainText(["Zones", "Alerts", "Appearance"]);
    await box.getByRole("button", { name: "Link a helper" }).click();
    const search = box.getByRole("combobox", { name: "Alert repeat helper" });
    await search.fill("repeat");
    await box.getByRole("option", { name: /Alert repeat rate/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await hostDialogText(page)).toContain("Every alert's repeat rate comes from it.");
    await allow(page);
    await expect(toast(frame)).toHaveText("Alert repeat linked.");
    await expect(box).toContainText("15 min. On your helper, input_number.alert_repeat_rate. Change it on any zone's Automations page, under Alerts.");
    expect((await stored(page)).room).toEqual({ alertRepeat: "input_number.alert_repeat_rate" });
    await box.getByRole("button", { name: "Link another" }).click();
    await box.getByRole("combobox", { name: "Alert repeat helper" }).fill("spare vpd");
    await box.getByRole("option", { name: /Spare VPD threshold/ }).click();
    await allow(page);
    /* The same words as the first link's toast, which can still be showing, so it's the stored setup that's waited for. */
    await expect.poll(async () => (await stored(page)).room).toEqual({ alertRepeat: "input_number.spare_vpd_threshold" });
    await expect(box).toContainText("On your helper, input_number.spare_vpd_threshold.");
    await box.getByRole("button", { name: "Unlink" }).click();
    await expect(toast(frame)).toHaveText("Alert repeat unlinked. Your helper stays as it is.");
    expect((await stored(page)).room).toEqual({});
    await expect(box.getByRole("button", { name: "Link a helper" })).toBeVisible();
    expect(await calls(page)).toEqual([]);
  });

  test("a save of anything else keeps the room's helper", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg", exact: true }).click();
    await app(frame).getByRole("menuitem", { name: "Link automations", exact: true }).click();
    await pick(frame, "Tent Lights Off").locator(".pickrow").click();
    await draftBar(frame).getByRole("button", { name: "Review and apply" }).click();
    await review(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(toast(frame)).toHaveText("Veg's automations saved.");
    expect((await stored(page)).room).toEqual({ alertRepeat: "input_number.alert_repeat_rate" });
  });
});

test.describe("removing a zone, and a zone removed elsewhere", () => {
  test("Remove zone says the zone's automation links go and the automations keep running", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Garden", exact: true }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    await expect(guard(frame).locator(".review-row").filter({ hasText: "Automations" })).toHaveText("Automations23 unlinked. They keep running in Home Assistant");
  });

  test("a zone removed elsewhere closes its Automations page and Link automations", async ({ page }) => {
    const frame = await openAutos(page, "Nursery");
    await restartWith(page, `c.zones = c.zones.filter((z) => z.id !== "nursery")`);
    await expect(heading(frame, "Overview")).toBeVisible();
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Veg", exact: true }).click();
    await app(frame).getByRole("menuitem", { name: "Link automations", exact: true }).click();
    await expect(heading(frame, "Link automations: Veg")).toBeVisible();
    await restartWith(page, `c.zones = c.zones.filter((z) => z.id !== "veg")`);
    await expect(heading(frame, "Setup")).toBeVisible();
  });
});

test.describe("the back gesture through the Automations pages", () => {
  test("goes one step back at a time: a menu, a question, Link automations with its draft, the page, the zone", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Veg");
    await moreButton(frame).click();
    await back(page);
    await expect(moreButton(frame)).toHaveAttribute("aria-expanded", "false");
    await zoneMenu(frame, "View automations");
    await chip(frame, "Control").click();
    await app(frame).getByRole("button", { name: "Link automations", exact: true }).click();
    await expect(heading(frame, "Link automations: Veg")).toBeVisible();
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("porch");
    await pick(frame, "Porch Light On").locator(".pickrow").click();
    /* With a draft open, Back asks; Back again closes the question and leaves the draft as it was. */
    await back(page);
    await expect(guard(frame).getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await back(page);
    await expect(guard(frame)).toHaveCount(0);
    await expect(pick(frame, "Porch Light On").locator(".pickrow")).toHaveAttribute("aria-pressed", "true");
    await back(page);
    await guard(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(heading(frame, "Automations: Veg")).toBeVisible();
    await expect(chip(frame, "Control")).toHaveAttribute("aria-pressed", "true");
    await back(page);
    await expect(heading(frame, "Veg")).toBeVisible();
    await back(page);
    await expect(heading(frame, "Overview")).toBeVisible();
  });
});

test.describe("on a phone", () => {
  /* Anything drawn past either edge of the window, which on a phone means clipped or scrolled sideways. */
  const offScreen = (frame: Frame) =>
    frame.evaluate(() => {
      const root = document.querySelector("ec-app")?.shadowRoot, w = document.documentElement.clientWidth, out: string[] = [];
      for (const el of root?.querySelectorAll("main *, .draftbar, .draftbar *") ?? []) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && el.closest(".sr") === null && (r.right > w + 0.5 || r.left < -0.5)) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
        if (el instanceof HTMLElement && el.matches(".dev-name, .dev-sub, .pick-text strong, .chip, .seg button, .notice span") && el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${el.className} clipped`);
      }
      if (document.documentElement.scrollWidth > w) out.push("the page scrolls sideways");
      return out;
    });

  test("at 390 px wide nothing on these pages is clipped or off the screen", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "the phone's own width");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await setState(page, "automation.failsafe_tent_lights_recovery", "off", { friendly_name: "Failsafe Tent Lights Recovery With A Rather Long Name For A Phone" });
    await goTo(frame, "Veg");
    await expect(app(frame).locator("button.notice.fix", { hasText: "failsafe" })).toBeVisible();
    expect(await offScreen(frame)).toEqual([]);
    await zoneMenu(frame, "View automations");
    expect(await offScreen(frame)).toEqual([]);
    /* The heading keeps the whole width for the title, with Link automations under it at the right, level with the
       page menu, never laid over the title or squeezing it onto more lines. */
    const title = (await heading(frame, "Automations: Veg").boundingBox())!, link = (await app(frame).getByRole("button", { name: "Link automations", exact: true }).boundingBox())!;
    const menu = (await app(frame).getByRole("button", { name: "Menu", exact: true }).boundingBox())!;
    expect(link.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(title.height).toBeLessThan(40);
    expect(Math.abs(link.y + link.height - (menu.y + menu.height))).toBeLessThanOrEqual(3);
    await typeRepeat(frame, "500");
    await expect(draftBar(frame)).toBeVisible();
    expect(await offScreen(frame)).toEqual([]);
    for (const b of await draftBar(frame).getByRole("button").all()) await expect(b).toBeInViewport({ ratio: 1 });
    await draftBar(frame).getByRole("button", { name: "Discard" }).click();
    for (const c of ["Failsafes", "Control"]) {
      await chip(frame, c).click();
      expect(await offScreen(frame)).toEqual([]);
    }
    await app(frame).getByRole("button", { name: "Link automations", exact: true }).click();
    await expect(app(frame).locator("#link-list")).toBeVisible();
    expect(await offScreen(frame)).toEqual([]);
    await app(frame).getByRole("searchbox", { name: "Search Home Assistant" }).fill("a");
    expect(await offScreen(frame)).toEqual([]);
    await goTo(frame, "Setup");
    await app(frame).locator("#room-alerts").getByRole("button", { name: "Link another" }).click();
    expect(await offScreen(frame)).toEqual([]);
  });
});
