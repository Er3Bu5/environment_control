// Drives the mock in headless Chromium over CDP with real taps and keystrokes. Touches nothing outside the scratchpad.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";

/* MOCK_PORT lets runs in different worktrees go side by side; each run needs its own DevTools port. */
const port = Number(process.env.MOCK_PORT || 9347);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.log(`Error MOCK_PORT must be a whole number from 1024 to 65535, not "${process.env.MOCK_PORT}"`); process.exit(2); }
/* A port another run's Chromium already holds would hand this run that browser's DevTools, and the two runs would drive one page. */
await new Promise((ok) => { const probe = createServer().once("error", () => { console.log(`Error port ${port} is in use: another run may hold it, so pick a free one with MOCK_PORT`); process.exit(2); }).listen(port, "127.0.0.1", () => probe.close(ok)); });
const dir = process.argv[2], profile = `${dir}/chromium-profile`;
process.on("uncaughtException", (e) => { console.log("Error", e.message); browser.kill(); process.exit(2); });
/* CHROMIUM_FLAGS adds flags for one machine, such as --no-sandbox on CI runners where Chromium's own sandbox can't start. */
const extraFlags = (process.env.CHROMIUM_FLAGS || "").split(" ").filter(Boolean);
const browser = spawn("chromium", [...extraFlags, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--disable-features=IsolateSandboxedIframes", "--disable-site-isolation-trials", "about:blank"], { stdio: "ignore" });
/* Chromium keeps writing its profile for a moment after the kill, so wait for it to exit before removing it. */
const finish = async () => { const gone = new Promise((r) => browser.once("exit", r)); browser.kill(); await gone; rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exit(fail ? 1 : 0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let info;
for (let n = 0; n < 50 && !info; n++) { await sleep(200); try { info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch {} }
if (!info) { console.log("Error Chromium didn't start: no DevTools on port " + port); browser.kill(); process.exit(2); }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0, frameContext; const waiting = new Map(), exceptions = [], contexts = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.executionContextCreated" && d.params.context.auxData && d.params.context.auxData.isDefault) contexts.push(d.params.context);
  if (d.method === "Runtime.exceptionThrown") exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const rawSend = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
/* Tests measure inside the frame, but pointer events land on the page, so they're shifted by where the panel sits under HA's bar. */
let frameOffset = { x: 0, y: 0 };
const send = (method, params = {}) => rawSend(method, method.startsWith("Input.") && "x" in params ? { ...params, x: params.x + frameOffset.x, y: params.y + frameOffset.y } : params);
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, ...(frameContext ? { contextId: frameContext } : {}) }); if (r.result.exceptionDetails) throw new Error(expression + " -> " + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, JSON.stringify(got)); } };
const phone = async (w, h) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true }); await send("Emulation.setTouchEmulationEnabled", { enabled: true }); };
const shot = async (name) => { await sleep(120); const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(`${dir}/${name}.png`, Buffer.from(r.result.data, "base64")); };
async function tap(sel) {
  const p = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await sleep(40);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(120);
}
const type = async (text) => { await send("Input.insertText", { text }); await sleep(30); };
const key = async (name, code) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code }); await sleep(60); };
const band = (k, i) => ev(`ui.vpdw.bands[ui.vpdw.period].${k}[${i}]`);
const active = () => ev(`document.activeElement.id`);
const issueText = () => ev(`[...document.querySelectorAll("#v-issues .notice span:first-child")].map(x=>x.textContent)`);
const saveOff = () => ev(`document.querySelector("[data-dreview]").disabled`);
const open = async () => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.mapw=null;ui.wiz=null;ui.leafw=null;openVpd(zones[0].id);render();window.scrollTo(0,0)`); await sleep(40); };
const clickIt = async (sel) => { await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(50); };

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await phone(390, 844);
/* The page plays Home Assistant: the fake HA and the host element sit on it, and the UI runs in the host's sandboxed frame, as it will in HA. */
/* SMOKE compares against the snapshot, so on the sample room every reading check fails and reads as a fault in the build. */
const smoke = process.env.SMOKE;
execFileSync("python3", [`${dir}/build-mock.py`, dir, process.env.MOCK_FILE || (smoke ? "snapshot-ui.html" : "environment-control-source.html"), process.env.SEED_FILE || (smoke ? "snapshot-seed.js" : "sample-seed.js"), "mock-dev.html"]);
writeFileSync(`${dir}/mock-page.html`, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync(`${dir}/mock-dev.html`, "utf8")}</body></html>`);
await send("Page.navigate", { url: `file://${dir}/mock-page.html` });
await sleep(1200);
let topContext;
for (const c of contexts) {
  const r = await send("Runtime.evaluate", { expression: "window.self !== window.top", returnByValue: true, contextId: c.id });
  if (r.result && r.result.result && r.result.result.value === true) frameContext = c.id;
  else if (r.result && r.result.result && r.result.result.value === false) topContext = c.id;
}
/* Runs on the page that plays HA, outside the sandbox. */
const onHA = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId: topContext }); if (r.result.exceptionDetails) throw new Error(expression + " -> " + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
frameOffset = await onHA(`(()=>{const r=document.querySelector("environment-control-panel").getBoundingClientRect();return {x:r.left,y:r.top}})()`);
console.log("IN FRAME:", await ev(`window.self !== window.top`), "origin:", await ev(`location.origin + " / " + self.origin`));
/* The frame holds the whole UI, so it's where a bad dependency or an injected name would run. It must reach nothing. */
const escaped = await (async () => { const r = await send("Runtime.evaluate", { expression: `(async()=>{const r={};try{parent.document.title;r.parent="read"}catch{r.parent="blocked"}try{localStorage.length;r.storage="read"}catch{r.storage="blocked"}try{document.cookie;r.cookie="read"}catch{r.cookie="blocked"}try{await fetch("data:text/plain,x");r.fetch="sent"}catch{r.fetch="blocked"}const s=document.createElement("script");s.textContent="window.__injected=1";document.head.append(s);await new Promise(r=>setTimeout(r,50));r.script=window.__injected?"ran":"blocked";return r})()`, returnByValue: true, awaitPromise: true, contextId: frameContext }); return r.result.result.value; })();
check("Sandbox: the frame can't reach HA's page, storage or cookies, can't fetch, and an injected script doesn't run", JSON.stringify(escaped) === JSON.stringify({ parent: "blocked", storage: "blocked", cookie: "blocked", fetch: "blocked", script: "blocked" }), escaped);
const sandboxed = await onHA(`(()=>{const p=document.querySelector("environment-control-panel");return {shadowClosed:p.shadowRoot===null,frames:document.querySelectorAll("iframe").length}})()`);
check("Sandbox: the frame sits in the host's closed shadow root, out of the page's reach", sandboxed.shadowClosed && sandboxed.frames === 0, sandboxed);

// A real-data build has no fixture to test against, so this checks it against what Home Assistant reported.
if (process.env.SMOKE) {
  const want = JSON.parse(readFileSync(`${dir}/ha-snap/expect.json`, "utf8"));
  const go = async (e) => { await ev(e); await sleep(90); };
  const clean = async (name) => { const t = await ev(`document.querySelector("#main").textContent`); check(`${name}: no NaN or undefined`, !/NaN|undefined/.test(t), t.match(/.{30}(NaN|undefined).{30}/)?.[0]); };
  const close = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;
  for (const [id, w] of Object.entries(want.zones)) {
    const n = await ev(`zoneById("${id}").now`);
    check(`${id}: temperature matches HA`, close(n.temperature, w.temperature, 0.06), [n.temperature, w.temperature]);
    check(`${id}: humidity matches HA`, close(n.humidity, w.humidity, 0.1), [n.humidity, w.humidity]);
    check(`${id}: VPD matches HA`, close(n.vpd, w.vpd, 0.012), [n.vpd, w.vpd]);
    // A zone with no light sensor has no light reading to compare, only the absence of one.
    check(`${id}: light matches HA`, w.light === null ? n.light === null : close(n.light, w.light, 1), [n.light, w.light]);
  }
  await go(`ui.screen="overview";render()`); await clean("Overview"); await shot("real-overview");
  check("Overview: every zone with light draws its graph", (await ev(`document.querySelectorAll("#main .zone-card svg.lspark").length`)) === (await ev(`zones.filter(z=>lightLine(z)).length`)));
  for (const z of ["garden", "veg", "nursery", "breeding"]) { await go(`ui.screen="zone";ui.zone="${z}";render()`); await clean(z); await shot(`real-${z}`); }
  for (const [s, name] of [["devices", "Devices"], ["setup", "Setup"]]) { await go(`ui.screen="${s}";render()`); await clean(name); }
  check("Setup: no made-up tasks left", (await ev(`document.querySelectorAll("#main [data-role], #main [data-answer]").length`)) === 0);
  for (const id of ["garden", "veg", "nursery", "breeding"]) {
    await go(`ui.screen="zone";ui.zone="${id}";render()`);
    const windows = {}, kinds = ["temperature", "humidity", "vpd", ...(want.zones[id].light === null ? [] : ["light"])];
    for (const k of kinds) for (const h of [6, 24, 72, 168]) {
      await go(`ui.metric="${k}";ui.range=${h};render()`); await clean(`${id} ${k} ${h}h`);
      const r = await ev(`(()=>{const c=chartNow,x=c.rows[0],s=chartStats(x.line);return {now:fmt("${k}",x.line[c.n].v),tile:fmt("${k}",zoneById("${id}").now.${k}),min:s.min.v,max:s.max.v,n:c.n,note:document.querySelector("#chart-note").textContent}})()`);
      check(`${id} ${k} ${h}h: the chart's Now is the tile's reading`, r.now === r.tile, r);
      windows[`${k}${h}`] = r;
    }
    for (const k of kinds) for (const [a, b] of [[6, 24], [24, 72], [72, 168]]) {
      const small = windows[`${k}${a}`], big = windows[`${k}${b}`], slack = (big.max - big.min) * 0.02 + 0.01;
      check(`${id} ${k}: ${b}h holds ${a}h's min and max`, big.min <= small.min + slack && big.max >= small.max - slack, [small.min, big.min, small.max, big.max]);
    }
    check(`${id}: HA holds all of 7d, so no note`, windows.temperature168.note === "", windows.temperature168.note);
    check(`${id}: 7d doesn't say that`, windows.temperature168.note === "", windows.temperature168.note);
  }
  await go(`ui.screen="zone";ui.zone="garden";ui.metric="vpd";ui.range=168;render();document.querySelector("#chart").scrollIntoView({block:"start"})`); await shot("real-chart-7d");
  await go(`ui.metric="light";ui.range=168;render();document.querySelector("#chart").scrollIntoView({block:"start"})`); await shot("real-chart-light");
  await go(`ui.metric="vpd";ui.range=24;render();document.querySelector('[data-cgroup="Lights"]').scrollIntoView({block:"start"})`); await shot("real-lights");
  const lit = await ev(`[...document.querySelectorAll('[data-cgroup="Lights"] .dev')].map(d=>d.textContent)`);
  check("Lights: Garden lists its controllers and plugs", lit.length === 8, lit);
  check("Lights: the controllers show HA's brightness", (await ev(`document.querySelectorAll('[data-cgroup="Lights"] input[type=range]').length`)) === 2 && lit[0].includes(want.lights.overhead === null ? "Off." : `On, ${want.lights.overhead}%`), lit[0]);
  for (const [id, want2] of Object.entries(want.sched)) {
    await go(`ui.screen="setup";render();document.querySelector('[data-vpd="${id}"]').click()`); await clean(`${id} Targets, day and night`);
    const v = await ev(`ui.sched.vals`);
    check(`${id} Day and night: the page holds HA's times, and no light limits`, v.day === want2.day && v.night === want2.night && v.dayMin === undefined && v.nightMax === undefined, v);
    await shot(`real-sched-${id}`);
    await go(`document.querySelector("[data-tdexit]").click()`);
    await go(`ui.screen="zone";ui.zone="${id}";render();document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="${id}"]').click()`);
    const rows = await ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[...t.querySelectorAll("tr")].pop().textContent)`);
    const dark = want2.dayMin === null && want2.nightMax === null;
    if (dark) check(`${id} Targets: View targets has no light limits`, !rows.some((r) => r.startsWith("Light")), rows);
    else check(`${id} Targets: View targets holds HA's light limits`, rows[0] === `Lightlx${want2.dayMin.toLocaleString("en-NZ")}` && rows[1] === `Lightlx${want2.nightMax.toLocaleString("en-NZ")}`, rows);
    await go(`document.querySelector('[data-tset="${id}"]').click();ui.vpdw.period="day";render()`); await clean(`${id} Targets`);
    const day = await ev(`document.querySelector("#vin-light-0")?.value ?? null`);
    await go(`ui.vpdw.period="night";render()`);
    const night = await ev(`document.querySelector("#vin-light-0")?.value ?? null`);
    if (dark) check(`${id} Targets: no light limit boxes`, day === null && night === null, [day, night]);
    else check(`${id} Targets: the boxes hold HA's light limits`, Number(day) === want2.dayMin && Number(night) === want2.nightMax, [day, night]);
    await go(`document.querySelector("[data-tdexit]").click()`);
  }
  await go(`ui.screen="setup";render();document.querySelector('[data-vpd="garden"]').click()`);
  check("Emerson: the red windows match HA's failsafe sum", (await ev(`document.querySelector("#s-em").textContent`)) === want.emerson, await ev(`document.querySelector("#s-em").textContent`));
  await go(`document.querySelector("[data-tdexit]").click()`);
  await go(`ui.screen="setup";render();document.querySelector('[data-vpd="veg"]').click()`);
  check("Schedule: Veg says Nursery shares its helpers", (await ev(`document.querySelector("#s-times").textContent`)).includes("Nursery uses the same helpers"));
  await go(`document.querySelector("[data-tdexit]").click()`);
  for (const z of ["garden", "veg", "nursery", "breeding"]) for (const p of ["day", "night"]) {
    const r = await ev(`(()=>{openVpd("${z}");const v=ui.vpdw;v.period="${p}";const i=vIssues(v,v.bands["${p}"]).map(x=>x.text);ui.vpdw=null;ui.td=null;ui.sched=null;return i})()`);
    check(`${z} ${p}: limits are valid and something fits`, r.length === 0, r);
  }
  check("Red lights: Garden's come from its helpers, and Veg, Nursery and Breeding don't use them", JSON.stringify(await ev(`["garden","veg","nursery","breeding"].map(id=>emersonModeOf(zoneById(id)))`)) === JSON.stringify(["helper", "none", "none", "none"]));
  check("Targets: only Garden has target helpers, so only Garden aims for a target", JSON.stringify(await ev(`["garden","veg","nursery","breeding"].map(id=>hasTarget(zoneById(id).bands))`)) === JSON.stringify([true, false, false, false]));
  for (const id of ["veg", "nursery", "breeding"]) {
    await go(`ui.screen="zone";ui.zone="${id}";render()`);
    check(`${id}: no Target tick, and - in its table`, (await ev(`document.querySelectorAll("#main .track .tick").length`)) === 0 && !/null/.test(await ev(`document.querySelector("#main").textContent`)) && (await ev(`(()=>{const d=document.createElement("div");d.innerHTML=targetsTable(zoneById(ui.zone));return d.querySelector("tbody tr").textContent})()`)).includes("-"));
  }
  /* Nothing in the real room is placed yet, so every zone's map says so, and says it's fine. */
  for (const id of ["garden", "veg", "nursery", "breeding"]) {
    await go(`ui.screen="zone";ui.zone="${id}";ui.level="all";render()`);
    const n = await ev(`placeable(zoneById("${id}")).length`), note = await ev(`document.querySelector("#unplaced-${id}")?.textContent || ""`);
    const wall = (await ev(`[...document.querySelectorAll("#main .map svg title")].some(t=>t.textContent==="Wall")`)) === true;
    // Breeding's lights are switched by hand, so it has nothing to control and nothing to place.
    if (id === "breeding") check(`${id}: a wall round the map, and no devices to name`, n === 0 && wall && note === "", [n, note]);
    else check(`${id}: a wall round the map, and its ${n} devices named as not on it`, n > 0 && wall && note.startsWith(`${n} device`) && note.includes("They don't need to be"), note);
  }
  const snap = JSON.parse(readFileSync(`${dir}/ha-snap/states.json`, "utf8")), snapIds = Array.isArray(snap) ? snap.map((s) => s.entity_id) : Object.keys(snap);
  /* The automations snapshot brings the alert repeat helper, which the states snapshot may predate. */
  const autoSnap = existsSync(`${dir}/ha-snap/automations.json`) ? JSON.parse(readFileSync(`${dir}/ha-snap/automations.json`, "utf8")) : null;
  if (autoSnap && autoSnap.repeat && !snapIds.includes(autoSnap.repeat.entity)) snapIds.push(autoSnap.repeat.entity);
  for (const id of ["garden", "veg", "nursery"]) {
    await go(`ui.screen="setup";openTd("${id}");render()`); await sleep(150); await clean(`${id} Targets, day and night helpers`);
    const r = await ev(`({issues:tdIssues().map(i=>i.text),changes:tdDraft(ui.td).items.length,numbers:helperCatalog.filter(h=>h.entity.startsWith("input_number.")).length})`);
    check(`${id} Targets, day and night: every helper it links is offered, in the right unit`, r.issues.length === 0, r.issues);
    check(`${id} Targets, day and night: opening it changes nothing`, r.changes === 0, r.changes);
    check(`${id} Targets, day and night: every number helper HA reported is offered`, r.numbers === snapIds.filter((e) => e.startsWith("input_number.")).length, r.numbers);
    if (id === "garden") { await go(`ui.vpdw.period="day";render();document.querySelector("#map-l-bands-day-temperature-min").scrollIntoView({block:"center"})`); await shot("real-map-links"); }
  }
  /* The real room's automations, grouped as its dashboards group them. */
  /* An automation belongs to one zone, so one the snapshot lists under two (Nursery's shared cards) stays with the first. */
  const onPage = (x, page) => (page === "alert" ? x.group.startsWith("alert_") : x.group === page);
  const owner = {};
  if (autoSnap) for (const id of ["garden", "veg", "nursery", "breeding"]) for (const x of autoSnap.links[id] || []) owner[x.entity] ??= id;
  if (autoSnap) for (const page of ["alert", "failsafe", "control"]) {
    const listed = new Set(Object.values(autoSnap.links).flat().filter((x) => onPage(x, page)).map((x) => x.entity));
    let shown = 0;
    for (const id of ["garden", "veg", "nursery", "breeding"]) {
      await go(`ui.autos=null;renderModal();ui.linkw=null;ui.screen="zone";ui.zone="${id}";render();openAutos("${id}","${page}")`);
      const rows = await ev(`document.querySelectorAll("#modal [data-autorow]").length`), want = (autoSnap.links[id] || []).filter((x) => onPage(x, page) && owner[x.entity] === id).length;
      shown += rows;
      check(`${id}: the ${page} chip lists every one on its dashboard`, rows === want, [rows, want]);
      if (id === "garden" && page === "alert") await shot("real-alerts");
    }
    check(`every ${page} on a dashboard is listed, in one zone`, shown === listed.size && listed.size > 0, [shown, listed.size]);
  }
  await go(`ui.autos=null;renderModal();ui.td=null;ui.sched=null;ui.vpdw=null;ui.screen="setup";render()`);
  await go(`ui.screen="setup";render();document.querySelector('[data-calw="garden"]').click()`); await clean("Sensor Calibration");
  await go(`ui.leafw=null;ui.screen="setup";render()`);
  check("Setup: Sensor Calibration sits before Targets in every zone", (await ev(`["garden","veg","nursery"].every(z=>document.querySelector('[data-calw="'+z+'"]').nextElementSibling.dataset.vpd===z)`)) === true);
  for (const z of ["veg", "nursery"]) { await go(`document.querySelector('[data-calw="${z}"]').click()`); await clean(`${z} calibration`); await go(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); }
  await go(`document.querySelector("[data-addzone]").click()`); await go(`ui.wiz.name="Flower 2";render()`); await go(`document.querySelector('[data-wiz="next"]').click()`); await go(`document.querySelector("[data-rapply]").click()`); await clean("New zone guide");
  for (const [e, name] of [[`ui.mapw=null;ui.screen="overview";render()`, "Overview with a new zone"], [`ui.screen="zone";ui.zone="flower_2";render()`, "New zone page"]]) { await go(e); await clean(name); }
  await go(`ui.mapw=null;ui.wiz=null;ui.guide=null;ui.review=null;ui.guard=null;renderModal();ui.screen="setup";render()`);
  await go(`document.querySelector('[data-rmzone="flower_2"]').click()`); await clean("Setup behind the dialog");
  check("Remove: real data, dialog names the new zone", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Remove Flower 2?");
  await go(`(()=>{const i=document.querySelector("#dlg-confirm");if(i){i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))}})();document.querySelector("[data-gdiscard]").click()`);
  check("Remove: real data, the new zone goes", (await ev(`!zoneById("flower_2")`)) === true);
  await go(`document.querySelector('[data-rmzone="garden"]').click()`);
  check("Remove: real data, shared hardware named", /stay in /.test(await ev(`document.querySelector("#modal").textContent`)), await ev(`document.querySelector("#modal").textContent`));
  check("Remove: real data, dialog has no NaN or undefined", !/NaN|undefined/.test(await ev(`document.querySelector("#modal").textContent`)));
  await go(`(()=>{const i=document.querySelector("#dlg-confirm");if(i){i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))}})();document.querySelector("[data-gdiscard]").click()`);
  check("Remove: real data, Garden's sensors stay findable", (await ev(`catalog().length`)) > (await ev(`zones.flatMap(z=>z.sensors).length`)));
  for (const [e, name] of [[`ui.screen="overview";render()`, "Overview without Garden"], [`ui.screen="devices";render()`, "Devices without Garden"], [`ui.screen="zone";ui.zone="veg";render()`, "Veg without Garden"], [`ui.screen="setup";render()`, "Setup without Garden"]]) { await go(e); await clean(name); }
  for (const id of await ev(`zones.map(z=>z.id)`)) { await go(`document.querySelector('[data-rmzone="${id}"]').click()`); await go(`(()=>{const i=document.querySelector("#dlg-confirm");if(i){i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))}})();document.querySelector("[data-gdiscard]").click()`); }
  for (const [e, name] of [[`ui.screen="overview";render()`, "Overview with no zones"], [`ui.screen="devices";render()`, "Devices with no zones"], [`ui.screen="setup";render()`, "Setup with no zones"]]) { await go(e); await clean(name); }
  check("Remove: real data, nothing left", (await ev(`zones.length`)) === 0);
  check("no script errors", exceptions.length === 0, exceptions.slice(0, 3));
  console.log(`${pass} passed, ${fail} failed`); await finish();
}

// Keyboard: heights taken from the user's foldable (41% of the screen), plus margin
const KEYBOARD = { portrait: 0.5, landscape: 0.62 };
for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await open(); await sleep(80);
  const hidden = [];
  for (const k of ["temperature", "humidity", "vpd"]) for (const i of [0, 2, 4]) {
    await tap(`#vin-${k}-${i}`); await sleep(420);
    const r = await ev(`(()=>{const e=document.querySelector("#vin-${k}-${i}").getBoundingClientRect(),bar=document.querySelector(".topbar"),head=bar&&getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0;return {top:e.top,bottom:e.bottom,head,h:innerHeight,active:document.activeElement.id}})()`);
    const line = r.h * (1 - kb);
    if (r.active !== `vin-${k}-${i}` || r.top < r.head - 1 || r.bottom > line) hidden.push([`${k}-${i}`, Math.round(r.top), Math.round(r.bottom), "limit " + Math.round(line), r.active]);
    await key("Escape", 27); await sleep(40);
  }
  check(`${name} ${w}x${h}: every box stays above the keyboard and below the header`, hidden.length === 0, hidden);
}
// Keyboard laid over the frame, as in Claude's viewer: nothing resizes
await phone(800, 1000); await open(); await tap("#vin-vpd-1"); await sleep(420);
const over = await ev(`(()=>{const c=document.querySelector("#vwrap").getBoundingClientRect(),b=document.querySelector("#vin-vpd-1").getBoundingClientRect();return {chartVisible:c.bottom-0,boxBottom:b.bottom,h:innerHeight}})()`);
check("overlaid keyboard: box sits just above where it starts", over.boxBottom <= over.h * 0.5 && over.boxBottom > over.h * 0.4, over);
await key("Escape", 27);
await tap("#vin-temperature-1"); await sleep(420);
const chart1 = await ev(`document.querySelector("#vwrap").getBoundingClientRect().bottom - 0`);
check("overlaid keyboard: chart stays in view above the first row", chart1 > 100, chart1);
await key("Escape", 27); await sleep(60);

// Keyboard that resizes the host, as Chill's page in the HA app: the frame gets shorter and the edge is measured
const outer = async (expression) => { const c = frameContext; frameContext = undefined; const r = await ev(expression); frameContext = c; return r; };
for (const [w, h, name] of [[800, 1000, "foldable"], [390, 844, "phone"]]) {
  await phone(w, h); await open(); await sleep(60);
  await tap("#vin-humidity-1"); await sleep(40);
  await outer(`document.querySelector("environment-control-panel").style.bottom="41%"`); await sleep(500);
  const m = await ev(`(()=>{const b=document.querySelector("#vin-humidity-1").getBoundingClientRect(),c=document.querySelector("#vwrap").getBoundingClientRect(),bar=document.querySelector(".topbar");return {boxTop:b.top,boxBottom:b.bottom,h:innerHeight,chart:c.bottom-(bar&&getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0),active:document.activeElement.id}})()`);
  check(`resized host ${name}: box is pushed up to just above the keyboard`, m.boxBottom <= m.h && m.boxBottom > m.h - 90 && m.active === "vin-humidity-1", m);
  check(`resized host ${name}: chart stays in view`, m.chart > 40, m);
  await tap("#vin-vpd-3"); await sleep(200);
  const m2 = await ev(`(()=>{const b=document.querySelector("#vin-vpd-3").getBoundingClientRect();return {top:b.top,bottom:b.bottom,h:innerHeight,active:document.activeElement.id}})()`);
  check(`resized host ${name}: moving box to box keeps it on screen`, m2.bottom <= m2.h && m2.top > 0 && m2.active === "vin-vpd-3", m2);
  await key("Escape", 27);
  await outer(`document.querySelector("environment-control-panel").style.bottom=""`); await sleep(120);
}

await phone(390, 844); await open();
await tap("#vin-vpd-1");
check("space is added while typing", await ev(`document.body.classList.contains("vtyping")`));
await tap("#vin-vpd-3");
check("space stays moving box to box", await ev(`document.body.classList.contains("vtyping")`));
await key("Enter", 13); await sleep(60);
check("space goes when typing ends", !(await ev(`document.body.classList.contains("vtyping")`)));
await tap("#vin-vpd-1"); await ev(`window.scrollTo(0,0)`); await sleep(40);
const q1 = await ev(`(()=>{const r=document.querySelector("#vin-vpd-1").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,h:innerHeight}})()`);
await ev(`document.querySelector("#vin-vpd-1").click()`); await sleep(120);
check("tapping the open box again brings it back", (await ev(`document.querySelector("#vin-vpd-1").getBoundingClientRect().bottom`)) < q1.h * 0.5, q1);
await key("Escape", 27);
await open(); await tap("#vin-humidity-1"); await type("61");
await ev(`document.querySelector("#vin-humidity-1").closest("label").click()`); await sleep(100);
check("tapping the Min/Low label keeps the box open", (await active()) === "vin-humidity-1", await active());
check("and keeps what was typed in it", (await ev(`document.querySelector("#vin-humidity-1").value`)) === "61");
await ev(`document.querySelector("[data-vrow=humidity]").click()`); await sleep(100);
check("tapping blank row space keeps the box open", (await active()) === "vin-humidity-1", await active());
await key("Escape", 27);

// Control: does the simulated touch tap reach click on an old, untouched button? If not, it is a tool limit, not this change.
await open();
const stageRect = await ev(`(()=>{const e=document.querySelector("[data-vstage]");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
await ev(`window.__clicks=0;document.addEventListener("click",()=>__clicks++,true)`);
await send("Input.synthesizeTapGesture", { x: stageRect.x, y: stageRect.y }); await sleep(400);
console.log("CONTROL simulated touch tap on an old button produced clicks:", await ev(`__clicks`));

// Nothing valid may be newly blocked by the wider checks
const falseBlocks = await ev(`(()=>{const out=[];for(const z of zones){openVpd(z.id);const v=ui.vpdw;for(const p of ["day","night"]){v.period=p;const before=vProblems(v.bands[p]);if(before.length)out.push([z.id,p,"bands",before]);for(const s of Object.keys(STAGES)){applyStage(v,s);const pr=vProblems(v.bands[p]);if(pr.length)out.push([z.id,p,s,pr]);}}}ui.vpdw=null;ui.td=null;ui.sched=null;return out})()`);
check("every zone band and Athena stage passes", falseBlocks.length === 0, falseBlocks);

await open();
/* Opening the page asks the host for HA's helper list, and its answer redraws the page. Wait for it, or a late answer
   rebuilds the boxes after they're marked (this check used to fail about one run in five for that reason). */
await send("Runtime.evaluate", { expression: "helpersLoading", awaitPromise: true, contextId: frameContext });
await ev(`document.querySelector("#vin-temperature-1").__mark=1;document.querySelector("#vin-temperature-3").__mark=1`);
await tap("#vin-temperature-1");
check("tap focuses the box", (await active()) === "vin-temperature-1", await active());
check("focus selects that line on the chart", (await ev(`[ui.vpdw.edit,ui.vpdw.sel].join()`)) === "temperature,1");
check("stepper appears for the selected line", (await ev(`document.querySelector("#vnudge").hidden`)) === false);
await type("22.2");
await tap("#vin-temperature-3");
check("exact value kept, not snapped to 0.5", (await band("temperature", 1)) === 22.2, await band("temperature", 1));
check("moving box to box keeps focus, so the keyboard stays", (await active()) === "vin-temperature-3", await active());
check("boxes were not rebuilt", (await ev(`document.querySelector("#vin-temperature-3").__mark`)) === 1);
/* On a phone the list can arrive after a box has been tapped. Redrawing then would replace the box being typed in. */
await send("Runtime.evaluate", { expression: "loadHelpers()", awaitPromise: true, contextId: frameContext });
check("Helpers: a list that arrives while typing doesn't rebuild the box", (await ev(`document.querySelector("#vin-temperature-3").__mark`)) === 1 && (await active()) === "vin-temperature-3" && (await ev(`helpersRedraw`)) === true);
await tap("#vread"); await sleep(150);
check("Helpers: once typing ends, the page catches up", (await ev(`helpersRedraw`)) === false && (await ev(`document.querySelector("#vin-temperature-3").__mark`)) === undefined && !(await ev(`typedBox(document.activeElement)`)));

await key("Escape", 27);
await open();
await tap("#vin-temperature-4"); await type("36"); await key("Enter", 13);
check("Enter commits a value past where the axis ended", (await band("temperature", 4)) === 36);
check("Enter closes the keyboard", (await active()) !== "vin-temperature-4");
check("a value past where the axis ended is not an issue", (await issueText()).length === 0, await issueText());
check("line stays inside the chart", await ev(`[...document.querySelectorAll("#vwrap line")].every(l=>Number(l.getAttribute("x1"))<=vGeom().W)`));
/* #159: the axes refit on commit, so a typed value gets room rather than sitting on the chart's edge. */
check("the axis makes room for it on commit, its line inside the edge", await ev(`(()=>{const g=vGeom(),x=Number(document.querySelector('#vwrap [data-vline="temperature:4"]').getAttribute("x1"));return g.t.hi>36&&x<g.right-g.cw/2})()`), await ev(`vGeom().t`));

const lowWas = await band("temperature", 1);
await tap("#vin-temperature-1"); await type(""); await ev(`document.querySelector("#vin-temperature-1").value=""`); await key("Enter", 13);
check("blank restores the old value", (await band("temperature", 1)) === lowWas && (await ev(`document.querySelector("#vin-temperature-1").value`)) === String(lowWas));
await tap("#vin-temperature-1"); await type("abc"); await key("Enter", 13);
check("text restores the old value", (await band("temperature", 1)) === lowWas);
await tap("#vin-temperature-1"); await type("23,5"); await key("Enter", 13);
check("comma decimal works", (await band("temperature", 1)) === 23.5);
await tap("#vin-temperature-1"); await type("99"); await key("Escape", 27);
check("Escape discards", (await band("temperature", 1)) === 23.5 && (await ev(`document.querySelector("#vin-temperature-1").value`)) === "23.5");

const highBefore = await band("humidity", 3);
await tap("#vin-humidity-3"); await type("99.9"); await key("Enter", 13);
const oo = await issueText();
check("out of order is named and blocks Save", oo.length === 1 && oo[0].includes("Humidity Max") && await saveOff(), oo);
check("offending box is marked", await ev(`document.querySelector("#vin-humidity-4").getAttribute("aria-invalid")==="true"`));
await shot("vpd-phone-error");
await tap("#v-issues .notice");
check("Fix lands on the box", (await active()) === "vin-humidity-4", await active());
await type("100"); await key("Enter", 13);
check("fixing it clears the issue and frees Save", (await issueText()).length === 0 && !(await saveOff()), await issueText());
await tap("#vin-humidity-4"); await type("200"); await key("Enter", 13);
check("impossible value is flagged", (await issueText()).some((t) => t.includes("between 0 and 100")), await issueText());
await tap("#vin-humidity-4"); await type("90"); await key("Enter", 13);
await tap("#vin-humidity-3"); await type(String(highBefore)); await key("Enter", 13);

await tap("#vin-temperature-2"); await type("25.5"); await key("Enter", 13);
const expected = await ev(`round2(calcVpd(25.5, ui.vpdw.bands[ui.vpdw.period].humidity[2], ui.vpdw.leaf))`);
check("Target temperature moves Target VPD", (await band("vpd", 2)) === expected && (await ev(`document.querySelector("#vin-vpd-2").value`)) === String(expected), [await band("vpd", 2), expected]);
check("Target box selects the Target tab", (await ev(`ui.vpdw.edit`)) === "target");
await tap("#vin-vpd-2"); await type("1"); await key("Enter", 13);
const rh = await band("humidity", 2);
check("Target VPD moves Target humidity", (await ev(`Math.abs(calcVpd(25.5, ${rh}, ui.vpdw.leaf) - 1) < 0.01`)) === true, rh);
check("the humidity move is announced", (await ev(`document.querySelector(".toast").textContent`)).includes("Humidity Target moved"));

await open(); await tap("#vin-temperature-1"); await type("24.4");
await ev(`document.querySelector("[data-vperiod]:not([aria-pressed=true])").click()`); await sleep(60);
const other = await ev(`ui.vpdw.period==="day"?"night":"day"`);
check("switching period commits to the period typed in", (await ev(`ui.vpdw.bands.${other}.temperature[1]`)) === 24.4, await ev(`ui.vpdw.bands.${other}.temperature[1]`));
check("and leaves the other period alone", (await band("temperature", 1)) !== 24.4);

await open(); await tap("#vin-temperature-1"); await type("24.4");
await ev(`document.querySelector("[data-vstage=veg]").click()`); await sleep(60);
check("a stage tapped with a box open wins", (await band("temperature", 1)) === 22.2, await band("temperature", 1));
await open(); await tap("#vin-temperature-1"); await type("24.4");
await ev(`document.querySelector("[data-calw]").click()`); await sleep(60);
check("leaf link opens the offsets with the wizard kept behind it", (await ev(`!!ui.leafw && !!ui.vpdw`)) === true);
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(60);
check("back from the offsets keeps the open box's value", (await ev(`!ui.leafw && ui.screen==="setup" && !!document.querySelector("#vwrap")`)) === true && (await band("temperature", 1)) === 24.4, await band("temperature", 1));

await open(); await tap("#vin-temperature-1"); await type("24.5");
await tap("#vnudge [data-vnudge='1']");
check("+ works first tap with a box focused", (await band("temperature", 1)) === 25, await band("temperature", 1));

await open(); await tap("#vin-humidity-1"); await type("41");
const pt = await ev(`(()=>{const e=document.querySelector("#vwrap");e.scrollIntoView({block:"center"});const r=e.querySelector("svg").getBoundingClientRect();return {x:r.left+r.width*0.6,y:r.top+r.height*0.4}})()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x + 4, y: pt.y + 30, button: "left" });
const live = await ev(`[document.querySelector("#vin-humidity-"+ui.vpdw.sel).value, String(ui.vpdw.bands[ui.vpdw.period].humidity[ui.vpdw.sel])]`);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x + 4, y: pt.y + 30, button: "left", clickCount: 1 });
await sleep(60);
check("dragging commits the open box first", (await band("humidity", 1)) === 41 || (await ev(`ui.vpdw.sel`)) === 1, await band("humidity", 1));
check("boxes follow the drag live", live[0] === live[1], live);

// iOS can leave the box focused through a button tap, so Save is clicked with focus held
await open(); await tap("#vin-temperature-1"); await type("24.7");
await ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`); await sleep(60);
check("Save with a box still focused keeps the typed value", (await ev(`zones[0].bands[typeof period==="function"?period(zones[0]):"day"].temperature[1]`)) === 24.7, await ev(`JSON.stringify(zones[0].bands)`));
check("Targets: Apply stays on the page, the saved value in its box, with nothing left to apply (#156)", (await ev(`!!ui.td && !!ui.vpdw && ui.screen==="setup" && document.querySelector("#vin-temperature-1").value==="24.7" && document.querySelector("#draftbar").hidden && !document.querySelector("#modal").querySelector("[data-rapply]")`)) === true, await ev(`[!!ui.td, ui.screen, document.querySelector("#vin-temperature-1")?.value, document.querySelector("#draftbar").hidden]`));
await open(); await tap("#vin-temperature-1"); await type("99");
await ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`); await sleep(60);
check("Save refuses a bad value still in the box", (await ev(`!!ui.vpdw`)) === true && (await issueText()).length === 1, await issueText());

for (const [w, h] of [[390, 844], [320, 640]]) {
  await phone(w, h); await open(); await sleep(60);
  const fit = await ev(`({page:document.documentElement.scrollWidth<=innerWidth, clipped:[...document.querySelectorAll('[data-vin]:not([data-vin="light:0"])')].filter(i=>i.scrollWidth>i.clientWidth).map(i=>i.id+"="+i.value), size:getComputedStyle(document.querySelector("[data-vin]")).fontSize})`);
  check(`${w}px: no sideways scroll`, fit.page, fit);
  check(`${w}px: no box clips its number`, fit.clipped.length === 0, fit.clipped);
  check(`${w}px: box text is 16px so iOS won't zoom`, fit.size === "16px", fit.size);
}
// ---------- Controls
/* The pages are in the page menu since #37, so going to one is picking it there. */
const menuItems = () => ev(`[...document.querySelectorAll("#zmenu-nav [role=menuitem]")].map(b=>b.textContent)`);
const goTab = async (name) => { await ev(`[...document.querySelectorAll("#zmenu-nav [role=menuitem]")].find(b=>b.textContent==="${name}").click()`); await sleep(60); };
const reset = () => ev(`ui.autos=null;ui.linkw=null;ui.review=null;ui.guard=null;ui.tview=null;ui.aview=null;renderModal();ui.leafw=null;ui.sched=null;ui.td=null;ui.vpdw=null;ui.mapw=null;ui.wiz=null;ui.picked=null;ui.zone="garden";ui.screen="overview";render();window.scrollTo(0,0)`);
const groupNames = () => ev(`[...document.querySelectorAll("[data-cgroup] .dev-name")].map(e=>e.textContent)`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
await phone(390, 844); await reset(); await goTab("Garden");
check("Controls: there's no Controls page in the menu", same(await menuItems(), ["Overview", "Garden", "Veg", "Nursery", "Devices", "Setup"]), await menuItems());
check("Controls: History, then the Zone map and Controls, as the panel has had them since #33", (await ev(`(()=>{const s=document.querySelector(".split");return s.previousElementSibling.querySelector("h2").textContent==="History"&&s.firstElementChild.querySelector("h2").textContent==="Zone map"&&s.lastElementChild.id==="controls"})()`)) === true);
check("Zone map: the zone page calls the map's card Zone map, and nothing on it says Device placement", (await ev(`!document.querySelector("#main").textContent.includes("Device placement") && [...document.querySelectorAll("#main h2")].some(h=>h.textContent==="Zone map")`)) === true, await ev(`[...document.querySelectorAll("#main h2")].map(h=>h.textContent)`));
await goTab("Setup");
check("Zone map: Setup still calls the step Device placement, in the zone's menu and the setup guide", (await ev(`document.querySelector('#zmenu-garden [data-wizard="garden"]').textContent`)) === "Device placement" && (await ev(`SETUP_STEPS.find(s=>s[0]==="place")[1]`)) === "Device placement", await ev(`document.querySelector('#zmenu-garden [data-wizard="garden"]').textContent`));
await goTab("Garden");
check("Controls: garden shows its climate devices and lights, and nothing else", same(await groupNames(), ["Dehumidifier", "Auxiliary dehumidifier", "Air conditioner", "Heater", "Intake fan", "Air conditioner exhaust fan", "Overhead light controller", "Under canopy light controller", "Overhead lights 1", "Overhead lights 2", "Red lights"]), await groupNames());
check("Controls: grouped by what they do", same(await ev(`[...document.querySelectorAll("[data-cgroup] h3")].map(e=>e.textContent)`), ["Humidity", "Temperature", "Airflow", "Lights"]));
check("Controls: humidity and temperature sit beside the live reading", (await ev(`[...document.querySelectorAll("[data-cgroup] .ctl-reading")].map(e=>e.textContent).join("|")`)).startsWith(await ev(`fmt("humidity",zones[0].now.humidity)`)), await ev(`[...document.querySelectorAll("[data-cgroup] .ctl-reading")].map(e=>e.textContent)`));
await goTab("Veg");
check("Controls: veg devices", same(await groupNames(), ["Auxiliary dehumidifier", "Heater", "Oscillating fans", "Tent light controller", "Tent lights"]), await groupNames());
check("Controls: shared device names who shares it", (await ev(`[...document.querySelectorAll(".dev")].find(d=>d.textContent.includes("Heater")).textContent`)).includes("Shared with Garden and Nursery"));
await goTab("Nursery");
check("Controls: nursery devices", same(await groupNames(), ["Auxiliary dehumidifier", "Heater", "Oscillating fans", "Tent light controller", "Tent lights"]), await groupNames());
await goTab("Garden");
/* Controls go through the host to the fake Home Assistant, which reports a moment later, drops what it's told to and runs failsafes. */
const evp = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId: frameContext }); if (r.result.exceptionDetails) throw new Error(expression + " -> " + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
const haCalls = () => onHA(`fakeHA.calls.map(c=>[c.domain+"."+c.service,c.data.entity_id,c.data.brightness_pct??c.data.mode??c.data.humidity??null])`);
const devRow = (id) => ev(`(()=>{const r=document.querySelector('[data-devrow="${id}"]');if(!r)return null;const s=r.querySelector(".sw"),t=r.querySelector(".ctl-status");return {on:s.getAttribute("aria-checked")==="true",disabled:s.disabled,status:t?t.textContent:"",cls:t?t.className:"",text:r.textContent}})()`);
const REPORT = 600 + 300, GIVE_UP_CTL = 4000 + 300;
check("Controls: nothing is marked Preview", (await ev(`!document.querySelector("#controls .pill.preview, #controls [data-preview]")`)) === true);
const before = (await haCalls()).length;
await tap('[data-devrow="heater"] .sw');
let calls = await haCalls(), heater = await devRow("heater");
check("Controls: a tap reaches Home Assistant as one call on the mapped entity", calls.length === before + 1 && same(calls.at(-1), ["switch.turn_on", "switch.heater_mains", null]), calls.slice(before));
check("Controls: it says sent, and the switch stays put until HA reports", heater.status.startsWith("Sent") && heater.on === false && heater.disabled === true, heater);
await sleep(REPORT); heater = await devRow("heater");
check("Controls: it moves once HA reports the heater on, and the note clears", heater.on === true && heater.status === "" && heater.text.includes("On."), heater);
await onHA(`fakeHA.knobs.dropNext=true`); await tap('[data-devrow="heater"] .sw'); await sleep(GIVE_UP_CTL); heater = await devRow("heater");
check("Controls: a dropped command is never shown as done", heater.on === true && heater.status === "Not confirmed. Heater still reports on. A Tuya plug can drop a command without saying, so try again." && heater.cls.includes("crit"), heater);
await tap('[data-devrow="heater"] .sw'); await sleep(REPORT); heater = await devRow("heater");
check("Controls: trying again works and clears the warning", heater.on === false && heater.status === "", heater);
await goTab("Overview");
await goTab("Veg"); await tap('[data-devrow="fans"] .sw'); await sleep(REPORT);
check("Controls: the fans report off", (await devRow("fans")).on === false, await devRow("fans"));
await sleep(1300); let fans = await devRow("fans");
check("Controls: a failsafe putting it back is explained, not left looking broken", fans.on === true && fans.status.startsWith("Put back by Home Assistant") && fans.cls.includes("warn"), fans);
await tap('[data-devrow="lp-tent"] .sw'); await sleep(REPORT); await sleep(3300); const tent = await devRow("lp-tent");
check("Controls: a light against its schedule is put back too", tent.on === false && tent.status.startsWith("Put back"), tent);
await goTab("Overview");
check("Controls: Overview counts a zone's devices, as the panel does", (await ev(`document.querySelector('.zone-card[data-zone="veg"]').textContent`)).includes("5 devices."));
await goTab("Garden");
/* A number is set on a dial, as the panel has had since #32. Its keys and buttons send once left alone for 0.7 s. */
const SETTLE = 700 + 100;
const setDial = (id, action, n) => ev(`(()=>{const r=document.querySelector('[data-devrow="${id}"] [data-dialin="${id}:${action}"]');r.value=${n};r.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector('[data-devrow="${id}"] [data-dialin="${id}:${action}"]').dispatchEvent(new Event("change",{bubbles:true}))})()`);
await setDial("lc-over", "brightness", 60); await sleep(SETTLE + REPORT);
check("Controls: brightness is sent as a percentage from its dial and shown once reported", same((await haCalls()).at(-1), ["light.turn_on", "light.garden_light_controller_overhead", 60]) && (await devRow("lc-over")).text.includes("On, 60%") && (await ev(`document.querySelector('[data-devrow="lc-over"] [data-dialin]').value`)) === "60", (await devRow("lc-over")).text);
const modes = await ev(`[...document.querySelectorAll('[data-devrow="dehu"] [data-act="mode"]')].map(o=>o.value+(o.checked?"*":""))`);
check("Controls: the dehumidifier's modes are chips in name order, and the mode HA reports outside its list isn't one", same(modes, ["boost", "comfort", "eco", "sleep"]), modes);
check("Controls: it says that mode isn't in its list, and offers to add it", (await devRow("dehu")).text.includes("Normal isn't in its mode list.") && (await devRow("dehu")).text.includes("Add Normal as a mode"), (await devRow("dehu")).text);
await ev(`(()=>{const s=document.querySelector('[data-devrow="dehu"] [data-act="mode"][value="eco"]');s.checked=true;s.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(REPORT);
let dehu = await devRow("dehu");
check("Controls: a mode change is sent and reported", same((await haCalls()).at(-1), ["humidifier.set_mode", "humidifier.garden_dehumidifier", "eco"]) && dehu.text.includes("On, eco mode") && !dehu.text.includes("isn't in its mode list"), dehu.text);
await setDial("dehu", "humidity", 50); await sleep(SETTLE + REPORT);
check("Controls: a target humidity is sent from its dial and reported", same((await haCalls()).at(-1), ["humidifier.set_humidity", "humidifier.garden_dehumidifier", 50]) && (await ev(`document.querySelector('[data-devrow="dehu"] [data-dialin]').value`)) === "50");
await tap('[data-devrow="lc-over"] [data-dialstep][data-dir="1"]'); await tap('[data-devrow="lc-over"] [data-dialstep][data-dir="1"]');
check("Controls: plus moves a light 5% at a time and sends nothing while pressed", (await ev(`document.querySelector('[data-devrow="lc-over"] .dial-num').textContent`)) === "70%" && (await haCalls()).at(-1)[2] === 50);
await sleep(SETTLE + REPORT);
check("Controls: two presses left alone are one command", same((await haCalls()).at(-1), ["light.turn_on", "light.garden_light_controller_overhead", 70]) && (await devRow("lc-over")).text.includes("On, 70%"), (await haCalls()).at(-1));
await setDial("lc-over", "brightness", 60); await sleep(SETTLE + REPORT);
await tap('[data-devrow="dehu"] .sw'); await sleep(REPORT);
check("Controls: an off dehumidifier's dial is grey and says Off, with its target in the caption", (await ev(`(()=>{const d=document.querySelector('[data-devrow="dehu"] .dial');return d.style.getPropertyValue("--c")==="var(--off)"&&d.querySelector(".dial-num").textContent==="Off"&&d.querySelector(".dial-cap").textContent==="Target 50%"})()`)) === true);
await tap('[data-devrow="dehu"] .sw'); await sleep(REPORT);
await ev(`devices.find(d=>d.id==="dehu").hiddenModes=["sleep","comfort"];render()`); await sleep(30);
check("Controls: modes left out in Device identification aren't offered", same(await ev(`[...document.querySelectorAll('[data-devrow="dehu"] [data-act="mode"]')].map(o=>o.value)`), ["boost", "eco"]));
await ev(`devices.find(d=>d.id==="dehu").hiddenModes=[];devices.find(d=>d.id==="dehu").nudgeMode="normal";render()`); await onHA(`fakeHA.knobs.targetModes["humidifier.garden_dehumidifier"]="normal"`); await sleep(30);
check("Controls: an extra mode joins the chips, in name order", same(await ev(`[...document.querySelectorAll('[data-devrow="dehu"] [data-act="mode"]')].map(o=>o.value)`), ["boost", "comfort", "eco", "normal", "sleep"]));
let nX = (await haCalls()).length;
await ev(`(()=>{const s=document.querySelector('[data-devrow="dehu"] [data-act="mode"][value="normal"]');s.checked=true;s.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(3 * REPORT + 600);
check("Controls: it's reached by moving the target one step and back, then reported", same((await haCalls()).slice(nX).map((c) => c[0]), ["humidifier.set_humidity", "humidifier.set_humidity"]) && (await devRow("dehu")).text.includes("On, normal mode"), [(await haCalls()).slice(nX), (await devRow("dehu")).text]);
await ev(`delete devices.find(d=>d.id==="dehu").nudgeMode;render()`); await onHA(`delete fakeHA.knobs.targetModes["humidifier.garden_dehumidifier"]`);
const down = await ev(`(()=>{const d=document.querySelector('[data-devrow="acfan"]');return {all:[...d.querySelectorAll("button, input")].every(b=>b.disabled),text:d.textContent.includes("Unavailable")}})()`);
check("Controls: an unavailable device can't be tapped", down.all && down.text, down);
await onHA(`fakeHA.offline("switch.heater_mains",true)`); await sleep(100);
check("Controls: a device going offline in HA disables its control straight away", (await devRow("heater")).disabled === true && (await devRow("heater")).text.includes("Unavailable"), await devRow("heater"));
await onHA(`fakeHA.offline("switch.heater_mains",false)`); await sleep(100);
check("Controls: and coming back enables it", (await devRow("heater")).disabled === false, await devRow("heater"));
/* What a compromised UI could try. The host looks everything up itself, so none of these reach HA. */
const n1 = (await haCalls()).length;
const refusals = await evp(`Promise.all([ask("device",{id:"nope",action:"turn_on"}),ask("device",{id:"lc-over",action:"brightness",value:150}),ask("device",{id:"dehu",action:"mode",value:"turbo"}),ask("device",{id:"heater",action:"open_valve"}),ask("device",{id:"acfan",action:"turn_on"}),ask("device",{id:"heater",action:"humidity",value:50})]).then(r=>r.map(x=>x.ok))`);
check("Controls: the host refuses an unknown device, a value out of range, a mode it lacks, an unknown action, an unavailable device and a wrong-kind action", same(refusals, [false, false, false, false, false, false]) && (await haCalls()).length === n1, refusals);
await evp(`ask("device",{id:"heater",action:"turn_on",entity_id:"switch.plug_7",service:"switch.turn_off"})`);
check("Controls: an entity or service named by the frame is ignored", same((await haCalls()).at(-1), ["switch.turn_on", "switch.heater_mains", null]), (await haCalls()).at(-1));
await sleep(REPORT);
await evp(`(parent.postMessage({v:1,type:"call_service",domain:"switch",service:"turn_on",service_data:{entity_id:"switch.plug_7"}},"*"),new Promise(r=>setTimeout(r,200)))`);
check("Controls: a message type the host doesn't know is dropped", (await haCalls()).at(-1)[1] === "switch.heater_mains" && (await onHA(`fakeHA.states["switch.plug_7"].state`)) === "off");
await tap('[data-devrow="heater"] .sw'); await sleep(REPORT);

// ---------- History opens on: a zone keeps the graph and range its History starts on, as the panel has since #52 and #55
await reset(); await goTab("Garden");
check("History: a zone opens on Temperature, 24h, with nothing to set", (await ev(`ui.metric==="temperature" && ui.range===24 && !document.querySelector("[data-histdefault]")`)) === true);
await ev(`document.querySelector('[data-metric="humidity"]').click()`); await sleep(40);
check("History: showing something else offers to always open on it", (await ev(`document.querySelector("[data-histdefault]").textContent`)) === "Always open on Humidity, 24h ›");
await ev(`document.querySelector("[data-histdefault]").click()`); await sleep(40);
check("History: it's a review, before and after", (await ev(`document.querySelector("#review-items").textContent`)) === "Garden's History opens onTemperature, 24h → Humidity, 24h", await ev(`document.querySelector("#review-items").textContent`));
await ev(`document.querySelector("[data-rapply]").click()`); await sleep(200);
check("History: applied, it's stored with the zone", same(await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="garden").history`), { metric: "humidity", hours: 24 }));
await goTab("Overview"); await goTab("Garden");
check("History: and the zone opens on it", (await ev(`ui.metric`)) === "humidity" && (await ev(`!document.querySelector("[data-histdefault]")`)) === true);
await goTab("Setup");
check("History: Setup's Appearance card shows what each zone opens on", (await ev(`document.querySelector('.opens-row [data-opens="garden"][data-ometric="humidity"]').getAttribute("aria-pressed")`)) === "true");
await ev(`document.querySelector('[data-opens="garden"][data-ometric="temperature"]').click()`); await sleep(40); await ev(`document.querySelector("[data-rapply]").click()`); await sleep(200);
check("History: going back to Temperature, 24h stores nothing, since that's the default", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="garden").history ?? null`)) === null);

// ---------- The History divider: a line between the graph chips and the range chips, shown only while they share a line
/* The line is the range chips' ::before, in the gap, and the row clips it once the range chips start a line of their
   own. Where it falls is worked out from its computed place, since a pseudo-element has no box to ask for. */
const sepAt = `const r=b.querySelector(".row.segs"),g=r?r.querySelectorAll(".seg"):[],a=g[0].getBoundingClientRect(),c=g[1].getBoundingClientRect(),p=getComputedStyle(g[1],"::before"),rr=r.getBoundingClientRect(),x=c.left+parseFloat(p.left),lw=parseFloat(p.width),one=Math.abs(a.top-c.top)<1,shown=!!r&&p.content!=="none"&&getComputedStyle(r).overflowX==="clip"&&x>=rr.left&&x+lw<=rr.right`;
const sepNow = (box) => ev(`(()=>{const b=${box};${sepAt};return {shown,oneLine:one,between:shown&&x>=a.right&&x+lw<=c.left,centred:Math.abs((x-a.right)-(c.left-x-lw))<1.5,ringRoom:parseFloat(getComputedStyle(r).paddingLeft)>=2}})()`);
const sepSweep = (box) => ev(`(()=>{const b=${box},out=[];let s=0,wr=0;for(let w=240;w<=600;w+=0.5){b.style.width=w+"px";${sepAt};if(shown)s++;if(!one)wr++;if(shown!==one)out.push([w,shown,one])}b.style.width="";return {wrong:out.slice(0,6),shown:s,wrapped:wr}})()`);
const HIST_BOX = `document.querySelector("#chart").closest(".card").querySelector(".card-head")`, OPENS_BOX = `document.querySelector('.opens-row [data-opens="garden"]').closest(".opens-row")`;
for (const [box, name] of [[HIST_BOX, "History card"], [OPENS_BOX, "Setup's History opens on"]]) {
  await reset(); await goTab(name === "History card" ? "Garden" : "Setup"); await sleep(60);
  for (const [w, h, size] of [[1280, 900, "desktop"], [390, 844, "phone"]]) {
    if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
    await sleep(60); const now = await sepNow(box);
    check(`Divider, ${name} ${size}: ${size === "desktop" ? "on one line, with a line centred between the groups, room left for a chip's focus ring" : "wrapped, with no line"}`, size === "desktop" ? now.shown && now.oneLine && now.between && now.centred && now.ringRoom : !now.shown && !now.oneLine, now);
    await ev(`${box}.scrollIntoView({block:"center"})`); await shot(`divider-${name === "History card" ? "history" : "setup"}-${size}`);
  }
  const sw = await sepSweep(box);
  check(`Divider, ${name}: across widths, measured where the groups really wrap, the line shows exactly while both sit on one line`, sw.wrong.length === 0 && sw.shown > 0 && sw.wrapped > 0, sw);
}
await phone(390, 844);

// ---------- Sorting Overview's cards: the stored order of zones, changed through a draft and a review like any other edit
{
  const panelEl = `document.querySelector("environment-control-panel")`;
  const cardNames = () => ev(`[...document.querySelectorAll("#main .zone-card h2")].map(h=>h.textContent)`);
  const diskOrder = () => onHA(`JSON.parse(fakeHA.disk).zones.map(z=>z.name)`);
  const arrowsOf = () => ev(`[...document.querySelectorAll("#main .zone-card")].map(c=>[...c.querySelectorAll(".btn.move")].map(b=>b.getAttribute("aria-label")+(b.disabled?" (off)":"")))`);
  const bars = () => ev(`(()=>{const p=document.querySelector("#pagebar"),d=document.querySelector("#draftbar");return {page:p&&!p.hidden?[...p.querySelectorAll("button")].map(b=>b.textContent):null,draft:d.hidden?null:{count:d.querySelector("#draft-count").textContent,what:d.querySelector("#draft-what").textContent,buttons:[...d.querySelectorAll("button")].filter(b=>!b.hidden).map(b=>b.textContent)}}})()`);
  const focused = () => ev(`document.activeElement.getAttribute("aria-label")`);
  const told = () => onHA(`${panelEl}.draftOpen`);
  const sorting = () => ev(`!!ui.sort && !!document.querySelector("#main .zone-card.sorting")`);
  const gesture = () => onHA(`${panelEl}.post({type:"back"})`).then(() => sleep(60));
  const move = (id, by) => tap(`[data-sortcard="${id}"] [data-by="${by}"]`);
  const blockArrows = () => ev(`[...document.querySelectorAll("#main .fambar")].map(c=>[...c.querySelectorAll(".btn.move")].map(b=>b.getAttribute("aria-label")+(b.disabled?" (off)":"")))`);
  /* Another device's save reaches this one as a config message; a made-up revision stands in, and the stored one is put back after. */
  let fakes = 0;
  const fakeConfig = (js) => onHA(`(()=>{const p=${panelEl},c=JSON.parse(JSON.stringify(p.stored()));${js};p.post({type:"config",...c,revision:c.revision+1000+${++fakes}})})()`).then(() => sleep(80));
  const realConfig = () => onHA(`${panelEl}.post({type:"config",...${panelEl}.stored()})`).then(() => sleep(80));
  await phone(390, 844); await reset();
  const order0 = await diskOrder();
  check("Sort: Overview shows the zones in the order they're stored", same(order0, ["Garden", "Veg", "Nursery"]) && same(await cardNames(), order0), [order0, await cardNames()]);
  const btn = await ev(`(()=>{const b=document.querySelector("[data-sort]"),n=document.querySelector(".navmenu .burger");if(!b)return null;const r=b.getBoundingClientRect(),q=n.getBoundingClientRect();return {text:b.textContent,cls:b.className,inHead:!!b.closest(".pagehead"),h:r.height,nh:q.height,bottom:r.bottom,nbottom:q.bottom,right:r.right,wrapRight:document.querySelector("#main .wrap").getBoundingClientRect().right}})()`);
  check("Sort: Overview's heading has a Sort button at its right, level with the menu button and as tall, where a zone's More sits", !!btn && btn.text === "Sort" && btn.cls.split(" ").includes("btn") && btn.inHead && Math.abs(btn.h - btn.nh) < 1 && Math.abs(btn.bottom - btn.nbottom) < 1 && Math.abs(btn.right - btn.wrapRight) < 1, btn);
  await fakeConfig(`c.zones=c.zones.slice(0,1)`);
  check("Sort: with one zone there's nothing to sort, so no button", (await ev(`document.querySelectorAll("#main .zone-card").length===1 && !document.querySelector("[data-sort]")`)) === true);
  await fakeConfig(`c.zones=c.zones.slice(0,2)`);
  check("Sort: with two zones the button is there", (await ev(`!!document.querySelector("[data-sort]")`)) === true);
  await realConfig();

  await tap("[data-sort]");
  check("Sort: sorting says so on the page, and the Sort button gives way to Back in the bar at the foot", (await sorting()) && (await ev(`document.querySelector("#sort-note").textContent`)) === "Sorting the cards: move them with the arrows." && (await ev(`document.activeElement.id`)) === "sort-note" && (await ev(`!document.querySelector("[data-sort]")`)) && same(await bars(), { page: ["Back"], draft: null }), await bars());
  check("Sort: each card has previous and next, a zone on its own steps among the zones and families, a card in a family only inside it", same(await arrowsOf(), [["Move Garden to previous (off)", "Move Garden to next"], ["Move Veg to previous in its group (off)", "Move Veg to next in its group"], ["Move Nursery to previous in its group", "Move Nursery to next in its group (off)"]]), await arrowsOf());
  check("Sort: a family has its own pair, joined to the top of its cards, to move it as one block", same(await blockArrows(), [["Move Veg and Nursery to previous", "Move Veg and Nursery to next (off)"]]), await blockArrows());
  check("Sort: the arrows draw the up and down chevrons", (await ev(`(()=>{const b=document.querySelectorAll('[data-sortcard="veg"] .btn.move');return b[0].querySelector("path").getAttribute("d")===ICON.up&&b[1].querySelector("path").getAttribute("d")===ICON.down})()`)) === true);
  check("Sort: a card is no button and holds nothing else to press, and the notices with their links are gone", (await ev(`[...document.querySelectorAll("#main .zone-card")].every(c=>c.tagName==="DIV"&&!c.closest("button")&&!c.querySelector("[data-go]")&&c.querySelectorAll("button").length===2) && !document.querySelector("#main .fixlink") && !document.querySelector("#main .notice")`)) === true);
  await tap('[data-sortcard="veg"] h2'); await tap('[data-sortcard="veg"] .rows');
  check("Sort: tapping a card opens nothing", (await ev(`ui.screen`)) === "overview" && (await sorting()));

  await move("nursery", -1);
  check("Sort: a move reorders the cards and saves nothing, and Nursery may come before its parent", same(await cardNames(), ["Garden", "Nursery", "Veg"]) && same(await diskOrder(), order0) && same(await menuItems(), ["Overview", "Garden", "Veg", "Nursery", "Devices", "Setup"]), [await cardNames(), await diskOrder()]);
  check("Sort: at its family's start a card can't leave it, so its previous is off and focus goes to its other arrow", (await focused()) === "Move Nursery to next in its group" && same(await arrowsOf(), [["Move Garden to previous (off)", "Move Garden to next"], ["Move Nursery to previous in its group (off)", "Move Nursery to next in its group"], ["Move Veg to previous in its group", "Move Veg to next in its group (off)"]]) && same(await blockArrows(), [["Move Nursery and Veg to previous", "Move Nursery and Veg to next (off)"]]), [await focused(), await arrowsOf(), await blockArrows()]);
  check("Sort: with the order changed, the bar holds the count, Back, Discard and Review and apply", same(await bars(), { page: null, draft: { count: "1", what: "Overview · Zone order", buttons: ["Back", "Discard", "Review and apply"] } }), await bars());
  check("Sort: and the host is told a draft is open", (await told()) === true);
  await tap('[data-moveblock="veg"][data-by="-1"]');
  check("Sort: a family moves as one block, past the zone before it, and focus goes to its other arrow at the top", same(await cardNames(), ["Nursery", "Veg", "Garden"]) && (await focused()) === "Move Nursery and Veg to next" && same(await blockArrows(), [["Move Nursery and Veg to previous (off)", "Move Nursery and Veg to next"]]), [await cardNames(), await focused()]);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await sleep(120);
  check("Sort: so it can be pressed again from the keyboard", same(await cardNames(), ["Garden", "Nursery", "Veg"]) && (await focused()) === "Move Nursery and Veg to previous", [await cardNames(), await focused()]);
  await move("garden", 1);
  check("Sort: a zone on its own steps past a whole family in one press", same(await cardNames(), ["Nursery", "Veg", "Garden"]) && (await focused()) === "Move Garden to previous", [await cardNames(), await focused()]);
  const inView = await ev(`(()=>{const c=document.querySelector('[data-sortcard="garden"]'),b=document.activeElement.getBoundingClientRect(),bar=[...document.querySelectorAll("#draftbar, #pagebar")].find(x=>!x.hidden).getBoundingClientRect();return {card:c.getBoundingClientRect().bottom>0&&c.getBoundingClientRect().top<innerHeight,top:b.top,bottom:b.bottom,barTop:bar.top}})()`);
  check("Sort: moved to the foot, the arrow used is in the window and above the bar", inView.card && inView.top >= 0 && inView.bottom <= inView.barTop, inView);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await sleep(120);
  await move("nursery", 1);
  check("Sort: back in the stored order, there's nothing to apply", same(await cardNames(), order0) && same(await bars(), { page: ["Back"], draft: null }) && (await told()) === false, [await cardNames(), await bars()]);
  const phoneFit = await ev(`(()=>{const out=[];for(const c of document.querySelectorAll("#main .zone-card, #main .fambar")){const r=c.getBoundingClientRect();for(const b of c.querySelectorAll(".btn.move")){const q=b.getBoundingClientRect();if(q.left<r.left||q.right>r.right||q.right>innerWidth||q.width<40)out.push(b.getAttribute("aria-label"))}}return {out,wide:document.documentElement.scrollWidth>innerWidth}})()`);
  check("Sort: at phone width every arrow sits whole inside its card, and nothing runs off the side", phoneFit.out.length === 0 && !phoneFit.wide, phoneFit);
  await ev(`window.scrollTo(0,0)`); await shot("sort-phone");
  await move("veg", 1); await ev(`window.scrollTo(0,0)`); await shot("sort-phone-moved");

  await tap("[data-ddiscard]");
  check("Sort: Discard puts the stored order back and keeps sorting", same(await cardNames(), order0) && (await sorting()) && same(await bars(), { page: ["Back"], draft: null }) && (await told()) === false, [await cardNames(), await bars()]);
  await move("veg", 1); await tap("[data-dback]");
  check("Sort: Back with the order changed asks first", (await ev(`ui.guard && ui.guard.title`)) === "Discard unsaved changes?" && (await ev(`document.querySelector("#dlg-text").textContent`)) === "You have 1 unsaved change in Overview. Leaving will discard it.", await ev(`document.querySelector("#dlg-text")?.textContent`));
  await tap("[data-gkeep]");
  check("Sort: Keep editing keeps the order and the sorting", same(await cardNames(), ["Garden", "Nursery", "Veg"]) && (await sorting()));
  await tap("[data-dback]"); await tap("[data-gdiscard]");
  check("Sort: Discard and continue stops sorting, in the stored order, focus back on Sort", !(await sorting()) && same(await cardNames(), order0) && (await ev(`document.activeElement.dataset.sort!==undefined`)) && same(await diskOrder(), order0) && (await told()) === false, [await cardNames(), await ev(`document.activeElement.outerHTML.slice(0,60)`)]);
  await tap("[data-sort]"); await tap("[data-sortback]");
  check("Sort: Back with nothing moved stops sorting without asking", !(await sorting()) && (await ev(`ui.guard`)) === null);

  await tap("[data-sort]"); await move("veg", 1); await goTab("Veg");
  check("Sort: the page menu asks first too", (await ev(`ui.guard && ui.guard.title`)) === "Discard unsaved changes?" && (await ev(`ui.screen`)) === "overview");
  await tap("[data-gdiscard]");
  check("Sort: and discarding goes there, saving nothing", (await ev(`ui.screen==="zone"&&ui.zone==="veg"&&!ui.sort`)) === true && same(await diskOrder(), order0));
  await goTab("Overview");
  check("Sort: back on Overview it isn't sorting", !(await sorting()) && same(await cardNames(), order0));
  await tap("[data-sort]"); await tap('[data-zmenu="nav"]'); await gesture();
  check("Sort: the back gesture closes the menu first", (await sorting()) === true && (await ev(`document.querySelector("#zmenu-nav").hidden`)) === true);
  await gesture();
  check("Sort: then, with nothing moved, it stops sorting", !(await sorting()));
  await tap("[data-sort]"); await move("veg", 1); await gesture();
  check("Sort: with the order changed, the back gesture asks first", (await ev(`ui.guard && ui.guard.title`)) === "Discard unsaved changes?");
  await gesture();
  check("Sort: the back gesture again closes that and keeps the order", (await ev(`ui.guard`)) === null && (await sorting()) && same(await cardNames(), ["Garden", "Nursery", "Veg"]));
  await gesture(); await tap("[data-gdiscard]");
  check("Sort: and discarding steps out of sorting", !(await sorting()) && same(await cardNames(), order0));

  await tap("[data-sort]"); await move("nursery", -1);
  await fakeConfig(`c.zones=c.zones.filter(z=>z.id!=="garden")`);
  check("Sort: a zone removed elsewhere drops out of the draft, and the rest keep their sorted order", same(await cardNames(), ["Nursery", "Veg"]) && same(await arrowsOf(), [["Move Nursery to previous in its group (off)", "Move Nursery to next in its group"], ["Move Veg to previous in its group", "Move Veg to next in its group (off)"]]) && (await bars()).draft?.count === "1", [await cardNames(), await bars()]);
  await tap("[data-dreview]");
  check("Sort: and the review names only the zones there are", (await ev(`[...document.querySelectorAll("#review-items .review-row")].map(r=>r.textContent).join("|")`)) === "Zone orderVeg, Nursery → Nursery, Veg", await ev(`document.querySelector("#review-items")?.textContent`));
  await tap("[data-rback]");
  await realConfig();
  check("Sort: a zone added elsewhere joins the cards being sorted", same(await cardNames(), ["Garden", "Nursery", "Veg"]) && (await sorting()), await cardNames());
  await fakeConfig(`c.zones=c.zones.slice(0,1)`);
  check("Sort: down to one zone, sorting stops and nothing is held", !(await sorting()) && (await told()) === false && same(await bars(), { page: null, draft: null }), await bars());
  await realConfig();

  await ev(`window.scrollTo(0,0)`); await tap("[data-sort]"); await move("nursery", -1); await tap("[data-dreview]");
  const rv = await ev(`(()=>({rows:[...document.querySelectorAll("#review-items .review-row")].map(r=>[r.querySelector("strong").textContent,r.querySelector("span").textContent]),text:document.querySelector("#dlg-text").textContent,note:[...document.querySelectorAll("#modal .review-scroll > p.small")].map(p=>p.textContent),apply:document.querySelector("[data-rapply]").textContent}))()`);
  check("Sort: the review lists one change, Zone order, as the names before and after", same(rv.rows, [["Zone order", "Garden, Veg, Nursery → Garden, Nursery, Veg"]]) && rv.apply === "Apply 1 change", rv);
  check("Sort: and says it's the order on Overview, in the menu and on Setup, on every device", rv.note.includes("This is the order zones are shown in on Overview, in the menu and on Setup, on every device. Nothing in Home Assistant changes.") && rv.text.startsWith("This changes only the order zones are listed in."), rv);
  /* The mock keeps live readings with its zones, so any save of the mock writes them. What a save would write without the
     move is the measure, not what was on disk. */
  const before = await ev(`(()=>{const d=configOf();d.zones.sort((a,b)=>a.id<b.id?-1:1);return JSON.stringify(d)})()`);
  await shot("sort-phone-review");
  await tap("[data-rapply]"); await sleep(300);
  const after = await onHA(`(()=>{const d=JSON.parse(fakeHA.disk);d.zones.sort((a,b)=>a.id<b.id?-1:1);delete d.revision;return JSON.stringify(d)})()`);
  check("Sort: applying stores the zones in the new order, with nothing else changed and nothing asked by the host", same(await diskOrder(), ["Garden", "Nursery", "Veg"]) && before === after && (await hostDialog()).open === false, await diskOrder());
  check("Sort: says so, stops sorting, since nothing is left to apply, and stays on Overview (#156)", (await ev(`document.querySelector("#toast").textContent`)) === "Zone order saved." && !(await sorting()) && (await ev(`ui.review`)) === null && (await told()) === false && (await ev(`ui.screen`)) === "overview");
  check("Sort: Overview and the page menu follow the stored order", same(await cardNames(), ["Garden", "Nursery", "Veg"]) && same(await menuItems(), ["Overview", "Garden", "Nursery", "Veg", "Devices", "Setup"]), [await cardNames(), await menuItems()]);
  await goTab("Setup");
  check("Sort: and so do Setup's zone rows", same(await ev(`[...document.querySelectorAll("#main .task > div > strong")].map(t=>t.textContent).filter(n=>["Garden","Veg","Nursery"].includes(n))`), ["Garden", "Nursery", "Veg"]));
  await goTab("Overview");

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await ev(`document.querySelector("#toast").hidden=true`);
  await tap("[data-sort]"); await ev(`window.scrollTo(0,0)`); await shot("sort-desktop");
  await move("veg", -1); await ev(`window.scrollTo(0,0)`); await shot("sort-desktop-moved");
  await tap("[data-dreview]"); await shot("sort-desktop-review"); await tap("[data-rback]");
  const deskFit = await ev(`(()=>{const out=[];for(const c of document.querySelectorAll("#main .zone-card, #main .fambar")){const r=c.getBoundingClientRect();for(const b of c.querySelectorAll(".btn.move")){const q=b.getBoundingClientRect();if(q.left<r.left||q.right>r.right)out.push(b.getAttribute("aria-label"))}}return out})()`);
  check("Sort: on a desktop the arrows sit inside their cards too", deskFit.length === 0, deskFit);
  await tap("[data-dback]"); await tap("[data-gdiscard]");
  /* A family is drawn as one joined card: Nursery and Veg touch, sharing a seam with the link tab on it, and Garden keeps its gap. */
  const joined = () => ev(`(()=>{const r=(id)=>document.querySelector('#main .zone-card[data-zone="'+id+'"]').getBoundingClientRect(),g=r("garden"),n=r("nursery"),v=r("veg"),t=document.querySelector("#main .linktab"),tr=t.getBoundingClientRect(),cs=(id)=>getComputedStyle(document.querySelector('#main .zone-card[data-zone="'+id+'"]'));return {side:{nv:v.left-n.right,top:v.top-n.top,gn:n.left-g.right},stack:{nv:v.top-n.bottom,left:v.left-n.left,gn:n.top-g.bottom},tab:{label:t.getAttribute("aria-label"),title:t.title,inCard:!!t.closest('[data-zone="nursery"]'),x:tr.left+tr.width/2-n.right,y:tr.top+tr.height/2-n.bottom},corners:{n:[cs("nursery").borderTopLeftRadius,cs("nursery").borderTopRightRadius,cs("nursery").borderBottomLeftRadius,cs("nursery").borderBottomRightRadius],v:[cs("veg").borderTopLeftRadius,cs("veg").borderTopRightRadius,cs("veg").borderBottomLeftRadius,cs("veg").borderBottomRightRadius]},families:document.querySelectorAll("#main .fam").length}})()`);
  await ev(`window.scrollTo(0,0)`);
  let jd = await joined();
  check("Joined: on a desktop Nursery and Veg sit side by side, filling a row of their own, touching with no gap, Garden apart above by the usual gap", Math.abs(jd.side.nv) <= 2 && Math.abs(jd.side.top) < 1 && jd.stack.gn >= 10 && jd.side.gn < 0 && jd.families === 1, jd);
  check("Joined: the link tab sits on their seam, and says what's linked to what", jd.tab.label === "Zone: Nursery is linked to Zone: Veg" && jd.tab.title === jd.tab.label && Math.abs(jd.tab.x) <= 2, jd.tab);
  check("Joined: the outer corners are rounded and the inner ones square", same(jd.corners, { n: ["12px", "0px", "12px", "0px"], v: ["0px", "12px", "0px", "12px"] }), jd.corners);
  /* #119: the seam is drawn at the tab's border weight, and the cards leave room either side of it so the tab doesn't crowd the state chip on its left or the reading's icon on its right. */
  const seamSide = await ev(`(()=>{const c=(id)=>document.querySelector('#main .zone-card[data-zone="'+id+'"]'),n=c("nursery"),v=c("veg"),t=document.querySelector("#main .linktab"),tr=t.getBoundingClientRect(),[l,r]=n.getBoundingClientRect().left<v.getBoundingClientRect().left?[n,v]:[v,n];return {seam:[getComputedStyle(l).borderRightWidth,getComputedStyle(r).borderLeftWidth],tab:getComputedStyle(t).borderTopWidth,chip:Math.round(tr.left-Math.max(...[...l.querySelectorAll(".pillcell .pill")].map(e=>e.getBoundingClientRect().right))),icon:Math.round(Math.min(...[...r.querySelectorAll(".mrow > .ic")].map(e=>e.getBoundingClientRect().left))-tr.right)}})()`);
  check("Joined: side by side the seam is 2px, the tab's border matches it, and the tab clears the state chip on its left and the reading icon on its right by at least 10px", same(seamSide.seam, ["2px", "2px"]) && seamSide.tab === "2px" && seamSide.chip >= 10 && seamSide.icon >= 10, seamSide);
  await shot("joined-seam-1280-light");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(60); await shot("joined-seam-1280-dark"); await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(60);
  const badges = await ev(`[...document.querySelectorAll("#main .zone-card")].map(c=>[c.querySelector("h2").textContent,[...c.querySelectorAll(".parentbadge")].map(b=>b.textContent+(b.previousElementSibling&&b.previousElementSibling.tagName==="H2"?" by name":"")).join(),(c.querySelector(".zlinked")||{}).textContent||""])`);
  check("Joined: the parent carries a Parent badge beside its name, whichever place it sits, and the linked card still says what it's linked to", same(badges, [["Garden", "", ""], ["Nursery", "", "Linked to Zone: Veg"], ["Veg", "Parent by name", "Zone: Nursery is linked to this zone"]]), badges);
  /* The linked line and the combine note sit on the name's line, so a linked or combined card's tracks start level with the rest of its row. */
  const titleLine = () => ev(`(()=>{const R=(e)=>e&&e.getBoundingClientRect(),hit=(a,b)=>!!(a&&b)&&a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5,vo=(a,b)=>!!(a&&b)&&a.top<b.bottom&&b.top<a.bottom;return [...document.querySelectorAll("#main .zone-card")].map(c=>{const r=R(c),h=R(c.querySelector("h2")),n=R(c.querySelector(".cardnote")),b=R(c.querySelector(".parentbadge"));return {zone:c.dataset.zone,top:Math.round(r.top),track:Math.round(R(c.querySelector(".track")).top),linked:vo(h,R(c.querySelector(".zlinked"))),combined:vo(h,R(c.querySelector(".zcombined"))),inside:[h,n,b].filter(Boolean).every(x=>x.left>=r.left-0.5&&x.right<=r.right+0.5),clash:hit(n,h)||hit(n,b)}})})()`);
  const tl = await titleLine(), tlz = (id) => tl.find((c) => c.zone === id) || {};
  check("Title line: on a linked card the linked text sits on the name's line, both sides of the link", tlz("nursery").linked && tlz("veg").linked, tl);
  check("Title line: a card with several sensors says how they combine on the name's line", tlz("garden").combined, tl);
  /* Three across only once each card gets about 640px, so not on a 1700px screen, where they'd be cramped. */
  const perRow = async (w) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(80); return ev(`(()=>{const n={};for(const c of document.querySelectorAll("#main .zone-card")){const t=Math.round(c.getBoundingClientRect().top);n[t]=(n[t]||0)+1}return Math.max(...Object.values(n))})()`); };
  const rows1700 = await perRow(1700), rows2300 = await perRow(2300);
  check("Grid: at 1700px no row of the Overview holds three cards, and at 2300px one does", rows1700 < 3 && rows2300 === 3, { rows1700, rows2300 });
  /* #119: four across on an ultrawide screen, on the same 640px a card, so it takes at least four zones on their own. */
  await ev(`["g2","g3","g4"].forEach((id,i)=>zones.push({...JSON.parse(JSON.stringify(zoneById("garden"))),id,name:"Garden "+(i+2),parent:null}));render()`); await sleep(60);
  const wide = {};
  for (const w of [1700, 2300, 2560, 3440, 5120]) wide[w] = await perRow(w);
  const cardW = await ev(`Math.round(document.querySelector("#main .zone-card").getBoundingClientRect().width)`);
  await ev(`zones.splice(0,zones.length,...zones.filter(z=>!["g2","g3","g4"].includes(z.id)));render()`); await perRow(2300);
  check("Grid: with four zones on their own, a row holds two at 1700px, three at 2300px and 2560px, and four at 3440px and 5120px, a card never wider than about 700px there", same(wide, { 1700: 2, 2300: 3, 2560: 3, 3440: 4, 5120: 4 }) && cardW >= 640 && cardW <= 700, { wide, cardW });
  const tl3 = await titleLine(), tl3z = (id) => tl3.find((c) => c.zone === id) || {};
  check("Title line: a linked card's first track starts level with an unlinked card's in the same row", tl3z("garden").top === tl3z("veg").top && tl3z("garden").track === tl3z("veg").track && tl3z("nursery").track === tl3z("veg").track, tl3);
  /* #119: two across only while each card's tracks stay long enough to read, and one across a card stops at about the
     widest it gets two across, centred, so the step between the two is modest. */
  const across = async (w) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(80); return ev(`(()=>{const g=document.querySelector("#main .cards.zones").getBoundingClientRect(),cs=[...document.querySelectorAll("#main .zone-card")].map(c=>{const r=c.getBoundingClientRect();return {top:Math.round(r.top),w:Math.round(r.width),l:Math.round(r.left-g.left),r:Math.round(g.right-r.right),track:Math.round(Math.min(...[...c.querySelectorAll(".track")].map(t=>t.getBoundingClientRect().width)))}});return {side:cs.some((c,i)=>cs.some((o,j)=>i!==j&&o.top===c.top)),cs}})()`); };
  const short = {}, oneWide = {};
  for (let w = 600; w <= 1400; w += 100) {
    const a = await across(w);
    if (a.side && a.cs.some((c) => c.track < 150)) short[w] = a.cs.map((c) => c.track);
    if (!a.side && a.cs.some((c) => c.w > 700 || Math.abs(c.l - c.r) > 1)) oneWide[w] = a.cs;
  }
  check("Grid: from 600px to 1400px, whenever two cards sit side by side every track is at least 150px long", Object.keys(short).length === 0, short);
  const at900 = await across(900), at1000 = await across(1000), at1100 = await across(1100);
  check("Grid: at 900px and 1000px Overview is one across and goes two across by 1100px", !at900.side && !at1000.side && at1100.side, { at900, at1000, at1100 });
  /* #119: stacked, the seam runs across, and the tab clears the foot of the card above and the title of the card below. */
  await across(900); await ev(`window.scrollTo(0,0)`);
  const seamStack = await ev(`(()=>{const c=(id)=>document.querySelector('#main .zone-card[data-zone="'+id+'"]'),n=c("nursery"),v=c("veg"),t=document.querySelector("#main .linktab"),tr=t.getBoundingClientRect(),[a,b]=n.getBoundingClientRect().top<v.getBoundingClientRect().top?[n,v]:[v,n],kids=(e)=>[...e.children].filter(k=>!k.classList.contains("linktab")).map(k=>k.getBoundingClientRect());return {seam:[getComputedStyle(a).borderBottomWidth,getComputedStyle(b).borderTopWidth],above:Math.round(tr.top-Math.max(...kids(a).map(k=>k.bottom))),below:Math.round(Math.min(...kids(b).map(k=>k.top))-tr.bottom)}})()`);
  check("Joined: stacked at 900px the seam is 2px and the tab clears the text above and below it by at least 6px", same(seamStack.seam, ["2px", "2px"]) && seamStack.above >= 6 && seamStack.below >= 6, seamStack);
  await ev(`document.querySelector("#main .linktab").scrollIntoView({block:"center"})`); await shot("joined-seam-900-light");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(60); await shot("joined-seam-900-dark"); await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(60);
  check("Grid: one across, a card is no wider than 700px and sits centred", Object.keys(oneWide).length === 0 && at1000.cs.every((c) => c.w <= 700 && c.w >= 680), oneWide);
  /* The linked line on the parent's half is the longer one: where it wraps and the other half's line doesn't, the halves still start their readings level. Measured inside the padding, as a card has more of it on the seam side. */
  const levelAt = async (w) => { await across(w); return ev(`(()=>{const o=(id)=>{const c=document.querySelector('#main .zone-card[data-zone="'+id+'"]');const cs=getComputedStyle(c);return Math.round(c.querySelector(".mrow").getBoundingClientRect().top-c.getBoundingClientRect().top-parseFloat(cs.borderTopWidth)-parseFloat(cs.paddingTop))};return {veg:o("veg"),nursery:o("nursery")}})()`); };
  const nurseryName = await ev(`zones.find(z=>z.id==="nursery").name`), level = {};
  await ev(`zones.find(z=>z.id==="nursery").name="Nursery bench by the door";render()`);
  for (const w of [900, 1000, 1100]) level[w] = await levelAt(w);
  await ev(`zones.find(z=>z.id==="nursery").name="Nursery bench by the back door on the left shelf";render()`);
  level.long1280 = await levelAt(1280);
  await ev(`zones.find(z=>z.id==="nursery").name=${JSON.stringify(nurseryName)};render()`);
  check("Joined: at 900px, 1000px and 1100px, and at 1280px with a linked line that wraps on one half only, both halves start their first reading row at the same height", Object.values(level).every((l) => l.veg === l.nursery), level);
  /* Sorting uses the same grid: the family's strip runs the width of the family, stacked or side by side. */
  const strip = {};
  for (const w of [1000, 1280]) {
    await across(w); await tap("[data-sort]");
    strip[w] = await ev(`(()=>{const b=document.querySelector("#main .fambar").getBoundingClientRect(),f=document.querySelector("#main .famcards").getBoundingClientRect();return Math.abs(b.left-f.left)<=1&&Math.abs(b.right-f.right)<=1&&Math.abs(b.bottom-f.top)<=1})()`);
    await tap("[data-sortback]");
  }
  check("Sort: the family's strip spans its cards at 1000px, stacked, and at 1280px, side by side", strip[1000] === true && strip[1280] === true, strip);
  const vegName = await ev(`zones.find(z=>z.id==="veg").name`);
  for (const w of [2300, 1280, 760, 500]) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(60);
    for (const long of [false, true]) {
      if (long) { await ev(`zones.find(z=>z.id==="veg").name="Veg room with a rather long name for its card";render()`); await sleep(40); }
      /* A name too long for the line wraps, and the note goes under it, so only then may a card's tracks sit lower. */
      const t = await titleLine(), bad = t.filter((c) => !c.inside || c.clash || (!long && t.some((o) => o.top === c.top && o.track !== c.track)));
      check(`Title line: at ${w} px${long ? " with a long name" : ""} nothing on the name's line is cut off or overlapped${long ? "" : ", and cards in a row start their tracks level"}`, bad.length === 0, t);
    }
    await ev(`zones.find(z=>z.id==="veg").name=${JSON.stringify(vegName)};render()`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(60);
  const seamAt = await ev(`(()=>{const n=document.querySelector('#main .zone-card[data-zone="nursery"]').getBoundingClientRect();return {x:n.left+n.width/2,y:n.top+40,sx:n.right-0.5,sy:n.top+40}})()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: seamAt.x, y: seamAt.y }); await sleep(80);
  check("Joined: a card's own border shows whole on just that card, over the seam it shares", (await ev(`document.elementFromPoint(${seamAt.sx},${seamAt.sy}).closest(".zone-card").dataset.zone`)) === "nursery" && (await ev(`getComputedStyle(document.querySelector('#main .zone-card[data-zone="nursery"]')).borderRightColor===getComputedStyle(document.querySelector('#main .zone-card[data-zone="nursery"]')).borderTopColor && getComputedStyle(document.querySelector('#main .zone-card[data-zone="veg"]')).borderTopColor!==getComputedStyle(document.querySelector('#main .zone-card[data-zone="nursery"]')).borderTopColor`)) === true);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await shot("joined-desktop");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await tap("[data-sort]"); await ev(`window.scrollTo(0,0)`); await shot("joined-sort-desktop-dark");
  await tap("[data-sortback]"); await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(60);
  await tap('#main .zone-card[data-zone="nursery"] .rows');
  check("Joined: each card still opens its own zone", (await ev(`ui.screen==="zone"&&ui.zone==="nursery"`)) === true);
  await goTab("Overview");
  await phone(390, 844); await ev(`window.scrollTo(0,0)`); jd = await joined();
  check("Joined: on a phone they stack, still touching, the seam running across with the tab on it, Garden apart", Math.abs(jd.stack.nv) <= 2 && Math.abs(jd.stack.left) < 1 && jd.stack.gn >= 10 && Math.abs(jd.tab.y) <= 2 && same(jd.corners, { n: ["12px", "12px", "0px", "0px"], v: ["0px", "0px", "12px", "12px"] }), jd);
  /* An order that splits a family can still arrive, from an older setup: each stray is pulled to just after its family. */
  await fakeConfig(`const by=(id)=>c.zones.find(z=>z.id===id);c.zones=[by("veg"),by("garden"),by("nursery")]`);
  check("Joined: a stored order that splits a family is read with the linked zone pulled to just after its parent's family", same(await cardNames(), ["Veg", "Nursery", "Garden"]) && same(await menuItems(), ["Overview", "Veg", "Nursery", "Garden", "Devices", "Setup"]), [await cardNames(), await menuItems()]);
  await realConfig();
  check("Sort: nothing the person sees says Arrange", (await ev(`(()=>{const out=[];for(const s of ["overview","setup"]){ui.screen=s;render();out.push(document.body.innerText)}ui.screen="overview";render();document.querySelector("[data-sort]").click();out.push(document.body.innerText);document.querySelector("[data-sortback]").click();return /arrang/i.test(out.join(" ")+document.querySelector("[data-sort]").outerHTML)})()`)) === false);
  /* Later checks count on the seeded order. */
  check("Sort: putting the seeded order back for the checks that follow", (await evp(`saveConfig(()=>{const o=["garden","veg","nursery"];zones.sort((a,b)=>o.indexOf(a.id)-o.indexOf(b.id))}).then(r=>{render();return r.ok})`)) === true && same(await diskOrder(), order0));
  await phone(390, 844); await reset();
}

// ---------- Confirmation: a device becomes controllable only once a person says yes, in a dialog the frame can't reach
/* Page scripts can't see into the host's closed shadow root, but the test can, through DevTools, and clicks it as a person would. */
await rawSend("DOM.enable");
async function hostDialog() {
  const doc = await rawSend("DOM.getDocument", { depth: -1, pierce: true }), out = { open: false, buttons: {} };
  const walk = (n) => {
    const a = n.attributes || [];
    if (n.nodeName === "DIALOG") { out.open = a.includes("open"); out.node = n.nodeId; }
    if (n.nodeName === "BUTTON" && a.includes("data-host")) out.buttons[a[a.indexOf("data-host") + 1]] = { id: n.nodeId, disabled: a.includes("disabled") };
    if (n.nodeName === "IFRAME") return;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  };
  walk(doc.result.root);
  if (out.node) {
    const html = (await rawSend("DOM.getOuterHTML", { nodeId: out.node })).result.outerHTML.replace(/<style>.*?<\/style>/s, "");
    out.text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.lines = [...html.matchAll(/<(p|span|strong|summary)\b[^>]*>([^<]*)<\/\1>/g)].map((x) => x[2].trim());
  }
  return out;
}
async function hostClick(which) {
  const d = await hostDialog(), b = d.buttons[which];
  const q = (await rawSend("DOM.getBoxModel", { nodeId: b.id })).result.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rawSend("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await sleep(150);
}
const spareMapped = () => ev(`devices.find(d=>d.id==="spare-plug").zones.join()`);
const addSpare = async () => {
  await ev(`ui.review=null;ui.guard=null;renderModal();ui.screen="setup";openMap("garden");ui.mapw.roles.plug="Heater";ui.mapw.step=2;render()`); await sleep(40);
  await ev(`document.querySelector('[data-mdevice="spare-plug"]').click()`); await sleep(40);
  await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(50);
  await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
  await ev(`document.querySelector("[data-rapply]").click()`); await sleep(200);
};
await phone(390, 844); await addSpare();
let dlg = await hostDialog();
check("Confirm: adding a controllable device opens HA's own dialog, outside the panel", dlg.open && dlg.text.startsWith("Allow Environment Control to control these?") && dlg.text.includes("switch.spare_plug") && dlg.text.includes("Spare Plug. tuya_local") && dlg.text.includes("Can be switched on and off"), dlg.text);
check("Confirm: an entity with no area is flagged", dlg.text.includes("Has no area in Home Assistant."), dlg.text);
check("Confirm: every sentence in the dialog ends in a full stop, so a short zone name can't read as cut off", dlg.lines.length > 3 && dlg.lines.every((l) => l.endsWith(".")), dlg.lines);
check("Confirm: it waits, saving nothing, while the review shows it's working", (await ev(`!!ui.review && ui.review.busy`)) === true && (await spareMapped()) === "", await spareMapped());
await shot("confirm-host-phone");
check("Confirm: Allow starts off, so a tap aimed elsewhere can't land on it", dlg.buttons.allow.disabled === true, dlg.buttons);
await hostClick("allow");
check("Confirm: a tap in that first second does nothing", (await hostDialog()).open === true && (await spareMapped()) === "");
await hostClick("cancel");
check("Confirm: Cancel saves nothing and keeps the review open with why", (await hostDialog()).open === false && (await spareMapped()) === "" && ((await ev(`ui.review ? ui.review.errors : null`)) || []).some((e) => e.includes("Not allowed")), await ev(`ui.review ? ui.review.errors : null`));
check("Confirm: and nothing reached storage", (await onHA(`JSON.parse(fakeHA.disk).devices.find(d=>d.id==="spare-plug").zones.length`)) === 0);
const refused = await evp(`ask("device",{id:"spare-plug",action:"turn_on"}).then(r=>r.ok)`);
check("Confirm: the host still won't control it", refused === false);
await ev(`document.querySelector("[data-rapply]").click()`); await sleep(1200);
await hostClick("allow"); await sleep(200);
check("Confirm: Allow, after a second, saves it", (await hostDialog()).open === false && (await spareMapped()) === "garden" && (await ev(`ui.review`)) === null, [await spareMapped(), await ev(`ui.review ? ui.review.errors : null`)]);
await evp(`ask("device",{id:"spare-plug",action:"turn_on"})`); await sleep(REPORT);
check("Confirm: and now the host controls it", (await onHA(`fakeHA.states["switch.spare_plug"].state`)) === "on");
await evp(`ask("device",{id:"spare-plug",action:"turn_off"})`); await sleep(REPORT);
const r1 = await evp(`saveConfig(()=>{devices.find(d=>d.id==="spare-plug").type="Heater"}).then(r=>r.ok)`); await sleep(100);
check("Confirm: changing only a device's role doesn't ask again", r1 === true && (await hostDialog()).open === false);
const r2 = await evp(`saveConfig(()=>{devices.find(d=>d.id==="spare-plug").zones=[]}).then(r=>r.ok)`); await sleep(100);
check("Confirm: removing a device never asks", r2 === true && (await hostDialog()).open === false && (await spareMapped()) === "");
/* What a compromised frame could try: slip the reservoir pump into a zone under a harmless name. */
const sneaky = evp(`saveConfig(()=>{devices.push({id:"heater-2",name:"Heater 2",type:"Heater",icon:"thermo",ctl:"switch",zones:["garden"],entity:"switch.reservoir_pump"})}).then(r=>r.ok)`);
await sleep(300); dlg = await hostDialog();
check("Confirm: the dialog names the real entity, not the name the frame gave it", dlg.open && dlg.text.includes("switch.reservoir_pump") && dlg.text.includes("Reservoir Pump") && !dlg.text.includes("Heater 2"), dlg.text);
check("Confirm: and flags that it's in another area", dlg.text.includes("In the Reservoir area in Home Assistant, not in the Garden area.") && dlg.text.includes("for the Garden zone."), dlg.text);
await key("Escape", 27); await sleep(150);
check("Confirm: Escape is a no", (await sneaky) === false && (await hostDialog()).open === false && (await onHA(`JSON.parse(fakeHA.disk).devices.some(d=>d.entity==="switch.reservoir_pump")`)) === false);
const linking = evp(`saveConfig(()=>{const z=zoneById("veg");z.helpers.bands.day.vpd.min="input_number.spare_vpd_threshold"}).then(r=>r.ok)`);
await sleep(300); dlg = await hostDialog();
check("Confirm: a newly linked helper is asked about too, folded under a count", dlg.open && dlg.text.includes("1 helper: values can be changed") && dlg.text.includes("input_number.spare_vpd_threshold") && dlg.text.includes("Allow 1 helper"), dlg.text);
await sleep(1100); await hostClick("allow"); await sleep(150);
check("Confirm: and once allowed, the link is saved", (await linking) === true && (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="veg").helpers.bands.day.vpd.min`)) === "input_number.spare_vpd_threshold");
const unlinking = evp(`saveConfig(()=>{zoneById("veg").helpers.bands.day.vpd.min="input_number.veg_day_vpd_min_threshold"}).then(r=>r.ok)`);
await sleep(1300); await hostClick("allow");
check("Confirm: putting back a helper that was dropped asks again, since it's new again", (await unlinking) === true);
const unknown = await evp(`saveConfig(()=>{devices.push({id:"lock",name:"Lock",ctl:"switch",zones:["garden"],entity:"lock.front_door"})}).then(r=>[r.ok,r.error])`);
check("Confirm: an entity the panel can't control is refused without asking", unknown[0] === false && unknown[1].includes("isn't something this panel can control") && (await hostDialog()).open === false, unknown);
/* The plug's question was answered only to get past it here, so it goes back to unanswered for the tests after. */
await ev(`ui.review=null;ui.mapw=null;renderModal();devices.find(d=>d.id==="plug").type=null;ui.screen="zone";ui.zone="garden";render()`); await sleep(40);
await tap("#main .notice.fix");
/* Since #36 a device's type is said in Device identification, so the notice opens its Devices step at that device. */
check("Controls: an unidentified plug's notice lands on it in Device identification", (await ev(`ui.screen==="setup" && !!ui.mapw && ui.mapw.step===2 && !!document.querySelector("#md-plug")`)) === true && (await ev(`(()=>{const r=document.querySelector("#md-plug").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`)) === true);
const plugRole = async (role) => {
  await ev(`(()=>{const s=document.querySelector('[data-mrole="plug"]');s.value="${role}";s.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(30);
  await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(50);
  await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
  await ev(`document.querySelector("[data-rapply]").click()`); await sleep(250);
};
await plugRole("Other"); await goTab("Garden");
check("Controls: a plug marked Other stays out and the notice goes", !(await groupNames()).includes("Plug 7") && (await ev(`document.querySelectorAll("#main .notice.fix").length`)) === 0, await groupNames());
await ev(`devices.find(d=>d.id==="plug").type=null;render()`); await sleep(30);
await ev(`document.querySelector("#main .notice.fix").click()`); await sleep(80);
await plugRole("Heater"); await goTab("Garden");
check("Controls: a plug marked Heater joins Temperature", (await ev(`document.querySelector('[data-cgroup="Temperature"]').textContent`)).includes("Plug 7"));
await ev(`devices.find(d=>d.id==="plug").type=null;render()`);

// ---------- The zone page's menu: View targets, View activity and View automations, behind one button in the heading
await phone(390, 844); await reset(); await goTab("Garden");
const MORE = '[data-zmenu="-more"]';
const moreOpen = () => ev(`!document.querySelector("#zmenu--more").hidden && document.querySelector('${MORE}').getAttribute("aria-expanded")==="true"`);
const moreFocused = () => ev(`document.activeElement.dataset.zmenu==="-more"`);
const moreClosed = () => ev(`(()=>{const m=document.querySelector("#zmenu--more"),b=document.querySelector('${MORE}');return !!m&&!!b&&m.hidden&&b.getAttribute("aria-expanded")==="false"})()`);
const tellBack = () => onHA(`document.querySelector("environment-control-panel").post({type:"back"})`).then(() => sleep(60));
const moreBtn = await ev(`(()=>{const b=document.querySelector('${MORE}'),n=document.querySelector(".navmenu .burger"),r=b.getBoundingClientRect(),q=n.getBoundingClientRect();return {label:b.getAttribute("aria-label"),pop:b.getAttribute("aria-haspopup"),exp:b.getAttribute("aria-expanded"),dots:b.querySelector("svg path").getAttribute("d")===ICON.dots,cls:b.className===n.className,w:r.width,h:r.height,nw:q.width,nh:q.height,inHead:!!b.closest(".pagehead"),right:r.right,wrapRight:document.querySelector("#main .wrap").getBoundingClientRect().right}})()`);
check("Zone menu: the heading's button is More, a menu button showing three dots", moreBtn.label === "More" && moreBtn.pop === "menu" && moreBtn.exp === "false" && moreBtn.dots && moreBtn.inHead, moreBtn);
check("Zone menu: it's the page menu's button in size and look, at the right of the heading", moreBtn.cls && moreBtn.w === moreBtn.nw && moreBtn.h === moreBtn.nh && Math.abs(moreBtn.right - moreBtn.wrapRight) < 1, moreBtn);
check("Zone menu: View targets is no longer a button of its own", (await ev(`[...document.querySelectorAll("#main [data-viewtargets]")].every(b=>b.closest(".menu"))`)) === true);
check("Zone menu: it's closed until asked", (await moreOpen()) === false && (await ev(`document.querySelector("#zmenu--more").hidden`)) === true);
await tap(MORE);
check("Zone menu: a tap opens it, with focus on its first item", (await moreOpen()) && (await ev(`document.activeElement.textContent`)) === "View targets", await ev(`document.activeElement.outerHTML.slice(0,80)`));
check("Zone menu: View targets, View activity and View automations, in that order, each a menu item", same(await ev(`[...document.querySelectorAll("#zmenu--more > *")].map(b=>b.getAttribute("role")+":"+b.textContent)`), ["menuitem:View targets", "menuitem:View activity", "menuitem:View automations"]), await ev(`[...document.querySelectorAll("#zmenu--more > *")].map(b=>b.textContent)`));
for (const [w, h, name] of [[390, 844, "phone"], [320, 640, "small phone"], [1280, 900, "desktop"]]) {
  if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
  await ev(`window.scrollTo(0,0)`); await sleep(60);
  if (!(await moreOpen())) await tap(MORE);
  const box = await ev(`(()=>{const m=document.querySelector("#zmenu--more").getBoundingClientRect(),b=document.querySelector('${MORE}').getBoundingClientRect();return {l:m.left,r:m.right,t:m.top,b:m.bottom,br:b.right,bb:b.bottom,w:innerWidth,h:innerHeight}})()`);
  check(`Zone menu ${name}: it opens downward from the button's right edge, on screen`, box.t >= box.bb && Math.abs(box.r - box.br) < 1 && box.l >= 0 && box.r <= box.w && box.b <= box.h, box);
  await shot(`zone-menu-${name.replace(" ", "-")}`);
}
await phone(390, 844); await ev(`window.scrollTo(0,0)`); await sleep(60);
if (!(await moreOpen())) await tap(MORE);
await key("ArrowDown", 40);
check("Zone menu: the arrow keys move along it", (await ev(`document.activeElement.textContent`)) === "View activity");
await key("Escape", 27);
check("Zone menu: Escape closes it and hands focus back to its button", !(await moreOpen()) && (await moreFocused()));
await tap(MORE); await tap(MORE);
check("Zone menu: tapping the button again closes it", await moreClosed());
await tap(MORE); await tap("#main h1");
check("Zone menu: a tap anywhere else closes it", await moreClosed());
await tap(MORE); await tellBack();
check("Zone menu: Back closes it, focus back on its button, and stays on the zone", !(await moreOpen()) && (await moreFocused()) && (await ev(`ui.screen==="zone" && ui.zone==="garden"`)) === true);
await tap(MORE); await tap('#zmenu--more [data-viewtargets="garden"]');
check("Zone menu: View targets opens the Targets dialog, and the menu closes", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Targets: Garden" && !(await moreOpen()) && same(await ev(`[...document.querySelectorAll("#modal .dlgfoot button")].map(b=>b.textContent)`), ["Close", "Set targets"]));
await tap("[data-tclose]");
check("Zone menu: closing Targets hands focus back to the menu's button", (await ev(`document.querySelector("#modal").hidden`)) === true && (await moreFocused()));

// The Activity design moved off the zone page into the dialog View activity opens. It reads a day at a time from the host,
// in the shape the backend's logbook command returns (#133).
check("Activity: the zone page has no Activity card", (await ev(`[...document.querySelectorAll("#main h2")].some(h=>h.textContent==="Activity") || !!document.querySelector("#main .act, #main [data-activity]")`)) === false);
/* The fake's entries are fixed NZ times, so the dialog is read in NZ time wherever the suite runs. */
await send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Auckland" });
await onHA(`fakeHA.knobs.activityMs=400;fakeHA.activityCalls=[];window.actAsked=[];if(!window.actHooked){window.actHooked=true;addEventListener("message",(e)=>{if(e.data&&e.data.type==="activity")window.actAsked.push(e.data)})}`);
const openAct = async (zone = "garden") => { await tap(MORE); await tap(`#zmenu--more [data-viewactivity="${zone}"]`); };
const actIdle = async () => { for (let n = 0; n < 40 && (await ev(`!!document.querySelector("#act-body .act-loading")`)); n++) await sleep(100); };
await openAct();
const actDlg = () => ev(`(()=>{const d=document.querySelector("#modal .dialog");return d && {role:d.getAttribute("role"),modal:d.getAttribute("aria-modal"),title:d.querySelector("#dlg-title").textContent,named:d.getAttribute("aria-labelledby"),chips:[...d.querySelectorAll("[data-activity]")].map(b=>b.textContent+(b.getAttribute("aria-pressed")==="true"?"*":"")),group:d.querySelector(".seg").getAttribute("aria-label"),bar:[...d.querySelectorAll(".dlgfoot button")].map(b=>b.textContent),days:[...d.querySelectorAll(".act-day h3")].map(h=>h.textContent),loading:(d.querySelector(".act-loading")||{}).textContent||"",rows:[...d.querySelectorAll(".act-row")].map(r=>({kind:r.dataset.kind,text:r.querySelector(".act-text").textContent,by:(r.querySelector(".act-by")||{}).textContent||"",un:r.classList.contains("unavail"),day:r.closest(".act-day").dataset.day})),earlier:!!d.querySelector("[data-aearlier]"),end:(d.querySelector("#act-end")||{}).textContent||"",error:(d.querySelector("#act-error span")||{}).textContent||"",retry:!!d.querySelector("[data-aretry]")}})()`);
let ad = await actDlg();
check("Activity: while the day is read it says so, under the heading and chips", ad.loading === "Reading today from Home Assistant..." && ad.days.length === 0, ad.loading);
await actIdle(); ad = await actDlg();
check("Activity: View activity opens a dialog titled Activity: Garden, with Close in its foot bar", ad && ad.role === "dialog" && ad.modal === "true" && ad.named === "dlg-title" && ad.title === "Activity: Garden" && same(ad.bar, ["Close"]), ad && ad.title);
check("Activity: its chips are All, Devices, Lights, Automations, Climate and Sensors", ad.group === "Activity type" && same(ad.chips, ["All*", "Devices", "Lights", "Automations", "Climate", "Sensors"]), ad.chips);
check("Activity: the page behind it can't be reached", (await ev(`document.querySelector("#main").inert`)) === true);
const actAskedNow = await onHA(`window.actAsked.map(m=>({keys:Object.keys(m).sort(),zone:m.zone,day:m.day}))`), toHA = await onHA(`fakeHA.activityCalls.map(m=>JSON.stringify(m))`);
check("Activity: the frame asks for a zone and a day, and never names an entity", actAskedNow.length === 1 && same(actAskedNow[0].keys, ["day", "req", "type", "v", "zone"]) && actAskedNow[0].zone === "garden" && actAskedNow[0].day === "2026-11-17" && same(toHA, ['{"type":"environment_control/activity","zone":"garden","day":"2026-11-17"}']), { actAskedNow, toHA });
check("Activity: today comes first under its own heading, newest first", same(ad.days, ["Today"]) && ad.rows[0].text === "Failsafe Garden Lights Recovery ran 405 times, 00:00 to 13:28", ad.rows.slice(0, 2));
const rowsLike = (re) => ad.rows.filter((r) => re.test(r.text));
let hum = rowsLike(/^Critical Garden Humidity Low Day (fired|ran)/);
check("Activity: a streak of runs is one row with its count and its first and last times, and an alert's streak fired", hum.length === 1 && hum[0].text === "Critical Garden Humidity Low Day fired 790 times, 07:02 to 09:14" && hum[0].by === "When Garden Environment Average Humidity changed" && hum[0].kind === "automation", hum);
check("Activity: a single run reads ran at, with its trigger in plain words", rowsLike(/^Garden Lights On ran/).length === 1 && rowsLike(/^Garden Lights On ran/)[0].text === "Garden Lights On ran at 07:00" && rowsLike(/^Garden Lights On ran/)[0].by === "At a set time", rowsLike(/^Garden Lights On/));
check("Activity: a timer's streak says on a timer", ad.rows[0].by === "On a timer", ad.rows[0]);
check("Activity: an automation switched off by hand is an automation row, by that person", rowsLike(/switched off$/).length === 1 && rowsLike(/switched off$/)[0].text === "Critical Garden Humidity Low Day switched off" && rowsLike(/switched off$/)[0].by === "By Sam" && rowsLike(/switched off$/)[0].kind === "automation", rowsLike(/switched/));
const un = rowsLike(/went unavailable$/);
check("Activity: a device going unavailable has its own row style, not on or off", un.length === 1 && un[0].text === "Air conditioner exhaust fan went unavailable" && un[0].un && ad.rows.filter((r) => r.un).length === 1 && (await ev(`getComputedStyle(document.querySelector(".act-row.unavail")).borderLeftStyle`)) === "dashed", un);
check("Activity: an automation the zone doesn't link is still named as the cause, with its trigger", rowsLike(/^Dehumidifier turned on$/)[0]?.by === "By Day Humidity Upper Limit, when Garden Environment Average Humidity crossed a limit", rowsLike(/^Dehumidifier/));
check("Activity: Came back online and By a person read as written", rowsLike(/^Air conditioner exhaust fan turned on$/)[0]?.by === "Came back online" && rowsLike(/^Air conditioner turned on$/)[0]?.by === "By Sam", ad.rows.filter((r) => /^Air/.test(r.text)));
check("Activity: climate and sensor rows stay, worked out from history", rowsLike(/^Humidity above ideal zone at 67\.4%$/).length === 1 && rowsLike(/^Environment under stopped reporting$/).length === 1 && rowsLike(/^Environment under came back$/).length === 1, ad.rows.filter((r) => /climate|sensor/.test(r.kind)));
// Same second, same cause: one row that opens to show its parts
const grp = () => ev(`(()=>{const b=document.querySelector('[data-day="2026-11-17"] [data-agroup]');const r=b.closest(".act-row");return {text:b.textContent,exp:b.getAttribute("aria-expanded"),by:r.querySelector(".act-by").textContent,kind:r.dataset.kind,parts:[...r.querySelectorAll(".act-part")].map(p=>p.textContent),groups:document.querySelectorAll('[data-day="2026-11-17"] [data-agroup]').length}})()`);
let g = await grp();
check("Activity: lights switched on in the same second by one cause are one row, closed", g.groups === 1 && g.text === "Lights on: 4 devices" && g.exp === "false" && g.parts.length === 0 && g.kind === "lights" && g.by === "By Garden Lights On, at a set time" && rowsLike(/^Overhead lights 1/).length === 0, g);
await tap('[data-day="2026-11-17"] [data-agroup]'); g = await grp();
check("Activity: tapping the row opens it to list each device, and keeps focus on it", g.exp === "true" && same(g.parts, ["Overhead light controller turned on", "Overhead lights 1 turned on", "Overhead lights 2 turned on", "Under canopy light controller turned on"]) && (await ev(`!!document.activeElement.dataset.agroup`)) === true, g);
await tap('[data-day="2026-11-17"] [data-agroup]'); g = await grp();
check("Activity: tapping it again closes it", g.exp === "false" && g.parts.length === 0, g);
// Earlier: the day before under its own heading, back to as far as history goes
check("Activity: Earlier is offered under today while there's more history", ad.earlier && !ad.end, ad);
await tap("[data-aearlier]"); ad = await actDlg();
check("Activity: Earlier reads the day before, saying so below what's shown", ad.loading === "Reading yesterday from Home Assistant..." && same(ad.days, ["Today"]) && !ad.earlier, ad.loading);
await actIdle(); ad = await actDlg();
hum = ad.rows.filter((r) => r.day === "2026-11-16" && /^Critical Garden Humidity Low Day (fired|ran)/.test(r.text));
check("Activity: the day before loads beneath, under Yesterday, and its streak of thousands is one row", same(ad.days, ["Today", "Yesterday"]) && hum.length === 1 && hum[0].text === "Critical Garden Humidity Low Day fired 3,961 times, 07:02 to 18:59" && (await ev(`document.activeElement.textContent`)) === "Yesterday", { days: ad.days, hum });
check("Activity: a restart reads After a restart, its changes grouped, and the run it caused says so", ad.rows.some((r) => r.day === "2026-11-16" && r.text === "3 devices changed" && r.by === "After a restart") && ad.rows.some((r) => r.text === "Failsafe Dehumidifier Mains Auto On ran at 03:12" && r.by === "When Home Assistant started"), ad.rows.filter((r) => r.day === "2026-11-16" && /03:|restart|changed/.test(r.text + r.by)));
check("Activity: No cause recorded where the log has none", ad.rows.some((r) => r.text === "Heater turned off" && r.by === "No cause recorded"), ad.rows.filter((r) => /Heater/.test(r.text)));
check("Activity: in the same second, a failsafe credited by the log is its own row beside the schedule's group", ad.rows.some((r) => r.day === "2026-11-16" && r.text === "Lights off: 3 devices" && r.by === "By Garden Lights Off, at a set time") && ad.rows.some((r) => r.day === "2026-11-16" && r.text === "Overhead lights 2 turned off" && r.by === "By Failsafe Garden Lights Recovery, on a timer"), ad.rows.filter((r) => r.day === "2026-11-16" && /off/.test(r.text)));
await tap("[data-aearlier]"); await actIdle(); ad = await actDlg();
check("Activity: Earlier stops at the earliest day, and says plainly that history goes no further back", same(ad.days, ["Today", "Yesterday", "Sunday 15 November"]) && !ad.earlier && ad.end === "History goes no further back. Home Assistant keeps it from Sunday 15 November at 09:14." && same((await onHA(`window.actAsked.map(m=>m.day)`)), ["2026-11-17", "2026-11-16", "2026-11-15"]), { days: ad.days, end: ad.end });
check("Activity: no row is a dehumidifier's mode or a light's brightness: the log can't supply them", ad.rows.length > 30 && ad.rows.every((r) => !/mode|brightness|dimmed|%\s*bright/i.test(r.text + r.by)), ad.rows.filter((r) => /mode|bright/i.test(r.text)));
check("Activity: times are local and 24 hour", (await ev(`[...document.querySelectorAll("#act-body .act-time")].every(t=>/^([01]\\d|2[0-3]):[0-5]\\d$/.test(t.textContent))`)) === true);
await shot("activity-dialog-phone");
// Each filter shows only its kind, across every day read
for (const [k, label] of [["device", "Devices"], ["lights", "Lights"], ["automation", "Automations"], ["climate", "Climate"], ["sensor", "Sensors"]]) {
  await tap(`#modal [data-activity="${k}"]`); ad = await actDlg();
  check(`Activity: ${label} shows only its own kind, and keeps focus`, ad.chips.includes(`${label}*`) && ad.rows.length > 0 && ad.rows.every((r) => r.kind === k) && (await ev(`document.activeElement.dataset.activity`)) === k && same(ad.days, ["Today", "Yesterday", "Sunday 15 November"]), { k, rows: ad.rows.map((r) => r.kind + ":" + r.text) });
}
check("Activity: a day with nothing of a kind says so under its heading", (await ev(`(()=>{const d=document.querySelector('[data-day="2026-11-15"]');return !d.querySelector(".act-row") && d.querySelector("p").textContent})()`)) === "Nothing of this kind on this day.");
await tap('#modal [data-activity="all"]');
// At phone width the days scroll inside the dialog, and the heading and chips stay put
const fixed = () => ev(`(()=>{const d=document.querySelector("#modal .dialog"),b=document.querySelector("#act-body");return {h:document.querySelector("#dlg-title").getBoundingClientRect().top,c:d.querySelector(".seg").getBoundingClientRect().top,f:d.querySelector(".dlgfoot").getBoundingClientRect().bottom,scrolls:b.scrollHeight>b.clientHeight+50,dTop:d.scrollTop,vh:innerHeight}})()`);
const f0 = await fixed(); await ev(`document.querySelector("#act-body").scrollTop=1e6`); await sleep(60); const f1 = await fixed();
check("Activity: on a phone the list scrolls inside the dialog, with the heading, chips and Close staying put", f0.scrolls && f0.h === f1.h && f0.c === f1.c && f1.dTop === 0 && f1.f <= f1.vh && (await ev(`document.documentElement.scrollWidth<=innerWidth`)) === true, { f0, f1 });
await tap("[data-aclose]");
check("Activity: Close shuts it and hands focus back to the menu's button", (await ev(`document.querySelector("#modal").hidden && !ui.aview && !ui.act`)) === true && (await moreFocused()));
// Busy and too slow: a retry, not a spinner forever
await onHA(`fakeHA.knobs.activity="busy"`); await openAct(); await actIdle(); ad = await actDlg();
check("Activity: Home Assistant answering busy shows why, with Try again", ad.error === "Home Assistant was busy and couldn't read today." && ad.retry && ad.days.length === 0, ad.error);
await onHA(`fakeHA.knobs.activity=null`); await tap("[data-aretry]"); await actIdle(); ad = await actDlg();
check("Activity: Try again reads the day once Home Assistant can", same(ad.days, ["Today"]) && !ad.retry && ad.rows.length > 5, ad.days);
await onHA(`fakeHA.knobs.activity="timeout";document.querySelector("environment-control-panel").activityTimeoutMs=500`);
await tap("[data-aearlier]"); await sleep(900); await actIdle(); ad = await actDlg();
check("Activity: no answer in time shows a retry under the days already read", ad.error === "Home Assistant took too long to read yesterday." && ad.retry && same(ad.days, ["Today"]) && !ad.earlier, ad.error);
await onHA(`fakeHA.knobs.activity=null;document.querySelector("environment-control-panel").activityTimeoutMs=20000`); await tap("[data-aretry]"); await actIdle(); ad = await actDlg();
check("Activity: Try again then reads that day", same(ad.days, ["Today", "Yesterday"]) && !ad.retry, ad.days);
await tap("[data-aclose]");
await openAct(); await actIdle(); await ev(`ui.act.open={}`);
check("Activity: opening it again starts from today", same((await actDlg()).days, ["Today"]));
await key("Escape", 27);
check("Activity: Escape shuts it", (await ev(`document.querySelector("#modal").hidden`)) === true && (await moreFocused()));
const actShown = () => ev(`!!ui.aview && !document.querySelector("#modal").hidden && document.querySelector("#dlg-title").textContent==="Activity: Garden"`);
await openAct(); let actWas = await actShown(); await tellBack();
check("Activity: Back shuts it", actWas === true && (await ev(`document.querySelector("#modal").hidden`)) === true && (await ev(`ui.screen==="zone"`)) === true && (await moreFocused()));
await openAct(); actWas = await actShown();
await ev(`document.querySelector("#modal").click()`); await sleep(40);
check("Activity: a tap outside the dialog shuts it", actWas === true && (await ev(`document.querySelector("#modal").hidden`)) === true);
await goTab("Nursery"); await openAct("nursery"); await actIdle(); ad = await actDlg();
check("Activity: a zone whose history starts today offers no Earlier, and says so", same(ad.days, ["Today"]) && !ad.earlier && ad.end === "History goes no further back. Home Assistant keeps it from Tuesday 17 November at 00:00." && ad.title === "Activity: Nursery", ad);
await tap("[data-aclose]"); await goTab("Garden");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await ev(`window.scrollTo(0,0)`);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(150);
await openAct(); await actIdle(); await tap('[data-day="2026-11-17"] [data-agroup]'); await tap("[data-aearlier]"); await actIdle(); await ev(`document.querySelector("#act-body").scrollTop=0`); await shot("activity-dialog-desktop"); await tap("[data-aclose]");
await send("Emulation.setEmulatedMedia", { features: [] }); await send("Emulation.setTimezoneOverride", { timezoneId: "" }); await onHA(`fakeHA.knobs.activityMs=300`);
await phone(390, 844); await reset(); await goTab("Garden");
await tap(MORE); await tap('#zmenu--more [data-autos="alert"]');
/* Since #113 View automations opens a dialog over the zone's page, as View targets and View activity do. */
const autosDlg = () => ev(`(()=>{const d=document.querySelector("#modal [data-autosdlg]");return d && {role:d.getAttribute("role"),modal:d.getAttribute("aria-modal"),title:d.querySelector("#autos-title").textContent,named:d.getAttribute("aria-labelledby"),bar:[...d.querySelectorAll(".dlgfoot button:not([hidden])")].map(b=>b.textContent),shown:!document.querySelector("#modal").hidden,under:document.querySelector("#main").inert&&ui.screen==="zone"&&!!document.querySelector("#main .zone-head, #main h1")&&document.querySelector("#main h1").textContent.includes("Garden")}})()`);
let adl = await autosDlg();
check("Zone menu: View automations opens Garden's automations on Alerts in a dialog, the zone's page still under it", (await ev(`ui.zone==="garden" && ui.autos.page==="alert"`)) === true && !!adl && adl.shown && adl.under && adl.role === "dialog" && adl.modal === "true" && adl.named === "autos-title" && adl.title === "Automations: Garden" && (await ev(`document.activeElement.id`)) === "autos-title", adl);
check("Automations: built as the Targets and Activity dialogs are, its Close in the foot bar inside the dialog", !!adl && same(adl.bar, ["Close"]) && (await ev(`!!document.querySelector("#modal [data-autosdlg] > .dlgfoot [data-uclose]") && document.querySelector("#modal [data-autosdlg]").classList.contains("dialog")`)) === true, adl);
check("Automations: there's no Automations page left to route to", (await ev(`(()=>{const was=ui.screen;ui.screen="autos";let routed=true;try{render()}catch(e){routed=false}ui.screen=was;render();return routed})()`)) === false && (await ev(`[...document.querySelectorAll("[data-go]")].some(b=>b.dataset.go==="autos")`)) === false);
await tap("[data-uclose]");
check("Automations: Close shuts it and hands focus back to the menu's button", (await ev(`document.querySelector("#modal").hidden && !ui.autos && ui.screen==="zone"`)) === true && (await moreFocused()));
await tap(MORE); await tap('#zmenu--more [data-autos="alert"]'); await key("Escape", 27);
check("Automations: Escape shuts it", (await ev(`document.querySelector("#modal").hidden && !ui.autos`)) === true && (await moreFocused()));
await tap(MORE); await tap('#zmenu--more [data-autos="alert"]'); await tellBack();
check("Automations: Back shuts it, staying on the zone", (await ev(`document.querySelector("#modal").hidden && !ui.autos && ui.screen==="zone"`)) === true && (await moreFocused()));
await tap(MORE); await tap('#zmenu--more [data-autos="alert"]'); await ev(`document.querySelector("#modal").click()`); await sleep(40);
check("Automations: a tap outside the dialog shuts it", (await ev(`document.querySelector("#modal").hidden && !ui.autos`)) === true);

// ---------- Automation switches: Home Assistant runs them, and the panel switches them through the host, never assumed
await ev(`ui.review=null;ui.guard=null;ui.autos=null;renderModal();ui.screen="zone";ui.zone="garden";ui.linkw=null;render()`); await sleep(40);
const autoRowOf = (entity, zone = "garden") => ev(`(()=>{const r=document.querySelector('[data-autorow="${entity}"][data-zone="${zone}"]');if(!r)return null;const s=r.querySelector(".sw"),t=r.querySelector(".ctl-status");return {on:s.getAttribute("aria-checked")==="true",disabled:s.disabled,status:t?t.textContent:"",cls:t?t.className:"",text:r.textContent}})()`);
const diskZone = (id) => onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${id}")`);
const VPD_NIGHT = "automation.critical_garden_vpd_low_night", RED_FS = "automation.failsafe_garden_red_lights_recovery";
/* Opens the dialog the way a test needs it, over the zone's page. */
const openAutosAt = async (zone, page) => { await ev(`ui.review=null;ui.guard=null;ui.autos=null;renderModal();ui.linkw=null;ui.screen="zone";ui.zone="${zone}";render();openAutos("${zone}","${page}")`); await sleep(40); };
check("Automations: the zone page has no Automations card, only the menu's way there", (await ev(`!document.querySelector("#z-autos") && ![...document.querySelectorAll("#main h2")].some(h=>h.textContent==="Automations") && [...document.querySelectorAll("#main [data-autos], #main [data-linkautos], #main [data-autocount]")].every(b=>b.closest(".menu"))`)) === true);
check("Automations: with every failsafe on, the zone page has no failsafe warning", (await ev(`[...document.querySelectorAll("#main .notice.fix")].some(n=>n.dataset.autos)`)) === false);
await tap(MORE); await tap('#zmenu--more [data-autos="alert"]');
const autoChipsNow = () => ev(`(()=>{const g=document.querySelector('#modal .seg[aria-label="Automations"]');return g && {role:g.getAttribute("role"),chips:[...g.querySelectorAll("button")].map(b=>[b.firstChild.textContent,b.querySelector(".segn").textContent,b.getAttribute("aria-label"),b.getAttribute("aria-pressed")])}})()`);
const autoPage = () => ev(`({h1:document.querySelector("#autos-title").textContent,sub:document.querySelector("#autos-sub").textContent,about:document.querySelector("#autos-about").textContent,repeat:!!document.querySelector("#alert-repeat"),groups:[...document.querySelectorAll("#modal [data-agroup] h3")].map(e=>e.textContent),rows:document.querySelectorAll("#modal [data-autorow]").length,link:document.querySelectorAll("#modal [data-linkautos], #main [data-linkautos]").length,focus:document.activeElement.dataset.autopage||""})`);
let ap = await autoPage();
check("Automations: headed Automations: Garden, saying what it's for", ap.h1 === "Automations: Garden" && ap.sub === "Home Assistant runs these. Here you switch them on and off.", ap);
check("Automations: chips for Alerts, Failsafes and Control, each counting what's on, in words to a screen reader, with Alerts picked", same(await autoChipsNow(), { role: "group", chips: [["Alerts", "15/16", "Alerts, 15 of 16 on", "true"], ["Failsafes", "3/3", "Failsafes, 3 of 3 on", "false"], ["Control", "4/4", "Control, 4 of 4 on", "false"]] }), await autoChipsNow());
const segn = await ev(`(()=>{const n=document.querySelector('#modal [data-autopage="alert"] .segn'),b=n.parentElement,c=getComputedStyle(n);return {small:parseFloat(c.fontSize)<parseFloat(getComputedStyle(b).fontSize),muted:c.color===getComputedStyle(document.querySelector(".muted")).color,seg:b.parentElement.classList.contains("seg")}})()`);
check("Automations: the chips are the History card's seg chips, the count small and muted", segn.small && segn.muted && segn.seg, segn);
check("Automations: Alerts holds its about sentence, the Alert repeat card and its groups, and no Link automations", ap.about === (await ev(`AUTO_PAGES.alert.about`)) && ap.repeat && same(ap.groups, ["Day alerts", "Night alerts", "Device alerts"]) && ap.link === 0, ap);
check("Automations: an alert named for the day stays where it was put, with the device alerts", (await ev(`document.querySelector('#modal [data-agroup="alert_device"]').textContent`)).includes("Light Controller Overhead Off Day"));
check("Automations: an alert that's off shows off", (await autoRowOf(VPD_NIGHT)).on === false && (await autoRowOf(VPD_NIGHT)).text.includes("Off."), await autoRowOf(VPD_NIGHT));
check("Automations: a row says when it last triggered, or that it never has", (await autoRowOf("automation.critical_garden_humidity_high_day")).text.includes("Last triggered ") && (await autoRowOf("automation.critical_garden_temperature_low_day")).text.includes("Never triggered."));
/* Fifty or so automations fit: the heading, chips and foot stay put, and only the rows scroll, inside the dialog. */
const autosScroll = () => ev(`(()=>{const d=document.querySelector("#modal [data-autosdlg]"),s=document.querySelector("#autos-scroll"),r=(e)=>e.getBoundingClientRect(),c=r(d.querySelector(".seg")),f=r(d.querySelector(".dlgfoot"));const before={chips:c.top,foot:f.top};s.scrollTop=s.scrollHeight;const c2=r(d.querySelector(".seg")),f2=r(d.querySelector(".dlgfoot"));return {scrolls:s.scrollHeight>s.clientHeight+20&&s.scrollTop>0,still:Math.abs(c2.top-before.chips)<1&&Math.abs(f2.top-before.foot)<1,fits:r(d).top>=0&&r(d).bottom<=innerHeight&&f2.bottom<=innerHeight,dlgStill:d.scrollTop===0,page:document.documentElement.scrollWidth<=innerWidth}})()`);
await ev(`window.keptGarden=zoneById("garden").automations;zoneById("garden").automations=[...keptGarden,...Array.from({length:40},(_,i)=>({id:"x"+i,entity:"automation.critical_garden_vpd_low_night",group:"alert_day"}))];redrawAutosDialog()`); await sleep(40);
for (const [w, h, name] of [[390, 844, "phone"], [1280, 900, "desktop"]]) {
  if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
  await sleep(60); const sc = await autosScroll();
  check(`Automations ${name}: with 56 automations the rows scroll inside the dialog, the heading, chips and Close staying put on screen`, sc.scrolls && sc.still && sc.fits && sc.dlgStill && sc.page, sc);
}
await phone(390, 844);
await ev(`zoneById("garden").automations=keptGarden;redrawAutosDialog();document.querySelector("#autos-scroll").scrollTop=0`); await sleep(40);
await shot("autos-alerts-phone");
let nA = (await haCalls()).length;
await tap(`[data-autorow="${VPD_NIGHT}"] .sw`);
let ar = await autoRowOf(VPD_NIGHT);
check("Automations: a tap is one automation.turn_on on the linked automation, shown as sent", same((await haCalls()).slice(nA), [["automation.turn_on", VPD_NIGHT, null]]) && ar.status.startsWith("Sent") && ar.on === false && ar.disabled, [ar, (await haCalls()).slice(nA)]);
await sleep(REPORT); ar = await autoRowOf(VPD_NIGHT);
check("Automations: it moves once HA reports it on, and the count follows", ar.on && ar.status === "" && (await ev(`document.querySelector('#modal [data-agroup="alert_night"] [data-autocount]').textContent`)) === "5 of 5 on", ar);
check("Automations: and so does the Alerts chip's, in words too", same((await autoChipsNow()).chips[0], ["Alerts", "16/16", "Alerts, 16 of 16 on", "true"]), (await autoChipsNow()).chips[0]);
await onHA(`fakeHA.setState("${VPD_NIGHT}","off",{friendly_name:"Critical Garden VPD Low Night"})`); await sleep(80);
check("Automations: switched off in Home Assistant, the row, its group and its chip all follow", (await autoRowOf(VPD_NIGHT)).on === false && (await ev(`document.querySelector('#modal [data-agroup="alert_night"] [data-autocount]').textContent`)) === "4 of 5 on" && same((await autoChipsNow()).chips[0], ["Alerts", "15/16", "Alerts, 15 of 16 on", "true"]), (await autoChipsNow()).chips[0]);
await onHA(`fakeHA.setState("${VPD_NIGHT}","on",{friendly_name:"Critical Garden VPD Low Night"})`); await sleep(80);
await tap(`[data-autorow="${VPD_NIGHT}"] .sw`);
check("Automations: switching an alert off doesn't ask", (await ev(`!!ui.guard`)) === false && (await haCalls()).at(-1)[0] === "automation.turn_off");
await sleep(REPORT);
await onHA(`fakeHA.knobs.dropNext=true`); await tap(`[data-autorow="${VPD_NIGHT}"] .sw`); await sleep(GIVE_UP_CTL); ar = await autoRowOf(VPD_NIGHT);
check("Automations: a switch HA never reports is never shown as done", ar.on === false && ar.cls.includes("stuck") && ar.status.startsWith("Not confirmed. Home Assistant still reports it off."), ar);
await tap(`[data-autorow="${VPD_NIGHT}"] .sw`); await sleep(REPORT); ar = await autoRowOf(VPD_NIGHT);
check("Automations: trying again works and clears the warning", ar.on && ar.status === "", ar);
await tap(`[data-autorow="${VPD_NIGHT}"] .sw`); await sleep(REPORT);
await tap('#modal [data-autopage="failsafe"]');
ap = await autoPage();
check("Automations: Failsafes holds its about sentence and its group, with no Alert repeat card and no Link automations", ap.about === (await ev(`AUTO_PAGES.failsafe.about`)) && !ap.repeat && same(ap.groups, ["Failsafes"]) && ap.rows === 3 && ap.link === 0 && ap.h1 === "Automations: Garden", ap);
check("Automations: the chip picked is pressed, and keeps focus", same((await autoChipsNow()).chips.map((c) => c[3]), ["false", "true", "false"]) && ap.focus === "failsafe", [await autoChipsNow(), ap.focus]);
nA = (await haCalls()).length;
/* The question opens over the dialog, which is left as it was: same chip, same scroll, same switch focused. */
await phone(390, 560);
await ev(`(()=>{window.autosWas=document.querySelector("#modal [data-autosdlg]");const s=document.querySelector("#autos-scroll");s.scrollTop=s.scrollHeight;window.autosTop=s.scrollTop})()`);
await tap(`[data-autorow="${RED_FS}"] .sw`);
const overNow = () => ev(`(()=>{const o=document.querySelector("#modal > .modal.over"),d=document.querySelector("#modal [data-autosdlg]");window.autosTop=document.querySelector("#autos-scroll").scrollTop;return {over:!!o&&!!o.querySelector("[role=alertdialog] #dlg-title"),under:!!d&&d===window.autosWas&&d.inert,focus:document.activeElement.id}})()`);
const ov = await overNow();
check("Automations: switching a failsafe off asks first, over the dialog, and sends nothing yet", (await ev(`ui.guard && ui.guard.title`)) === "Switch off Failsafe Garden Red Lights Recovery?" && (await haCalls()).length === nA && ov.over && ov.under && ov.focus === "dlg-title", [await ev(`ui.guard && ui.guard.title`), ov]);
await shot("autos-failsafe-ask-phone");
await tap("[data-gkeep]");
const backTo = () => ev(`(()=>{const d=document.querySelector("#modal [data-autosdlg]");return {same:d===window.autosWas&&!d.inert,over:!!document.querySelector("#modal > .modal.over"),top:document.querySelector("#autos-scroll").scrollTop,was:window.autosTop,chip:ui.autos.page,focus:document.activeElement.closest("[data-autorow]")?.dataset.autorow||document.activeElement.id}})()`);
let bt = await backTo();
check("Automations: Keep it on sends nothing, and goes back to the dialog on Failsafes, scrolled where it was, the switch focused", (await haCalls()).length === nA && (await autoRowOf(RED_FS)).on && bt.same && !bt.over && bt.chip === "failsafe" && bt.top === bt.was && bt.top > 0 && bt.focus === RED_FS, bt);
await tap(`[data-autorow="${RED_FS}"] .sw`); await tap("[data-gdiscard]"); await sleep(REPORT);
bt = await backTo();
check("Automations: Switch off sends automation.turn_off, it shows off once reported, and the dialog is still there", same((await haCalls()).slice(nA), [["automation.turn_off", RED_FS, null]]) && (await autoRowOf(RED_FS)).on === false && bt.same && !bt.over && bt.chip === "failsafe", [(await haCalls()).slice(nA), bt]);
await phone(390, 844);
await tap("[data-uclose]");
check("Automations: the zone page then warns that a failsafe is off", (await ev(`document.querySelector('#main .notice.fix[data-autos="failsafe"]').textContent`)).includes("A failsafe is off: Failsafe Garden Red Lights Recovery."));
await tap('#main .notice.fix[data-autos="failsafe"]');
check("Automations: and the warning opens the dialog on Failsafes, which counts it off, over the zone's page", (await ev(`ui.screen==="zone" && ui.autos.page==="failsafe" && !!document.querySelector('#modal [data-autorow="${RED_FS}"]') && document.querySelector("#autos-title").textContent==="Automations: Garden"`)) === true && same((await autoChipsNow()).chips[1], ["Failsafes", "2/3", "Failsafes, 2 of 3 on", "true"]), await autoChipsNow());
await tap(`[data-autorow="${RED_FS}"] .sw`);
check("Automations: switching a failsafe back on doesn't ask", (await ev(`!!ui.guard`)) === false);
await sleep(REPORT);
check("Automations: and it's on again", (await autoRowOf(RED_FS)).on === true);
await tap("[data-uclose]");
check("Automations: closing it hands focus back to the notice that opened it", (await ev(`document.querySelector("#modal").hidden`)) === true && (await ev(`!!document.activeElement.closest("#main")`)) === true);
/* An automation belongs to one zone, so a row never names another, even for a setup an earlier release stored with one
   linked in two. */
await ev(`zoneById("garden").automations.push({id:"a99",entity:"automation.failsafe_veg_fans_auto_on",group:"failsafe"})`); await openAutosAt("veg", "failsafe");
check("Automations: a failsafe's row names no other zone", !(await autoRowOf("automation.failsafe_veg_fans_auto_on", "veg")).text.includes("Shared"), await autoRowOf("automation.failsafe_veg_fans_auto_on", "veg"));
await tap('[data-autorow="automation.failsafe_veg_fans_auto_on"][data-zone="veg"] .sw');
check("Automations: and switching it off names none either", (await ev(`ui.guard.text`)) === "It's a failsafe: it puts hardware back when something goes wrong. While it's off, Home Assistant won't do that. You can switch it on again here.", await ev(`ui.guard.text`));
await tap("[data-gkeep]");
await ev(`zoneById("garden").automations=zoneById("garden").automations.filter(a=>a.id!=="a99")`);
await openAutosAt("garden", "alert");
await tap('#modal [data-autopage="control"]'); ap = await autoPage();
check("Automations: Control holds its about sentence and its group, and no Link automations", ap.about === (await ev(`AUTO_PAGES.control.about`)) && !ap.repeat && same(ap.groups, ["Control"]) && ap.rows === 4 && ap.link === 0, ap);
await ev(`window.keptAutos=zoneById("nursery").automations;window.keptParent=zoneById("nursery").parent;delete zoneById("nursery").parent;zoneById("nursery").automations=keptAutos.filter(a=>a.group!=="control")`); await openAutosAt("nursery", "control");
const emptyChip = await ev(`(()=>{const n=document.querySelector("#autos-empty");return {chip:[...document.querySelectorAll("#modal [data-autopage]")].map(b=>b.getAttribute("aria-label")+"|"+b.querySelector(".segn").textContent),notice:n&&n.textContent,acts:n?n.querySelectorAll("button,a,[data-linkautos]").length:-1,rows:document.querySelectorAll("#modal [data-autorow]:not([data-from])").length,link:document.querySelectorAll("#modal [data-linkautos]").length}})()`);
check("Automations: a chip with nothing linked says so, in words too, and says to link them in Setup, with no way there from here (#111)", same(emptyChip.chip, ["Alerts, 3 of 3 on|3/3", "Failsafes, 2 of 2 on|2/2", "Control, none linked|0/0"]) && emptyChip.notice === "No control linked to Nursery yet.Link automations in Setup." && emptyChip.acts === 0 && emptyChip.rows === 0 && emptyChip.link === 0, emptyChip);
await ev(`zoneById("nursery").automations=keptAutos;if(keptParent)zoneById("nursery").parent=keptParent`);
for (const [w, h, name] of [[390, 844, "phone"], [320, 640, "small-phone"], [1280, 900, "desktop"]]) {
  if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
  for (const k of ["alert", "failsafe", "control"]) {
    await openAutosAt("garden", k);
    const fit = await ev(`(()=>{const g=document.querySelector('#modal .seg[aria-label="Automations"]').getBoundingClientRect(),b=[...document.querySelectorAll("#modal [data-autopage]")].map(x=>x.getBoundingClientRect()),d=document.querySelector("#modal [data-autosdlg]").getBoundingClientRect(),f=document.querySelector("#modal [data-uclose]").getBoundingClientRect();return {page:document.documentElement.scrollWidth<=innerWidth,inside:g.left>=d.left&&g.right<=d.right&&d.left>=0&&d.right<=innerWidth,oneLine:b.every(r=>Math.abs(r.top-b[0].top)<1),close:f.bottom<=innerHeight&&f.top>=0,noLink:!document.querySelector("#modal [data-linkautos]")}})()`);
    check(`Automations ${name} ${k}: no sideways scroll, the chips sit in the dialog${w === 320 ? "" : ", on one line"}, Close on screen, and no Link automations`, fit.page && fit.inside && (fit.oneLine || w === 320) && fit.close && fit.noLink, fit);
    if (w !== 320) await shot(`autos-${k}-${name}`);
  }
}
await phone(390, 844);
/* What a compromised UI could try. The host looks the automation up in its own config, so none of these reach HA. */
nA = (await haCalls()).length;
const autoRefused = await evp(`Promise.all([ask("automation",{zone:"garden",link:"nope",on:false}),ask("automation",{zone:"veg",link:"a1",on:"off"}),ask("automation",{zone:"nowhere",link:"a1",on:false}),ask("automation",{zone:"garden",on:false})]).then(rs=>rs.map(r=>r.ok))`);
check("Automations: the host refuses a link the zone doesn't have, an on that isn't true or false, and an unknown zone", same(autoRefused, [false, false, false, false]) && (await haCalls()).length === nA, autoRefused);
await evp(`ask("automation",{zone:"garden",link:"a1",on:false,entity_id:"automation.porch_light_on",service:"turn_on"})`);
await onHA(`fakeHA.setState("automation.critical_garden_temperature_high_day","off",{mode:"single",id:"1699"})`); await sleep(80);
check("Automations: only an automation's name and last run reach the frame, never its id or run mode", same(Object.keys(await ev(`haStates["automation.critical_garden_temperature_high_day"].attributes`)).sort(), ["friendly_name", "last_triggered"]), await ev(`haStates["automation.critical_garden_temperature_high_day"].attributes`));
await onHA(`fakeHA.setState("automation.critical_garden_temperature_high_day","on",{})`); await sleep(80);
check("Automations: an entity or service named by the frame is ignored", same((await haCalls()).at(-1), ["automation.turn_off", "automation.critical_garden_temperature_high_day", null]) && (await onHA(`fakeHA.states["automation.porch_light_on"].state`)) === "on", (await haCalls()).at(-1));
await sleep(REPORT); await evp(`ask("automation",{zone:"garden",link:"a1",on:true})`); await sleep(REPORT);

// ---------- Linking automations: only Environment Control's record changes, and a new one is allowed in HA's own dialog
/* Since #111 Link automations is reached through Setup only: the Automations dialog is for looking and switching. */
await reset(); await goTab("Setup"); await tap('[data-zmenu="nursery"]'); await tap('#zmenu-nursery [data-linkautos="nursery"]'); await sleep(300);
check("Link: it's on a zone's menu on Setup, and opens Nursery's Link automations as a Setup page", (await ev(`!!ui.linkw && ui.linkw.id==="nursery" && ui.screen==="setup" && document.querySelector("#main h1").textContent==="Link automations: Nursery" && document.querySelector("#zmenu-nav [aria-current]").textContent==="Setup"`)) === true, await ev(`[ui.screen, document.querySelector("#main h1").textContent]`));
await tap("[data-linkback]");
check("Link: Back comes back to Setup", (await ev(`ui.screen==="setup" && !ui.linkw && document.querySelector("#main h1").textContent==="Setup"`)) === true);
await tap('[data-zmenu="nursery"]'); await tap('#zmenu-nursery [data-linkautos="nursery"]'); await sleep(300);
const linkListed = await ev(`[...document.querySelectorAll("[data-lpick]")].map(b=>b.dataset.lpick)`);
check("Link: suggests what Nursery links and what's named for it, and none of the house's", linkListed.includes("automation.critical_nursery_vpd_high_day") && linkListed.includes("automation.nursery_heat_mat_on") && !linkListed.includes("automation.porch_light_on") && !linkListed.includes("automation.reservoir_refill_reminder"), linkListed);
check("Link: the rest are a search away", (await ev(`document.querySelector("#link-more").textContent`)).includes("more in Home Assistant"));
await tap('[data-lpick="automation.critical_nursery_vpd_high_day"]');
const groupChips = (e) => ev(`(()=>{const f=document.querySelector('[data-lgroup="${e}"]')?.closest("fieldset.chips");return f && {legend:f.querySelector("legend").textContent,chips:[...f.querySelectorAll("label.chip")].map(l=>{const i=l.querySelector("input");return l.textContent+"|"+i.type+"|"+i.value+(i.checked?"*":"")})}})()`);
check("Link: picking one shows its group as radio chips, the one its name suggests picked", same(await groupChips("automation.critical_nursery_vpd_high_day"), { legend: "Group", chips: ["Day alerts|radio|alert_day*", "Night alerts|radio|alert_night", "Device alerts|radio|alert_device", "Failsafes|radio|failsafe", "Control|radio|control"] }), await groupChips("automation.critical_nursery_vpd_high_day"));
check("Link: no native select anywhere on the page, a picked row's group being its chips", (await ev(`document.querySelectorAll("select").length===0 && document.querySelectorAll('input[type=radio][data-lgroup]').length>0`)) === true);
check("Link: and the bar counts it, saving nothing yet", (await ev(`document.querySelector("#draft-count").textContent`)) === "1" && !(await diskZone("nursery")).automations.some((a) => a.entity === "automation.critical_nursery_vpd_high_day"));
await ev(`(()=>{const i=document.querySelector("#link-q");i.value="porch";i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await sleep(30);
check("Link: search reaches the rest of Home Assistant's automations", same(await ev(`[...document.querySelectorAll("[data-lpick]")].map(b=>b.dataset.lpick)`), ["automation.porch_light_on"]), await ev(`[...document.querySelectorAll("[data-lpick]")].map(b=>b.dataset.lpick)`));
await ev(`(()=>{const i=document.querySelector("#link-q");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await sleep(30);
await tap('[data-lgroup="automation.critical_nursery_vpd_high_day"][value="alert_device"]');
check("Link: tapping another group's chip picks it in the draft", (await ev(`ui.linkw.pick["automation.critical_nursery_vpd_high_day"]`)) === "alert_device" && (await groupChips("automation.critical_nursery_vpd_high_day")).chips.filter((c) => c.endsWith("*")).join() === "Device alerts|radio|alert_device*", await groupChips("automation.critical_nursery_vpd_high_day"));
await ev(`document.querySelector('[data-lpick="automation.critical_nursery_vpd_high_day"]').scrollIntoView({block:"center"})`); await shot("autos-link-phone");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await ev(`document.querySelector('[data-lpick="automation.critical_nursery_vpd_high_day"]').scrollIntoView({block:"center"})`); await shot("autos-link-desktop"); await phone(390, 844);
await tap("[data-dreview]");
const autoLinkReview = await ev(`document.querySelector("#review-items").textContent`);
check("Link: the review names it, from not linked to the group picked", autoLinkReview.includes("Critical Nursery VPD High Day") && autoLinkReview.includes("Not linked") && autoLinkReview.includes("Device alerts"), autoLinkReview);
await tap("[data-rapply]"); await sleep(300);
dlg = await hostDialog();
check("Link: a newly linked automation is asked about in HA's own dialog, before anything is saved", dlg.open && dlg.text.includes("automation.critical_nursery_vpd_high_day") && dlg.text.includes("Allow 1 automation") && !(await diskZone("nursery")).automations.some((a) => a.entity === "automation.critical_nursery_vpd_high_day"), dlg.text);
await sleep(1100); await hostClick("allow"); await sleep(300);
check("Link: once allowed it's saved in the group its chip picked, and it stays on Link automations with it ticked and nothing left to apply (#156)", (await diskZone("nursery")).automations.some((a) => a.entity === "automation.critical_nursery_vpd_high_day" && a.group === "alert_device") && (await ev(`ui.screen==="setup" && !!ui.linkw && ui.linkw.id==="nursery" && document.querySelector("#main h1").textContent.startsWith("Link automations") && document.querySelector('[data-lpick="automation.critical_nursery_vpd_high_day"]').getAttribute("aria-pressed")==="true" && linkDraft(ui.linkw).items.length===0 && document.querySelector("#draftbar").hidden`)) === true, await ev(`[ui.screen, !!ui.linkw]`));
check("Link: focus lands on the page's heading once the review closes", (await ev(`document.activeElement===document.querySelector("#main h1")`)) === true, await ev(`document.activeElement.outerHTML.slice(0,80)`));
await sleep(250);
check("Link: the toast saying it's saved drops in at the top of the view", (await ev(`(()=>{const t=document.querySelector("#toast"),r=t.getBoundingClientRect();return !t.hidden&&t.textContent==="Nursery's automations saved."&&r.top>=0&&r.bottom<=innerHeight/4})()`)) === true, await ev(`[document.querySelector("#toast").textContent, document.querySelector("#toast").getBoundingClientRect().top, innerHeight]`));
await tap("[data-linkback]"); await sleep(80);
check("Link: then Back goes to Setup, where it was opened, without asking", (await ev(`document.querySelector("#modal").hidden`)) === true && (await ev(`ui.screen==="setup" && !ui.linkw && document.querySelector("#main h1").textContent==="Setup"`)) === true, await ev(`[ui.screen, !!ui.linkw]`));
await openAutosAt("nursery", "control");
check("Link: and Nursery's Alerts chip counts it", same((await autoChipsNow()).chips[0].slice(0, 2), ["Alerts", "4/4*"]) && (await autoChipsNow()).chips[0][2].startsWith("Alerts, 4 of 4 on"), await autoChipsNow());
await ev(`ui.autos=null;renderModal()`);
const sneakyAuto = evp(`saveConfig(()=>{zoneById("nursery").automations.push({id:"a99",entity:"automation.porch_light_on",group:"failsafe"})}).then(r=>r.ok)`);
await sleep(300); dlg = await hostDialog();
check("Link: the dialog names the real automation, and flags a failsafe as one", dlg.text.includes("Porch Light On") && dlg.text.includes("Linked as a failsafe. Once allowed, the panel can switch it off."), dlg.text);
await key("Escape", 27); await sleep(150);
check("Link: Escape is a no", (await sneakyAuto) === false && !(await diskZone("nursery")).automations.some((a) => a.entity === "automation.porch_light_on"));
const diskBeforeTent = await onHA(`fakeHA.disk`);
const already = evp(`saveConfig(()=>{zoneById("garden").automations.push({id:"a99",entity:"automation.tent_lights_on",group:"control"})}).then(r=>[r.ok,r.error])`);
await sleep(300); dlg = await hostDialog();
check("Link: one another zone links is asked about like any newly linked automation", dlg.open && dlg.text.includes("automation.tent_lights_on"), dlg.text);
await sleep(1100); await hostClick("allow"); await sleep(150);
check("Link: and then refused by the backend, so nothing is stored", same(await already, [false, "An automation can only be linked to one zone."]) && (await onHA(`fakeHA.disk`)) === diskBeforeTent, await already);
const notAuto = await evp(`saveConfig(()=>{zoneById("garden").automations.push({id:"a98",entity:"switch.reservoir_pump",group:"control"})}).then(r=>[r.ok,r.error])`);
check("Link: anything that isn't an automation is refused without asking", notAuto[0] === false && notAuto[1].includes("isn't an automation") && (await hostDialog()).open === false, notAuto);
const strayKey = await onHA(`fakeHA.command({type:"environment_control/config/save",revision:fakeHA.config.revision,config:{zones:fakeHA.config.zones,devices:fakeHA.config.devices,scripts:["script.x"]}}).then(()=>"saved",e=>e.message)`);
check("Link: the backend refuses a setup holding anything but zones, devices and room settings", strayKey.includes("something other than zones, devices and room settings"), strayKey);
check("Remove: a zone's dialog says its automations are unlinked and keep running", (await ev(`removeRows(zoneById("veg")).find(r=>r[0]==="Automations")[1]`)) === "10 unlinked. They keep running in Home Assistant");

// ---------- Alert repeat: one helper for every alert, linked on Setup, changed through a review like any other value
await openAutosAt("garden", "alert");
const repeatReviewBtn = () => ev(`(()=>{const b=document.querySelector("#modal [data-ureview]");return b ? {shown:!b.hidden,off:b.disabled,inFoot:!!b.closest("[data-autosdlg] > .dlgfoot")} : null})()`);
check("Repeat: the Alerts chip shows the room's repeat rate from its helper", (await ev(`document.querySelector("#repeat-in").value`)) === "15");
check("Repeat: with nothing typed, the dialog's foot holds only Close", same((await autosDlg()).bar, ["Close"]), (await autosDlg()).bar);
await ev(`(()=>{const i=document.querySelector("#repeat-in");i.focus();i.value="200";i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await sleep(20);
let rb = await repeatReviewBtn();
check("Repeat: a value outside the helper's limits is a problem and stops review", (await ev(`document.querySelector("#repeat-bad").textContent`)).includes("between 0 and 120") && rb.shown && rb.off, rb);
await ev(`(()=>{const i=document.querySelector("#repeat-in");i.value="30";i.dispatchEvent(new Event("input",{bubbles:true}));i.blur()})()`); await sleep(20);
rb = await repeatReviewBtn();
check("Repeat: while it differs from the helper, Review change sits in the dialog's own foot, and the window's bar stays out of it", rb.shown && !rb.off && rb.inFoot && (await ev(`document.querySelector("#draftbar").hidden`)) === true, rb);
await tap('#modal [data-autopage="failsafe"]');
check("Repeat: picking another chip with it unsaved asks first, over the dialog", (await ev(`ui.guard && ui.guard.title`)) === "Discard unsaved changes?" && (await ev(`document.querySelector("#dlg-text").textContent`)) === "You have 1 unsaved change in Alerts. Leaving will discard it." && (await ev(`ui.autos.page`)) === "alert" && (await ev(`!!document.querySelector("#modal > .modal.over") && document.querySelector("#modal [data-autosdlg]").inert`)) === true, await ev(`document.querySelector("#dlg-text")?.textContent`));
await tap("[data-gkeep]");
check("Repeat: Keep editing stays on Alerts with the minutes typed", (await ev(`ui.autos.page==="alert" && document.querySelector("#repeat-in").value==="30" && document.querySelector('#modal [data-autopage="alert"]').getAttribute("aria-pressed")==="true"`)) === true);
await tap('#modal [data-autopage="failsafe"]'); await tap("[data-gdiscard]");
check("Repeat: discarding goes to Failsafes, and the draft is gone", (await ev(`ui.autos.page==="failsafe" && ui.autos.repeat===undefined && document.querySelector("#draftbar").hidden && !document.querySelector("#alert-repeat") && !document.querySelector("#modal [data-ureview]")`)) === true);
await tap('#modal [data-autopage="alert"]');
check("Repeat: and back on Alerts it holds the helper's value again", (await ev(`document.querySelector("#repeat-in").value`)) === "15");
await ev(`(()=>{const i=document.querySelector("#repeat-in");i.value="30";i.dispatchEvent(new Event("input",{bubbles:true}));i.blur()})()`); await sleep(20);
await tap("[data-uclose]");
check("Repeat: closing the dialog asks first too", (await ev(`ui.guard && ui.guard.title`)) === "Discard unsaved changes?" && (await ev(`!!ui.autos`)) === true);
await tap("[data-gkeep]");
check("Repeat: and Keep editing leaves the dialog open with the minutes typed", (await ev(`!!ui.autos && !ui.guard && document.querySelector("#repeat-in").value==="30"`)) === true);
await tap("#modal [data-ureview]");
check("Repeat: the review opens over the dialog and says it changes every alert, not only this zone's", (await ev(`document.querySelector("#dlg-text").textContent`)).includes("every alert in Home Assistant") && (await ev(`document.querySelector("#review-items").textContent`)).includes("15 min") && (await ev(`document.querySelector("#review-items").textContent`)).includes("30 min") && (await ev(`!!document.querySelector("#modal > .modal.over #review-items")`)) === true, await ev(`document.querySelector("#dlg-text").textContent`));
nA = (await haCalls()).length;
await tap("[data-rapply]"); await sleep(REPORT + 300);
check("Repeat: applied through the host to the helper, and counted once HA reports it", same((await haCalls()).slice(nA).map((c) => c.slice(0, 2)), [["input_number.set_value", "input_number.alert_repeat_rate"]]) && (await onHA(`fakeHA.states["input_number.alert_repeat_rate"].state`)) === "30" && (await ev(`ui.review`)) === null && (await ev(`document.querySelector("#repeat-in").value`)) === "30", (await haCalls()).slice(nA));
const repeatRefused = await evp(`Promise.all([ask("setting",{name:"alertRepeat",value:500}),ask("setting",{zone:"garden",name:"alertRepeat",value:5}),ask("setting",{name:"alertRepeat",value:2.5})]).then(rs=>rs.map(r=>r.ok))`);
check("Repeat: the host refuses a value outside the helper's limits or step, and the repeat rate as a zone setting", same(repeatRefused, [false, false, false]), repeatRefused);
await tap("[data-uclose]"); await goTab("Setup");
check("Setup: the Alerts card shows the linked repeat helper", (await ev(`document.querySelector("#room-alerts").textContent`)).includes("input_number.alert_repeat_rate"));
await tap("[data-repeatunlink]"); await sleep(250);
check("Setup: unlinking saves without asking, and the helper stays in HA", (await onHA(`(JSON.parse(fakeHA.disk).room||{}).alertRepeat ?? null`)) === null && (await onHA(`!!fakeHA.states["input_number.alert_repeat_rate"]`)) && (await hostDialog()).open === false);
await openAutosAt("garden", "alert");
check("Repeat: with nothing linked, the Alerts chip says where to link it", (await ev(`document.querySelector("#alert-repeat").textContent`)).includes("Link it on Setup"));
await tap('#alert-repeat [data-go="setup"]');
check("Repeat: and its Link it on Setup closes the dialog and goes there", (await ev(`!ui.autos && document.querySelector("#modal").hidden && ui.screen==="setup"`)) === true); await tap("[data-repeatpick]"); await sleep(300);
check("Setup: the picker offers number helpers, the repeat one first", (await ev(`document.querySelector("[data-repeatlink]").dataset.repeatlink`)) === "input_number.alert_repeat_rate");
await tap('[data-repeatlink="input_number.alert_repeat_rate"]'); await sleep(300); dlg = await hostDialog();
check("Setup: linking it asks in HA's own dialog, saying every alert follows it", dlg.open && dlg.text.includes("Every alert's repeat rate comes from it."), dlg.text);
await sleep(1100); await hostClick("allow"); await sleep(300);
check("Setup: and once allowed it's linked for the room", (await onHA(`JSON.parse(fakeHA.disk).room.alertRepeat`)) === "input_number.alert_repeat_rate");
await ev(`ui.screen="zone";ui.zone="garden";ui.autos=null;render()`); await sleep(30);
for (const [w, h] of [[390, 844], [320, 640]]) {
  await phone(w, h); await reset(); await goTab("Garden"); await sleep(60);
  check(`Controls ${w}px: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`), await ev(`document.documentElement.scrollWidth`));
  check(`Controls ${w}px: the page menu's button is on screen`, await ev(`(()=>{const c=document.querySelector(".navmenu .burger").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&c.top>=0})()`));
  await goTab("Setup");
  check(`Setup ${w}px: the page menu's button is on screen`, await ev(`(()=>{const c=document.querySelector(".navmenu .burger").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&c.top>=0})()`));
}

// ---------- Leaf temperature offset
await phone(390, 844); await reset();
const L = { rows: (id) => `ui.leafw.rows["${id}"]` };
const openL = async (zone = "garden") => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.leafw=null;ui.vpdw=null;ui.td=null;ui.sched=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";openCalibration("${zone}");render();window.scrollTo(0,0)`); await sleep(50); };
const ACK = 900, GIVE_UP = 1620;
/* A board's offset lives in the fake HA now, so resets and silent boards are set there. */
const boardSet = async (pairs) => { await onHA(`(${JSON.stringify(pairs)}).forEach(([e,v])=>fakeHA.setState(e,Number(v).toFixed(1)))`); await sleep(60); };
const haSet = async (pairs) => { await onHA(`(${JSON.stringify(pairs)}).forEach(([e,v])=>fakeHA.setState(e,String(v)))`); await sleep(60); };
const helperCalls = () => onHA(`fakeHA.calls.filter(c=>c.domain.startsWith("input_")).map(c=>c.data.entity_id+"="+(c.data.value??c.data.time))`);
const boardSilent = (entity, on) => onHA(`fakeHA.knobs.ignore.${on ? "add" : "delete"}("${entity}")`);
const leafSave = (wait = ACK) => ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`).then(() => sleep(wait));
const sends = () => ev(`leafSends.map(x=>x.entity_id+"="+x.value)`);
const board = (id) => ev(`zones.flatMap(z=>z.sensors).find(s=>s.id==="${id}").leafLive`);
const row = (id) => ev(`ui.leafw.rows["${id}"]`);
const saved = (id) => ev(`leafOf(zones.flatMap(z=>z.sensors).find(s=>s.id==="${id}"))`);
await openL();
check("Leaf: every environment sensor listed", same(await ev(`[...document.querySelectorAll(".lrow-top strong")].map(e=>e.textContent)`), ["Environment left", "Environment right", "Environment under"]), await ev(`[...document.querySelectorAll(".lrow-top strong")].map(e=>e.textContent)`));
check("Leaf: a board shows where its offset comes from", (await ev(`document.querySelector("#lr-g-left").textContent`)).includes("number.environment_left_leaf_temperature_offset"));
check("Leaf: a board's offset is a box on the same screen as the rest", (await ev(`["g-left","g-right","g-under"].every(i=>!!document.querySelector("#lin-"+i))`)) === true);
check("Leaf: there is one place for an offset, no source choice", (await ev(`!document.querySelector("[data-lsource]") && !document.querySelector("#main").textContent.includes("Set here")`)) === true);
check("Leaf: nothing on the screen is a Preview", (await ev(`!document.querySelector("#main .pill.preview, #main [data-preview]")`)) === true);
check("Leaf: a sensor with nowhere to hold an offset says so", (await ev(`document.querySelector("#lr-g-under").textContent`)).includes("kept in Environment Control"));
check("Leaf: the screen says it changes the board and what reads it", (await ev(`document.querySelector("#main").textContent`)).includes("changed on the board itself"));
const zoneNow = await ev(`zones[0].now.vpd`);
await tap("#lin-g-under"); await type("2"); await key("Enter", 13);
check("Leaf: typing a size sets it", (await row("g-under")).mag === 2, await row("g-under"));
check("Leaf: typing keeps the direction", (await row("g-under")).dir === -1);
check("Leaf: the sensor's own line updates", (await ev(`document.querySelector("#lp-g-under").textContent`)).includes("leaf 22.9"), await ev(`document.querySelector("#lp-g-under").textContent`));
check("Leaf: the zone figure previews it", (await ev(`document.querySelector("#l-zone").textContent`)).includes("Now"), await ev(`document.querySelector("#l-zone").textContent`));
check("Leaf: nothing is saved before Save", (await ev(`zones[0].now.vpd`)) === zoneNow && (await saved("g-under")) === -0.5);
await tap("#lin-g-under"); await type("-1.5"); await key("Enter", 13);
check("Leaf: a typed minus means below", (await row("g-under")).mag === 1.5 && (await row("g-under")).dir === -1, await row("g-under"));
await tap("#lin-g-under"); await type("+1"); await key("Enter", 13);
check("Leaf: a typed plus means above", (await row("g-under")).mag === 1 && (await row("g-under")).dir === 1, await row("g-under"));
check("Leaf: Above air lights up after a typed plus", (await ev(`document.querySelector('[data-ldir="g-under:1"]').getAttribute("aria-pressed")`)) === "true");
await tap("#lin-g-under"); await type("1,5"); await key("Enter", 13);
check("Leaf: a comma decimal works", (await row("g-under")).mag === 1.5, await row("g-under"));
await tap("#lin-g-under"); await type(""); await ev(`document.activeElement.value=""`); await key("Enter", 13);
check("Leaf: blank keeps the old value", (await row("g-under")).mag === 1.5 && (await ev(`document.querySelector("#lin-g-under").value`)) === "1.5", await row("g-under"));
await tap("#lin-g-under"); await type("abc"); await key("Enter", 13);
check("Leaf: words keep the old value", (await row("g-under")).mag === 1.5, await row("g-under"));
await tap("#lin-g-under"); await type("9"); await key("Escape", 27);
check("Leaf: Escape restores the box", (await ev(`document.querySelector("#lin-g-under").value`)) === "1.5" && (await row("g-under")).mag === 1.5);
await tap('[data-ldir="g-under:-1"]');
check("Leaf: the direction button works", (await row("g-under")).dir === -1, await row("g-under"));
check("Leaf: a board's box starts from the board's value", (await ev(`document.querySelector("#lin-g-right").value`)) === "1.0", await ev(`document.querySelector("#lin-g-right").value`));
await tap("#lin-g-under"); await type("1.2"); await tap("#lin-g-right");
check("Leaf: moving to the next box keeps focus", (await active()) === "lin-g-right", await active());
check("Leaf: and commits the one left", (await row("g-under")).mag === 1.2, await row("g-under"));
await type("1.5"); await key("Enter", 13);
check("Leaf: editing a board warns about nothing", !(await ev(`document.querySelector("#main").textContent`)).includes("different number"));
check("Leaf: typing into a board's box sends nothing yet", (await sends()).length === 0 && (await board("g-right")) === -1, await sends());
await tap("#lin-g-under"); await type("6"); await key("Enter", 13);
check("Leaf: past 5 below is refused", (await ev(`document.querySelector("[data-dreview]").disabled`)) === true && (await ev(`document.querySelector("#l-issues").textContent`)).includes("at most 5"), await ev(`document.querySelector("#l-issues").textContent`));
check("Leaf: the box is marked", (await ev(`document.querySelector("#lin-g-under").getAttribute("aria-invalid")`)) === "true");
await tap("#l-issues .notice");
check("Leaf: Fix lands on the box", (await active()) === "lin-g-under", await active());
await type("3"); await key("Enter", 13);
check("Leaf: 3 below is fine", (await ev(`document.querySelector("[data-dreview]").disabled`)) === false);
await tap('[data-ldir="g-under:1"]');
check("Leaf: 3 above is past the board's limit", (await ev(`document.querySelector("#l-issues").textContent`)).includes("at most 2"), await ev(`document.querySelector("#l-issues").textContent`));
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(50);
check("Leaf: Cancel changes nothing", (await saved("g-under")) === -0.5 && (await board("g-right")) === -1 && (await sends()).length === 0 && (await ev(`ui.screen`)) === "setup");
await openL(); await tap("#lin-g-under"); await type("1.2");
await leafSave(60);
check("Leaf: Save with the box still focused keeps it", (await saved("g-under")) === -1.2, await saved("g-under"));
check("Leaf: other sensors don't move", (await saved("g-left")) === -1 && (await saved("g-right")) === -1);
check("Leaf: a stored offset writes to no board", (await sends()).length === 0, await sends());
// Writing to the board
await openL(); await tap("#lin-g-left"); await type("1.4"); await key("Enter", 13);
await leafSave(60);
check("Board: Save sends only the row that changed, with its sign", same(await sends(), ["number.environment_left_leaf_temperature_offset=-1.4"]), await sends());
check("Board: shows it's waiting on the board", (await ev(`document.querySelector("#ls-g-left").textContent`)).includes("Sending"), await ev(`document.querySelector("#ls-g-left").textContent`));
check("Board: not shown as saved until the board reports it", (await board("g-left")) === -1 && (await ev(`!!ui.leafw`)) === true);
check("Board: boxes and buttons lock while waiting", (await ev(`document.querySelector("#lin-g-left").disabled && document.querySelector("[data-dreview]").disabled && document.querySelector("[data-lexit]").disabled && document.querySelector('[data-ldir="g-left:1"]').disabled`)) === true);
await ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`); await sleep(40);
check("Board: a second tap doesn't send twice", (await sends()).length === 1, await sends());
await sleep(ACK);
check("Board: the board's report is what's stored", (await board("g-left")) === -1.4, await board("g-left"));
check("Board: then it stays on the page and says so", (await ev(`!!ui.leafw && !ui.leafw.sending`)) === true && (await ev(`document.querySelector("#toast").textContent`)).includes("on the boards"), await ev(`document.querySelector("#toast").textContent`));
check("Board: the zone reading follows", Math.abs((await ev(`zones[0].now.vpd`)) - (await ev(`combine(methodOf(zones[0],"vpd"),envOf(zones[0]).map(s=>calcVpd(s.t,s.h,leafOf(s))))`))) < 1e-9);
await openL(); await leafSave(40);
check("Board: with nothing changed there's nothing to review", (await sends()).length === 1 && (await ev(`document.querySelector("#draftbar").hidden && document.querySelector("#modal").hidden`)) === true, await sends());
await boardSilent("number.environment_right_leaf_temperature_offset", true);
await openL(); await tap("#lin-g-right"); await type("2"); await key("Enter", 13);
await tap("#lin-g-left"); await type("1"); await key("Enter", 13);
await leafSave(GIVE_UP);
check("Board: no reply is never shown as saved", (await board("g-right")) === -1 && (await ev(`!!ui.leafw`)) === true, await board("g-right"));
check("Board: it says what the board still reports", (await ev(`document.querySelector("#ls-g-right").textContent`)).includes("Not confirmed. The board still reports leaf 1.0"), await ev(`document.querySelector("#ls-g-right").textContent`));
check("Board: the one that answered is kept", (await board("g-left")) === -1, await board("g-left"));
check("Board: your typed value survives to try again", (await ev(`document.querySelector("#lin-g-right").value`)) === "2.0" && (await ev(`document.querySelector("[data-dreview]").disabled`)) === false);
check("Board: the review stays open and says what failed", (await ev(`document.querySelector("#modal").textContent`)).includes("Some changes were not applied") && (await ev(`document.querySelector("#modal").textContent`)).includes("not confirmed. The board still reports leaf 1.0"), await ev(`document.querySelector("#modal").textContent`));
check("Board: and lists only what's left", (await ev(`document.querySelectorAll("#review-items .review-row").length`)) === 1 && (await ev(`document.querySelector("[data-rapply]").textContent`)) === "Apply 1 change", await ev(`document.querySelector("#modal").textContent`));
await boardSilent("number.environment_right_leaf_temperature_offset", false); await ev(`leafSends.length=0`);
await ev(`document.querySelector("[data-rapply]").click()`); await sleep(ACK);
check("Board: Save tries again, sending only what's still different", same(await sends(), ["number.environment_right_leaf_temperature_offset=-2"]) && (await board("g-right")) === -2, await sends());
await boardSet([["number.environment_right_leaf_temperature_offset", -1]]); await ev(`leafSends.length=0;render()`);
/* The calibration write path. The frame names a sensor, never an entity, and the host checks the entity's own limits. */
const setCalls = () => onHA(`fakeHA.calls.filter(c=>c.service==="set_value").map(c=>c.data.entity_id+"="+c.data.value)`);
const calBefore = (await setCalls()).length;
const calTries = await evp(`Promise.all([ask("calibrate",{sensor:"nope",value:-1}),ask("calibrate",{sensor:"g-left",value:-7}),ask("calibrate",{sensor:"g-left",value:-1.25}),ask("calibrate",{sensor:"g-under",value:-1}),ask("calibrate",{sensor:"g-left",value:"-1"})]).then(r=>r.map(x=>x.ok))`);
check("Calibrate: the host refuses an unknown sensor, a value past the board's limits or off its step, a sensor with no board setting and a non-number", JSON.stringify(calTries) === JSON.stringify([false, false, false, false, false]) && (await setCalls()).length === calBefore, calTries);
await evp(`ask("calibrate",{sensor:"g-left",value:-1.5,entity_id:"number.environment_right_leaf_temperature_offset"})`); await sleep(ACK);
check("Calibrate: it writes that sensor's own setting, whatever entity the frame names", JSON.stringify((await setCalls()).slice(calBefore)) === JSON.stringify(["number.environment_left_leaf_temperature_offset=-1.5"]) && (await board("g-left")) === -1.5, await setCalls());
await onHA(`fakeHA.offline("number.environment_left_leaf_temperature_offset",true)`); await sleep(60);
check("Calibrate: an offline board is refused by the host too", (await evp(`ask("calibrate",{sensor:"g-left",value:-1}).then(r=>r.ok)`)) === false);
await onHA(`fakeHA.offline("number.environment_left_leaf_temperature_offset",false)`);
await boardSet([["number.environment_left_leaf_temperature_offset", -1]]);
check("Calibrate: a value set on the board from elsewhere shows here", (await board("g-left")) === -1);
await ev(`zones[2].sensors[0].t=null;zones[2].sensors[0].h=null`); await openL("nursery");
check("Board: an offline board can't be edited and says why", (await ev(`document.querySelector("#lin-n-env").disabled && document.querySelector('[data-ldir="n-env:1"]').disabled && document.querySelector("#ls-n-env").textContent.includes("offline")`)) === true);
await leafSave(40);
check("Board: and nothing is sent to it", (await sends()).length === 0, await sends());
await ev(`zones[2].sensors[0].t=21.1;zones[2].sensors[0].h=66;ui.leafw=null;render()`);
const oneValue = await ev(`(()=>{const z=zones[0],e=envOf(z);render();return {tile:z.now.vpd,calc:combine(methodOf(z,"vpd"),e.map(s=>calcVpd(s.t,s.h,leafOf(s)))),ends:e.map((s,i)=>Math.abs(series(z,"vpd",24,i).at(-1).v-sensorValue(z,s,"vpd"))<1e-9)}})()`);
check("Leaf: zone reading uses each sensor's own offset", Math.abs(oneValue.tile - oneValue.calc) < 1e-9, oneValue);
check("Leaf: every chart line ends on that sensor's value", oneValue.ends.every(Boolean), oneValue);
await ev(`zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5;render()`);
await goTab("Garden");
await tap('#main .tile [data-calw="garden"]');
check("Leaf: reachable from the VPD tile", (await ev(`!!ui.leafw`)) === true);
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(50);
check("Leaf: back returns to the zone", (await ev(`ui.screen==="zone" && ui.zone==="garden"`)) === true);
await ev(`ui.picked="g-right";render()`); await sleep(40);
await tap('.detail [data-calw]');
check("Leaf: reachable from a sensor on the map, landing on its row", await ev(`(()=>{const r=document.querySelector("#lr-g-right").getBoundingClientRect();return !!ui.leafw&&r.top>=0&&r.top<innerHeight})()`));
await openL(); await tap("#lin-g-under"); await type("4"); await goTab("Overview"); await sleep(60);
await ev(`document.querySelector("[data-gdiscard]")?.click()`); await sleep(40);
check("Leaf: leaving by a tab drops the screen and saves nothing", (await ev(`!ui.leafw && ui.screen==="overview"`)) === true && (await saved("g-under")) === -0.5);
await ev(`document.activeElement&&document.activeElement.blur()`);

// Sensor Calibration comes before Targets and holds the leaf temperature offset
const setupNow = async () => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.leafw=null;ui.vpdw=null;ui.td=null;ui.sched=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";render();window.scrollTo(0,0)`); await sleep(40); };
const setupButtons = (zone) => ev(`[...document.querySelectorAll('#zmenu-${zone} button')].map(b=>b.textContent)`);
const calibrate = async (zone = "garden") => { await setupNow(); await ev(`document.querySelector('[data-calw="${zone}"]').click()`); await sleep(50); };
await setupNow();
check("Order: Sensor Calibration comes before Targets", same(await setupButtons("garden"), ["Zone details", "Device identification", "Zone layout", "Device placement", "Sensor Calibration", "Targets, day and night", "Automations", "Remove zone"]), await setupButtons("garden"));
check("Order: and it's there in every zone", same(await setupButtons("veg"), ["Zone details", "Device identification", "Zone layout", "Device placement", "Sensor Calibration", "Targets, day and night", "Automations", "Remove zone"]) && same(await setupButtons("nursery"), ["Zone details", "Device identification", "Zone layout", "Device placement", "Sensor Calibration", "Targets, day and night", "Automations", "Remove zone"]), await setupButtons("veg"));
// The zone's setup steps sit behind a menu button, and Add zone is the bigger button with a plus
await setupNow();
const rowButtons = (zone) => ev(`[...document.querySelector('[data-zmenu="${zone}"]').closest(".zacts").children].filter(x=>x.matches("button")).map(b=>b.textContent)`);
const menuOpen = (zone) => ev(`!document.querySelector("#zmenu-${zone}").hidden && document.querySelector('[data-zmenu="${zone}"]').getAttribute("aria-expanded")==="true"`);
check("Menu: a zone's row shows no step buttons, only the menu and Continue setup", (await ev(`zones.every(z=>[...document.querySelector('[data-zmenu="'+z.id+'"]').closest(".zacts").querySelectorAll("button")].filter(b=>!b.closest(".menu")).every(b=>b.dataset.zmenu||b.dataset.guide))`)) === true, await rowButtons("garden"));
check("Menu: it's closed until asked, and says it's a menu", (await ev(`zones.every(z=>document.querySelector("#zmenu-"+z.id).hidden && document.querySelector('[data-zmenu="'+z.id+'"]').getAttribute("aria-haspopup")==="menu")`)) === true);
check("Menu: the button is named after its zone", (await ev(`document.querySelector('[data-zmenu="garden"]').getAttribute("aria-label")`)) === "Set up Garden");
await tap('[data-zmenu="garden"]');
check("Menu: a tap opens it, with focus on its first step", (await menuOpen("garden")) && (await ev(`document.activeElement.textContent`)) === "Zone details", await ev(`document.activeElement.outerHTML.slice(0,80)`));
const menuBox = await ev(`(()=>{const r=document.querySelector("#zmenu-garden").getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight}})()`);
check("Menu: it opens on screen", menuBox.l >= 0 && menuBox.r <= menuBox.w && menuBox.t >= 0 && menuBox.b <= menuBox.h, menuBox);
await shot("setup-menu-phone");
await key("ArrowDown", 40);
check("Menu: arrow down moves to the next step", (await ev(`document.activeElement.textContent`)) === "Device identification");
await key("End", 35);
check("Menu: End lands on Remove zone, last and apart", (await ev(`document.activeElement.textContent`)) === "Remove zone" && (await ev(`document.activeElement.previousElementSibling.tagName`)) === "HR");
await key("ArrowDown", 40);
check("Menu: arrow down wraps to the top", (await ev(`document.activeElement.textContent`)) === "Zone details");
await key("Escape", 27);
check("Menu: Escape closes it and hands focus back to its button", !(await menuOpen("garden")) && (await ev(`document.activeElement.dataset.zmenu`)) === "garden");
await tap('[data-zmenu="garden"]'); await tap('[data-zmenu="garden"]');
check("Menu: tapping the button again closes it", !(await menuOpen("garden")));
await tap('[data-zmenu="garden"]'); await tap("#main h1");
check("Menu: a tap anywhere else closes it", !(await menuOpen("garden")));
await tap('[data-zmenu="garden"]'); await ev(`document.querySelector('[data-zmenu="veg"]').click()`); await sleep(50);
check("Menu: opening one zone's menu closes another's", !(await menuOpen("garden")) && (await menuOpen("veg")));
await key("Escape", 27);
const lastZone = await ev(`zones[zones.length-1].id`);
await tap(`[data-zmenu="${lastZone}"]`);
const lastBox = await ev(`(()=>{const r=document.querySelector("#zmenu-${lastZone}").getBoundingClientRect();return {t:r.top,b:r.bottom,h:innerHeight}})()`);
check("Menu: the last zone's menu still fits on screen", lastBox.t >= 0 && lastBox.b <= lastBox.h, lastBox);
await key("Escape", 27);
await tap('[data-zmenu="veg"]'); await tap('#zmenu-veg [data-details]');
check("Menu: a step in it opens that step for its zone", (await ev(`!!ui.wiz && ui.wiz.id==="veg" && ui.wiz.step===0`)) === true, await ev(`ui.wiz && [ui.wiz.id, ui.wiz.step]`));
await setupNow();
await tap('[data-zmenu="veg"]'); await tap('#zmenu-veg [data-rmzone]');
check("Menu: Remove zone in it asks first", (await ev(`document.querySelector("#dlg-title")?.textContent`)) === "Remove Veg?");
await ev(`document.querySelector("[data-gkeep]").click()`); await sleep(50);
check("Menu: and keeping the zone leaves the menu closed", !(await menuOpen("veg")));
const addBox = await ev(`(()=>{const a=document.querySelector("[data-addzone]"),s=a.querySelector("svg"),b=document.querySelector('[data-zmenu="garden"]');return {plus:!!s&&s.querySelector("path").getAttribute("d")===ICON.plus,first:a.firstElementChild===s,text:a.textContent,h:a.getBoundingClientRect().height,font:getComputedStyle(a).fontSize}})()`);
const plainBtn = await ev(`(()=>{const b=document.createElement("button");b.className="btn";b.textContent="Add zone";document.querySelector("#main .card-head").appendChild(b);const h=b.getBoundingClientRect().height;b.remove();return h})()`);
check("Add zone: a plus icon before the words", addBox.plus && addBox.first && addBox.text === "Add zone", addBox);
check("Add zone: filled in the primary colour, so it stands out", (await ev(`(()=>{const a=getComputedStyle(document.querySelector("[data-addzone]")),p=document.createElement("i");p.style.color="var(--primary)";document.body.appendChild(p);const c=getComputedStyle(p).color;p.remove();return a.backgroundColor===c})()`)) === true, await ev(`getComputedStyle(document.querySelector("[data-addzone]")).backgroundColor`));
check("Add zone: bigger than an ordinary button", addBox.h > plainBtn + 3 && addBox.font === "15px", { addBox, plainBtn });
await ev(`window.scrollTo(0,0)`); await shot("setup-add-zone-phone");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await setupNow(); await tap('[data-zmenu="garden"]'); await shot("setup-menu-dark"); await key("Escape", 27);
await send("Emulation.setEmulatedMedia", { features: [] });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await setupNow(); await tap('[data-zmenu="garden"]'); await shot("setup-menu-desktop"); await key("Escape", 27); await phone(390, 844); await setupNow();

// Appearance: Home Assistant, Light or Dark, per device, and Home Assistant takes HA's own colours
const primaryNow = () => ev(`getComputedStyle(document.querySelector("[data-addzone]")).backgroundColor`);
const frameTheme = () => ev(`document.documentElement.dataset.theme`);
const pickLook = async (k) => { await tap(`[data-appearance="${k}"]`); await sleep(100); };
const lookOn = () => ev(`document.querySelector('#appearance [aria-pressed="true"]')?.dataset.appearance`);
await setupNow();
check("Appearance: Setup offers Home Assistant, Light and Dark", same(await ev(`[...document.querySelectorAll("#appearance [data-appearance]")].map(b=>b.textContent)`), ["Home Assistant", "Light", "Dark"]));
check("Appearance: Home Assistant is the default", (await lookOn()) === "ha");
check("Appearance: it takes your HA primary colour, red here", (await primaryNow()) === "rgb(244, 67, 54)", await primaryNow());
check("Appearance: Add zone follows it too", (await ev(`getComputedStyle(document.querySelector("[data-addzone]")).backgroundColor`)) === "rgb(244, 67, 54)", await ev(`getComputedStyle(document.querySelector("[data-addzone]")).backgroundColor`));
check("Appearance: dark text on red, since white on it is short of 4.5:1", (await ev(`getComputedStyle(document.querySelector("[data-addzone]")).color`)) === "rgb(17, 17, 17)");
await ev(`window.scrollTo(0,0)`); await shot("appearance-red-phone");
await onHA(`setPrimary("")`); await sleep(100);
check("Appearance: a new primary colour in HA shows straight away", (await primaryNow()) === "rgb(3, 169, 244)", await primaryNow());
await onHA(`setPrimary("#FFEB3B")`); await sleep(100);
check("Appearance: a light primary colour gets dark text", (await ev(`getComputedStyle(document.querySelector("[data-addzone]")).color`)) === "rgb(17, 17, 17)");
await onHA(`setPrimary("#F44336")`); await sleep(100);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(150);
check("Appearance: HA's dark mode turns it dark, in HA's dark colours", (await frameTheme()) === "dark" && (await ev(`getComputedStyle(document.body).backgroundColor`)) === "rgb(17, 17, 17)" && (await ev(`getComputedStyle(document.querySelector("#appearance")).backgroundColor`)) === "rgb(28, 28, 28)" && (await primaryNow()) === "rgb(244, 67, 54)", [await frameTheme(), await ev(`getComputedStyle(document.body).backgroundColor`)]);
await ev(`document.querySelector("#appearance").scrollIntoView({block:"center"})`); await shot("appearance-ha-dark");
await pickLook("light");
check("Appearance: Light keeps it light while HA is dark", (await frameTheme()) === "light" && (await lookOn()) === "light" && (await ev(`getComputedStyle(document.body).backgroundColor`)) === "rgb(250, 250, 250)");
check("Appearance: Light uses the panel's own colours, not HA's", (await primaryNow()) === "rgb(3, 169, 244)", await primaryNow());
check("Appearance: the card says what's chosen", (await ev(`document.querySelector("#appearance").textContent`)).includes("Light, whatever Home Assistant uses"));
check("Appearance: the choice is kept by the host, in this browser", (await onHA(`localStorage.getItem("environment-control-appearance")`)) === "light");
await ev(`document.querySelector("#appearance").scrollIntoView({block:"center"})`); await shot("appearance-light-phone");
await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(100);
await pickLook("dark");
check("Appearance: Dark keeps it dark while HA is light", (await frameTheme()) === "dark" && (await lookOn()) === "dark");
const badLook = await evp(`ask("appearance",{value:"purple"}).then(r=>r.ok)`);
check("Appearance: the host refuses anything but the three", badLook === false && (await onHA(`localStorage.getItem("environment-control-appearance")`)) === "dark");
await pickLook("ha");
await onHA(`document.documentElement.style.setProperty("--primary-color","url(https://example.com/x)");fakeHA.publish()`); await sleep(100);
check("Appearance: a theme value that isn't a plain colour never reaches the panel", (await primaryNow()) === "rgb(3, 169, 244)" && (await ev(`document.documentElement.style.getPropertyValue("--primary")`)) === "", await primaryNow());
await onHA(`setPrimary("#F44336")`); await sleep(100);
check("Appearance: back on Home Assistant it follows HA again", (await lookOn()) === "ha" && (await frameTheme()) === "light" && (await primaryNow()) === "rgb(244, 67, 54)");
await setupNow();

await calibrate();
check("Order: one page, leaf temperature offset only, no soil until irrigation", same(await ev(`[...document.querySelectorAll("#main h2")].map(e=>e.textContent)`), ["Leaf temperature offset"]), await ev(`[...document.querySelectorAll("#main h2")].map(e=>e.textContent)`));
check("Order: the page is called Sensor Calibration", (await ev(`document.querySelector("#main h1").textContent`)) === "Sensor Calibration: Garden");
await calibrate("veg");
check("Order: a zone with no probes shows only the offsets", same(await ev(`[...document.querySelectorAll("#main h2")].map(e=>e.textContent)`), ["Leaf temperature offset"]));
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(40);
check("Order: Back returns to Setup", (await ev(`!ui.leafw && ui.screen==="setup" && !!document.querySelector("[data-addzone]")`)) === true);
await setupNow(); await ev(`document.querySelector('[data-vpd="garden"]').click()`); await sleep(50);
check("Order: Targets goes straight to the chart", (await ev(`!!ui.vpdw && !ui.leafw && !!document.querySelector("#vwrap")`)) === true);
check("Order: there are no steps left on it", !(await ev(`document.querySelector("#main").textContent`)).includes("Step "));
await calibrate(); await tap("#lin-g-left"); await type("2"); await key("Enter", 13);
await leafSave(60);
check("Order: an offset still waits for the board", (await ev(`ui.leafw.sending`)) === true && (await board("g-left")) !== -2);
await sleep(ACK);
await setupNow(); await ev(`document.querySelector('[data-vpd="garden"]').click()`); await sleep(50);
const afterNext = await ev(`(()=>{const v=ui.vpdw,b=v&&v.bands.day;return v?{leaf:v.leaf,want:zoneLeaf(zones[0]),agrees:Math.abs(b.vpd[2]-calcVpd(b.temperature[2],b.humidity[2],v.leaf))<0.03}:null})()`);
check("Order: the chart opens at the new offset", !!afterNext && afterNext.leaf === -1.2 && afterNext.want === -1.2, afterNext);
await boardSet([["number.environment_left_leaf_temperature_offset", -1]]); await boardSilent("number.environment_right_leaf_temperature_offset", true); await ev(`leafSends.length=0`);
await calibrate(); await tap("#lin-g-right"); await type("2"); await key("Enter", 13);
await leafSave(GIVE_UP);
check("Order: an unconfirmed board stays on screen as not confirmed", (await ev(`!!ui.leafw`)) === true && (await ev(`document.querySelector("#ls-g-right").textContent`)).includes("Not confirmed"));
await boardSilent("number.environment_right_leaf_temperature_offset", false); await ev(`leafSends.length=0;ui.leafw=null;render()`);

// Left and right can differ, and the chart can only draw one
const basisZone = await ev(`zones[0].now.vpd`);
await openL();
check("Basis: offered with the sensors counted in the zone", same(await ev(`[...document.querySelectorAll("[data-lbasis]")].map(b=>b.textContent)`), ["Average", "Env left", "Env right", "Env under"]), await ev(`[...document.querySelectorAll("[data-lbasis]")].map(b=>b.textContent)`));
check("Basis: Average is the default", (await ev(`document.querySelector('[data-lbasis=""]').getAttribute("aria-pressed")`)) === "true");
check("Basis: says what the chart is drawn at", (await ev(`document.querySelector("#l-basis-note").textContent`)).includes("Drawn at leaf 0.8 °C below air"), await ev(`document.querySelector("#l-basis-note").textContent`));
check("Basis: and that each sensor keeps its own", (await ev(`document.querySelector("#l-basis-note").textContent`)).includes("own offset"));
await tap("#lin-g-under"); await type("3");
await tap('[data-lbasis="g-right"]');
check("Basis: a tap while typing still lands", (await ev(`ui.leafw.basis`)) === "g-right" && (await ev(`document.querySelector('[data-lbasis="g-right"]').getAttribute("aria-pressed")`)) === "true", await ev(`ui.leafw.basis`));
check("Basis: the note follows the pick", (await ev(`document.querySelector("#l-basis-note").textContent`)).includes("Drawn at leaf 1.0"), await ev(`document.querySelector("#l-basis-note").textContent`));
await sleep(120);
check("Basis: the keyboard room goes once the tap has finished", (await ev(`document.body.classList.contains("vtyping")`)) === false, await ev(`document.body.className`));
await tap('[data-lbasis=""]');
check("Basis: the average follows what's typed", (await ev(`document.querySelector("#l-basis-note").textContent`)).includes("Drawn at leaf 1.7"), await ev(`document.querySelector("#l-basis-note").textContent`));
await tap('[data-lbasis="g-under"]');
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(40);
check("Basis: Cancel keeps nothing", !(await ev(`zones[0].leafBasis`)), await ev(`zones[0].leafBasis`));
await openL(); await tap('[data-lbasis="g-under"]'); await leafSave(60);
check("Basis: Save keeps the pick", (await ev(`zones[0].leafBasis`)) === "g-under" && (await ev(`zoneLeaf(zones[0])`)) === -0.5, await ev(`zones[0].leafBasis`));
check("Basis: it writes to no board", (await sends()).length === 0, await sends());
check("Basis: the zone reading doesn't move", (await ev(`zones[0].now.vpd`)) === basisZone, await ev(`zones[0].now.vpd`));
await open();
check("Basis: the chart draws at that sensor's offset", (await ev(`ui.vpdw.leaf`)) === -0.5, await ev(`ui.vpdw.leaf`));
check("Basis: and names it", (await ev(`document.querySelector("#main").textContent`)).includes("from Environment under"));
await openL();
check("Basis: comes back selected", (await ev(`document.querySelector('[data-lbasis="g-under"]').getAttribute("aria-pressed")`)) === "true");
await ev(`zones[0].sensors.find(s=>s.id==="g-under").avg=false;render()`);
check("Basis: a sensor left out of the reading isn't offered", (await ev(`!document.querySelector('[data-lbasis="g-under"]') && document.querySelector('[data-lbasis=""]').getAttribute("aria-pressed")==="true"`)) === true);
await ev(`ui.leafw=null;zones[0].sensors.find(s=>s.id==="g-under").avg=true;zones[0].sensors.find(s=>s.id==="g-under").leaf=-1;zones[0].leafBasis=undefined;render()`);
await openL();
check("Basis: matching sensors say so", (await ev(`document.querySelector("#l-basis-note").textContent`)).includes("Every sensor matches"), await ev(`document.querySelector("#l-basis-note").textContent`));
/* Since #54 Back rides in the bar at the foot of the window, with the draft bar taking over once something differs. */
check("Basis: Back is in the bar at the foot of the window", (await ev(`(()=>{const b=document.querySelector("#pagebar [data-lexit]").getBoundingClientRect();return b.bottom<=innerHeight&&b.bottom>innerHeight-120})()`)) === true);
await tap("#lin-g-left"); await type("2"); await key("Enter", 13);
check("Basis: offsets starting to differ keep Back at the foot, beside Discard", (await ev(`(()=>{const b=document.querySelector("#draftbar [data-dback]");if(!b||b.hidden)return false;const r=b.getBoundingClientRect();return r.bottom<=innerHeight&&r.bottom>innerHeight-160})()`)) === true);
await ev(`ui.leafw=null;zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5;render()`);
await openL("veg");
check("Basis: not offered with one sensor", (await ev(`!document.querySelector("#l-basis")`)) === true);
await ev(`ui.leafw=null;ui.vpdw=null;ui.td=null;ui.sched=null;render()`);

// One offset for the chart
await open();
check("Chart: mixed offsets say they're an average", (await ev(`document.querySelector("#main").textContent`)).includes("the average of 3 sensors"), await ev(`ui.vpdw.leaf`));
check("Chart: uses the average of the counted sensors", (await ev(`ui.vpdw.leaf`)) === -0.8, await ev(`ui.vpdw.leaf`));
// The leaf offset line is in the accent colour, words and button alike, and readable on the card in both themes (#159)
/* HA's own colours, as the host sends them for its light and dark themes; the attribute alone leaves HA's colours in place. */
const LEAF_THEMES = { light: { card: "#FFFFFF", fg: "#212121", muted: "#727272" }, dark: { card: "#1C1C1C", fg: "#E1E1E1", muted: "#9B9B9B" } };
const leafLook = (theme, accent) => ev(`(()=>{const r=document.documentElement;r.dataset.theme="${theme}";r.style.setProperty("--primary","${accent}");Object.entries(${JSON.stringify(LEAF_THEMES[theme])}).forEach(([k,v])=>r.style.setProperty("--"+k,v));
const rgb=(c)=>{const n=c.match(/[0-9.]+/g).map(Number);return c.startsWith("color(")?n.slice(0,3).map((x)=>x*255):n.slice(0,3)},lin=(v)=>(v/=255)<=0.03928?v/12.92:((v+0.055)/1.055)**2.4,lum=(c)=>{const [a,g,b]=rgb(c);return 0.2126*lin(a)+0.7152*lin(g)+0.0722*lin(b)},ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
const w=document.querySelector("#vleaf"),t=w.querySelector("span"),b=w.querySelector(".vleafbtn"),cs=getComputedStyle,p=document.createElement("i");let card=w,bg;
while(card&&((bg=cs(card).backgroundColor)==="rgba(0, 0, 0, 0)"||bg==="transparent"))card=card.parentElement;
p.style.color="var(--primary-text)";w.append(p);const acc=cs(p).color;p.style.color="var(--muted)";const muted=cs(p).color;p.style.color="var(--fg)";const fg=cs(p).color;p.remove();
const [ar,ag,ab]=rgb(acc),hue=ar>ag+40&&ar>ab+40?"red":ab>ar+40&&ab>ag?"blue":"";
return {acc,muted,fg,hue,bg,text:cs(t).color,btn:cs(b).color,border:cs(b).borderTopColor,contrast:Math.round(ratio(cs(t).color,bg)*100)/100}})()`);
const themeBefore = await ev(`[document.documentElement.dataset.theme||"",document.documentElement.style.cssText]`), leafBgs = new Set();
for (const theme of ["light", "dark"]) for (const [accent, said, hue] of [["#F44336", "red", "red"], ["#03A9F4", "HA's light blue", "blue"]]) {
  const l = await leafLook(theme, accent); leafBgs.add(l.bg);
  check(`Chart: the leaf offset words and the Change button's label and outline take the accent text colour, ${said} in ${theme}`, l.text === l.acc && l.btn === l.acc && l.border === l.acc && l.acc !== l.muted && l.acc !== l.fg && l.hue === hue, l);
  check(`Chart: the leaf offset line is 4.5:1 or better on the card, ${said} in ${theme}`, l.contrast >= 4.5, l);
}
check("Chart: the leaf offset colours were judged on both themes' cards", leafBgs.size === 2, [...leafBgs]);
await ev(`(()=>{const r=document.documentElement,[t,css]=${JSON.stringify(themeBefore)};if(t)r.dataset.theme=t;else delete r.dataset.theme;r.style.cssText=css})()`);
const targetBefore = await band("vpd", 2);
await ev(`document.querySelector("[data-calw]").click()`); await sleep(50);
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(50);
check("Chart: going back with no change leaves Target VPD alone", (await band("vpd", 2)) === targetBefore, await band("vpd", 2));
await ev(`document.querySelector("[data-calw]").click()`); await sleep(50);
await tap("#lin-g-under"); await type("2"); await ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`); await sleep(50);
check("Chart: applying an offset from the chart's Change link stays on Sensor Calibration (#156)", (await ev(`!!ui.leafw && !!ui.vpdw && document.querySelector("#lin-g-under").value==="2.0"`)) === true, await ev(`[!!ui.leafw, document.querySelector("#lin-g-under")?.value]`));
await clickIt("[data-lexit]");
check("Chart: a saved offset comes back into the open chart", (await ev(`ui.vpdw.leaf`)) === -1.3 && (await ev(`!ui.leafw && !document.querySelector("#modal").querySelector("[data-gdiscard]") && !!document.querySelector("#vwrap")`)) === true, await ev(`ui.vpdw.leaf`));
check("Chart: and moves Target VPD with it", (await band("vpd", 2)) !== targetBefore, await band("vpd", 2));
await ev(`zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5`);
// Athena's Flower finish only fits with the leaf at air temperature
await ev(`ui.mapw=null;ui.wiz=null;ui.leafw=null;openVpd("nursery");render()`); await sleep(40);
await ev(`document.querySelector("[data-vstage=finish]").click()`); await sleep(50);
check("Finish: no conditions fit at leaf -1", (await issueText()).some((t) => t.includes("No conditions fit")), await issueText());
await tap("#v-issues [data-calw]");
check("Finish: Fix opens the offsets", (await ev(`!!ui.leafw && !!ui.vpdw`)) === true);
await tap("#lin-n-env"); await type("0"); await leafSave(); await clickIt("[data-lexit]");
check("Finish: leaf same as air clears it", (await issueText()).length === 0 && (await ev(`ui.vpdw.leaf`)) === 0, await issueText());
check("Finish: and that change went to the board", (await sends()).includes("number.nursery_environment_leaf_temperature_offset=0") && (await board("n-env")) === 0, await sends());
const fin = await ev(`(()=>{const b=ui.vpdw.bands[ui.vpdw.period],t=b.temperature,h=b.humidity,p=b.vpd;return {inside:t[2]>=t[1]&&t[2]<=t[3]&&h[2]>=h[1]&&h[2]<=h[3]&&p[2]>=p[1]&&p[2]<=p[3],agrees:Math.abs(calcVpd(t[2],h[2],0)-p[2])<0.03,saveOn:!document.querySelector("[data-dreview]").disabled,target:[t[2],h[2],p[2]]}})()`);
check("Finish: Target lands inside every ideal range", fin.inside, fin);
check("Finish: its temperature, humidity and VPD still agree", fin.agrees, fin);
check("Finish: it can be saved", fin.saveOn, fin);
check("Finish: and it says the Target moved", (await ev(`document.querySelector("#toast").textContent`)).includes("Target moved"), await ev(`document.querySelector("#toast").textContent`));
await ev(`(document.querySelector("[data-tdexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(40);
await boardSet([["number.nursery_environment_leaf_temperature_offset", -1]]); await ev(`leafSends.length=0`);
// The ideal-zone check judges every value a limit may take, not the chart's old 16 to 34 degree, 30 to 90 % grid (#159)
await ev(`ui.mapw=null;ui.wiz=null;ui.leafw=null;openVpd("nursery");render()`); await sleep(40);
const idealIssues = async (period, t, h, p) => { await ev(`(()=>{const v=ui.vpdw;v.period="${period}";Object.assign(v.bands["${period}"],{temperature:${JSON.stringify(t)},humidity:${JSON.stringify(h)},vpd:${JSON.stringify(p)}});render()})()`); await sleep(30); return issueText(); };
const fitsNone = (got) => got.some((x) => x.includes("No conditions fit"));
/* A narrow range, its VPD worked out at the chart's own offset from the middle of the range so it is sure to fit. */
const narrowIssues = async (period, t0) => { const p = await ev(`(()=>{const m=${t0}+0.2,l=ui.vpdw.leaf;return [Math.floor(calcVpd(m,61,l)*100)/100,Math.ceil(calcVpd(m,61,l)*100)/100]})()`); return idealIssues(period, [t0 - 2, t0, t0 + 0.2, Math.round((t0 + 0.4) * 10) / 10, t0 + 2], [50, 60, 61, 62, 70], [p[0] - 0.2, p[0], p[0], p[1], p[1] + 0.2]); };
for (const period of ["day", "night"]) {
  const cool = await idealIssues(period, [8, 10, 12, 14, 16], [40, 50, 60, 70, 80], [0.2, 0.4, 0.6, 0.8, 1]);
  check(`Ideal zone: a ${period} range of 10 to 14 degrees, below the old grid, that fits isn't told nothing fits`, cool.length === 0, cool);
  const coolHigh = await idealIssues(period, [8, 10, 12, 14, 16], [40, 50, 60, 70, 80], [1, 1.2, 1.4, 1.6, 1.8]);
  check(`Ideal zone: the same ${period} range with a VPD it can't reach is still told nothing fits`, fitsNone(coolHigh), coolHigh);
  for (const t0 of [12.2, 20.2]) {
    const narrow = await narrowIssues(period, t0);
    check(`Ideal zone: a narrow ${period} range that fits, ${t0} to ${Math.round((t0 + 0.4) * 10) / 10} degrees and 60 to 62 %, isn't flagged`, narrow.length === 0, narrow);
  }
}
await ev(`ui.vpdw.period="day";render()`);

// Where a sensor's offset is held is chosen on Sensor Calibration, as the panel has it since #17, not in Device identification
await ev(`ui.vpdw=null;ui.td=null;ui.sched=null;ui.screen="setup";render();document.querySelector('[data-mapw="veg"]').click()`); await sleep(50);
check("Calibration: Device identification doesn't ask about the offset", (await ev(`!document.querySelector('[data-mmetric^="v-env:leaf"]')`)) === true);
await ev(`ui.mapw=null;render()`); await openL("veg");
check("Calibration: a board's sensor asks where its offset is held, on the board by default", (await ev(`document.querySelector('[data-lsrc="v-env"][value="number.veg_environment_leaf_temperature_offset"]').checked`)) === true);
await ev(`(()=>{const e=document.querySelector('[data-lsrc="v-env"][value="kept"]');e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(40);
check("Calibration: kept here starts from the board's last value", (await ev(`document.querySelector("#lin-v-env").value`)) === "1.0");
await tap("#lin-v-env"); await type("2"); await key("Enter", 13); await leafSave(60);
check("Calibration: and saving it writes nothing to the board", (await sends()).length === 0 && (await ev(`zones[1].sensors[0].leafLive`)) === -1 && (await saved("v-env")) === -2 && (await ev(`zones[1].sensors[0].leafUnused`)) === true, await sends());
await ev(`zones[1].sensors[0].leafUnused=false;zones[1].sensors[0].leaf=undefined;render()`);
await ev(`zones[1].sensors[0].t=null;zones[1].sensors[0].h=null`); await openL("veg");
check("Leaf: a dead sensor shows no data, never a number", await ev(`(()=>{const t=document.querySelector("#main").textContent;return t.includes("No data from this sensor")&&!t.includes("NaN")&&t.includes("VPD --")})()`), await ev(`document.querySelector("#l-zone").textContent`));
await ev(`zones[1].sensors[0].t=20.4;zones[1].sensors[0].h=72.1;ui.leafw=null;render()`);
await ev(`ui.vpdw=null;ui.td=null;ui.sched=null;ui.screen="setup";render()`);

for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await openL(); await sleep(60);
  const hidden = [];
  for (const id of ["g-left", "g-right", "g-under"]) {
    await tap(`#lin-${id}`); await sleep(420);
    const r = await ev(`(()=>{const e=document.querySelector("#lin-${id}").getBoundingClientRect(),bar=document.querySelector(".topbar"),head=bar&&getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0;return {top:e.top,bottom:e.bottom,head,h:innerHeight,active:document.activeElement.id}})()`);
    const line = r.h * (1 - kb);
    if (r.active !== `lin-${id}` || r.top < r.head - 1 || r.bottom > line) hidden.push([id, Math.round(r.top), Math.round(r.bottom), "limit " + Math.round(line), r.active]);
    await key("Escape", 27); await sleep(40);
  }
  check(`Leaf ${name} ${w}x${h}: every box stays above the keyboard and below the header`, hidden.length === 0, hidden);
  check(`Leaf ${name}: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`));
}
await phone(320, 640); await openL(); await sleep(60);
check("Leaf 320px: a long entity id wraps instead of widening the page", await ev(`document.documentElement.scrollWidth<=innerWidth`));
check("Leaf: box text is 16px on touch", (await ev(`getComputedStyle(document.querySelector("[data-lin]")).fontSize`)) === "16px");
// ---------- VPD tile: leaf link names the offset as signed degrees
const leafLink = async () => ev(`(()=>{ui.screen="zone";ui.zone=zones[0].id;render();return document.querySelector('#main .tile [data-calw]').closest(".tavg").textContent.trim()})()`);
await ev(`window.__lk=envOf(zones[0]).map(s=>[s.leafLive,s.leaf]);envOf(zones[0]).forEach(s=>{s.leafLive=-1;s.leaf=-1})`);
check("VPD tile: a shared offset reads as signed degrees", (await leafLink()) === "Leaf temperature offset -1.0 °C. Change ›", await leafLink());
await ev(`envOf(zones[0]).forEach(s=>{s.leafLive=0.5;s.leaf=0.5})`);
check("VPD tile: an offset above air carries a plus", (await leafLink()) === "Leaf temperature offset +0.5 °C. Change ›", await leafLink());
await ev(`envOf(zones[0]).forEach((s,i)=>{s.leafLive=i?-1:-0.5;s.leaf=s.leafLive})`);
check("VPD tile: offsets that differ say per sensor", (await leafLink()) === "Leaf temperature offset per sensor. Change ›", await leafLink());
await ev(`envOf(zones[0]).forEach((s,i)=>{[s.leafLive,s.leaf]=window.__lk[i]});render()`);
// ---------- Map devices: sensor classes
await phone(390, 844); await reset();
const mOpen = async (id) => { await ev(`ui.screen="setup";ui.wiz=null;openMap("${id}");render()`); await sleep(40); };
/* Choices are radio chips since #24, so a value is picked by checking its chip. */
const mChange = async (sel, v) => { await ev(`(()=>{let e=document.querySelector('${sel}');if(e.type==="radio"){e=document.querySelector('${sel}[value="'+${JSON.stringify(String(v))}+'"]');e.checked=true}else if(e.type==="checkbox")e.checked=${JSON.stringify(v)};else e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(40); };
const slotNames = (id) => ev(`[...document.querySelectorAll("#ms-${id} fieldset.chips legend")].map(e=>e.textContent.replace(", pick one",""))`);
const combineSel = () => ev(`[...document.querySelectorAll(".combine legend")].map(e=>e.textContent)`);
await mOpen("garden");
check("Map: with only the Environment class, no class box is shown", (await ev(`document.querySelectorAll("[data-mclass]").length`)) === 0);
check("Map: an environment sensor is asked for temperature, humidity, VPD and light, never its offset", same(await slotNames("g-left"), ["Temperature", "Humidity", "VPD", "Light"]), await slotNames("g-left"));
check("Map: no soil probes offered until irrigation", (await ev(`catalog().every(s=>s.kind==="env") && !/soil/i.test(document.querySelector("#main").textContent)`)) === true);
check("Map: every sensor is in the average until excluded", (await ev(`[...document.querySelectorAll("[data-mavg]")].every(e=>!e.checked) && document.querySelectorAll("[data-mavg]").length===3 && document.querySelector('#ms-g-left .inavg').textContent.trim()==="Exclude from average"`)) === true);
check("Map: one combine choice for the environment sensors", same(await combineSel(), ["How should these 3 environment sensors combine into the zone's reading?"]), await combineSel());
await mChange('[data-mavg="g-right"]', true);
check("Map: two still counted keeps the choice", same(await combineSel(), ["How should these 2 environment sensors combine into the zone's reading?"]), await combineSel());
await mChange('[data-mavg="g-under"]', true);
check("Map: one left counted hides it", (await ev(`document.querySelectorAll(".combine").length`)) === 0);
await mChange('[data-mavg="g-under"]', false);
await ev(`document.querySelector('[data-msensor="x-pulse"]').click()`); await sleep(40);
check("Map: any other sensor on the device can be put to a reading, on request", (await ev(`document.querySelector('[data-mmore="x-pulse:humidity"]').textContent.trim()`)) === "From this device: 3 more sensors ›", await ev(`document.querySelector('[data-mmore="x-pulse:humidity"]').textContent.trim()`));
for (const k of ["temperature", "humidity", "vpd", "light"]) await mChange(`[data-mmetric="x-pulse:${k}"]`, "none");
check("Map: a sensor with every reading Not used stops Next", (await ev(`mapIssues(ui.mapw).some(i=>i.text==="Air monitor: pick at least one reading, or leave this sensor out.") && document.querySelector('[data-mstep="next"]').disabled`)) === true, await ev(`mapIssues(ui.mapw).map(i=>i.text)`));
await ev(`document.querySelector('[data-msensor="x-pulse"]').click()`); await sleep(40);
await mChange('[data-mcombine="env"]', "median");
check("Map: the review lists exclusion and method", (await ev(`(()=>{const it=mapDraft(ui.mapw).items;return it.some(i=>i.label==="Environment right average"&&i.after==="Excluded")&&it.some(i=>i.label==="Environment sensors combine by"&&i.before==="Average"&&i.after==="Median")})()`)) === true, await ev(`mapDraft(ui.mapw).items`));
await ev(`saveMap(ui.mapw);ui.mapw=null;render()`);
check("Map: saved, the zone combines by the environment method", (await ev(`methodOf(zones[0])==="median"`)) === true);
check("Map: and the excluded sensor is out of the reading", (await ev(`zones[0].sensors.find(s=>s.id==="g-right").avg===false && Math.abs(zoneAverage(zones[0],"humidity")-combine("median",envOf(zones[0]).filter(s=>s.id!=="g-right").map(s=>s.h)))<1e-9`)) === true);
await ev(`zones[0].sensors.find(s=>s.id==="g-right").avg=true;zones[0].combine=undefined;ui.screen="overview";render()`); await sleep(40);
// ---------- Device identification: names, entities, modes and virtual devices, as the panel has them since #36
await mOpen("garden"); await ev(`ui.mapw.step=2;ui.mapw.roles.plug="Other";render()`); await sleep(30);
const inputType = (sel, v) => ev(`(()=>{const e=document.querySelector('${sel}');e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("input",{bubbles:true}))})()`);
await inputType("#name-md-heater", "Mains heater"); await sleep(30);
check("Ident: renaming a device counts in the bar at the foot, beside the plug's type", (await ev(`document.querySelector("#main .wizbar .draft-count").textContent`)) === "2", await ev(`document.querySelector("#main .wizbar").textContent`));
await ev(`render()`); await sleep(20);
check("Ident: a renamed device says what HA calls it, with a way to put that back", (await ev(`document.querySelector("#md-heater").textContent`)).includes("Home Assistant calls it Heater.") && !!(await ev(`document.querySelector('[data-mnamereset="heater"]')`)));
await inputType("#swap-heater", "spare"); await sleep(40);
await ev(`document.querySelector('[data-mswap="heater"]').click()`); await sleep(30);
check("Ident: a device can move to an entity no zone uses yet", (await ev(`mapDraft(ui.mapw).items.some(i=>i.label==="Heater entity"&&i.before==="switch.heater_mains"&&i.after==="switch.spare_plug")`)) === true && (await ev(`document.querySelector("#md-heater").textContent`)).includes("On switch.spare_plug."));
await ev(`delete ui.mapw.swap.heater;render()`); await sleep(20);
check("Ident: a dehumidifier offers an extra mode and which modes Controls shows", (await ev(`!!document.querySelector('[data-mextra="dehu"]') && [...document.querySelectorAll('[data-mhide="dehu"]')].map(e=>e.value).join()==="boost,comfort,eco,sleep"`)) === true);
await inputType('[data-mextra="dehu"]', "normal"); await ev(`render()`); await sleep(20);
await mChange('[data-mhide="dehu"][value="sleep"]', false);
check("Ident: the extra mode joins the modes offered, and a mode can be left out", (await ev(`[...document.querySelectorAll('[data-mhide="dehu"]')].map(e=>e.value+(e.checked?"":"-")).join()`)) === "boost,comfort,eco,normal,sleep-");
await ev(`document.querySelector("[data-maddvirt]").click()`); await sleep(40);
check("Ident: adding a virtual device opens its name box, and it must be named", (await ev(`document.activeElement.dataset.mvname`)) === "v-new_1" && (await ev(`document.querySelector("#main .wizbar").textContent`)).includes("A virtual device needs a name.") && (await ev(`document.querySelector('[data-mstep="next"]').disabled`)) === true);
await inputType('[data-mvname="v-new_1"]', "Drain tank"); await mChange('[data-mvtype="v-new_1"]', "Tank");
check("Ident: named and typed, it's Virtual, Tank", (await ev(`document.querySelector("#mv-v-new_1").textContent`)).includes("Virtual, Tank."));
await ev(`document.querySelector('[data-mgo="0"]').click()`); await sleep(30);
check("Ident: a step can be gone to by tapping it", (await ev(`ui.mapw.step`)) === 1);
await ev(`ui.mapw.step=3;render()`); await sleep(20);
check("Ident: Check lists the virtual device and the new name", (await ev(`document.querySelector("#main .review").textContent`)).includes("Drain tank (tank)") && (await ev(`document.querySelector("#main .review").textContent`)).includes("Mains heater (Heater)"), await ev(`document.querySelector("#main .review").textContent`));
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(40); await ev(`document.querySelector("[data-rapply]").click()`); await sleep(300);
check("Ident: applied, the name, extra mode, modes and virtual device are saved, HA's name kept", (await ev(`(()=>{const h=devices.find(d=>d.id==="heater"),d=devices.find(d=>d.id==="dehu"),v=(zones[0].virtual||[]).find(v=>v.name==="Drain tank");return h.name==="Mains heater"&&h.haName==="Heater"&&d.nudgeMode==="normal"&&d.hiddenModes.join()==="sleep"&&v&&v.type==="Tank"})()`)) === true);
await ev(`(()=>{const h=devices.find(d=>d.id==="heater");h.name="Heater";delete h.haName;const d=devices.find(d=>d.id==="dehu");delete d.nudgeMode;delete d.hiddenModes;delete zones[0].virtual;devices.find(d=>d.id==="plug").type=null;ui.mapw=null;render()})()`); await sleep(20);

// ---------- Sharing asks first: something another zone has joins this one only once a person says so
const shareAsk = () => ev(`(()=>{const d=document.querySelector("#modal .dialog");return d && !document.querySelector("#modal").hidden ? {role:d.getAttribute("role"),title:d.querySelector("#dlg-title").textContent,text:d.querySelector("#dlg-text").textContent,more:d.querySelector("#dlg-more")?.textContent ?? null,described:d.getAttribute("aria-describedby"),buttons:[...d.querySelectorAll(".dlgfoot button")].map(b=>b.textContent),red:[...d.querySelectorAll(".dlgfoot button")].some(b=>b.classList.contains("danger")),primary:d.querySelector("[data-gdiscard]").className,focus:document.activeElement.id} : null})()`);
const noAsk = async () => (await shareAsk()) === null && (await ev(`!ui.guard`)) === true;
const DEHU_ASK = { role: "alertdialog", title: "Dehumidifier", text: "This device is already associated to Zone: Garden. Are you sure you want to duplicate it here?", more: "This means that controls are in sync in both zones. Automations from Garden may affect the device state.", described: "dlg-text dlg-more", buttons: ["Cancel", "Add"], red: false, primary: "btn primary", focus: "dlg-title" };
await phone(390, 844); await reset(); await mOpen("nursery"); await ev(`ui.mapw.step=2;render()`); await sleep(30);
await tap('[data-mdevice="dehu"]');
check("Share: ticking a device another zone has asks first, under its name, in two paragraphs, in the panel's own dialog, with its primary button and not the red one", same(await shareAsk(), DEHU_ASK) && (await ev(`!ui.mapw.pickD.dehu`)) === true && (await hostDialog()).open === false, await shareAsk());
await shot("share-ask-device-phone");
await tap("[data-gkeep]");
check("Share: Cancel leaves the device unticked, focus back on its row", (await noAsk()) && (await ev(`!ui.mapw.pickD.dehu && document.querySelector('[data-mdevice="dehu"]').getAttribute("aria-pressed")==="false" && document.activeElement.dataset.mdevice==="dehu"`)) === true);
/* Each way out is taken only once the question is showing, so a row ticked without asking can't pass for one left out. */
let asked;
await tap('[data-mdevice="dehu"]'); asked = await shareAsk(); await key("Escape", 27);
check("Share: Escape leaves it unticked", !!asked && (await noAsk()) && (await ev(`!ui.mapw.pickD.dehu`)) === true);
await tap('[data-mdevice="dehu"]'); asked = await shareAsk(); await tellBack();
check("Share: so does the back gesture", !!asked && (await noAsk()) && (await ev(`!ui.mapw.pickD.dehu && !!ui.mapw`)) === true);
await tap('[data-mdevice="dehu"]'); asked = await shareAsk(); await ev(`document.querySelector("#modal").click()`); await sleep(40);
check("Share: and a tap outside the dialog", !!asked && (await noAsk()) && (await ev(`!ui.mapw.pickD.dehu`)) === true);
await tap('[data-mdevice="dehu"]'); await tap("[data-gdiscard]");
check("Share: Add ticks it in the draft, saving nothing, and the row still says who shares it", (await ev(`ui.mapw.pickD.dehu===true && document.querySelector('[data-mdevice="dehu"]').getAttribute("aria-pressed")==="true" && document.querySelector("#md-dehu").textContent.includes("Shared. Also in Garden.") && document.activeElement.dataset.mdevice==="dehu"`)) === true && !(await diskZone("nursery")) === false && (await onHA(`JSON.parse(fakeHA.disk).devices.find(d=>d.id==="dehu").zones.join()`)) === "garden", await ev(`document.querySelector("#md-dehu")?.textContent`));
await tap('[data-mdevice="heater"]');
check("Share: unticking never asks, even something shared", (await noAsk()) && (await ev(`!ui.mapw.pickD.heater`)) === true);
await tap('[data-mdevice="heater"]');
check("Share: ticking again what this zone has saved never asks: that sharing was agreed to", (await noAsk()) && (await ev(`ui.mapw.pickD.heater===true`)) === true);
await tap('[data-mdevice="spare-plug"]');
check("Share: ticking what no other zone has never asks", (await noAsk()) && (await ev(`ui.mapw.pickD["spare-plug"]===true`)) === true);
await tap('[data-mdevice="spare-plug"]');
await ev(`ui.mapw.step=3;render()`); await sleep(30);
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
check("Share: the review goes as before, listing it as joining this zone", (await ev(`document.querySelector("#review-items").textContent`)).includes("DehumidifierNot in this zone → In this zone"), await ev(`document.querySelector("#review-items")?.textContent`));
await tap("[data-rapply]"); await sleep(400);
check("Share: applied, it's in both zones, with no question from the host for a device it already switches", (await onHA(`JSON.parse(fakeHA.disk).devices.find(d=>d.id==="dehu").zones.join()`)) === "garden,nursery" && (await hostDialog()).open === false, await onHA(`JSON.parse(fakeHA.disk).devices.find(d=>d.id==="dehu").zones.join()`));
await mOpen("nursery"); await ev(`ui.mapw.step=2;render()`); await sleep(30);
await tap('[data-mdevice="dehu"]');
check("Share: unticking a device now saved here never asks", (await noAsk()) && (await ev(`!ui.mapw.pickD.dehu`)) === true);
await tap('[data-mdevice="dehu"]');
check("Share: nor does ticking it again", (await noAsk()) && (await ev(`ui.mapw.pickD.dehu===true`)) === true);
await tap('[data-mdevice="dehu"]'); await ev(`ui.mapw.step=3;render()`); await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60); await tap("[data-rapply]"); await sleep(400);
check("Share: and taking it out again leaves it in Garden only", (await onHA(`JSON.parse(fakeHA.disk).devices.find(d=>d.id==="dehu").zones.join()`)) === "garden");
await mOpen("garden"); await ev(`ui.mapw.step=2;render()`); await sleep(30);
await tap('[data-mdevice="fans"]');
check("Share: several zones are a plain list in Overview's order, not alphabetical, and three zones in all are all of these zones", same(await shareAsk(), { ...DEHU_ASK, title: "Oscillating fans", text: "This device is already associated to Zones: Veg, Nursery. Are you sure you want to duplicate it here?", more: "This means that controls are in sync in all of these zones. Automations from Veg and Nursery may affect the device state." }), await shareAsk());
await tap("[data-gkeep]");
/* A sensor may be in two zones only inside one family, a parent and the zones linked to it: one zone's readings show in
   another only through that link. Garden isn't linked to Veg, so Veg's sensor can't be ticked here. */
const sensorNo = () => ev(`(()=>{const d=document.querySelector("#modal .dialog");return d && !document.querySelector("#modal").hidden ? {role:d.getAttribute("role"),title:d.querySelector("#dlg-title").textContent,text:d.querySelector("#dlg-text").textContent,buttons:[...d.querySelectorAll(".dlgfoot button")].map(b=>b.textContent+"|"+b.className),focus:document.activeElement.id} : null})()`);
const themeShots = async (name) => {
  for (const look of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", { features: look === "dark" ? [{ name: "prefers-color-scheme", value: "dark" }] : [] }); await sleep(150);
    await shot(`${name}-phone-${look}`); await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(80); await shot(`${name}-desktop-${look}`); await phone(390, 844); await sleep(80);
  }
  await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(100);
};
await ev(`ui.mapw.step=1;render()`); await sleep(30);
await tap('[data-msensor="v-env"]');
check("Share: a sensor outside this zone's family can't be ticked, and the panel's dialog says how it could be", same(await sensorNo(), { role: "alertdialog", title: "Veg environment", text: "This sensor is already associated to Zone: Veg. If you want a duplicate here, this zone must be linked to Veg. This can be done in the Zone details section of Setup.", buttons: ["OK|btn primary"], focus: "dlg-title" }) && (await ev(`!ui.mapw.pickS["v-env"]`)) === true, await sensorNo());
await themeShots("sensor-refused");
await tap("[data-gkeep]");
check("Share: OK closes it with the sensor still unticked, focus back on its row", (await noAsk()) && (await ev(`!ui.mapw.pickS["v-env"] && document.activeElement.dataset.msensor==="v-env"`)) === true);
await tap('[data-msensor="v-env"]'); await key("Escape", 27);
check("Share: so does Escape", (await noAsk()) && (await ev(`!ui.mapw.pickS["v-env"]`)) === true);
await tap('[data-msensor="n-env"]');
check("Share: a sensor of a linked zone says that zone can't be this one's parent", (await sensorNo())?.text === "This sensor is already associated to Zone: Nursery. Nursery is itself linked to Zone: Veg, so it can't be this zone's parent.", await sensorNo());
await tap("[data-gkeep]");
await tap('[data-msensor="g-right"]'); await tap('[data-msensor="g-right"]');
check("Share: a sensor this zone has saved never asks, unticked and ticked again", (await noAsk()) && (await ev(`ui.mapw.pickS["g-right"]===true`)) === true);
await tap('[data-msensor="x-pulse"]');
check("Share: a sensor no zone has never asks", (await noAsk()) && (await ev(`ui.mapw.pickS["x-pulse"]===true`)) === true);
await ev(`ui.mapw=null;ui.screen="setup";render()`); await sleep(30);
/* Nursery is linked to Veg, so Veg's sensor asks the sharing question as before. */
await mOpen("nursery"); await ev(`ui.mapw.step=1;render()`); await sleep(30);
await tap('[data-msensor="v-env"]');
check("Share: in the same family, a sensor another zone has asks, as a sensor", same(await shareAsk(), { ...DEHU_ASK, title: "Veg environment", text: "This sensor is already associated to Zone: Veg. Are you sure you want to duplicate it here?", more: "This means that data is in sync in both zones." }) && (await ev(`!ui.mapw.pickS["v-env"]`)) === true, await shareAsk());
await shot("share-ask-sensor-phone");
await tap("[data-gkeep]");
check("Share: Cancel leaves the sensor unticked", (await noAsk()) && (await ev(`!ui.mapw.pickS["v-env"]`)) === true);
await tap('[data-msensor="v-env"]'); await tap("[data-gdiscard]");
check("Share: Add ticks the sensor in the draft", (await noAsk()) && (await ev(`ui.mapw.pickS["v-env"]===true && document.querySelector('[data-msensor="v-env"]').getAttribute("aria-pressed")==="true"`)) === true);
await tap('[data-msensor="v-env"]');
check("Share: unticking it never asks", (await noAsk()) && (await ev(`!ui.mapw.pickS["v-env"]`)) === true);
await tap('[data-msensor="g-left"]');
check("Share: a zone that already has a parent says so rather than sending you to Zone details", (await sensorNo())?.text === "This sensor is already associated to Zone: Garden. This zone is already linked to Zone: Veg, and a zone is linked to one other zone only.", await sensorNo());
await tap("[data-gkeep]");
await ev(`ui.mapw=null;ui.screen="setup";render()`); await sleep(30);
await mOpen("veg"); await ev(`ui.mapw.step=1;render()`); await sleep(30);
await tap('[data-msensor="g-left"]');
check("Share: a zone other zones are linked to says it can't be linked to another", (await sensorNo())?.text === "This sensor is already associated to Zone: Garden. Zone: Nursery is linked to this zone, so it can't be linked to another.", await sensorNo());
await tap("[data-gkeep]");
await tap('[data-msensor="n-env"]');
check("Share: a parent taking a linked zone's sensor is the same family, so it asks", same(await shareAsk(), { ...DEHU_ASK, title: "Nursery environment", text: "This sensor is already associated to Zone: Nursery. Are you sure you want to duplicate it here?", more: "This means that data is in sync in both zones." }), await shareAsk());
await tap("[data-gkeep]");
await ev(`ui.mapw=null;ui.screen="setup";render()`); await sleep(30);
const crossSensor = await evp(`saveConfig(()=>{zoneById("veg").sensors.push({...zoneById("garden").sensors[0],pos:null})}).then(r=>[r.ok,r.error||""])`);
check("Share: the backend refuses a sensor shared outside a family", same(crossSensor, [false, "Environment left is in Zone: Garden and Veg. A sensor can only be shared between a zone and the zones linked to it."]) && !(await diskZone("veg")).sensors.some((x) => x.id === "g-left"), crossSensor);
/* Inside one family the other ways round are allowed: a parent takes a linked zone's sensor, and two zones linked to one parent share the parent's. */
const familyTries = await onHA(`(()=>{const disk=JSON.parse(fakeHA.disk),z=(c,id)=>c.zones.find(o=>o.id===id),sen=(c,sid)=>({...JSON.parse(JSON.stringify(c.zones.flatMap(o=>o.sensors||[]).find(s=>s.id===sid))),pos:null}),shelf=(c,parent,sid)=>({...JSON.parse(JSON.stringify(z(c,"nursery"))),id:"shelf",name:"Shelf",parent,automations:[],sensors:[sen(c,sid)]});const tryIt=(f)=>{const c=JSON.parse(fakeHA.disk);f(c);try{fakeHA.checkConfig(c,disk);return "ok"}catch(e){return e.message}};return [tryIt((c)=>z(c,"veg").sensors.push(sen(c,"n-env"))),tryIt((c)=>{z(c,"nursery").sensors.push(sen(c,"v-env"));c.zones.push(shelf(c,"veg","v-env"))}),tryIt((c)=>c.zones.push(shelf(c,"garden","n-env")))]})()`);
check("Share: the backend lets a parent take a linked zone's sensor and two zones linked to one parent share the parent's, and refuses a zone of another family", same(familyTries, ["ok", "ok", "Nursery environment is in Zone: Nursery and Shelf. A sensor can only be shared between a zone and the zones linked to it."]), familyTries);
/* A setup stored before linked zones can hold a sensor in unrelated zones: the fake lets it be saved as it is and shrink one zone a save, as the panel edits one zone at a time, and refuses it growing. */
const storedShare = await onHA(`(()=>{const z=(c,id)=>c.zones.find(o=>o.id===id),copy=(c)=>JSON.parse(JSON.stringify(c)),sen=(c,sid)=>({...copy(c.zones.flatMap(o=>o.sensors||[]).find(s=>s.id===sid)),pos:null}),drop=(c,zid)=>{z(c,zid).sensors=z(c,zid).sensors.filter(s=>s.id!=="v-env")};const stored=JSON.parse(fakeHA.disk);delete z(stored,"nursery").parent;for(const zid of ["garden","nursery"])z(stored,zid).sensors.push(sen(stored,"v-env"));const once=copy(stored);drop(once,"nursery");const tryIt=(before,f)=>{const c=copy(before);f(c);try{fakeHA.checkConfig(c,before);return "ok"}catch(e){return e.message}};return [tryIt(stored,()=>{}),tryIt(stored,(c)=>drop(c,"nursery")),tryIt(once,(c)=>drop(c,"garden")),tryIt(stored,(c)=>c.zones.push({id:"shelf",name:"Shelf",sensors:[sen(c,"v-env")]}))]})()`);
check("Share: the backend lets a share stored before linked zones be saved as it is and shrink a zone at a time, and refuses it growing", same(storedShare, ["ok", "ok", "ok", "Veg environment is in Zone: Garden, Veg, Nursery and Shelf. A sensor can only be shared between a zone and the zones linked to it."]), storedShare);
await ev(`ui.mapw=null;ui.screen="setup";render()`); await sleep(30);
// ---------- One zone per automation: another zone's are hidden in Link automations, and can't be ticked when shown
const linkSearch = async (text) => { await ev(`(()=>{const i=document.querySelector("#link-q");i.value=${JSON.stringify(text)};i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await sleep(40); };
const linkNow = () => ev(`(()=>{const t=document.querySelector("[data-lothers]");return {rows:[...document.querySelectorAll("[data-lpick]")].map(b=>b.dataset.lpick),toggle:t&&{text:t.textContent,pressed:t.getAttribute("aria-pressed"),tag:t.tagName+"."+t.className,near:t.closest(".card")===document.querySelector("#link-q").closest(".card")},hidden:(document.querySelector("#link-hidden")||{}).textContent||null}})()`);
const okAsk = () => ev(`(()=>{const d=document.querySelector("#modal .dialog");return d && !document.querySelector("#modal").hidden ? {role:d.getAttribute("role"),title:d.querySelector("#dlg-title").textContent,text:d.querySelector("#dlg-text").textContent,buttons:[...d.querySelectorAll(".dlgfoot button")].map(b=>b.textContent+"|"+b.className),focus:document.activeElement.id} : null})()`);
const linkRowOf = (e) => ev(`(()=>{const b=document.querySelector('[data-lpick="${e}"]');return b&&{disabled:b.getAttribute("aria-disabled"),pressed:b.getAttribute("aria-pressed"),tick:b.querySelector(".tick").textContent,sub:b.querySelector(".dev-sub").textContent,focusable:b.tabIndex>=0&&!b.disabled}})()`);
const TENT_ON = "automation.tent_lights_on", TENT = ["automation.failsafe_tent_lights_recovery", "automation.tent_lights_off", TENT_ON];
/* Link automations is reached through Setup only (#111). */
const linkFromSetup = async (id) => { await ev(`ui.autos=null;ui.guard=null;ui.review=null;renderModal();ui.linkw=null;ui.screen="setup";ui.guide=null;render();window.scrollTo(0,0)`); await sleep(30); await tap(`[data-zmenu="${id}"]`); await tap(`#zmenu-${id} [data-linkautos="${id}"]`); await sleep(300); };
const toggleShots = async (name) => { await shot(`${name}-phone`); await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await shot(`${name}-desktop`); await phone(390, 844); };
await linkFromSetup("nursery");
let ln = await linkNow();
check("One zone: Nursery's suggestions hold none another zone has, so there's no toggle and no count line", ln.toggle === null && ln.hidden === null && !ln.rows.some((e) => TENT.includes(e)) && ln.rows.includes("automation.nursery_heat_mat_on"), ln);
await linkSearch("tent"); ln = await linkNow();
check("One zone: search hides what another zone has, says how many and why, and offers the toggle by the search box", same(ln.rows, []) && ln.hidden === "3 are hidden because another zone has them." && same(ln.toggle, { text: "Show automations in other zones", pressed: "false", tag: "BUTTON.chip", near: true }), ln);
await toggleShots("onezone-toggle-off");
await tap("[data-lothers]"); ln = await linkNow();
check("One zone: the toggle on lists them where they fall, pressed and keeping focus, with no count line", same(ln.rows, TENT) && ln.toggle.pressed === "true" && ln.hidden === null && (await ev(`document.activeElement.matches("[data-lothers]")`)) === true, ln);
check("One zone: such a row reads as unavailable, has no tick, says which zone has it, and can still be reached", same(await linkRowOf(TENT_ON), { disabled: "true", pressed: "false", tick: "", sub: "In Zone: Veg", focusable: true }), await linkRowOf(TENT_ON));
await toggleShots("onezone-toggle-on");
await tap(`[data-lpick="${TENT_ON}"]`);
check("One zone: tapping it explains in the panel's dialog, with one ordinary OK button, and ticks nothing", same(await okAsk(), { role: "alertdialog", title: "Tent Lights On", text: "This automation is already associated to Zone: Veg. Please remove it before associating it with a new zone.", buttons: ["OK|btn primary"], focus: "dlg-title" }) && (await ev(`ui.linkw.pick["${TENT_ON}"]`)) === undefined, await okAsk());
await toggleShots("onezone-dialog");
await tap("[data-gkeep]");
check("One zone: OK closes it, focus back on the row, with nothing ticked or drafted", (await okAsk()) === null && (await ev(`!ui.guard && document.activeElement.dataset.lpick==="${TENT_ON}" && ui.linkw.pick["${TENT_ON}"]===undefined && linkDraft(ui.linkw).items.length===0`)) === true);
for (const [how, act] of [["Escape", () => key("Escape", 27)], ["the back gesture", tellBack], ["a tap outside", () => ev(`document.querySelector("#modal").click()`)]]) {
  await tap(`[data-lpick="${TENT_ON}"]`); const was = await okAsk(); await act(); await sleep(40);
  check(`One zone: ${how} closes it as well, ticking nothing and staying on Link automations`, !!was && (await okAsk()) === null && (await ev(`!ui.guard && !!ui.linkw && ui.linkw.pick["${TENT_ON}"]===undefined`)) === true);
}
await tap("[data-lothers]"); await linkSearch("veg fans"); ln = await linkNow();
check("One zone: off again, one hidden is said in the singular", same(ln.rows, []) && ln.hidden === "1 is hidden because another zone has it." && ln.toggle.pressed === "false", ln);
await linkSearch("porch"); ln = await linkNow();
check("One zone: a search finding none another zone has shows neither the toggle nor the line", same(ln.rows, ["automation.porch_light_on"]) && ln.toggle === null && ln.hidden === null, ln);
await tap('[data-lpick="automation.porch_light_on"]');
check("One zone: one no zone links ticks at once, with no question", (await okAsk()) === null && (await ev(`ui.linkw.pick["automation.porch_light_on"]`)) === "control");
await tap('[data-lpick="automation.porch_light_on"]'); await linkSearch("");
await tap('[data-lpick="automation.nursery_heat_mat_on"]');
check("One zone: unticking one this zone has never asks", (await okAsk()) === null && (await ev(`ui.linkw.pick["automation.nursery_heat_mat_on"]`)) === undefined);
await tap('[data-lpick="automation.nursery_heat_mat_on"]');
check("One zone: nor does ticking it again", (await okAsk()) === null && (await ev(`ui.linkw.pick["automation.nursery_heat_mat_on"]`)) === "control");
await tap("[data-linkback]");
/* Moving one to another zone is two saves: unlinked where it is, then linked in the new zone. */
await linkFromSetup("veg");
await tap(`[data-lpick="${TENT_ON}"]`); await tap("[data-dreview]"); await tap("[data-rapply]"); await sleep(400);
check("One zone: unlinked in Veg, it's in no zone", (await diskZone("veg")).automations.every((a) => a.entity !== TENT_ON) && (await diskZone("nursery")).automations.every((a) => a.entity !== TENT_ON));
await linkFromSetup("nursery"); await linkSearch("tent"); ln = await linkNow();
check("One zone: then Nursery can pick it, the two Veg still has staying hidden", same(ln.rows, [TENT_ON]) && ln.hidden === "2 are hidden because another zone has them." && (await linkRowOf(TENT_ON)).disabled === null, ln);
await tap(`[data-lpick="${TENT_ON}"]`);
check("One zone: and ticking it asks nothing in the panel", (await okAsk()) === null && (await ev(`ui.linkw.pick["${TENT_ON}"]`)) === "control");
await tap("[data-dreview]"); await tap("[data-rapply]"); await sleep(400);
dlg = await hostDialog();
check("One zone: the host asks about it, as for any automation newly linked to a zone", dlg.open && dlg.text.includes(TENT_ON) && dlg.text.includes("for the Nursery zone"), dlg.text);
await sleep(1100); await hostClick("allow"); await sleep(400);
check("One zone: allowed, it's Nursery's alone", (await diskZone("nursery")).automations.some((a) => a.entity === TENT_ON) && (await diskZone("veg")).automations.every((a) => a.entity !== TENT_ON));
/* Two people editing: one zone's save can still meet another's link to the same automation, and the review shows why. */
await linkFromSetup("garden"); await linkSearch("porch"); await tap('[data-lpick="automation.porch_light_on"]');
await ev(`zoneById("veg").automations.push({id:"a99",entity:"automation.porch_light_on",group:"control"})`);
await tap("[data-dreview]"); await tap("[data-rapply]"); await sleep(300);
await sleep(1100); await hostClick("allow"); await sleep(400);
check("One zone: a save the backend refuses for it shows the reason in the review, and stores nothing", (await ev(`document.querySelector("#modal .notice.critical")?.textContent || ""`)).includes("Not saved. An automation can only be linked to one zone.") && (await diskZone("garden")).automations.every((a) => a.entity !== "automation.porch_light_on"), await ev(`document.querySelector("#modal")?.textContent`));
await ev(`zoneById("veg").automations=zoneById("veg").automations.filter(a=>a.id!=="a99")`);
await tap("[data-rback]"); await ev(`ui.linkw.pick={...ui.linkw.was}`); await tap("[data-linkback]");

// ---------- Names: a linked automation can carry a name of the panel's own, as a sensor or device can (#152)
const HUM_LOW = "automation.critical_garden_humidity_low_day";
const linkNameBox = (e) => ev(`(()=>{const i=document.querySelector('[data-lname="${e}"]');return i&&{value:i.value,placeholder:i.placeholder,max:i.maxLength,reset:!!document.querySelector('[data-lnamereset="${e}"]'),row:i.closest(".pickwrap").querySelector(".pick-text").textContent}})()`);
const typeLinkName = async (e, text) => { await ev(`(()=>{const i=document.querySelector('[data-lname="${e}"]');i.scrollIntoView({block:"center"});i.focus();i.select()})()`); await type(text); };
const shownAs = (zone, e) => ev(`autoName(zoneById("${zone}").automations.find(a=>a.entity==="${e}"))`);
await phone(390, 844);
await linkFromSetup("garden"); await linkSearch("porch");
check("Names: an unticked row in Link automations has no name box", (await ev(`!!document.querySelector('[data-lpick="automation.porch_light_on"]') && !document.querySelector('[data-lname="automation.porch_light_on"]')`)) === true);
await linkSearch("");
const box0 = await linkNameBox(RED_FS);
check("Names: a ticked row has an empty name box, as long as a device's, with Home Assistant's name as its hint", !!box0 && box0.value === "" && box0.placeholder === "Failsafe Garden Red Lights Recovery" && box0.max === 100 && !box0.reset, box0);
await typeLinkName(RED_FS, "Red lights watchdog"); await typeLinkName(HUM_LOW, "  Humidity low, day ");
check("Names: typed but not applied, nothing is saved and every place still shows Home Assistant's name", !(await diskZone("garden")).automations.some((a) => a.name && (a.entity === RED_FS || a.entity === HUM_LOW)) && (await shownAs("garden", RED_FS)) === "Failsafe Garden Red Lights Recovery" && (await ev(`actName(zoneById("garden"),{kind:"run",entity:"${HUM_LOW}",name:"Critical Garden Humidity Low Day"})`)) === "Critical Garden Humidity Low Day");
await ev(`document.querySelector("#link-list").innerHTML=linkList(ui.linkw,zoneById("garden"))`);
const box1 = await linkNameBox(RED_FS);
check("Names: the row leads with the panel's name and keeps Home Assistant's on its second line, with a way to put it back", !!box1 && box1.row.startsWith("Red lights watchdog") && box1.row.includes("Failsafe Garden Red Lights Recovery. automation.failsafe_garden_red_lights_recovery") && box1.reset, box1);
await ev(`document.querySelector('[data-lname="${RED_FS}"]').scrollIntoView({block:"center"})`); await shot("autos-link-named-phone");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await onHA(`document.documentElement.dataset.theme="dark"`); await ev(`document.documentElement.dataset.theme="dark"`);
await ev(`document.querySelector('[data-lname="${RED_FS}"]').scrollIntoView({block:"center"})`); await shot("autos-link-named-dark-desktop");
await onHA(`delete document.documentElement.dataset.theme`); await ev(`delete document.documentElement.dataset.theme`); await phone(390, 844);
await tap("[data-dreview]");
const nameReview = await ev(`[...document.querySelectorAll("#review-items .review-row")].map(l=>l.textContent.replace(/\\s+/g," ").trim())`);
check("Names: the review lists each rename, from Home Assistant's name to the panel's, trimmed", nameReview.some((t) => t.includes("Name") && t.includes("Critical Garden Humidity Low Day") && t.includes("Humidity low, day") && !t.includes("  Humidity")) && nameReview.some((t) => t.includes("Failsafe Garden Red Lights Recovery") && t.includes("Red lights watchdog")), nameReview);
await tap("[data-rapply]"); await sleep(400);
const savedNames = (await diskZone("garden")).automations.filter((a) => a.name).map((a) => [a.entity, a.name]);
check("Names: applied, the names are stored on the links, and renaming a link the zone has asks nothing in the host", same(savedNames.map((x) => x.join("=")).sort(), [`${HUM_LOW}=Humidity low, day`, "automation.garden_red_lights_off=Red lights, evening", "automation.garden_red_lights_on=Red lights, morning", `${RED_FS}=Red lights watchdog`].sort()) && (await hostDialog()).open === false, savedNames);
await openAutosAt("garden", "failsafe");
check("Names: the Automations dialog row shows the panel's name", (await ev(`document.querySelector('[data-autorow="${RED_FS}"] .dev-name').textContent`)) === "Red lights watchdog");
await tap(`[data-autorow="${RED_FS}"] .sw`);
check("Names: and so does the question before a failsafe is switched off", (await ev(`ui.guard && ui.guard.title`)) === "Switch off Red lights watchdog?", await ev(`ui.guard && ui.guard.title`));
await tap("[data-gkeep]"); await ev(`ui.autos=null;renderModal()`);
/* As in the Activity checks: the fake's entries are fixed NZ times, and the suite's own zone otherwise decides which part
   of them today holds. */
await send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Auckland" });
await reset(); await goTab("Garden"); await openAct("garden"); await actIdle();
const actNamed = await ev(`[...document.querySelectorAll("#act-body .act-row")].map(r=>r.textContent)`);
check("Names: Activity names a linked automation by the panel's name, in its rows and as a cause", actNamed.some((t) => t.includes("Humidity low, day fired 790 times")) && actNamed.some((t) => t.includes("Humidity low, day switched off")) && actNamed.some((t) => t.includes("Red lights, morning ran at 06:30")) && actNamed.some((t) => t.includes("By Red lights, morning, at a set time")) && !actNamed.some((t) => t.includes("Critical Garden Humidity Low Day")), actNamed);
await send("Emulation.setTimezoneOverride", { timezoneId: "" });
check("Names: an automation the zone doesn't link keeps Home Assistant's name in Activity", (await ev(`actName(zoneById("garden"),{kind:"run",entity:"automation.porch_light_on",name:"Porch Light On"})`)) === "Porch Light On");
await ev(`ui.aview=null;renderModal()`);
await openAutosAt("nursery", "control");
check("Names: a linked zone's card from its parent shows the parent's panel names", (await ev(`[...document.querySelectorAll('#modal [data-from="veg"] .dev-name')].map(n=>n.textContent)`)).includes("Tent lights off"), await ev(`[...document.querySelectorAll('#modal [data-from="veg"] .dev-name')].map(n=>n.textContent)`));
await ev(`ui.autos=null;renderModal()`);
await linkFromSetup("garden");
await tap(`[data-lnamereset="${HUM_LOW}"]`); await typeLinkName(RED_FS, ""); await ev(`document.querySelector('[data-lname="${RED_FS}"]').value=""`);
await tap("[data-dreview]");
const clearReview = await ev(`document.querySelector("#review-items").textContent`);
check("Names: the review lists a cleared name going back to Home Assistant's", clearReview.includes("Humidity low, day") && clearReview.includes("Critical Garden Humidity Low Day") && clearReview.includes("Red lights watchdog"), clearReview);
await tap("[data-rapply]"); await sleep(400);
check("Names: cleared, the links carry no name and Home Assistant's comes back", !(await diskZone("garden")).automations.some((a) => a.entity === HUM_LOW && "name" in a || a.entity === RED_FS && "name" in a) && (await shownAs("garden", HUM_LOW)) === "Critical Garden Humidity Low Day" && (await shownAs("garden", RED_FS)) === "Failsafe Garden Red Lights Recovery");
const badName = async (change) => onHA(`(()=>{const c=JSON.parse(fakeHA.disk);const a=c.zones.find(z=>z.id==="garden").automations[0];${change};return fakeHA.command({type:"environment_control/config/save",revision:fakeHA.config.revision,config:{zones:c.zones,devices:c.devices}}).then(()=>"saved",e=>e.message)})()`);
const nameTries = [await badName(`a.name=5`), await badName(`a.name="x".repeat(101)`), await badName(`a.name=""`), await badName(`a.icon="mdi:fan"`)];
check("Names: the backend refuses a name that isn't short text and a link with an unknown key", nameTries.slice(0, 3).every((m) => m.includes("a name that isn't short text")) && nameTries[3].includes("something other than an id, an entity, a group and a name"), nameTries);
const disguised = evp(`saveConfig(()=>{zoneById("nursery").automations.push({id:"a99",entity:"automation.porch_light_on",group:"control",name:"Garden Lights On"})}).then(r=>r.ok)`);
await sleep(300); dlg = await hostDialog();
check("Names: the host's question for a newly linked automation names Home Assistant's automation and entity, never the panel's name for it", dlg.open && dlg.text.includes("Porch Light On") && dlg.text.includes("automation.porch_light_on") && !dlg.text.includes("Garden Lights On"), dlg.text);
await key("Escape", 27); await sleep(150);
check("Names: and a no stores nothing", (await disguised) === false && !(await diskZone("nursery")).automations.some((a) => a.entity === "automation.porch_light_on"));
await ev(`ui.screen="setup";ui.linkw=null;render()`);
/* The auxiliary dehumidifier is in all three sample zones, so a fourth zone is made to ask about it, then removed. */
await ev(`ui.screen="setup";ui.linkw=null;ui.mapw=null;ui.wiz=null;render()`); await sleep(40);
await ev(`document.querySelector("[data-addzone]").click()`); await sleep(90); await ev(`ui.wiz.name="Flower tent";render()`); await sleep(40);
await ev(`document.querySelector('[data-wiz="next"]').click()`); await sleep(90); await ev(`document.querySelector("[data-rapply]").click()`); await sleep(400);
await mOpen("flower_tent"); await ev(`ui.mapw.step=2;render()`); await sleep(30);
await tap('[data-mdevice="aux"]');
check("Share: a device in three other zones names all three in Overview's order", same(await shareAsk(), { ...DEHU_ASK, title: "Auxiliary dehumidifier", text: "This device is already associated to Zones: Garden, Veg, Nursery. Are you sure you want to duplicate it here?", more: "This means that controls are in sync in all of these zones. Automations from Garden, Veg and Nursery may affect the device state." }) && (await ev(`!ui.mapw.pickD.aux`)) === true, await shareAsk());
await shot("share-ask-three-zones-phone");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(60);
await shot("share-ask-three-zones-desktop");
await phone(390, 844);
await tap("[data-gkeep]");
await ev(`ui.mapw=null;ui.guide=null;ui.screen="setup";render()`); await sleep(40);
await ev(`document.querySelector('[data-rmzone="flower_tent"]').click()`); await sleep(60);
await ev(`(()=>{const i=document.querySelector("#dlg-confirm");i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))})();document.querySelector("[data-gdiscard]").click()`); await sleep(400);
check("Share: the zone made for that question is gone again", (await ev(`!zoneById("flower_tent")`)) === true && !(await diskZone("flower_tent")));
await reset();

// ---------- Tiles: tracks in one row line up
const trackTops = (id) => ev(`(()=>{ui.screen="zone";ui.zone="${id}";render();return [...document.querySelectorAll("#main .tiles .tile")].map(t=>{const r=t.getBoundingClientRect(),k=t.querySelector(".track");return {row:Math.round(r.top),top:k?Math.round(k.getBoundingClientRect().top*10)/10:null}}).filter(x=>x.top!==null)})()`);
const rowsLineUp = (tops) => Object.values(tops.reduce((a, x) => ((a[x.row] ||= []).push(x.top), a), {})).every((r) => r.every((t) => Math.abs(t - r[0]) < 0.6));
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await reset(); await sleep(60);
for (const i of [0, 1]) { const id = await ev(`zones[${i}].id`), tops = await trackTops(id); check(`Tiles desktop, zone ${i + 1}: all three tracks on one line`, tops.length === 3 && new Set(tops.map((x) => x.row)).size === 1 && rowsLineUp(tops), tops); }
await ev(`ui.screen="zone";ui.zone=zones[0].id;render()`); await sleep(60); await shot("tiles-aligned-desktop");
await phone(390, 844); await sleep(60);
for (const i of [0, 1]) { const id = await ev(`zones[${i}].id`), tops = await trackTops(id); check(`Tiles phone, zone ${i + 1}: tracks side by side line up`, tops.length === 3 && rowsLineUp(tops), tops); }
await ev(`ui.screen="zone";ui.zone=zones[0].id;render()`); await sleep(60); await shot("tiles-aligned-phone");
// ---------- The track
await phone(390, 844); await reset(); await sleep(60);
const parts = await ev(`(()=>{const t=document.querySelector("#main .zone-card .track"),box=(c)=>{const e=t.querySelector(c),r=e.getBoundingClientRect();return {l:r.left,r:r.right,bg:getComputedStyle(e).backgroundColor}};return {c:box(".bandc"),g:box(".bandr"),n:box(".bandi"),green:getComputedStyle(document.documentElement).getPropertyValue("--tnom"),w:{left:t.getBoundingClientRect().left,right:t.getBoundingClientRect().right}}})()`);
check("Track: red runs the full width", Math.abs(parts.c.l - parts.w.left) < 1 && Math.abs(parts.c.r - parts.w.right) < 1, parts);
check("Track: grey sits inside the red, with red showing both ends", parts.g.l > parts.c.l && parts.g.r < parts.c.r, parts);
check("Track: green sits inside the grey", parts.n.l >= parts.g.l && parts.n.r <= parts.g.r, parts);
check("Track: green, grey and red are three different colours", new Set([parts.c.bg, parts.g.bg, parts.n.bg]).size === 3, parts);
check("Track: green is green", (() => { const [r, g, b] = parts.n.bg.match(/\d+/g).map(Number); return g > r && g > b; })(), parts.n.bg);
check("Track: red is red", (() => { const [r, g, b] = parts.c.bg.match(/\d+/g).map(Number); return r > g && r > b; })(), parts.c.bg);
check("Track: grey is grey", (() => { const [r, g, b] = parts.g.bg.match(/\d+/g).map(Number); return r === g && g === b; })(), parts.g.bg);
const dotAt = await ev(`(()=>{const z=zones[0],out=[];for(const k of ["temperature","humidity","vpd"]){const [mn,,,,mx]=z.bands[period(z)][k],pad=(mx-mn)*0.35,a=mn-pad,b=mx+pad;out.push([z.now[k],parseFloat(track(z,k).match(/class="dot[^"]*" style="left:([0-9.]+)%/)[1]),((z.now[k]-a)/(b-a))*100])}return out})()`);
check("Track: each dot sits at the zone's combined reading", dotAt.every(([, got, wanted]) => Math.abs(got - wanted) < 0.01), dotAt);
const overview = await ev(`(()=>{const c=document.querySelector("#main .zone-card");return {text:c.textContent,rows:c.querySelectorAll(".mrow").length,tracks:c.querySelectorAll(".track").length}})()`);
check("Overview: a zone with several sensors says how they combine", overview.text.includes("Average of 3 sensors"), overview.text);
check("Overview: light is on the card, without a track", overview.rows === 4 && overview.tracks === 3, overview);
check("Overview: light shows the zone's combined reading", overview.text.includes(await ev(`fmt("light",zones[0].now.light)`)));
check("Overview: a one-sensor zone says nothing about combining", (await ev(`document.querySelectorAll("#main .zone-card")[1].querySelector(".zcombined")`)) === null);
check("Overview: zones count units, not pots", /\d+ units/.test(await ev(`ui.screen="zone";ui.zone=zones[0].id;render();const t=document.querySelector("#main").textContent;ui.screen="overview";render();t`)) && !/\bpots?\b/i.test(await ev(`document.documentElement.innerHTML`)));
await ev(`zones[0].combine={env:"highest"};render()`); await sleep(40);
check("Overview: the note names the environment method", (await ev(`document.querySelector("#main .zone-card").textContent`)).includes("Highest of 3 sensors"));
await ev(`zones[0].combine=undefined;render()`);
const spark = await ev(`(()=>{const row=[...document.querySelectorAll("#main .zone-card")[0].querySelectorAll(".mrow")].pop(),g=row.querySelector("svg.lspark"),tr=document.querySelector("#main .zone-card .track").getBoundingClientRect(),pill=document.querySelector("#main .zone-card .pillcell").getBoundingClientRect();if(!g)return null;const r=g.getBoundingClientRect();return {l:r.left,r:r.right,h:r.height,trl:tr.left,pillr:pill.right,label:g.getAttribute("aria-label"),stroke:g.querySelector("path:last-child").getAttribute("stroke")}})()`);
check("Overview: light has a short graph", spark && spark.h > 20 && spark.h <= 40, spark);
check("Overview: the light graph runs from the tracks' left edge to the pills' right edge", spark && Math.abs(spark.l - spark.trl) < 1 && Math.abs(spark.r - spark.pillr) < 1, spark);
check("Overview: the light graph is the 4 hour black to yellow line", spark && /last 4 hours/.test(spark.label) && spark.stroke.startsWith("url(#ls-"), spark);
check("Overview: the light graph covers 4 hours in 49 points, like the zone's light card", await ev(`(()=>{const d=(h)=>h.match(/<path d="([^"]+)" fill="none"/)[1].split(/[ML]/).filter(Boolean).length;return d(lightSpark(zones[0]))===49&&d(lightCards(zones[0]))===49})()`));
await ev(`window.__keep=zones[1].sensors.map(s=>s.avg);zones[1].sensors.forEach(s=>{if(s.kind==="env")s.avg=false});render()`); await sleep(40);
check("Overview: a zone with no light reading draws no light graph", (await ev(`document.querySelectorAll("#main .zone-card")[1].querySelectorAll("svg.lspark").length`)) === 0);
await ev(`zones[1].sensors.forEach((s,i)=>{s.avg=window.__keep[i]});render()`);

// ---------- A zone with no light sensor at all (#130): its sensors map no light entity, the shape the real-room build
// gives such a zone. No light sensor is not darkness, so no light value is drawn, while an offline one still says no data.
const zeroLx = (t) => /(^|[^\d,.])0 lx/.test(t);
const NL = `zones[1]`;
await ev(`window.__nl={lux:${NL}.sensors.map(s=>s.lux),limits:{...${NL}.lightLimits},history:${NL}.history};${NL}.sensors.forEach(s=>{if(s.kind==="env")s.lux=null});${NL}.lightLimits={dayMin:null,nightMax:null};${NL}.history={metric:"light",hours:24};refreshReadings();ui.screen="overview";render()`); await sleep(60);
const nlCard = await ev(`(()=>{const c=document.querySelectorAll("#main .zone-card")[1];return {text:c.textContent,rows:c.querySelectorAll(".mrow").length,spark:c.querySelectorAll("svg.lspark").length,lux:c.querySelectorAll(".lux").length,now:${NL}.now.light}})()`);
check("No light sensor: Overview draws no light row or line, and no lux on the day strip", nlCard.rows === 3 && nlCard.spark === 0 && nlCard.lux === 0 && !/\blx\b/.test(nlCard.text) && nlCard.now === null, nlCard);
check("No light sensor: the day strip still says lights on or off", /Lights (on|off)/.test(nlCard.text), nlCard.text);
const litCard = await ev(`(()=>{const c=document.querySelectorAll("#main .zone-card")[0];return {rows:c.querySelectorAll(".mrow").length,spark:c.querySelectorAll("svg.lspark").length}})()`);
check("No light sensor: a zone with light keeps its light row and line", litCard.rows === 4 && litCard.spark === 1, litCard);
check("No light sensor: Overview shows 0 lx nowhere for it", !zeroLx(nlCard.text), nlCard.text);
await ev(`document.querySelectorAll("#main .zone-card")[1].click()`); await sleep(120);
const nlZone = await ev(`(()=>{const m=document.querySelector("#main"),t=[...m.querySelectorAll(".tiles > .tile")].map(e=>e.getBoundingClientRect());return {text:m.textContent,lcards:m.querySelectorAll(".tiles .lcard, svg.lline").length,tiles:t.length,cols:t.map(r=>[Math.round(r.left),Math.round(r.width)]),chip:m.querySelectorAll('[data-metric="light"]').length,metric:ui.metric,chart:!!m.querySelector("#chart svg")}})()`);
const litCols = await ev(`(()=>{const was=ui.zone;ui.zone=zones[0].id;render();const c=[...document.querySelectorAll("#main .tiles > .tile")].map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.width)]});ui.zone=was;render();return c})()`);
check("No light sensor: the zone page has no light card, and its other tiles sit where a lit zone's do", nlZone.lcards === 0 && nlZone.tiles === 3 && JSON.stringify(nlZone.cols) === JSON.stringify(litCols), [nlZone.cols, litCols]);
check("No light sensor: History offers no Light chip, and a zone set to open on Light opens on Temperature", nlZone.chip === 0 && nlZone.metric === "temperature" && nlZone.chart, nlZone);
check("No light sensor: the zone page and History show 0 lx nowhere", !zeroLx(nlZone.text), nlZone.text.match(/.{30}0 lx.{10}/)?.[0]);
check("No light sensor: its sensors list no light entity", (await ev(`envOf(${NL}).every(s=>!deviceEntities(s).some(e=>e[2]==="illuminance"))`)) === true && (await ev(`envOf(zones[0]).every(s=>deviceEntities(s).some(e=>e[2]==="illuminance"))`)) === true);
await ev(`document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="'+${NL}.id+'"]').click()`); await sleep(80);
const nlView = await ev(`(()=>({text:document.querySelector("#main").textContent,rows:[...document.querySelectorAll(".tbl-wrap tr")].map(r=>r.textContent).filter(t=>t.startsWith("Light")).length,line:!!document.querySelector("#t-nolight")}))()`);
check("No light sensor: View targets has no light rows, and says why", nlView.rows === 0 && nlView.line && !zeroLx(nlView.text), nlView.rows);
await ev(`document.querySelector('[data-tset="'+${NL}.id+'"]').click()`); await sleep(80);
const nlEdit = await ev(`(()=>({text:document.querySelector("#main").textContent,box:document.querySelectorAll("#vin-light-0").length,line:!!document.querySelector("#vnolight"),issue:/Light limit/.test(document.querySelector("#main").textContent)}))()`);
check("No light sensor: Targets has no light limit box, says why, and raises no light problem", nlEdit.box === 0 && nlEdit.line && !nlEdit.issue && !zeroLx(nlEdit.text), nlEdit);
await ev(`document.querySelector("[data-tdexit]").click()`); await sleep(60);
await ev(`ui.screen="setup";render()`); await sleep(40);
check("No light sensor: History opens on offers it no Light, and shows it opening on Temperature", (await ev(`document.querySelectorAll('.opens-row [data-opens="'+${NL}.id+'"][data-ometric="light"]').length===0&&document.querySelector('.opens-row [data-opens="'+${NL}.id+'"][data-ometric="temperature"]').getAttribute("aria-pressed")==="true"&&document.querySelectorAll('.opens-row [data-opens="'+zones[0].id+'"][data-ometric="light"]').length===1`)) === true);
// An offline light sensor still exists: the card stays and says no data.
await ev(`${NL}.sensors.forEach((s,i)=>{s.lux=window.__nl.lux[i]});window.__nl.t=${NL}.sensors.map(s=>s.t);${NL}.sensors.forEach(s=>{if(s.kind==="env")s.t=null});refreshReadings();ui.screen="zone";ui.zone=${NL}.id;ui.metric="temperature";render()`); await sleep(80);
const offZone = await ev(`(()=>{const l=document.querySelector("#main .tiles .lcard");return {card:l?l.textContent:null,chip:document.querySelectorAll('#main [data-metric="light"]').length,text:document.querySelector("#main").textContent}})()`);
check("Offline light sensor: the zone keeps its light card, showing no data rather than 0", offZone.card !== null && offZone.card.includes("--") && offZone.chip === 1 && !zeroLx(offZone.text), offZone.card);
await ev(`${NL}.sensors.forEach((s,i)=>{s.t=window.__nl.t[i]});${NL}.lightLimits=window.__nl.limits;${NL}.history=window.__nl.history;refreshReadings();ui.screen="overview";render()`); await sleep(60);
await shot("overview-light-graph");
await phone(800, 1200); await sleep(60); await shot("overview-light-graph-foldable"); await phone(390, 844);

const setupOnly = async () => { await ev(`ui.sched=null;ui.td=null;ui.leafw=null;ui.vpdw=null;ui.td=null;ui.sched=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";render();window.scrollTo(0,0)`); await sleep(40); };
const cClick = async (sel) => { await ev(`document.querySelector('${sel}').click()`); await sleep(50); };

// ---------- Adding and naming a zone
await phone(390, 844); await setupOnly();
const wizNext = () => cClick(`[data-wiz="next"]`), nextOff = () => ev(`document.querySelector('[data-wiz="next"]').disabled`);
const zoneCount = await ev(`zones.length`);
await cClick("[data-addzone]");
check("Zone: Add zone asks for its name and a description first", (await ev(`ui.wiz.step===0 && !ui.wiz.id && document.querySelector("#main h1").textContent==="Add zone" && !!document.querySelector("#wiz-name") && !!document.querySelector("#wiz-desc")`)) === true);
check("Zone: a new zone is just that, with size and units later", (await ev(`!document.querySelector(".steps") && !document.querySelector("#wiz-w") && document.querySelector("#main").textContent.includes("Size and units come later")`)) === true);
check("Zone: no Next without a name", (await nextOff()) === true && (await ev(`document.querySelector("#wiz-name-fix").textContent`)).includes("Name this zone"));
await tap("#wiz-name-fix");
check("Zone: the link lands on the box", (await active()) === "wiz-name", await active());
await shot("addzone-phone");
await type("veg");
check("Zone: a name already taken is refused, whatever its case", (await nextOff()) === true && (await ev(`document.querySelector("#wiz-name-fix").textContent`)).includes("already a zone called veg"), await ev(`document.querySelector("#wiz-name-fix").textContent`));
check("Zone: typing keeps the keyboard open", (await active()) === "wiz-name", await active());
await ev(`document.querySelector("#wiz-name").value=""`); await type("   ");
check("Zone: spaces aren't a name", (await nextOff()) === true);
await ev(`document.querySelector("#wiz-name").value=""`); await type(`Flower <img src=x onerror="window.pwned=1"> 2`);
check("Zone: a good name opens Next", (await nextOff()) === false && (await ev(`!document.querySelector("#wiz-name-fix")`)) === true);
await cClick('[data-wiz="back"]');
check("Zone: Cancel asks, and a name can't run as code in that either", (await ev(`document.querySelector("#modal").textContent`)).includes("Discard unsaved changes?") && (await ev(`!document.querySelector("#modal img") && !window.pwned`)) === true, await ev(`document.querySelector("#modal").textContent`));
await cClick("[data-gdiscard]");
check("Zone: Cancel creates nothing", (await ev(`zones.length`)) === zoneCount && (await ev(`!ui.wiz`)) === true);
await cClick("[data-addzone]"); await tap("#wiz-name"); await type(`Flower <img src=x onerror="window.pwned=1"> 2`);
await tap("#wiz-desc"); await type("Flowering tent <b>bold</b>");
check("Zone: the description is kept as typed", (await ev(`ui.wiz.desc`)) === "Flowering tent <b>bold</b>", await ev(`ui.wiz.desc`));
check("Zone: it's one step, so Review and apply comes straight away", (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Review and apply");
check("Zone: nothing is created before saving", (await ev(`zones.length`)) === zoneCount);
await shot("addzone-details-phone");
await wizNext();
const newReview = await ev(`document.querySelector("#modal").textContent`);
check("Zone: the review lists its name and description, and says size comes later", newReview.includes("New zone") && newReview.includes("Flowering tent <b>bold</b>") && !newReview.includes("Grid") && newReview.includes("until you set its layout"), newReview);
check("Zone: a name or description can't run as code in the review", (await ev(`!document.querySelector("#modal img, #modal b b") && !window.pwned`)) === true);
await cClick("[data-rapply]"); await sleep(60);
const newId = await ev(`zones.at(-1).id`);
const guideRows = () => ev(`[...document.querySelectorAll("#main .task")].map(t=>t.id+(t.getAttribute("aria-current")?"*":"")+":"+[...t.querySelectorAll(".pill")].map(p=>p.textContent).join("/"))`);
check("Zone: saving creates it and opens its setup, one step at a time", (await ev(`zones.length`)) === zoneCount + 1 && (await ev(`ui.screen==="setup" && !!ui.guide && ui.guide.id===zones.at(-1).id && document.querySelector("#main h1").textContent.startsWith("Set up Flower <img")`)) === true);
check("Zone: the guide runs in the order of a first setup, details done and devices next", same(await guideRows(), ["g-details:Done", "g-devices*:", "g-layout:", "g-place:Needs sensors from Device identification", "g-calibrate:Needs sensors from Device identification", "g-targets:"]), await guideRows());
const zeroed = (z) => ["day", "night"].every((p) => ["temperature", "humidity", "vpd"].every((k) => z.bands[p][k].every((v) => v === 0))) && z.lightLimits.dayMin === 0 && z.lightLimits.nightMax === 0 && z.dayAt === 0 && z.nightAt === 0;
check("Zone: a new zone starts at 0, every limit day and night, both light limits and both times", (await ev(`(${zeroed})(zoneById("${newId}"))`)) === true && (await onHA(`(${zeroed})(JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${newId}"))`)) === true, await ev(`JSON.stringify([zoneById("${newId}").bands.day, zoneById("${newId}").lightLimits, zoneById("${newId}").dayAt, zoneById("${newId}").nightAt])`));
check("Zone: it's saved straight away, description and all", (await onHA(`(JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${newId}")||{}).description`)) === "Flowering tent <b>bold</b>");
check("Zone: it's in the page menu", (await menuItems()).some((t) => t.startsWith("Flower <img")));
await shot("newzone-guide-phone");
await cClick('[data-glater="layout"]'); await sleep(120);
check("Zone: a step can wait, and that's saved too", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${newId}").setup.layout`)) === "later" && (await guideRows())[2] === "g-layout:Later", await guideRows());
await cClick("[data-gfinish]");
check("Zone: Finish for now lands on the zone, which says what's left", (await ev(`ui.screen==="zone" && ui.zone==="${newId}" && !ui.guide`)) === true && (await ev(`document.querySelector("#main [data-guide]").textContent`)).includes("Device identification, Zone layout, Device placement, Sensor Calibration, Targets, day and night"), await ev(`document.querySelector("#main [data-guide]")?.textContent`));
check("Zone: its page shows the description, as text", (await ev(`document.querySelector("#main .zdesc")?.textContent`)) === "Flowering tent <b>bold</b>" && (await ev(`!document.querySelector("#main .zdesc b")`)) === true);
const newScreens = [];
for (const [e, name] of [[`ui.mapw=null;ui.screen="overview";render()`, "overview"], [`ui.screen="zone";ui.zone="${newId}";render()`, "zone"], [`ui.screen="devices";render()`, "devices"], [`ui.screen="setup";render()`, "setup"], [`openVpd("${newId}");render()`, "targets"], [`ui.vpdw=null;ui.td=null;ui.sched=null;render()`, "setup again"]]) {
  await ev(e); await sleep(60);
  if (/NaN|undefined/.test(await ev(`document.querySelector("#main").textContent`))) newScreens.push(name);
}
check("Zone: a zone with no sensors shows no NaN anywhere", newScreens.length === 0, newScreens);
check("Zone: a name can't run as code", (await ev(`window.pwned === undefined && !document.querySelector("#main img")`)) === true);
check("Zone: Continue setup stays on the row, and the menu follows the setup order, Sensor Calibration included, as the panel always lists it", same(await rowButtons(newId), ["Continue setup"]) && same(await setupButtons(newId), ["Zone details", "Device identification", "Zone layout", "Device placement", "Sensor Calibration", "Targets, day and night", "Automations", "Remove zone"]), await setupButtons(newId));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40);
check("Zone: no leaf link with no sensors to set", (await ev(`document.querySelectorAll("#main .tile [data-calw]").length`)) === 0);
await ev(`ui.screen="overview";render()`); await sleep(40);
check("Zone: its Overview card says it isn't set up, and gives no band", (await ev(`[...document.querySelectorAll("#main .zone-card")].find(c=>c.dataset.zone==="${newId}").querySelector(".card-head").textContent`)) === (await ev(`zoneById("${newId}").name`)) + "Not set up", await ev(`[...document.querySelectorAll("#main .zone-card")].find(c=>c.dataset.zone==="${newId}").querySelector(".card-head").textContent`));
check("Zone: and holds no button of its own, since the card is one", (await ev(`[...document.querySelectorAll("#main .zone-card")].find(c=>c.dataset.zone==="${newId}").querySelectorAll("button").length`)) === 0 && (await ev(`[...document.querySelectorAll("#main .zone-card")].find(c=>c.dataset.zone==="${newId}").textContent.includes("Day and night not set up")`)) === true);
check("Zone: an empty zone isn't reported as a problem", !(await ev(`document.querySelector("#main .notice")?.textContent || ""`)).includes("Flower"), await ev(`document.querySelector("#main .notice")?.textContent`));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40); await shot("newzone-phone");
await cClick("#main [data-guide]");
check("Zone: Continue setup goes back to the guide", (await ev(`ui.screen==="setup" && ui.guide.id==="${newId}"`)) === true);
await cClick("#g-devices [data-mapw]");
await ev(`document.querySelector('[data-msensor="x-spare"]').click()`); await sleep(40);
await ev(`Object.assign(ui.mapw.choice["x-spare"],{temperature:"a",humidity:"a",vpd:"a",light:"a"});render()`); await sleep(40);
for (let i = 0; i < 2; i++) { await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(50); }
check("Zone: mapping can finish for a new zone", (await ev(`!document.querySelector('[data-mstep="next"]').disabled`)) === true, await ev(`document.querySelector("#main").textContent.slice(0,300)`));
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
await ev(`document.querySelector("[data-rapply]")?.click()`); await sleep(200);
check("Zone: applying Device identification from the guide stays on its last step, with Finish to go on (#156)", (await ev(`!!ui.mapw && ui.mapw.step===3 && !!ui.guide && document.querySelector('[data-mstep="next"]').textContent==="Finish" && zoneById("${newId}").setup.devices==="done"`)) === true, await ev(`[!!ui.mapw, ui.mapw && ui.mapw.step, document.querySelector('[data-mstep="next"]')?.textContent]`));
await cClick('[data-mstep="next"]'); await sleep(60);
check("Zone: then Finish goes back to the guide, done, with Placement next past the layout left for later", same(await guideRows(), ["g-details:Done", "g-devices:Done", "g-layout:Later", "g-place*:", "g-calibrate:", "g-targets:"]) && (await ev(`!ui.mapw`)) === true, await guideRows());
await cClick("#g-layout [data-layout]");
check("Zone: Zone layout is size then units, under its own name", same(await ev(`[...document.querySelectorAll(".steps li")].map(e=>e.textContent)`), ["1. Size", "2. Units and labels"]) && (await ev(`document.querySelector("#main h1").textContent`)).startsWith("Zone layout: Flower") && (await ev(`!document.querySelector("#wiz-name")`)) === true);
await ev(`ui.wiz.w=2.4;render()`); await sleep(30); await wizNext();
await ev(`ui.wiz.units=6;ui.wiz.rows=2;ui.wiz.cols=3;render()`); await sleep(30);
check("Zone: a sensor not placed yet doesn't drag the layout onto the map", (await ev(`document.querySelectorAll(".steps li").length`)) === 2 && (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Review and apply");
await wizNext();
const layoutReview = await ev(`document.querySelector("#modal").textContent`);
check("Zone: the layout review lists size, units and grid", ["Size", "Units", "Grid"].every((w) => layoutReview.includes(w)) && !layoutReview.includes("Zone name"), layoutReview);
await cClick("[data-rapply]"); await sleep(200);
check("Zone: applying the layout from the guide stays on its last step, with Finish to go on (#156)", (await ev(`!!ui.wiz && ui.wiz.flow[0]===1 && ui.wiz.step===2 && document.querySelector('[data-wiz="next"]').textContent==="Finish"`)) === true, await ev(`[!!ui.wiz, ui.wiz && ui.wiz.step, document.querySelector('[data-wiz="next"]')?.textContent]`));
await wizNext(); await sleep(60);
check("Zone: then Finish takes the layout back to the guide, done", (await guideRows())[2] === "g-layout:Done" && (await ev(`zoneById("${newId}").layout.units`)) === 6, await guideRows());
await cClick("#g-place [data-wizard]");
check("Zone: Place sensors opens on the map, on the sensor", (await ev(`!!ui.wiz && ui.wiz.step===3 && ui.wiz.pick==="x-spare" && !document.querySelector(".steps")`)) === true);
await ev(`document.querySelector('[data-spot="0,0"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`); await sleep(40);
await wizNext(); await cClick("[data-rapply]"); await sleep(200);
check("Zone: applying Placement from the guide stays on the map (#156)", (await ev(`!!ui.wiz && ui.wiz.step===3 && !!ui.guide && document.querySelector('[data-wiz="next"]').textContent==="Finish"`)) === true, await ev(`[!!ui.wiz, ui.wiz && ui.wiz.step]`));
await cClick('[data-wiz="back"]'); await sleep(60);
check("Zone: and Back from it goes back to the guide too", (await ev(`ui.screen==="setup" && !!ui.guide && zoneById("${newId}").sensors[0].pos.join()==="0,0"`)) === true && (await guideRows())[3] === "g-place:Done", await guideRows());
check("Zone: its reading now shows", (await ev(`zoneById("${newId}").now.temperature`)) === 22);
check("Zone: a sensor new to Environment Control with nowhere to hold an offset starts at 0", (await ev(`zoneById("${newId}").sensors[0].leaf`)) === 0, await ev(`zoneById("${newId}").sensors[0].leaf`));
await cClick("#g-targets [data-vpd]"); await sleep(60);
check("Zone: Targets says it isn't confirmed, and Confirm stays off while its 0s can't be used", (await ev(`document.querySelector("#confirm-note")?.textContent || ""`)).startsWith("Not confirmed yet.") && (await ev(`document.querySelector("[data-confirmstep]").disabled && !document.querySelector("[data-confirmstep]").hidden`)) === true && (await ev(`document.querySelector("#s-issues").textContent`)).includes("two different times"), await ev(`[document.querySelector("#confirm-note")?.textContent, document.querySelector("[data-confirmstep]")?.disabled, document.querySelector("#s-issues").textContent]`));
await cClick("[data-tdexit]"); await sleep(200);
check("Zone: going through Targets without confirming leaves it to do", (await guideRows())[5] === "g-targets:" && (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${newId}").setup.targets`)) === "todo", await guideRows());
await cClick("[data-gfinish]"); await sleep(40);
check("Zone: its page says it isn't set up, and what's left to confirm", (await ev(`document.querySelector("#main [data-guide]").textContent`)).includes("Not set up yet. Still to confirm: Sensor Calibration, Targets, day and night."), await ev(`document.querySelector("#main [data-guide]")?.textContent`));
check("Zone: a reading isn't judged against limits nobody has set, and its track isn't red", (await ev(`(()=>{const i=document.createElement("i");i.style.background="var(--tcrit)";document.body.append(i);const crit=getComputedStyle(i).backgroundColor;i.remove();return [...document.querySelectorAll("#main .tile")].slice(0,3).every(t=>t.textContent.includes("Targets not set up yet") && !t.querySelector(".pill.critlow,.pill.crithigh,.range") && getComputedStyle(t.querySelector(".track .bandc")).backgroundColor !== crit)})()`)) === true && (await ev(`document.querySelector("#main .period").textContent`)).includes("Day and night not set up"), await ev(`document.querySelector("#main .tile").textContent`));
await ev(`ui.screen="overview";render()`); await sleep(40);
check("Zone: and isn't reported as critical on Overview", !(await ev(`[...document.querySelectorAll("#main .notice")].map(n=>n.textContent).join()`)).includes("Flower"), await ev(`[...document.querySelectorAll("#main .notice")].map(n=>n.textContent).join()`));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40);
await ev(`ui.wiz=null;ui.guide=null;ui.screen="setup";render()`); await sleep(40);
check("Zone: Sensor Calibration appears once it has sensors, in its place", same(await rowButtons(newId), ["Continue setup"]) && same(await setupButtons(newId), ["Zone details", "Device identification", "Zone layout", "Device placement", "Sensor Calibration", "Targets, day and night", "Automations", "Remove zone"]), await setupButtons(newId));
check("Zone: its Setup row says it isn't set up", (await ev(`document.querySelector('[data-zmenu="${newId}"]').closest(".task").querySelector("strong + .pill")?.textContent`)) === "Not set up");
await ev(`document.querySelector('[data-guide="${newId}"]').click()`); await sleep(50);
await cClick("#g-calibrate [data-calw]"); await sleep(40);
check("Zone: Sensor Calibration shows the new offset at 0, and asks to be confirmed", (await ev(`document.querySelector("#lin-x-spare").value`)) === "0.0" && (await ev(`document.querySelector("#confirm-note")?.textContent || ""`)).startsWith("Not confirmed yet.") && (await ev(`!document.querySelector("[data-confirmstep]").disabled`)) === true, await ev(`[document.querySelector("#lin-x-spare")?.value, document.querySelector("#confirm-note")?.textContent]`));
await cClick("[data-lexit]"); await sleep(200);
check("Zone: leaving Sensor Calibration without confirming leaves it to do", (await guideRows())[4] === "g-calibrate*:", await guideRows());
await cClick("#g-calibrate [data-calw]"); await sleep(40);
await cClick("[data-confirmstep]"); await sleep(200);
check("Zone: Confirm counts it as done with nothing changed, and goes back to the guide", (await guideRows())[4] === "g-calibrate:Done" && (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="${newId}").setup.calibrate`)) === "done", await guideRows());
await cClick("#g-targets [data-vpd]"); await sleep(60);
await ev(`ui.sched.vals.day="06:00";ui.sched.vals.night="18:00";render()`); await sleep(40);
await cClick('[data-vstage="veg"]'); await sleep(60);
check("Zone: with changes open, applying them is how Targets is confirmed", (await ev(`document.querySelector("#pagebar").hidden && !document.querySelector("#draftbar").hidden && !document.querySelector("[data-dreview]").disabled`)) === true, await ev(`[document.querySelector("[data-confirmstep]")?.hidden, document.querySelector("#draftbar").hidden, document.querySelector("#td-issues").textContent, document.querySelector("#v-issues")?.textContent]`));
await cClick("[data-dreview]"); await cClick("[data-rapply]"); await sleep(400);
check("Zone: applying Targets from the guide stays on Targets, counted as done, with no Confirm left (#156)", (await ev(`!!ui.td && !!ui.guide && zoneById("${newId}").setup.targets==="done" && !document.querySelector("[data-confirmstep]") && document.querySelector("#draftbar").hidden`)) === true, await ev(`[!!ui.td, zoneById("${newId}").setup.targets]`));
await cClick("[data-tdexit]"); await sleep(100);
check("Zone: then Back goes to the guide, where Targets is done, and finishes setup", (await guideRows())[5] === "g-targets:Done" && (await ev(`document.querySelector("[data-gfinish]").textContent`)) === "Done", await guideRows());
await ev(`ui.wiz=null;ui.guide=null;ui.screen="setup";render()`); await sleep(40);
check("Zone: once every step is confirmed it's set up: no mark and no Continue setup", same(await rowButtons(newId), []) && (await ev(`!document.querySelector('[data-zmenu="${newId}"]').closest(".task").querySelector("strong + .pill")`)) === true, await rowButtons(newId));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40);
check("Zone: and its readings are judged against what was confirmed", (await ev(`!document.querySelector("#main [data-guide]") && document.querySelectorAll("#main .tile .range").length === 3`)) === true);
await ev(`ui.screen="setup";render()`); await sleep(40);
await ev(`document.querySelector('[data-details="veg"]').click()`); await sleep(40);
check("Zone: an existing zone's Zone details can rename it", (await ev(`document.querySelector("#wiz-name").value`)) === "Veg" && (await nextOff()) === false && (await ev(`document.querySelector("#main h1").textContent`)) === "Zone details");
await tap("#wiz-name"); await type("Veg north"); await wizNext(); await cClick("[data-rapply]");
check("Zone: renaming keeps its id and everything on it", (await ev(`zoneById("veg").name`)) === "Veg north" && (await ev(`zoneById("veg").sensors.length`)) > 0 && (await menuItems()).includes("Veg north"));
await ev(`ui.screen="setup";ui.wiz=null;openWizard("garden",[1,2]);ui.wiz.step=2;ui.wiz.units=1;ui.wiz.rows=1;ui.wiz.cols=1;render()`); await sleep(40);
check("Zone: a layout that strands a placed sensor carries on to the map", same(await ev(`[...document.querySelectorAll(".steps li")].map(e=>e.textContent)`), ["1. Size", "2. Units and labels", "3. Sensors and devices"]) && (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Next", await ev(`[...document.querySelectorAll(".steps li")].map(e=>e.textContent)`));
await wizNext();
check("Zone: and opens on what it stranded", (await ev(`ui.wiz.step===3 && !!ui.wiz.pick && ui.wiz.sensors.some(s=>s.id===ui.wiz.pick)`)) === true);
await ev(`window.__garden=JSON.stringify({z:zoneById("garden"),p:devices.map(d=>d.place||null)});stranded(ui.wiz).forEach(s=>{s.pos=[0,0]});render()`); await sleep(40);
await wizNext(); await cClick("[data-rapply]"); await sleep(200);
check("Zone: applied from the map it carried on to, the layout stays on that step, with Finish to go on (#156)", (await ev(`!!ui.wiz && ui.wiz.flow[0]===1 && ui.wiz.step===3 && zoneById("garden").layout.units===1 && document.querySelectorAll(".steps li").length===3 && document.querySelector('[data-wiz="next"]').textContent==="Finish"`)) === true, await ev(`[!!ui.wiz, ui.wiz && ui.wiz.step, document.querySelector('[data-wiz="next"]')?.textContent]`));
await ev(`(()=>{const g=JSON.parse(window.__garden);Object.assign(zoneById("garden"),g.z);devices.forEach((d,i)=>{if(g.p[i])d.place=g.p[i];else delete d.place});return saveConfig(()=>{})})()`); await sleep(100);
await ev(`ui.wiz=null;render()`);
await ev(`ui.guide=null;zoneById("${newId}").sensors=[];ui.screen="setup";openWizard("${newId}");render()`); await sleep(40);
check("Zone: Placement with nothing to place offers Device identification", (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Device identification", await ev(`document.querySelector('[data-wiz="next"]').textContent`));
await wizNext(); await sleep(40);
await ev(`document.querySelector('[data-msensor="x-spare"]').click()`); await sleep(40);
await ev(`Object.assign(ui.mapw.choice["x-spare"],{temperature:"a",humidity:"a",vpd:"a",light:"a"});render()`); await sleep(40);
for (let i = 0; i < 2; i++) { await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(50); }
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
await ev(`document.querySelector("[data-rapply]")?.click()`); await sleep(200);
check("Zone: sent from Placement, applying Device identification still carries on to Placement, on the sensor to place", (await ev(`!ui.mapw && !!ui.wiz && ui.wiz.id==="${newId}" && ui.wiz.step===3 && ui.wiz.pick==="x-spare"`)) === true, await ev(`[!!ui.mapw, !!ui.wiz, ui.wiz && ui.wiz.step, ui.wiz && ui.wiz.pick]`));
await ev(`ui.wiz=null;render()`);
await ev(`zoneById("veg").name="Veg";zones.pop();devices.forEach(d=>{d.zones=d.zones.filter(id=>id!=="${newId}")});ui.zone="garden";render()`);

await phone(390, 844); await reset(); await goTab("Garden"); await shot("controls-phone");
await ev(`window.scrollTo(0,520)`); await shot("controls-phone-2");
await sleep(60); await shot("zone-phone");
await openL(); await sleep(60); await shot("leaf-phone");
await boardSilent("number.environment_right_leaf_temperature_offset", true); await tap("#lin-g-right"); await type("1.5"); await key("Enter", 13); await leafSave(GIVE_UP);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await shot("leaf-phone-dark"); await send("Emulation.setEmulatedMedia", { features: [] });
await reset();

// Confirm edits: nothing moves until it's reviewed and applied, as PHASE does it
await phone(390, 844);
const modalText = () => ev(`document.querySelector("#modal").textContent`);
const modalOpen = () => ev(`!document.querySelector("#modal").hidden`);
const barOn = () => ev(`!document.querySelector("#draftbar").hidden`);
const toastNow = () => ev(`(()=>{const t=document.querySelector("#toast");return t && !t.hidden ? t.textContent : ""})()`);
const clearToast = () => ev(`(()=>{const t=document.querySelector("#toast");if(t){t.hidden=true;t.textContent=""}})()`);
const barText = () => ev(`document.querySelector("#draftbar").textContent`);
const reviewBtn = () => ev(`document.querySelector("[data-dreview]").disabled`);
const openT = async (id) => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.leafw=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";openVpd("${id}");render();window.scrollTo(0,0)`); await sleep(50); };
await boardSilent("number.environment_right_leaf_temperature_offset", false); await boardSet([["number.environment_left_leaf_temperature_offset", -1], ["number.environment_right_leaf_temperature_offset", -1]]); await ev(`leafSends.length=0;zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5;zones[0].leafBasis=undefined`);
await openL();
check("Confirm: no bar until something changes", (await barOn()) === false);
await tap("#lin-g-left"); await type("1.6"); await key("Enter", 13); await sleep(80);
check("Confirm: one change names itself", (await barOn()) === true && (await barText()).includes("Garden · Environment left leaf temperature offset"), await barText());
check("Confirm: it says nothing changes until you apply", (await barText()).includes("nothing changes until you apply"), await barText());
await shot("confirm-bar-phone");
await tap("#lin-g-right"); await type("2"); await key("Enter", 13); await sleep(80);
check("Confirm: more changes are counted", (await barText()).includes("2 unsaved changes"), await barText());
check("Confirm: nothing has moved yet", (await board("g-left")) === -1 && (await sends()).length === 0);
await clickIt("[data-dreview]");
const review = await modalText();
check("Confirm: the review shows before and after", review.includes("Review changes") && review.includes("Environment left leaf temperature offset") && review.includes("1.0 °C below air") && review.includes("1.6 °C below air"), review);
check("Confirm: it counts what it will apply", (await ev(`document.querySelector("[data-rapply]").textContent`)) === "Apply 2 changes");
check("Confirm: it says what follows", review.includes("follows straight away"), review);
check("Confirm: opening it sends nothing", (await sends()).length === 0);
check("Confirm: the page behind can't be reached", (await ev(`document.querySelector("#main").inert`)) === true);
check("Confirm: focus lands in it", (await active()) === "dlg-title", await active());
await shot("confirm-review-phone");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await shot("confirm-review-dark"); await send("Emulation.setEmulatedMedia", { features: [] });
await clickIt("[data-rback]");
check("Confirm: Back to editing keeps your edits", (await modalOpen()) === false && (await ev(`document.querySelector("#lin-g-left").value`)) === "1.6" && (await barOn()) === true);
await clickIt("[data-dreview]"); await key("Escape", 27); await sleep(40);
check("Confirm: Escape closes it", (await modalOpen()) === false);
await clickIt("[data-dreview]"); await ev(`document.querySelector("#modal").click()`); await sleep(40);
check("Confirm: tapping outside closes it", (await modalOpen()) === false);
await clickIt("[data-dreview]"); await clickIt("[data-rapply]");
check("Confirm: it verifies before closing", (await modalText()).includes("Applying and verifying") && (await ev(`document.querySelector("[data-rapply]").disabled && document.querySelector("[data-rback]").disabled`)) === true, await modalText());
await key("Escape", 27); await ev(`document.querySelector("#modal").click()`); await sleep(40);
check("Confirm: it can't be closed mid send", (await modalOpen()) === true);
await sleep(ACK);
check("Confirm: it closes once the boards report", (await modalOpen()) === false && (await board("g-left")) === -1.6 && (await board("g-right")) === -2, [await modalOpen(), await board("g-right"), await modalText(), await sends()]);
check("Confirm: only then is the draft gone", (await barOn()) === false);
await boardSet([["number.environment_left_leaf_temperature_offset", -1], ["number.environment_right_leaf_temperature_offset", -1]]); await ev(`leafSends.length=0`);
await openL(); await tap("#lin-g-left"); await type("1.6"); await key("Enter", 13); await sleep(80);
await clickIt("[data-ddiscard]");
check("Confirm: Discard goes back to what's saved", (await barOn()) === false && (await ev(`document.querySelector("#lin-g-left").value`)) === "1.0" && (await sends()).length === 0, await ev(`document.querySelector("#lin-g-left").value`));
await tap("#lin-g-under"); await type("2"); await key("Enter", 13); await sleep(80);
await goTab("Overview"); await sleep(60);
check("Confirm: a tab asks before dropping a draft", (await modalText()).includes("Discard unsaved changes?") && (await modalText()).includes("1 unsaved change in Garden") && (await ev(`ui.screen`)) === "setup", await modalText());
await shot("confirm-guard-phone");
await clickIt("[data-gkeep]");
check("Confirm: Keep editing stays with the edit", (await ev(`!!ui.leafw && document.querySelector("#lin-g-under").value`)) === "2.0");
await clickIt("[data-lexit]");
check("Confirm: Back asks too", (await modalText()).includes("Discard unsaved changes?") && (await ev(`!!ui.leafw`)) === true, await modalText());
await clickIt("[data-gdiscard]");
check("Confirm: Discard and continue goes where you were going", (await ev(`!ui.leafw`)) === true && (await saved("g-under")) === -0.5);
await openL(); await clickIt("[data-lexit]");
check("Confirm: Back with nothing changed doesn't ask", (await modalOpen()) === false && (await ev(`!ui.leafw`)) === true);

await openT("nursery"); const tDay = await ev(`ui.vpdw.period`), tNight = tDay === "day" ? "night" : "day", tName = tDay === "day" ? "Day" : "Night", tOther = tDay === "day" ? "Night" : "Day";
await tap("#vin-temperature-2"); await type(String((await band("temperature", 2)) + 0.5)); await key("Enter", 13); await sleep(80);
await clickIt("[data-dreview]");
check("Targets: a side effect is in the review too", (await modalText()).includes(`${tName} Temperature Target`) && (await modalText()).includes(`${tName} VPD Target`), await modalText());
await clickIt("[data-rback]"); await clickIt("[data-ddiscard]");
check("Targets: Discard drops it", (await barOn()) === false);
await tap('[data-vstage="bulk"]'); await sleep(60);
await ev(`ui.vpdw.bands["${tNight}"].temperature[4]=${await ev(`ui.vpdw.bands["${tNight}"].temperature[4]`)}+1;render()`); await sleep(40);
await clickIt("[data-dreview]");
const tCount = await ev(`vpdDraft(ui.vpdw).items.length`);
check("Targets: both periods are listed", (await modalText()).includes(`${tOther} Temperature Max`) && (await modalText()).includes(`${tName} Temperature Low`) && (await ev(`document.querySelectorAll("#review-items .review-row").length`)) === tCount, await modalText());
await phone(320, 640); await sleep(120);
const fit = await ev(`(()=>{const d=document.querySelector(".dialog").getBoundingClientRect(),a=document.querySelector("[data-rapply]").getBoundingClientRect(),l=document.querySelector(".review-scroll");return {fits:d.top>=0&&d.bottom<=innerHeight,apply:a.bottom<=innerHeight,scrolls:l.scrollHeight>l.clientHeight}})()`);
check("Targets: a long review fits a small phone and scrolls", fit.fits && fit.apply && fit.scrolls, fit);
await shot("confirm-long-phone");
await phone(390, 844); await clickIt("[data-rapply]");
check("Targets: Apply stores them and stays on the page, nothing left to apply (#156)", (await modalOpen()) === false && (await ev(`!!ui.vpdw && !!ui.td && ui.td.m.id==="nursery" && ui.screen==="setup" && !!document.querySelector("#vwrap") && vpdDraft(ui.vpdw).items.length===0`)) === true && (await barOn()) === false, await ev(`[!!ui.td, ui.screen]`));
check("Targets: focus lands on the page's heading", (await ev(`document.activeElement===document.querySelector("#main h1")`)) === true, await ev(`document.activeElement.outerHTML.slice(0,80)`));
await clickIt("[data-tdexit]");
check("Targets: then Back goes to Setup, where it was opened, without asking", (await modalOpen()) === false && (await ev(`!ui.td && !ui.vpdw && ui.screen==="setup"`)) === true, await ev(`[!!ui.td, ui.screen]`));
await openT("nursery");
await ev(`ui.vpdw.bands["${tNight}"].humidity[4]=1;render()`); await sleep(40);
check("Targets: a problem in the other period blocks the review", (await reviewBtn()) === true && (await barText()).includes(`fix ${tOther} before review`), await barText());
check("Targets: the reason shows on a phone", (await ev(`getComputedStyle(document.querySelector("#draft-why")).display`)) !== "none");
check("Targets: and the notice leads to it", (await ev(`document.querySelector("#v-issues").textContent`)).includes(`${tOther} has a value to fix`), await ev(`document.querySelector("#v-issues").textContent`));
await clickIt(`#v-issues [data-vperiod="${tNight}"]`);
check("Targets: tapping it opens that period", (await ev(`ui.vpdw.period`)) === tNight);
await clickIt("[data-ddiscard]");
await openT("garden"); await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[0]-=1;ui.vpdw.bands[ui.vpdw.period].temperature[1]-=0.5;render()`); await sleep(40);
await clickIt("[data-dreview]");
check("Linked: a value on a helper is applied there, and the review says so", (await modalText()).includes("Temperature Min, on your helper") && (await modalText()).includes("follows straight away") && (await ev(`document.querySelector("[data-rapply]").textContent`)) === "Apply 2 changes" && (await ev(`!document.querySelector(".review-list.preview")`)) === true, await modalText());
const lp = await ev(`ui.vpdw.period`), minBefore = await ev(`zones[0].bands["${lp}"].temperature[0]`), minWant = await ev(`ui.vpdw.bands["${lp}"].temperature[0]`), lowWant = await ev(`ui.vpdw.bands["${lp}"].temperature[1]`);
const minHelper = `input_number.garden_${lp}_temperature_min_threshold`;
await clickIt("[data-rapply]"); await sleep(ACK);
check("Linked: the Min goes to its helper through the host, and the Low is saved here", (await ev(`zones[0].bands["${lp}"].temperature[0]`)) === minWant && (await ev(`zones[0].bands["${lp}"].temperature[1]`)) === lowWant && (await helperCalls()).at(-1) === `${minHelper}=${minWant}` && (await ev(`!!ui.vpdw && !ui.review && vpdDraft(ui.vpdw).items.length===0`)) === true, [await helperCalls(), await ev(`ui.review && ui.review.errors`)]);
await haSet([[minHelper, minBefore]]);
await openT("garden"); await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[0]=${minBefore}-0.05;render()`); await sleep(40);
check("Linked: a value the helper can't take is a problem before review, not a refusal after", (await ev(`document.querySelector("#v-issues").textContent`)).includes("Temperature Min goes to your helper, which takes -20 to 50 in steps of 0.1") && (await reviewBtn()) === true, await ev(`document.querySelector("#v-issues").textContent`));
await clickIt("[data-ddiscard]");
await boardSilent(minHelper, true);
await openT("garden"); await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[0]-=1;render()`); await sleep(40);
await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(GIVE_UP);
check("Linked: a helper that doesn't report keeps the review open and says what it still holds", ((await ev(`ui.review && ui.review.errors`)) || []).some((e) => e.includes("Temperature Min: not confirmed. Your helper still reports")), await ev(`ui.review && ui.review.errors`));
await boardSilent(minHelper, false); await ev(`ui.review=null;renderModal()`); await clickIt("[data-ddiscard]");

await openT("nursery"); await tap("#vin-temperature-2"); await type("23.5"); await key("Enter", 13); await sleep(80);
await clickIt("[data-calw]");
await tap("#lin-n-env"); await type("1.5"); await key("Enter", 13); await sleep(80);
await clickIt("[data-lexit]");
check("Round trip: Back from offsets only names the offsets", (await modalText()).includes("1 unsaved change in Nursery"), await modalText());
await clickIt("[data-gdiscard]");
check("Round trip: the chart's draft survives", (await ev(`!!ui.vpdw && !ui.leafw`)) === true && (await barOn()) === true, await barText());
await clickIt("[data-calw]");
await tap("#lin-n-env"); await type("1.5"); await key("Enter", 13); await sleep(80);
await leafSave();
check("Round trip: applying the offsets stays on Sensor Calibration, the saved value showing and nothing left to apply (#156)", (await modalOpen()) === false && (await ev(`!!ui.leafw && ui.leafw.id==="nursery" && document.querySelector("#lin-n-env").value==="1.5" && leafDraft(ui.leafw).items.length===0`)) === true, await ev(`[!!ui.leafw, document.querySelector("#lin-n-env")?.value]`));
await clickIt("[data-lexit]");
check("Round trip: then Back goes to the chart without asking, its own draft intact", (await modalOpen()) === false && (await ev(`!ui.leafw && !!ui.vpdw && !!document.querySelector("#vwrap") && vpdDraft(ui.vpdw).items.some(i=>/Temperature Target/.test(i.label))`)) === true && (await barOn()) === true, await ev(`[!!ui.leafw, !!ui.vpdw, vpdDraft(ui.vpdw).items.map(i=>i.label)]`));
await goTab("Overview"); await sleep(60);
check("Round trip: a tab still asks about it", (await modalText()).includes("Discard unsaved changes?"), await modalText());
await clickIt("[data-gdiscard]");

await ev(`ui.screen="setup";ui.wiz=null;openWizard("veg");render()`); await sleep(40);
check("Placement: nothing changed just finishes", (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Finish", await ev(`document.querySelector('[data-wiz="next"]').textContent`));
await clickIt('[data-wiz="next"]');
check("Placement: without a review", (await modalOpen()) === false && (await ev(`!ui.wiz`)) === true);
await ev(`ui.screen="setup";openWizard("veg",[0]);ui.wiz.name="Veg two";render()`); await sleep(40);
await clickIt('[data-wiz="back"]');
check("Zone details: Cancel asks once something changed", (await modalText()).includes("Discard unsaved changes?") && (await ev(`!!ui.wiz`)) === true, await modalText());
await clickIt("[data-gkeep]"); await clickIt('[data-wiz="next"]');
check("Zone details: the review lists the name and nothing else", /Zone name.*Veg two/.test(await modalText()) && !(await modalText()).includes("position"), await modalText());
check("Zone details: nothing's saved yet", (await ev(`zones[1].name`)) === "Veg");
await clearToast(); await clickIt("[data-rapply]");
check("Zone details: Apply saves it", (await ev(`zones[1].name`)) === "Veg two");
check("Zone details: and stays on the step, the saved name in its box, with Finish as the last button (#156)", (await modalOpen()) === false && (await ev(`!!ui.wiz && ui.wiz.id==="veg" && ui.wiz.step===0 && ui.screen==="setup" && document.querySelector("#wiz-name").value==="Veg two" && document.querySelector('[data-wiz="next"]').textContent==="Finish" && wizDraft(ui.wiz).items.length===0`)) === true && (await toastNow()) === "Zone details saved.", await ev(`[!!ui.wiz, ui.wiz && ui.wiz.step, document.querySelector('[data-wiz="next"]')?.textContent]`));
check("Zone details: focus lands on Finish", (await ev(`document.activeElement===document.querySelector('[data-wiz="next"]')`)) === true, await ev(`document.activeElement.outerHTML.slice(0,80)`));
await clearToast(); await clickIt('[data-wiz="next"]');
check("Zone details: then Finish leaves for the zone, without asking or saying nothing changed", (await modalOpen()) === false && (await ev(`!ui.wiz && ui.screen==="zone" && ui.zone==="veg"`)) === true && (await toastNow()) === "", await ev(`[!!ui.wiz, ui.screen, document.querySelector("#toast").textContent]`));
await ev(`ui.screen="setup";openWizard("veg");ui.wiz.sensors[0].level="under";ui.wiz.sensors[0].pos=[0,0];render()`); await sleep(40);
await clickIt('[data-wiz="next"]');
check("Placement: the review lists spot and height", (await modalText()).includes("Veg environment position") && (await modalText()).includes("Veg environment height") && !(await modalText()).includes("Zone name"), await modalText());
await clickIt("[data-rapply]");
check("Placement: Apply saves it", (await ev(`zones[1].sensors[0].level`)) === "under");
check("Placement: and stays on the step, on the sensor it was placing, with Finish as the last button (#156)", (await modalOpen()) === false && (await ev(`!!ui.wiz && ui.wiz.step===3 && ui.wiz.sensors[0].level==="under" && document.querySelector('[data-wiz="next"]').textContent==="Finish" && wizDraft(ui.wiz).items.length===0`)) === true, await ev(`[!!ui.wiz, ui.wiz && ui.wiz.step, document.querySelector('[data-wiz="next"]')?.textContent]`));
await clickIt('[data-wiz="back"]');
check("Placement: then Back leaves without asking", (await modalOpen()) === false && (await ev(`!ui.wiz && ui.screen==="setup"`)) === true, await ev(`[!!ui.wiz, ui.screen]`));
await ev(`zones[1].name="Veg";zones[1].sensors[0].level="above";zones[1].sensors[0].pos=[0.5,0.5]`);

await ev(`ui.screen="setup";ui.wiz=null;openMap("veg");render()`); await sleep(40);
for (let i = 0; i < 2; i++) await clickIt('[data-mstep="next"]');
check("Map: nothing changed just finishes", (await ev(`document.querySelector('[data-mstep="next"]').textContent`)) === "Finish", await ev(`document.querySelector('[data-mstep="next"]').textContent`));
await clickIt('[data-mstep="next"]');
check("Map: without a review", (await modalOpen()) === false && (await ev(`!ui.mapw`)) === true);
const wasLinked = await ev(`zones[1].linked`);
const wasCombine = await ev(`methodOf(zones[1])`);
await ev(`openMap("veg");ui.mapw.combine.env=${JSON.stringify(wasCombine)}==="median"?"average":"median";ui.mapw.step=3;render()`); await sleep(40);
await clickIt('[data-mstep="next"]');
check("Map: the review lists what moved", (await modalText()).includes("combine by") && (await ev(`methodOf(zones[1])`)) === wasCombine, await modalText());
check("Map: it's sensors and devices only now, with day, night and limits on their own page", same(await ev(`MAP_STEPS`), ["Sensors", "Devices", "Check"]) && !(await modalText()).includes("Limits"));
await clickIt("[data-rback]"); await ev(`ui.mapw.step=1;render()`); await sleep(40);
await clickIt('[data-mstep="back"]');
check("Map: Cancel asks once something changed", (await modalText()).includes("Discard unsaved changes?"), await modalText());
await clickIt("[data-gdiscard]");
check("Map: discarding keeps what was saved", (await ev(`!ui.mapw`)) === true && (await ev(`methodOf(zones[1])`)) === wasCombine);
const otherCombine = wasCombine === "median" ? "average" : "median";
await ev(`ui.screen="setup";openMap("veg");ui.mapw.combine.env="${otherCombine}";ui.mapw.step=3;render()`); await sleep(40);
await clickIt('[data-mstep="next"]'); await clearToast(); await clickIt("[data-rapply]"); await sleep(100);
check("Map: Apply saves it and stays on the Check step, with Finish as the last button (#156)", (await modalOpen()) === false && (await ev(`methodOf(zones[1])`)) === otherCombine && (await ev(`!!ui.mapw && ui.mapw.step===3 && ui.screen==="setup" && document.querySelector('[data-mstep="next"]').textContent==="Finish" && mapDraft(ui.mapw).items.length===0`)) === true && (await toastNow()) === "Mapping saved.", await ev(`[!!ui.mapw, ui.mapw && ui.mapw.step, document.querySelector('[data-mstep="next"]')?.textContent]`));
await clearToast(); await clickIt('[data-mstep="next"]');
check("Map: then Finish leaves without asking or saying nothing changed", (await modalOpen()) === false && (await ev(`!ui.mapw && ui.screen==="setup"`)) === true && (await toastNow()) === "", await ev(`[!!ui.mapw, ui.screen]`));
await ev(`saveConfig(()=>{const z=zoneById("veg");if(${JSON.stringify(wasCombine)}==="mean"){if(z.combine){delete z.combine.env;if(!Object.keys(z.combine).length)delete z.combine}}else z.combine={...(z.combine||{}),env:${JSON.stringify(wasCombine)}}})`); await sleep(100);

for (const [w, h, name] of [[390, 844, "phone"], [320, 640, "small phone"], [844, 390, "landscape"]]) {
  await phone(w, h); await openL(); await tap("#lin-g-left"); await type("1.6"); await key("Enter", 13); await sleep(100);
  const b = await ev(`(()=>{const r=document.querySelector("#draftbar").getBoundingClientRect(),o=[...document.querySelectorAll("#draftbar button")].map(x=>x.getBoundingClientRect());window.scrollTo(0,1e6);const back=document.querySelector("[data-lexit]").getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,tall:o.every(x=>x.height>=44),scroll:document.documentElement.scrollWidth<=innerWidth,clear:back.bottom<=document.querySelector("#draftbar").getBoundingClientRect().top,clipped:document.querySelector("#draftbar").scrollWidth>document.querySelector("#draftbar").clientWidth}})()`);
  check(`Bar: fits at ${name}`, b.inside && b.tall && b.scroll && !b.clipped, b);
  check(`Bar: never covers the end of the page at ${name}`, b.clear, b);
}
await phone(390, 844); await openL(); await tap("#lin-g-left"); await type("1.6"); await key("Enter", 13); await sleep(100);
await tap("#lin-g-right"); await sleep(420);
check("Bar: gets out of the way of the keyboard", (await ev(`getComputedStyle(document.querySelector("#draftbar")).display`)) === "none");
await key("Enter", 13); await sleep(120);
check("Bar: comes back after", (await ev(`getComputedStyle(document.querySelector("#draftbar")).display`)) !== "none", await ev(`document.body.className`));
await ev(`toast("Testing the toast")`); await sleep(300);
const toastBox = `(()=>{const t=document.querySelector("#toast"),r=t.getBoundingClientRect(),b=document.querySelector("#draftbar").getBoundingClientRect(),pe=t.style.pointerEvents;t.style.pointerEvents="auto";const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);t.style.pointerEvents=pe;return {shown:!t.hidden,top:r.top,bottom:r.bottom,h:innerHeight,clear:r.bottom<=b.top,onTop:!!hit&&t.contains(hit)}})()`;
let tb = await ev(toastBox);
check("Bar: the toast drops in at the top of the view, nowhere near the bar", tb.shown && tb.top >= 0 && tb.bottom <= tb.h / 4 && tb.clear && tb.onTop, tb);
await tap("[data-dreview]"); await sleep(150); await ev(`toast("Testing the toast over a dialog")`); await sleep(300); tb = await ev(toastBox);
check("Bar: and it shows over an open dialog", (await ev(`!document.querySelector("#modal").hidden`)) && tb.shown && tb.top >= 0 && tb.onTop, tb);
check("Bar: a tap where the toast lies goes through to the page under it", (await ev(`(()=>{const t=document.querySelector("#toast"),r=t.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !t.hidden&&!!hit&&!t.contains(hit)})()`)) === true);
check("Bar: the toast is a quiet surface, not the inverted ink", (await ev(`(()=>{const c=getComputedStyle(document.querySelector("#toast")),b=getComputedStyle(document.body);return c.backgroundColor!==b.color&&c.color!==b.backgroundColor})()`)) === true);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); await ev(`toast("Testing the toast still")`);
check("Bar: with reduced motion the toast appears without sliding", (await ev(`getComputedStyle(document.querySelector("#toast")).animationName`)) === "none");
await send("Emulation.setEmulatedMedia", { features: [] });
await ev(`ui.review=null;ui.guard=null;ui.leafw=null;render()`);
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await openL(); await tap("#lin-g-left"); await type("1.6"); await key("Enter", 13); await sleep(100); await shot("confirm-bar-desktop");
await clickIt("[data-dreview]"); await shot("confirm-review-desktop"); await reset();

await phone(390, 844); await open(); await shot("vpd-phone");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await open(); await shot("vpd-phone-dark");
await send("Emulation.setEmulatedMedia", { features: [] });
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await open(); await sleep(60);
await ev(`window.scrollTo(0,0);document.querySelector("#vin-vpd-1").focus({preventScroll:true})`); await sleep(150);
check("desktop: focusing a box doesn't move the page or add space", (await ev(`window.scrollY`)) === 0 && !(await ev(`document.body.classList.contains("vtyping")`)), await ev(`window.scrollY`));
await ev(`document.activeElement.blur()`);
const wide = await ev(`({clipped:[...document.querySelectorAll("[data-vin]")].filter(i=>i.scrollWidth>i.clientWidth).map(i=>i.id), size:getComputedStyle(document.querySelector("[data-vin]")).fontSize})`);
check("desktop: no box clips its number", wide.clipped.length === 0, wide);
await shot("vpd-desktop");
/* #159: the selected limit is the one in the accent colour; the others are grey, in every group. */
const vLook = () => ev(`(()=>{const c=(v)=>{const p=document.createElement("i");p.style.color=v;document.body.appendChild(p);const x=getComputedStyle(p).color;p.remove();return x},prim=c("var(--primary)"),onp=c("var(--on-primary)");return {flags:[...document.querySelectorAll("#vwrap [data-vflag]")].map(g=>({slot:Number(g.dataset.vflag),fill:getComputedStyle(g.querySelector("rect")).fill,text:getComputedStyle(g.querySelector("text")).fill})),accent:[...document.querySelectorAll("#vwrap line, #vwrap path, #vwrap circle")].filter(l=>getComputedStyle(l).stroke===prim).length,prim,onp}})()`);
for (const k of ["temperature", "humidity", "vpd"]) {
  await open(); await ev(`ui.vpdw.edit="${k}";ui.vpdw.sel=3;vSync()`);
  const lk = await vLook(), mine = lk.flags.filter((f) => f.slot === 3), rest = lk.flags.filter((f) => f.slot !== 3);
  check(`Chart colours, ${k}: the selected label is filled in the accent colour with its text colour, the other three grey, and its line is in the accent`, mine.length === 1 && mine[0].fill === lk.prim && mine[0].text === lk.onp && rest.length === 3 && rest.every((f) => f.fill !== lk.prim && f.text !== lk.onp) && lk.accent >= 1, lk);
}
await open(); await ev(`ui.vpdw.edit="temperature";ui.vpdw.sel=null;vSync()`);
const lkNone = await vLook();
check("Chart colours: with nothing selected no label or line is in the accent", lkNone.flags.length === 4 && lkNone.flags.every((f) => f.fill !== lkNone.prim) && lkNone.accent === 0, lkNone);
await open(); await ev(`ui.vpdw.edit="target";vSync()`);
check("Chart colours: on Target the circle is drawn in the accent", (await vLook()).accent >= 1, await vLook());
/* #159: the axes fit the zone's limits. The stakeholder's case first: temperature Min 13, Low 16, High 21, Max 21. */
const vAxisNow = () => ev(`(()=>{const w=document.querySelector("#vwrap");w.scrollIntoView({block:"center"});const svg=w.querySelector("svg"),r=svg.getBoundingClientRect(),g=vGeom(),sc=r.width/g.W,pos={};for(const l of svg.querySelectorAll("[data-vline]"))pos[l.dataset.vline]=l.tagName==="path"?l.getAttribute("d").length:l.dataset.vline.startsWith("temperature")?Number(l.getAttribute("x1")):Number(l.getAttribute("y1"));return {pos,L:g.L+g.cw/2,R:g.right-g.cw/2,T:g.T+g.ch/2,B:g.bottom-g.ch/2,ticks:[...svg.querySelectorAll("[data-vtick]")].map(t=>Number(t.dataset.vtick)),rh:[...svg.querySelectorAll("text")].filter(t=>t.textContent.endsWith("%")).map(t=>Number(t.textContent.slice(0,-1))),cells:svg.querySelectorAll("g[opacity] > rect").length,left:r.left,top:r.top,sc,band:ui.vpdw.bands[ui.vpdw.period].temperature.slice()}})()`);
const vPlace = async (temps) => { await ev(`(()=>{const z=zones[0],p=typeof period==="function"?period(z):"day";window.__bandsWas=window.__bandsWas||JSON.stringify(z.bands);z.bands[p].temperature=${JSON.stringify(temps)}})()`); await open(); await ev(`ui.vpdw.edit="temperature";ui.vpdw.sel=null;vSync()`); };
const vRestore = () => ev(`(()=>{if(window.__bandsWas)zones[0].bands=JSON.parse(window.__bandsWas);window.__bandsWas=null})()`);
/* Presses at a chart point (in the chart's own units), moves to another, and reads the axis while still held. */
const vDrag = async (x0, y0, x1, y1) => {
  const a = await vAxisNow(), at = (x, y) => ({ x: a.left + x * a.sc, y: a.top + y * a.sc });
  const p = at(x0, y0), q = at(x1, y1);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }); await sleep(40);
  const down = await vAxisNow();
  for (let n = 1; n <= 4; n++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + ((q.x - p.x) * n) / 4, y: p.y + ((q.y - p.y) * n) / 4, button: "left", buttons: 1 }); await sleep(20); }
  const held = await vAxisNow();
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: q.x, y: q.y, button: "left", clickCount: 1 }); await sleep(80);
  return { down, held, up: await vAxisNow() };
};
await vPlace([13, 16, 18.5, 21, 21]);
let ax = await vAxisNow(), tp = ax.pos;
check("Axes, Min 13 Low 16 High 21 Max 21: every temperature line has its own place inside the plot, none on an edge, Min left of Low, High and Max one line", ["temperature:0", "temperature:1", "temperature:3", "temperature:4"].every((id) => tp[id] > ax.L && tp[id] < ax.R) && tp["temperature:0"] < tp["temperature:1"] && tp["temperature:1"] < tp["temperature:3"] && tp["temperature:3"] === tp["temperature:4"], ax);
check("Axes, Min 13 Low 16 High 21 Max 21: the VPD lines and the Target are on the chart too", [0, 1, 3, 4].every((i) => tp[`vpd:${i}`] > 0) && (await ev(`(()=>{const c=document.querySelector("#vwrap circle"),g=vGeom(),b=ui.vpdw.bands[ui.vpdw.period];return Math.abs(Number(c.getAttribute("cx"))-g.X(b.temperature[2]))<0.01&&Math.abs(Number(c.getAttribute("cy"))-g.Y(b.humidity[2]))<0.01})()`)), ax);
await shot("vpd-axes-tight-temperature");
/* Max selected on the shared High/Max line: a press there drags Max, not High. */
await ev(`ui.vpdw.sel=4;vSync()`); ax = await vAxisNow();
let dr = await vDrag(ax.pos["temperature:4"], (ax.T + ax.B) / 2, ax.pos["temperature:4"] + 2 * (await ev(`vGeom().cw`)), (ax.T + ax.B) / 2);
check("Grab: with Max selected, a press on the coinciding High/Max line moves Max and leaves High", dr.up.band[4] > 21 && dr.up.band[3] === 21 && (await ev(`ui.vpdw.sel`)) === 4, dr.up.band);
await vPlace([13, 16, 18.5, 21, 21]); await ev(`ui.vpdw.sel=3;vSync()`); ax = await vAxisNow();
dr = await vDrag(ax.pos["temperature:3"], (ax.T + ax.B) / 2, ax.pos["temperature:3"] - 2 * (await ev(`vGeom().cw`)), (ax.T + ax.B) / 2);
check("Grab: with High selected, the same press moves High and leaves Max", dr.up.band[3] < 21 && dr.up.band[4] === 21 && (await ev(`ui.vpdw.sel`)) === 3, dr.up.band);
await vPlace([13, 16, 18.5, 21, 21]); ax = await vAxisNow();
dr = await vDrag(ax.pos["temperature:4"], (ax.T + ax.B) / 2, ax.pos["temperature:4"], (ax.T + ax.B) / 2);
check("Grab: with neither selected, a press on the High/Max line takes the outer one, Max", (await ev(`ui.vpdw.sel`)) === 4, await ev(`ui.vpdw.sel`));
/* Dragged to the right edge and past it: the axis holds still until release, the line stops at the edge, then the axis makes room. */
await vPlace([13, 16, 18.5, 21, 21]); ax = await vAxisNow();
dr = await vDrag(ax.pos["temperature:4"], (ax.T + ax.B) / 2, ax.R + 200, (ax.T + ax.B) / 2);
const edgeHi = dr.down.ticks.at(-1);
check("Drag: the axis doesn't change between pressing and letting go, the line stopping at the chart's edge", JSON.stringify(dr.down.ticks) === JSON.stringify(dr.held.ticks) && dr.down.cells === dr.held.cells && Math.abs(dr.held.pos["temperature:4"] - dr.held.R) < 0.5, dr);
check("Drag: once let go near the edge the axis makes room, so the line has space past it", JSON.stringify(dr.up.ticks) !== JSON.stringify(dr.held.ticks) && dr.up.pos["temperature:4"] < dr.up.R - 1 && dr.up.ticks.at(-1) > edgeHi, [dr.held.ticks, dr.up.ticks, dr.up.band]);
await ev(`ui.vpdw.edit="temperature";ui.vpdw.sel=4;vSync()`); const maxWas = await band("temperature", 4);
await tap("#vnudge [data-vnudge='1']");
check("Drag: from there + goes on a step at a time", (await band("temperature", 4)) === maxWas + 0.5, await band("temperature", 4));
/* Ordinary limits: round labels, and about as many cells as the fixed 16 to 34 by 30 to 90 grid had (19 by 13). */
await vRestore(); await open(); ax = await vAxisNow();
const cols = ax.ticks.length, rows = ax.rh.length;
check("Axes, ordinary limits: whole even temperature labels, humidity in fives, and a grid of about the same number of cells as before", ax.ticks.every((t) => Number.isInteger(t) && t % 2 === 0) && ax.rh.every((r) => r % 5 === 0) && ax.cells >= 19 * 13 && ax.cells <= 26 * 17 && rows >= 13 && rows <= 17, { ticks: ax.ticks, rh: ax.rh, cells: ax.cells });
await ev(`ui.vpdw.edit="temperature";ui.vpdw.sel=null;vSync()`); await shot("vpd-axes-ordinary-temperature");
await ev(`ui.vpdw.edit="humidity";ui.vpdw.sel=3;vSync()`); await shot("vpd-axes-ordinary-humidity");
const dayTicks = (await vAxisNow()).ticks;
await ev(`(()=>{const v=ui.vpdw,o=v.period==="day"?"night":"day";v.bands[o].temperature=[8,10,null,14,15];v.bands[o].temperature[2]=v.bands[o].temperature[2]})()`);
await ev(`document.querySelector("[data-vperiod]:not([aria-pressed=true])").click()`); await sleep(60);
const nightAx = await vAxisNow();
check("Axes: switching period refits them to that period's limits", JSON.stringify(nightAx.ticks) !== JSON.stringify(dayTicks) && nightAx.pos["temperature:0"] > nightAx.L, [dayTicks, nightAx.ticks]);
await open();
/* The leaf offset the chart is drawn at sits with the chart, at its left, as a button rather than a caption off to the side. */
const leafSpot = () => ev(`(()=>{const b=document.querySelector("#td-targets [data-calw]");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect(),t=b.previousElementSibling.getBoundingClientRect(),c=document.querySelector("#td-targets").getBoundingClientRect(),svg=document.querySelector("#vwrap svg").getBoundingClientRect(),g=vGeom(),gridTop=svg.top+(g.T*svg.height)/g.H;return {left:Math.min(t.left,r.left)-c.left,afterText:r.left-t.right<=16||r.top>=t.bottom-1,third:c.width/3,gap:gridTop-r.bottom,h:r.height,name:b.getAttribute("aria-label"),text:b.parentElement.textContent,cls:b.className}})()`);
for (const w of [1280, 900, 500]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await open(); await sleep(60);
  const ls = await leafSpot();
  check(`Leaf offset, ${w}px: the line and its button start at the left of the Targets card, right above the chart's grid, named for what it changes`, ls.left >= 0 && ls.left < ls.third && ls.afterText && ls.gap >= 0 && ls.gap <= 80 && ls.name === "Change the leaf temperature offset" && /^Leaf .*air/.test(ls.text) && ls.cls.split(" ").includes("btn"), ls);
}
await phone(500, 900); await open(); await sleep(60);
check("Leaf offset, phone: the button is at least 40px high to tap", (await leafSpot()).h >= 40, await leafSpot());
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await open(); await sleep(60);
await reset(); await goTab("Garden"); await shot("controls-desktop");
await openL(); await sleep(60); await shot("leaf-desktop"); await reset();
// ---------- The history chart
await phone(390, 844); await reset(); await goTab("Garden"); await sleep(60);
const rangeBtn = async (h) => { await ev(`document.querySelector('[data-range="${h}"]').click()`); await sleep(60); };
const metricBtn = async (k) => { await ev(`document.querySelector('[data-metric="${k}"]').click()`); await sleep(60); };
const chartText = () => ev(`document.querySelector("#chart-stats").textContent`);
check("Chart: the four ranges", same(await ev(`[...document.querySelectorAll("[data-range]")].map(b=>b.textContent)`), ["6h", "24h", "72h", "7d"]), await ev(`[...document.querySelectorAll("[data-range]")].map(b=>b.textContent)`));
check("Chart: a row for the combined reading and one per sensor", same(await ev(`[...document.querySelectorAll(".cstats tbody td:first-child")].map(c=>c.textContent)`), ["Average", "Env left", "Env right", "Env under"]));
check("Chart: columns are Now, Min and Max", same(await ev(`[...document.querySelectorAll(".cstats thead th")].slice(1).map(c=>c.textContent)`), ["Now", "Min", "Max"]));
for (const k of ["temperature", "humidity", "vpd", "light"]) {
  await metricBtn(k);
  const mins = [];
  for (const h of [6, 24, 72, 168]) {
    await rangeBtn(h);
    const r = await ev(`(()=>{const c=chartNow,rows=c.rows.map(x=>({now:x.line[c.n].v,...chartStats(x.line)}));return {rows,tile:fmt("${k}",zones[0].now.${k}),shown:document.querySelector("#cs-v0").textContent}})()`);
    check(`Chart ${k} ${h}h: Now is the tile's reading`, r.shown === r.tile, [r.shown, r.tile]);
    check(`Chart ${k} ${h}h: every line's Now sits inside its Min and Max`, r.rows.every((x) => x.min.v <= x.now + 1e-9 && x.max.v >= x.now - 1e-9), r.rows);
    check(`Chart ${k} ${h}h: clean`, !/NaN|undefined/.test(await chartText()));
    if (k !== "light") mins.push((await ev(`document.querySelector('.cstats td[data-cs="min"]').textContent`)));
  }
  if (k !== "light") check(`Chart ${k}: Min follows the range`, new Set(mins).size > 1, mins);
}
await metricBtn("light"); await rangeBtn(24);
check("Chart: light shows Now only, on any range", same(await ev(`[...document.querySelectorAll(".cstats thead th")].slice(1).map(c=>c.textContent)`), ["Now"]) && (await ev(`document.querySelectorAll("[data-cs]").length`)) === 0, await chartText());
await ev(`chartAt(3)`); await sleep(20);
check("Chart: light still reads a point on hover", (await ev(`document.querySelector("#cs-at").textContent`)) !== "Now", await ev(`document.querySelector("#cs-at").textContent`));
await ev(`chartAt(null)`); await sleep(20);
check("Chart: and goes back to Now", (await ev(`document.querySelector("#cs-at").textContent`)) === "Now");
check("Chart: light has no band and doesn't claim one", (await ev(`!document.querySelector('#chart [fill="var(--ideal)"]') && !document.querySelector("#chart-key").textContent.includes("Ideal")`)) === true, await ev(`document.querySelector("#chart-key").textContent`));
check("Chart: light's axis never goes below zero", (await ev(`[...document.querySelectorAll("#chart text")].every(x=>!x.textContent.startsWith("-"))`)) === true, await ev(`[...document.querySelectorAll("#chart text")].map(x=>x.textContent)`));
await ev(`ui.zone="veg";render()`); await sleep(50);
check("Chart: a dim zone's axis doesn't round to the same label", await ev(`(()=>{const y=[...document.querySelectorAll("#chart text")].filter(x=>x.getAttribute("text-anchor")==="end"&&+x.getAttribute("x")<50).map(x=>x.textContent);return new Set(y).size===y.length})()`), await ev(`[...document.querySelectorAll("#chart text")].map(x=>x.textContent)`));
await ev(`ui.zone="garden";render()`); await sleep(50);
await metricBtn("vpd");
check("Chart: VPD keeps its band", (await ev(`!!document.querySelector('#chart [fill="var(--ideal)"]') && document.querySelector("#chart-key").textContent.includes("Ideal")`)) === true);
await ev(`document.querySelector("#chart").scrollIntoView({block:"center"})`); await sleep(80);
const chartBox = await ev(`(()=>{const r=document.querySelector("#chart svg").getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
const nowText = await ev(`document.querySelector("#cs-v0").textContent`), minText = await ev(`document.querySelector('.cstats td[data-cs="min"]').textContent`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chartBox.x + chartBox.w * 0.4, y: chartBox.y + chartBox.h * 0.5 }); await sleep(80);
const hover = await ev(`(()=>{const c=chartNow;return {at:document.querySelector("#cs-at").textContent,want:hhmm(c.rows[0].line[c.at].t),cell:document.querySelector("#cs-v0").textContent,value:fmt(c.k,c.rows[0].line[c.at].v),line:!!document.querySelector("#chart-hover line"),dots:document.querySelectorAll("#chart-hover circle").length,rows:c.rows.length}})()`);
check("Chart: hovering reads that time", hover.at === hover.want && hover.at !== "Now", hover);
check("Chart: and each line's value there", hover.cell === hover.value, hover);
check("Chart: with a line and a dot on each series", hover.line && hover.dots === hover.rows, hover);
check("Chart: Min stays the whole window's", (await ev(`document.querySelector('.cstats td[data-cs="min"]').textContent`)) === minText);
await shot("chart-hover-phone");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chartBox.x + 4, y: chartBox.y + chartBox.h + 80 }); await sleep(80);
check("Chart: leaving goes back to now", (await ev(`document.querySelector("#cs-at").textContent`)) === "Now" && (await ev(`document.querySelector("#cs-v0").textContent`)) === nowText && (await ev(`!document.querySelector("#chart-hover line")`)) === true);
await ev(`document.querySelector("#chart svg").focus({preventScroll:true})`); await key("ArrowLeft", 37); await key("ArrowLeft", 37); await sleep(40);
check("Chart: the arrow keys read it too", (await ev(`chartNow.at===chartNow.n-2`)) === true, await ev(`chartNow.at`));
await key("Escape", 27); await sleep(40);
check("Chart: Escape goes back to now", (await ev(`chartNow.at===null`)) === true);
await rangeBtn(168);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chartBox.x + chartBox.w * 0.5, y: chartBox.y + chartBox.h * 0.5 }); await sleep(80);
check("Chart: past a day it names the day", /^[A-Z][a-z]{2} \d+ \d\d:\d\d$/.test(await ev(`document.querySelector("#cs-at").textContent`)), await ev(`document.querySelector("#cs-at").textContent`));
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chartBox.x + 4, y: chartBox.y + chartBox.h + 80 }); await sleep(40);
await ev(`zones[0].sensors[1].t=null;zones[0].sensors[1].h=null;render()`); await sleep(60);
const deadRow = await ev(`[...document.querySelectorAll(".cstats tbody tr")].map(r=>r.children[1].textContent)`);
check("Chart: a dead sensor reads --, never 0", deadRow[2] === "--", deadRow);
check("Chart: and the combined line still matches the tile", deadRow[0] === (await ev(`fmt("vpd",zones[0].now.vpd)`)), deadRow);
await ev(`zones[0].sensors[1].t=27;zones[0].sensors[1].h=62.6;ui.range=24;render()`);
await ev(`ACTIVITY.garden=ACTIVITY.garden;const s=envOf(zones[0])[0];window.fourth={...s,id:"g-4",name:"Fourth",short:"Fourth"};zones[0].sensors.push(window.fourth);render()`); await sleep(60);
check("Chart: more than three sensors all show", (await ev(`document.querySelectorAll(".cstats tbody tr").length`)) === 5 && !/NaN|undefined/.test(await chartText()), await chartText());
await ev(`zones[0].sensors.pop();render()`);
for (const [w, h] of [[390, 844], [320, 640]]) {
  await phone(w, h); await reset(); await goTab("Garden"); await rangeBtn(168); await sleep(60);
  check(`Chart ${w}px: no sideways scroll on 7d`, await ev(`document.documentElement.scrollWidth<=innerWidth`), await ev(`document.documentElement.scrollWidth`));
}
await phone(390, 844); await ev(`ui.range=24;ui.metric="vpd";render();document.querySelector("#chart").scrollIntoView({block:"start"})`); await shot("chart-phone");
/* The stakeholder, #104: the plot sits evenly in the card, with no more room left of the axis numbers than they need. */
const chartInsets = () => ev(`(()=>{const svg=document.querySelector("#chart svg"),card=svg.closest(".card"),cs=getComputedStyle(card),cr=card.getBoundingClientRect();
  const inL=cr.left+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth),inR=cr.right-parseFloat(cs.paddingRight)-parseFloat(cs.borderRightWidth);
  const box=(els)=>{let l=1e9,r=-1e9;for(const e of els){const b=e.getBoundingClientRect();if(!b.width&&!b.height)continue;l=Math.min(l,b.left);r=Math.max(r,b.right);}return {l,r};};
  const all=box(svg.querySelectorAll(":scope > *:not(#chart-hover)"));chartAt(0);const h0=box(svg.querySelectorAll("#chart-hover *"));chartAt(chartNow.n);const h1=box(svg.querySelectorAll("#chart-hover *"));chartAt(null);
  return {left:+(all.l-inL).toFixed(1),right:+(inR-all.r).toFixed(1),hoverL:+(h0.l-inL).toFixed(1),hoverR:+(inR-h1.r).toFixed(1)};})()`);
for (const [w, h, mobile] of [[1280, 900, false], [500, 900, true]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }); await reset(); await goTab("Garden");
  for (const k of ["temperature", "humidity", "vpd", "light"]) for (const r of [6, 24, 72, 168]) {
    await ev(`ui.metric="${k}";ui.range=${r};render()`); await sleep(40);
    const m = await chartInsets();
    check(`Chart ${w}px ${k} ${r}h: as much room left of the axis numbers as right of the plot`, Math.abs(m.left - m.right) <= 2 && m.left >= 0 && m.right >= 0 && m.left <= 8, m);
    check(`Chart ${w}px ${k} ${r}h: the hover line and dots stay inside the card at both ends`, m.hoverL >= 0 && m.hoverR >= 0, m);
  }
}
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await reset(); await goTab("Garden");
await ev(`ui.metric="temperature";ui.range=24;render();document.querySelector("#chart").closest(".card").scrollIntoView({block:"start"})`); await shot("chart-history-desktop");
await phone(390, 844);

// ---------- Lights in Controls
await reset(); await goTab("Garden");
check("Lights: last group, beside the light reading", (await ev(`[...document.querySelectorAll("[data-cgroup]")].at(-1).dataset.cgroup`)) === "Lights" && (await ev(`document.querySelector('[data-cgroup="Lights"] .ctl-reading').textContent`)).includes("lx"));
check("Lights: a controller shows its brightness", (await ev(`[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][0].textContent`)).includes("On, 60%") && (await ev(`document.querySelector('[data-cgroup="Lights"] .dev input[type=range]').value`)) === "60");
check("Lights: an off controller shows no stale brightness and no slider", await ev(`(()=>{ui.zone="veg";render();const d=[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][0];return !/\d%/.test(d.textContent)&&d.textContent.includes("Off")&&!!d.querySelector("input[type=range]")})()`));
check("Lights: shared lights name who shares them", (await ev(`[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][1].textContent`)).includes("Shared with Nursery"));
await ev(`ui.zone="garden";render()`); await sleep(40);
await shot("lights-phone");
await ev(`ui.screen="setup";openMap("garden");ui.mapw.step=2;render()`); await sleep(40);
await plugRole("Light"); await goTab("Garden");
check("Lights: a plug marked Light joins them", (await groupNames()).includes("Plug 7"), await groupNames());
await ev(`devices.find(d=>d.id==="plug").type=null;render()`);
await ev(`openMap("garden");ui.mapw.step=2;render()`); await sleep(40);
check("Lights: Map devices lists them and offers Light as a type", (await ev(`!!document.querySelector('[data-mdevice="lc-over"]') && !!document.querySelector('[data-mrole="lc-over"][value="Light"]')`)) === true);
await ev(`ui.mapw=null;render()`);

// ---------- Day and night
await phone(390, 844); await reset(); await setupOnly();
const setBox = async (k, v) => { await ev(`(()=>{const e=document.querySelector("#sin-${k}");e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(40); };
const schedOpen = async (id) => { await setupOnly(); await clickIt(`[data-vpd="${id}"]`); };
const schedModal = () => ev(`document.querySelector("#modal").textContent`);
const schedSent = () => ev(`schedSends.length`);
await schedOpen("garden");
check("Sched: opens on the zone's times", (await ev(`document.querySelector("#sin-day").value+document.querySelector("#sin-night").value`)) === "07:0019:00");
check("Sched: it's a v1 page, with nothing marked as coming later", !/Coming|Preview/.test(await ev(`document.querySelector(".sched-title").textContent`)));
check("Sched: shows the photoperiod", (await ev(`document.querySelector("#s-len").textContent`)) === "12h 00m of light, 12h 00m of dark", await ev(`document.querySelector("#s-len").textContent`));
check("Emerson: same sum as the HA failsafe", (await ev(`document.querySelector("#s-em").textContent`)) === "Red lights 06:55 - 07:10 and 18:50 - 19:05", await ev(`document.querySelector("#s-em").textContent`));
check("Sched: light limits aren't with the times, they belong to the sensors with the other limits", (await ev(`!document.querySelector("#s-limits") && !document.querySelector("#sin-dayMin") && !document.querySelector("#s-times [data-vin], #s-emerson [data-vin]") && !!document.querySelector("#td-targets #vin-light-0")`)) === true);
check("Sched: nothing changed, no bar", (await ev(`document.querySelector("#draftbar").hidden`)) === true);
await shot("sched-phone");
await setBox("night", "18:00");
check("Sched: the length follows as you edit", (await ev(`document.querySelector("#s-len").textContent`)) === "11h 00m of light, 13h 00m of dark");
check("Emerson: and so do the red windows", (await ev(`document.querySelector("#s-em").textContent`)) === "Red lights 06:55 - 07:10 and 17:50 - 18:05");
check("Sched: nothing is saved yet", (await ev(`zoneById("garden").nightAt`)) === 19 * 60);
await clickIt("[data-dreview]");
const rv = await schedModal();
check("Review: lists it before and after", rv.includes("Lights off") && rv.includes("19:00") && rv.includes("18:00"), rv);
check("Review: says what happens to the photoperiod", rv.includes("Light goes from 12h 00m to 11h 00m a day."), rv);
check("Review: says the lights can switch within minutes", rv.includes("lights can switch within minutes of applying"), rv);
check("Review: and the red windows", rv.includes("Red lights 06:55 - 07:10 and 17:50 - 18:05"), rv);
check("Review: and that it moves whatever reads the helper", rv.includes("anything reading them"), rv);
await shot("sched-review-phone");
const sentBefore = await schedSent();
await clickIt("[data-rapply]");
check("Apply: sends only what changed, to the right helper", (await schedSent()) === sentBefore + 1 && (await ev(`schedSends.at(-1).entity_id`)) === "input_datetime.garden_night_time" && (await ev(`schedSends.at(-1).value`)) === "18:00", await ev(`schedSends`));
check("Apply: never optimistic", (await ev(`zoneById("garden").nightAt`)) === 19 * 60 && (await ev(`document.querySelector("[data-rapply]").textContent`)).includes("verifying"));
await sleep(ACK);
check("Apply: counts once Home Assistant reports it, staying on the page with the new time in its box (#156)", (await ev(`zoneById("garden").nightAt`)) === 18 * 60 && (await ev(`!!ui.sched && !ui.review && document.querySelector("#sin-night").value==="18:00" && schedDraft(ui.sched).items.length===0`)) === true, await ev(`[!!ui.sched, document.querySelector("#sin-night")?.value]`));
await haSet([["input_datetime.garden_night_time", "19:00:00"]]); await ev(`render()`);
await schedOpen("veg");
check("Sched: across midnight the length is right", (await ev(`document.querySelector("#s-len").textContent`)) === "18h 00m of light, 6h 00m of dark", await ev(`document.querySelector("#s-len").textContent`));
check("Sched: shared helpers are named", (await ev(`document.querySelector("#s-times").textContent`)).includes("Nursery uses the same helpers"));
check("Sched: the helpers it reads are picked right there, by entity", same(await ev(`[document.querySelector("#map-onHelper").dataset.value,document.querySelector("#map-offHelper").dataset.value]`), ["input_datetime.veg_day_time", "input_datetime.veg_night_time"]), await ev(`[document.querySelector("#map-onHelper").dataset.value,document.querySelector("#map-offHelper").dataset.value]`));
check("Emerson: a zone without it says it's not used, with nothing to set", (await ev(`document.querySelector("#s-emerson").textContent`)).includes("Not used in Veg.") && (await ev(`!document.querySelector("#sin-morning")`)) === true);
await setBox("day", "15:00"); await clickIt("[data-dreview]");
check("Review: names the zone that moves with it", (await schedModal()).includes("Veg and Nursery") && (await schedModal()).includes("Nursery uses the same helpers"), await schedModal());
await clickIt("[data-rapply]"); await sleep(ACK);
check("Apply: the sharing zone moves too", (await ev(`zoneById("veg").dayAt`)) === 15 * 60 && (await ev(`zoneById("nursery").dayAt`)) === 15 * 60);
await haSet([["input_datetime.veg_day_time", "16:00:00"]]); await ev(`render()`);
await schedOpen("garden"); await boardSilent("input_number.emerson_effect_morning_extension", true); await setBox("morning", "7");
await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(GIVE_UP);
check("Apply: no answer is never shown as saved", (await ev(`zoneById("garden").emerson.morning`)) === 5 && (await schedModal()).includes("still reports 5 min"), await schedModal());
check("Apply: the review stays open to try again", (await ev(`!!ui.review && !!ui.sched`)) === true && (await ev(`!document.querySelector("[data-rapply]").disabled`)) === true);
await boardSilent("input_number.emerson_effect_morning_extension", false); await clickIt("[data-rapply]"); await sleep(ACK);
/* The setting write path. The frame names a zone and a setting, never an entity, and the host checks the helper's own limits. */
const hBefore = (await helperCalls()).length;
const hTries = await evp(`Promise.all([ask("setting",{zone:"garden",name:"heater",value:1}),ask("setting",{zone:"nursery",name:"bands.day.vpd.min",value:0.8}),ask("setting",{zone:"garden",name:"night",value:"25:00"}),ask("setting",{zone:"garden",name:"morning",value:7.5}),ask("setting",{zone:"garden",name:"morning",value:90}),ask("setting",{zone:"nope",name:"day",value:"07:00"})]).then(r=>r.map(x=>x.ok))`);
check("Setting: the host refuses an unknown setting, one the zone doesn't link, a bad time, a value off the helper's step or past its limit, and an unknown zone", JSON.stringify(hTries) === JSON.stringify([false, false, false, false, false, false]) && (await helperCalls()).length === hBefore, hTries);
await evp(`ask("setting",{zone:"garden",name:"night",value:"19:30",entity_id:"input_datetime.veg_night_time"})`); await sleep(ACK);
check("Setting: it writes the zone's own helper, whatever entity the frame names, with the time HA expects", JSON.stringify((await helperCalls()).slice(hBefore)) === JSON.stringify(["input_datetime.garden_night_time=19:30:00"]) && (await ev(`zoneById("garden").nightAt`)) === 19.5 * 60, await helperCalls());
await haSet([["input_datetime.garden_night_time", "19:00:00"]]);
check("Setting: a helper changed from elsewhere shows here", (await ev(`zoneById("garden").nightAt`)) === 19 * 60);
check("Apply: and trying again works", (await ev(`zoneById("garden").emerson.morning`)) === 7 && (await ev(`!ui.review`)) === true);
await haSet([["input_number.emerson_effect_morning_extension", "5.0"]]); await ev(`render()`);
await schedOpen("garden");
await setBox("night", "07:00");
check("Problem: the same time twice stops the review", (await ev(`document.querySelector("[data-dreview]").disabled`)) === true && (await ev(`document.querySelector("#s-issues").textContent`)).includes("two different times"));
await clickIt("[data-sfix]");
check("Problem: Fix lands on the box", (await active()) === "sin-night", await active());
await setBox("night", "19:00"); await setBox("evening", "60");
check("Problem: Emerson keeps to the helper's limits", (await ev(`document.querySelector("#s-issues").textContent`)).includes("between 0 and 59"), await ev(`document.querySelector("#s-issues").textContent`));
check("Problem: the typed value stays in its box", (await ev(`document.querySelector("#sin-evening").value`)) === "60");
await setBox("evening", "12"); await setBox("evening", "abc");
check("Problem: not a number keeps the last value", (await ev(`document.querySelector("#sin-evening").value`)) === "12");
await clickIt("[data-ddiscard]");
check("Discard: everything goes back", (await ev(`document.querySelector("#sin-evening").value`)) === "5" && (await ev(`document.querySelector("#draftbar").hidden`)) === true);
await tap("#sin-morning"); await type("9"); await key("Enter", 13); await sleep(40);
check("Typing: a real keystroke edit lands in the draft", (await ev(`ui.sched.vals.morning`)) === 9, await ev(`ui.sched.vals.morning`));
await clickIt("[data-tdexit]");
check("Leaving: Back asks first", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Discard unsaved changes?" && (await ev(`!!ui.sched`)) === true);
await clickIt("[data-gkeep]"); await goTab("Overview");
check("Leaving: so does a tab", (await ev(`!!ui.guard`)) === true);
await clickIt("[data-gdiscard]");
check("Leaving: discarding leaves it unsaved", (await ev(`!ui.sched && zoneById("garden").emerson.morning===5`)) === true);
/* A linked zone that shares its parent's lights takes the parent's schedule read only, so these run on Nursery unlinked. */
await ev(`zoneById("nursery").parent=undefined;zoneById("nursery").periodMode="fixed";zoneById("nursery").dayAt=16*60;render()`);
await schedOpen("nursery");
check("Sched: Set here shares with nobody", (await ev(`document.querySelector("#s-times").textContent`)).includes("Stored in Environment Control") && !(await ev(`document.querySelector("#s-times").textContent`)).includes("same helpers"));
await setBox("day", "15:30"); const sentFixed = await schedSent(); await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(40);
check("Sched: Set here saves at once and sends nothing", (await schedSent()) === sentFixed && (await ev(`zoneById("nursery").dayAt`)) === 15.5 * 60 && (await ev(`zoneById("veg").dayAt`)) === 16 * 60, [await schedSent(), sentFixed, await ev(`[zoneById("nursery").dayAt,zoneById("veg").dayAt,ui.review&&ui.review.errors]`)]);
await ev(`zoneById("nursery").periodMode=undefined;zoneById("nursery").dayAt=16*60`); await evp(`saveConfig(()=>{zoneById("nursery").parent="veg"})`);
check("Sched: Nursery is linked to Veg again, on disk too", (await diskZone("nursery")).parent === "veg" && (await ev(`sharesLights(zoneById("nursery"))`)) === true);
await ev(`zoneById("garden").periodMode="detected";zoneById("garden").lights=["switch.tent_lights"];render()`);
await schedOpen("garden");
check("Sched: Detected has no times to set, and its switches are picked right there", (await ev(`!document.querySelector("#sin-day") && document.querySelector("#s-times").textContent.includes("no times to set") && document.querySelector('[data-mlight="switch.tent_lights"]').getAttribute("aria-pressed")==="true"`)) === true);
check("Sched: but its Emerson effect still works", (await ev(`!!document.querySelector("#sin-morning")`)) === true && !/NaN|undefined/.test(await ev(`document.querySelector("#main").textContent`)));
await setBox("morning", "9"); await clickIt('[data-mperiod="fixed"]');
check("Sched: changing how day is known brings in the times and keeps an edit to the red lights", (await ev(`ui.sched.vals.morning`)) === 9 && (await ev(`!!document.querySelector("#sin-day")`)) === true, await ev(`ui.sched.vals`));
const periodReview = await ev(`openReview();document.querySelector("#modal").textContent`);
check("Sched: and the review lists the source change with the value", periodReview.includes("Day and night") && periodReview.includes("Detected") && periodReview.includes("Set here") && periodReview.includes("Morning extension"), periodReview);
await clickIt("[data-rback]"); await clickIt("[data-ddiscard]");
check("Sched: Discard puts the source back too", (await ev(`ui.td.m.period`)) === "detected" && (await ev(`ui.sched.vals.morning`)) === 5);
await ev(`window.__keptLights=LIGHTS.garden;delete LIGHTS.garden;openTd("garden");ui.td.m.period="detected";render()`); await sleep(40);
const fresh = await ev(`document.querySelector("#map-lights").textContent`);
check("Sched: a zone with no suggested switches lists everything, not an empty search", !fresh.includes("Nothing matches") && fresh.includes("Everything in Home Assistant") && fresh.includes("switch.tent_lights"), fresh);
await ev(`LIGHTS.garden=window.__keptLights;ui.td=null;ui.sched=null;ui.vpdw=null;render()`);
await reset(); await goTab("Setup");
await ev(`document.querySelector('#main [data-vpd="garden"]').click()`); await sleep(50);
await ev(`document.querySelector("[data-tdexit]").click()`); await sleep(50);
check("Sched: Back returns to where you came from", (await ev(`ui.screen==="setup" && !ui.sched`)) === true);

/* Light limits are thresholds on the sensor, so they sit with the other thresholds. Same helpers, different zones: Veg and Nursery share a schedule but not these. */
const limitTables = () => ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[...t.querySelectorAll("tr")].pop().textContent)`);
const limitBox = () => ev(`document.querySelector("#vin-light-0").value`);
const limitCell = () => ev(`document.querySelector("#vin-light-0").closest("label").textContent`);
const period2 = async (p) => { await ev(`document.querySelector('[data-vperiod="${p}"]').click()`); await sleep(40); };
const typeLimit = async (v) => { await ev(`(()=>{const e=document.querySelector("#vin-light-0");e.focus();e.value="${v}";e.dispatchEvent(new Event("change",{bubbles:true}));e.blur()})()`); await sleep(40); };
const noChart = () => ev(`ui.vpdw.edit`);
const lightNote = () => ev(`(()=>{const n=document.querySelector("#vnote-light"),b=document.querySelector("#vin-light-0"),r=n.getBoundingClientRect(),c=b.getBoundingClientRect(),row=n.closest(".vrow").getBoundingClientRect();return {text:n.textContent,same:r.top<c.bottom&&r.bottom>c.top,right:r.left>=c.right,left:r.right<=c.left,inside:r.left>=row.left&&r.right<=row.right&&r.bottom<=row.bottom,described:b.getAttribute("aria-describedby")==="vnote-light"}})()`);
await reset(); await goTab("Garden");
/* Since #33 the zone's targets are behind View targets, on the menu in its heading, and Set targets there opens the page. */
const viaTargets = async (id = "garden") => { await ev(`document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="${id}"]').click()`); await sleep(40); await ev(`document.querySelector('[data-tset="${id}"]').click()`); await sleep(50); };
await ev(`document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="garden"]').click()`); await sleep(40);
check("Limits: View targets lists them with the other thresholds", same(await limitTables(), ["Lightlx2,000", "Lightlx200"]), await limitTables());
await ev(`document.querySelector("[data-tclose]").click()`); await sleep(30);
await viaTargets(); await period2("day");
check("Limits: Day holds the minimum, in lux, in one column, with no Target", (await limitBox()) === "2000" && (await limitCell()) === "Min" && (await ev(`[...document.querySelector('[data-vrow="light"]').children].filter(e=>!e.classList.contains("vnote")).map(e=>e.textContent).join("")`)) === "Light lxMin" && (await ev(`document.querySelector("#vin-light-0").closest("label").getBoundingClientRect().width<document.querySelector("#vin-temperature-0").closest("label").getBoundingClientRect().width*1.2`)) === true);
{ const n = await lightNote(); check("Limits: Day says what falling below the minimum means, beside the box", n.text === "Below this light level, lights are considered off or malfunctioning." && n.same && n.right && n.inside && n.described, n); }
await shot("limits-note-day");
await period2("night");
{ const n = await lightNote(); check("Limits: Night says what rising above the maximum means, beside the box", n.text === "Above this light level, lights are considered on or malfunctioning." && n.same && n.left && n.inside && n.described, n); }
await shot("limits-note-night");
check("Limits: Night holds the maximum, under the other Max boxes", (await limitBox()) === "200" && (await limitCell()) === "Max" && (await ev(`Math.abs(document.querySelector("#vin-light-0").getBoundingClientRect().left-document.querySelector("#vin-temperature-4").getBoundingClientRect().left)<1`)) === true);
await period2("day");
const editBefore = await noChart(); await ev(`document.querySelector("#vin-light-0").focus()`); await sleep(40);
check("Limits: focusing the box leaves the chart alone", (await noChart()) === editBefore);
await typeLimit("2005");
check("Limits: they keep to the helper's step", (await ev(`document.querySelector("#v-issues").textContent`)).includes("steps of 10") && (await ev(`document.querySelector("[data-dreview]").disabled`)) === true, await ev(`document.querySelector("#v-issues").textContent`));
await ev(`document.querySelector('[data-vfix="light"]').click()`); await sleep(60);
check("Limits: Fix lands on the box and leaves the chart alone", (await active()) === "vin-light-0" && (await noChart()) === editBefore, await active());
await typeLimit("20000");
check("Limits: and inside its range", (await ev(`document.querySelector("#v-issues").textContent`)).includes("between 0 and 10,000 lx"));
await typeLimit("abc");
check("Limits: not a number keeps the last value", (await limitBox()) === "20000");
await period2("night");
check("Limits: a bad day value is reachable from Night", (await ev(`document.querySelector("#v-issues").textContent`)).includes("Day has a value to fix"));
await period2("day"); await typeLimit("2500");
await clickIt("[data-dreview]");
check("Limits: a linked zone's light limit goes to its helper, like its other helpers", (await schedModal()).includes("Day Light Min, on your helper") && (await schedModal()).includes("2,500 lx") && (await ev(`vpdDraft(ui.vpdw).items.length`)) === 1 && (await ev(`vpdDraft(ui.vpdw).skipped.length`)) === 0, await schedModal());
await ev(`ui.review=null;render()`); await sleep(30);
await ev(`document.querySelector('[data-vstage="veg"]').click()`); await sleep(40);
check("Limits: an Athena stage leaves them alone", (await limitBox()) === "2500");
await clickIt("[data-ddiscard]");
check("Limits: Discard puts them back", (await limitBox()) === "2000" && (await ev(`document.querySelector("#draftbar").hidden`)) === true);
await ev(`zoneById("garden").linked=false;ui.td.m.band="here";render()`); await typeLimit("2500"); await period2("night"); await typeLimit("150");
await clickIt("[data-dreview]");
check("Limits: a zone not on helpers lists both for review", (await ev(`vpdDraft(ui.vpdw).items.map((i)=>i.label).join()`)) === "Day Light Min,Night Light Max", await ev(`vpdDraft(ui.vpdw).items.map((i)=>i.label).join()`));
await clickIt("[data-rapply]"); await sleep(60);
check("Limits: and saves them, without touching the schedule", same(await ev(`[zoneById("garden").lightLimits.dayMin,zoneById("garden").lightLimits.nightMax,zoneById("garden").dayAt,schedSends.length]`), [2500, 150, 7 * 60, await schedSent()]), await ev(`zoneById("garden").lightLimits`));
check("Limits: no working field leaks into the saved bands", (await ev(`zoneById("garden").bands.day.light===undefined && zoneById("garden").bands.night.light===undefined`)) === true);
await ev(`ui.screen="zone";ui.zone="garden";ui.td=null;ui.sched=null;ui.vpdw=null;render();document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="garden"]').click()`); await sleep(40);
check("Limits: View targets follows", same(await limitTables(), ["Lightlx2,500", "Lightlx150"]), await limitTables());
await ev(`document.querySelector("[data-tclose]").click()`); await sleep(30);
await ev(`Object.assign(zoneById("garden"),{linked:true,lightLimits:{dayMin:2000,nightMax:200}});render()`);
await reset(); await goTab("Veg");
const vegLimit = await ev(`zoneById("veg").lightLimits.dayMin`), nurseryLimit = await ev(`zoneById("nursery").lightLimits.dayMin`);
check("Limits: Veg and Nursery each have their own", vegLimit !== nurseryLimit, [vegLimit, nurseryLimit]);
for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await reset(); await goTab("Garden"); await viaTargets(); await sleep(10);
  await tap("#vin-light-0"); await sleep(420);
  const r = await ev(`(()=>{const e=document.querySelector("#vin-light-0").getBoundingClientRect();return {bottom:e.bottom,h:innerHeight,active:document.activeElement.id}})()`);
  check(`Limits ${name} ${w}x${h}: the box stays above the keyboard`, r.active === "vin-light-0" && r.bottom <= r.h * (1 - kb), r);
  await key("Escape", 27); await sleep(40);
  check(`Limits ${name}: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`));
  if (w >= 500) { const e = await ev(`(()=>{const i=document.querySelector("#vin-light-0");i.value="10000";const r=[i.scrollWidth,i.clientWidth];i.value=2000;return r})()`); check(`Limits ${name}: the widest value fits one column`, e[0] <= e[1], e); }
  if (w === 800) { await ev(`document.querySelector('[data-vrow="light"]').scrollIntoView({block:"center"})`); await shot("limits-targets-foldable"); await reset(); await goTab("Garden"); await ev(`document.querySelector('[data-zmenu="-more"]').click();document.querySelector('[data-viewtargets="garden"]').click()`); await sleep(40); await ev(`document.querySelector(".tbl-wrap").scrollIntoView({block:"center"})`); await sleep(40); await shot("limits-table-foldable"); check("Limits foldable: every table fits its card", await ev(`[...document.querySelectorAll(".tbl-wrap")].every((t)=>t.scrollWidth<=t.clientWidth)`), await ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[t.scrollWidth,t.clientWidth])`)); }
}
for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await schedOpen("garden"); await sleep(60);
  const hidden = [];
  for (const id of ["morning", "daylight", "evening"]) {
    await tap(`#sin-${id}`); await sleep(420);
    const r = await ev(`(()=>{const e=document.querySelector("#sin-${id}").getBoundingClientRect();return {bottom:e.bottom,h:innerHeight,active:document.activeElement.id}})()`);
    if (r.active !== `sin-${id}` || r.bottom > r.h * (1 - kb)) hidden.push([id, Math.round(r.bottom), r.active]);
    await key("Escape", 27); await sleep(40);
  }
  check(`Sched ${name} ${w}x${h}: every box stays above the keyboard`, hidden.length === 0, hidden);
  check(`Sched ${name}: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`));
}
await phone(390, 844); await reset();
await ev(`document.documentElement.dataset.theme="dark"`); await schedOpen("garden"); await shot("sched-dark");
await goTab("Garden"); await ev(`document.querySelector("#chart").scrollIntoView({block:"start"})`); await shot("chart-dark");
await ev(`delete document.documentElement.dataset.theme`);
await reset();

// ---------- Helper picker: every link is picked from what HA has, never built from a zone's name
await reset();
/* Raced against a second, so a host that never answers fails here rather than hanging the run. */
const helperList = await evp(`Promise.race([ask("helpers",{}).then(r=>r.helpers),new Promise(r=>setTimeout(()=>r([]),1000))])`), listed = helperList.map((h) => h.entity);
check("Helpers: the host lists HA's number and time helpers, linked or not", ["input_number.nursery_day_temperature_min_threshold", "input_datetime.reservoir_refill_time", "input_number.garden_day_temperature_min_threshold", "input_datetime.veg_day_time"].every((e) => listed.includes(e)), listed);
check("Helpers: and nothing else, not even a date-and-time helper", listed.every((e) => /^input_(number|datetime)\./.test(e)) && !listed.includes("input_datetime.last_reservoir_refill"), listed);
const HOST_ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "unit_of_measurement"];
check("Helpers: only allowlisted attributes cross", helperList.every((h) => Object.keys(h.attributes).every((k) => HOST_ATTRS.includes(k))), helperList.find((h) => Object.keys(h.attributes).some((k) => !HOST_ATTRS.includes(k))));
check("Helpers: listing them maps nothing, so no unlinked helper's state reaches the frame", (await ev(`"input_number.nursery_day_temperature_min_threshold" in haStates`)) === false);
/* Helper pickers are search boxes since #25: picking one is choosing it from the box's list. */
const pick = async (sel, value) => { await ev(`pickHelper(document.querySelector("#${sel}").dataset.hq, ${JSON.stringify(value)})`); await sleep(40); };
const opts = (sel) => ev(`helperOptions(document.querySelector("#${sel}").dataset.hq)`);
const fixText = () => ev(`document.querySelector("#td-issues")?.textContent || ""`);
const mapNextOff = () => ev(`!!topDraft().blocked`);
/* Nursery shares Veg's lights, so its lights helpers are Veg's and read only there: those pickers are tried on Veg. */
await ev(`ui.screen="setup";openTd("veg");ui.vpdw.period="day";render()`); await sleep(150);
const onOpts = await opts("map-onHelper");
check("Picker: lights on lists every time helper HA has, not names built from the zone", onOpts.includes("input_datetime.reservoir_refill_time") && onOpts.includes("input_datetime.garden_day_time") && !onOpts.includes("input_datetime.last_reservoir_refill"), onOpts);
await ev(`ui.screen="setup";openTd("nursery");ui.vpdw.period="day";render()`); await sleep(150);
check("Picker: limit pickers only show once the zone uses its helpers", (await ev(`!!document.querySelector("[data-mlink^='bands']")`)) === false);
await clickIt('[data-mband="helpers"]');
const tmin = "map-l-bands-day-temperature-min", nT = "input_number.nursery_day_temperature_min_threshold";
await ev(`(()=>{const i=document.querySelector("#${tmin}");i.focus();i.value="temperature min threshold";i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await sleep(40);
const pickListed = await ev(`[...document.querySelectorAll("#${tmin}-list [data-hval]")].map(li=>li.dataset.hval)`);
check("Picker: typing narrows to helpers matching every word, in the setting's unit first", pickListed.includes(nT) && pickListed.includes("input_number.garden_day_temperature_min_threshold") && !pickListed.includes("input_number.nursery_day_humidity_min_threshold") && pickListed.length <= 8, pickListed);
const nTval = await onHA(`fakeHA.states["${nT}"].state`);
check("Picker: each choice names the helper and what it holds", (await ev(`document.querySelector('#${tmin}-list [data-hval="${nT}"] .eid').textContent`)) === `${nT}, ${nTval} °C`, await ev(`document.querySelector('#${tmin}-list [data-hval="${nT}"] .eid').textContent`));
await ev(`document.activeElement.blur()`); await sleep(220);
check("Picker: My helpers with nothing linked says so and holds Next", (await mapNextOff()) === true && (await fixText()).includes("Link at least one limit"), await fixText());
await pick(tmin, "input_number.nursery_day_humidity_min_threshold");
check("Picker: a helper in another unit is flagged and holds Next", (await mapNextOff()) === true && (await fixText()).includes("Day temperature Min: input_number.nursery_day_humidity_min_threshold is in %, not °C"), await fixText());
await pick(tmin, nT);
check("Picker: picking leaves the box, so a phone's keyboard closes, and says what's linked under it", (await active()) !== tmin && (await ev(`document.querySelector("#${tmin}-box p").textContent`)).startsWith("Linked: "), await active());
await pick("map-l-bands-day-temperature-max", nT);
check("Picker: one helper behind two limits is flagged", (await fixText()).includes(`${nT} is linked to both Day temperature Min and Day temperature Max`), await fixText());
await pick("map-l-bands-day-temperature-max", "input_number.nursery_day_temperature_max_threshold");
await clickIt('[data-vperiod="night"]');
await pick("map-l-bands-night-vpd-min", "input_number.reservoir_target_ec");
await clickIt('[data-vperiod="day"]');
check("Picker: a problem on the other period is still caught", (await fixText()).includes("Night VPD Min: input_number.reservoir_target_ec is in mS/cm, not kPa"), await fixText());
await clickIt("#td-issues [data-tdfix]");
check("Picker: and its Fix opens Night on that box", (await ev(`ui.vpdw.period`)) === "night" && (await active()) === "map-l-bands-night-vpd-min");
await pick("map-l-bands-night-vpd-min", "input_number.nursery_night_vpd_min_threshold");
check("Picker: with every problem fixed, Next is on", (await mapNextOff()) === false, await fixText());
await ev(`openReview()`); await sleep(40);
const linkReview = await modalText();
check("Picker: the review lists each new link with what it holds, and says HA will ask", linkReview.includes("Day temperature Min") && linkReview.includes(`${nT} (${nTval} °C)`) && linkReview.includes("Set here") && linkReview.includes("asks you to allow each helper"), linkReview);
check("Picker: nothing is saved before Apply", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery").helpers.bands`)) === undefined);
await clickIt("[data-rapply]"); await sleep(300);
const linkDlg = await hostDialog();
check("Picker: Home Assistant asks before the links are saved, naming each helper", linkDlg.open && linkDlg.text.includes("3 helpers: values can be changed") && linkDlg.text.includes(nT) && linkDlg.text.includes("input_number.nursery_night_vpd_min_threshold"), linkDlg.text);
await sleep(1100); await hostClick("allow"); await sleep(400);
const savedLinks = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery")`);
check("Picker: once allowed, exactly the picked links are on disk", savedLinks.linked === true && JSON.stringify(savedLinks.helpers.bands) === JSON.stringify({ day: { temperature: { min: nT, max: "input_number.nursery_day_temperature_max_threshold" } }, night: { vpd: { min: "input_number.nursery_night_vpd_min_threshold" } } }) && savedLinks.helpers.light === undefined, savedLinks.helpers);
check("Picker: Targets now treats them as on your helper", (await ev(`settingLink(zoneById("nursery"),"bands.day.temperature.min")`)) === nT && (await ev(`settingLink(zoneById("nursery"),"bands.day.humidity.min")`)) === undefined);
await haSet([[nT, 17.5]]);
check("Picker: and the zone reads what the helper holds", (await ev(`zoneById("nursery").bands.day.temperature[0]`)) === 17.5, await ev(`zoneById("nursery").bands.day.temperature`));
await reset(); await ev(`ui.screen="setup";openTd("veg");ui.vpdw.period="day";render()`); await sleep(150);
await pick("map-onHelper", "input_datetime.reservoir_refill_time");
check("Picker: changing only which helper holds lights on is a change to review", (await ev(`tdDraft(ui.td).items.length`)) > 0 && (await ev(`document.querySelector("#draftbar").hidden`)) === false);
await ev(`openReview()`); await sleep(40);
check("Picker: and the review names both helpers", /Lights on helper.*input_datetime\.veg_day_time \(16:00\).*input_datetime\.reservoir_refill_time \(09:00\)/.test(await modalText()), await modalText());
await reset(); await ev(`ui.screen="setup";openTd("veg");ui.vpdw.period="day";render()`); await sleep(150);
await clickIt('[data-mem="helper"]');
await pick("map-l-morning", "input_number.emerson_effect_morning_extension");
check("Picker: red lights from helpers need all three", (await fixText()).includes("Red lights: pick all three helpers."), await fixText());
for (const [k, e] of [["morning", "morning_extension"], ["daylight", "daylight_time"], ["evening", "evening_extension"]]) await pick(`map-l-${k}`, `input_number.emerson_effect_${e}`);
await ev(`openReview()`); await sleep(40); await clickIt("[data-rapply]"); await sleep(400);
check("Picker: a helper another zone already links isn't asked about again", (await hostDialog()).open === false);
check("Picker: linking all three Emerson helpers gives Veg the Emerson effect, read from them", JSON.stringify(await ev(`zoneById("veg").emerson`)) === JSON.stringify(await ev(`zoneById("garden").emerson`)), await ev(`zoneById("veg").emerson`));
await ev(`openTd("veg");render()`); await sleep(40);
check("Picker: and the page shows it, with its values", (await ev(`!!document.querySelector("#sin-morning") && document.querySelector('[data-mem="helper"]').checked`)) === true);
const wrongKind = await evp(`saveConfig(()=>{zoneById("veg").helpers.bands.day.humidity.min="input_datetime.veg_day_time"}).then(r=>[r.ok,r.error])`);
check("Picker: the backend refuses a limit linked to a time helper", wrongKind[0] === false && wrongKind[1].includes("isn't a number helper"), wrongKind);

// ---------- No target: any zone can have limits and nothing to aim for
await reset(); await ev(`openVpd("nursery");render()`); await sleep(40);
await clickIt('[data-vtarget="off"]');
const noAim = await ev(`({tab:document.querySelectorAll('.vtabs [data-vedit="target"]').length,dash:document.querySelectorAll(".vdash").length,box:!!document.querySelector("#vin-temperature-2"),circle:document.querySelectorAll("#vwrap circle").length,issues:vIssues(ui.vpdw,ui.vpdw.bands.day).length+vIssues(ui.vpdw,ui.vpdw.bands.night).length})`);
check("No target: the Target tab, boxes and chart point go, and no order problem appears", noAim.tab === 0 && noAim.dash === 3 && !noAim.box && noAim.circle === 0 && noAim.issues === 0, noAim);
await clickIt('[data-vstage="veg"]');
check("No target: an Athena stage fills the limits and leaves the target off", (await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[2]`)) === null && (await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[1]`)) === 22.2);
await clickIt("[data-dreview]");
const noAimReview = await modalText();
check("No target: the review lists each target going to None", /Day Temperature Target[^]*None/.test(noAimReview) && noAimReview.includes("Night VPD Target"), noAimReview);
await clickIt("[data-rapply]"); await sleep(300);
const appliedHelpers = await ev(`!!ui.review && ui.review.busy`);
for (let i = 0; i < 80 && (await ev(`!!ui.review`)); i++) await sleep(50);
check("No target: an Athena stage on a zone with helpers writes them, and the page waits until they report", appliedHelpers === true && (await ev(`!ui.review && !!ui.td && vpdDraft(ui.vpdw).items.length===0`)) === true);
const noAimDisk = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery").bands`);
check("No target: saved as no value in both periods", ["day", "night"].every((p) => ["temperature", "humidity", "vpd"].every((k) => noAimDisk[p][k][2] === null)), noAimDisk);
await ev(`ui.screen="zone";ui.zone="nursery";render()`); await sleep(60);
const noAimPage = await ev(`({ticks:document.querySelectorAll("#main .track .tick").length,tracks:document.querySelectorAll("#main .track").length,range:document.querySelector("#main .tile .range").textContent,table:(()=>{const d=document.createElement("div");d.innerHTML=targetsTable(zoneById(ui.zone));return d.querySelector("tbody tr").textContent})(),bad:/NaN|undefined|null/.test(document.querySelector("#main").textContent)})`);
check("No target: the zone page draws its tracks without a Target tick, and shows - for it", noAimPage.ticks === 0 && noAimPage.tracks > 0 && noAimPage.range.includes("-Target") && noAimPage.table.includes("-") && !noAimPage.bad, noAimPage);
check("No target: readings are still judged against the limits", ["ok", "low", "high", "critlow", "crithigh"].includes(await ev(`bandState(zoneById("nursery"),"temperature")`)));
await reset(); await ev(`openVpd("nursery");render()`); await sleep(40);
await clickIt('[data-vtarget="on"]');
const backOn = await ev(`(()=>{const b=ui.vpdw.bands.day.temperature;return [b[2],round2((b[1]+b[3])/2)]})()`);
check("No target: turning it back on starts it midway between Low and High", backOn[0] !== null && backOn[0] === backOn[1], backOn);
await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(300);
check("No target: and that saves", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery").bands.day.temperature[2]`)) === backOn[0]);
const callsBefore = (await helperCalls()).length, vegTarget = await onHA(`fakeHA.states["input_number.veg_day_temperature_target"].state`);
await reset(); await ev(`ui.screen="setup";openTd("veg");ui.vpdw.period="day";render()`); await sleep(150);
check("No target: the page shows Target pickers while the zone aims for one", (await ev(`!!document.querySelector("#map-l-bands-day-temperature-target")`)) === true);
await clickIt('[data-vtarget="off"]');
check("No target: and hides them once it doesn't", (await ev(`!!document.querySelector("#map-l-bands-day-temperature-target")`)) === false && (await mapNextOff()) === false);
await ev(`openReview()`); await sleep(40);
check("No target: the review says so, target by target", /Day Temperature Target[^]*None/.test(await modalText()), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
const vegDisk = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="veg")`);
check("No target: the target helpers are unlinked and the zone holds no target", vegDisk.helpers.bands.day.temperature.target === undefined && vegDisk.helpers.bands.day.temperature.min === "input_number.veg_day_temperature_min_threshold" && vegDisk.bands.day.temperature[2] === null, vegDisk.helpers.bands.day);
check("No target: nothing is written to the helpers, which keep their values", (await helperCalls()).length === callsBefore && (await onHA(`fakeHA.states["input_number.veg_day_temperature_target"].state`)) === vegTarget);
const lateSet = await evp(`ask("setting",{zone:"veg",name:"bands.day.temperature.target",value:24}).then(r=>r.ok)`);
check("No target: and the host refuses to write one", lateSet === false && (await helperCalls()).length === callsBefore);
await reset(); await ev(`ui.screen="setup";openTd("veg");ui.vpdw.period="day";render()`); await sleep(150);
await clickIt('[data-vtarget="on"]');
check("No target: turning it on offers Set here or a helper", (await ev(`document.querySelector("#map-l-bands-day-temperature-target-box p").textContent`)) === "Set here");
await pick("map-l-bands-day-temperature-target", "input_number.veg_day_temperature_target");
await ev(`openReview()`); await sleep(40); await clickIt("[data-rapply]"); await sleep(300);
await sleep(1100); await hostClick("allow"); await sleep(400);
const vegBack = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="veg")`);
check("No target: relinking asks again, then reads the helper, with the rest midway", vegBack.helpers.bands.day.temperature.target === "input_number.veg_day_temperature_target" && vegBack.bands.day.temperature[2] === Number(vegTarget) && vegBack.bands.night.temperature[2] !== null, [vegBack.helpers.bands.day.temperature, vegBack.bands.day.temperature, vegBack.bands.night.temperature]);
await reset();

// ---------- Red lights: from a helper, set here, detected, or not used
/* Nursery shares Veg's lights, which makes its red lights Veg's and read only, so these run on Nursery unlinked. */
await evp(`saveConfig(()=>{delete zoneById("nursery").parent})`); await sleep(100);
await ev(`ui.screen="setup";openTd("nursery");ui.vpdw.period="day";render()`); await sleep(150);
const emModes = () => ev(`[...document.querySelectorAll("[data-mem]")].map(b=>b.dataset.mem)`);
check("Red lights: four sources, like day and night", JSON.stringify(await emModes()) === JSON.stringify(["none", "helper", "fixed", "detected"]) && (await ev(`document.querySelector('[data-mem="none"]').checked`)) === true, await emModes());
await clickIt('[data-mem="fixed"]');
check("Red lights: Set here shows the three extensions, starting at none", same(await ev(`["morning","daylight","evening"].map(k=>document.querySelector("#sin-"+k)?.value)`), ["0", "0", "0"]), await ev(`["morning","daylight","evening"].map(k=>document.querySelector("#sin-"+k)?.value)`));
await setBox("morning", "10"); await setBox("daylight", "20"); await setBox("evening", "70");
check("Red lights: one past the limit is flagged and holds the review", (await ev(`document.querySelector("#s-issues").textContent`)).includes("Evening extension has to be between 0 and 59") && (await mapNextOff()) === true, await ev(`document.querySelector("#s-issues").textContent`));
await setBox("evening", "15");
check("Red lights: with all three fine, the review is on", (await mapNextOff()) === false, await fixText());
await ev(`openReview()`); await sleep(40);
check("Red lights: the review lists the source and each extension", /Red lights[^]*Not used[^]*Set here/.test(await modalText()) && /Morning extension[^]*Not set[^]*10 min/.test(await modalText()), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
const emFixedDisk = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery")`);
check("Red lights: Set here is stored, with no helper linked and nothing asked", emFixedDisk.emersonMode === "fixed" && JSON.stringify(emFixedDisk.emerson) === JSON.stringify({ morning: 10, daylight: 20, evening: 15 }) && emFixedDisk.helpers.morning === undefined && (await hostDialog()).open === false, emFixedDisk);
await reset(); await ev(`openTd("nursery");render()`); await sleep(40);
const emCard = await ev(`document.querySelector("#s-emerson").textContent`);
check("Red lights: the page edits them and works out the windows", (await ev(`!!document.querySelector("#sin-morning")`)) === true && emCard.includes("Red lights 15:50 - 16:20 and 09:40 - 10:15") && emCard.includes("Stored in Environment Control"), emCard);
const emCalls = (await helperCalls()).length;
await ev(`(()=>{const i=document.querySelector("#sin-morning");i.value="12";i.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(40);
await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(400);
check("Red lights: and saves them here, writing to no helper", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery").emerson.morning`)) === 12 && (await helperCalls()).length === emCalls);
await reset(); await ev(`ui.screen="setup";openTd("nursery");ui.vpdw.period="day";render()`); await sleep(150);
await clickIt('[data-mem="detected"]');
const redOffered = await ev(`[...document.querySelectorAll("#map-red [data-mred]")].map(b=>b.dataset.mred)`);
check("Red lights: Detected lists on and off switches to follow, and needs one", redOffered.includes("switch.lights_red") && (await mapNextOff()) === true && (await fixText()).includes("Pick at least one red light switch"), [redOffered, await fixText()]);
await clickIt('[data-mred="switch.lights_red"]');
await ev(`openReview()`); await sleep(40);
check("Red lights: the review names the switch", /Red lights[^]*Set here[^]*Detected/.test(await modalText()) && (await modalText()).includes("switch.lights_red"), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
const emDetDisk = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery")`);
check("Red lights: Detected stores the switch and drops the extensions", emDetDisk.emersonMode === "detected" && JSON.stringify(emDetDisk.redLights) === JSON.stringify(["switch.lights_red"]) && emDetDisk.emerson === undefined, emDetDisk);
await reset(); await ev(`openTd("nursery");render()`); await sleep(40);
const detCard = await ev(`document.querySelector("#s-emerson").textContent`);
check("Red lights: the page shows what it follows, with nothing to set", detCard.includes("Detected") && detCard.includes("switch.lights_red") && (await ev(`!!document.querySelector("#sin-morning")`)) === false, detCard);
await reset(); await ev(`ui.screen="setup";openTd("garden");ui.vpdw.period="day";render()`); await sleep(150);
check("Red lights: Garden is still on its helpers", (await ev(`document.querySelector('[data-mem="helper"]').checked`)) === true && (await ev(`document.querySelector("#map-l-morning").dataset.value`)) === "input_number.emerson_effect_morning_extension");
const emBad = await evp(`saveConfig(()=>{const z=zoneById("nursery");z.emersonMode="fixed";z.emerson={morning:90,daylight:10,evening:5}}).then(r=>[r.ok,r.error])`);
const redBad = await evp(`saveConfig(()=>{zoneById("nursery").redLights=["lock.front_door"]}).then(r=>[r.ok,r.error])`);
check("Red lights: the backend refuses an extension past 59 minutes and a switch that isn't on or off", emBad[0] === false && emBad[1].includes("outside 0 to 59") && redBad[0] === false && redBad[1].includes("isn't an on or off entity"), [emBad, redBad]);
await evp(`saveConfig(()=>{zoneById("nursery").parent="veg"})`); await sleep(100);
check("Red lights: Nursery is linked to Veg again", (await diskZone("nursery")).parent === "veg");
await reset();

// ---------- Placement: devices too, optional, between the units and the wall if wanted
await ev(`ui.level="all";ui.screen="zone";ui.zone="garden";render()`); await sleep(60);
const devMarksOn = () => ev(`[...document.querySelectorAll("#main [data-mapdev]")].map(g=>g.dataset.mapdev).sort()`);
check("Placement: the zone map has a wall round it", (await ev(`[...document.querySelectorAll("#main .map svg rect")].some(r=>r.querySelector("title")?.textContent==="Wall")`)) === true);
check("Placement: placed devices show on the zone's map", same(await devMarksOn(), ["ac", "dehu", "heater", "intake"]), await devMarksOn());
const unplacedLine = () => ev(`document.querySelector("#unplaced-garden")?.textContent || ""`);
check("Placement: the zone says which devices aren't on the map, and that it's fine", /^8 devices aren't on the map: Auxiliary dehumidifier, Air conditioner exhaust fan, Plug 7, .*They don't need to be/.test(await unplacedLine()) && !(await unplacedLine()).includes("Dehumidifier"), await unplacedLine());
const svgClick = async (sel) => { await ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent("click",{bubbles:true}))`); await sleep(50); };
await svgClick('[data-mapdev="dehu"]');
const devDetail = await ev(`document.querySelector("#main .detail").textContent`);
check("Placement: tapping a device says where it is and how it's doing", devDetail.includes("Dehumidifier") && devDetail.includes("By the wall at unit 9"), devDetail);
await svgClick('[data-mapdev="ac"]');
check("Placement: one by the top wall is named by its unit", (await ev(`document.querySelector("#main .detail").textContent`)).includes("By the wall at unit 4"));
await ev(`ui.level="above";render()`); await sleep(40);
check("Placement: devices have no height, so a height filter hides them", (await devMarksOn()).length === 0);
await ev(`ui.level="all";render()`); await sleep(40);
await ev(`document.querySelector("#main .map").scrollIntoView({block:"start"})`); await shot("placement-zone-phone");
await clickIt("#unplaced-garden [data-wizard]");
check("Placement: Place devices opens the wizard on the first one left", (await ev(`!!ui.wiz && ui.wiz.step===3 && ui.wiz.pick==="d:aux"`)) === true, await ev(`ui.wiz && [ui.wiz.step, ui.wiz.pick]`));
const edgeSpots = () => ev(`[...document.querySelectorAll("[data-spot]")].map(g=>g.dataset.spot).filter(s=>{const [r,c]=s.split(",").map(Number);return r<0||c<0||r>2||c>3})`);
check("Placement: a device can go between the outer units and the wall, all the way round", (await edgeSpots()).length > 0 && (await edgeSpots()).includes("-0.5,-0.5") && (await edgeSpots()).includes("1,3.5") && (await edgeSpots()).includes("2.5,1.5"), await edgeSpots());
check("Placement: spots another mark already holds aren't offered", !(await edgeSpots()).includes("2.5,0") && !(await edgeSpots()).includes("-0.5,3"), await edgeSpots());
check("Placement: a device has no height to set", (await ev(`!!document.querySelector("[data-wizlevel]")`)) === false);
check("Placement: unplaced devices are told about, and don't stop saving", (await ev(`document.querySelector("#wiz-unplaced")?.textContent || ""`)).includes("placing a device is optional") && (await nextOff()) === false, await ev(`document.querySelector("#wiz-unplaced")?.textContent`));
const mapInView = () => ev(`(()=>{const r=document.querySelector("#main .map").getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight+1})()`);
await ev(`window.scrollTo(0,0)`); await clickIt('[data-pick="d:plug"]');
check("Placement: picking from a long list brings the map into view", (await mapInView()) === true);
await shot("placement-device-phone");
await clickIt('[data-pick="g-left"]');
check("Placement: sensors can go by the wall too, but not outside it", (await edgeSpots()).includes("-0.5,-0.5") && !(await edgeSpots()).some((k) => k.split(",").map(Number).some((x) => x === -1)) && (await ev(`!!document.querySelector("[data-wizlevel]")`)) === true, await edgeSpots());
await clickIt('[data-pick="d:acfan"]'); await svgClick('[data-spot="-0.5,-0.5"]');
await clickIt('[data-pick="d:dehu"]'); await clickIt("[data-wunplace]");
await wizNext();
check("Placement: the review lists each device move", /Air conditioner exhaust fan position[^]*Not placed[^]*Corner by unit 1/.test(await modalText()) && /Dehumidifier position[^]*By the wall at unit 9[^]*Not placed/.test(await modalText()) && (await modalText()).includes("Placing a device is optional"), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
const placeDisk = await onHA(`(()=>{const d=JSON.parse(fakeHA.disk).devices;return [d.find(x=>x.id==="acfan").place, d.find(x=>x.id==="dehu").place]})()`);
check("Placement: it's stored per zone, and taking one off forgets it", same(placeDisk, [{ garden: [-0.5, -0.5] }, null]) || (same(placeDisk[0], { garden: [-0.5, -0.5] }) && placeDisk[1] === undefined), placeDisk);
await ev(`ui.screen="zone";ui.zone="garden";render()`); await sleep(40);
check("Placement: and the zone's map follows", (await devMarksOn()).includes("acfan") && !(await devMarksOn()).includes("dehu"), await devMarksOn());
// Every spot for a device: between units in a row, an empty unit's spot, and outside the wall
await ev(`ui.screen="setup";openWizard("garden");ui.wiz.step=3;ui.wiz.pick="d:plug";render()`); await sleep(40);
const spotLabel = (spot) => ev(`document.querySelector('[data-spot="${spot}"]')?.getAttribute("aria-label") || ""`);
check("Placement: a device can go between two units in a row", (await spotLabel("0,0.5")) === "Between unit 1 and unit 2", await spotLabel("0,0.5"));
check("Placement: and outside the wall, all the way round", (await spotLabel("-1,-1")) === "Outside the wall, by unit 1" && (await spotLabel("3,2")) === "Outside the wall, by unit 11" && (await spotLabel("1,4")) === "Outside the wall, by unit 8", [await spotLabel("-1,-1"), await spotLabel("3,2"), await spotLabel("1,4")]);
check("Placement: outside the wall is a +, never a unit", (await ev(`["-1,-1","-1,0","3,0","1,-1","1,4"].every(k=>{const g=document.querySelector('[data-spot="'+k+'"]');return g && g.querySelector("path") && !g.querySelector('circle[r="32"]')})`)) === true);
const looks = await ev(`typeof look==="function" ? devices.filter(d=>d.ctl).map(d=>[d.type||"",look({kind:"device",dev:d})]).map(([t,k])=>t+"="+k.icon+"/"+k.c) : []`);
const wantLook = { Dehumidifier: "drop/var(--hum)", Humidifier: "drop/var(--hum)", "Air conditioner": "thermo/var(--temp)", Heater: "thermo/var(--temp)", Fan: "fan/var(--air)", Light: "sun/var(--sun)", Other: "plug/var(--muted)", "": "plug/var(--muted)" };
check("Placement: each device class has its own icon and colour, and one not yet said is plain", looks.length > 5 && looks.every((l) => { const [t, k] = l.split("="); return wantLook[t] === k; }) && new Set(looks.map((l) => l.split("=")[1])).size >= 4, looks);
check("Placement: a sensor is filled with its height's colour, and a virtual device is dashed", (await ev(`typeof look==="function" && look({kind:"env",level:"under"}).fill===true && look({kind:"env",level:"under"}).c==="var(--under)" && look({kind:"virtual"}).dash===true`)) === true);
const mapMarks = await ev(`[...document.querySelectorAll("#main .map svg [data-pick]")].map(m=>[m.dataset.pick, m.querySelectorAll("text").length, m.querySelector("svg path")?.getAttribute("d")||""])`);
check("Placement: the map carries icons, never names", mapMarks.length >= 3 && mapMarks.every(([, t, d]) => t === 0 && d), mapMarks);
const optIcons = await ev(`Object.fromEntries([...document.querySelectorAll(".sensor-opt[data-pick]")].map(b=>[b.dataset.pick, b.querySelector(".mk svg path")?.getAttribute("d")||""]))`);
check("Placement: the selector shows each name beside the same icon the map uses", Object.keys(optIcons).length > 5 && Object.values(optIcons).every(Boolean) && mapMarks.every(([id, , d]) => optIcons[id] === d), [optIcons, mapMarks]);
const steps = await ev(`(()=>{const L=wizLayout(ui.wiz),g=geom(L,true),d=(f,n)=>{const v=[];for(let k=-1;k<n;k+=0.5)v.push(Math.round(f(k+0.5)-f(k)));return [...new Set(v)]};return [d(g.X,L.cols),d(g.Y,L.rows)]})()`);
check("Placement: the spots are evenly spaced right out past the wall, with no gap either side of it", same(steps, [[65], [56]]), steps);
const crossing = await ev(`(()=>{const w=ui.wiz,keep=w.devs.map(d=>d.pos),at={"d:plug":[1,-1],"d:acfan":[1,-0.5],"d:aux":[1,3.5],"d:dehu":[1,4]};
  w.devs.forEach(d=>{if(at[d.id])d.pos=at[d.id]});render();
  const wall=document.querySelector("#main .map svg rect title").parentNode,wl=+wall.getAttribute("x"),wr=wl+ +wall.getAttribute("width");
  const bad=[...document.querySelectorAll("#main .map svg [data-pick]")].filter(m=>{const r=m.querySelector("rect");if(!r)return false;const a=+r.getAttribute("x"),b=a+ +r.getAttribute("width");return (a<wl&&b>wl)||(a<wr&&b>wr)}).map(m=>m.dataset.pick);
  const placed=Object.keys(at).filter(id=>document.querySelector('#main .map svg [data-pick="'+id+'"] rect'));
  w.devs.forEach((d,i)=>d.pos=keep[i]);render();return [placed.length,bad]})()`);
check("Placement: a mark beside the wall, inside or out, never crosses it", crossing[0] === 4 && crossing[1].length === 0, crossing);
await ev(`ui.wiz.units=11;render()`); await sleep(40);
check("Placement: and on the spot an empty unit would have", (await spotLabel("2,3")) === "Where unit 12 would be", await spotLabel("2,3"));
await clickIt('[data-pick="g-left"]');
check("Placement: a sensor gets every spot inside the wall, and none outside it", (await spotLabel("0,0.5")) === "Between unit 1 and unit 2" && (await spotLabel("2,3")) === "Where unit 12 would be" && (await spotLabel("-0.5,1")) === "By the wall at unit 2" && (await spotLabel("-1,-1")) === "" && (await spotLabel("3,2")) === "", [await spotLabel("0,0.5"), await spotLabel("2,3"), await spotLabel("-1,-1")]);
// Unit labels (#39) and the height an environment sensor needs before saving (#36)
await ev(`ui.screen="setup";openWizard("garden",[1,2]);ui.wiz.step=2;render()`); await sleep(40);
await ev(`(()=>{const i=document.querySelector('[data-wlabel="3"]');i.value="Kush";i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await ev(`render()`); await sleep(30);
check("Placement: a unit label shows on the map in place of its number", (await ev(`[...document.querySelectorAll("#main .map text")].map(t=>t.textContent).includes("Kush")`)) === true);
await wizNext();
check("Placement: unit labels are reviewed", /Unit labels[^]*None[^]*3: Kush/.test(await modalText()), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
check("Placement: and stored with the layout, by unit number", same(await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="garden").layout.labels`), { 3: "Kush" }));
await ev(`ui.screen="setup";openWizard("garden");ui.wiz.step=3;delete ui.wiz.sensors.find(x=>x.id==="g-left").level;ui.wiz.pick="g-left";render()`); await sleep(40);
check("Placement: a placed environment sensor with no height can't be saved, and says so", (await ev(`document.querySelector('[data-pick="g-left"]').textContent`)).includes("Needs a height") && (await nextOff()) === true && (await ev(`document.querySelector("#main .wizbar").textContent`)).includes("Set Environment left's height to save"));
await ev(`(()=>{const i=document.querySelector('[data-wizlevel][value="in"]');i.checked=true;i.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(30);
check("Placement: picking its height from the chips lets it save", (await nextOff()) === false);
await ev(`ui.wiz=null;render()`); await evp(`saveConfig(()=>{delete zoneById("garden").layout.labels})`); await sleep(60);

// Virtual devices: added in Device identification, placed here, drawn on the map, unknown to Home Assistant
await evp(`saveConfig(()=>{zoneById("garden").virtual=[{id:"v-drain_tank",name:"Drain tank",type:"Tank"}]})`); await sleep(60);
await ev(`openWizard("garden");ui.wiz.step=3;ui.wiz.pick=null;render()`); await sleep(40);
check("Placement: placing only places, with a way to Device identification for adding", (await ev(`!document.querySelector("#wiz-vname") && !!document.querySelector("[data-weditdevs]")`)) === true);
check("Placement: a virtual device from Device identification is listed with its type, needing a place", (await ev(`document.querySelector('[data-pick="v-drain_tank"]').textContent`)).includes("Drain tank Tank") && (await ev(`document.querySelector('[data-pick="v-drain_tank"]').textContent`)).includes("Needs placing"));
await clickIt('[data-pick="v-drain_tank"]');
check("Placement: it has to be placed before saving", (await nextOff()) === true && (await ev(`document.querySelector('.fixlink[data-pick]')?.textContent || ""`)).includes("Place Drain tank to save") && (await spotLabel("3,3")) === "Outside the wall, by unit 12", await spotLabel("3,3"));
await svgClick('[data-spot="3,3"]');
await shot("placement-virtual-phone");
await wizNext();
check("Placement: the review lists the virtual device and where it goes", /Drain tank, virtual[^]*Not placed[^]*Outside the wall, by unit 12/.test(await modalText()), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
const virtDisk = await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="garden").virtual`);
check("Placement: it's stored with the zone, as a name, a type and a spot only", same(virtDisk, [{ id: "v-drain_tank", name: "Drain tank", type: "Tank", pos: [3, 3] }]), virtDisk);
await ev(`ui.screen="zone";ui.zone="garden";ui.level="all";render()`); await sleep(40);
await svgClick('[data-mapvirt="v-drain_tank"]');
check("Placement: it shows on the zone's map, which grows to fit outside the wall, and says it's virtual", (await ev(`document.querySelector("#main .detail").textContent`)).includes("Virtual device. Home Assistant doesn't have it") && (await ev(`document.querySelector("#main .map svg").viewBox.baseVal.height`)) > (await ev(`geom(zoneById("garden").layout).H`)));
await ev(`ui.screen="setup";openMap("garden");ui.mapw.step=2;render()`); await sleep(40);
await clickIt('[data-mvremove="v-drain_tank"]'); await ev(`ui.mapw.roles.plug="Other";ui.mapw.step=3;render()`); await sleep(30);
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(40);
check("Placement: removing one, in Device identification, is reviewed too", /Drain tank \(virtual\)[^]*Drain tank, tank[^]*Removed/.test(await modalText()), await modalText());
await clickIt("[data-rapply]"); await sleep(400);
check("Placement: and it's gone from storage", (await onHA(`JSON.parse(fakeHA.disk).zones.find(z=>z.id==="garden").virtual`)) === undefined);
await ev(`devices.find(d=>d.id==="plug").type=null;render()`);
const virtEntity = await evp(`saveConfig(()=>{zoneById("garden").virtual=[{id:"v-x",name:"X",pos:[0,0],entity:"switch.reservoir_pump"}]}).then(r=>[r.ok,r.error])`);
const virtOut = await evp(`saveConfig(()=>{zoneById("garden").virtual=[{id:"v-x",name:"X",pos:[9,0]}]}).then(r=>[r.ok,r.error])`);
check("Placement: the backend refuses a virtual device that names an entity, or sits off the map", virtEntity[0] === false && virtEntity[1].includes("isn't a name and a spot") && virtOut[0] === false && virtOut[1].includes("outside garden's map"), [virtEntity, virtOut]);
await ev(`ui.mapw=null;ui.screen="setup";openWizard("garden",[1,2]);ui.wiz.step=2;ui.wiz.rows=2;ui.wiz.units=8;render()`); await sleep(40);
check("Placement: shrinking the grid says which devices come off the map", /1 device no longer fits[^]*Heater/.test(await ev(`document.querySelector("#main").textContent`)), await ev(`document.querySelector("#main").textContent.slice(0,600)`));
await ev(`ui.wiz=null;ui.screen="setup";ui.guide={id:"garden"};zoneById("garden").setup={details:"done",devices:"done",layout:"done",place:"done",calibrate:"done",targets:"done"};render()`); await sleep(40);
check("Placement: the setup guide counts the step done, unplaced devices or not, as the panel does", (await ev(`document.querySelector("#g-place").textContent`)).includes("Done"), await ev(`document.querySelector("#g-place").textContent`));
await ev(`ui.guide=null;delete zoneById("garden").setup;render()`); await sleep(40);
check("Placement: Setup counts placed sensors, as the panel's row does", /3 of 3 sensors placed\./.test(await ev(`document.querySelector('[data-mapw="garden"]').closest(".task").textContent`)), await ev(`document.querySelector('[data-mapw="garden"]').closest(".task").textContent`));
await ev(`openMap("garden");ui.mapw.pickD.acfan=false;render()`); await sleep(40);
await evp(`(()=>{const m=ui.mapw;return saveConfig(()=>saveMap(m)).then(()=>{ui.mapw=null})})()`);
check("Placement: a device taken out of a zone loses its spot there", (await onHA(`JSON.parse(fakeHA.disk).devices.find(x=>x.id==="acfan").place`)) === undefined);
const placeOut = await evp(`saveConfig(()=>{devices.find(x=>x.id==="intake").place={garden:[5,0]}}).then(r=>[r.ok,r.error])`);
const placeWrong = await evp(`saveConfig(()=>{devices.find(x=>x.id==="intake").place={veg:[0,0]}}).then(r=>[r.ok,r.error])`);
const placeOdd = await evp(`saveConfig(()=>{devices.find(x=>x.id==="intake").place={garden:[0.3,0]}}).then(r=>[r.ok,r.error])`);
check("Placement: the backend refuses a spot off the map, between half-steps, or in a zone the device isn't in", placeOut[0] === false && placeOut[1].includes("outside garden's map") && placeOdd[0] === false && placeWrong[0] === false && placeWrong[1].includes("isn't in"), [placeOut, placeOdd, placeWrong]);
await reset();

// ---------- Linked zones: a zone linked to a parent shows what it shares with the parent read only, and never goes there
{
const both = async (name) => {
  await ev(`(()=>{const t=document.querySelector("#toast");if(t)t.hidden=true})()`);
  for (const look of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", { features: look === "dark" ? [{ name: "prefers-color-scheme", value: "dark" }] : [] }); await sleep(80);
    await shot(`${name}-phone-${look}`); await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(60); await shot(`${name}-desktop-${look}`); await phone(390, 844); await sleep(60);
  }
  await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(60);
};
await phone(390, 844); await reset(); await setupOnly();
/* Who says what under a zone's name. */
const linkLines = () => ev(`(()=>{const out={};for(const id of ["garden","veg","nursery"]){ui.screen="zone";ui.zone=id;render();out[id]=document.querySelector("#main .pagehead .zlinked")?.textContent||""}ui.screen="overview";render();out.overview=[...document.querySelectorAll("#main .zone-card")].map(c=>c.querySelector(".zlinked")?.textContent||"");ui.screen="setup";render();out.setup=[...document.querySelectorAll("#main .task")].filter(t=>t.querySelector("[data-zmenu]")).map(t=>t.querySelector(".zlinked")?.textContent||"");return out})()`);
let ll = await linkLines();
check("Linked: under the name, on its page, its Overview card and its Setup row, Nursery says it's linked to Veg, and Veg names Nursery", same(ll, { garden: "", veg: "Zone: Nursery is linked to this zone", nursery: "Linked to Zone: Veg", overview: ["", "Zone: Nursery is linked to this zone", "Linked to Zone: Veg"], setup: ["", "Zone: Nursery is linked to this zone", "Linked to Zone: Veg"] }), ll);
await both("linked-overview");
/* Zone details: a tick box, then the parent from radio chips, never a select. A linked zone isn't offered as a parent. */
const detailsLinked = () => ev(`(()=>{const box=document.querySelector("#wiz-linked"),t=document.querySelector("#wiz-linkme"),f=box&&box.querySelector("fieldset.chips");return {tick:t?t.checked:null,tickLabel:t?t.closest("label").textContent:null,chips:f?[...f.querySelectorAll("label.chip")].map(l=>l.textContent+(l.querySelector("input").checked?"*":"")):null,legend:f?f.querySelector("legend").textContent:null,line:box?box.textContent.replace(/\\s+/g," ").trim():"",selects:document.querySelectorAll("select").length,next:document.querySelector('[data-wiz="next"]').disabled,fix:document.querySelector("#wiz-parent-fix")?.textContent||""}})()`);
await ev(`openNewZone();render()`); await sleep(40); await tap("#wiz-name"); await type("Bench");
let dl = await detailsLinked();
check("Linked: Add zone's first step has the tick box, unticked, and no parent choice yet", dl.tick === false && dl.tickLabel === "This is a linked zone" && dl.chips === null && dl.next === false && dl.line.endsWith("A linked zone is part of the same space as its parent. What it shares with the parent is set in the parent."), dl);
await tap("#wiz-linkme"); dl = await detailsLinked();
check("Linked: ticking it shows the parent as radio chips, every zone that isn't itself linked, in Overview's order, and Next waits for one", dl.tick === true && same(dl.chips, ["Zone: Garden", "Zone: Veg"]) && dl.legend === "Linked to" && dl.selects === 0 && dl.next === true && dl.fix === "Pick the zone it's linked to ›" && (await ev(`document.activeElement.id`)) === "wiz-linkme", dl);
await both("linked-details-add");
await tap("#wiz-parent-fix");
check("Linked: the bar's prompt lands on the choice", (await ev(`document.activeElement.id`)) === "wiz-linked");
await tap('[data-wparent="garden"]'); dl = await detailsLinked();
check("Linked: picking one opens Next, focus staying on the chip", same(dl.chips, ["Zone: Garden*", "Zone: Veg"]) && dl.next === false && dl.fix === "" && (await ev(`document.activeElement.matches('[data-wparent="garden"]')`)) === true, dl);
await tap("#wiz-linkme"); dl = await detailsLinked();
check("Linked: unticking clears the parent", dl.tick === false && dl.chips === null && (await ev(`ui.wiz.parent`)) === "" && dl.next === false, dl);
await tap("#wiz-linkme"); dl = await detailsLinked();
check("Linked: ticked again, nothing is picked until you pick it", same(dl.chips, ["Zone: Garden", "Zone: Veg"]) && dl.next === true, dl);
await tap('[data-wparent="garden"]');
await cClick('[data-wiz="next"]');
check("Linked: the review lists it like the rest of Zone details", (await ev(`document.querySelector("#review-items").textContent`)).includes("Linked toNot linked → Zone: Garden"), await ev(`document.querySelector("#review-items")?.textContent`));
const reviewNotes = () => ev(`[...document.querySelectorAll("#modal .review-scroll > p.small")].map(p=>p.textContent).join(" ")`);
const namesOnDisk = () => onHA(`JSON.parse(fakeHA.disk).zones.map(z=>z.name)`);
check("Linked: the review says the new zone moves next to its parent, as that shows on every page", (await reviewNotes()).includes("Bench moves next to Garden on Overview, in the menu and on Setup."), await reviewNotes());
const zonesBefore = await ev(`zones.length`);
await cClick("[data-rapply]"); await sleep(300);
const bench = await ev(`zones.find(z=>z.name==="Bench").id`);
check("Linked: it's stored at the end of its parent's family, so the family stays together", same(await namesOnDisk(), ["Garden", "Bench", "Veg", "Nursery"]), await namesOnDisk());
check("Linked: it's created linked to Garden, and nothing else about setting it up changes", (await ev(`zones.length`)) === zonesBefore + 1 && (await diskZone(bench)).parent === "garden" && (await ev(`ui.screen==="setup" && !!ui.guide && ui.guide.id==="${bench}"`)) === true, await diskZone(bench));
await ev(`ui.guide=null;openWizard("nursery",[0]);render()`); await sleep(40);
dl = await detailsLinked();
check("Linked: opened later, Zone details has the same controls, Nursery's ticked with Veg picked, and Bench, itself linked, not offered", dl.tick === true && same(dl.chips, ["Zone: Garden", "Zone: Veg*"]) && dl.next === false, dl);
await both("linked-details-nursery");
await ev(`openWizard("veg",[0]);render()`); await sleep(40); dl = await detailsLinked();
check("Linked: a zone with zones linked to it says so in place of the tick box", dl.tick === null && dl.chips === null && dl.line === "Zone: Nursery is linked to this zone, so it can't be linked to another.", dl);
await ev(`openWizard("garden",[0]);render()`); await sleep(40); dl = await detailsLinked();
check("Linked: Garden, a parent itself now, says so too", dl.tick === null && dl.line === "Zone: Bench is linked to this zone, so it can't be linked to another.", dl);
await ev(`openWizard("${bench}",[0]);render()`); await sleep(40); await tap("#wiz-linkme"); await cClick('[data-wiz="next"]');
check("Linked: unticking an existing link is reviewed too", (await ev(`document.querySelector("#review-items").textContent`)).includes("Linked toZone: Garden → Not linked"), await ev(`document.querySelector("#review-items")?.textContent`));
await cClick("[data-rapply]"); await sleep(300);
check("Linked: applied, the parent is gone", (await diskZone(bench)).parent === undefined && same((await linkLines()).garden, ""), await diskZone(bench));
check("Linked: unlinked, it stays where it was, on its own", same(await namesOnDisk(), ["Garden", "Bench", "Veg", "Nursery"]), await namesOnDisk());
await ev(`openWizard("${bench}",[0]);render()`); await sleep(40); await tap("#wiz-linkme"); await tap('[data-wparent="garden"]'); await cClick('[data-wiz="next"]');
check("Linked: linked again where it already sits next to its parent, the review says nothing about moving", !(await reviewNotes()).includes("moves next to"), await reviewNotes());
await cClick("[data-rapply]"); await sleep(300);
check("Linked: and linked again", (await diskZone(bench)).parent === "garden");
check("Linked: applying it stays on Zone details, ticked, with Finish to go on (#156)", (await ev(`!!ui.wiz && ui.wiz.id==="${bench}" && ui.wiz.step===0 && document.querySelector("#wiz-linkme").checked && document.querySelector('[data-wiz="next"]').textContent==="Finish"`)) === true, await ev(`[!!ui.wiz, document.querySelector('[data-wiz="next"]')?.textContent]`));
await setupOnly();
/* The fake backend refuses what the panel never offers. */
const linkSave = (change) => evp(`saveConfig(()=>{${change}}).then(r=>[r.ok,r.error||""])`);
const refusedLinks = [
  await linkSave(`zoneById("garden").parent="garden"`),
  await linkSave(`zoneById("${bench}").parent="nursery"`),
  await linkSave(`zoneById("veg").parent="garden"`),
  await linkSave(`zoneById("${bench}").parent="attic"`),
];
check("Linked: the backend refuses a zone linked to itself, a second level, a parent for a zone that has linked zones, and a parent that doesn't exist", same(refusedLinks.map((r) => r[0]), [false, false, false, false]) && refusedLinks[0][1].includes("can't be linked to itself") && refusedLinks[1][1].includes("itself linked to another") && refusedLinks[2][1].includes("has zones linked to it") && refusedLinks[3][1].includes("doesn't exist") && (await diskZone("garden")).parent === undefined && (await diskZone("veg")).parent === undefined && (await diskZone(bench)).parent === "garden", refusedLinks);
/* The parent's automations, read only, on each chip. */
const fromCard = () => ev(`(()=>{const c=document.querySelector("#modal [data-fromzone]");return c && {head:c.querySelector("h3").textContent,hint:c.querySelector("p").textContent,rows:[...c.querySelectorAll("[data-autorow]")].map(r=>r.dataset.autorow),sw:[...c.querySelectorAll(".sw")].map(b=>[b.getAttribute("aria-disabled"),b.title,b.disabled,b.tabIndex>=0,!!b.dataset.auto]),links:c.querySelectorAll("a,[data-go],[data-zone] button:not(.sw)").length,last:c===[...document.querySelectorAll("#modal section.card")].at(-1)}})()`);
for (const page of ["alert", "failsafe", "control"]) {
  await openAutosAt("nursery", page);
  const fc = await fromCard(), want = await ev(`autosOf(zoneById("veg"),"${page}").map(a=>a.entity)`);
  check(`Linked: Nursery's ${page} chip ends with a From Zone: Veg card holding Veg's, in Veg's order, each switch read only`, !!fc && fc.head === "From Zone: Veg" && fc.hint === "These belong to Zone: Veg and run devices this zone shares. Edit in Veg." && same(fc.rows, want) && want.length > 0 && fc.sw.every((x) => same(x, ["true", "Edit in Zone: Veg", false, true, false])) && fc.links === 0 && fc.last, [fc, want]);
  check(`Linked: and no Link automations in the dialog on ${page}, linked zone or not`, (await ev(`!document.querySelector("#modal [data-linkautos]") && !document.querySelector("#main [data-linkautos]")`)) === true);
  await both(`linked-autos-${page}`);
}
/* #111: a chip whose group holds the parent's automations carries an asterisk after its own count, said in words too. */
const starNow = () => ev(`({chips:[...document.querySelectorAll('#modal [data-autopage]')].map(b=>{const s=b.querySelector(".segn .star");return [b.dataset.autopage,b.querySelector(".segn").textContent,s?s.getAttribute("aria-hidden"):"",b.getAttribute("aria-label")]}),line:document.querySelector("#autos-star")?.textContent||"",lineIn:!!document.querySelector("#modal .autoshead #autos-star")})`);
const ownN = await ev(`["alert","failsafe","control"].map(p=>autosOf(zoneById("nursery"),p).length)`), vegN = await ev(`["alert","failsafe","control"].map(p=>autosOf(zoneById("veg"),p).length)`);
let st = await starNow();
const starWant = (vn) => ["alert", "failsafe", "control"].map((k, i) => { const t = { alert: "Alerts", failsafe: "Failsafes", control: "Control" }[k], n = ownN[i]; return [k, `${n}/${n}${vn[i] ? "*" : ""}`, vn[i] ? "true" : "", `${t}, ${n ? `${n} of ${n} on` : "none linked"}${vn[i] ? ", and Zone: Veg has some that also run here" : ""}`]; });
check("Linked: the chips count Nursery's own automations, an asterisk after the count on each group holding Veg's, in words to a screen reader", same(st.chips, starWant(vegN)) && vegN.every((n) => n > 0), [st, ownN, vegN]);
check("Linked: one line by the chips says what the asterisk means", st.line === "* Zone: Veg has automations in this group that also run here." && st.lineIn, st);
await ev(`window.keptVeg=zoneById("veg").automations;zoneById("veg").automations=keptVeg.filter(a=>AUTO_GROUPS[a.group][0]!=="control")`); await openAutosAt("nursery", "alert");
st = await starNow();
check("Linked: a group with none of Veg's gets no asterisk", same(st.chips, starWant([vegN[0], vegN[1], 0])), st);
await ev(`zoneById("veg").automations=keptVeg`);
await openAutosAt("garden", "alert"); st = await starNow();
check("Linked: a zone linked to none has no asterisk and no line", st.chips.every((c) => !c[1].includes("*") && !c[2]) && st.line === "", st);
/* #111: a tick box shows or hides the From card, as Show automations in other zones does in Link automations. */
const fromOpt = () => ev(`(()=>{const b=document.querySelector("#modal [data-ufrom]");return {box:b&&[b.tagName,b.className,b.textContent,b.getAttribute("aria-pressed")],card:!!document.querySelector("#modal [data-fromzone]"),stars:document.querySelectorAll("#modal [data-autopage] .star").length,line:!!document.querySelector("#autos-star"),focus:document.activeElement.hasAttribute("data-ufrom")}})()`);
check("Linked: a zone linked to none has no Show automations tick box", (await fromOpt()).box === null);
await openAutosAt("nursery", "failsafe");
let fo = await fromOpt();
check("Linked: Nursery's dialog has a Show automations from Zone: Veg tick box, the same control as Link automations', on, with the card shown", same(fo.box, ["BUTTON", "chip", "Show automations from Zone: Veg", "true"]) && fo.card, fo);
await tap("#modal [data-ufrom]"); fo = await fromOpt();
check("Linked: ticking it off hides the From card, keeps the asterisks and their line, and keeps focus", same(fo.box.slice(3), ["false"]) && !fo.card && fo.stars === 3 && fo.line && fo.focus, fo);
await tap('#modal [data-autopage="alert"]');
check("Linked: it stays hidden on another chip", (await fromOpt()).card === false);
await tap("#modal [data-ufrom]");
check("Linked: and ticking it again shows it", (await fromOpt()).card === true && same((await fromOpt()).box.slice(3), ["true"]));
await tap("#modal [data-ufrom]"); await tap("[data-uclose]"); await openAutosAt("nursery", "failsafe");
check("Linked: opened again, it's on, as Show automations in other zones starts off each time Link automations opens", (await fromOpt()).card === true);
await openAutosAt("nursery", "failsafe"); await clearToast();
let nCalls = (await haCalls()).length;
/* #111: a tap on what's read only answers in the same dialog Link automations shows, over the Automations dialog. */
const notHereNow = () => ev(`(()=>{const o=document.querySelector("#modal > .modal.over .dialog")||document.querySelector("#modal .dialog");return o && {role:o.getAttribute("role"),title:o.querySelector("#dlg-title").textContent,text:o.querySelector("#dlg-text").textContent,buttons:[...o.querySelectorAll(".dlgfoot button")].map(b=>b.textContent+"|"+b.className),focus:document.activeElement.id,over:!!document.querySelector("#modal > .modal.over")}})()`);
await ev(`(()=>{window.autosWas=document.querySelector("#modal [data-autosdlg]");const s=document.querySelector("#autos-scroll");s.scrollTop=s.scrollHeight;window.autosTop=s.scrollTop})()`);
for (const look of ["light", "dark"]) {
  await send("Emulation.setEmulatedMedia", { features: look === "dark" ? [{ name: "prefers-color-scheme", value: "dark" }] : [] }); await sleep(80);
  await ev(`document.querySelector("#autos-scroll").scrollTop=window.autosTop`); await shot(`linked-from-card-phone-${look}`);
}
await send("Emulation.setEmulatedMedia", { features: [] }); await sleep(60);
await tap('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .sw');
let nh = await notHereNow();
check("Linked: tapping a read only switch switches nothing and opens the one-button dialog, titled with its name, over the Automations dialog", same(nh, { role: "alertdialog", title: "Failsafe Veg Fans Auto On", text: "This automation is associated to Zone: Veg. Please edit it in Veg.", buttons: ["OK|btn primary"], focus: "dlg-title", over: true }) && (await haCalls()).length === nCalls && (await onHA(`fakeHA.states["automation.failsafe_veg_fans_auto_on"].state`)) === "on", nh);
check("Linked: and raises no toast, and goes nowhere", (await toastNow()) === "" && (await ev(`ui.screen==="zone" && ui.zone==="nursery" && ui.autos.zone==="nursery"`)) === true, await toastNow());
await both("linked-not-here-auto");
await ev(`window.autosTop=document.querySelector("#autos-scroll").scrollTop`);
await tap("[data-gkeep]"); bt = await backTo();
check("Linked: OK closes it, back to the Automations dialog on its chip, where it was scrolled, the switch focused", bt.same && !bt.over && bt.chip === "failsafe" && bt.top === bt.was && bt.focus === "automation.failsafe_veg_fans_auto_on" && (await ev(`!ui.guard`)) === true, bt);
await tap('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .sw'); await key("Escape", 27);
check("Linked: Escape closes only that dialog, the Automations dialog staying open", (await ev(`!ui.guard && !!ui.autos && !document.querySelector("#modal > .modal.over")`)) === true);
await tap('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .sw'); await tellBack();
check("Linked: and so does Back", (await ev(`!ui.guard && !!ui.autos && !document.querySelector("#modal > .modal.over")`)) === true);
/* #111: what's read only reads as not yours before it's tapped, by one shared look: no accent colour on its icon or switch,
   controls at --ro-dim, a dashed --ro-surface outline barely off the card, its name in --ro-fg at 4.5:1 on that and its
   second line at 3:1. */
const grey = (c) => { const v = (c.match(/[\d.]+/g) || []).slice(0, 3); return v.length === 3 && v[0] === v[1] && v[1] === v[2]; };
const roTiled = (r, ed) => !!r && !!ed && r.tile === r.roBg && r.tile !== ed.tile && r.rowBorder === "dashed" && ed.rowBorder !== "dashed" && [r.icFill, r.icBg, r.knob, r.swBorder].every(grey) && r.nameRatio >= 4.5 && r.subRatio >= 3;
const roLook = (sel) => ev(`(()=>{const tok=(n,p)=>{const e=document.createElement("span");e.style[p]="var("+n+")";document.body.append(e);const c=getComputedStyle(e)[p];e.remove();return c};
  const lum=(c)=>{const v=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4});return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2]};
  const bgOf=(e)=>{for(;e;e=e.parentElement){const b=getComputedStyle(e).backgroundColor;if(b&&!/rgba\\(.*, 0\\)|transparent/.test(b))return b}return "rgb(255, 255, 255)"};
  const ratio=(e)=>{const a=lum(getComputedStyle(e).color),b=lum(bgOf(e));return Math.round((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)*100)/100};
  const el=document.querySelector(${JSON.stringify("SEL")});if(!el)return null;const cs=getComputedStyle(el),row=el.closest(".dev"),name=row&&row.querySelector(".dev-name");
  return {dim:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ro-dim")),op:parseFloat(cs.opacity),cursor:cs.cursor,color:cs.color,bg:cs.backgroundColor,roFg:tok("--ro-fg","color"),roBg:tok("--ro-surface","backgroundColor"),tile:row?getComputedStyle(row).backgroundColor:"",rowBorder:row?getComputedStyle(row).borderTopStyle:"",icFill:row&&row.querySelector(":scope > .ic svg")?getComputedStyle(row.querySelector(":scope > .ic svg")).fill:"",icBg:row&&row.querySelector(":scope > .ic")?getComputedStyle(row.querySelector(":scope > .ic")).backgroundColor:"",
    knob:row&&row.querySelector(".sw i")?getComputedStyle(row.querySelector(".sw i")).backgroundColor:"",swBorder:row&&row.querySelector(".sw")?getComputedStyle(row.querySelector(".sw")).borderTopColor:"",subRatio:row&&row.querySelector(".dev-sub")?ratio(row.querySelector(".dev-sub")):0,
    name:name?getComputedStyle(name).color:"",nameRatio:name?ratio(name):0,ratio:ratio(el)}})()`.replace('"SEL"', JSON.stringify(sel)));
const roDimmed = (r) => !!r && r.dim === 0.45 && r.op === r.dim && r.cursor === "not-allowed";
const edAuto = await roLook('#modal [data-autorow]:not([data-from]) .sw:not(:disabled)'), roAuto = await roLook('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .sw');
const fromText = await ev(`(()=>{const c=document.querySelector("#modal [data-fromzone]"),h=c.querySelector("h3"),p=c.querySelector("p");const own=document.querySelector("#modal [data-autorow]:not([data-from])").closest("section")?.querySelector("h3");return [!!own&&own!==h&&getComputedStyle(h).color===getComputedStyle(own).color&&getComputedStyle(h).opacity==="1",getComputedStyle(p).color===getComputedStyle(document.querySelector("#modal [data-autorow]:not([data-from]) .dev-sub")).color,getComputedStyle(c).opacity]})()`);
check("Linked: a read only switch in the From card is dimmed by the shared look, its name in the lower-contrast colour and still 4.5:1, where this zone's own switch isn't; no accent colour on its icon or switch where this zone's own has it, on a dashed near-card outline, second line 3:1; the card's heading and line aren't dimmed", roDimmed(roAuto) && roTiled(roAuto, edAuto) && !grey(edAuto.icFill) && !grey(edAuto.knob) && roAuto.name === roAuto.roFg && roAuto.nameRatio >= 4.5 && !!edAuto && edAuto.op === 1 && edAuto.cursor !== "not-allowed" && edAuto.name !== roAuto.name && same(fromText, [true, true, "1"]), { roAuto, edAuto, fromText });
await tap('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .sw');
check("Linked: dimmed, it still takes the tap that opens the dialog", ((await notHereNow()) || {}).title === "Failsafe Veg Fans Auto On"); await tap("[data-gkeep]");
/* #113: the whole tile is the target, and only its switch takes focus. */
const tileCur = await ev(`[getComputedStyle(document.querySelector('#modal [data-fromzone] [data-autorow] .dev-name')).cursor,getComputedStyle(document.querySelector('#modal [data-autorow]:not([data-from]) .dev-name')).cursor]`);
await tap('#modal [data-fromzone] [data-autorow="automation.failsafe_veg_fans_auto_on"] .dev-name');
const nhName = ((await notHereNow()) || {}).title; await tap("[data-gkeep]");
const fsRow = await ev(`(()=>{const s=document.querySelector('#modal [data-autorow]:not([data-from]) .sw.on[data-auto]:not(:disabled)');return s&&s.closest("[data-autorow]").dataset.autorow})()`);
await tap(`#modal [data-autorow="${fsRow}"] .dev-name`);
const fsAsk = await ev(`ui.guard && ui.guard.title`); await ev(`ui.guard=null;renderModal()`); await sleep(40);
check("Linked: a tap on a tile's name answers as its control does: not here on a read-only row, the failsafe question on an editable failsafe that is on; the cursor says which", nhName === "Failsafe Veg Fans Auto On" && /^Switch off /.test(fsAsk || "") && same(tileCur, ["not-allowed", "pointer"]), { nhName, fsAsk, tileCur });
await openAutosAt("nursery", "alert");
const swState = (e) => ev(`(()=>{const s=document.querySelector('#modal [data-autorow="${e}"] .sw');return s?s.getAttribute("aria-checked")+(s.disabled?"-busy":""):""})()`);
const tgRow = await ev(`(()=>{const s=document.querySelector('#modal [data-autorow]:not([data-from]) .sw[data-auto]:not(:disabled)');return s&&s.closest("[data-autorow]").dataset.autorow})()`);
const tgWas = await swState(tgRow), tgSeen = [];
for (let i = 0; i < 2; i++) {
  await tap(`#modal [data-autorow="${tgRow}"] .dev-name`);
  if (await ev(`!!ui.guard`)) { await ev(`ui.guard=null;renderModal()`); break; }
  for (let k = 0; k < 40 && /busy/.test(await swState(tgRow)); k++) await sleep(100);
  tgSeen.push(await swState(tgRow));
}
const flip = tgWas === "true" ? "false" : "true";
check("Automations: a tap on an editable row's name toggles its switch, and a second tap toggles it back", !!tgRow && same(tgSeen, [flip, tgWas]), { tgRow, tgWas, tgSeen });
const tabbed = [];
await ev(`document.querySelector('#modal [data-autorow] .sw').focus()`);
for (let i = 0; i < 6; i++) { await key("Tab", 9); tabbed.push(await ev(`(()=>{const a=document.activeElement;return a.matches(".dev")?"tile":a.matches(".sw")?"switch":a.tagName})()`)); }
check("Automations: Tab goes from switch to switch and never stops on a tile", tabbed.includes("switch") && !tabbed.includes("tile"), tabbed);
await openAutosAt("nursery", "failsafe");
await tap('#modal [data-fromzone] h3');
check("Linked: nothing in the card takes you to Veg", (await ev(`ui.screen==="zone" && ui.zone==="nursery" && !!ui.autos && !ui.guard`)) === true);
await ev(`ui.autos=null;renderModal()`);
/* The parent's failsafe off shows on the linked zone's page, as plain text. */
await onHA(`fakeHA.setState("automation.failsafe_veg_fans_auto_on","off",{})`); await sleep(120);
await ev(`ui.screen="zone";ui.zone="nursery";ui.autos=null;render();window.scrollTo(0,0)`); await sleep(40);
const pfs = () => ev(`(()=>{const n=document.querySelector("#parent-failsafe");return n && {text:n.textContent,tag:n.tagName,acts:n.querySelectorAll("button,a").length+(n.matches("button,a,[data-autos]")?1:0)}})()`);
let pf = await pfs();
check("Linked: Veg's failsafe off shows on Nursery's page, as a plain notice", same(pf, { text: "A failsafe in Zone: Veg is off: Failsafe Veg Fans Auto On. While it's off, nothing puts that hardware back. Edit in Veg.", tag: "DIV", acts: 0 }), pf);
await both("linked-zone-failsafe-off");
await tap("#parent-failsafe");
check("Linked: tapping it opens nothing", (await ev(`ui.screen==="zone" && ui.zone==="nursery" && !ui.autos`)) === true);
await onHA(`fakeHA.setState("automation.failsafe_tent_lights_recovery","off",{})`); await sleep(120); await ev(`render()`); await sleep(30);
check("Linked: several are counted", (await pfs()).text === "2 failsafes in Zone: Veg are off. While they're off, nothing puts that hardware back. Edit in Veg.", await pfs());
check("Linked: Veg's own page keeps its own notice, which opens its Automations page", (await ev(`ui.zone="veg";render();!document.querySelector("#parent-failsafe") && !!document.querySelector('#main .notice.fix[data-autos="failsafe"]')`)) === true);
for (const e of ["automation.failsafe_veg_fans_auto_on", "automation.failsafe_tent_lights_recovery"]) await onHA(`fakeHA.setState("${e}","on",{})`);
await sleep(120);
check("Linked: back on, the notice goes", (await ev(`ui.zone="nursery";render();!document.querySelector("#parent-failsafe")`)) === true);
/* Nursery shares Veg's lights, so its day strip is Veg's whatever Nursery's own stored times say. */
await ev(`zoneById("nursery").dayAt=13*60;ui.screen="zone";ui.zone="nursery";render()`); await sleep(30);
const nStrip = await ev(`[document.querySelector("#main .strip").getAttribute("aria-label"),document.querySelector("#main .period-top .muted").textContent]`);
await ev(`zoneById("nursery").dayAt=16*60;render()`);
check("Linked: Nursery's day strip shows Veg's times, not its own", nStrip[0].startsWith("Lights on 16:00 to 10:00") && nStrip[1].startsWith("16:00 - 10:00"), nStrip);
/* Controls: every device Veg also has is read only in Nursery, and switchable in Veg and in Garden, which isn't linked. */
const devRow = (id, zone) => ev(`(()=>{const r=document.querySelector('[data-devrow="${id}"][data-zone="${zone}"]');return r && {sub:r.querySelector(".dev-sub").textContent,ro:[...r.querySelectorAll("button,input")].filter(x=>!x.matches(".fixlink")).map(x=>x.getAttribute("aria-disabled")==="true"||x.disabled),acts:r.querySelectorAll("[data-dev],[data-dialin],[data-dialstep],[data-dial]").length,title:r.querySelector(".sw").title}})()`);
await ev(`ui.screen="zone";ui.zone="nursery";render()`); await sleep(40);
const nDevs = await ev(`devices.filter(d=>d.ctl&&d.zones.includes("nursery")).map(d=>d.id)`);
const roRows = [];
for (const id of nDevs) roRows.push([id, await devRow(id, "nursery")]);
check("Linked: every device Nursery shares with Veg says it runs on Veg's automations, and every control on it is read only", nDevs.length > 0 && roRows.every(([, r]) => !!r && r.sub.includes("Runs on Zone: Veg's automations. Edit in Veg.") && !r.sub.includes("Shared with") && r.ro.every(Boolean) && r.acts === 0 && r.title === "Edit in Zone: Veg"), roRows);
await ev(`document.querySelector('[data-devrow="lp-tent"][data-zone="nursery"]').scrollIntoView({block:"center"})`); await both("linked-controls");
nCalls = (await haCalls()).length; await clearToast();
/* #111: each answers in the one-button dialog titled with the device's name, never a toast. */
const devAsk = async (sel) => { await tap(sel); const d = await notHereNow(), t = await toastNow(), where = await ev(`ui.screen+":"+ui.zone`); await tap("[data-gkeep]"); return [d && d.title, d && d.text, d && d.buttons.join(), t, where, await ev(`!ui.guard && document.querySelector("#modal").hidden`)]; };
const devName = (id) => ev(`devices.find(d=>d.id==="${id}").name`);
const DEV_SAYS = "This device runs on Zone: Veg's automations. Please control it in Veg.";
const a1 = await devAsk('[data-devrow="lp-tent"][data-zone="nursery"] .sw');
const a2 = await devAsk('[data-devrow="lc-tent"][data-zone="nursery"] .dial-steps button:last-child');
const modeWas = await ev(`[...document.querySelectorAll('[data-devrow="aux"][data-zone="nursery"] input[type=radio]')].findIndex(i=>i.checked)`);
const a3 = await devAsk('[data-devrow="aux"][data-zone="nursery"] label.chip:not(:has(input:checked))');
check("Linked: tapping a read only switch, dial step or mode chip sends nothing and opens the one-button dialog titled with the device's name, with no toast, staying on Nursery", (await haCalls()).length === nCalls && same([a1, a2, a3], [[await devName("lp-tent"), DEV_SAYS, "OK|btn primary", "", "zone:nursery", true], [await devName("lc-tent"), DEV_SAYS, "OK|btn primary", "", "zone:nursery", true], [await devName("aux"), DEV_SAYS, "OK|btn primary", "", "zone:nursery", true]]) && (await ev(`[...document.querySelectorAll('[data-devrow="aux"][data-zone="nursery"] input[type=radio]')].findIndex(i=>i.checked)`)) === modeWas, [a1, a2, a3, (await haCalls()).slice(nCalls)]);
await tap('[data-devrow="lp-tent"][data-zone="nursery"] .sw'); await both("linked-not-here-device"); await tap("[data-gkeep]");
const roDev = await roLook('[data-devrow="lp-tent"][data-zone="nursery"] .sw'), roDial = await roLook('[data-devrow="lc-tent"][data-zone="nursery"] .dial'), roChip = await roLook('[data-devrow="aux"][data-zone="nursery"] label.chip');
await ev(`ui.zone="garden";render()`); await sleep(30);
const edDev = await roLook('.dev[data-zone="garden"]:not(.ro) .dev-ctl .sw:not(:disabled)');
await ev(`ui.zone="nursery";render()`); await sleep(30);
check("Linked: a shared device's switch, dial and mode chips are dimmed by the shared look, its name in the lower-contrast colour and still 4.5:1, with no accent colour on its icon or switch, on a dashed near-card outline, second line 3:1, where an unlinked zone's aren't", [roDev, roDial, roChip].every(roDimmed) && roTiled(roDev, edDev) && roDev.name === roDev.roFg && roDev.nameRatio >= 4.5 && !!edDev && edDev.op === 1 && edDev.name !== roDev.name, { roDev, roDial, roChip, edDev });
check("Linked: dimmed, the device's switch still takes the tap that opens the dialog", (await devAsk('[data-devrow="lp-tent"][data-zone="nursery"] .sw'))[0] === (await devName("lp-tent")));
await ev(`ui.zone="veg";render()`); await sleep(30);
const vegTent = await devRow("lp-tent", "veg");
check("Linked: in Veg the same device is switched as ever, and its line names Nursery", !!vegTent && vegTent.acts > 0 && vegTent.ro.every((x) => !x) && vegTent.sub.includes("Shared with Nursery"), vegTent);
await ev(`ui.zone="garden";render()`); await sleep(30);
const gardenAux = await devRow("aux", "garden");
check("Linked: Garden isn't linked, so a device it shares with both stays switchable there", !!gardenAux && gardenAux.acts > 0 && gardenAux.ro.every((x) => !x) && !gardenAux.sub.includes("Runs on"), gardenAux);
check("Linked: a zone that isn't linked to one shows none of it: only the line naming the zone linked to it, no parent notice, no From card", (await ev(`(()=>{ui.screen="zone";ui.zone="garden";render();const a=document.querySelector("#main .pagehead .zlinked")?.textContent==="Zone: Bench is linked to this zone"&&!document.querySelector("#parent-failsafe");openAutos("garden","failsafe");const b=!document.querySelector("[data-fromzone]")&&!!document.querySelector("#modal [data-autosdlg]");ui.autos=null;renderModal();return a&&b})()`)) === true);
/* Targets, day and night: Nursery shares Veg's lights, so its day and night and red lights are Veg's; its own sensor keeps its targets its own. */
await ev(`openTd("nursery");render();window.scrollTo(0,0)`); await sleep(80);
const tdNow = () => ev(`(()=>{const sec=(id)=>{const s=document.querySelector(id);return {line:s.querySelector("[data-sharedline]")?.textContent||"",chips:s.querySelectorAll("fieldset.chips").length,boxes:[...s.querySelectorAll("input:not([type=radio])")].map(i=>[i.disabled||i.readOnly,i.title,!!i.dataset.sin])}};const t=document.querySelector("#td-targets");return {times:sec("#s-times"),red:sec("#s-emerson"),targets:{line:t.querySelector("[data-sharedline]")?.textContent||"",src:!!t.querySelector('[name="limits-src"]'),stages:t.querySelectorAll("[data-vstage]").length,boxes:[...t.querySelectorAll(".vcell input")].map(i=>i.disabled||i.readOnly),ro:t.querySelector("#vwrap").hasAttribute("data-ro")},bar:[...document.querySelectorAll("#pagebar button")].map(b=>b.textContent),draft:tdDraft(ui.td).items.length}})()`);
let td = await tdNow();
check("Linked: sharing Veg's lights, Nursery's day and night shows Veg's, read only, under one line, with no source to choose", td.times.line === "This zone shares Zone: Veg's lights, so its day and night are Veg's. Edit in Veg." && td.times.chips === 0 && td.times.boxes.length === 2 && td.times.boxes.every((b) => same(b, [true, "Edit in Zone: Veg", false])) && (await ev(`document.querySelector("#sro-day").value+"-"+document.querySelector("#sro-night").value`)) === (await ev(`hhmm(zoneById("veg").dayAt)+"-"+hhmm(zoneById("veg").nightAt)`)), td.times);
check("Linked: and its red lights are Veg's too", td.red.line === "This zone shares Zone: Veg's lights, so its red lights are Veg's. Edit in Veg." && td.red.chips === 0 && td.red.boxes.every((b) => b[0]), td.red);
/* #111: a tap on a read only box answers in the one-button dialog, titled with the setting, never a toast. */
const SET_SAYS = (z) => `These settings are Zone: ${z}'s. Please edit them in ${z}.`;
const setAsk = async (sel) => { await clearToast(); await tap(sel); const d = await notHereNow(), t = await toastNow(), where = await ev(`ui.screen+":"+!!ui.td`); await tap("[data-gkeep]"); return [d && d.title, d && d.text, d && d.buttons.join(), t, where, await ev(`!ui.guard`)]; };
check("Linked: tapping Nursery's day box opens the one-button dialog, Day and night, with no toast, staying on the page", same(await setAsk("#sro-day"), ["Day and night", SET_SAYS("Veg"), "OK|btn primary", "", "setup:true", true]), await setAsk("#sro-day"));
const roBox = await roLook("#sro-day"), edBox = await roLook("#td-targets input:not([type=radio]):not([readonly])");
check("Linked: a read only day box has the muted box and lower-contrast figures of the shared look, at 4.5:1 or better, not opacity, where an editable box doesn't", !!roBox && roBox.bg === roBox.roBg && roBox.color === roBox.roFg && roBox.op === 1 && roBox.ratio >= 4.5 && roBox.cursor === "not-allowed" && !!edBox && edBox.color !== roBox.color && edBox.bg !== roBox.bg, { roBox, edBox });
/* Veg uses no red lights in the sample, so for this one check it borrows Garden's, set in Environment Control. */
await ev(`window.vegEm=[zoneById("veg").emersonMode,zoneById("veg").emerson];Object.assign(zoneById("veg"),{emersonMode:"fixed",emerson:{...zoneById("garden").emerson}});render()`); await sleep(40);
check("Linked: and a red lights box opens it titled Red lights", same(await setAsk("#s-emerson input"), ["Red lights", SET_SAYS("Veg"), "OK|btn primary", "", "setup:true", true]), await setAsk("#s-emerson input"));
await ev(`Object.assign(zoneById("veg"),{emersonMode:vegEm[0],emerson:vegEm[1]});if(vegEm[0]===undefined)delete zoneById("veg").emersonMode;if(vegEm[1]===undefined)delete zoneById("veg").emerson;render()`); await sleep(40);
check("Linked: Nursery's own sensor keeps its targets its own, editable as in any zone", td.targets.line === "" && td.targets.src && td.targets.stages === 4 && td.targets.boxes.every((d) => !d) && !td.targets.ro, td.targets);
check("Linked: with nothing changed there's nothing to review, and nothing read only can be", td.draft === 0, td);
await both("linked-targets-nursery");
/* A linked zone that shares an environment sensor with its parent: Bench, made above, takes one of Garden's. */
const gardenLeft = await ev(`JSON.stringify(zoneById("garden").sensors.find(s=>s.id==="g-left"))`);
await evp(`saveConfig(()=>{zoneById("${bench}").sensors=[{...JSON.parse(${JSON.stringify(gardenLeft)}),pos:null}]})`); await sleep(100);
check("Linked: it shares Garden's left environment sensor", (await diskZone(bench)).sensors.some((s) => s.id === "g-left"));
await ev(`ui.guide=null;ui.screen="zone";ui.zone="${bench}";ui.metric="temperature";ui.range=24;render();window.scrollTo(0,0)`); await sleep(80);
const benchTile = await ev(`(()=>{const t=[...document.querySelectorAll("#main .tile")].find(x=>x.querySelector(".name").textContent==="Temperature");return {range:[...t.querySelectorAll(".range b")].map(b=>b.textContent),pill:t.querySelector(".pill")?.textContent||"",bands:document.querySelectorAll('#chart rect[fill="var(--band)"]').length}})()`);
const gardenRange = await ev(`zoneById("garden").bands[period(zoneById("${bench}"))].temperature.map(v=>v===null?"-":String(v))`);
check("Linked: its tiles judge its readings against Garden's targets, and its History draws Garden's bands", same(benchTile.range, gardenRange) && benchTile.pill !== "No targets yet" && benchTile.bands > 0, [benchTile, gardenRange]);
const benchCard = await ev(`(()=>{ui.screen="overview";render();const c=[...document.querySelectorAll("#main .zone-card")].find(x=>x.querySelector("h2").textContent==="Bench");const r=c.querySelector(".mrow");return {unset:!!r.querySelector(".track.unset"),pill:r.querySelector(".pillcell").textContent,own:bandState(zoneById("${bench}"),"temperature")}})()`);
check("Linked: its Overview card judges it against Garden's targets too", !benchCard.unset && benchCard.pill !== "" && !/No targets/.test(benchCard.pill) && benchCard.own !== "unset", benchCard);
await ev(`ui.screen="zone";ui.zone="${bench}";render();window.scrollTo(0,0)`); await sleep(40);
await tap(MORE); await tap(`#zmenu--more [data-viewtargets="${bench}"]`); await sleep(60);
const tv = await ev(`(()=>{const d=document.querySelector("#modal .dialog");return {line:d.querySelector("#t-shared")?.textContent||"",set:!!d.querySelector("[data-tset]"),editin:d.querySelector("#t-editin")?.textContent||"",editTag:d.querySelector("#t-editin")?.tagName||"",first:d.querySelector("tbody td:nth-child(2)").textContent}})()`);
check("Linked: View targets shows Garden's, says why under the tables, and has plain text in place of Set targets", tv.line === "This zone shares a sensor with Zone: Garden, so its targets are Garden's. Edit in Garden." && !tv.set && tv.editin === "Edit in Zone: Garden" && tv.editTag === "SPAN" && tv.first === String(await ev(`zoneById("garden").bands.day.temperature[0]`)), tv);
await both("linked-view-targets-bench");
await tap("[data-tclose]");
await ev(`openTd("${bench}");render();window.scrollTo(0,0)`); await sleep(80);
td = await tdNow();
check("Linked: on Targets, day and night the whole Targets card is Garden's, read only: no source choice, no Athena stages, boxes disabled, the chart not draggable", td.targets.line === "This zone shares a sensor with Zone: Garden, so its targets are Garden's. Edit in Garden." && !td.targets.src && td.targets.stages === 0 && td.targets.boxes.length > 0 && td.targets.boxes.every(Boolean) && td.targets.ro && (await ev(`[...document.querySelectorAll("#td-targets .vcell input")].every(i=>i.title==="Edit in Zone: Garden"&&!i.dataset.vin)`)) === true, td.targets);
check("Linked: tapping one of Garden's target boxes opens the one-button dialog, Targets, with no toast", same(await setAsk("#td-targets .vcell input"), ["Targets", SET_SAYS("Garden"), "OK|btn primary", "", "setup:true", true]), await setAsk("#td-targets .vcell input"));
check("Linked: and so does a tap on the chart", same(await setAsk("#vwrap"), ["Targets", SET_SAYS("Garden"), "OK|btn primary", "", "setup:true", true]), await setAsk("#vwrap"));
check("Linked: it shares no lights, so its day and night are its own", td.times.line === "" && td.times.chips === 1, td.times);
await ev(`document.querySelector("#td-targets").scrollIntoView()`); await both("linked-targets-bench");
const benchBands = await ev(`JSON.stringify(ui.vpdw.bands)`);
const chartAt = await ev(`(()=>{const r=document.querySelector("#vwrap svg").getBoundingClientRect();return {x:r.left+r.width*0.3,y:r.top+r.height*0.5}})()`);
for (const type of ["mousePressed", "mouseMoved", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: chartAt.x + (type === "mouseMoved" ? 40 : 0), y: chartAt.y, button: "left", clickCount: 1 });
await sleep(80);
nCalls = (await haCalls()).length;
check("Linked: dragging the chart moves nothing, so there's nothing to review or send", (await ev(`JSON.stringify(ui.vpdw.bands)`)) === benchBands && (await ev(`tdDraft(ui.td).items.length`)) === 0 && !(await ev(`ui.vpdw.drag`)), await ev(`tdDraft(ui.td).items`));
/* A press on the read only chart is a tap like any other, so it answers in the one-button dialog (#111). */
check("Linked: and the press answers in the one-button dialog, Targets", (await ev(`ui.guard && ui.guard.title`)) === "Targets" && (await ev(`ui.guard.ok`)) === "OK", await ev(`ui.guard && ui.guard.title`));
await tap("[data-gkeep]");
await ev(`ui.td=null;ui.sched=null;ui.vpdw=null;render()`);
check("Linked: and nothing read only was sent or saved", (await haCalls()).length === nCalls && same((await diskZone(bench)).bands, await ev(`zoneById("${bench}").bands`)));
/* Given Garden's lights too, Bench has nothing of its own left on the page: the foot bar is Back, and Confirm while the step is open. */
await evp(`saveConfig(()=>{devices.filter(d=>d.type==="Light"&&d.zones.includes("garden")).forEach(d=>d.zones.push("${bench}"))})`); await sleep(100);
await ev(`openTd("${bench}");render();window.scrollTo(0,0)`); await sleep(80);
const bare = () => ev(`(()=>{const page=document.querySelector("#pagebar");return {shares:sharesLights(zoneById("${bench}"))&&sharesSensor(zoneById("${bench}")),editable:[...document.querySelectorAll("#main input,#main select,#main textarea,#main fieldset.chips,#main [data-vstage],#main [data-dreview]")].filter(e=>!e.disabled&&!e.readOnly&&!e.closest("#pagebar")).map(e=>e.id||e.outerHTML.slice(0,60)),bar:[...page.querySelectorAll("button")].filter(b=>!b.hidden).map(b=>b.textContent),pageHidden:page.hidden,draft:document.querySelector("#draftbar").hidden,intro:document.querySelector("#td-intro").textContent,note:document.querySelector("#confirm-note")?.textContent||"",issues:(document.querySelector("#s-issues").textContent+document.querySelector("#td-issues").textContent).trim()}})()`);
let fb = await bare();
check("Linked: sharing Garden's lights and a sensor, nothing on Targets, day and night can be edited, and the foot bar has only Back, with Confirm as for any zone", fb.shares && fb.editable.length === 0 && same(fb.bar, ["Back", "Confirm"]) && !fb.pageHidden && fb.draft && fb.issues === "" && fb.intro === "Everything on this page is Zone: Garden's, so there's nothing to change here. Edit in Garden." && fb.note === "Not confirmed yet. There's nothing to set here, so Confirm once you've looked.", fb);
await both("linked-targets-all-parent");
await cClick("[data-confirmstep]"); await sleep(300);
await ev(`openTd("${bench}");render()`); await sleep(80);
fb = await bare();
check("Linked: confirmed and opened again, it's Back alone", same(fb.bar, ["Back"]) && fb.note === "" && fb.draft && (await ev(`stepOpen(zoneById("${bench}"),"targets")`)) === false, fb);
await ev(`ui.td=null;ui.sched=null;ui.vpdw=null;render()`);
await evp(`saveConfig(()=>{devices.forEach(d=>{if(d.type==="Light")d.zones=d.zones.filter(x=>x!=="${bench}")})})`); await sleep(100);
/* Bench shares Garden's sensor, so neither unlinking it nor removing Garden can leave that sensor in two families. */
await ev(`openWizard("${bench}",[0]);render()`); await sleep(40); await tap("#wiz-linkme"); await cClick('[data-wiz="next"]'); await cClick("[data-rapply]"); await sleep(300);
const unlinkNo = await ev(`document.querySelector("#modal .notice.critical")?.textContent||""`);
check("Linked: unlinking a zone that shares its parent's sensor is refused, naming the sensor to take out first", unlinkNo.includes("Not saved. Environment left is in both Garden and Bench. Take it out of Bench before unlinking it.") && (await diskZone(bench)).parent === "garden", unlinkNo);
await cClick("[data-rback]"); await ev(`ui.review=null;ui.wiz=null;renderModal();render()`);
/* Removing a parent unlinks its zones, which stay. The Remove dialog says so first. */
await ev(`askRemoveZone("garden")`); await sleep(40);
const rmRow = await ev(`[...document.querySelectorAll("#modal .review-row")].map(r=>r.textContent).find(t=>t.startsWith("Linked zones"))||""`);
check("Linked: removing a parent lists its linked zones as unlinked", rmRow === "Linked zonesBench is unlinked", rmRow);
await ev(`(()=>{const i=document.querySelector("#dlg-confirm");i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await cClick("[data-gdiscard]"); await sleep(300);
check("Linked: but while Bench shares Garden's sensor, removing Garden is refused, naming the sensor", (await toastNow()).includes("Environment left is in both Garden and Bench. Take it out of Bench before removing Garden.") && !!(await diskZone("garden")) && (await ev(`!!zoneById("garden")`)) === true, await toastNow());
await evp(`saveConfig(()=>{zoneById("${bench}").sensors=[]})`); await sleep(100);
await ev(`zoneById("garden").parent=undefined;zoneById("${bench}").parent="veg";askRemoveZone("veg")`); await sleep(40);
/* Listed in the zone order, where Bench now sits next to Garden, the parent it was made under. */
const rmRows = await ev(`[...document.querySelectorAll("#modal .review-row")].map(r=>r.textContent).find(t=>t.startsWith("Linked zones"))||""`);
check("Linked: several are named together", rmRows === "Linked zonesBench and Nursery are unlinked", rmRows);
await both("linked-remove");
await key("Escape", 27); await ev(`zoneById("${bench}").parent="garden";delete zoneById("garden").parent;render()`);
/* Removing Bench's parent for real would take Garden, so Bench becomes a parent here instead: Shelf, linked to it. */
await evp(`saveConfig(()=>{zoneById("${bench}").parent=undefined;delete zoneById("${bench}").parent;zones.push({...JSON.parse(JSON.stringify(zoneById("${bench}"))),id:"shelf",name:"Shelf",sensors:[],parent:"${bench}"})})`); await sleep(100);
check("Linked: Shelf is stored linked to Bench", (await diskZone("shelf")).parent === bench, await diskZone("shelf"));
await ev(`askRemoveZone("${bench}")`); await sleep(40);
await ev(`(()=>{const i=document.querySelector("#dlg-confirm");i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))})()`); await cClick("[data-gdiscard]"); await sleep(300);
check("Linked: removed, Bench is gone and Shelf stays, unlinked, and shows none of it: no line, no parent notice, no From card", !(await diskZone(bench)) && !!(await diskZone("shelf")) && (await diskZone("shelf")).parent === undefined && (await ev(`(()=>{ui.screen="zone";ui.zone="shelf";render();const a=!document.querySelector("#main .zlinked")&&!document.querySelector("#parent-failsafe");openAutos("shelf","control");const b=!document.querySelector("[data-fromzone]")&&!!document.querySelector("#modal [data-autosdlg]");ui.autos=null;renderModal();return a&&b})()`)) === true, await diskZone("shelf"));
/* Straight against the fake, then put back: a save that drops Veg unlinks Nursery, which stays. */
const lone = await onHA(`(()=>{const keep={config:fakeHA.config,disk:fakeHA.disk,saves:fakeHA.saves.length};try{const c=JSON.parse(fakeHA.disk);fakeHA.save({revision:fakeHA.config.revision,config:{zones:c.zones.filter(z=>z.id!=="veg"),devices:c.devices.map(d=>({...d,zones:d.zones.filter(z=>z!=="veg")})).map(d=>{if(d.place)delete d.place.veg;return d}),room:c.room}});const n=JSON.parse(fakeHA.disk).zones.find(z=>z.id==="nursery");return [true,!!n&&n.parent===undefined]}catch(e){return [false,e.message]}finally{fakeHA.config=keep.config;fakeHA.disk=keep.disk;fakeHA.saves.length=keep.saves}})()`);
check("Linked: the backend itself unlinks the zones of a parent removed in the same save", same(lone, [true, true]), lone);
await evp(`saveConfig(()=>{zones.splice(zones.findIndex((z)=>z.id==="shelf"),1)})`); await sleep(100);
check("Linked: and the sample room is as it was, Nursery still linked to Veg", same(await ev(`zones.map(z=>z.id+":"+(z.parent||""))`), ["garden:", "veg:", "nursery:veg"]) && same(await onHA(`JSON.parse(fakeHA.disk).zones.map(z=>z.id)`), ["garden", "veg", "nursery"]), await ev(`zones.map(z=>z.id+":"+(z.parent||""))`));
}
await reset(); await setupOnly();

// ---------- Dialogs: a dialog's buttons are its own foot, and the bar pinned to the window is for pages
/* The dialog on top: a question asked from the Automations dialog sits over it. */
const dlgFit = () => ev(`(()=>{const m=document.querySelector("#modal"),d=m&&!m.hidden&&(m.querySelector(":scope > .modal.over .dialog")||m.querySelector(".dialog")),b=d&&d.querySelector(".dlgfoot"),t=d&&d.querySelector("#dlg-title, #autos-title");if(!b)return null;const r=d.getBoundingClientRect(),q=b.getBoundingClientRect(),h=t.getBoundingClientRect(),bs=[...b.querySelectorAll("button:not([hidden])")],k=bs.map(x=>x.getBoundingClientRect());return {title:t.textContent,inside:k.every(x=>x.left>=r.left-0.5&&x.right<=r.right+0.5&&x.top>=r.top-0.5&&x.bottom<=r.bottom+0.5),last:d.lastElementChild===b,foot:Math.abs(r.bottom-q.bottom-parseFloat(getComputedStyle(d).paddingBottom)-parseFloat(getComputedStyle(d).borderBottomWidth))<1.5,bg:getComputedStyle(b).backgroundColor,dbg:getComputedStyle(d).backgroundColor,position:getComputedStyle(b).position,onScreen:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,titleShown:h.top>=r.top&&h.bottom<=r.bottom,buttons:bs.map(x=>x.textContent),leaveFirst:bs[0].className==="btn"&&(bs.length<2||["btn primary","btn danger"].includes(bs[1].className))}})()`);
const dlgOk = (f) => !!f && f.inside && f.last && f.foot && f.position === "static" && f.onScreen && f.titleShown && f.leaveFirst;
/* WCAG contrast, the page's own primary colour, and computed styles, for the colour checks on dialogs and the foot bar. */
const LOOK_JS = `const rgb=(c)=>c.match(/[0-9.]+/g).slice(0,3).map(Number),lin=(v)=>(v/=255)<=0.03928?v/12.92:((v+0.055)/1.055)**2.4,lum=(c)=>{const [r,g,b]=rgb(c);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)},ratio=(a,b)=>{const x=lum(a),y=lum(b);return Math.round((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)*100)/100},cs=(e)=>getComputedStyle(e),prim=(()=>{const i=document.createElement("i");i.style.color="var(--primary)";document.body.append(i);const c=cs(i).color;i.remove();return c})();`;
const dlgLook = () => ev(`(()=>{${LOOK_JS}const d=document.querySelector("#modal > .modal.over .dialog")||document.querySelector("#modal .dialog"),f=d&&d.querySelector(".dlgfoot");if(!f)return null;const bs=[...f.querySelectorAll("button:not([hidden])")],go=bs.length>1?bs.at(-1):null,leave=bs[0],fb=cs(d).backgroundColor;return {divider:cs(f).borderTopStyle!=="none"&&parseFloat(cs(f).borderTopWidth)>0,red:!!go&&go.classList.contains("danger"),goBg:go&&cs(go).backgroundColor,prim,goText:go&&ratio(cs(go).color,cs(go).backgroundColor),leaveText:ratio(cs(leave).color,fb),leaveBorder:cs(leave).borderTopColor!==fb}})()`);
const dlgLookOk = (l) => !!l && l.divider && l.leaveBorder && l.leaveText >= 4.5 && (!l.goBg || l.red || (l.goBg === l.prim && l.goText >= 4.5));
const barLook = () => ev(`(()=>{${LOOK_JS}const b=[...document.querySelectorAll(".draftbar")].find(e=>!e.hidden&&e.getBoundingClientRect().height>0);if(!b)return null;const bg=cs(b).backgroundColor,body=cs(document.body),go=b.querySelector(".draft-review"),n=b.querySelector(".draft-count");return {bg,fg:body.color,page:body.backgroundColor,prim,goBg:go&&cs(go).backgroundColor,goText:go&&ratio(cs(go).color,cs(go).backgroundColor),text:ratio(cs(b).color,bg),plain:[...b.querySelectorAll(".draft-discard")].map(p=>ratio(cs(p).color,bg)),count:n&&ratio(cs(n).color,cs(n).backgroundColor),edge:cs(b).boxShadow.includes("0px 0px 0px 1px")}})()`);
const withAccent = (c) => ev(`(()=>{const r=document.documentElement;window.__acc=[r.style.getPropertyValue("--primary"),r.style.getPropertyValue("--on-primary")];r.style.setProperty("--primary","${c}");r.style.setProperty("--on-primary",onColor("${c}"))})()`);
const restoreAccent = () => ev(`(()=>{const r=document.documentElement,a=window.__acc||["",""];[["--primary",a[0]],["--on-primary",a[1]]].forEach(([k,v])=>v?r.style.setProperty(k,v):r.style.removeProperty(k))})()`);
/* 45 minutes, a value the helper doesn't hold at any point in the suite, so typing it is always a draft. */
const typeRepeat = (v) => ev(`(()=>{const i=document.querySelector("#repeat-in");i.value="${v}";i.dispatchEvent(new Event("input",{bubbles:true}));i.blur()})()`);
const DIALOGS = [
  ["targets", async () => { await goTab("Garden"); await tap(MORE); await tap('#zmenu--more [data-viewtargets="garden"]'); }, "[data-tclose]"],
  ["activity", async () => { await goTab("Garden"); await tap(MORE); await tap('#zmenu--more [data-viewactivity="garden"]'); }, "[data-aclose]"],
  ["automations", async () => { await goTab("Garden"); await tap(MORE); await tap('#zmenu--more [data-autos="alert"]'); }, "[data-uclose]"],
  ["automations-linked", async () => { await goTab("Nursery"); await tap(MORE); await tap('#zmenu--more [data-autos="alert"]'); await tap('#modal [data-autopage="failsafe"]'); }, "[data-uclose]"],
  ["discard", async () => { await openAutosAt("garden", "alert"); await typeRepeat(45); await tap('#modal [data-autopage="failsafe"]'); }, "[data-gkeep]"],
  ["review", async () => { await openAutosAt("garden", "alert"); await typeRepeat(45); await tap("#modal [data-ureview]"); }, "[data-rback]"],
  ["failsafe-off", async () => { await openAutosAt("garden", "failsafe"); await tap('[data-autorow="automation.failsafe_garden_lights_recovery"] .sw'); }, "[data-gkeep]"],
  ["share", async () => { await mOpen("nursery"); await ev(`ui.mapw.step=2;render()`); await tap('[data-mdevice="dehu"]'); }, "[data-gkeep]"],
  ["remove", async () => { await setupNow(); await tap('[data-zmenu="veg"]'); await cClick('[data-rmzone="veg"]'); }, "[data-gkeep]"],
];
for (const theme of ["light", "dark"]) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  for (const [w, h, size] of [[390, 844, "phone"], [1280, 900, "desktop"]]) {
    for (const [name, openIt, closeSel] of DIALOGS) {
      if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
      await reset(); await openIt(); await sleep(80);
      const f = await dlgFit();
      if (theme === "light") check(`Dialogs ${size}, ${name}: its buttons sit inside its box, as its foot, the leaving one first, and the whole dialog on screen`, dlgOk(f), f);
      check(`Dialogs ${size}, ${name}, ${theme}: its foot has no strip of its own, on the dialog's own background`, !!f && f.bg === f.dbg, f);
      const l = await dlgLook();
      check(`Dialogs ${size}, ${name}, ${theme}: a divider above its buttons, the leaving one outlined, the going-on one in the accent colour or red, each readable at 4.5:1`, dlgLookOk(l), l);
      if (name === "review" && size === "desktop") {
        await withAccent("#F44336"); const r = await dlgLook(); await restoreAccent();
        check(`Dialogs, review, ${theme}: with a red accent its going-on button is red with readable text`, dlgLookOk(r) && r.goBg === "rgb(244, 67, 54)", r);
      }
      await shot(`dialog-${name}-${size}${theme === "dark" ? "-dark" : ""}`);
      await tap(closeSel); await ev(`ui.mapw=null;ui.autos=null;ui.guard=null;ui.review=null;renderModal();render()`);
    }
  }
}
await send("Emulation.setEmulatedMedia", { features: [] });
await phone(390, 844); await reset();

// ---------- The bar pinned to the foot of the window: its own grey in both themes, the going-on button in the accent colour
const BARS = [
  ["wizard", async () => { await ev(`ui.screen="setup";openWizard("garden",[1,2]);render();window.scrollTo(0,0)`); await sleep(60); }],
  ["draft", async () => { await linkFromSetup("garden"); await tap('[data-lpick]:not([aria-disabled="true"])'); await sleep(60); }],
];
const barOk = (b) => !!b && b.bg !== b.fg && b.bg !== b.page && b.edge && b.text >= 4.5 && b.plain.length > 0 && b.plain.every((x) => x >= 4.5) && (b.count === null || b.count >= 4.5) && b.goBg === b.prim && b.goText >= 4.5;
for (const theme of ["light", "dark"]) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  for (const [w, h, size] of [[390, 844, "phone"], [1280, 900, "desktop"]]) {
    if (w === 1280) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); else await phone(w, h);
    for (const [name, openIt] of BARS) {
      await reset(); await openIt();
      const b = await barLook();
      check(`Foot bar ${size}, ${name}, ${theme}: a grey of its own, not the inverted colours, its text, count and plain buttons readable, the going-on button in the accent colour`, barOk(b), b);
      await withAccent("#F44336"); const r = await barLook(); await restoreAccent();
      check(`Foot bar ${size}, ${name}, ${theme}: with a red accent the going-on button is red with readable text`, barOk(r) && r.goBg === "rgb(244, 67, 54)", r);
      await shot(`bar-${name}-${size}${theme === "dark" ? "-dark" : ""}`);
      await ev(`if(ui.linkw)ui.linkw.pick={...ui.linkw.was};render()`);
    }
    await reset(); await openAutosAt("garden", "alert"); await sleep(20);
    await shot(`autos-head-${size}${theme === "dark" ? "-dark" : ""}`);
  }
}
await ev(`ui.autos=null;renderModal()`);
await send("Emulation.setEmulatedMedia", { features: [] });
await phone(390, 844); await reset();
await linkFromSetup("garden"); await tap('[data-lpick]:not([aria-disabled="true"])'); await sleep(40);
check("Dialogs: a page with a draft keeps its bar pinned to the foot of the window", (await ev(`(()=>{const b=document.querySelector("#draftbar"),r=b.getBoundingClientRect();return !b.hidden&&getComputedStyle(b).position==="fixed"&&r.bottom<=innerHeight&&r.bottom>innerHeight-40})()`)) === true);
await ev(`ui.linkw.pick={...ui.linkw.was};ui.linkw=null;render()`);
/* A long review, longer than any window: thirty changes, drawn by the review dialog itself. */
for (const [w, h, size] of [[390, 844, "phone"], [844, 390, "landscape"]]) {
  await phone(w, h); await reset();
  await ev(`ui.review={d:{zone:"Garden",items:Array.from({length:30},(_,i)=>({label:"Change "+(i+1),before:"Before",after:"After"})),skipped:[],note:"",apply:(done)=>done([])},busy:false,errors:[]};renderModal()`); await sleep(80);
  const f = await dlgFit(), scroll = await ev(`(()=>{const s=document.querySelector("#modal .review-scroll");return {rows:document.querySelectorAll("#review-items .review-row").length,scrolls:s.scrollHeight>s.clientHeight}})()`);
  check(`Dialogs ${size}: a long review scrolls its middle, its title and buttons in view inside the window`, dlgOk(f) && scroll.scrolls && scroll.rows === 30, [f, scroll]);
  await shot(`dialog-long-review-${size}`);
  await ev(`ui.review=null;renderModal()`);
}
await phone(390, 844); await reset();

// Removing a zone. Last, because it takes the fixture's zones with it, so nothing here can call reset().
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await phone(390, 844); await setupNow();
const zoneIds = () => ev(`zones.map(z=>z.id)`);
const startZones = await zoneIds();
/* The zone's menu is opened with a real tap, as a person opens it, which puts keyboard focus in the panel's frame.
   The dialog needs that for its title to take focus and for Escape and Enter to reach it: a scripted click gives no
   focus, and since Chrome 158 a frame that isn't focused can no longer take focus for itself from code. The item is
   then clicked from code, because at 320 px, under the design's 500 px floor, the menu hangs off the left edge. */
const askRemove = async (id) => { await tap(`[data-zmenu="${id}"]`); await cClick(`[data-rmzone="${id}"]`); };
const typeName = (text) => ev(`(()=>{const i=document.querySelector("#dlg-confirm");i.value=${JSON.stringify(text)};i.dispatchEvent(new Event("input",{bubbles:true}))})()`);
const removeOff = () => ev(`document.querySelector("[data-gdiscard]").disabled`);
const confirmRemove = async () => { await ev(`(()=>{const i=document.querySelector("#dlg-confirm");if(i){i.value=ui.guard.confirm;i.dispatchEvent(new Event("input",{bubbles:true}))}})()`); await cClick("[data-gdiscard]"); };
const dialog = () => ev(`document.querySelector("#modal").textContent`);
const mainText = () => ev(`document.querySelector("#main").textContent`);
const see = async (screen, zone) => { await ev(`ui.screen="${screen}";${zone ? `ui.zone="${zone}";` : ""}render();window.scrollTo(0,0)`); await sleep(40); return mainText(); };
const noJunk = (t) => !/NaN|undefined/.test(t);
check("Remove: every zone has the button, last in its row", (await ev(`zones.every(z=>document.querySelector('[data-mapw="'+z.id+'"]').parentElement.lastElementChild.dataset.rmzone===z.id)`)) === true);
const toRow = () => ev(`document.querySelector('[data-zmenu="garden"]').scrollIntoView({block:"center"})`);
await toRow(); await shot("remove-setup-phone");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await setupNow(); await toRow(); await shot("remove-setup-desktop"); await phone(390, 844); await setupNow();

await askRemove("garden");
const askText = await dialog();
check("Remove: it asks first, named after the zone", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Remove Garden?", askText);
check("Remove: the dialog says it can't be undone and that HA doesn't change", askText.includes("can't be undone") && askText.includes("Nothing in Home Assistant changes"), askText);
check("Remove: it names what goes", ["Placement", "Sensors", "Devices", "Targets", "Day and night"].every((w) => askText.includes(w)), askText);
check("Remove: shared hardware is shown staying in its other zones", /\d+ stay in Veg and Nursery/.test(askText), askText);

check("Remove: focus lands on the title, not the red button", (await ev(`document.activeElement.id`)) === "dlg-title", await ev(`document.activeElement.outerHTML.slice(0,60)`));
check("Remove: the page behind is locked", (await ev(`document.querySelector("#main").inert`)) === true);
check("Remove: nothing goes before confirming", same(await zoneIds(), startZones), await zoneIds());
check("Remove: it asks for the zone's name to be typed, and Remove stays off until it is", (await dialog()).includes("Type Garden to confirm") && (await removeOff()) === true);
check("Remove: the name box capitalises like every other text box", (await ev(`(()=>{const i=document.querySelector("#dlg-confirm"),n=document.createElement("input");n.type="text";return !i.hasAttribute("autocapitalize") && i.autocapitalize===n.autocapitalize})()`)) === true, await ev(`document.querySelector("#dlg-confirm").outerHTML`));
await cClick("[data-gdiscard]");
check("Remove: tapping Remove without the name does nothing", same(await zoneIds(), startZones) && (await ev(`!!ui.guard`)) === true);
await typeName("garden");
check("Remove: the name has to match exactly, case and all", (await removeOff()) === true);
await typeName("Garden ");
check("Remove: a stray space doesn't count", (await removeOff()) === true);
await typeName("Garden");
check("Remove: the exact name turns Remove on", (await removeOff()) === false);
await typeName("");
await shot("remove-dialog-phone");
await key("Escape", 27); await sleep(60);
check("Remove: Escape keeps the zone", same(await zoneIds(), startZones) && !(await ev(`!!ui.guard`)));
await askRemove("garden"); await ev(`document.querySelector("#modal").dispatchEvent(new MouseEvent("click",{bubbles:true}))`); await sleep(60);
check("Remove: tapping outside keeps the zone", same(await zoneIds(), startZones) && !(await ev(`!!ui.guard`)));
await askRemove("garden"); await cClick("[data-gkeep]");
check("Remove: Keep zone keeps the zone", same(await zoneIds(), startZones) && !(await ev(`!!ui.guard`)));
await phone(320, 640); await setupNow(); await askRemove("garden"); await sleep(60);
const tight = await ev(`(()=>{const b=document.querySelector("[data-gdiscard]").getBoundingClientRect(),d=document.querySelector(".dialog").getBoundingClientRect();return {bottom:b.bottom,top:d.top,h:innerHeight,w:innerWidth,right:d.right}})()`);
check("Remove: the dialog fits a 320x640 phone", tight.top >= 0 && tight.bottom <= tight.h && tight.right <= tight.w, tight);
await shot("remove-dialog-small");
await cClick("[data-gkeep]");
/* The keyboard takes the foot of the window, as a host that resizes for it has it: the box and the dialog's own buttons
   must both stay reachable, in view together where there's room for that. In view means not clipped by the dialog or
   its scrolling middle either, not only inside the window. */
for (const [w, h, name] of [[390, Math.round(844 * (1 - KEYBOARD.portrait)), "phone"], [844, Math.round(390 * (1 - KEYBOARD.landscape)), "landscape"]]) {
  await phone(390, 844); await setupNow(); await askRemove("garden"); await tap("#dlg-confirm");
  await phone(w, h); await sleep(150);
  const k = await ev(`(()=>{const i=document.querySelector("#dlg-confirm"),bs=[...document.querySelectorAll("#modal .dlgfoot button")],vis=(e)=>{const r=e.getBoundingClientRect();let ok=r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;for(let p=e.parentElement;p&&ok;p=p.parentElement){if(getComputedStyle(p).overflowY==="visible")continue;const q=p.getBoundingClientRect();ok=r.top>=q.top-1&&r.bottom<=q.bottom+1}return ok},reach=(e)=>{e.scrollIntoView({block:"nearest"});return vis(e)},out={focused:document.activeElement===i,both:vis(i)&&bs.every(vis)};out.buttons=bs.every(reach);out.box=reach(i);return out})()`);
  check(`Remove, keyboard up ${name}: the box and the buttons are both reachable${name === "phone" ? ", and in view together" : ""}`, k.focused && k.box && k.buttons && (name !== "phone" || k.both), k);
  await shot(`remove-dialog-keyboard-${name}`);
  await key("Escape", 27); await sleep(40);
}
await phone(390, 844); await setupNow();
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(60); await toRow(); await shot("remove-setup-dark"); await askRemove("garden"); await shot("remove-dialog-dark"); await cClick("[data-gkeep]");
await send("Emulation.setEmulatedMedia", { features: [] });

const beforeHeater = await ev(`devices.find(d=>d.id==="heater").zones`);
await ev(`ui.zone="garden"`); await askRemove("garden"); await typeName("Garden"); await ev(`document.querySelector("#dlg-confirm").focus()`); await key("Enter", 13); await sleep(60);
check("Remove: Enter in the box removes it once the name matches", !(await zoneIds()).includes("garden"), await zoneIds());
check("Remove: the zone goes", !(await zoneIds()).includes("garden"), await zoneIds());
check("Remove: its tab goes", !(await ev(`[...document.querySelectorAll("[data-go=zone]")].some(b=>b.dataset.zone==="garden")`)));
check("Remove: its activity and lights go", (await ev(`ACTIVITY.garden===undefined && LIGHTS.garden===undefined`)) === true);
check("Remove: no device still points at it", (await ev(`devices.every(d=>!d.zones.includes("garden"))`)) === true);
check("Remove: shared hardware stays in its other zones", same(await ev(`devices.find(d=>d.id==="heater").zones`), beforeHeater.filter((z) => z !== "garden")), await ev(`devices.find(d=>d.id==="heater").zones`));
check("Remove: the open zone moves to one that exists", (await ev(`!!zoneById(ui.zone)`)) === true, await ev(`ui.zone`));
check("Remove: it stays on Setup and says so", (await ev(`ui.screen`)) === "setup" && (await ev(`document.querySelector("#toast")?.textContent||document.querySelector(".toast").textContent`)).includes("Garden removed"));
check("Remove: focus lands on Add zone, not on nothing", (await ev(`document.activeElement.hasAttribute("data-addzone")`)) === true);
/* Devices' table, not the list of everything in Home Assistant below it, which keeps every device. */
const devicesTable = async () => { await see("devices"); return ev(`document.querySelector("#main table").textContent`); };
check("Remove: a Garden-only device leaves Devices, a shared one stays", await (async () => { const t = await devicesTable(); return !t.includes("Air conditioner exhaust fan") && t.includes("Heater") && noJunk(t); })());
check("Remove: Setup stops asking about a device that's no longer mapped", await (async () => { await see("setup"); return !(await ev(`!!document.querySelector("#task-plug")`)); })());
check("Remove: its sensors are still findable, once each and unplaced", (await ev(`(()=>{const c=catalog().filter(s=>s.id==="g-left");return c.length===1 && c[0].pos===null})()`)) === true);
for (const id of ["veg", "nursery"]) check(`Remove: ${id} still renders`, noJunk(await see("zone", id)));
check("Remove: Overview still renders", noJunk(await see("overview")));

await setupNow(); await cClick('[data-mapw="veg"]');
await ev(`ui.mapw.q="left";render()`); await sleep(40);
check("Remove: search finds a freed sensor from Map devices", (await ev(`!!document.querySelector("#ms-g-left")`)) === true);
await cClick('[data-msensor="g-left"]');
for (let i = 0; i < 2; i++) await cClick('[data-mstep="next"]');
await ev(`ui.mapw.step=2;ui.mapw.q="air conditioner";render()`); await sleep(40);
check("Remove: search finds a freed device too", (await mainText()).includes("Air conditioner"), (await mainText()).slice(0, 200));
await ev(`ui.mapw.step=3;ui.mapw.q="";render()`); await sleep(40);
await cClick('[data-mstep="next"]'); await cClick("[data-rapply]"); await sleep(120);
check("Remove: a freed sensor can be mapped to another zone", (await ev(`(()=>{const s=zoneById("veg").sensors.find(x=>x.id==="g-left");return !!s && s.pos===null})()`)) === true, await ev(`zoneById("veg").sensors.map(x=>x.id)`));
await ev(`ui.review=null;ui.guard=null;renderModal();ui.mapw=null;ui.wiz=null;render()`);

await setupNow(); await cClick("[data-addzone]"); await ev(`ui.wiz.name="Garden";render()`); await sleep(30);
check("Remove: its name is free again", !(await ev(`document.querySelector('[data-wiz="next"]').disabled`)));
await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.guide=null;render()`);
check("Remove: a new zone of that name starts clean", (await ev(`(()=>{const z=zoneById("garden");return !!z && !z.sensors.length && !ACTIVITY.garden.length && devices.every(d=>!d.zones.includes("garden"))})()`)) === true);
check("Remove: and its page renders", noJunk(await see("zone", "garden")));
await setupNow(); await askRemove("garden");
const emptyAsk = await dialog();
check("Remove: an empty zone's dialog leaves out what it doesn't have", !emptyAsk.includes("Sensors") && !emptyAsk.includes("Devices") && emptyAsk.includes("Placement"), emptyAsk);
await cClick("[data-gkeep]");

await cClick("[data-addzone]"); await ev(`ui.wiz.name='Bad <img src=x onerror="window.pwned=1"> zone';render()`); await sleep(30);
await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.guide=null;render()`); await setupNow();
await askRemove(await ev(`zones.at(-1).id`)); await sleep(60);
check("Remove: a zone name can't run as code in the dialog", !(await ev(`window.pwned`)) && (await ev(`!document.querySelector("#modal img")`)) === true);
await confirmRemove();
check("Remove: nor in the toast", !(await ev(`window.pwned`)));

for (const id of await zoneIds()) { await setupNow(); await askRemove(id); await confirmRemove(); await sleep(40); }
check("Remove: the last zone can go too", (await zoneIds()).length === 0, await zoneIds());
check("Remove: no zones leaves no question and no calm notice", await (async () => { const t = await see("setup"); return t.includes("No zones yet") && !t.includes("Every device is identified") && !t.includes("Questions for you"); })());
await shot("remove-empty-setup");
check("Remove: Devices says it has none", (await devicesTable()).includes("Nothing is in a zone yet. Device identification adds them."));
const emptyOverview = await see("overview");
check("Remove: Overview offers Add a zone, not All zones ideal", emptyOverview.includes("No zones yet") && !emptyOverview.includes("All zones ideal") && noJunk(emptyOverview), emptyOverview);
await shot("remove-empty-overview");
await cClick("[data-addzone]");
check("Remove: Add a zone from Overview opens Placement on Setup", (await ev(`ui.screen==="setup" && !!ui.wiz && !ui.wiz.id && !!document.querySelector("#wiz-name")`)) === true);
await ev(`ui.wiz.name="Fresh start";render()`); await sleep(30);
await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.guide=null;render()`);
check("Remove: and the first zone is back on Overview", (await see("overview")).includes("Fresh start"));

// ---------- Storage: setup is written by the backend, and survives restarts, power cuts and updates
/* Reopening the panel builds a new frame, so the tests follow it to its new context. */
const refindFrame = async () => {
  await sleep(700);
  for (const c of [...contexts].reverse()) {
    const r = await rawSend("Runtime.evaluate", { expression: "window.self!==window.top && typeof ui==='object' && Array.isArray(zones)", returnByValue: true, contextId: c.id });
    if (r.result && r.result.result && r.result.result.value === true) { frameContext = c.id; return; }
  }
};
const onDisk = () => onHA(`JSON.parse(fakeHA.disk).zones.map(z=>z.name)`);
const names = () => ev(`zones.map(z=>z.name)`);
const reviewErrors = () => ev(`ui.review ? ui.review.errors : null`);
const rename = async (name) => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.mapw=null;openWizard(zones[0].id,[0]);ui.wiz.name=${JSON.stringify(name)};ui.screen="setup";render()`); await sleep(30); await cClick('[data-wiz="next"]'); };
const rev0 = await ev(`configRevision`);
await rename("Flower room"); await cClick("[data-rapply]"); await sleep(150);
check("Storage: an applied change is written by the backend, and the revision moves on", same(await onDisk(), ["Flower room"]) && same(await names(), ["Flower room"]) && (await ev(`configRevision`)) === rev0 + 1, [await onDisk(), await ev(`configRevision`), rev0]);
await onHA(`fakeHA.restart()`); await sleep(200);
check("Storage: a restart shows HA's notice outside the panel", (await onHA(`document.querySelector("#ha-status").textContent`)).includes("restarting"));
await sleep(1600);
check("Storage: after a restart the change is still there", same(await names(), ["Flower room"]) && (await onHA(`document.querySelector("#ha-status").hidden`)) === true);
await evp(`ask("appearance",{value:"dark"})`); await sleep(100);
await onHA(`reopenPanel()`); await refindFrame();
check("Storage: reopening the panel reads it back from storage", same(await names(), ["Flower room"]), await names());
check("Appearance: reopening the panel keeps the one picked", (await ev(`document.documentElement.dataset.theme`)) === "dark" && (await ev(`appearance`)) === "dark");
await evp(`ask("appearance",{value:"ha"})`); await sleep(100);
await onHA(`fakeHA.knobs.cutPower=true`); await rename("Lost name"); await cClick("[data-rapply]"); await sleep(200);
check("Storage: a power cut mid-save keeps the review open and says it wasn't saved", ((await reviewErrors()) || []).some((e) => e.includes("Lost connection")) && same(await names(), ["Flower room"]), await reviewErrors());
check("Storage: and what's on disk is the old setup, whole", same(await onDisk(), ["Flower room"]), await onDisk());
await sleep(1700);
await cClick("[data-rapply]"); await sleep(200);
check("Storage: once HA is back, applying again saves it", same(await onDisk(), ["Lost name"]) && (await ev(`ui.review`)) === null, [await onDisk(), await reviewErrors()]);
await onHA(`installUpdate()`); await refindFrame();
check("Storage: an update keeps every setting", same(await names(), ["Lost name"]) && (await onHA(`document.querySelector("#ha-status").textContent`)).startsWith("Updated"), await names());
await onHA(`fakeHA.config.revision+=1;fakeHA.disk=JSON.stringify(fakeHA.config)`);
await rename("Stale"); await cClick("[data-rapply]"); await sleep(150);
check("Storage: a save made from an older copy is refused, not merged", ((await reviewErrors()) || []).some((e) => e.includes("saved from somewhere else")) && same(await onDisk(), ["Lost name"]), await reviewErrors());
await onHA(`reopenPanel()`); await refindFrame();
const diskBefore = await onHA(`fakeHA.disk`);
const junk = await evp(`Promise.all([ask("save",{base:configRevision,config:{zones:clone(zones),devices:[{id:"x",zones:["nowhere"]}]}}),ask("save",{base:configRevision,config:{zones:clone(zones),devices:[{id:"lock",zones:[zones[0].id],entity:"lock.front_door"}]}}),ask("save",{base:"1",config:{}})]).then(r=>r.map(x=>x.ok))`);
check("Storage: the backend refuses a device in a missing zone, an entity it can't control and a malformed save", same(junk, [false, false, false]) && (await onHA(`fakeHA.disk`)) === diskBefore, junk);

// ---------- Leaving the page: the frame can't raise the browser's leave prompt, so it tells the host a draft is open
const leaveAsks = () => onHA(`(()=>{const e=new Event("beforeunload",{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()`);
/* The name box is tapped, not focused from code: typing goes to whatever holds keyboard focus, and since Chrome 158 a
   frame that isn't focused can't take focus for itself. */
const openDetails = async () => { await ev(`ui.review=null;ui.guard=null;renderModal();openWizard(zones[0].id,[0]);ui.screen="setup";render()`); await sleep(50); await tap("#wiz-name"); await type("x"); await sleep(50); };
await ev(`ui.review=null;ui.guard=null;renderModal();ui.wiz=null;ui.screen="setup";render()`); await sleep(50);
check("Leaving: with nothing unsaved, closing the page doesn't ask", (await leaveAsks()) === false);
await openDetails();
check("Leaving: a letter typed into a zone's name makes closing the page ask first", (await leaveAsks()) === true);
await cClick('[data-wiz="back"]'); await sleep(40); await cClick("[data-gdiscard]"); await sleep(60);
check("Leaving: once that's discarded, it doesn't ask", (await leaveAsks()) === false && (await ev(`ui.wiz`)) === null);
await evp(`parent.postMessage({v:1,type:"draft",open:"yes"},"*")`); await sleep(40);
check("Leaving: a draft message that isn't true or false is dropped", (await leaveAsks()) === false);
await openDetails(); await onHA(`reopenPanel()`); await refindFrame();
check("Leaving: a reopened panel holds no draft, so it doesn't ask", (await leaveAsks()) === false);
await openDetails();
let dialogSeen; const dialogShown = new Promise((r) => { dialogSeen = r; });
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Page.javascriptDialogOpening") dialogSeen(d.params.type); });
await onHA(`setTimeout(()=>location.reload(),0)`);
const dialogType = await Promise.race([dialogShown, sleep(3000).then(() => "none")]);
if (dialogType !== "none") await send("Page.handleJavaScriptDialog", { accept: false });
await sleep(200);
check("Leaving: reloading with a draft open raises the browser's own prompt, and staying keeps the draft", dialogType === "beforeunload" && /x/.test(await ev(`ui.wiz ? ui.wiz.name : ""`)), dialogType);

/* HA's sidebar changes page without unloading, so the host holds the link click itself. These are real clicks on the page that
   plays HA, landing on links inside the sidebar's shadow root, through the same router HA uses. */
const sideClick = async (route) => {
  const r = await onHA(`(()=>{const b=document.querySelector("ha-sidebar").shadowRoot.querySelector('[data-route="${route}"]').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rawSend("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(200);
};
const haRoute = () => onHA(`haRoute`);
await sideClick("/lovelace");
const leaveDlg = await hostDialog();
check("Leaving: with a draft open, HA's sidebar doesn't change page, and the host asks first", (await haRoute()) === "/environment-control" && leaveDlg.open === true && leaveDlg.text.includes("Discard unsaved changes?"), [await haRoute(), leaveDlg.text]);
await hostClick("keep");
check("Leaving: Keep editing stays on the panel with the draft as it was", (await haRoute()) === "/environment-control" && (await hostDialog()).open === false && /x/.test(await ev(`ui.wiz ? ui.wiz.name : ""`)), await haRoute());
await sideClick("/environment-control");
check("Leaving: the panel's own link in the sidebar goes nowhere, so it doesn't ask", (await hostDialog()).open === false && /x/.test(await ev(`ui.wiz ? ui.wiz.name : ""`)));
await sideClick("/lovelace"); await hostClick("leave");
check("Leaving: Discard and leave lets HA change page", (await haRoute()) === "/lovelace" && (await onHA(`document.querySelector("environment-control-panel")`)) === null && (await hostDialog()).open === false, await haRoute());
await sideClick("/environment-control"); await refindFrame();
check("Leaving: coming back opens the panel fresh, with no draft", (await haRoute()) === "/environment-control" && (await ev(`ui.wiz`)) === null);
await sideClick("/lovelace");
check("Leaving: with nothing unsaved, the sidebar changes page without asking", (await haRoute()) === "/lovelace" && (await hostDialog()).open === false);
await sideClick("/environment-control"); await refindFrame();

check("no script errors", exceptions.length === 0, exceptions);

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); await finish();
