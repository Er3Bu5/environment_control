/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, panelFrame, serviceCalls } from "./helpers";

test.describe("manual controls", () => {
  const controls = (frame: Frame) => app(frame).locator("#controls");
  const row = (frame: Frame, name: string) => controls(frame).locator(".dev", { has: frame.locator(".dev-name", { hasText: new RegExp(`^${name}$`) }) });
  const sw = (frame: Frame, name: string) => controls(frame).getByRole("switch", { name, exact: true });
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  async function openZone(page: Page, zone = "Garden"): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, zone);
    await expect(controls(frame)).toBeVisible();
    return frame;
  }
  const device = (frame: Frame, body: Record<string, unknown>) =>
    frame.evaluate(
      (b) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const req = 9000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
          parent.postMessage({ v: 1, type: "device", req, ...b }, "*");
        }),
      body,
    );

  test("groups the zone's devices by what they move, names shared hardware, and holds back a device with no role", async ({ page }) => {
    const frame = await openZone(page);
    await expect(controls(frame).locator("h3")).toHaveText(["Humidity", "Temperature", "Airflow", "Lights"]);
    await expect(row(frame, "Heater")).toContainText("Off. Shared with Veg and Nursery.");
    await expect(row(frame, "Dehumidifier")).toContainText("Unit RH 56%. Normal isn't in its mode list.");
    await expect(row(frame, "Air conditioner exhaust fan")).toContainText("Unavailable");
    await expect(sw(frame, "Air conditioner exhaust fan")).toBeDisabled();
    await expect(controls(frame)).not.toContainText("Spare plug");
    await expect(row(frame, "Plug 7")).toHaveCount(0);
    await controls(frame).getByRole("button", { name: /Plug 7 isn't shown until you say what it is/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: /Device identification/ })).toBeVisible();
    await expect(app(frame).locator("#md-switch_plug_7")).toBeInViewport();
    expect(await serviceCalls(page)).toBe(0);
  });

  test("a shared device names its other zones in Overview's order, whatever order it was added to them in", async ({ page }) => {
    const frame = await openZone(page);
    /* The rename shows the change has been heard; the heater now lists its zones backwards. */
    await page.evaluate(`(() => { fakeHA.knobs.restartMs = 50; const c = JSON.parse(fakeHA.disk); c.zones.find((z) => z.id === "veg").name = "Veg tent"; c.devices.find((d) => d.entity === "switch.heater_mains").zones = ["nursery", "veg", "garden"]; fakeHA.disk = JSON.stringify(c); fakeHA.restart(); })()`);
    await expect(row(frame, "Heater")).toContainText("Shared with Veg tent and Nursery.");
  });

  test("a tap is shown as sent, and the switch moves only once the device reports it", async ({ page }) => {
    const frame = await openZone(page);
    await page.evaluate("fakeHA.knobs.reportMs = 1500");
    await sw(frame, "Heater").click();
    await expect(row(frame, "Heater").getByRole("status")).toHaveText("Sent. Waiting for Heater to report back.");
    await expect(sw(frame, "Heater")).toHaveAttribute("aria-checked", "false");
    await expect(sw(frame, "Heater")).toBeDisabled();
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "switch", service: "turn_on", data: { entity_id: "switch.heater_mains" } })]);
    await expect(sw(frame, "Heater")).toHaveAttribute("aria-checked", "true");
    await expect(row(frame, "Heater").getByRole("status")).toHaveCount(0);
    await expect(row(frame, "Heater")).toContainText("On. Shared with Veg and Nursery.");
  });

  test("a command the device drops is never shown as done, says what it still reports, and can be tried again", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await openZone(page);
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await sw(frame, "Heater").click();
    await expect(row(frame, "Heater").getByRole("status")).toHaveText("Not confirmed. Heater still reports off. A Tuya plug can drop a command without saying, so try again.", { timeout: 15_000 });
    await expect(sw(frame, "Heater")).toHaveAttribute("aria-checked", "false");
    await sw(frame, "Heater").click();
    await expect(sw(frame, "Heater")).toHaveAttribute("aria-checked", "true");
    await expect(row(frame, "Heater").getByRole("status")).toHaveCount(0);
    expect((await calls(page)).map((c) => c.service)).toEqual(["turn_on", "turn_on"]);
  });

  test("a failsafe that puts a device straight back is said, rather than the control looking broken", async ({ page }) => {
    const frame = await openZone(page, "Veg");
    await sw(frame, "Oscillating fans").click();
    await expect(row(frame, "Oscillating fans").getByRole("status")).toHaveText("Put back by Home Assistant straight after, most likely a failsafe or the light schedule.");
    await expect(sw(frame, "Oscillating fans")).toHaveAttribute("aria-checked", "true");
  });

  test("dims a light controller, and sets a dehumidifier's mode and target, each shown once reported", async ({ page }) => {
    const frame = await openZone(page);
    await controls(frame).getByRole("slider", { name: "Overhead light controller brightness", exact: true }).fill("40");
    await expect(row(frame, "Overhead light controller")).toContainText("On, 40%.");
    await row(frame, "Auxiliary dehumidifier").getByText("Eco", { exact: true }).click();
    await expect(row(frame, "Auxiliary dehumidifier")).toContainText("On, eco mode.");
    await controls(frame).getByRole("slider", { name: "Auxiliary dehumidifier target humidity", exact: true }).fill("45");
    /* The dial shows the number being chosen at once, so wait for the command and the device's report. */
    await expect.poll(() => serviceCalls(page)).toBe(3);
    await expect(row(frame, "Auxiliary dehumidifier").getByRole("slider")).toBeEnabled();
    await expect(row(frame, "Auxiliary dehumidifier").locator(".dial")).toContainText("Target45%");
    expect((await calls(page)).map((c) => [`${c.domain}.${c.service}`, c.data])).toEqual([
      ["light.turn_on", { entity_id: "light.garden_light_controller_overhead", brightness_pct: 40 }],
      ["humidifier.set_mode", { entity_id: "humidifier.auxiliary_dehumidifier", mode: "eco" }],
      ["humidifier.set_humidity", { entity_id: "humidifier.auxiliary_dehumidifier", humidity: 45 }],
    ]);
  });

  test("on a screen too narrow for one line, a dehumidifier's modes sit under its name with the dial beside both", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const frame = await openZone(page);
    const r = row(frame, "Auxiliary dehumidifier");
    const box = async (sel: string) => (await r.locator(sel).boundingBox())!;
    const [whole, text, modes, dial, onOff] = [(await r.boundingBox())!, await box(".dev-text"), await box(".dev-modes"), await box(".dial"), await box(".sw")];
    const foot = (b: { y: number; height: number }) => b.y + b.height, right = (b: { x: number; width: number }) => b.x + b.width;
    /* Under the name, starting under its icon, and clear of the dial at their right. */
    const icon = await box(".ic");
    expect(modes.y).toBeGreaterThanOrEqual(foot(text));
    /* With room between them, so the modes read as a line of their own and not as part of the name. */
    expect(modes.y - foot(text)).toBeGreaterThanOrEqual(12);
    expect(Math.abs(modes.x - icon.x)).toBeLessThan(2);
    expect(right(modes)).toBeLessThanOrEqual(dial.x);
    expect(Math.abs((await box(".chip >> nth=0")).x - icon.x)).toBeLessThan(2);
    /* The dial is beside the name and the modes, not on a line under them, so the row is as tall as its dial. */
    expect(dial.y).toBeLessThan(foot(text));
    expect(foot(dial)).toBeGreaterThan(modes.y);
    expect(right(dial)).toBeLessThan(onOff.x);
    expect(whole.height).toBeLessThan(175);
    /* The name and its modes are centred against the dial as one block. */
    expect(Math.abs((text.y + foot(modes)) / 2 - (whole.y + whole.height / 2))).toBeLessThan(3);
    /* What a device says back still gets a line of its own, the full width of the row. */
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await r.getByText("Eco", { exact: true }).click();
    const status = (await r.locator(".ctl-status").boundingBox())!;
    expect(status.y).toBeGreaterThanOrEqual(foot((await r.locator(".dial").boundingBox())!) - 1);
    expect(Math.abs(status.x - (await r.locator(".ic").boundingBox())!.x)).toBeLessThan(2);
    /* A unit with five modes still has them on one line. */
    await page.evaluate(`fakeHA.setState("humidifier.auxiliary_dehumidifier", "on", { available_modes: ["sleep", "comfort", "eco", "boost", "normal"], mode: "boost" })`);
    await expect(r.locator(".chip")).toHaveCount(5);
    expect((await box(".chip >> nth=4")).y).toBe((await box(".chip >> nth=0")).y);
    expect(right(await box(".chip >> nth=4"))).toBeLessThanOrEqual((await box(".dial")).x);
    /* Narrower still, the name stays beside its icon and the modes take the line under both. */
    await page.setViewportSize({ width: 412, height: 900 });
    const [mark, name, chips] = [await box(".ic"), await box(".dev-text"), await box(".dev-modes")];
    expect(name.x).toBeGreaterThanOrEqual(right(mark));
    expect(name.y).toBeLessThan(foot(mark));
    expect(chips.y - Math.max(foot(name), foot(mark))).toBeGreaterThanOrEqual(12);
    expect(Math.abs(chips.x - mark.x)).toBeLessThan(2);
  });

  test("on a wide screen a group's devices stand two abreast, each laid out as a mid-width row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const frame = await openZone(page);
    const foot = (b: { y: number; height: number }) => b.y + b.height, right = (b: { x: number; width: number }) => b.x + b.width;
    const group = controls(frame).locator(".cgroup", { has: frame.getByRole("heading", { name: "Humidity", exact: true }) });
    const [whole, first, second] = [(await group.boundingBox())!, (await group.locator(".dev").nth(0).boundingBox())!, (await group.locator(".dev").nth(1).boundingBox())!];
    /* Side by side, as tall as each other, and filling the group's width between them. */
    expect(second.y).toBe(first.y);
    expect(second.height).toBe(first.height);
    expect(second.x).toBeGreaterThan(right(first));
    expect(Math.abs(first.x - whole.x)).toBeLessThan(2);
    expect(Math.abs(right(second) - right(whole))).toBeLessThan(2);
    expect(Math.abs(first.width - second.width)).toBeLessThan(2);
    /* In half the width, the modes sit under the name, starting under its icon and all on one line, with the dial
       beside both, and nothing runs out of its row. */
    const r = row(frame, "Auxiliary dehumidifier");
    const box = async (sel: string) => (await r.locator(sel).boundingBox())!;
    const [mine, text, modes, dial, onOff] = [(await r.boundingBox())!, await box(".dev-text"), await box(".dev-modes"), await box(".dial"), await box(".sw")];
    expect(modes.y).toBeGreaterThanOrEqual(foot(text));
    expect(Math.abs(modes.x - (await box(".ic")).x)).toBeLessThan(2);
    expect((await box(".chip >> nth=3")).y).toBe((await box(".chip >> nth=0")).y);
    expect(dial.y).toBeLessThan(foot(text));
    expect(right(modes)).toBeLessThanOrEqual(dial.x);
    expect(right(dial)).toBeLessThan(onOff.x);
    expect(right(onOff)).toBeLessThanOrEqual(right(mine));
    expect(mine.height).toBeLessThan(175);
    /* Every group is in the same two columns, and a row with a dial keeps it on the row's own line. */
    for (const g of await controls(frame).locator(".cgroup").all()) {
      const rows = await Promise.all((await g.locator(".dev").all()).map(async (d) => (await d.boundingBox())!));
      for (const [i, b] of rows.entries()) expect(Math.abs(b.x - (i % 2 ? second.x : first.x))).toBeLessThan(2);
    }
    const light = row(frame, "Overhead light controller");
    const [name, lightDial] = [(await light.locator(".dev-text").boundingBox())!, (await light.locator(".dial").boundingBox())!];
    expect(lightDial.y).toBeLessThan(foot(name));
    expect(lightDial.x).toBeGreaterThanOrEqual(right(name));
    /* What has a dial is listed first, so the two controllers share a line and no plug is stretched beside a dial. */
    const lights = controls(frame).locator(".cgroup", { has: frame.getByRole("heading", { name: "Lights", exact: true }) }).locator(".dev");
    await expect(lights.locator(".dev-name")).toHaveText(["Overhead light controller", "Under canopy light controller", "Overhead lights 1", "Overhead lights 2", "Red lights"]);
    expect((await lights.nth(1).boundingBox())!.y).toBe((await lights.nth(0).boundingBox())!.y);
    expect((await lights.nth(2).boundingBox())!.height).toBeLessThan(100);
  });

  test("a light controller that rounds to its own steps answers with its own number, and the row says so at once", async ({ page }) => {
    const frame = await openZone(page);
    await page.evaluate("fakeHA.knobs.steps['light.garden_light_controller_overhead'] = { step: 5, floor: 15 }");
    const lamp = row(frame, "Overhead light controller"), slider = controls(frame).getByRole("slider", { name: "Overhead light controller brightness", exact: true });
    await slider.fill("63");
    await expect(lamp.getByRole("status")).toHaveText("Went to 65%, not 63%. Overhead light controller keeps to its own steps and limits.", { timeout: 3000 });
    await expect(lamp).toContainText("On, 65%.");
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveValue("65");
    /* Asked for a number it rounds back to where it already is, it reports nothing new. */
    await slider.fill("67");
    await expect(lamp.getByRole("status")).toHaveText("Not confirmed. Overhead light controller still reports 65%. It may not take 67%, so try another value.", { timeout: 15_000 });
    await slider.fill("40");
    await expect(lamp).toContainText("On, 40%.");
    await expect(lamp.getByRole("status")).toHaveCount(0);
  });

  test("a dial's buttons step in the light's own steps and send one command once left alone, and its middle takes no tap", async ({ page }) => {
    const frame = await openZone(page);
    const lamp = row(frame, "Overhead light controller"), num = lamp.locator(".dial-num");
    await lamp.scrollIntoViewIfNeeded();
    const box = (await lamp.locator(".dial svg").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const raise = lamp.getByRole("button", { name: "Raise Overhead light controller brightness" });
    await raise.click();
    await raise.click();
    /* The number moves ahead of the light only while it's being chosen, and nothing is sent yet. */
    await expect(num).toHaveText("90%");
    expect(await serviceCalls(page)).toBe(0);
    await expect(lamp).toContainText("On, 90%.");
    await expect(lamp.getByRole("status")).toHaveCount(0);
    await lamp.getByRole("button", { name: "Lower Overhead light controller brightness" }).click();
    await expect(lamp).toContainText("On, 85%.");
    expect((await calls(page)).map((c) => c.data.brightness_pct)).toEqual([90, 85]);
  });

  test("dragging a dial's arc chooses the number under the pointer, sent when it lifts", async ({ page }) => {
    const frame = await openZone(page);
    const lamp = row(frame, "Overhead light controller"), num = lamp.locator(".dial-num");
    await lamp.scrollIntoViewIfNeeded();
    const box = (await lamp.locator(".dial svg").boundingBox())!;
    /* Where a brightness sits on the arc: 270 degrees from bottom left, in the dial's 120 unit box. */
    const at = (pct: number): [number, number] => {
      const a = ((135 + (270 * (pct - 1)) / 99) * Math.PI) / 180;
      return [box.x + ((60 + 48 * Math.cos(a)) / 120) * box.width, box.y + ((60 + 48 * Math.sin(a)) / 120) * box.height];
    };
    await page.mouse.move(...at(60));
    await page.mouse.down();
    await expect(num).toHaveText("60%");
    await page.mouse.move(...at(45), { steps: 4 });
    await page.mouse.move(...at(30), { steps: 4 });
    await expect(num).toHaveText("30%");
    await expect(lamp).toContainText("On, 80%.");
    expect(await serviceCalls(page)).toBe(0);
    await page.mouse.up();
    await expect(lamp).toContainText("On, 30%.");
    expect((await calls(page)).map((c) => [`${c.domain}.${c.service}`, c.data])).toEqual([["light.turn_on", { entity_id: "light.garden_light_controller_overhead", brightness_pct: 30 }]]);
    /* Turned and brought back to where the light already is, nothing is asked for. */
    await page.mouse.move(...at(30));
    await page.mouse.down();
    await page.mouse.move(...at(50), { steps: 4 });
    await page.mouse.move(...at(30), { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await serviceCalls(page)).toBe(1);
    await expect(lamp.getByRole("status")).toHaveCount(0);
  });

  test("a dehumidifier that's off has a grey dial that says Off, with its target kept in the caption and still settable", async ({ page }) => {
    const frame = await openZone(page);
    const unit = row(frame, "Auxiliary dehumidifier"), num = unit.locator(".dial-num"), cap = unit.locator(".dial-cap"), fill = unit.locator(".dial .fil");
    const stroke = () => fill.evaluate((el) => getComputedStyle(el).stroke);
    await expect(num).toHaveText("50%");
    await expect(cap).toHaveText("Target");
    const lit = await stroke();
    await page.evaluate(`fakeHA.setState("humidifier.auxiliary_dehumidifier", "off")`);
    await expect(unit).toContainText("Off.");
    await expect(num).toHaveText("Off");
    await expect(cap).toHaveText("Target 50%");
    const grey = await stroke();
    expect(grey).not.toBe(lit);
    /* The same grey as an off device's icon and switch. */
    expect(grey).toBe(await unit.locator(".sw i").evaluate((el) => getComputedStyle(el).backgroundColor));
    /* The target can be set ahead of switching it on, and nothing here switches it on. */
    await unit.getByRole("button", { name: "Raise Auxiliary dehumidifier target humidity" }).click();
    await expect(cap).toHaveText("Target 51%");
    await expect(num).toHaveText("Off");
    await expect.poll(() => serviceCalls(page)).toBe(1);
    expect((await calls(page)).map((c) => [`${c.domain}.${c.service}`, c.data.humidity])).toEqual([["humidifier.set_humidity", 51]]);
    await expect.poll(() => page.evaluate(`fakeHA.states["humidifier.auxiliary_dehumidifier"].attributes.humidity`)).toBe(51);
    await expect(unit.getByRole("status")).toHaveCount(0);
    await page.evaluate(`fakeHA.setState("humidifier.auxiliary_dehumidifier", "on")`);
    await expect(num).toHaveText("51%");
    await expect(cap).toHaveText("Target");
    expect(await stroke()).toBe(lit);
  });

  test("a device whose target moves in steps is set only on those steps, by the dial's buttons and by the host", async ({ page }) => {
    const frame = await openZone(page);
    await page.evaluate(`fakeHA.setState("humidifier.auxiliary_dehumidifier", "on", { target_humidity_step: 5 })`);
    const unit = row(frame, "Auxiliary dehumidifier"), num = unit.locator(".dial-num");
    await expect(num).toHaveText("50%");
    await unit.getByRole("button", { name: "Raise Auxiliary dehumidifier target humidity" }).click();
    await expect(num).toHaveText("55%");
    await expect.poll(() => serviceCalls(page)).toBe(1);
    /* Its slider moves in the same steps, so the keys land on them too. */
    await expect(unit.getByRole("slider")).toHaveAttribute("step", "5");
    await unit.getByRole("slider").fill("65");
    await expect(num).toHaveText("65%");
    await expect.poll(() => serviceCalls(page)).toBe(2);
    expect((await calls(page)).map((c) => c.data.humidity)).toEqual([55, 65]);
    /* And the host won't send a target between steps whatever the frame asks for. */
    expect(await device(frame, { id: "aux", action: "humidity", value: 63 })).toMatchObject({ ok: false, error: expect.stringContaining("isn't something this device takes") });
    expect(await serviceCalls(page)).toBe(2);
  });

  test("a mode Home Assistant doesn't list is added from the row that reports it, then reached by moving the target one step and back", async ({ page }) => {
    test.setTimeout(60_000);
    const frame = await openZone(page);
    /* As the real unit is: its target moves in steps of 5, and it takes a target between two steps without changing. */
    await page.evaluate(`fakeHA.knobs.targetModes["humidifier.garden_dehumidifier"] = "normal"; fakeHA.setState("humidifier.garden_dehumidifier", "on", { target_humidity_step: 5 })`);
    const dehu = row(frame, "Dehumidifier"), chip = (name: string) => dehu.getByRole("radio", { name, exact: true });
    await expect(dehu).toContainText("Normal isn't in its mode list.");
    await expect(chip("Normal")).toHaveCount(0);
    /* The link opens Device identification at the device, with the mode filled in, to review like any other change. */
    await dehu.getByRole("button", { name: "Add Normal as a mode ›" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: /Device identification/ })).toBeVisible();
    const box = app(frame).locator("#md-humidifier_garden_dehumidifier").getByLabel(/^Extra mode, optional/);
    await expect(box).toHaveValue("normal");
    /* Plug 7 still has no role, which would hold the review, so it's left out of the zone here. */
    await app(frame).locator("#md-switch_plug_7").getByRole("button").first().click();
    /* This page's Garden has sensors Home Assistant no longer lists, which would hold the review too: they're swapped
       for one it does, on the step before. */
    await app(frame).locator(".steps").getByRole("button", { name: "1. Sensors", exact: true }).click();
    for (const id of ["g-left", "g-right", "g-under"]) await app(frame).locator(`#ms-${id}`).getByRole("button").first().click();
    await app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: "Environment board" }) }).getByRole("button").first().click();
    const next = app(frame).getByRole("button", { name: /^(Next|Review and apply)$/ });
    await next.click();
    await expect(box).toHaveValue("normal");
    await next.click();
    await next.click();
    await expect(app(frame).getByRole("dialog")).toContainText("extra modeNone → normal");
    await app(frame).getByRole("dialog").getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(controls(frame)).toBeVisible();
    /* Applied, the device goes by the name Home Assistant has for it. */
    const unit = row(frame, "Garden Dehumidifier"), mode = (name: string) => unit.getByRole("radio", { name, exact: true });
    await expect(unit).not.toContainText("isn't in its mode list");
    await expect(unit.getByRole("radio")).toHaveCount(5);
    await expect(mode("Normal")).toBeChecked();
    expect(await serviceCalls(page)).toBe(0);

    await unit.getByText("Boost", { exact: true }).click();
    await expect(unit).toContainText("On, boost mode.");
    await unit.getByText("Normal", { exact: true }).click();
    await expect(unit.getByRole("status")).toHaveText("Moving the target one step and back, which puts Garden Dehumidifier in normal mode.");
    await expect(unit).toContainText("On, normal mode.");
    await expect(mode("Normal")).toBeChecked();
    await expect(unit.getByRole("status")).toHaveCount(0);
    /* Each step waited for the one before: the mode, then the target up one of the unit's own steps and back. */
    expect((await calls(page)).map((c) => [c.service, c.data.mode ?? c.data.humidity])).toEqual([["set_mode", "boost"], ["set_humidity", 60], ["set_humidity", 55]]);
    await expect(unit.locator(".dial")).toContainText("Target55%");

    /* A unit that takes the target changes and stays as it was is never shown as having reached the mode. */
    await page.evaluate(`delete fakeHA.knobs.targetModes["humidifier.garden_dehumidifier"]`);
    await unit.getByText("Boost", { exact: true }).click();
    await expect(unit).toContainText("On, boost mode.");
    await unit.getByText("Normal", { exact: true }).click();
    await expect(unit.getByRole("status")).toHaveText("Not confirmed. Garden Dehumidifier still reports on, boost mode. Moving its target didn't put it in normal mode.", { timeout: 20_000 });
    await expect(mode("Boost")).toBeChecked();
    await expect(mode("Normal")).not.toBeChecked();
  });

  test("modes unticked in Device identification are left off the device's row, except the one it's in", async ({ page }) => {
    test.setTimeout(60_000);
    const frame = await openZone(page);
    const dehu = row(frame, "Dehumidifier");
    await expect(dehu.getByRole("radio")).toHaveCount(4);
    await dehu.getByRole("button", { name: "Add Normal as a mode ›" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: /Device identification/ })).toBeVisible();
    /* Every mode Home Assistant lists and the extra one, each ticked until it's left out. */
    const offered = app(frame).locator("#modes-md-humidifier_garden_dehumidifier"), tick = (mode: string) => offered.getByRole("checkbox", { name: mode, exact: true });
    /* By name, both here and on the row, whatever order the device lists them in. */
    await expect(offered.locator(".chip")).toHaveText(["Boost", "Comfort", "Eco", "Normal", "Sleep"]);
    for (const box of await offered.getByRole("checkbox").all()) await expect(box).toBeChecked();
    await tick("Sleep").uncheck();
    await tick("Comfort").uncheck();
    await tick("Eco").uncheck();
    await tick("Eco").check();
    /* Plug 7 and the sensors Home Assistant no longer lists would hold the review, as in the test above. */
    await app(frame).locator("#md-switch_plug_7").getByRole("button").first().click();
    await app(frame).locator(".steps").getByRole("button", { name: "1. Sensors", exact: true }).click();
    for (const id of ["g-left", "g-right", "g-under"]) await app(frame).locator(`#ms-${id}`).getByRole("button").first().click();
    await app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: "Environment board" }) }).getByRole("button").first().click();
    const next = app(frame).getByRole("button", { name: /^(Next|Review and apply)$/ });
    await next.click();
    await expect(tick("Sleep")).not.toBeChecked();
    await expect(tick("Eco")).toBeChecked();
    await next.click();
    await next.click();
    await expect(app(frame).getByRole("dialog")).toContainText("modes left out of ControlsNone → comfort, sleep");
    await app(frame).getByRole("dialog").getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(controls(frame)).toBeVisible();
    const unit = row(frame, "Garden Dehumidifier");
    await expect(unit.locator(".chip")).toHaveText(["Boost", "Eco", "Normal"]);
    await expect(unit.getByRole("radio", { name: "Normal", exact: true })).toBeChecked();
    /* Leaving a mode out sends nothing to the device, and the device keeps it: put in sleep mode from elsewhere, the row
       shows sleep, and drops it again once the device moves on. */
    expect(await serviceCalls(page)).toBe(0);
    await page.evaluate(`fakeHA.setState("humidifier.garden_dehumidifier", "on", { mode: "sleep" })`);
    await expect(unit.locator(".chip")).toHaveText(["Boost", "Eco", "Normal", "Sleep"]);
    await expect(unit.getByRole("radio", { name: "Sleep", exact: true })).toBeChecked();
    await unit.getByText("Eco", { exact: true }).click();
    await expect(unit).toContainText("On, eco mode.");
    await expect(unit.locator(".chip")).toHaveText(["Boost", "Eco", "Normal"]);
    /* Only the names are stored, with the device. */
    const kept = await page.evaluate<{ entity: string; hiddenModes?: string[] }[]>("JSON.parse(JSON.stringify(fakeHA.config.devices))");
    expect(kept.filter((d) => d.hiddenModes).map((d) => [d.entity, d.hiddenModes])).toEqual([["humidifier.garden_dehumidifier", ["comfort", "sleep"]]]);
  });

  test("a device that goes offline disables its controls and keeps no dial for it", async ({ page }) => {
    const frame = await openZone(page);
    await page.evaluate("fakeHA.offline('humidifier.garden_dehumidifier', true)");
    await expect(row(frame, "Dehumidifier")).toContainText("Unavailable");
    await expect(sw(frame, "Dehumidifier")).toBeDisabled();
    await expect(controls(frame).getByLabel("Dehumidifier target humidity", { exact: true })).toHaveCount(0);
  });

  test("the host sends to the device the setup maps, whatever entity the frame names", async ({ page }) => {
    const frame = await openZone(page);
    expect((await device(frame, { id: "heater", action: "turn_on", entity_id: "switch.reservoir_pump" })).ok).toBe(true);
    expect((await calls(page)).map((c) => c.data.entity_id)).toEqual(["switch.heater_mains"]);
  });

  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a device in no zone", { id: "spare-plug", action: "turn_on" }, "isn't mapped to a zone"],
    ["a device the setup doesn't have", { id: "nobody", action: "turn_on" }, "isn't mapped to a zone"],
    ["a device whose role isn't said", { id: "plug", action: "turn_on" }, "Say what that device is"],
    ["an action the panel doesn't know", { id: "heater", action: "toggle" }, "Not a device or action"],
    ["brightness on a plug", { id: "heater", action: "brightness", value: 50 }, "isn't something this device takes"],
    ["brightness past 100", { id: "lc-over", action: "brightness", value: 101 }, "isn't something this device takes"],
    ["brightness that isn't a whole percent", { id: "lc-over", action: "brightness", value: 40.5 }, "isn't something this device takes"],
    ["a mode not in the device's list", { id: "dehu", action: "mode", value: "normal" }, "isn't something this device takes"],
    ["a target past the device's limits", { id: "dehu", action: "humidity", value: 90 }, "isn't something this device takes"],
    ["an unavailable device", { id: "acfan", action: "turn_on" }, "unavailable"],
  ];
  for (const [what, body, why] of REFUSED) {
    test(`the host refuses ${what}`, async ({ page }) => {
      const frame = await openZone(page);
      const r = await device(frame, body);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(why);
      expect(await serviceCalls(page)).toBe(0);
    });
  }
});
