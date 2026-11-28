/* Linked zones (#91), fourth piece: what a linked zone takes from its parent. Shared hardware makes it the same space
   for what that hardware does, so the parent's settings apply, shown read only, and a tap says where they're changed
   without ever going there. The sample room has Nursery linked to Veg, sharing Veg's lights, fans and more, with an
   environment sensor of its own. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, dialogFoot, goTo, openNav, panelFrame, tab, zoneMenu } from "./helpers";

type Zone = { id: string; name: string; parent?: string; sensors: Record<string, unknown>[]; bands: Record<string, Record<string, (number | null)[]>>; [k: string]: unknown };
type Stored = { zones: Zone[]; devices: { id: string; zones: string[] }[] };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const alert = (frame: Frame) => app(frame).getByRole("alertdialog");
const dialog = (frame: Frame) => app(frame).getByRole("dialog");
const bar = (frame: Frame) => app(frame).locator(".draftbar");
const tile = (frame: Frame, label: string) => app(frame).locator(".tile", { has: frame.locator(".name", { hasText: label }) });
const device = (frame: Frame, id: string) => app(frame).locator(`.dev[data-device="${id}"]`);
const DEVICE_WORDS = "This device runs on Zone: Veg's automations. Please control it in Veg.";
const SETTING_WORDS = "These settings are Zone: Veg's. Please edit them in Veg.";

/* Each test reshapes the sample room before the panel reads it: what Nursery shares with Veg, and limits that tell
   Veg's apart from Nursery's own (a reading of about 21 degrees is High by Veg's and Ideal by Nursery's). */
async function load(page: Page, opts: { shareSensor?: boolean; heaterOwn?: boolean; vegTimes?: boolean }): Promise<Frame> {
  await page.goto(PAGE);
  await page.evaluate(`(() => {
    const o = ${JSON.stringify(opts)}, cfg = JSON.parse(fakeHA.disk), z = (id) => cfg.zones.find((x) => x.id === id);
    const veg = z("veg"), nursery = z("nursery"), five = (t) => ({ day: { temperature: t, humidity: [40, 50, null, 70, 80], vpd: [0.4, 0.6, null, 1.2, 1.4] }, night: { temperature: t, humidity: [40, 50, null, 70, 80], vpd: [0.4, 0.6, null, 1.2, 1.4] } });
    for (const x of [veg, nursery]) { x.linked = false; if (x.helpers) { delete x.helpers.bands; delete x.helpers.light; } }
    veg.bands = five([10, 12, null, 15, 35]);
    nursery.bands = five([10, 12, null, 30, 35]);
    const now = new Date().toISOString(), put = (e, v) => (fakeHA.states[e] = { entity_id: e, state: String(v), attributes: {}, context: {}, last_updated: now });
    nursery.sensors[0].entities = { temperature: "sensor.nursery_t" };
    veg.sensors[0].entities = { temperature: "sensor.veg_t" };
    put("sensor.nursery_t", 21);
    put("sensor.veg_t", 21.4);
    if (o.shareSensor) nursery.sensors.push(JSON.parse(JSON.stringify(veg.sensors[0])));
    if (o.heaterOwn) cfg.devices.find((d) => d.id === "heater").zones = ["garden", "nursery"];
    if (o.vegTimes) { veg.periodMode = "fixed"; veg.dayAt = 8 * 60; veg.nightAt = 20 * 60; if (veg.helpers) { delete veg.helpers.day; delete veg.helpers.night; } }
    fakeHA.disk = JSON.stringify(cfg);
    fakeHA.config = cfg;
    fakeHA.knobs.restartMs = 50;
    fakeHA.restart();
    window.sent = [];
    window.addEventListener("message", (e) => e.data && typeof e.data.type === "string" && window.sent.push(e.data.type));
  })()`);
  const frame = await panelFrame(page);
  await openNav(frame);
  await expect(tab(frame, "Nursery")).toBeVisible();
  return frame;
}
const sent = (page: Page) => page.evaluate<string[]>("window.sent");
async function nursery(frame: Frame): Promise<void> {
  await goTo(frame, "Nursery");
  await expect(app(frame).getByRole("heading", { level: 1, name: "Nursery" })).toBeVisible();
}
async function setup(frame: Frame): Promise<void> {
  await goTo(frame, "Setup");
  await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
  await app(frame).getByRole("menuitem", { name: "Targets, day and night", exact: true }).click();
  await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Nursery" })).toBeVisible();
}
async function saysNotHere(frame: Frame, title: string, words: string): Promise<void> {
  await expect(alert(frame).locator("#dlg-title")).toHaveText(title);
  await expect(alert(frame).locator("#dlg-text")).toHaveText(words);
  await dialogFoot(alert(frame), ["OK"]);
  await alert(frame).getByRole("button", { name: "OK" }).click();
  await expect(alert(frame)).toHaveCount(0);
}

test.describe("what a linked zone takes from its parent", () => {
  test.describe.configure({ timeout: 60_000 });
  test("a device shared with the parent is read only and a tap sends nothing; one the parent hasn't still switches", async ({ page }) => {
    const frame = await load(page, { heaterOwn: true });
    await nursery(frame);
    const fans = device(frame, "fans");
    await expect(fans).toHaveClass(/\bro\b/);
    await expect(fans).toContainText("Runs on Zone: Veg's automations. Edit in Veg.");
    await expect(fans).not.toContainText("Shared with");
    const sw = fans.getByRole("switch");
    const was = await sw.getAttribute("aria-checked");
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await expect(sw).toHaveAttribute("title", "Edit in Zone: Veg");
    await sw.click({ force: true });
    await saysNotHere(frame, "Oscillating fans", DEVICE_WORDS);
    /* The whole tile takes the tap, not only its switch. */
    await fans.locator(".dev-name").click({ force: true });
    await saysNotHere(frame, "Oscillating fans", DEVICE_WORDS);
    /* A dial's buttons and a humidifier's mode chips answer the same way, and nothing moves. */
    await device(frame, "lc-tent").getByRole("button", { name: /^Raise / }).click({ force: true });
    await saysNotHere(frame, "Tent light controller", DEVICE_WORDS);
    const aux = device(frame, "aux"), chips = aux.getByRole("radio");
    if (await chips.count()) {
      const checked = await aux.locator("input[type=radio]:checked").count();
      await aux.locator("label.chip:has(input:not(:checked))").first().click({ force: true });
      await saysNotHere(frame, "Auxiliary dehumidifier", DEVICE_WORDS);
      expect(await aux.locator("input[type=radio]:checked").count()).toBe(checked);
    }
    await expect(sw).toHaveAttribute("aria-checked", was ?? "");
    expect(await sent(page)).not.toContain("device");
    expect(await page.evaluate<number>("fakeHA.calls.length")).toBe(0);
    /* The heater is Nursery's and Garden's, not Veg's, so Nursery switches it as any zone does. */
    const heater = device(frame, "heater");
    await expect(heater).not.toHaveClass(/\bro\b/);
    await expect(heater).toContainText("Shared with Garden.");
    await heater.getByRole("switch").click();
    await expect(alert(frame)).toHaveCount(0);
    await expect.poll(() => sent(page)).toContain("device");
    await expect.poll(() => page.evaluate<number>("fakeHA.calls.length")).toBe(1);
  });

  for (const share of [true, false])
    test(`a reading is judged by the parent's limits only when a sensor is shared (${share ? "shared" : "not shared"})`, async ({ page }) => {
      const frame = await load(page, { shareSensor: share });
      await nursery(frame);
      await expect(tile(frame, "Temperature").locator(".pill")).toHaveText(share ? "High" : "Ideal");
    });

  test("sharing a sensor and lights: Targets and day and night are the parent's, read only, with nothing to apply", async ({ page }) => {
    const frame = await load(page, { shareSensor: true });
    await nursery(frame);
    await zoneMenu(frame, "View targets");
    await expect(dialog(frame).locator("#t-shared")).toHaveText("This zone shares a sensor with Zone: Veg, so its targets are Veg's. Edit in Veg.");
    await expect(dialog(frame).locator("#t-editin")).toHaveText("Edit in Zone: Veg");
    await expect(dialog(frame).getByRole("button", { name: "Set targets" })).toHaveCount(0);
    await expect(dialog(frame).locator("table.limits").first().locator("tbody tr").first()).toContainText("Temperature°C1012-1535");
    await dialog(frame).getByRole("button", { name: "Close" }).click();

    await setup(frame);
    await expect(app(frame).locator("#td-intro")).toHaveText("Everything on this page is Zone: Veg's, so there's nothing to change here. Edit in Veg.");
    await expect(app(frame).locator('[data-sharedline="targets"]')).toHaveText("This zone shares a sensor with Zone: Veg, so its targets are Veg's. Edit in Veg.");
    await expect(app(frame).locator('[data-sharedline="times"]')).toHaveText("This zone shares Zone: Veg's lights, so its day and night are Veg's. Edit in Veg.");
    await expect(app(frame).getByRole("group", { name: "Limits", exact: true })).toHaveCount(0);
    await expect(app(frame).getByRole("group", { name: "Athena stage", exact: true })).toHaveCount(0);
    await expect(app(frame).getByRole("group", { name: "Day and night source", exact: true })).toHaveCount(0);
    const max = app(frame).locator("#vin-temperature-3");
    await expect(max).toHaveValue("15");
    await expect(max).toHaveAttribute("readonly", "");
    await expect(max).not.toHaveAttribute("disabled", "");
    await max.click({ force: true });
    await saysNotHere(frame, "Targets", SETTING_WORDS);
    await app(frame).locator("#vwrap").click({ force: true });
    await saysNotHere(frame, "Targets", SETTING_WORDS);
    await app(frame).locator("#sro-day").click({ force: true });
    await saysNotHere(frame, "Day and night", SETTING_WORDS);
    await expect(bar(frame).getByRole("button", { name: /Review and apply|Discard/ })).toHaveCount(0);
    expect((await sent(page)).filter((t) => t === "setting" || t === "save" || t === "device")).toEqual([]);
  });

  test("sharing only lights: day and night are the parent's, the zone's own targets stay editable and save as its own", async ({ page }) => {
    const frame = await load(page, { vegTimes: true });
    const before = await stored(page);
    await setup(frame);
    await expect(app(frame).locator('[data-sharedline="times"]')).toHaveText("This zone shares Zone: Veg's lights, so its day and night are Veg's. Edit in Veg.");
    await expect(app(frame).locator('[data-sharedline="emerson"]')).toHaveText("This zone shares Zone: Veg's lights, so its red lights are Veg's. Edit in Veg.");
    await expect(app(frame).locator("#sro-day")).toHaveValue("08:00");
    await expect(app(frame).locator("#sro-night")).toHaveValue("20:00");
    await expect(app(frame).getByRole("group", { name: "Day and night source", exact: true })).toHaveCount(0);
    await app(frame).locator("#sro-night").click({ force: true });
    await saysNotHere(frame, "Day and night", SETTING_WORDS);
    await expect(app(frame).locator('[data-sharedline="targets"]')).toHaveCount(0);
    await expect(app(frame).getByRole("group", { name: "Limits", exact: true })).toBeVisible();
    const max = app(frame).locator("#vin-temperature-3");
    await expect(max).not.toHaveAttribute("readonly", "");
    await max.fill("28");
    await max.press("Enter");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const after = await stored(page), z = (s: Stored, id: string) => s.zones.find((x) => x.id === id) as Zone;
    /* The page opens on the period it is now, by Veg's day and night. */
    expect([z(after, "nursery").bands.day.temperature[3], z(after, "nursery").bands.night.temperature[3]]).toContain(28);
    expect(z(after, "veg")).toEqual(z(before, "veg"));
    for (const k of ["periodMode", "dayAt", "nightAt", "emersonMode", "emerson", "helpers", "lights", "redLights"]) expect(z(after, "nursery")[k]).toEqual(z(before, "nursery")[k]);
    expect(await sent(page)).not.toContain("setting");
  });
});
