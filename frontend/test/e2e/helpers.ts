/* What every browser test needs: the page that plays Home Assistant, the panel's frame inside it, and the host's own
   dialog, which only DevTools can see. Shared by the spec files so each doesn't carry its own copy. */
import { type Frame, type Locator, type Page, expect } from "@playwright/test";

export const PAGE = "/frontend/test/e2e/page.html";

export async function panelFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().length).toBeGreaterThan(1);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("no frame");
  await frame.waitForSelector("ec-app");
  return frame;
}
export const frameText = (frame: Frame) => frame.evaluate(() => document.querySelector("ec-app")?.shadowRoot?.textContent ?? "");
export const app = (frame: Frame) => frame.locator("ec-app");
/* The pages are in a menu behind one button. A test names a page the way it always did; going there opens the menu. */
export const tab = (frame: Frame, name: string) => app(frame).getByRole("navigation").getByRole("menuitem", { name, exact: true });
export async function openNav(frame: Frame): Promise<void> {
  const button = app(frame).getByRole("navigation").getByRole("button", { name: "Menu", exact: true });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}
export async function goTo(frame: Frame, name: string): Promise<void> {
  await openNav(frame);
  await tab(frame, name).click();
}
/* A zone's targets and activity are in the menu at the right of its heading. */
export const moreButton = (frame: Frame) => app(frame).locator(".pagehead").getByRole("button", { name: "More", exact: true });
export async function zoneMenu(frame: Frame, item: string): Promise<void> {
  await moreButton(frame).click();
  await app(frame).getByRole("menuitem", { name: item, exact: true }).click();
}
export const leaveAsks = (page: Page) =>
  page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
/* A button in the host's open dialog, by its data-host name: its centre on the page, or null when there's none. The
   dialog is in the host's closed shadow root, so only DevTools can find it. */
export async function hostButton(page: Page, name: string): Promise<{ x: number; y: number } | null> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let button: number | null = null;
  const walk = (n: { nodeId: number; nodeName: string; attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[] }, inDialog: boolean) => {
    const attrs = n.attributes || [], open = inDialog || (n.nodeName === "DIALOG" && attrs.includes("open"));
    if (open && n.nodeName === "BUTTON" && attrs[attrs.indexOf("data-host") + 1] === name && attrs.includes("data-host")) button = n.nodeId;
    if (n.nodeName === "IFRAME") return;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c as typeof n, open);
  };
  walk(root as Parameters<typeof walk>[0], false);
  if (button === null) { await cdp.detach(); return null; }
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId: button });
  await cdp.detach();
  const q = model.content;
  return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
}
/* The page declares these with let and const, so they are globals but not window properties: read them as expressions. */
export const route = (page: Page) => page.evaluate<string>("haRoute");
export const serviceCalls = (page: Page) => page.evaluate<number>("fakeHA.calls.length");
/* The host's dialog lives in its closed shadow root, out of the page's reach. DevTools can still see it. */
export async function hostDialogText(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  type N = { nodeName: string; nodeType: number; nodeValue?: string; attributes?: string[]; children?: N[]; shadowRoots?: N[] };
  const out: string[] = [];
  const walk = (n: N, inside: boolean) => {
    if (n.nodeName === "IFRAME" || n.nodeName === "STYLE") return;
    const here = inside || (n.nodeName === "DIALOG" && (n.attributes || []).includes("open"));
    if (here && n.nodeType === 3 && n.nodeValue?.trim()) out.push(n.nodeValue.trim());
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
  };
  walk(root as N, false);
  await cdp.detach();
  return out.join(" ");
}
/* A dialog's buttons, leaving first and going on second, sit in a row at the foot of the dialog's own box, at its right,
   and in the window. */
export async function dialogFoot(box: Locator, names: (string | RegExp)[]): Promise<void> {
  const foot = box.locator(".dlgfoot"), buttons = foot.getByRole("button");
  await expect(buttons).toHaveText(names);
  const d = (await box.boundingBox())!, f = (await foot.boundingBox())!;
  for (const b of await buttons.all()) {
    const r = (await b.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(d.x);
    expect(r.x + r.width).toBeLessThanOrEqual(d.x + d.width);
    expect(r.y).toBeGreaterThanOrEqual(d.y);
    expect(r.y + r.height).toBeLessThanOrEqual(d.y + d.height);
    await expect(b).toBeInViewport({ ratio: 1 });
  }
  /* At the dialog's bottom edge, inside its padding, and right-aligned. */
  expect(d.y + d.height - (f.y + f.height)).toBeLessThanOrEqual(24);
  const last = (await buttons.last().boundingBox())!;
  expect(d.x + d.width - (last.x + last.width)).toBeLessThanOrEqual(24);
}
/* A graph's chips and a range's, in the box that holds both: whether they share a line, and whether the line between
   them is drawn, and drawn in the gap between them. The line is clipped to the box, so one outside it isn't seen. */
export const segDivider = (row: Locator) =>
  row.evaluate((el) => {
    const [a, b] = [...el.querySelectorAll(":scope > .seg")].map((x) => x.getBoundingClientRect()), box = el.getBoundingClientRect();
    const line = getComputedStyle(el.querySelectorAll(":scope > .seg")[1], "::before"), x = b.left + parseFloat(line.left);
    const drawn = line.content !== "none" && line.content !== "normal" && line.display !== "none" && parseFloat(line.width) > 0 && x >= box.left;
    return { sameLine: Math.abs(a.top - b.top) < 2, shown: drawn, between: drawn && x > a.right && x + parseFloat(line.width) < b.left };
  });
export async function hostDialogOpen(page: Page): Promise<boolean> {
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
