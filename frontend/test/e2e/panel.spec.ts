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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Veg" })).toBeVisible();
    await expect(tab(frame, "Veg")).toHaveAttribute("aria-current", "page");
    await tab(frame, "Overview").click();
    await app(frame).locator(".zone-card", { hasText: "Nursery" }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Nursery" })).toBeVisible();
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
        { v: 1, type: "device", id: "heater", action: "turn_on", req: 1 },
        { v: 1, type: "calibrate", sensor: "s1", value: 0, req: 2 },
        { v: 1, type: "setting", zone: "garden", name: "day", value: "07:00", req: 3 },
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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent" })).toBeVisible();
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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
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
    await app(frame).getByRole("button", { name: "Map devices", exact: true }).click();
    await expect(app(frame).getByRole("heading", { level: 1, name: "Map devices: Flower tent" })).toBeVisible();
    return frame;
  }

  async function pickAll(frame: Frame): Promise<void> {
    await row(frame, "Environment board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await row(frame, "Two probe board").getByLabel("sensor.two_probe_top_temp (23.0 °C)").check();
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
    await expect(board.getByLabel("sensor.environment_board_air_temp (24.1 °C)")).toBeChecked();
    await expect(board.getByLabel("sensor.environment_board_chip_temp (41.0 °C)")).toHaveCount(0);
    await expect(board.getByLabel("number.environment_board_leaf_offset (-1.5 °C)")).toBeChecked();
    await expect(next(frame)).toBeEnabled();
    await row(frame, "Two probe board").getByRole("button").first().click();
    await expect(row(frame, "Two probe board")).toContainText("Pick one");
    await expect(next(frame)).toBeDisabled();
    await expect(app(frame).getByRole("button", { name: "Two probe board: pick which Temperature entity to use. ›" })).toBeVisible();
    await row(frame, "Two probe board").getByLabel("sensor.two_probe_low_temp (21.4 °C)").check();
    await expect(next(frame)).toBeEnabled();
    await expect(app(frame).getByText("How should these 2 sensors combine into the zone's reading?")).toBeVisible();
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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent" })).toBeVisible();
    const z = (await stored(page)).zones.find((x) => x.id === "flower_tent");
    expect(z?.setup?.devices).toBe("done");
    expect(z?.combine).toEqual({ env: "mean" });
    expect(z?.sensors.map((s) => [s.id, s.entities, s.leafEntity ?? null, s.leafUnused])).toEqual([
      ["d-board", { temperature: "sensor.environment_board_air_temp", humidity: "sensor.environment_board_humidity", vpd: "sensor.environment_board_vpd", light: "sensor.environment_board_light" }, "number.environment_board_leaf_offset", false],
      ["d-two", { temperature: "sensor.two_probe_top_temp", humidity: "sensor.two_probe_humidity" }, null, true],
    ]);
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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Set up Flower tent" })).toBeVisible();
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
    await expect(app(frame).getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
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
    for (const want of ["Garden", "Veg", "No area", "WiFi", "Zigbee", "Through Hue bridge", "Link not known", "Cloud", "1 entity, such as a helper or template", "Spare plug"]) {
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
