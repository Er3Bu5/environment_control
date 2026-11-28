/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, hostButton, hostDialogOpen, hostDialogText, panelFrame, serviceCalls } from "./helpers";

test.describe("the automation switch", () => {
  type Answer = { ok: boolean; error?: string };
  type Link = { id: string; entity: string; group: string };
  type Stored = { revision: number; zones: { id: string; automations?: Link[] }[]; devices: unknown[]; room?: { alertRepeat?: string } };
  /* The frame's messages, sent raw: the host answers them the same whether the panel's own screen sent them or not. */
  const send = (frame: Frame, type: string, body: Record<string, unknown>) =>
    frame.evaluate(
      ([t, b]) =>
        new Promise<Answer>((resolve) => {
          const req = 7000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
          parent.postMessage({ v: 1, type: t, req, ...(b as Record<string, unknown>) }, "*");
        }),
      [type, body] as const,
    );
  const automation = (frame: Frame, body: Record<string, unknown>) => send(frame, "automation", body);
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
  const state = (page: Page, entity: string) => page.evaluate<string | undefined>(`(fakeHA.states[${JSON.stringify(entity)}] || {}).state`);
  /* A save of the stored setup with one change made to it, as the panel's own save sends it. */
  const save = (frame: Frame, config: Record<string, unknown>, base: number) => send(frame, "save", { base, config });
  const allow = async (page: Page) => {
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    /* Allow is off for a second after the dialog appears, so a stray tap can't land on it. */
    await page.waitForTimeout(1100);
    const button = await hostButton(page, "allow");
    await page.mouse.click(button!.x, button!.y);
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
  };
  /* Garden's first link in the sample room, an alert that's on. */
  const HIGH = "automation.critical_garden_temperature_high_day";
  const PORCH = "automation.porch_light_on";
  const REPEAT = "input_number.alert_repeat_rate";

  test("switches a zone's linked automation off and on again, and HA then reports it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await automation(frame, { zone: "garden", link: "a1", on: false })).toEqual(expect.objectContaining({ ok: true }));
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "automation", service: "turn_off", data: { entity_id: HIGH } })]);
    await expect.poll(() => state(page, HIGH)).toBe("off");
    expect((await automation(frame, { zone: "garden", link: "a1", on: true })).ok).toBe(true);
    expect((await calls(page)).map((c) => [c.service, c.data])).toEqual([["turn_off", { entity_id: HIGH }], ["turn_on", { entity_id: HIGH }]]);
    await expect.poll(() => state(page, HIGH)).toBe("on");
  });

  test("ignores an entity or a service named by the frame: the switch goes to the zone's own link", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await automation(frame, { zone: "garden", link: "a1", on: false, entity_id: PORCH, entity: PORCH, service: "trigger" })).ok).toBe(true);
    expect((await calls(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["automation", "turn_off", { entity_id: HIGH }]]);
    expect(await state(page, PORCH)).toBe("on");
  });

  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a link the zone doesn't have", { zone: "garden", link: "nope", on: false }, "doesn't link that automation"],
    ["another zone's link id", { zone: "nursery", link: "a23", on: false }, "doesn't link that automation"],
    ["a zone the setup doesn't have", { zone: "kitchen", link: "a1", on: false }, "doesn't link that automation"],
    ["no zone at all", { link: "a1", on: false }, "Not an automation"],
    ["on that isn't true or false", { zone: "garden", link: "a1", on: "off" }, "Not an automation"],
    ["a link id that's an entity", { zone: "garden", link: "automation.porch_light_on", on: false }, "Not an automation"],
  ];
  for (const [what, body, why] of REFUSED) {
    test(`refuses ${what}`, async ({ page }) => {
      await page.goto(PAGE);
      const frame = await panelFrame(page);
      const r = await automation(frame, body);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(why);
      expect(await serviceCalls(page)).toBe(0);
    });
  }

  test("refuses an automation that's unavailable, or that HA no longer has", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await page.evaluate(`fakeHA.offline(${JSON.stringify(HIGH)}, true)`);
    expect((await automation(frame, { zone: "garden", link: "a1", on: false })).error).toContain("unavailable");
    await page.evaluate(`(() => { delete fakeHA.states[${JSON.stringify(HIGH)}]; fakeHA.publish(); })()`);
    expect((await automation(frame, { zone: "garden", link: "a1", on: false })).error).toContain("has no");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("a linked automation's state and when it last ran reach the frame, and an unlinked one's never does", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    type Seen = { keys: string[]; got?: { state: string; attributes: Record<string, unknown> } };
    /* The listener goes in first and is waited for: the page and the frame are driven separately, so a state changed
       straight after asking for it could otherwise arrive before anything is listening. */
    await frame.evaluate((entity) => {
      const seen: Seen = { keys: [] };
      (window as unknown as { seen: Seen }).seen = seen;
      window.addEventListener("message", (e) => {
        if (e.data?.type !== "states") return;
        seen.keys.push(...Object.keys(e.data.states));
        if (e.data.states[entity]) seen.got = e.data.states[entity];
      });
    }, HIGH);
    await page.evaluate(`fakeHA.setState(${JSON.stringify(PORCH)}, "off", {})`);
    await page.evaluate(`fakeHA.setState(${JSON.stringify(HIGH)}, "off", { last_triggered: "2026-11-17T01:00:00+00:00", id: "1699", mode: "single" })`);
    const read = () => frame.evaluate(() => (window as unknown as { seen: Seen }).seen);
    await expect.poll(async () => !!(await read()).got).toBe(true);
    const { keys, got } = (await read()) as Required<Seen>;
    expect(got.state).toBe("off");
    /* Only allowlisted attributes: the name and when it last ran, never its id or how it runs. */
    expect(got.attributes).toEqual({ friendly_name: "Critical Garden Temperature High Day", last_triggered: "2026-11-17T01:00:00+00:00" });
    expect(keys).not.toContain(PORCH);
  });

  test("linking an automation waits for you in the host's own dialog, which names the real one; Escape saves nothing", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const zones = before.zones.map((z) => (z.id === "nursery" ? { ...z, automations: [...(z.automations ?? []), { id: "a99", entity: PORCH, group: "failsafe" }] } : z));
    const answer = save(frame, { zones, devices: before.devices }, before.revision);
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const text = await hostDialogText(page);
    expect(text).toContain("automation.porch_light_on");
    expect(text).toContain("Porch Light On.");
    expect(text).toContain("Can be switched on and off. While it's off, Home Assistant doesn't run it.");
    expect(text).toContain("Linked as a failsafe. Once allowed, the panel can switch it off.");
    expect(text).toContain("for the Nursery zone");
    expect(text).toContain("Allow 1 automation");
    await page.keyboard.press("Escape");
    expect(await answer).toEqual(expect.objectContaining({ ok: false, error: "Not allowed, so nothing was saved." }));
    expect((await stored(page)).revision).toBe(before.revision);
    expect((await automation(frame, { zone: "nursery", link: "a99", on: false })).error).toContain("doesn't link that automation");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("once you allow it, the link is stored and the automation can be switched", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const zones = before.zones.map((z) => (z.id === "nursery" ? { ...z, automations: [...(z.automations ?? []), { id: "a99", entity: PORCH, group: "control" }] } : z));
    const answer = save(frame, { zones, devices: before.devices }, before.revision);
    await allow(page);
    expect((await answer).ok).toBe(true);
    expect((await stored(page)).zones.find((z) => z.id === "nursery")?.automations).toContainEqual({ id: "a99", entity: PORCH, group: "control" });
    expect((await automation(frame, { zone: "nursery", link: "a99", on: false })).ok).toBe(true);
    await expect.poll(() => state(page, PORCH)).toBe("off");
  });

  test("changing only a group doesn't ask again", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, automations: (z.automations ?? []).map((a) => (a.id === "a1" ? { ...a, group: "alert_device" } : a)) } : z));
    expect((await save(frame, { zones, devices: before.devices }, before.revision)).ok).toBe(true);
    expect(await hostDialogOpen(page)).toBe(false);
    expect((await stored(page)).revision).toBe(before.revision + 1);
  });

  /* An automation belongs to one zone. The host still asks, as for any automation new to a zone, and the backend's
     refusal comes back as the answer. */
  const TENT_ON = "automation.tent_lights_on";
  test("linking one that another zone already links is refused, and nothing is stored", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    expect(before.zones.find((z) => z.id === "veg")?.automations?.some((a) => a.entity === TENT_ON)).toBe(true);
    const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, automations: [...(z.automations ?? []), { id: "a99", entity: TENT_ON, group: "control" }] } : z));
    const answer = save(frame, { zones, devices: before.devices }, before.revision);
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const text = await hostDialogText(page);
    expect(text).toContain(TENT_ON);
    expect(text).toContain("for the Garden zone");
    await allow(page);
    expect(await answer).toEqual(expect.objectContaining({ ok: false, error: "An automation can only be linked to one zone." }));
    expect(await stored(page)).toEqual(before);
    expect((await automation(frame, { zone: "garden", link: "a99", on: false })).error).toContain("doesn't link that automation");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("one automation linked in two zones in one save is refused, and nothing is stored", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const add = (group: string) => ({ id: "a99", entity: PORCH, group });
    const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, automations: [...(z.automations ?? []), add("control")] } : z.id === "nursery" ? { ...z, automations: [...(z.automations ?? []), add("failsafe")] } : z));
    const answer = save(frame, { zones, devices: before.devices }, before.revision);
    await allow(page);
    expect(await answer).toEqual(expect.objectContaining({ ok: false, error: "An automation can only be linked to one zone." }));
    expect(await stored(page)).toEqual(before);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("an automation moves zone in two saves: unlinked where it is, then linked, asked about, in the new one", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const tent = { id: "a99", entity: TENT_ON, group: "control" };
    const both = before.zones.map((z) => (z.id === "nursery" ? { ...z, automations: [...(z.automations ?? []), tent] } : z));
    const inOne = save(frame, { zones: both, devices: before.devices }, before.revision);
    await allow(page);
    expect((await inOne).error).toBe("An automation can only be linked to one zone.");
    const unlinked = before.zones.map((z) => (z.id === "veg" ? { ...z, automations: (z.automations ?? []).filter((a) => a.entity !== TENT_ON) } : z));
    expect((await save(frame, { zones: unlinked, devices: before.devices }, before.revision)).ok).toBe(true);
    expect(await hostDialogOpen(page)).toBe(false);
    const moved = unlinked.map((z) => (z.id === "nursery" ? { ...z, automations: [...(z.automations ?? []), tent] } : z));
    const answer = save(frame, { zones: moved, devices: before.devices }, before.revision + 1);
    await allow(page);
    expect((await answer).ok).toBe(true);
    const after = await stored(page);
    expect(after.zones.filter((z) => z.automations?.some((a) => a.entity === TENT_ON)).map((z) => z.id)).toEqual(["nursery"]);
    expect((await automation(frame, { zone: "nursery", link: "a99", on: true })).ok).toBe(true);
  });

  test("a link to anything but an automation is refused without asking", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    for (const entity of ["switch.reservoir_pump", "script.water_everything", "automation.Bad Id"]) {
      const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, automations: [...(z.automations ?? []), { id: "a99", entity, group: "control" }] } : z));
      const r = await save(frame, { zones, devices: before.devices }, before.revision);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("isn't an automation this panel can switch");
    }
    expect(await hostDialogOpen(page)).toBe(false);
    expect((await stored(page)).revision).toBe(before.revision);
  });

  test("the room's alert repeat rate is set on its linked helper, inside the helper's own limits", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await send(frame, "setting", { name: "alertRepeat", value: 30 })).ok).toBe(true);
    expect((await calls(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["input_number", "set_value", { entity_id: REPEAT, value: 30 }]]);
    await expect.poll(() => state(page, REPEAT)).toBe("30");
    expect((await send(frame, "setting", { name: "alertRepeat", value: 500 })).error).toContain("between 0 and 120");
    expect((await send(frame, "setting", { name: "alertRepeat", value: 2.5 })).error).toContain("in steps of 1");
    /* It belongs to the room, so it isn't a zone's setting. */
    expect((await send(frame, "setting", { zone: "garden", name: "alertRepeat", value: 5 })).error).toContain("Not a setting");
    expect((await calls(page)).length).toBe(1);
  });

  test("a save that sends no room settings keeps the ones stored", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    expect(before.room).toEqual({ alertRepeat: REPEAT });
    const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, description: "Flowering tent" } : z));
    expect((await save(frame, { zones, devices: before.devices }, before.revision)).ok).toBe(true);
    const after = await stored(page);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.room).toEqual({ alertRepeat: REPEAT });
    expect((await send(frame, "setting", { name: "alertRepeat", value: 20 })).ok).toBe(true);
  });

  test("linking another helper for the room asks first, and unlinking never does", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const other = "input_number.spare_vpd_threshold";
    const answer = save(frame, { zones: before.zones, devices: before.devices, room: { alertRepeat: other } }, before.revision);
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    const text = await hostDialogText(page);
    expect(text).toContain(other);
    expect(text).toContain("Every alert's repeat rate comes from it.");
    await page.keyboard.press("Escape");
    expect((await answer).ok).toBe(false);
    expect((await stored(page)).room).toEqual({ alertRepeat: REPEAT });
    expect((await save(frame, { zones: before.zones, devices: before.devices, room: {} }, before.revision)).ok).toBe(true);
    expect(await hostDialogOpen(page)).toBe(false);
    expect((await stored(page)).room).toEqual({});
    expect((await send(frame, "setting", { name: "alertRepeat", value: 20 })).error).toContain("isn't linked to a helper");
    /* Anything but a number helper is refused outright. */
    const now = await stored(page);
    const bad = await save(frame, { zones: now.zones, devices: now.devices, room: { alertRepeat: "switch.reservoir_pump" } }, now.revision);
    expect(bad.error).toContain("can only link to a number helper");
    expect(await hostDialogOpen(page)).toBe(false);
  });
});
