/* Linked zones (#91, #111), third piece: what a linked zone shows of its parent's automations. In the sample room
   Nursery is linked to Veg, and both link automations on every chip; Garden isn't linked to anything. The parent's are
   shown read only, a tap on one says where it's changed, and nothing for them is ever sent from the linked zone. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, zoneMenu } from "./helpers";

const FANS = "automation.failsafe_veg_fans_auto_on";
const autos = (frame: Frame) => app(frame).getByRole("dialog", { name: /^Automations: / });
const chip = (frame: Frame, name: string) => autos(frame).getByRole("group", { name: "Automations", exact: true }).getByRole("button", { name: new RegExp(`^${name},`) });
const fromCard = (frame: Frame) => autos(frame).locator("section.card[data-fromzone]");
const roRow = (frame: Frame, name: string) => fromCard(frame).locator(".dev.ro", { has: frame.locator(".dev-name", { hasText: new RegExp(`^${name}$`) }) });
const told = (frame: Frame) => app(frame).getByRole("alertdialog");
const showFrom = (frame: Frame) => autos(frame).getByRole("button", { name: "Show automations from Zone: Veg", exact: true });
const starLine = (frame: Frame) => autos(frame).locator("#autos-star");
const setState = (page: Page, entity: string, state: string) => page.evaluate(`fakeHA.setState(${JSON.stringify(entity)}, ${JSON.stringify(state)}, {})`);
const restartWith = (page: Page, change: string) =>
  page.evaluate(`(() => { fakeHA.knobs.restartMs = 50; const c = JSON.parse(fakeHA.disk); ${change}; fakeHA.disk = JSON.stringify(c); fakeHA.restart(); })()`);

/* Every message the frame posts to the host, by type, and every service call HA was asked for. */
async function watchSent(page: Page): Promise<() => Promise<{ sent: string[]; calls: string[] }>> {
  await page.evaluate(() => {
    const w = window as unknown as { sentTypes: string[] };
    w.sentTypes = [];
    window.addEventListener("message", (e) => e.data && typeof e.data.type === "string" && w.sentTypes.push(e.data.type), true);
  });
  const before = await page.evaluate<number>("fakeHA.calls.length");
  return () =>
    page.evaluate(`({ sent: window.sentTypes.slice(), calls: fakeHA.calls.slice(${before}).map((c) => c.domain + "." + c.service) })`) as Promise<{ sent: string[]; calls: string[] }>;
}

async function openAutos(page: Page, zone = "Nursery", chipName = "Failsafes", dark = false): Promise<Frame> {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  if (dark) {
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  }
  await goTo(frame, zone);
  await zoneMenu(frame, "View automations");
  await expect(autos(frame).getByRole("heading", { level: 2, name: `Automations: ${zone}`, exact: true })).toBeVisible();
  if (chipName !== "Alerts") await chip(frame, chipName).click();
  return frame;
}

/* WCAG contrast of an element's text on the read-only tile behind it, both read as the browser resolved them. */
const contrast = (frame: Frame, sel: string) =>
  frame.evaluate((s) => {
    const el = document.querySelector("ec-app")!.shadowRoot!.querySelector(s) as HTMLElement;
    const probe = document.createElement("canvas").getContext("2d")!;
    const rgb = (c: string) => {
      probe.fillStyle = "#000";
      probe.fillStyle = c;
      probe.fillRect(0, 0, 1, 1);
      return Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const lum = (c: number[]) => c.map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    let bgEl: HTMLElement | null = el;
    while (bgEl && getComputedStyle(bgEl).backgroundColor === "rgba(0, 0, 0, 0)") bgEl = bgEl.parentElement;
    const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(getComputedStyle(bgEl!).backgroundColor))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, sel);

test.describe("a linked zone's parent automations", () => {
  test("a linked zone lists its parent's automations for the chip after its own, with the parent's names; an unlinked zone has none", async ({ page }) => {
    let frame = await openAutos(page);
    await expect(fromCard(frame).getByRole("heading", { level: 3, name: "From Zone: Veg", exact: true })).toBeVisible();
    await expect(fromCard(frame)).toContainText("These belong to Zone: Veg and run devices this zone shares. Edit in Veg.");
    await expect(fromCard(frame).locator(".dev.ro .dev-name")).toHaveText(["Failsafe Veg Fans Auto On", "Failsafe Tent Lights Recovery"]);
    /* After the zone's own groups. */
    expect(await autos(frame).locator("#autos-scroll > section.card").evaluateAll((cs) => cs.map((c) => (c.hasAttribute("data-fromzone") ? "from" : c.getAttribute("data-agroup"))))).toEqual(["failsafe", "from"]);
    /* Live state: the row follows what HA reports for the parent's automation. */
    await expect(roRow(frame, "Failsafe Veg Fans Auto On").locator(".dev-sub")).toContainText(/^On\./);
    await setState(page, FANS, "off");
    await expect(roRow(frame, "Failsafe Veg Fans Auto On").locator(".dev-sub")).toContainText(/^Off\./);
    await expect(roRow(frame, "Failsafe Veg Fans Auto On").getByRole("switch")).toHaveAttribute("aria-checked", "false");
    /* The parent's own name for a link, where it gave one. */
    await chip(frame, "Control").click();
    await expect(fromCard(frame).locator(".dev-name")).toContainText(["Tent lights off"]);

    frame = await openAutos(page, "Garden");
    await expect(fromCard(frame)).toHaveCount(0);
    await expect(starLine(frame)).toHaveCount(0);
    await expect(showFrom(frame)).toHaveCount(0);
  });

  test("a tap on a read-only row, or Enter or Space on its switch, opens the one-button dialog and sends nothing", async ({ page }) => {
    const frame = await openAutos(page);
    const sent = await watchSent(page);
    const url = page.url(), row = roRow(frame, "Failsafe Veg Fans Auto On"), sw = row.getByRole("switch");
    const answer = async () => {
      await expect(told(frame).getByRole("heading", { name: "Failsafe Veg Fans Auto On", exact: true })).toBeVisible();
      await expect(told(frame)).toContainText("This automation is associated to Zone: Veg. Please edit it in Veg.");
      await expect(told(frame).getByRole("button")).toHaveText(["OK"]);
      await expect(app(frame).locator(".toast")).toHaveCount(0);
      await told(frame).getByRole("button", { name: "OK" }).click();
      await expect(told(frame)).toHaveCount(0);
      await expect(autos(frame).getByRole("heading", { level: 2, name: "Automations: Nursery", exact: true })).toBeVisible();
      expect(page.url()).toBe(url);
    };
    await row.locator(".dev-name").click();
    await answer();
    await row.locator(".dev-sub").click();
    await answer();
    /* The switch is reached by the keyboard, and says it's read only. */
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await expect(sw).toHaveAttribute("aria-readonly", "true");
    await sw.focus();
    await expect(sw).toBeFocused();
    await page.keyboard.press("Enter");
    await answer();
    await sw.focus();
    await page.keyboard.press(" ");
    await answer();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    const { sent: types, calls } = await sent();
    expect(types).not.toContain("automation");
    expect(calls).toEqual([]);
  });

  for (const dark of [false, true])
    test(`a read-only row has no accent colour, dims its switch, shows not-allowed over the tile, and keeps its text legible (${dark ? "dark" : "light"})`, async ({ page }) => {
      const frame = await openAutos(page, "Nursery", "Failsafes", dark);
      const look = (sel: string) =>
        frame.evaluate((s) => {
          const r = document.querySelector("ec-app")!.shadowRoot!.querySelector(s)!, cs = (q: string) => getComputedStyle(r.querySelector(q)!);
          return { tile: getComputedStyle(r).cursor, name: cs(".dev-name").cursor, icon: cs(".ic svg").fill, knob: cs(".sw i").backgroundColor, track: cs(".sw").borderColor, opacity: cs(".sw").opacity, dim: getComputedStyle(r).getPropertyValue("--ro-dim").trim(), border: getComputedStyle(r).borderStyle };
        }, sel);
      /* Both rows are on: an editable one shows the accent on its icon and switch, a read-only one doesn't. */
      const mine = await look('section.card[data-agroup="failsafe"] .dev:has(.sw.on)'), ro = await look("section.card[data-fromzone] .dev.ro:has(.sw.on)");
      expect(mine.knob).not.toBe(ro.knob);
      expect(mine.icon).not.toBe(ro.icon);
      expect(mine.track).not.toBe(ro.track);
      expect(ro.knob).toBe(ro.track);
      expect(ro.opacity).toBe("0.45");
      expect(ro.dim).toBe(".45");
      expect(ro.border).toBe("dashed");
      expect(ro.tile).toBe("not-allowed");
      expect(ro.name).toBe("not-allowed");
      expect(mine.tile).toBe("pointer");
      expect(await contrast(frame, "section.card[data-fromzone] .dev.ro .dev-name")).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(frame, "section.card[data-fromzone] .dev.ro .dev-sub")).toBeGreaterThanOrEqual(3);
      expect(await contrast(frame, 'section.card[data-agroup="failsafe"] .dev .dev-name')).toBeGreaterThanOrEqual(4.5);
      /* The card's heading and its line aren't dimmed. */
      expect(await fromCard(frame).locator("h3, p").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))).toEqual(["1", "1"]);
    });

  test("an asterisk marks only the chips where the parent has automations, with its line, and the control hides and shows the card", async ({ page }) => {
    let frame = await openAutos(page);
    await restartWith(page, `const v = c.zones.find((z) => z.id === "veg"); v.automations = v.automations.filter((a) => a.group !== "control")`);
    await expect(chip(frame, "Control")).toHaveAttribute("aria-label", /^Control, \d+ of \d+ on$/);
    await expect(chip(frame, "Failsafes")).toHaveAttribute("aria-label", /^Failsafes, \d+ of 2 on, and Zone: Veg has some that also run here$/);
    await expect(chip(frame, "Alerts")).toHaveAttribute("aria-label", /, and Zone: Veg has some that also run here$/);
    await expect(chip(frame, "Failsafes").locator(".star")).toHaveText("*");
    await expect(chip(frame, "Failsafes").locator(".star")).toHaveAttribute("aria-hidden", "true");
    await expect(chip(frame, "Control").locator(".star")).toHaveCount(0);
    await expect(starLine(frame)).toHaveText("* Zone: Veg has automations in this group that also run here.");

    frame = await openAutos(page);
    await expect(showFrom(frame)).toHaveAttribute("aria-pressed", "true");
    await expect(fromCard(frame)).toHaveCount(1);
    await showFrom(frame).click();
    await expect(showFrom(frame)).toHaveAttribute("aria-pressed", "false");
    await expect(fromCard(frame)).toHaveCount(0);
    await expect(chip(frame, "Failsafes").locator(".star")).toHaveText("*");
    await expect(starLine(frame)).toBeVisible();
    /* Remembered across chips while the dialog is open. */
    await chip(frame, "Alerts").click();
    await expect(fromCard(frame)).toHaveCount(0);
    await showFrom(frame).click();
    await expect(fromCard(frame)).toHaveCount(1);
    await expect(fromCard(frame).locator(".dev-name")).toContainText(["Critical Veg Temperature High Day"]);
  });

  test("the linked zone's page says plainly when a failsafe in its parent is off, with nothing to tap", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Nursery");
    const notice = app(frame).locator("#parent-failsafe");
    await expect(notice).toHaveCount(0);
    await setState(page, FANS, "off");
    await expect(notice).toHaveText("A failsafe in Zone: Veg is off: Failsafe Veg Fans Auto On. While it's off, nothing puts that hardware back. Edit in Veg.");
    await expect(notice.locator("button, a")).toHaveCount(0);
    await setState(page, "automation.failsafe_tent_lights_recovery", "off");
    await expect(notice).toHaveText("2 failsafes in Zone: Veg are off. While they're off, nothing puts that hardware back. Edit in Veg.");
    await goTo(frame, "Garden");
    await expect(app(frame).locator("#parent-failsafe")).toHaveCount(0);
  });
});
