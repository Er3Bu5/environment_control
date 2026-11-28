/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, leaveAsks, panelFrame, serviceCalls } from "./helpers";

test.describe("the calibration write", () => {
  const LEFT = "number.environment_left_leaf_temperature_offset";
  /* The frame's message, sent raw: the host answers it the same whether the panel's own screen sent it or not. */
  const calibrate = (frame: Frame, body: Record<string, unknown>) =>
    frame.evaluate(
      (b) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const req = 9000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
          parent.postMessage({ v: 1, type: "calibrate", req, ...b }, "*");
        }),
      body,
    );
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");

  test("sets the offset on the number the sensor is linked to, and the value counts once the board reports it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await calibrate(frame, { sensor: "g-left", value: -1.5 })).toEqual(expect.objectContaining({ ok: true }));
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "number", service: "set_value", data: { entity_id: LEFT, value: -1.5 } })]);
    await expect.poll(() => page.evaluate<string>(`fakeHA.states[${JSON.stringify(LEFT)}].state`)).toBe("-1.5");
  });

  test("ignores an entity named by the frame: the write goes to the sensor's own link", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await calibrate(frame, { sensor: "g-left", value: -1, entity_id: "number.environment_right_leaf_temperature_offset" })).ok).toBe(true);
    expect((await calls(page)).map((c) => c.data.entity_id)).toEqual([LEFT]);
  });

  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a value past the board's limits", { sensor: "g-left", value: 2.5 }, "between -5 and 2"],
    ["a value off the board's step", { sensor: "g-left", value: -1.05 }, "in steps of 0.1"],
    ["a value that isn't a number", { sensor: "g-left", value: "-1" }, "Not a sensor or value"],
    ["a sensor the setup doesn't have", { sensor: "nobody", value: -1 }, "no leaf temperature offset"],
    ["a sensor whose offset is kept in Environment Control", { sensor: "g-under", value: -1 }, "no leaf temperature offset"],
  ];
  for (const [what, body, why] of REFUSED) {
    test(`refuses ${what}`, async ({ page }) => {
      await page.goto(PAGE);
      const frame = await panelFrame(page);
      const r = await calibrate(frame, body);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(why);
      expect(await serviceCalls(page)).toBe(0);
    });
  }

  test("refuses a link HA doesn't list on the sensor's own device, one not in °C, and an offline board", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const set = (js: string) => page.evaluate(`(() => { ${js}; fakeHA.publish(); })()`);
    await set(`fakeHA.registry.entities[${JSON.stringify(LEFT)}].device_id = "g-right"`);
    expect((await calibrate(frame, { sensor: "g-left", value: -1 })).error).toContain("on that sensor's own device");
    await set(`fakeHA.registry.entities[${JSON.stringify(LEFT)}].device_id = "g-left"; fakeHA.states[${JSON.stringify(LEFT)}].attributes.unit_of_measurement = "%"`);
    expect((await calibrate(frame, { sensor: "g-left", value: -1 })).error).toContain("isn't in °C");
    await set(`fakeHA.states[${JSON.stringify(LEFT)}].attributes.unit_of_measurement = "℃"; fakeHA.states[${JSON.stringify(LEFT)}].state = "unavailable"`);
    expect((await calibrate(frame, { sensor: "g-left", value: -1 })).error).toContain("offline");
    expect(await serviceCalls(page)).toBe(0);
    /* HA writes Celsius both ways, so the other sign is a °C setting too. */
    await set(`fakeHA.states[${JSON.stringify(LEFT)}].state = "-1.0"`);
    expect((await calibrate(frame, { sensor: "g-left", value: -1.2 })).ok).toBe(true);
  });
});

test.describe("sensor calibration", () => {
  const LEFT = "number.environment_left_leaf_temperature_offset";
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const box = (frame: Frame, name: string) => app(frame).getByLabel(`${name} degrees from air`);
  const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
  const row = (frame: Frame, name: string) => app(frame).locator(".lrow", { has: frame.locator("strong", { hasText: name }) });
  const stored = (page: Page) => page.evaluate<{ revision: number; zones: Record<string, unknown>[] }>("JSON.parse(fakeHA.disk)");
  const sets = (page: Page) => page.evaluate<{ data: { entity_id: string; value: number } }[]>("fakeHA.calls.filter((c) => c.service === 'set_value')");
  async function openGarden(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Sensor Calibration" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    return frame;
  }
  const type = async (frame: Frame, name: string, value: string) => {
    await box(frame, name).fill(value);
    await box(frame, name).press("Enter");
  };

  test("shows each offset where it's held, and nothing is sent until applied, then only once the board reports it is it saved", async ({ page }) => {
    const frame = await openGarden(page);
    await expect(box(frame, "Environment left")).toHaveValue("1.0");
    await expect(row(frame, "Environment left").getByRole("button", { name: "Below air" })).toHaveAttribute("aria-pressed", "true");
    await expect(row(frame, "Environment under")).toContainText("kept in Environment Control");
    await type(frame, "Environment left", "1.5");
    await expect(bar(frame)).toContainText("Garden · Environment left: leaf temperature offset");
    expect(await serviceCalls(page)).toBe(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("1.0 °C below air → 1.5 °C below air, on the board");
    expect(await serviceCalls(page)).toBe(0);
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame).getByRole("button", { name: "Applying and verifying..." })).toBeDisabled();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => c.data)).toEqual([{ entity_id: LEFT, value: -1.5 }]);
    await expect(app(frame).locator(".toast")).toHaveText("Leaf temperature offsets saved on the boards.");
    await expect(box(frame, "Environment left")).toHaveValue("1.5");
    await expect(bar(frame)).toHaveCount(0);
  });

  test("on a touch screen the draft bar is out of the way only while a box is typed in, whatever is tapped next", async ({ page }) => {
    const frame = await openGarden(page);
    test.skip(!(await frame.evaluate(() => matchMedia("(pointer: coarse)").matches)), "a mouse and keyboard keep the bar");
    await type(frame, "Environment left", "1.5");
    await expect(bar(frame)).toBeVisible();
    /* From a button in the panel straight to a box, and from the box straight to a button: focus never leaves the panel. */
    const above = row(frame, "Environment left").getByRole("button", { name: "Above air" });
    await above.click();
    await expect(bar(frame)).toBeVisible();
    await box(frame, "Environment left").click();
    await expect(app(frame).locator(".draftbar")).toBeHidden();
    await above.click();
    await expect(bar(frame)).toBeVisible();
  });

  test("a zone made before setup steps were recorded stays judged after one of its steps is confirmed", async ({ page }) => {
    const frame = await openGarden(page);
    await type(frame, "Environment under", "1");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect(((await stored(page)).zones.find((z) => z.id === "garden") as { setup?: Record<string, string> }).setup).toEqual({ calibrate: "done" });
    await goTo(frame, "Garden");
    const tile = app(frame).locator(".tile", { has: frame.locator(".name", { hasText: /^Temperature$/ }) });
    await expect(tile).toContainText("Max");
    await expect(tile).not.toContainText("Targets not set up yet");
  });

  test("a board that doesn't report the new value is never shown as saved, and only what's left is offered again", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await openGarden(page);
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await type(frame, "Environment left", "2");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toContainText("Some changes were not applied.", { timeout: 15_000 });
    await expect(dialog(frame)).toContainText("Environment left: not confirmed. The board still reports 1.0 °C below air.");
    await expect(dialog(frame).getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
    await expect(row(frame, "Environment left").locator(".lstatus")).toHaveText("Not confirmed. The board still reports 1.0 °C below air.");
    /* Trying again sends it again, and this time the board takes it. */
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => c.data.value)).toEqual([-2, -2]);
  });

  test("a value past the board's limits stops the save, and its Fix goes to the box", async ({ page }) => {
    const frame = await openGarden(page);
    await type(frame, "Environment left", "6");
    await expect(bar(frame)).toContainText("Fix first: Environment left can be at most 5 °C below air.");
    await expect(bar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await type(frame, "Environment left", "+3");
    await expect(row(frame, "Environment left").getByRole("button", { name: "Above air" })).toHaveAttribute("aria-pressed", "true");
    await app(frame).getByRole("button", { name: /Environment left can be at most 2 °C above air/ }).click();
    await expect(box(frame, "Environment left")).toBeFocused();
    expect(await serviceCalls(page)).toBe(0);
  });

  test("an offline board can't be edited and says why", async ({ page }) => {
    await page.goto(PAGE);
    await page.evaluate(`fakeHA.offline(${JSON.stringify(LEFT)}, true)`);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Sensor Calibration" }).click();
    await expect(box(frame, "Environment left")).toBeDisabled();
    await expect(row(frame, "Environment left")).toContainText("This board is offline, so its offset can't change until it's back.");
  });

  test("an offset kept here and the chart's choice are saved in Environment Control, with nothing sent to a board", async ({ page }) => {
    const frame = await openGarden(page);
    await type(frame, "Environment under", "1");
    await app(frame).locator(".lbasis").getByLabel("Environment right").check();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("VPD chart uses");
    await dialog(frame).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const garden = (await stored(page)).zones.find((z) => z.id === "garden") as { leafBasis?: string; sensors: { id: string; leaf?: number }[] };
    expect(garden.leafBasis).toBe("g-right");
    expect(garden.sensors.find((x) => x.id === "g-under")?.leaf).toBe(-1);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("leaving with an offset typed asks first", async ({ page }) => {
    const frame = await openGarden(page);
    await type(frame, "Environment left", "1.5");
    await goTo(frame, "Overview");
    await expect(app(frame).getByRole("alertdialog")).toContainText("You have 1 unsaved change in Garden.");
    await app(frame).getByRole("button", { name: "Keep editing" }).click();
    await expect(box(frame, "Environment left")).toHaveValue("1.5");
    expect(await leaveAsks(page)).toBe(true);
  });

  test("the VPD tile's Change opens it, and Back returns to the zone", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    await app(frame).locator(".tile", { hasText: "VPD" }).getByRole("button", { name: "Change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true })).toBeVisible();
  });

  test("a new zone's board asks where its offset is held; linking it saves the link, and a new value then goes to that board", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Setup");
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByLabel("Zone name").press("Enter");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).locator("#g-calibrate")).toContainText("Needs sensors from Device identification");
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: "Environment board" }) }).getByRole("button").first().click();
    const next = app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });
    for (let i = 0; i < 3; i++) await next.click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await app(frame).locator("#g-calibrate").getByRole("button", { name: "Sensor Calibration" }).click();
    await expect(app(frame).getByRole("button", { name: "Say where Environment board's offset is held." })).toBeVisible();
    await expect(app(frame).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect(box(frame, "Environment board")).toBeDisabled();
    await app(frame).getByLabel("On the board, Leaf offset").check();
    await expect(box(frame, "Environment board")).toHaveValue("1.5");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Not said yet → On the board, Leaf offset");
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect(await serviceCalls(page)).toBe(0);
    const tent = (await stored(page)).zones.find((z) => z.name === "Flower tent") as { setup: Record<string, string>; sensors: { leafEntity?: string }[] };
    expect([tent.sensors[0].leafEntity, tent.setup.calibrate]).toEqual(["number.environment_board_leaf_offset", "done"]);
    await type(frame, "Environment board", "1");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => c.data)).toEqual([{ entity_id: "number.environment_board_leaf_offset", value: -1 }]);
  });
});
