/* The real built host and frame, mounted on a page that plays Home Assistant with the mock's fake HA. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, app, goTo, openNav, panelFrame, segDivider, serviceCalls, tab } from "./helpers";

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
    await openNav(frame);
    await expect(tab(frame, "Garden")).toBeVisible();
    return frame;
  }
  const card = (frame: Frame) => app(frame).locator("section.card", { has: frame.getByRole("heading", { name: "History", exact: true }) });
  const row = (frame: Frame, name: string) => card(frame).locator("tbody tr", { hasText: name });
  const calls = (page: Page) => page.evaluate<{ entities: string[]; hours: number; buckets: number }[]>("historyCalls");

  test("the tiles' tracks line up across the row, however many lines of notes a tile has", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
    const tiles = app(frame).locator(".tiles .tile");
    await expect(tiles).toHaveCount(3);
    /* VPD has a line the others don't, its leaf temperature offset, which used to push its track down. */
    await expect(tiles.nth(2)).toContainText("Leaf temperature offset");
    const tops = await tiles.locator(".track").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    const perRow = (await tiles.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size)) === 1 ? 3 : 2;
    expect(tops[0]).toBe(tops[1]);
    if (perRow === 3) expect(tops[2]).toBe(tops[0]);
    const ranges = await tiles.locator(".range").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(ranges[0]).toBe(ranges[1]);
  });

  test("every sensor gets a line and the combined line ends on the same value as the tile", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
    await expect(card(frame).locator(".chart svg")).toBeVisible();
    await expect(card(frame).locator("tbody tr")).toHaveCount(4);
    const tile = (await app(frame).locator(".tile", { has: frame.locator(".name", { hasText: /^Temperature$/ }) }).locator(".val").textContent())?.replace("°C", "").trim();
    await expect(row(frame, "Average").locator("td").nth(1)).toHaveText(tile ?? "");
    await expect(row(frame, "Environment under").locator("td").nth(1)).toHaveText("24.9");
    await expect(card(frame).locator("thead")).toContainText("Min");
  });

  test("every sensor's line is drawn at full strength, so it shows against the ideal band", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
    const lines = card(frame).locator(".chart svg path");
    await expect(lines).toHaveCount(4);
    for (const l of await lines.all()) expect(await l.getAttribute("stroke-opacity")).toBeNull();
  });

  test("a metric and range ask for exactly the readings drawn, and VPD asks for temperature and humidity where a board has none", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
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
    await goTo(frame, "Garden");
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

  test("the chart leaves the same space left and right of what it draws, and nothing it draws leaves the card", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
    /* What the chart draws, measured against the card's content box: the gap on each side, and whether anything,
       hover dots included, lands outside the card. */
    const measure = () =>
      card(frame).evaluate((el) => {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        const drawn = [...el.querySelectorAll(".chart svg *")].map((n) => n.getBoundingClientRect()).filter((b) => b.width || b.height);
        const dots = [...el.querySelectorAll(".chart svg circle")].map((n) => n.getBoundingClientRect());
        const lo = Math.min(...drawn.map((b) => b.left)), hi = Math.max(...drawn.map((b) => b.right));
        const inside = (b: DOMRect) => b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom;
        return { leftGap: lo - left, rightGap: right - hi, allInside: drawn.every(inside), dots: dots.length, dotsInside: dots.every(inside) };
      });
    for (const width of [1280, 500]) {
      await page.setViewportSize({ width, height: 900 });
      for (const metric of ["Temp", "Light"]) {
        await card(frame).getByRole("button", { name: metric, exact: true }).click();
        const chart = card(frame).locator(".chart svg");
        await expect(chart.locator("path")).not.toHaveCount(0);
        /* The chart redraws at its new width once the resize is seen; until then it's scaled and proves nothing. */
        await expect
          .poll(() => chart.evaluate((s) => Math.abs((s as SVGSVGElement).viewBox.baseVal.width - s.getBoundingClientRect().width)))
          .toBeLessThanOrEqual(1);
        const still = await measure();
        expect(Math.abs(still.leftGap - still.rightGap), `${metric} at ${width}px: ${JSON.stringify(still)}`).toBeLessThanOrEqual(2);
        expect(still.leftGap, `${metric} at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(still.allInside, `${metric} at ${width}px`).toBe(true);
        const box = await chart.boundingBox();
        if (!box) throw new Error("no chart");
        for (const x of [0.5, box.width - 0.5]) {
          await chart.hover({ position: { x, y: box.height / 2 } });
          await expect(chart.locator("circle").first()).toBeVisible();
          const hovered = await measure();
          expect(hovered.dots, `${metric} at ${width}px, x ${x}`).toBeGreaterThan(0);
          expect(hovered.dotsInside && hovered.allInside, `${metric} at ${width}px, x ${x}: ${JSON.stringify(hovered)}`).toBe(true);
        }
        await page.mouse.move(0, 0);
      }
    }
    await card(frame).screenshot({ path: test.info().outputPath("history-light-500.png") });
  });

  test("light shows only Now, and Overview draws each zone's last 4 hours of light", async ({ page }) => {
    const frame = await garden(page);
    await expect(app(frame).getByRole("img", { name: "Light (Average) in Garden over the last 4 hours" })).toBeVisible();
    await goTo(frame, "Garden");
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
    await goTo(frame, "Garden");
    await expect(row(frame, "Environment right").locator("td")).toHaveText(["Environment right", "--", "--", "--"]);
    await expect(card(frame).locator(".chart-note")).toContainText("Home Assistant has kept 12 hours of these readings");
  });

  test("what's showing can be made what a zone's History opens on, through a review, and each zone keeps its own", async ({ page }) => {
    const frame = await garden(page);
    await tab(frame, "Garden").click();
    const button = (name: string) => card(frame).getByRole("button", { name, exact: true });
    const always = card(frame).getByRole("button", { name: /^Always open on / });
    const opensOn = () => page.evaluate<unknown>("JSON.parse(fakeHA.disk).zones[0].history ?? null");
    await expect(button("Temp")).toHaveAttribute("aria-pressed", "true");
    await expect(button("24h")).toHaveAttribute("aria-pressed", "true");
    /* Nothing to offer while it shows what it opens on. */
    await expect(always).toHaveCount(0);
    await button("RH").click();
    await button("72h").click();
    await expect(always).toHaveText("Always open on Humidity, 72h ›");
    /* Offered at the foot of the card, under the chart and its table, so it never moves them. */
    expect((await always.boundingBox())!.y).toBeGreaterThan((await card(frame).locator("table").boundingBox())!.y);
    await always.click();
    const dialog = app(frame).getByRole("dialog");
    await expect(dialog.locator(".review-row")).toHaveText(["Garden's History opens onTemperature, 24h → Humidity, 72h"]);
    expect(await opensOn()).toBeNull();
    await dialog.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(app(frame).locator(".toast")).toHaveText("Garden's History now opens on Humidity, 72h.");
    await expect(always).toHaveCount(0);
    expect(await opensOn()).toEqual({ metric: "humidity", hours: 72 });
    expect(await serviceCalls(page)).toBe(0);
    /* Another zone still opens on what every zone starts with, and coming back to Garden opens on its own. */
    await goTo(frame, "Veg");
    await expect(button("Temp")).toHaveAttribute("aria-pressed", "true");
    await expect(button("24h")).toHaveAttribute("aria-pressed", "true");
    await goTo(frame, "Garden");
    await expect(button("RH")).toHaveAttribute("aria-pressed", "true");
    await expect(button("72h")).toHaveAttribute("aria-pressed", "true");
    /* Looking at something else for now changes nothing stored, and offers itself in turn. */
    await button("VPD").click();
    await expect(always).toHaveText("Always open on VPD, 72h ›");
    expect(await opensOn()).toEqual({ metric: "humidity", hours: 72 });
    /* Choosing what every zone starts with again stores nothing. */
    await button("Temp").click();
    await button("24h").click();
    await always.click();
    await expect(dialog.locator(".review-row")).toHaveText(["Garden's History opens onHumidity, 72h → Temperature, 24h"]);
    await dialog.getByRole("button", { name: "Apply 1 change" }).click();
    await expect.poll(opensOn).toBeNull();
  });

  test("switching metric or range keeps the card's place on the page while the new readings load", async ({ page }) => {
    const frame = await garden(page);
    await goTo(frame, "Garden");
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
    await goTo(frame, "Garden");
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

test.describe("chip groups", () => {
  test("a line parts the graph chips from the range chips while they share a line, and none dangles once they don't", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(PAGE);
    const frame = await panelFrame(page);
    await goTo(frame, "Garden");
    const history = app(frame).locator("section.card", { has: frame.getByRole("heading", { name: "History", exact: true }) }).locator(".card-head .row");
    await expect(history.locator(".seg")).toHaveCount(2);
    expect(await segDivider(history)).toEqual({ sameLine: true, shown: true, between: true });
    await page.setViewportSize({ width: 400, height: 900 });
    await expect.poll(() => segDivider(history)).toEqual({ sameLine: false, shown: false, between: false });
    /* Appearance's rows on Setup have the same two groups for each zone. */
    await goTo(frame, "Setup");
    const opens = app(frame).locator(".opens-row .row");
    await expect(opens).toHaveCount(3);
    for (const row of await opens.all()) expect(await segDivider(row)).toEqual({ sameLine: false, shown: false, between: false });
    await page.setViewportSize({ width: 1100, height: 900 });
    for (const row of await opens.all()) await expect.poll(() => segDivider(row)).toEqual({ sameLine: true, shown: true, between: true });
  });
});
