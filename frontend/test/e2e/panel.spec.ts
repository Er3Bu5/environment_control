/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";

const PAGE = "/frontend/test/e2e/page.html";

async function panelFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().length).toBeGreaterThan(1);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("no frame");
  await frame.waitForSelector("ec-app");
  return frame;
}
const frameText = (frame: Frame) => frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.textContent ?? "");
const app = (frame: Frame) => frame.locator("ec-app");
const tab = (frame: Frame, name: string) => app(frame).getByRole("navigation").getByRole("button", { name, exact: true });
const leaveAsks = (page: Page) =>
  page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
/* The host's reload bar, also in its closed shadow root: its button's centre on the page, or null when there's no bar. */
async function updatedBarButton(page: Page): Promise<{ x: number; y: number } | null> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let button: number | null = null;
  const walk = (n: { nodeId: number; nodeName: string; attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[] }, inBar: boolean) => {
    const attrs = n.attributes || [], bar = inBar || (n.nodeName === "DIV" && attrs[attrs.indexOf("class") + 1] === "updated" && attrs.includes("class"));
    if (bar && n.nodeName === "BUTTON") button = n.nodeId;
    if (n.nodeName === "IFRAME") return;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c as typeof n, bar);
  };
  walk(root as Parameters<typeof walk>[0], false);
  if (button === null) { await cdp.detach(); return null; }
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId: button });
  await cdp.detach();
  const q = model.content;
  return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
}
/* The page declares these with let and const, so they are globals but not window properties: read them as expressions. */
const route = (page: Page) => page.evaluate<string>("haRoute");
const serviceCalls = (page: Page) => page.evaluate<number>("fakeHA.calls.length");
/* The host's dialog lives in its closed shadow root, out of the page's reach. DevTools can still see it. */
async function hostDialogOpen(page: Page): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let open = false;
  const walk = (n: { nodeName: string; attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[] }) => {
    if (n.nodeName === "DIALOG" && (n.attributes || []).includes("open")) open = true;
    if (n.nodeName === "IFRAME") return;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c as typeof n);
  };
  walk(root as Parameters<typeof walk>[0]);
  await cdp.detach();
  return open;
}

test.describe("sandbox", () => {
  test("the frame sits in a closed shadow root with allow-scripts and nothing else", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    const seen = await page.evaluate(() => ({
      shadow: document.querySelector("environment-control-panel")?.shadowRoot === null,
      frames: document.querySelectorAll("iframe").length,
    }));
    expect(seen).toEqual({ shadow: true, frames: 0 });
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const sandboxes: string[] = [];
    const walk = (n: { nodeName: string; attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[] }) => {
      const a = n.attributes || [];
      if (n.nodeName === "IFRAME") sandboxes.push(a[a.indexOf("sandbox") + 1]);
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c as typeof n);
    };
    walk(root as Parameters<typeof walk>[0]);
    expect(sandboxes).toEqual(["allow-scripts"]);
  });

  test("the frame can't reach HA's page, storage, cookies or the network, and an injected script doesn't run", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const escaped = await frame.evaluate(async () => {
      const r: Record<string, string> = { origin: self.origin };
      try { void parent.document.title; r.parent = "read"; } catch { r.parent = "blocked"; }
      try { void localStorage.length; r.storage = "read"; } catch { r.storage = "blocked"; }
      try { void document.cookie; r.cookie = "read"; } catch { r.cookie = "blocked"; }
      try { await fetch("http://127.0.0.1:4173/frontend/test/e2e/page.html"); r.fetch = "sent"; } catch { r.fetch = "blocked"; }
      r.socket = await new Promise<string>((done) => {
        try {
          const ws = new WebSocket("ws://127.0.0.1:4173/");
          ws.onopen = () => done("open");
          ws.onerror = () => done("blocked");
          setTimeout(() => done("blocked"), 1500);
        } catch { done("blocked"); }
      });
      const s = document.createElement("script");
      s.textContent = "window.__injected = 1";
      document.head.append(s);
      await new Promise((ok) => setTimeout(ok, 50));
      r.script = (window as unknown as { __injected?: number }).__injected ? "ran" : "blocked";
      return r;
    });
    expect(escaped).toEqual({ origin: "null", parent: "blocked", storage: "blocked", cookie: "blocked", fetch: "blocked", socket: "blocked", script: "blocked" });
  });

  test("only admins get the panel", async ({ page }) => {
    await page.goto(`${PAGE}?user=guest`);
    await expect.poll(() => page.evaluate(() => document.querySelector("environment-control-panel")?.isConnected)).toBe(true);
    await page.waitForTimeout(300);
    expect(page.frames().length).toBe(1);
  });
});

test.describe("layout", () => {
  test("the frame fills the window, less the safe areas, inside a container with no height as HA mounts it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const windowHeight = await page.evaluate(() => window.innerHeight);
    /* The page sets the top and bottom safe areas to 10px and 20px. */
    expect(await frame.evaluate(() => window.innerHeight)).toBe(windowHeight - 30);
  });
});

test.describe("talking to HA", () => {
  test("the frame shows what HA has stored: a tab and a card per zone, and the release on Setup", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    for (const name of ["Garden", "Veg", "Nursery"]) await expect(tab(frame, name)).toBeVisible();
    await expect(app(frame).locator(".zone-card")).toHaveCount(3);
    await tab(frame, "Setup").click();
    await expect.poll(() => frameText(frame)).toContain("Installed, version 0.0.0.");
  });

  test("a zone's tab opens its page, and Overview's card does too", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Veg").click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Veg", exact: true })).toBeVisible();
    await expect(tab(frame, "Veg")).toHaveAttribute("aria-current", "page");
    await tab(frame, "Overview").click();
    await app(frame).locator(".zone-card", { hasText: "Nursery" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Nursery", exact: true })).toBeVisible();
  });

  test("after HA restarts, the panel reads what's stored again", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(tab(frame, "Nursery")).toBeVisible();
    await page.evaluate(`(() => {
      fakeHA.knobs.restartMs = 100;
      const next = JSON.parse(fakeHA.disk);
      next.zones = next.zones.slice(0, 1);
      fakeHA.disk = JSON.stringify(next);
      fakeHA.restart();
    })()`);
    await expect(tab(frame, "Nursery")).toHaveCount(0);
    await expect(app(frame).locator(".zone-card")).toHaveCount(1);
  });

  test("a message the host doesn't know, or from anywhere but the frame, is dropped, and nothing is ever sent to HA", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await frame.evaluate(() => {
      for (const m of [
        { v: 1, type: "switch", entity_id: "switch.heater_mains", action: "turn_on", req: 1 },
        { v: 1, type: "calibrate", sensor: "s1", value: 0, req: 2 },
        { v: 1, type: "setting", zone: "nursery", name: "bands.day.temperature.min", value: 20, req: 3 },
        { v: 1, type: "save", base: 0, config: { zones: [], devices: [] }, req: 4 },
        { v: 1, type: "callService", domain: "switch", service: "turn_on" },
      ]) parent.postMessage(m, "*");
    });
    await page.evaluate(() => window.postMessage({ v: 1, type: "draft", open: true }, "*"));
    await page.waitForTimeout(200);
    expect(await serviceCalls(page)).toBe(0);
    expect(await page.evaluate<number>("fakeHA.saves.length")).toBe(0);
    expect(await leaveAsks(page)).toBe(false);
  });
});

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
    await tab(frame, "Setup").click();
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

  test("a zone made before setup steps were recorded stays judged after one of its steps is confirmed", async ({ page }) => {
    const frame = await openGarden(page);
    await type(frame, "Environment under", "1");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect(((await stored(page)).zones.find((z) => z.id === "garden") as { setup?: Record<string, string> }).setup).toEqual({ calibrate: "done" });
    await tab(frame, "Garden").click();
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
    await tab(frame, "Setup").click();
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
    await tab(frame, "Overview").click();
    await expect(app(frame).getByRole("alertdialog")).toContainText("You have 1 unsaved change in Garden.");
    await app(frame).getByRole("button", { name: "Keep editing" }).click();
    await expect(box(frame, "Environment left")).toHaveValue("1.5");
    expect(await leaveAsks(page)).toBe(true);
  });

  test("the VPD tile's Change opens it, and Back returns to the zone", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Garden").click();
    await app(frame).locator(".tile", { hasText: "VPD" }).getByRole("button", { name: "Change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true })).toBeVisible();
  });

  test("a new zone's board asks where its offset is held; linking it saves the link, and a new value then goes to that board", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
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

test.describe("the setting write", () => {
  /* The frame's message, sent raw: the host answers it the same whether the panel's own screen sent it or not. */
  const setting = (frame: Frame, body: Record<string, unknown>) =>
    frame.evaluate(
      (b) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const req = 8000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
          parent.postMessage({ v: 1, type: "setting", req, ...b }, "*");
        }),
      body,
    );
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  const MIN = "input_number.garden_day_temperature_min_threshold";

  test("sets a zone's linked number helper inside its own limits, and HA then reports the value", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22.5 })).toEqual(expect.objectContaining({ ok: true }));
    expect(await calls(page)).toEqual([expect.objectContaining({ domain: "input_number", service: "set_value", data: { entity_id: MIN, value: 22.5 } })]);
    await expect.poll(() => page.evaluate<string>(`fakeHA.states[${JSON.stringify(MIN)}].state`)).toBe("22.5");
  });

  test("sets lights on as a time on the zone's time helper", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await setting(frame, { zone: "garden", name: "day", value: "07:30" })).ok).toBe(true);
    expect((await calls(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["input_datetime", "set_datetime", { entity_id: "input_datetime.garden_day_time", time: "07:30:00" }]]);
  });

  test("ignores an entity named by the frame: the write goes to the zone's own link", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect((await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22, entity_id: "input_number.veg_day_temperature_min_threshold" })).ok).toBe(true);
    expect((await calls(page)).map((c) => c.data.entity_id)).toEqual([MIN]);
  });

  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a setting the panel doesn't know", { zone: "garden", name: "bands.day.co2.min", value: 1 }, "Not a setting"],
    ["a zone the setup doesn't have", { zone: "kitchen", name: "day", value: "07:00" }, "isn't linked to a helper"],
    ["a limit the zone keeps in Environment Control", { zone: "nursery", name: "bands.day.temperature.min", value: 20 }, "isn't linked to a helper"],
    ["a value past the helper's limits", { zone: "garden", name: "bands.day.temperature.min", value: 80 }, "between -20 and 50"],
    ["a value off the helper's step", { zone: "garden", name: "bands.day.temperature.min", value: 22.55 }, "in steps of 0.1"],
    ["a number for a time", { zone: "garden", name: "day", value: 7 }, "isn't a time"],
    ["a time that isn't one", { zone: "garden", name: "night", value: "25:00" }, "isn't a time"],
    ["text for a number", { zone: "garden", name: "light.dayMin", value: "2000" }, "isn't a number"],
  ];
  for (const [what, body, why] of REFUSED) {
    test(`refuses ${what}`, async ({ page }) => {
      await page.goto(PAGE);
      const frame = await panelFrame(page);
      const r = await setting(frame, body);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(why);
      expect(await serviceCalls(page)).toBe(0);
    });
  }

  test("refuses a time helper that holds a date too, and a helper HA has gone without", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await page.evaluate(`(() => { fakeHA.states["input_datetime.garden_day_time"].attributes.has_date = true; fakeHA.publish(); })()`);
    expect((await setting(frame, { zone: "garden", name: "day", value: "07:00" })).error).toContain("holds a date");
    await page.evaluate(`fakeHA.offline(${JSON.stringify(MIN)}, true)`);
    expect((await setting(frame, { zone: "garden", name: "bands.day.temperature.min", value: 22 })).error).toContain("has no");
    expect(await serviceCalls(page)).toBe(0);
  });
});

test.describe("targets, day and night", () => {
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const bar = (frame: Frame) => app(frame).getByRole("region", { name: "Unsaved changes" });
  const stored = (page: Page) => page.evaluate<{ zones: Record<string, unknown>[] }>("JSON.parse(fakeHA.disk)");
  const sets = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  async function open(page: Page, zone: string): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
    await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: `Targets, day and night: ${zone}`, exact: true })).toBeVisible();
    return frame;
  }
  const time = (frame: Frame, label: string, value: string) => app(frame).getByLabel(label, { exact: true }).fill(value);
  const source = (frame: Frame, group: string, name: string) => app(frame).getByRole("group", { name: group }).getByRole("button", { name, exact: true }).click();

  test("a time on a helper is sent only on apply, and counts once HA reports it, and the zone then runs by it", async ({ page }) => {
    const frame = await open(page, "Garden");
    await expect(app(frame).getByLabel("Lights on", { exact: true })).toHaveValue("07:00");
    await time(frame, "Lights on", "06:30");
    await expect(bar(frame)).toContainText("Garden · Lights on");
    expect(await serviceCalls(page)).toBe(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("07:00 → 06:30, on your helper");
    await expect(dialog(frame)).toContainText("Light goes from 12h 00m to 12h 30m a day.");
    expect(await serviceCalls(page)).toBe(0);
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => [c.domain, c.service, c.data])).toEqual([["input_datetime", "set_datetime", { entity_id: "input_datetime.garden_day_time", time: "06:30:00" }]]);
    await expect(app(frame).locator(".toast")).toHaveText("Garden saved, on your helpers too.");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await tab(frame, "Garden").click();
    await expect(app(frame).locator(".period").first()).toContainText("06:30 - 19:00");
  });

  test("a helper that doesn't report the new value is never shown as saved", async ({ page }) => {
    test.setTimeout(45_000);
    const frame = await open(page, "Garden");
    await page.evaluate("fakeHA.knobs.dropNext = true");
    await app(frame).getByLabel("Daylight time (min)").fill("15");
    await app(frame).getByLabel("Daylight time (min)").press("Enter");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(dialog(frame)).toContainText("Daylight time: not confirmed. Home Assistant still reports 10.", { timeout: 15_000 });
    await expect(dialog(frame).getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
  });

  test("set here keeps the times in Environment Control and drops the helper links, sending nothing", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Set here");
    await time(frame, "Lights on", "08:00");
    await time(frame, "Lights off", "20:00");
    await source(frame, "Red lights source", "Not used");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("From a helper → Set here");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = (await stored(page)).zones.find((x) => x.id === "garden") as Record<string, unknown>;
    expect([z.periodMode, z.dayAt, z.nightAt, z.emersonMode, "emerson" in z]).toEqual(["fixed", 480, 1200, "none", false]);
    expect(Object.keys(z.helpers as object)).not.toContain("day");
    expect(Object.keys(z.helpers as object)).not.toContain("morning");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("detected follows the zone's switches, and says so when none of them is reporting", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Detected");
    await app(frame).getByLabel("Search Home Assistant").first().fill("tent");
    await app(frame).locator(".follow", { hasText: "light.tent_light" }).locator("input").check();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = (await stored(page)).zones.find((x) => x.id === "garden") as Record<string, unknown>;
    expect([z.periodMode, z.lights]).toEqual(["detected", ["light.tent_light"]]);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await tab(frame, "Garden").click();
    await expect(app(frame).locator(".period").first()).toContainText("Lights not reporting");
    await page.evaluate(`(() => { fakeHA.states["light.tent_light"] = { entity_id: "light.tent_light", state: "on", attributes: {}, context: {} }; fakeHA.publish(); })()`);
    await expect(app(frame).locator(".period").first()).toContainText("Lights on");
    await expect(app(frame).locator(".period").first()).toContainText("Following its light switches");
  });

  test("problems stop the review, each with its fix", async ({ page }) => {
    const frame = await open(page, "Garden");
    await source(frame, "Day and night source", "Set here");
    await time(frame, "Lights on", "19:00");
    await expect(bar(frame)).toContainText("Fix first: Lights on and lights off need two different times.");
    await expect(bar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await source(frame, "Red lights source", "Set here");
    await app(frame).getByLabel("Evening extension (min)").fill("75");
    await app(frame).getByLabel("Evening extension (min)").press("Enter");
    await app(frame).getByRole("button", { name: /Evening extension has to be between 0 and 59 minutes/ }).click();
    await expect(app(frame).getByLabel("Evening extension (min)")).toBeFocused();
  });

  test("a helper never linked before waits for you in the host's own dialog", async ({ page }) => {
    const frame = await open(page, "Garden");
    await app(frame).locator("#sh-on-q").fill("reservoir");
    await app(frame).locator("#sh-on").getByRole("option", { name: /^Reservoir refill time/ }).click();
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Home Assistant asks you to allow each helper this panel hasn't linked before.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("zones sharing lights helpers are named, since changing one moves the other", async ({ page }) => {
    const frame = await open(page, "Veg");
    await expect(app(frame).locator("#s-times")).toContainText("Nursery uses the same helpers, so it moves too.");
    await time(frame, "Lights on", "15:30");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Nursery uses the same helpers, so it moves too.");
  });

  /* Limits. The period on show follows the clock, so each test picks its own. */
  const card = (frame: Frame) => app(frame).locator("#td-targets");
  const pick = (frame: Frame, group: string, name: string) => card(frame).getByRole("group", { name: group }).getByRole("button", { name, exact: true }).click();
  const box = (frame: Frame, label: string) => card(frame).getByLabel(label, { exact: true });
  const type = async (frame: Frame, label: string, value: string) => {
    await box(frame, label).fill(value);
    await box(frame, label).press("Enter");
  };
  const zoneOf = async (page: Page, id: string) => (await stored(page)).zones.find((x) => x.id === id || x.name === id) as Record<string, any>;
  const dayRow = (frame: Frame, reading: string) => app(frame).locator(".tbl-wrap table", { has: frame.locator("th", { hasText: /^Day$/ }) }).locator("tr", { hasText: reading }).locator("td");

  test("a limit on a helper is sent only on apply and counts once HA reports it; Low is stored here; the zone is judged by both", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Temperature Max")).toHaveValue("28");
    await type(frame, "Temperature Max", "29");
    await type(frame, "Temperature Low", "24.5");
    await type(frame, "Light Min", "2500");
    await expect(bar(frame)).toContainText("3 unsaved changes");
    expect(await serviceCalls(page)).toBe(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Day Temperature Max, on your helper");
    await expect(dialog(frame)).toContainText("28° → 29°");
    await expect(dialog(frame)).toContainText("2,000 lx → 2,500 lx");
    await expect(dialog(frame)).toContainText("anything reading them, like your alerts, follows straight away");
    await dialog(frame).getByRole("button", { name: "Apply 3 changes" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    expect((await sets(page)).map((c) => [c.service, c.data.entity_id, c.data.value])).toEqual([
      ["set_value", "input_number.garden_day_temperature_max_threshold", 29],
      ["set_value", "input_number.day_lights_garden_min_threshold", 2500],
    ]);
    expect((await zoneOf(page, "garden")).bands.day.temperature[1]).toBe(24.5);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await tab(frame, "Garden").click();
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24.5", "25", "27", "29"]);
    await expect(dayRow(frame, "Light")).toHaveText([/^Light/, "2,500", "", "", "", ""]);
  });

  test("the zone's table reads a helper live, so it shows what your alerts read", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Garden").click();
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24", "25", "27", "28"]);
    await page.evaluate(`fakeHA.setState("input_number.garden_day_temperature_min_threshold", "22.5")`);
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "22.5", "24", "25", "27", "28"]);
    await app(frame).getByRole("button", { name: "Set targets" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
  });

  test("an Athena stage fills the period on show, all stored here with nothing sent", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await pick(frame, "Athena stage", "Flower bulk");
    await expect(box(frame, "Temperature Low")).toHaveValue("23.8");
    await expect(box(frame, "VPD Max")).toHaveValue("1.35");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = await zoneOf(page, "nursery");
    expect(z.bands.day).toEqual({ temperature: [21.8, 23.8, 25.2, 26.6, 28.6], humidity: [55, 60, 65, 70, 75], vpd: [0.85, 1, 1.1, 1.2, 1.35] });
    expect(z.bands.night.temperature).toEqual([18, 19, 21, 23, 25]);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("no target: the boxes show none, the target helpers are unlinked, and nothing is written to them", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await pick(frame, "Target", "No target");
    await expect(card(frame).getByRole("img", { name: "Temperature Target, none" })).toBeVisible();
    await expect(card(frame).getByRole("group", { name: "What to edit" }).getByRole("button", { name: "Target" })).toHaveCount(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("25° → None");
    await dialog(frame).getByRole("button", { name: "Apply 6 changes" }).click();
    await expect(dialog(frame)).toHaveCount(0);
    const z = await zoneOf(page, "garden");
    expect(z.bands.day.temperature[2]).toBeNull();
    expect(z.helpers.bands.day.temperature).toEqual({ min: "input_number.garden_day_temperature_min_threshold", max: "input_number.garden_day_temperature_max_threshold" });
    expect(await serviceCalls(page)).toBe(0);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await tab(frame, "Garden").click();
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "23", "24", "-", "27", "28"]);
  });

  test("a value out of order stops the review, its Fix goes to the box, and the other period's problem is reachable", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Min", "30");
    await expect(bar(frame)).toContainText("Fix first: Temperature Low can't be below Min.");
    await expect(bar(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    await card(frame).getByRole("button", { name: /Temperature Low can't be below Min/ }).click();
    await expect(box(frame, "Temperature Low")).toBeFocused();
    await type(frame, "Temperature Min", "22");
    await pick(frame, "Period", "Night");
    await type(frame, "Humidity Max", "10");
    await pick(frame, "Period", "Day");
    await card(frame).getByRole("button", { name: /Night has a value to fix/ }).click();
    await expect(card(frame).getByRole("group", { name: "Period" }).getByRole("button", { name: "Night" })).toHaveAttribute("aria-pressed", "true");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("the target is one point: a typed target VPD moves humidity and says so", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Humidity Target")).toHaveValue("62");
    await type(frame, "VPD Target", "0.8");
    await expect(app(frame).locator(".toast")).toContainText(/^Humidity Target moved to [\d.]+% to give that VPD at 25°\.$/);
    await expect(box(frame, "Humidity Target")).not.toHaveValue("62");
  });

  test("dragging on the chart moves the nearest line, no further than its neighbour, and the arrow keys nudge it", async ({ page }) => {
    const frame = await open(page, "Nursery");
    await pick(frame, "Period", "Day");
    await pick(frame, "What to edit", "Temperature");
    const chart = card(frame).locator("#vwrap svg");
    await chart.scrollIntoViewIfNeeded();
    const r = await chart.boundingBox();
    if (!r) throw new Error("no chart");
    /* The chart's own units: 692 wide, a column of 34 per degree from 16° centred at 55. */
    const x = (t: number) => r.x + ((38 + (t - 16) * 34 + 17) / 692) * r.width, y = r.y + r.height / 2;
    await page.mouse.move(x(28.2), y);
    await page.mouse.down();
    await page.mouse.move(x(30), y, { steps: 4 });
    await page.mouse.up();
    await expect(box(frame, "Temperature Max")).toHaveValue("30");
    await expect(card(frame).locator(".now")).toContainText("Temperature Max 30°");
    await page.keyboard.press("ArrowLeft");
    await expect(box(frame, "Temperature Max")).toHaveValue("29.5");
    await page.mouse.move(x(29.5), y);
    await page.mouse.down();
    await page.mouse.move(x(20), y, { steps: 4 });
    await page.mouse.up();
    await expect(box(frame, "Temperature Max")).toHaveValue("27");
    await card(frame).getByRole("button", { name: "Higher" }).click();
    await expect(box(frame, "Temperature Max")).toHaveValue("27.5");
  });

  test("a picked helper shows what it holds, and HA asks before it's linked for the first time", async ({ page }) => {
    await page.goto(PAGE);
    const helper = "input_number.nursery_day_temperature_min_threshold";
    const frame = await panelFrame(page);
    /* The helper changes in HA after the panel has listed HA's helpers, so the page has to look again when it opens. */
    await tab(frame, "Devices").click();
    await expect.poll(() => frameText(frame)).toContain("Environment board");
    await page.evaluate(`(() => { fakeHA.states[${JSON.stringify(helper)}].state = "21"; CATALOG.entities.find((e) => e.entity_id === ${JSON.stringify(helper)}).state = "21"; })()`);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
    await app(frame).getByRole("menuitem", { name: "Targets, day and night" }).click();
    await pick(frame, "Period", "Day");
    await pick(frame, "Limits", "My helpers");
    await expect(bar(frame)).toContainText("Fix first: Link at least one limit to a helper, or choose Set here.");
    await card(frame).locator("#tl-bands-day-temperature-min-q").fill("nursery day temperature min");
    await card(frame).locator("#tl-bands-day-temperature-min").getByRole("option", { name: /nursery_day_temperature_min_threshold\s*21/ }).click();
    await expect(box(frame, "Temperature Min")).toHaveValue("21");
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Day temperature Min helper");
    await expect(dialog(frame)).toContainText("Home Assistant asks you to allow each helper this panel hasn't linked before.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect(await serviceCalls(page)).toBe(0);
  });

  test("on a phone, a typed box rises to sit just above where the keyboard lands, and the draft bar gets out of its way", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "Touch screens only: a mouse has no on-screen keyboard.");
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Max", "29");
    await expect(bar(frame)).toBeVisible();
    await box(frame, "Humidity Low").focus();
    await expect(bar(frame)).toBeHidden();
    /* With nothing to measure, the keyboard is taken to cover the lower half of the screen. */
    await expect
      .poll(() =>
        frame.evaluate(() => {
          const root = document.querySelector("ec-app")?.shadowRoot, row = root?.activeElement?.closest(".vrow")?.getBoundingClientRect(), bar = root?.querySelector(".topbar")?.getBoundingClientRect();
          return !!row && !!bar && row.bottom <= window.innerHeight * 0.5 && row.top >= bar.bottom;
        }),
      )
      .toBe(true);
    await box(frame, "Humidity Low").press("Enter");
    await expect(bar(frame)).toBeVisible();
  });

  test("a helper is picked by searching: typing narrows the matches, and the list stays short however many helpers there are", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    const picker = card(frame).locator("#tl-bands-day-humidity-max"), search = card(frame).locator("#tl-bands-day-humidity-max-q");
    await expect(picker).toContainText("Linked: input_number.garden_day_humidity_max_threshold, 70 %");
    await search.focus();
    const options = picker.getByRole("option");
    expect(await options.count()).toBeLessThanOrEqual(7);
    await expect(options.first()).toHaveText(/^\s*Set here/);
    await search.fill("night humidity");
    await expect(options).not.toHaveCount(0);
    for (const t of await options.allTextContents()) expect(t.toLowerCase()).toMatch(/night.*humidity|humidity.*night/);
    await search.fill("nothing like this");
    await expect(picker).toContainText("Nothing matches.");
    await search.fill("garden night humidity max");
    await expect(options).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Linked: input_number.garden_night_humidity_max_threshold, 68 %");
    await expect(picker.getByRole("listbox")).toHaveCount(0);
    await expect(box(frame, "Humidity Max")).toHaveValue("68");
    await search.focus();
    await search.fill("set here");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Set here");
    await expect(bar(frame)).toContainText("unsaved changes");
  });

  test("Escape closes a helper search without changing the link", async ({ page }) => {
    const frame = await open(page, "Garden");
    const search = app(frame).locator("#sh-on-q");
    await search.fill("reservoir");
    await expect(app(frame).locator("#sh-on").getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(app(frame).locator("#sh-on").getByRole("listbox")).toHaveCount(0);
    await expect(app(frame).locator("#sh-on")).toContainText("Linked: input_datetime.garden_day_time");
    await expect(bar(frame)).toHaveCount(0);
  });

  test("the chart's Change goes to Sensor Calibration and back, keeping the page's draft", async ({ page }) => {
    const frame = await open(page, "Garden");
    await pick(frame, "Period", "Day");
    await type(frame, "Temperature Max", "29");
    await card(frame).getByRole("button", { name: "Change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Sensor Calibration: Garden", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Targets, day and night: Garden", exact: true })).toBeVisible();
    await pick(frame, "Period", "Day");
    await expect(box(frame, "Temperature Max")).toHaveValue("29");
    await expect(bar(frame)).toContainText("Garden · Day Temperature Max, on your helper");
  });

  test("a new zone's 0s can't be confirmed; with its times and limits set it is, and its readings are judged from then on", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).locator("#g-targets").getByRole("button", { name: "Targets, day and night" }).click();
    await expect(app(frame).locator(".notice").first()).toContainText("Not confirmed yet. A new zone's times and limits all start at 0");
    await expect(app(frame).getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect(card(frame)).toContainText("Temperature Max has to be above Min.");
    await time(frame, "Lights on", "06:00");
    await time(frame, "Lights off", "18:00");
    for (const p of ["Day", "Night"]) {
      await pick(frame, "Period", p);
      await pick(frame, "Athena stage", "Veg");
    }
    await expect(card(frame).locator(".notice.fix")).toHaveCount(0);
    await bar(frame).getByRole("button", { name: "Review and apply" }).click();
    await expect(dialog(frame)).toContainText("Applying confirms this step, and Flower tent's readings are judged against these limits from then on.");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await expect(app(frame).locator("#g-targets .pill.ok")).toHaveText("Done");
    const z = await zoneOf(page, "Flower tent");
    expect([z.dayAt, z.nightAt, z.setup.targets, z.bands.night.vpd]).toEqual([360, 1080, "done", [0.65, 0.8, 0.9, 1, 1.15]]);
    await tab(frame, "Flower tent").click();
    await expect(app(frame).locator(".tile", { has: frame.locator(".name", { hasText: /^Temperature$/ }) })).not.toContainText("Targets not set up yet");
    await expect(dayRow(frame, "Temperature")).toHaveText([/^Temperature/, "20.2", "22.2", "24.95", "27.7", "29.7"]);
  });
});

test.describe("zones", () => {
  const stored = (page: Page) => page.evaluate<{ revision: number; zones: { id: string; name: string; description?: string; setup?: Record<string, string> }[]; devices: { id: string; zones: string[] }[] }>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const alert = (frame: Frame) => app(frame).getByRole("alertdialog");

  test("adding a zone needs a new name, shows what it saves, and opens its setup guide", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    const name = app(frame).getByLabel("Zone name"), review = app(frame).getByRole("button", { name: "Review and apply" });
    await expect(review).toBeDisabled();
    await name.fill("veg");
    await expect(app(frame).getByRole("button", { name: "There's already a zone called veg ›" })).toBeVisible();
    await expect(review).toBeDisabled();
    await name.fill("Flower tent");
    await app(frame).getByLabel("Description, optional").fill("By the window");
    await review.click();
    await expect(dialog(frame)).toContainText("Zone name");
    await expect(dialog(frame)).toContainText("Flower tent");
    await expect(dialog(frame)).toContainText("By the window");
    await dialog(frame).getByRole("button", { name: "Apply 2 changes" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await expect(tab(frame, "Flower tent")).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.description).toBe("By the window");
    expect(z?.setup).toEqual({ details: "done", devices: "todo", layout: "todo", place: "todo", calibrate: "todo", targets: "todo" });
    expect(await serviceCalls(page)).toBe(0);
  });

  test("leaving with a draft asks first, and the host knows a draft is open", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Seedlings");
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await tab(frame, "Overview").click();
    await expect(alert(frame)).toContainText("Discard unsaved changes?");
    await alert(frame).getByRole("button", { name: "Keep editing" }).click();
    await expect(app(frame).getByLabel("Zone name")).toHaveValue("Seedlings");
    await tab(frame, "Overview").click();
    await alert(frame).getByRole("button", { name: "Discard and continue" }).click();
    await expect(app(frame).locator(".zone-card")).toHaveCount(3);
    await expect.poll(() => leaveAsks(page)).toBe(false);
    expect((await stored(page)).zones.map((z) => z.id)).not.toContain("seedlings");
  });

  test("Zone details renames from the menu, and Finish with nothing changed saves nothing", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByLabel("Zone name").fill("Veg tent");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(tab(frame, "Veg tent")).toBeVisible();
    const revision = (await stored(page)).revision;
    expect((await stored(page)).zones.find((z) => z.id === "veg")?.name).toBe("Veg tent");
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Set up Veg tent" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByRole("button", { name: "Finish" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    expect((await stored(page)).revision).toBe(revision);
  });

  test("removing a zone needs its name typed exactly, and shared devices stay in their other zones", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Set up Nursery" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    const remove = alert(frame).getByRole("button", { name: "Remove zone" });
    await expect(alert(frame)).toContainText("Remove Nursery?");
    await expect(remove).toBeDisabled();
    await alert(frame).getByLabel("Type Nursery to confirm").fill("nursery");
    await expect(remove).toBeDisabled();
    await alert(frame).getByLabel("Type Nursery to confirm").fill("Nursery");
    await remove.click();
    await expect(tab(frame, "Nursery")).toHaveCount(0);
    const after = await stored(page);
    expect(after.zones.map((z) => z.id)).toEqual(["garden", "veg"]);
    expect(after.devices.find((d) => d.id === "lc-tent")?.zones).toEqual(["veg"]);
    expect(after.devices.every((d) => !d.zones.includes("nursery"))).toBe(true);
  });

  test("Escape keeps the zone, and a zone named with markup is drawn as text", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill('<img src=x onerror="window.pwned=1">');
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(tab(frame, '<img src=x onerror="window.pwned=1">')).toBeVisible();
    expect(await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.querySelectorAll("img").length)).toBe(0);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Set up Veg" }).click();
    await app(frame).getByRole("menuitem", { name: "Remove zone" }).click();
    await page.keyboard.press("Escape");
    await expect(alert(frame)).toHaveCount(0);
    await expect(tab(frame, "Veg")).toBeVisible();
  });

  test("a save that would make a device controllable waits for you, in the host's own dialog", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    const before = await stored(page);
    const answer = frame.evaluate(
      (config) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === 777 && resolve(e.data));
          const devices = config.devices.map((d: { id: string; zones: string[] }) => (d.id === "spare-plug" ? { ...d, zones: ["garden"] } : d));
          parent.postMessage({ v: 1, type: "save", req: 777, base: config.revision, config: { zones: config.zones, devices } }, "*");
        }),
      before,
    );
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await answer).toEqual(expect.objectContaining({ ok: false, error: "Not allowed, so nothing was saved." }));
    expect((await stored(page)).revision).toBe(before.revision);
  });
});

test.describe("map devices", () => {
  type Stored = { revision: number; zones: { id: string; sensors: Record<string, unknown>[]; setup?: Record<string, string>; combine?: { env: string } }[]; devices: Record<string, unknown>[] };
  const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const row = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
  const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });

  /* A zone added through the panel, then its setup guide's Map devices. */
  async function newZoneMap(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device identification: Flower tent", exact: true })).toBeVisible();
    return frame;
  }

  async function pickAll(frame: Frame): Promise<void> {
    await row(frame, "Environment board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByLabel("Top temp, 23 °C").check();
    await next(frame).click();
    await row(frame, "Spare Plug").getByRole("button").first().click();
    await row(frame, "Spare Plug").getByLabel("Heater").check();
    await row(frame, "Garden Dehumidifier").getByRole("button").first().click();
    await next(frame).click();
  }

  test("a board's readings are matched for it, two candidates ask, and Next waits for every answer", async ({ page }) => {
    const frame = await newZoneMap(page);
    await expect(next(frame)).toBeDisabled();
    await row(frame, "Environment board").getByRole("button").first().click();
    const board = row(frame, "Environment board");
    await expect(board.getByLabel("Air temp, 24.1 °C")).toBeChecked();
    await expect(board.getByLabel("Light, 41,200 lx")).toBeChecked();
    await expect(board.getByLabel("Chip temp, 41 °C")).toHaveCount(0);
    await expect(board.getByText("Leaf temperature offset")).toHaveCount(0);
    await expect(next(frame)).toBeEnabled();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await expect(row(frame, "Two probe board")).toContainText("Pick one");
    await expect(next(frame)).toBeDisabled();
    await expect(app(frame).getByRole("button", { name: "Two probe board: pick which Temperature entity to use. ›" })).toBeVisible();
    await row(frame, "Two probe board").getByLabel("Low temp, 21.4 °C").check();
    await expect(next(frame)).toBeEnabled();
    await expect(app(frame).getByText("How should these 2 environment sensors combine into the zone's reading?")).toBeVisible();
    await next(frame).click();
    await row(frame, "Spare Plug").getByRole("button").first().click();
    await expect(row(frame, "Spare Plug")).toContainText("What is it?");
    await expect(next(frame)).toBeDisabled();
    await row(frame, "Spare Plug").getByLabel("Heater").check();
    await row(frame, "Garden Dehumidifier").getByRole("button").first().click();
    await expect(row(frame, "Garden Dehumidifier").getByLabel("Dehumidifier")).toBeChecked();
    await next(frame).click();
    await expect(app(frame).locator(".review")).toContainText("Spare Plug (Heater), Garden Dehumidifier (Dehumidifier)");
  });

  test("a soil probe is detected as Soil and asked for moisture, EC and temperature, not humidity, VPD or light", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Soil 1").getByRole("button").first().click();
    const soil = row(frame, "Soil 1");
    await expect(soil.locator("fieldset", { hasText: "Class" }).getByLabel("Soil, detected")).toBeChecked();
    for (const reading of ["Moisture (VWC), pick one", "pwEC, pick one", "Temperature"]) await expect(soil.locator("legend", { hasText: reading })).toHaveCount(1);
    for (const reading of ["Humidity", "VPD", "Light"]) await expect(soil.locator("legend", { hasText: new RegExp(`^${reading}`) })).toHaveCount(0);
    await soil.getByLabel("Soil 1 Substrate Normalised VWC, 85.4 %").check();
    await soil.getByLabel("Soil 1 Substrate Pore Water EC, 2.54 mS/cm").check();
    await expect(soil.getByLabel("Soil 1 Substrate Temperature, 20.8 °C")).toBeChecked();
    await expect(next(frame)).toBeEnabled();
    /* Changed to Environment it asks that class's readings instead, keeping the temperature already picked. */
    await soil.locator("fieldset", { hasText: "Class" }).getByLabel("Environment").check();
    await expect(soil.locator("legend", { hasText: /^Humidity/ })).toHaveCount(1);
    await expect(soil.locator("legend", { hasText: /^Moisture/ })).toHaveCount(0);
    await expect(soil.getByLabel("Soil 1 Substrate Temperature, 20.8 °C")).toBeChecked();
  });

  test("any sensor on the device can go to any reading, and Not used is always there", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Two probe board").getByRole("button").first().click();
    const two = row(frame, "Two probe board"), light = two.locator("fieldset", { hasText: "Light" });
    await expect(light.getByLabel("Not used")).toBeChecked();
    await two.getByRole("button", { name: /From this device/ }).last().click();
    await light.getByLabel("Low temp, 21.4 °C").check();
    await expect(light.getByLabel("Low temp, 21.4 °C")).toBeChecked();
    await expect(light.getByLabel("Top temp, 23 °C")).toHaveCount(0);
    for (const reading of ["Temperature", "Humidity", "VPD"]) await two.locator("fieldset", { hasText: reading }).getByLabel("Not used").check();
    await light.getByLabel("Not used").check();
    await expect(app(frame).getByRole("button", { name: "Two probe board: pick at least one reading, or leave this sensor out. ›" })).toBeVisible();
    await expect(next(frame)).toBeDisabled();
  });

  test("applying waits for the host's own dialog; once you allow it, the mapping is stored and the step is done", async ({ page }) => {
    const frame = await newZoneMap(page);
    await pickAll(frame);
    await next(frame).click();
    await expect(dialog(frame)).toContainText("Spare Plug is a");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    /* Allow is off for a second after the dialog appears, so a stray tap can't land on it. */
    await page.waitForTimeout(1100);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.setup?.devices).toBe("done");
    expect(z?.combine).toEqual({ env: "mean", soil: "mean" });
    expect(z?.sensors.map((s) => [s.id, s.entities])).toEqual([
      ["d-board", { temperature: "sensor.environment_board_air_temp", humidity: "sensor.environment_board_humidity", vpd: "sensor.environment_board_vpd", light: "sensor.environment_board_light" }],
      ["d-two", { temperature: "sensor.two_probe_top_temp", humidity: "sensor.two_probe_humidity" }],
    ]);
    /* The leaf temperature offset is Sensor Calibration's, so mapping writes nothing about it. */
    expect(z?.sensors.some((s) => "leafEntity" in s || "leafUnused" in s || "leaf" in s)).toBe(false);
    const devices = (await stored(page)).devices.filter((d) => (d.zones as string[]).includes("flower_tent"));
    expect(devices.map((d) => [d.entity, d.type]).sort()).toEqual([
      ["humidifier.garden_dehumidifier", "Dehumidifier"],
      ["switch.spare_plug", "Heater"],
    ]);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("cancelling the host's dialog stores nothing, and the review says so", async ({ page }) => {
    const frame = await newZoneMap(page);
    const before = (await stored(page)).revision;
    await pickAll(frame);
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(frame)).toContainText("Not allowed, so nothing was saved.");
    expect((await stored(page)).revision).toBe(before);
  });

  test("leaving Map devices with picks made asks first", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await app(frame).getByRole("button", { name: "Cancel" }).click();
    await expect(app(frame).getByRole("alertdialog")).toContainText("Discard unsaved changes?");
    await app(frame).getByRole("alertdialog").getByRole("button", { name: "Discard and continue" }).click();
    await expect.poll(() => leaveAsks(page)).toBe(false);
  });

  test("a board HA can't say the link of is asked about on Setup, and the answer is kept", async ({ page }) => {
    const frame = await newZoneMap(page);
    await row(frame, "Environment board").getByRole("button").first().click();
    await next(frame).click();
    await next(frame).click();
    await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await tab(frame, "Setup").click();
    const questions = app(frame).locator("section", { hasText: "Questions for you" });
    const ask = questions.locator(".task", { hasText: "Environment board" });
    await ask.getByRole("button", { name: "Ethernet" }).click();
    await expect(ask).toHaveCount(0);
    const s = (await stored(page)).zones.find((x) => x.id === "flower_tent")?.sensors[0];
    expect([s?.link, s?.linkSource]).toEqual(["ethernet", "confirmed"]);
  });
});

test.describe("after an update", () => {
  test("a page that stayed open asks for a reload, keeps working underneath, and Reload reloads", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(tab(frame, "Overview")).toBeVisible();
    expect(await updatedBarButton(page)).toBeNull();
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page.evaluate(`panelModuleUrl = "/environment_control_static/0.1.0b6/host.js"; fakeHA.publish()`);
    await expect.poll(() => updatedBarButton(page)).not.toBeNull();
    await tab(frame, "Setup").click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    const button = await updatedBarButton(page);
    await Promise.all([page.waitForEvent("load"), page.mouse.click(button!.x, button!.y)]);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBeUndefined();
    await panelFrame(page);
  });

  test("with the release HA registers, or no panel list at all, there is no bar", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(tab(frame, "Overview")).toBeVisible();
    await page.evaluate(`panelModuleUrl = location.origin + "/custom_components/environment_control/frontend/host.js"; fakeHA.publish()`);
    await page.waitForTimeout(200);
    expect(await updatedBarButton(page)).toBeNull();
    await page.evaluate(`panelModuleUrl = undefined; fakeHA.publish()`);
    await page.waitForTimeout(200);
    expect(await updatedBarButton(page)).toBeNull();
  });
});

test.describe("zone layout and placement", () => {
  type Zone = { id: string; layout: { w: number; d: number; units: number; rows: number; cols: number }; sensors: { id: string; pos: number[] | null; level?: string; kind?: string }[]; virtual?: { id: string; name: string; pos: number[] }[]; setup?: Record<string, string> };
  type Stored = { revision: number; zones: Zone[]; devices: { id: string; place?: Record<string, number[]> }[] };
  const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const spot = (frame: Frame, name: string) => app(frame).locator(".map").getByRole("button", { name, exact: true }).first();
  const finish = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });

  async function openFromMenu(page: Page, zone: string, item: "Zone layout" | "Device placement"): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: `Set up ${zone}` }).click();
    await app(frame).getByRole("menuitem", { name: item }).click();
    return frame;
  }

  test("Zone layout sets the size, the units and a suggested grid, through a review", async ({ page }) => {
    const frame = await openFromMenu(page, "Veg", "Zone layout");
    await expect(app(frame).getByRole("heading", { level: 1, name: "Zone layout: Veg", exact: true })).toBeVisible();
    await app(frame).getByLabel("Width in metres").fill("2.4");
    await finish(frame).click();
    /* More units than the grid holds re-suggests the grid straight away, as the mock does. */
    await app(frame).getByLabel("Units", { exact: true }).fill("8");
    await expect(app(frame).locator(".stepper").first()).toContainText("2");
    await expect(app(frame).locator(".stepper").last()).toContainText("4");
    await expect(app(frame).getByText(/This grid holds/)).toHaveCount(0);
    await expect(finish(frame)).toBeEnabled();
    await finish(frame).click();
    await expect(dialog(frame)).toContainText("1.2 x 1.2 m");
    await expect(dialog(frame)).toContainText("2.4 x 1.2 m");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await expect.poll(async () => (await stored(page)).zones.find((z) => z.id === "veg")?.layout).toEqual({ w: 2.4, d: 1.2, units: 8, rows: 2, cols: 4 });
  });

  test("finishing or cancelling a setup editor goes back where it was opened: Setup from its menu, the zone's page from a link", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    await app(frame).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await app(frame).getByRole("button", { name: "Set up Garden" }).click();
    await app(frame).getByRole("menuitem", { name: "Zone details" }).click();
    await app(frame).getByLabel("Description, optional").fill("By the window");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    await tab(frame, "Garden").click();
    await app(frame).getByRole("button", { name: "Set targets" }).click();
    await app(frame).getByRole("button", { name: "Back", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Garden", exact: true })).toBeVisible();
  });

  test("a grid that strands a placed sensor carries on to the map, and can't save until it's placed again", async ({ page }) => {
    const frame = await openFromMenu(page, "Garden", "Zone layout");
    await finish(frame).click();
    await app(frame).getByLabel("Units", { exact: true }).fill("4");
    await expect(app(frame).locator(".steps")).toContainText("3. Sensors and devices");
    await expect(app(frame).getByText(/no longer fits?/).first()).toBeVisible();
    await finish(frame).click();
    await expect(app(frame).getByRole("button", { name: "Review and apply" })).toBeDisabled();
    const fix = app(frame).getByRole("button", { name: /^Place .* to save ›$/ });
    await expect(fix).toBeVisible();
    await spot(frame, "Unit 4").click();
    await expect(app(frame).getByRole("button", { name: "Review and apply" })).toBeEnabled();
  });

  test("a soil probe goes only in a unit, an air sensor anywhere inside at a height, a device or virtual device outside too", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).getByRole("button", { name: "Device placement", exact: true })).toBeDisabled();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    const row = (name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
    await row("Environment board").getByRole("button").first().click();
    await row("Soil 1").getByRole("button").first().click();
    await row("Soil 1").getByLabel("Soil 1 Substrate Normalised VWC, 85.4 %").check();
    await row("Soil 1").getByLabel("Soil 1 Substrate Pore Water EC, 2.54 mS/cm").check();
    for (let i = 0; i < 3; i++) await finish(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await app(frame).getByRole("button", { name: "Device placement", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Device placement: Flower tent", exact: true })).toBeVisible();

    await app(frame).locator(".sensor-opt", { hasText: "Soil 1" }).click();
    await expect(app(frame).getByText("Tap the unit Soil 1 is in.")).toBeVisible();
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Aisle/ })).toHaveCount(0);
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Unit \d$/ })).toHaveCount(4);
    await spot(frame, "Unit 1").click();
    /* A soil probe is in the substrate, so it's asked no height. */
    await expect(app(frame).getByRole("group", { name: /^Height of Soil 1/ })).toHaveCount(0);

    await app(frame).locator(".sensor-opt", { hasText: "Environment board" }).click();
    await expect(app(frame).locator(".map").getByRole("button", { name: /^Outside the wall/ })).toHaveCount(0);
    await spot(frame, "Aisle between rows 1 and 2").click();
    /* An air sensor can't be saved until its height is chosen. */
    await expect(app(frame).locator(".sensor-opt", { hasText: "Environment board" })).toContainText("Needs a height");
    await expect(finish(frame)).toBeDisabled();
    await app(frame).getByRole("button", { name: "Set Environment board's height to save" }).click();
    await app(frame).getByLabel("In canopy").check();
    await expect(finish(frame)).toBeEnabled();

    await app(frame).getByLabel("Add a virtual device").fill("Drain tank");
    await app(frame).getByRole("group", { name: "Its type" }).getByLabel("Tank").check();
    await app(frame).getByRole("button", { name: "Add", exact: true }).click();
    await spot(frame, "Outside the wall, by unit 1").click();
    /* Picked, a virtual device can be renamed, retyped and removed right here. */
    await app(frame).getByLabel("Name", { exact: true }).fill("Waste tank");
    await app(frame).getByLabel("Name", { exact: true }).press("Enter");
    await expect(app(frame).locator(".sensor-opt", { hasText: "Waste tank" })).toContainText("Tank");
    await app(frame).getByLabel("Add a virtual device").fill("Spare bucket");
    await app(frame).getByRole("button", { name: "Add", exact: true }).click();
    await app(frame).getByRole("button", { name: "Remove Spare bucket" }).click();
    await expect(app(frame).locator(".sensor-opt", { hasText: "Spare bucket" })).toHaveCount(0);

    await finish(frame).click();
    await expect(dialog(frame)).toContainText("Soil 1 position");
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.setup?.place).toBe("done");
    expect(z?.sensors.map((x) => [x.id, x.kind, x.pos, x.level ?? null])).toEqual([
      ["d-board", "env", [0.5, 0], "in"],
      ["d-soil", "soil", [0, 0], null],
    ]);
    expect(z?.virtual).toEqual([{ id: "v-drain_tank", name: "Waste tank", pos: [-1, -1], type: "Tank" }]);
  });

  test("a zone's page shows its map, and names devices that aren't on it", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Garden").click();
    const map = app(frame).getByRole("group", { name: "Units, sensors and devices in Garden" });
    await expect(map).toBeVisible();
    await expect(map.getByRole("button", { name: /^Select Environment left, / })).toHaveCount(1);
    await expect(app(frame).getByRole("button", { name: "Place devices ›" })).toHaveCount(await app(frame).getByText(/on the map: /).count());
  });
});

test.describe("live readings", () => {
  const dialog = (frame: Frame) => app(frame).getByRole("dialog");
  const row = (frame: Frame, name: string) => app(frame).locator(".pickwrap", { has: frame.locator("strong", { hasText: name }) });
  const next = (frame: Frame) => app(frame).getByRole("button", { name: /^(Next|Review and apply|Finish)$/ });
  const tile = (frame: Frame, label: string) => app(frame).locator(".tile", { has: frame.locator(".name", { hasText: label }) });
  /* Sensor states as HA would hold them, updated just now unless told otherwise. */
  /* The page declares fakeHA with const, so it is a global but not a window property: reached as an expression. */
  const setStates = (page: Page, states: Record<string, [string, number?]>) =>
    page.evaluate(`(() => {
      for (const [e, [state, ageMs]] of Object.entries(${JSON.stringify(states)}))
        fakeHA.states[e] = { entity_id: e, state, attributes: {}, context: { user_id: null, parent_id: null }, last_updated: new Date(Date.now() - (ageMs ?? 5000)).toISOString() };
      fakeHA.publish();
    })()`);

  /* A zone with the environment board and the two probe board mapped. */
  async function twoSensorZone(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    await setStates(page, {
      "sensor.environment_board_air_temp": ["24"], "sensor.environment_board_humidity": ["60"], "sensor.environment_board_vpd": ["1.2"], "sensor.environment_board_light": ["40000"],
      "sensor.two_probe_top_temp": ["22"], "sensor.two_probe_low_temp": ["21"], "sensor.two_probe_humidity": ["70"],
    });
    const frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Add zone" }).click();
    await app(frame).getByLabel("Zone name").fill("Flower tent");
    await app(frame).getByRole("button", { name: "Review and apply" }).click();
    await dialog(frame).getByRole("button", { name: "Apply 1 change" }).click();
    await app(frame).getByRole("button", { name: "Device identification", exact: true }).click();
    await row(frame, "Environment board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByLabel(/^Top temp,/).check();
    for (let i = 0; i < 3; i++) await next(frame).click();
    await dialog(frame).getByRole("button", { name: /^Apply \d+ changes$/ }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent", exact: true })).toBeVisible();
    await tab(frame, "Flower tent").click();
    return frame;
  }

  test("a zone's tiles combine its live sensors and say how, and Overview shows the same numbers", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("23.0");
    await expect(tile(frame, "Temperature")).toContainText("Average of 2: Environment board 24.0, Two probe board 22.0.");
    await expect(tile(frame, "Humidity").locator(".val")).toContainText("65.0");
    await expect(tile(frame, "Temperature")).toContainText("Targets not set up yet");
    await expect(app(frame).locator(".lcard .val")).toContainText("40,000");
    await tab(frame, "Overview").click();
    const card = app(frame).locator(".zone-card", { hasText: "Flower tent" });
    await expect(card.locator(".mrow", { hasText: "Temperature" })).toContainText("23.0");
    await expect(card).toContainText("No targets yet");
  });

  test("a dead sensor is never a number: it is left out and named", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await setStates(page, { "sensor.environment_board_air_temp": ["unavailable"] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("22.0");
    await expect(tile(frame, "Temperature")).toContainText("Environment board has no data, left out.");
    await setStates(page, { "sensor.two_probe_top_temp": ["unknown"] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("--");
  });

  test("a reading that stopped updating is stale, left out and named", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await setStates(page, { "sensor.two_probe_top_temp": ["22", 20 * 60_000] });
    await expect(tile(frame, "Temperature").locator(".val")).toContainText("24.0");
    await expect(tile(frame, "Temperature")).toContainText("Two probe board is stale, left out.");
  });

  test("tapping a sensor on the map says where it is, what it reads and when it last reported", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Garden").click();
    await app(frame).locator(".map").getByRole("button", { name: /^Select Environment under, / }).click();
    await expect(app(frame).locator(".detail")).toContainText("Environment under");
    await expect(app(frame).locator(".detail")).toContainText("Under canopy.");
  });

  test("Devices lists each mapped device and sensor with its link and state", async ({ page }) => {
    const frame = await twoSensorZone(page);
    await tab(frame, "Devices").click();
    const table = app(frame).locator("table");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Environment sensor");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Online");
    await expect(table.locator("tr", { hasText: "Environment board" })).toContainText("Link not known");
    await app(frame).getByLabel("WiFi").check();
    await expect(table.locator("tr", { hasText: "Environment board" })).toHaveCount(0);
  });
});

test.describe("history", () => {
  /* Garden's three boards given readings, as a real setup maps them: the under-canopy board has no VPD of its own. */
  async function garden(page: Page): Promise<Frame> {
    await page.goto(PAGE);
    await page.evaluate(`(() => {
      const now = new Date().toISOString(), base = { gl: [26.6, 64.2, 1.05, 41200], gr: [27.0, 62.6, 1.12, 40300], gu: [24.9, 71.0, null, 11000] };
      for (const [p, b] of Object.entries(base)) ["t", "h", "v", "l"].forEach((k, i) => {
        if (b[i] !== null) fakeHA.states["sensor." + p + "_" + k] = { entity_id: "sensor." + p + "_" + k, state: String(b[i]), attributes: {}, context: {}, last_updated: now };
      });
      const cfg = JSON.parse(fakeHA.disk), ids = { "g-left": "gl", "g-right": "gr", "g-under": "gu" };
      for (const s of cfg.zones[0].sensors) {
        const p = ids[s.id];
        s.entities = { temperature: "sensor." + p + "_t", humidity: "sensor." + p + "_h", ...(p === "gu" ? {} : { vpd: "sensor." + p + "_v" }), light: "sensor." + p + "_l" };
      }
      fakeHA.disk = JSON.stringify(cfg);
      fakeHA.config = cfg;
      fakeHA.knobs.restartMs = 50;
      fakeHA.restart();
    })()`);
    const frame = await panelFrame(page);
    await expect(tab(frame, "Garden")).toBeVisible();
    return frame;
  }
  const card = (frame: Frame) => app(frame).locator("section.card", { has: frame.getByRole("heading", { name: "History", exact: true }) });
  const row = (frame: Frame, name: string) => card(frame).locator("tbody tr", { hasText: name });
  const calls = (page: Page) => page.evaluate<{ entities: string[]; hours: number; buckets: number }[]>("historyCalls");

  test("every sensor gets a line and the combined line ends on the same value as the tile", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    await expect(card(frame).locator(".chart svg")).toBeVisible();
    await expect(card(frame).locator("tbody tr")).toHaveCount(4);
    const tile = (await app(frame).locator(".tile", { has: frame.locator(".name", { hasText: /^Temperature$/ }) }).locator(".val").textContent())?.replace("°C", "").trim();
    await expect(row(frame, "Average").locator("td").nth(1)).toHaveText(tile ?? "");
    await expect(row(frame, "Environment under").locator("td").nth(1)).toHaveText("24.9");
    await expect(card(frame).locator("thead")).toContainText("Min");
  });

  test("every sensor's line is drawn at full strength, so it shows against the ideal band", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    const lines = card(frame).locator(".chart svg path");
    await expect(lines).toHaveCount(4);
    for (const l of await lines.all()) expect(await l.getAttribute("stroke-opacity")).toBeNull();
  });

  test("a metric and range ask for exactly the readings drawn, and VPD asks for temperature and humidity where a board has none", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    await expect(card(frame).locator(".chart svg")).toBeVisible();
    await card(frame).getByRole("button", { name: "VPD", exact: true }).click();
    await card(frame).getByRole("button", { name: "7d", exact: true }).click();
    await expect.poll(async () => (await calls(page)).at(-1)).toEqual({
      type: "environment_control/history",
      entities: ["sensor.gl_v", "sensor.gr_v", "sensor.gu_t", "sensor.gu_h"],
      hours: 168,
      buckets: 336,
    });
  });

  test("moving across the chart, or the arrow keys, reads a point in time, and Escape goes back to now", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    const head = card(frame).locator("thead th").nth(1);
    await expect(head).toHaveText("Now");
    const chart = card(frame).locator(".chart svg"), box = await chart.boundingBox();
    if (!box) throw new Error("no chart");
    await chart.hover({ position: { x: box.width * 0.3, y: box.height / 2 } });
    await expect(head).toHaveText(/^\d\d:\d\d$/);
    await card(frame).locator(".chart svg").focus();
    await page.keyboard.press("Escape");
    await expect(head).toHaveText("Now");
    await page.keyboard.press("ArrowLeft");
    await expect(head).toHaveText(/^\d\d:\d\d$/);
    expect(await serviceCalls(page)).toBe(0);
  });

  test("light shows only Now, and Overview draws each zone's last 4 hours of light", async ({ page }) => {
    const frame = await garden(page);
    await expect(app(frame).getByRole("img", { name: "Light (Average) in Garden over the last 4 hours" })).toBeVisible();
    await tab(frame, "Garden").click();
    await card(frame).getByRole("button", { name: "Light", exact: true }).click();
    await expect(card(frame).locator("thead")).not.toContainText("Min");
    await expect(row(frame, "Environment left").locator("td")).toHaveCount(2);
  });

  test("a dead reading is a gap, never 0, and a short history says how far back it goes", async ({ page }) => {
    const frame = await garden(page);
    await page.evaluate(`(() => {
      const made = historyFor;
      historyFor = (entity, msg, start) => (entity === "sensor.gr_t" ? { first: null, values: Array(msg.buckets).fill(null) } : { ...made(entity, msg, start), first: start + msg.hours * 1800 });
      fakeHA.states["sensor.gr_t"] = { ...fakeHA.states["sensor.gr_t"], state: "unavailable" };
      fakeHA.publish();
    })()`);
    await tab(frame, "Garden").click();
    await expect(row(frame, "Environment right").locator("td")).toHaveText(["Environment right", "--", "--", "--"]);
    await expect(card(frame).locator(".chart-note")).toContainText("Home Assistant has kept 12 hours of these readings");
  });

  test("switching metric or range keeps the card's place on the page while the new readings load", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    await expect(card(frame).locator(".chart svg")).toBeVisible();
    await page.evaluate("historyDelayMs = 1500");
    await card(frame).locator(".chart").scrollIntoViewIfNeeded();
    const before = await frame.evaluate(() => window.scrollY);
    const height = (await card(frame).boundingBox())?.height ?? 0;
    await card(frame).getByRole("button", { name: "RH", exact: true }).click();
    await expect(card(frame)).toContainText("Reading the history from Home Assistant.");
    expect(await frame.evaluate(() => window.scrollY)).toBe(before);
    expect(Math.abs(((await card(frame).boundingBox())?.height ?? 0) - height)).toBeLessThan(40);
    await card(frame).getByRole("button", { name: "72h", exact: true }).click();
    expect(await frame.evaluate(() => window.scrollY)).toBe(before);
    await expect(card(frame)).not.toContainText("Reading the history", { timeout: 5000 });
    expect(await frame.evaluate(() => window.scrollY)).toBe(before);
  });

  test("when the history can't be read it says so", async ({ page }) => {
    const frame = await garden(page);
    await page.evaluate("historyDown = true");
    await tab(frame, "Garden").click();
    await expect(card(frame)).toContainText("Couldn't read the history. Recorder busy");
  });

  test("the host asks for nothing but a mapped sensor's readings, over a range the panel draws", async ({ page }) => {
    const frame = await garden(page);
    await expect.poll(async () => (await calls(page)).length).toBeGreaterThan(0);
    const before = (await calls(page)).length;
    const ask = (body: Record<string, unknown>) =>
      frame.evaluate(
        (b) =>
          new Promise<{ ok: boolean; error?: string }>((resolve) => {
            const req = 7000 + Math.floor(Math.random() * 1000);
            window.addEventListener("message", (e) => e.data?.type === "result" && e.data.req === req && resolve(e.data));
            parent.postMessage({ v: 1, type: "history", req, ...b }, "*");
          }),
        body,
      );
    expect((await ask({ entities: ["switch.heater_mains"], hours: 24, buckets: 288 })).error).toContain("only for the readings of a sensor");
    expect((await ask({ entities: ["number.environment_left_leaf_temperature_offset"], hours: 24, buckets: 288 })).ok).toBe(false);
    expect((await ask({ entities: ["sensor.gl_t"], hours: 720, buckets: 288 })).error).toContain("isn't a range this panel draws");
    expect((await ask({ entities: ["sensor.gl_t"], hours: 24, buckets: 5000 })).ok).toBe(false);
    expect((await calls(page)).length).toBe(before);
  });
});

test.describe("narrow window", () => {
  test("with HA's sidebar hidden, the menu button opens it, and only then is there one", async ({ page }) => {
    await page.goto(`${PAGE}?narrow=1`);
    let frame = await panelFrame(page);
    await app(frame).getByRole("button", { name: "Open Home Assistant's sidebar" }).click();
    await expect.poll(() => page.evaluate<number>("sidebarToggles")).toBe(1);
    await page.goto(PAGE);
    frame = await panelFrame(page);
    await expect(tab(frame, "Overview")).toBeVisible();
    await expect(app(frame).getByRole("button", { name: "Open Home Assistant's sidebar" })).toHaveCount(0);
  });

  test("the host passes a change of width on, so the button comes and goes", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await expect(tab(frame, "Overview")).toBeVisible();
    await page.evaluate("panel.narrow = true");
    await expect(app(frame).getByRole("button", { name: "Open Home Assistant's sidebar" })).toBeVisible();
    await page.evaluate("panel.narrow = false");
    await expect(app(frame).getByRole("button", { name: "Open Home Assistant's sidebar" })).toHaveCount(0);
  });
});

test.describe("what Home Assistant has", () => {
  test("the catalog shows each device by area with how it is connected, and says so when that isn't known", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Devices").click();
    await expect.poll(() => frameText(frame)).toContain("Environment board");
    const text = await frameText(frame);
    for (const want of ["Garden", "Veg", "No area", "WiFi", "Zigbee", "Through Hue bridge", "Link not known", "Cloud", "entities, such as helpers and templates", "Spare plug"]) {
      expect(text).toContain(want);
    }
    expect(await serviceCalls(page)).toBe(0);
  });

  test("a device named with markup is drawn as text, never run", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, "Devices").click();
    await expect.poll(() => frameText(frame)).toContain('<img src=x onerror="window.pwned=1">');
    expect(await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.querySelectorAll("img").length)).toBe(0);
  });

  test("when Home Assistant can't list its devices the panel says so, and Try again asks again", async ({ page }) => {
    await page.goto(`${PAGE}?catalog=fail`);
    const frame = await panelFrame(page);
    await tab(frame, "Devices").click();
    await app(frame).getByText("Everything in Home Assistant").click();
    await expect.poll(() => frameText(frame)).toContain("couldn't list its devices");
    await page.evaluate("catalogDown = false");
    await frame.locator("ec-app").getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => frameText(frame)).toContain("Environment board");
  });
});

test.describe("appearance", () => {
  test("HA's primary colour reaches the frame, and one that isn't a plain colour doesn't", async ({ page }) => {
    await page.goto(PAGE);
    let frame = await panelFrame(page);
    const primary = () => frame.evaluate(() => getComputedStyle(document.querySelector("ec-app") as Element).getPropertyValue("--primary").trim());
    await expect.poll(primary).toBe("#F44336");
    await page.goto(`${PAGE}?primary=${encodeURIComponent("url(https://x.test/a.png)")}`);
    frame = await panelFrame(page);
    await expect.poll(primary).toBe("#03A9F4");
  });

  test("an appearance picked in the frame is kept by the host and survives reopening the panel", async ({ page }) => {
    await page.goto(PAGE);
    let frame = await panelFrame(page);
    await tab(frame, "Setup").click();
    await app(frame).getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect(app(frame).getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => (window as unknown as { reopenPanel(): void }).reopenPanel());
    await expect.poll(() => page.frames().length).toBe(2);
    frame = page.frames()[1];
    await frame.waitForSelector("ec-app");
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  });

  test("an appearance the host doesn't know is refused", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await frame.evaluate(() => parent.postMessage({ v: 1, type: "appearance", value: "neon", req: 9 }, "*"));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => localStorage.getItem("environment-control-appearance"))).toBeNull();
  });
});

test.describe("leaving with a draft open", () => {
  const draft = (frame: Frame, open: unknown) => frame.evaluate((o) => parent.postMessage({ v: 1, type: "draft", open: o }, "*"), open);

  test("closing the page asks only while the frame says a draft is open, and only true or false counts", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    expect(await leaveAsks(page)).toBe(false);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await draft(frame, "no");
    await page.waitForTimeout(100);
    expect(await leaveAsks(page)).toBe(true);
    await draft(frame, false);
    await expect.poll(() => leaveAsks(page)).toBe(false);
  });

  test("HA's sidebar is held and the host asks; Keep editing stays, Discard and leave goes", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    const overview = page.locator('ha-sidebar a[data-route="/lovelace"]');
    await overview.click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await overview.click();
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await page.evaluate(() => document.querySelector("environment-control-panel"))).toBeNull();
  });

  test("a navigation with no click, such as a notification tap, is held the same way", async ({ page }) => {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    expect(await page.evaluate(() => location.hash)).toBe("#/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await page.evaluate(() => location.hash)).toBe("#/lovelace");
    expect(await page.evaluate(() => document.querySelector("environment-control-panel"))).toBeNull();
  });

  test("the back gesture is held too, and Discard and leave goes back", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => route(page)).toBe("/lovelace");
    await page.evaluate("haNavigate('/environment-control')");
    await expect.poll(() => route(page)).toBe("/environment-control");
    const frame = await panelFrame(page);
    await draft(frame, true);
    await expect.poll(() => leaveAsks(page)).toBe(true);
    /* A real gesture gives the page a user activation, which Chromium asks for before it lets a page cancel going back. */
    await page.mouse.click(5, 120);
    await page.evaluate(() => history.back());
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    expect(await route(page)).toBe("/environment-control");
    await page.keyboard.press("Escape");
    await expect.poll(() => hostDialogOpen(page)).toBe(false);
    expect(await route(page)).toBe("/environment-control");
    await page.mouse.click(5, 120);
    await page.evaluate(() => history.back());
    await expect.poll(() => hostDialogOpen(page)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => route(page)).toBe("/lovelace");
  });

  test("with nothing unsaved, navigation with no click and going back go straight through", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.evaluate("haNavigate('/lovelace')");
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await hostDialogOpen(page)).toBe(false);
    await page.evaluate(() => history.back());
    await expect.poll(() => route(page)).toBe("/environment-control");
    await panelFrame(page);
  });

  test("with nothing unsaved, the sidebar goes straight away, and coming back opens the panel fresh", async ({ page }) => {
    await page.goto(PAGE);
    await panelFrame(page);
    await page.locator('ha-sidebar a[data-route="/lovelace"]').click();
    await expect.poll(() => route(page)).toBe("/lovelace");
    expect(await hostDialogOpen(page)).toBe(false);
    await page.locator('ha-sidebar a[data-route="/environment-control"]').click();
    await expect.poll(() => route(page)).toBe("/environment-control");
    await expect.poll(() => page.frames().length).toBe(2);
    expect(await leaveAsks(page)).toBe(false);
  });
});

test.describe("manual controls", () => {
  const controls = (frame: Frame) => app(frame).locator("#controls");
  const row = (frame: Frame, name: string) => controls(frame).locator(".dev", { has: frame.locator(".dev-name", { hasText: new RegExp(`^${name}$`) }) });
  const sw = (frame: Frame, name: string) => controls(frame).getByRole("switch", { name, exact: true });
  const calls = (page: Page) => page.evaluate<{ domain: string; service: string; data: Record<string, unknown> }[]>("fakeHA.calls");
  async function openZone(page: Page, zone = "Garden"): Promise<Frame> {
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await tab(frame, zone).click();
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
    await controls(frame).getByLabel("Overhead light controller brightness").fill("40");
    await expect(row(frame, "Overhead light controller")).toContainText("On, 40%.");
    await row(frame, "Auxiliary dehumidifier").getByText("Eco", { exact: true }).click();
    await expect(row(frame, "Auxiliary dehumidifier")).toContainText("On, eco mode.");
    await controls(frame).getByLabel("Auxiliary dehumidifier target humidity").fill("45");
    await expect(row(frame, "Auxiliary dehumidifier")).toContainText("Target 45%");
    expect((await calls(page)).map((c) => [`${c.domain}.${c.service}`, c.data])).toEqual([
      ["light.turn_on", { entity_id: "light.garden_light_controller_overhead", brightness_pct: 40 }],
      ["humidifier.set_mode", { entity_id: "humidifier.auxiliary_dehumidifier", mode: "eco" }],
      ["humidifier.set_humidity", { entity_id: "humidifier.auxiliary_dehumidifier", humidity: 45 }],
    ]);
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
