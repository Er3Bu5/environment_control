/* The frame asks for a zone's Activity by zone id and a time page. The host forwards only those, checked against its
   own copy of the setup, and hands back only the fields it knows, so the frame can neither name an entity to the backend
   nor receive anything the backend adds later. */
import { type Frame, type Page, expect, test } from "@playwright/test";
import { PAGE, panelFrame } from "./helpers";

type Answer = { ok: boolean; error?: string; code?: string; activity?: Record<string, unknown> };
const HOUR = 3600;

/* Plays the backend's Activity command: records what reaches it, and answers with the given page or fails with a code. */
async function fakeActivity(page: Page, answer: unknown, fail?: { code: string; message: string }): Promise<void> {
  await page.evaluate(`(() => {
    window.activitySent = [];
    const send = fakeHA.command.bind(fakeHA), answer = ${JSON.stringify(answer)}, fail = ${JSON.stringify(fail || null)};
    fakeHA.command = async (msg) => {
      if (!msg || msg.type !== "environment_control/activity") return send(msg);
      window.activitySent.push(msg);
      if (fail) { const e = new Error(fail.message); e.code = fail.code; throw e; }
      return answer;
    };
  })()`);
}
const sent = (page: Page) => page.evaluate<Record<string, unknown>[]>("window.activitySent");

let nextReq = 900;
/* Posts a raw message from the frame, as a frame that had been taken over could, and resolves to the host's answer. */
function ask(frame: Frame, msg: Record<string, unknown>): Promise<Answer> {
  const req = nextReq++;
  return frame.evaluate(
    ({ msg, req }) =>
      new Promise<Answer>((resolve) => {
        window.addEventListener("message", (e) => { if (e.data?.type === "result" && e.data.req === req) resolve(e.data); });
        parent.postMessage({ v: 1, type: "activity", req, ...msg }, "*");
      }),
    { msg, req },
  );
}

const now = () => Math.floor(Date.now() / 1000);
const EMPTY = { zone: "garden", start: 0, end: 0, earliest: 0, more: false, next_end: null, entries: [] };

test("a good Activity request reaches the backend with only the zone and the page", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await fakeActivity(page, EMPTY);
  const end = now(), start = end - 24 * HOUR;
  const answer = await ask(frame, { zone: "garden", start, end, entity: "switch.anything", entities: ["switch.anything"], hours: 24 });
  expect(answer.ok).toBe(true);
  expect(await sent(page)).toEqual([{ type: "environment_control/activity", zone: "garden", start, end }]);
});

test("a malformed Activity request is refused and nothing reaches the backend", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  await fakeActivity(page, EMPTY);
  const end = now(), start = end - 24 * HOUR;
  const bad: Record<string, unknown>[] = [
    { zone: "nowhere", start, end },
    { zone: "switch.garden_dehumidifier", start, end },
    { zone: ["garden"], start, end },
    { start, end, entity: "switch.garden_dehumidifier" },
    { zone: "garden", start: end - 26 * HOUR, end },
    { zone: "garden", start: end, end: start },
    { zone: "garden", start: end, end },
    { zone: "garden", start: String(start), end },
    { zone: "garden", start, end: null },
    { zone: "garden", start: -HOUR, end: 0 },
    { zone: "garden", start: end + 30 * HOUR, end: end + 31 * HOUR },
  ];
  for (const msg of bad) {
    const answer = await ask(frame, msg);
    expect(answer.ok, JSON.stringify(msg)).toBe(false);
    expect(answer.error, JSON.stringify(msg)).toBeTruthy();
  }
  expect(await sent(page)).toEqual([]);
});

test("only the known fields of an Activity answer reach the frame", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  const end = now(), start = end - 24 * HOUR;
  const device = { kind: "device", when: end - 60, entity: "switch.garden_dehumidifier", name: "Dehumidifier", state: "on",
    cause: { type: "automation", name: "Day humidity", entity: "automation.day_humidity", trigger: { kind: "state", name: "Humidity", source: "state of sensor.x" }, context_id: "c1" },
    context_user_id: "u1" };
  const run = { kind: "run", when: end - 120, entity: "automation.day_humidity", name: "Day humidity", trigger: { kind: "time", extra: 1 }, count: 3, first: end - 400, last: end - 120, source: "time" };
  const odd = { kind: "secret", when: end - 30, entity: "lock.front_door" };
  const many = Array.from({ length: 600 }, (_, i) => ({ ...run, when: end - 1000 - i }));
  await fakeActivity(page, { zone: "garden", start, end, earliest: start - HOUR, more: true, next_end: end - 120, extra: "x", entries: [device, run, odd, ...many] });
  const answer = await ask(frame, { zone: "garden", start, end });
  expect(answer.ok).toBe(true);
  const activity = answer.activity!;
  expect(Object.keys(activity).sort()).toEqual(["earliest", "end", "entries", "more", "next_end", "start", "zone"]);
  const entries = activity.entries as Record<string, unknown>[];
  expect(entries.length).toBeLessThanOrEqual(500);
  expect(entries[0]).toEqual({ kind: "device", when: end - 60, entity: "switch.garden_dehumidifier", name: "Dehumidifier", state: "on",
    cause: { type: "automation", name: "Day humidity", entity: "automation.day_humidity", trigger: { kind: "state", name: "Humidity" } } });
  expect(entries[1]).toEqual({ kind: "run", when: end - 120, entity: "automation.day_humidity", name: "Day humidity", trigger: { kind: "time" }, count: 3, first: end - 400, last: end - 120 });
  expect(entries.some((e) => e.kind === "secret")).toBe(false);
});

test("a busy or slow logbook reaches the frame as its own code, apart from other refusals", async ({ page }) => {
  await page.goto(PAGE);
  const frame = await panelFrame(page);
  const end = now(), start = end - 24 * HOUR;
  const codes: Record<string, string | undefined> = {};
  for (const code of ["busy", "timeout", "no_logbook", "something_else"]) {
    await fakeActivity(page, EMPTY, { code, message: `Failed: ${code}` });
    const answer = await ask(frame, { zone: "garden", start, end });
    expect(answer).toEqual(expect.objectContaining({ ok: false, error: `Failed: ${code}` }));
    codes[code] = answer.code;
  }
  expect(codes).toEqual({ busy: "busy", timeout: "timeout", no_logbook: "no_logbook", something_else: undefined });
});
