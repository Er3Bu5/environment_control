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

test.describe("saving", () => {
  const stored = (page: Page) => page.evaluate<{ revision: number }>("JSON.parse(JSON.stringify(fakeHA.config))");

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
    for (const want of ["Garden", "Veg", "No area", "WiFi", "Zigbee", "Through Hue bridge", "Link not known", "Cloud", "1 entity, such as a helper or template"]) {
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
