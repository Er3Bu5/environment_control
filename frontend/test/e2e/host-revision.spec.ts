/* The host checks what a save would make controllable against its own copy of the setup, so it must not act on a save
   built on a newer setup than that copy. Another window's save reaches the backend the way that window's host sends it,
   and this page's host hears nothing of it until it asks. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, hostDialogOpen, panelFrame } from "./helpers";

type Link = { id: string; entity: string; group: string };
type Stored = { revision: number; zones: { id: string; automations?: Link[] }[]; devices: unknown[]; room?: Record<string, unknown> };
const stored = (page: Page) => page.evaluate<Stored>("JSON.parse(JSON.stringify(fakeHA.config))");
const CONFLICT = "Setup was saved from somewhere else since this was opened. Reopen the panel to see it.";
const HIGH = "automation.critical_garden_temperature_high_day";

/* Unlinks an automation from Garden as another window would, and hands back the link and what was stored after. */
async function unlinkElsewhere(page: Page): Promise<{ link: Link; after: Stored }> {
  const before = await stored(page);
  const garden = before.zones.find((z) => z.id === "garden")!;
  const link = garden.automations!.find((a) => a.entity === HIGH)!;
  const zones = before.zones.map((z) => (z.id === "garden" ? { ...z, automations: z.automations!.filter((a) => a.entity !== HIGH) } : z));
  const config = { zones, devices: before.devices, ...(before.room ? { room: before.room } : {}) };
  await page.evaluate(`fakeHA.command(${JSON.stringify({ type: "environment_control/config/save", revision: before.revision, config })})`);
  const after = await stored(page);
  expect(after.revision).toBe(before.revision + 1);
  return { link, after };
}

/* A save on top of what's stored now that links the automation back, sent by the frame as a raw message. Resolves to the
   answer and the revision of any setup the host handed the frame before answering. */
function relink(frame: Frame, after: Stored, link: Link) {
  return frame.evaluate(
    ({ after, link }) =>
      new Promise<{ answer: { ok: boolean; error?: string }; given: number | null }>((resolve) => {
        let given: number | null = null;
        window.addEventListener("message", (e) => {
          if (e.data?.type === "config") given = e.data.revision;
          if (e.data?.type === "result" && e.data.req === 778) resolve({ answer: e.data, given });
        });
        const zones = after.zones.map((z) => (z.id === "garden" ? { ...z, automations: [...(z.automations || []), link] } : z));
        parent.postMessage({ v: 1, type: "save", req: 778, base: after.revision, config: { zones, devices: after.devices, room: after.room } }, "*");
      }),
    { after, link },
  );
}

test("a save built on a newer setup than the host holds is answered as a conflict, not forwarded", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  const { link, after } = await unlinkElsewhere(page);
  const { answer, given } = await relink(frame, after, link);
  expect(answer).toEqual(expect.objectContaining({ ok: false, error: CONFLICT }));
  expect(given).toBe(after.revision);
  expect(await hostDialogOpen(page)).toBe(false);
  expect(await stored(page)).toEqual(after);
});

test("a save built on a newer setup is refused when the host can't read the setup again", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  const { link, after } = await unlinkElsewhere(page);
  await page.evaluate(`(() => { const send = fakeHA.command.bind(fakeHA); fakeHA.command = async (msg) => { if (msg.type === "environment_control/config") fakeHA.fail("Home Assistant is restarting"); return send(msg); }; })()`);
  const { answer, given } = await relink(frame, after, link);
  expect(answer).toEqual(expect.objectContaining({ ok: false, error: CONFLICT }));
  expect(given).toBe(null);
  expect(await stored(page)).toEqual(after);
});
