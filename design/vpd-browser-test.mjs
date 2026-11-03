// Drives the mock in headless Chromium over CDP with real taps and keystrokes. Touches nothing outside the scratchpad.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";

const dir = process.argv[2], port = 9347, profile = `${dir}/chromium-profile`;
process.on("uncaughtException", (e) => { console.log("Error", e.message); browser.kill(); process.exit(2); });
const browser = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--disable-features=IsolateSandboxedIframes", "--disable-site-isolation-trials", "about:blank"], { stdio: "ignore" });
/* Chromium keeps writing its profile for a moment after the kill, so wait for it to exit before removing it. */
const finish = async () => { const gone = new Promise((r) => browser.once("exit", r)); browser.kill(); await gone; rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exit(fail ? 1 : 0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let info;
for (let n = 0; n < 50 && !info; n++) { await sleep(200); try { info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch {} }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0, frameContext; const waiting = new Map(), exceptions = [], contexts = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.executionContextCreated" && d.params.context.auxData && d.params.context.auxData.isDefault) contexts.push(d.params.context);
  if (d.method === "Runtime.exceptionThrown") exceptions.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
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

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await phone(390, 844);
writeFileSync(`${dir}/mock-wrapped.html`, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync(`${dir}/${process.env.MOCK_FILE || "environment-control-source.html"}`, "utf8")}</body></html>`);
writeFileSync(`${dir}/mock-framed.html`, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" src="mock-wrapped.html"></iframe></body></html>`);
await send("Page.navigate", { url: `file://${dir}/mock-framed.html` });
await sleep(1200);
for (const c of contexts) {
  const r = await send("Runtime.evaluate", { expression: "window.self !== window.top", returnByValue: true, contextId: c.id });
  if (r.result && r.result.result && r.result.result.value === true) frameContext = c.id;
}
console.log("IN FRAME:", await ev(`window.self !== window.top`), "origin:", await ev(`location.origin + " / " + self.origin`));

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
    check(`${id}: light matches HA`, close(n.light, w.light, 1), [n.light, w.light]);
  }
  await go(`ui.screen="overview";render()`); await clean("Overview"); await shot("real-overview");
  check("Overview: every zone with light draws its graph", (await ev(`document.querySelectorAll("#main .zone-card svg.lspark").length`)) === (await ev(`zones.filter(z=>lightLine(z)).length`)));
  for (const z of ["garden", "veg", "nursery"]) { await go(`ui.screen="zone";ui.zone="${z}";render()`); await clean(z); await shot(`real-${z}`); }
  for (const [s, name] of [["devices", "Devices"], ["setup", "Setup"]]) { await go(`ui.screen="${s}";render()`); await clean(name); }
  check("Setup: no made-up tasks left", (await ev(`document.querySelectorAll("#main [data-role], #main [data-answer]").length`)) === 0);
  for (const id of ["garden", "veg", "nursery"]) {
    await go(`ui.screen="zone";ui.zone="${id}";render()`);
    const windows = {};
    for (const k of ["temperature", "humidity", "vpd", "light"]) for (const h of [6, 24, 72, 168]) {
      await go(`ui.metric="${k}";ui.range=${h};render()`); await clean(`${id} ${k} ${h}h`);
      const r = await ev(`(()=>{const c=chartNow,x=c.rows[0],s=chartStats(x.line);return {now:fmt("${k}",x.line[c.n].v),tile:fmt("${k}",zoneById("${id}").now.${k}),min:s.min.v,max:s.max.v,n:c.n,note:document.querySelector("#chart-note").textContent}})()`);
      check(`${id} ${k} ${h}h: the chart's Now is the tile's reading`, r.now === r.tile, r);
      windows[`${k}${h}`] = r;
    }
    for (const k of ["temperature", "humidity", "vpd", "light"]) for (const [a, b] of [[6, 24], [24, 72], [72, 168]]) {
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
  check("Lights: the controllers show HA's brightness", lit.filter((x) => x.includes("Brightness")).length === 2 && lit[0].includes(`${want.lights.overhead}%`), lit[0]);
  for (const [id, want2] of Object.entries(want.sched)) {
    await go(`ui.screen="setup";render();document.querySelector('[data-schedw="${id}"]').click()`); await clean(`${id} Day and night`);
    const v = await ev(`ui.sched.vals`);
    check(`${id} Day and night: the page holds HA's times, and no light limits`, v.day === want2.day && v.night === want2.night && v.dayMin === undefined && v.nightMax === undefined, v);
    await shot(`real-sched-${id}`);
    await go(`document.querySelector("[data-sexit]").click()`);
    await go(`ui.screen="zone";ui.zone="${id}";render()`);
    const rows = await ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[...t.querySelectorAll("tr")].pop().textContent)`);
    check(`${id} Targets: the zone page holds HA's light limits`, rows[0] === `Lightlx${want2.dayMin.toLocaleString("en-NZ")}` && rows[1] === `Lightlx${want2.nightMax.toLocaleString("en-NZ")}`, rows);
    await go(`document.querySelector('[data-vpd="${id}"]').click();ui.vpdw.period="day";render()`); await clean(`${id} Targets`);
    const day = await ev(`document.querySelector("#vin-light-0").value`);
    await go(`ui.vpdw.period="night";render()`);
    const night = await ev(`document.querySelector("#vin-light-0").value`);
    check(`${id} Targets: the boxes hold HA's light limits`, Number(day) === want2.dayMin && Number(night) === want2.nightMax, [day, night]);
    await go(`document.querySelector("[data-vexit]").click()`);
  }
  await go(`document.querySelector('[data-schedw="garden"]').click()`);
  check("Emerson: the red windows match HA's failsafe sum", (await ev(`document.querySelector("#s-em").textContent`)) === want.emerson, await ev(`document.querySelector("#s-em").textContent`));
  await go(`document.querySelector("[data-sexit]").click()`);
  await go(`document.querySelector('[data-schedw="veg"]').click()`);
  check("Schedule: Veg says Nursery shares its helpers", (await ev(`document.querySelector("#s-times").textContent`)).includes("Nursery uses the same helpers"));
  await go(`document.querySelector("[data-sexit]").click()`);
  for (const z of ["garden", "veg", "nursery"]) for (const p of ["day", "night"]) {
    const r = await ev(`(()=>{openVpd("${z}");const v=ui.vpdw;v.period="${p}";const i=vIssues(v,v.bands["${p}"]).map(x=>x.text);ui.vpdw=null;return i})()`);
    check(`${z} ${p}: limits are valid and something fits`, r.length === 0, r);
  }
  for (const id of ["g-s1", "g-s2", "g-s3"]) {
    const r = await ev(`(()=>{const s=zones[0].sensors.find(x=>x.id==="${id}"),r=soilCeiling(soilCurve(s));return {value:r&&r.value,count:r&&r.count,trusted:r&&r.trusted,shelf:r&&r.shelf&&r.shelf.level,fs:s.fsLive}})()`);
    console.log("SOIL", id, JSON.stringify(r));
    check(`${id}: the replayed rise gives a figure`, r.value !== null, r);
  }
  await go(`ui.screen="setup";render();document.querySelector('[data-calw="garden"]').click()`); await clean("Sensor Calibration"); await go(`document.querySelector('[data-cprobe="g-s1"]').click()`); await go(`document.querySelector("[data-cstart]").click()`); await go(`document.querySelector("[data-cfinish]").click()`); await clean("Soil result"); await shot("real-soil");
  await go(`ui.soilw=null;ui.leafw=null;ui.screen="setup";render()`);
  check("Setup: Sensor Calibration sits before Targets in every zone", (await ev(`["garden","veg","nursery"].every(z=>document.querySelector('[data-calw="'+z+'"]').nextElementSibling.dataset.vpd===z)`)) === true);
  for (const z of ["veg", "nursery"]) { await go(`document.querySelector('[data-calw="${z}"]').click()`); await clean(`${z} calibration`); await go(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); }
  await go(`document.querySelector("[data-addzone]").click()`); await go(`ui.wiz.name="Flower 2";render()`); await go(`document.querySelector('[data-wiz="next"]').click()`); await go(`document.querySelector('[data-wiz="next"]').click()`); await go(`document.querySelector('[data-wiz="next"]').click()`); await go(`document.querySelector("[data-rapply]").click()`); await clean("New zone map");
  for (const [e, name] of [[`ui.mapw=null;ui.screen="overview";render()`, "Overview with a new zone"], [`ui.screen="zone";ui.zone="flower_2";render()`, "New zone page"]]) { await go(e); await clean(name); }
  await go(`ui.mapw=null;ui.wiz=null;ui.review=null;ui.guard=null;renderModal();ui.screen="setup";render()`);
  await go(`document.querySelector('[data-rmzone="flower_2"]').click()`); await clean("Setup behind the dialog");
  check("Remove: real data, dialog names the new zone", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Remove Flower 2?");
  await go(`document.querySelector("[data-gdiscard]").click()`);
  check("Remove: real data, the new zone goes", (await ev(`!zoneById("flower_2")`)) === true);
  await go(`document.querySelector('[data-rmzone="garden"]').click()`);
  check("Remove: real data, shared hardware named", /stay in /.test(await ev(`document.querySelector("#modal").textContent`)), await ev(`document.querySelector("#modal").textContent`));
  check("Remove: real data, dialog has no NaN or undefined", !/NaN|undefined/.test(await ev(`document.querySelector("#modal").textContent`)));
  await go(`document.querySelector("[data-gdiscard]").click()`);
  check("Remove: real data, Garden's sensors stay findable", (await ev(`catalog().length`)) > (await ev(`zones.flatMap(z=>z.sensors).length`)));
  for (const [e, name] of [[`ui.screen="overview";render()`, "Overview without Garden"], [`ui.screen="devices";render()`, "Devices without Garden"], [`ui.screen="zone";ui.zone="veg";render()`, "Veg without Garden"], [`ui.screen="setup";render()`, "Setup without Garden"]]) { await go(e); await clean(name); }
  for (const id of ["veg", "nursery"]) { await go(`document.querySelector('[data-rmzone="${id}"]').click()`); await go(`document.querySelector("[data-gdiscard]").click()`); }
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
    const r = await ev(`(()=>{const e=document.querySelector("#vin-${k}-${i}").getBoundingClientRect(),bar=document.querySelector(".topbar"),head=getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0;return {top:e.top,bottom:e.bottom,head,h:innerHeight,active:document.activeElement.id}})()`);
    const line = r.h * (1 - kb);
    if (r.active !== `vin-${k}-${i}` || r.top < r.head - 1 || r.bottom > line) hidden.push([`${k}-${i}`, Math.round(r.top), Math.round(r.bottom), "limit " + Math.round(line), r.active]);
    await key("Escape", 27); await sleep(40);
  }
  check(`${name} ${w}x${h}: every box stays above the keyboard and below the header`, hidden.length === 0, hidden);
}
// Keyboard laid over the frame, as in Claude's viewer: nothing resizes
await phone(800, 1000); await open(); await tap("#vin-vpd-1"); await sleep(420);
const over = await ev(`(()=>{const c=document.querySelector("#vwrap").getBoundingClientRect(),b=document.querySelector("#vin-vpd-1").getBoundingClientRect();return {chartVisible:c.bottom-document.querySelector(".topbar").getBoundingClientRect().bottom,boxBottom:b.bottom,h:innerHeight}})()`);
check("overlaid keyboard: box sits just above where it starts", over.boxBottom <= over.h * 0.5 && over.boxBottom > over.h * 0.4, over);
await key("Escape", 27);
await tap("#vin-temperature-1"); await sleep(420);
const chart1 = await ev(`document.querySelector("#vwrap").getBoundingClientRect().bottom - document.querySelector(".topbar").getBoundingClientRect().bottom`);
check("overlaid keyboard: chart stays in view above the first row", chart1 > 100, chart1);
await key("Escape", 27); await sleep(60);

// Keyboard that resizes the host, as Chill's page in the HA app: the frame gets shorter and the edge is measured
const outer = async (expression) => { const c = frameContext; frameContext = undefined; const r = await ev(expression); frameContext = c; return r; };
for (const [w, h, name] of [[800, 1000, "foldable"], [390, 844, "phone"]]) {
  await phone(w, h); await open(); await sleep(60);
  await tap("#vin-humidity-1"); await sleep(40);
  await outer(`document.querySelector("iframe").style.height="59%"`); await sleep(500);
  const m = await ev(`(()=>{const b=document.querySelector("#vin-humidity-1").getBoundingClientRect(),c=document.querySelector("#vwrap").getBoundingClientRect(),bar=document.querySelector(".topbar");return {boxTop:b.top,boxBottom:b.bottom,h:innerHeight,chart:c.bottom-(getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0),active:document.activeElement.id}})()`);
  check(`resized host ${name}: box is pushed up to just above the keyboard`, m.boxBottom <= m.h && m.boxBottom > m.h - 90 && m.active === "vin-humidity-1", m);
  check(`resized host ${name}: chart stays in view`, m.chart > 40, m);
  await tap("#vin-vpd-3"); await sleep(200);
  const m2 = await ev(`(()=>{const b=document.querySelector("#vin-vpd-3").getBoundingClientRect();return {top:b.top,bottom:b.bottom,h:innerHeight,active:document.activeElement.id}})()`);
  check(`resized host ${name}: moving box to box keeps it on screen`, m2.bottom <= m2.h && m2.top > 0 && m2.active === "vin-vpd-3", m2);
  await key("Escape", 27);
  await outer(`document.querySelector("iframe").style.height="100%"`); await sleep(120);
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
const falseBlocks = await ev(`(()=>{const out=[];for(const z of zones){openVpd(z.id);const v=ui.vpdw;for(const p of ["day","night"]){v.period=p;const before=vProblems(v.bands[p]);if(before.length)out.push([z.id,p,"bands",before]);for(const s of Object.keys(STAGES)){applyStage(v,s);const pr=vProblems(v.bands[p]);if(pr.length)out.push([z.id,p,s,pr]);}}}ui.vpdw=null;return out})()`);
check("every zone band and Athena stage passes", falseBlocks.length === 0, falseBlocks);

await open();
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

await key("Escape", 27);
await open();
await tap("#vin-temperature-4"); await type("36"); await key("Enter", 13);
check("Enter commits a value past the chart edge", (await band("temperature", 4)) === 36);
check("Enter closes the keyboard", (await active()) !== "vin-temperature-4");
check("past the chart edge is not an issue", (await issueText()).length === 0, await issueText());
check("line stays inside the chart", await ev(`[...document.querySelectorAll("#vwrap line")].every(l=>Number(l.getAttribute("x1"))<=vGeom().W)`));

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
check("Save with a box still focused keeps the typed value", (await ev(`zones[0].bands[ui.vpdw ? "x" : (typeof period==="function"?period(zones[0]):"day")].temperature[1]`)) === 24.7, await ev(`JSON.stringify(zones[0].bands)`));
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
const goTab = async (name) => { await ev(`[...document.querySelectorAll("#tabs button")].find(b=>b.textContent==="${name}").click()`); await sleep(60); };
const reset = () => ev(`ui.review=null;ui.guard=null;renderModal();ui.soilw=null;ui.leafw=null;ui.sched=null;ui.vpdw=null;ui.mapw=null;ui.wiz=null;ui.picked=null;ui.zone="garden";ui.screen="overview";render();window.scrollTo(0,0)`);
const groupNames = () => ev(`[...document.querySelectorAll("[data-cgroup] .dev-name span:first-child")].map(e=>e.textContent)`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
await phone(390, 844); await reset(); await goTab("Garden");
check("Controls: there's no Controls tab", same(await ev(`[...document.querySelectorAll("#tabs button")].map(b=>b.textContent)`), ["Overview", "Garden", "Veg", "Nursery", "Devices", "Setup"]), await ev(`[...document.querySelectorAll("#tabs button")].map(b=>b.textContent)`));
check("Controls: they sit straight under the readings", (await ev(`document.querySelector(".tiles").nextElementSibling.firstElementChild.id`)) === "controls");
check("Controls: garden shows its climate devices and lights, and nothing else", same(await groupNames(), ["Dehumidifier", "Auxiliary dehumidifier", "Air conditioner", "Heater", "Intake fan", "Air conditioner exhaust fan", "Overhead light controller", "Overhead lights 1", "Overhead lights 2", "Under canopy light controller", "Red lights"]), await groupNames());
check("Controls: grouped by what they do", same(await ev(`[...document.querySelectorAll("[data-cgroup] h3")].map(e=>e.textContent)`), ["Humidity", "Temperature", "Airflow", "Lights"]));
check("Controls: humidity and temperature sit beside the live reading", (await ev(`[...document.querySelectorAll("[data-cgroup] .ctl-reading")].map(e=>e.textContent).join("|")`)).startsWith(await ev(`fmt("humidity",zones[0].now.humidity)`)), await ev(`[...document.querySelectorAll("[data-cgroup] .ctl-reading")].map(e=>e.textContent)`));
await goTab("Veg");
check("Controls: veg devices", same(await groupNames(), ["Auxiliary dehumidifier", "Heater", "Oscillating fans", "Tent light controller", "Tent lights"]), await groupNames());
check("Controls: shared device names who shares it", (await ev(`[...document.querySelectorAll(".dev")].find(d=>d.textContent.includes("Heater")).textContent`)).includes("Shared with Garden and Nursery"));
await goTab("Nursery");
check("Controls: nursery devices", same(await groupNames(), ["Auxiliary dehumidifier", "Heater", "Oscillating fans", "Tent light controller", "Tent lights"]), await groupNames());
await goTab("Garden");
const stateBefore = await ev(`JSON.stringify(devices)`), lookBefore = await ev(`document.querySelector("#main").innerHTML`);
await tap("[data-cgroup] .sw[data-preview]");
check("Controls: a tap says nothing was sent", (await ev(`document.querySelector("#toast").textContent`)) === (await ev(`SENT`)));
await ev(`document.querySelectorAll("[data-cgroup] [data-preview]").forEach(b=>b.click())`); await sleep(60);
check("Controls: no tap changes any device state", (await ev(`JSON.stringify(devices)`)) === stateBefore);
check("Controls: no tap changes how a control looks", (await ev(`document.querySelector("#main").innerHTML`)) === lookBefore);
check("Controls: every device row is marked Preview", (await ev(`[...document.querySelectorAll("[data-cgroup] .dev")].every(d=>d.querySelector(".pill.preview"))`)) === true);
const down = await ev(`(()=>{const d=[...document.querySelectorAll("[data-cgroup] .dev")].find(x=>x.textContent.includes("exhaust fan"));return {all:[...d.querySelectorAll(".mock")].every(b=>b.disabled),text:d.textContent.includes("Unavailable")}})()`);
check("Controls: an unavailable device can't be tapped", down.all && down.text, down);
await tap("#main .notice.fix");
check("Controls: an unidentified plug's notice lands on its question", (await ev(`ui.screen==="setup" && !!document.querySelector("#task-plug")`)) === true && (await ev(`(()=>{const r=document.querySelector("#task-plug").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`)) === true);
await ev(`document.querySelector('[data-role="plug"][data-val="Other"]').click()`); await sleep(50); await goTab("Garden");
check("Controls: a plug marked Other stays out and the notice goes", !(await groupNames()).includes("Plug 7") && (await ev(`document.querySelectorAll("#main .notice.fix").length`)) === 0, await groupNames());
await ev(`devices.find(d=>d.id==="plug").type=null;render()`); await sleep(30);
await ev(`document.querySelector("#main .notice.fix").click()`); await sleep(50);
await ev(`document.querySelector('[data-role="plug"][data-val="Heater"]').click()`); await sleep(50); await goTab("Garden");
check("Controls: a plug marked Heater joins Temperature", (await ev(`document.querySelector('[data-cgroup="Temperature"]').textContent`)).includes("Plug 7"));
await ev(`devices.find(d=>d.id==="plug").type=null;render()`);
for (const [w, h] of [[390, 844], [320, 640]]) {
  await phone(w, h); await reset(); await goTab("Garden"); await sleep(60);
  check(`Controls ${w}px: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`), await ev(`document.documentElement.scrollWidth`));
  check(`Controls ${w}px: its tab is on screen`, await ev(`(()=>{const c=document.querySelector("#tabs [aria-current]").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth})()`));
  await goTab("Setup");
  check(`Setup ${w}px: the last tab is on screen`, await ev(`(()=>{const c=document.querySelector("#tabs [aria-current]").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth})()`));
}

// ---------- Leaf temperature offset
await phone(390, 844); await reset();
const L = { rows: (id) => `ui.leafw.rows["${id}"]` };
const openL = async (zone = "garden") => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.leafw=null;ui.vpdw=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";openCalibration("${zone}");render();window.scrollTo(0,0)`); await sleep(50); };
const ACK = 620, GIVE_UP = 1620;
const leafSave = (wait = ACK) => ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`).then(() => sleep(wait));
const sends = () => ev(`leafSends.map(x=>x.entity_id+"="+x.value)`);
const board = (id) => ev(`zones.flatMap(z=>z.sensors).find(s=>s.id==="${id}").leafLive`);
const row = (id) => ev(`ui.leafw.rows["${id}"]`);
const saved = (id) => ev(`leafOf(zones.flatMap(z=>z.sensors).find(s=>s.id==="${id}"))`);
await openL();
check("Leaf: every environment sensor listed, soil left out", same(await ev(`[...document.querySelectorAll(".lrow-top strong")].map(e=>e.textContent)`), ["Environment left", "Environment right", "Environment under"]), await ev(`[...document.querySelectorAll(".lrow-top strong")].map(e=>e.textContent)`));
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
await ev(`zones[0].sensors.find(s=>s.id==="g-right").leafStuck=true`);
await openL(); await tap("#lin-g-right"); await type("2"); await key("Enter", 13);
await tap("#lin-g-left"); await type("1"); await key("Enter", 13);
await leafSave(GIVE_UP);
check("Board: no reply is never shown as saved", (await board("g-right")) === -1 && (await ev(`!!ui.leafw`)) === true, await board("g-right"));
check("Board: it says what the board still reports", (await ev(`document.querySelector("#ls-g-right").textContent`)).includes("Not confirmed. The board still reports leaf 1.0"), await ev(`document.querySelector("#ls-g-right").textContent`));
check("Board: the one that answered is kept", (await board("g-left")) === -1, await board("g-left"));
check("Board: your typed value survives to try again", (await ev(`document.querySelector("#lin-g-right").value`)) === "2.0" && (await ev(`document.querySelector("[data-dreview]").disabled`)) === false);
check("Board: the review stays open and says what failed", (await ev(`document.querySelector("#modal").textContent`)).includes("Some changes were not applied") && (await ev(`document.querySelector("#modal").textContent`)).includes("not confirmed. The board still reports leaf 1.0"), await ev(`document.querySelector("#modal").textContent`));
check("Board: and lists only what's left", (await ev(`document.querySelectorAll("#review-items .review-row").length`)) === 1 && (await ev(`document.querySelector("[data-rapply]").textContent`)) === "Apply 1 change", await ev(`document.querySelector("#modal").textContent`));
await ev(`zones[0].sensors.find(s=>s.id==="g-right").leafStuck=false;leafSends.length=0`);
await ev(`document.querySelector("[data-rapply]").click()`); await sleep(ACK);
check("Board: Save tries again, sending only what's still different", same(await sends(), ["number.environment_right_leaf_temperature_offset=-2"]) && (await board("g-right")) === -2, await sends());
await ev(`zones[0].sensors.find(s=>s.id==="g-right").leafLive=-1;leafSends.length=0;render()`);
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
const setupNow = async () => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.soilw=null;ui.leafw=null;ui.vpdw=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";render();window.scrollTo(0,0)`); await sleep(40); };
const setupButtons = (zone) => ev(`[...document.querySelector('[data-mapw="${zone}"]').parentElement.children].map(b=>b.textContent)`);
const calibrate = async (zone = "garden") => { await setupNow(); await ev(`document.querySelector('[data-calw="${zone}"]').click()`); await sleep(50); };
await setupNow();
check("Order: Sensor Calibration comes before Targets", same(await setupButtons("garden"), ["Map devices", "Placement", "Day and night", "Sensor Calibration", "Targets", "Remove zone"]), await setupButtons("garden"));
check("Order: and it's there for zones with no soil probes", same(await setupButtons("veg"), ["Map devices", "Placement", "Day and night", "Sensor Calibration", "Targets", "Remove zone"]) && same(await setupButtons("nursery"), ["Map devices", "Placement", "Day and night", "Sensor Calibration", "Targets", "Remove zone"]), await setupButtons("veg"));
await calibrate();
check("Order: one page, leaf temperature offset first, then soil", same(await ev(`[...document.querySelectorAll("#main h2")].map(e=>e.textContent)`), ["Leaf temperature offset", "Soil probes"]), await ev(`[...document.querySelectorAll("#main h2")].map(e=>e.textContent)`));
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
await ev(`zones[0].sensors.find(s=>s.id==="g-left").leafLive=-1;zones[0].sensors.find(s=>s.id==="g-right").leafStuck=true;leafSends.length=0`);
await calibrate(); await tap("#lin-g-right"); await type("2"); await key("Enter", 13);
await leafSave(GIVE_UP);
check("Order: an unconfirmed board stays on screen as not confirmed", (await ev(`!!ui.leafw`)) === true && (await ev(`document.querySelector("#ls-g-right").textContent`)).includes("Not confirmed"));
await ev(`zones[0].sensors.find(s=>s.id==="g-right").leafStuck=false;leafSends.length=0;ui.leafw=null;render()`);

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
const saveTop = await ev(`document.querySelector("[data-lexit]").getBoundingClientRect().top+scrollY`);
await tap("#lin-g-left"); await type("2"); await key("Enter", 13);
check("Basis: offsets starting to differ doesn't move Back", (await ev(`document.querySelector("[data-lexit]").getBoundingClientRect().top+scrollY`)) === saveTop);
await ev(`ui.leafw=null;zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5;render()`);
await openL("veg");
check("Basis: not offered with one sensor", (await ev(`!document.querySelector("#l-basis")`)) === true);
await ev(`ui.leafw=null;ui.vpdw=null;render()`);

// One offset for the chart
await open();
check("Chart: mixed offsets say they're an average", (await ev(`document.querySelector("#main").textContent`)).includes("the average of 3 sensors"), await ev(`ui.vpdw.leaf`));
check("Chart: uses the average of the counted sensors", (await ev(`ui.vpdw.leaf`)) === -0.8, await ev(`ui.vpdw.leaf`));
const targetBefore = await band("vpd", 2);
await ev(`document.querySelector("[data-calw]").click()`); await sleep(50);
await ev(`(document.querySelector("[data-lexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(50);
check("Chart: going back with no change leaves Target VPD alone", (await band("vpd", 2)) === targetBefore, await band("vpd", 2));
await ev(`document.querySelector("[data-calw]").click()`); await sleep(50);
await tap("#lin-g-under"); await type("2"); await ev(`(document.querySelector("[data-dreview]").click(),document.querySelector("[data-rapply]")?.click())`); await sleep(50);
check("Chart: a saved offset comes back into the open chart", (await ev(`ui.vpdw.leaf`)) === -1.3 && !!(await ev(`document.querySelector("#vwrap")`) === null ? null : true), await ev(`ui.vpdw.leaf`));
check("Chart: and moves Target VPD with it", (await band("vpd", 2)) !== targetBefore, await band("vpd", 2));
await ev(`zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5`);
// Athena's Flower finish only fits with the leaf at air temperature
await ev(`ui.mapw=null;ui.wiz=null;ui.leafw=null;openVpd("nursery");render()`); await sleep(40);
await ev(`document.querySelector("[data-vstage=finish]").click()`); await sleep(50);
check("Finish: no conditions fit at leaf -1", (await issueText()).some((t) => t.includes("No conditions fit")), await issueText());
await tap("#v-issues [data-calw]");
check("Finish: Fix opens the offsets", (await ev(`!!ui.leafw && !!ui.vpdw`)) === true);
await tap("#lin-n-env"); await type("0"); await leafSave();
check("Finish: leaf same as air clears it", (await issueText()).length === 0 && (await ev(`ui.vpdw.leaf`)) === 0, await issueText());
check("Finish: and that change went to the board", (await sends()).includes("number.nursery_environment_leaf_temperature_offset=0") && (await board("n-env")) === 0, await sends());
const fin = await ev(`(()=>{const b=ui.vpdw.bands[ui.vpdw.period],t=b.temperature,h=b.humidity,p=b.vpd;return {inside:t[2]>=t[1]&&t[2]<=t[3]&&h[2]>=h[1]&&h[2]<=h[3]&&p[2]>=p[1]&&p[2]<=p[3],agrees:Math.abs(calcVpd(t[2],h[2],0)-p[2])<0.03,saveOn:!document.querySelector("[data-dreview]").disabled,target:[t[2],h[2],p[2]]}})()`);
check("Finish: Target lands inside every ideal range", fin.inside, fin);
check("Finish: its temperature, humidity and VPD still agree", fin.agrees, fin);
check("Finish: it can be saved", fin.saveOn, fin);
check("Finish: and it says the Target moved", (await ev(`document.querySelector("#toast").textContent`)).includes("Target moved"), await ev(`document.querySelector("#toast").textContent`));
await ev(`(document.querySelector("[data-vexit]").click(),document.querySelector("[data-gdiscard]")?.click())`); await sleep(40);
await ev(`zones[2].sensors[0].leafLive=-1;leafSends.length=0`);

// Mapping decides whether a sensor has an offset on the device
await ev(`ui.vpdw=null;ui.screen="setup";render();document.querySelector('[data-mapw="veg"]').click()`); await sleep(50);
check("Map: the leaf temperature offset entity is matched with the rest", (await ev(`!!document.querySelector('[data-mmetric="v-env:leaf"]')`)) === true);
await ev(`(()=>{const e=document.querySelector('[data-mmetric="v-env:leaf"]');e.value="none";e.dispatchEvent(new Event("change",{bubbles:true}));saveMap(ui.mapw);ui.mapw=null;render()})()`); await sleep(50);
await openL("veg");
check("Map: Not used stores the offset here, starting from the board's last value", (await ev(`document.querySelector("#lin-v-env").value==="1.0" && document.querySelector("#lr-v-env").textContent.includes("kept in Environment Control")`)) === true);
await tap("#lin-v-env"); await type("2"); await key("Enter", 13); await leafSave(60);
check("Map: and saving it writes nothing to the board", (await sends()).length === 0 && (await ev(`zones[1].sensors[0].leafLive`)) === -1 && (await saved("v-env")) === -2, await sends());
await ev(`zones[1].sensors[0].leafUnused=false;zones[1].sensors[0].leaf=undefined;render()`);
await ev(`zones[1].sensors[0].t=null;zones[1].sensors[0].h=null`); await openL("veg");
check("Leaf: a dead sensor shows no data, never a number", await ev(`(()=>{const t=document.querySelector("#main").textContent;return t.includes("No data from this sensor")&&!t.includes("NaN")&&t.includes("VPD --")})()`), await ev(`document.querySelector("#l-zone").textContent`));
await ev(`zones[1].sensors[0].t=20.4;zones[1].sensors[0].h=72.1;ui.leafw=null;render()`);
await ev(`ui.vpdw=null;ui.screen="setup";render()`);

for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await openL(); await sleep(60);
  const hidden = [];
  for (const id of ["g-left", "g-right", "g-under"]) {
    await tap(`#lin-${id}`); await sleep(420);
    const r = await ev(`(()=>{const e=document.querySelector("#lin-${id}").getBoundingClientRect(),bar=document.querySelector(".topbar"),head=getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0;return {top:e.top,bottom:e.bottom,head,h:innerHeight,active:document.activeElement.id}})()`);
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
const leafLink = async () => ev(`(()=>{ui.screen="zone";ui.zone=zones[0].id;render();return document.querySelector('#main .tile [data-calw]').textContent.trim()})()`);
await ev(`window.__lk=envOf(zones[0]).map(s=>[s.leafLive,s.leaf]);envOf(zones[0]).forEach(s=>{s.leafLive=-1;s.leaf=-1})`);
check("VPD tile: a shared offset reads as signed degrees", (await leafLink()) === "Leaf temperature offset -1.0 °C ›", await leafLink());
await ev(`envOf(zones[0]).forEach(s=>{s.leafLive=0.5;s.leaf=0.5})`);
check("VPD tile: an offset above air carries a plus", (await leafLink()) === "Leaf temperature offset +0.5 °C ›", await leafLink());
await ev(`envOf(zones[0]).forEach((s,i)=>{s.leafLive=i?-1:-0.5;s.leaf=s.leafLive})`);
check("VPD tile: offsets that differ say per sensor", (await leafLink()) === "Leaf temperature offset per sensor ›", await leafLink());
await ev(`envOf(zones[0]).forEach((s,i)=>{[s.leafLive,s.leaf]=window.__lk[i]});render()`);
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
check("Overview: a one-sensor zone says nothing about combining", !(await ev(`document.querySelectorAll("#main .zone-card")[1].textContent`)).includes("sensors."));
check("Overview: zones count units, not pots", /\d+ units/.test(await ev(`ui.screen="zone";ui.zone=zones[0].id;render();const t=document.querySelector("#main").textContent;ui.screen="overview";render();t`)) && !/\bpots?\b/i.test(await ev(`document.documentElement.innerHTML`)));
await ev(`zones[0].combine={temperature:"highest"};render()`); await sleep(40);
check("Overview: mixed methods don't claim to be an average", (await ev(`document.querySelector("#main .zone-card").textContent`)).includes("Combined from 3 sensors"));
await ev(`zones[0].combine=undefined;render()`);
const spark = await ev(`(()=>{const row=[...document.querySelectorAll("#main .zone-card")[0].querySelectorAll(".mrow")].pop(),g=row.querySelector("svg.lspark"),tr=document.querySelector("#main .zone-card .track").getBoundingClientRect(),pill=document.querySelector("#main .zone-card .pillcell").getBoundingClientRect();if(!g)return null;const r=g.getBoundingClientRect();return {l:r.left,r:r.right,h:r.height,trl:tr.left,pillr:pill.right,label:g.getAttribute("aria-label"),stroke:g.querySelector("path:last-child").getAttribute("stroke")}})()`);
check("Overview: light has a short graph", spark && spark.h > 20 && spark.h <= 40, spark);
check("Overview: the light graph runs from the tracks' left edge to the pills' right edge", spark && Math.abs(spark.l - spark.trl) < 1 && Math.abs(spark.r - spark.pillr) < 1, spark);
check("Overview: the light graph is the 4 hour black to yellow line", spark && /last 4 hours/.test(spark.label) && spark.stroke.startsWith("url(#ls-"), spark);
check("Overview: the light graph covers 4 hours in 49 points, like the zone's light card", await ev(`(()=>{const d=(h)=>h.match(/<path d="([^"]+)" fill="none"/)[1].split(/[ML]/).filter(Boolean).length;return d(lightSpark(zones[0]))===49&&d(lightCards(zones[0]))===49})()`));
await ev(`window.__keep=zones[1].sensors.map(s=>s.avg);zones[1].sensors.forEach(s=>{if(s.kind==="env")s.avg=false});render()`); await sleep(40);
check("Overview: a zone with no light reading draws no light graph", (await ev(`document.querySelectorAll("#main .zone-card")[1].querySelectorAll("svg.lspark").length`)) === 0);
await ev(`zones[1].sensors.forEach((s,i)=>{s.avg=window.__keep[i]});render()`);
await shot("overview-light-graph");
await phone(800, 1200); await sleep(60); await shot("overview-light-graph-foldable"); await phone(390, 844);

// ---------- Soil calibration
await phone(390, 844);
const setupOnly = async () => { await ev(`ui.sched=null;ui.soilw=null;ui.leafw=null;ui.vpdw=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";render();window.scrollTo(0,0)`); await sleep(40); };
const cClick = async (sel) => { await ev(`document.querySelector('${sel}').click()`); await sleep(50); };
const soil = (id) => ev(`zones[0].sensors.find(s=>s.id==="${id}")`);
const toSoil = async (id) => { await setupOnly(); await cClick('[data-calw="garden"]'); await cClick(`[data-cprobe="${id}"]`); };
await setupOnly();
await cClick('[data-calw="garden"]');
check("Soil: probes are listed on Sensor Calibration, and it says it never runs a pump", (await ev(`!ui.soilw && !!document.querySelector('[data-cprobe="g-s1"]') && document.querySelector("#main").textContent.includes("never runs a pump")`)) === true);
check("Soil: a probe that isn't reporting can't be picked", (await ev(`document.querySelector('[data-cprobe="g-s2"]').disabled && document.querySelector("#main").textContent.includes("Not reporting")`)) === true);
await cClick('[data-cprobe="g-s1"]');
check("Soil: the wizard starts at full saturation", same(await ev(`[...document.querySelectorAll(".steps li")].map(e=>e.textContent)`), ["1. Full saturation", "2. Field capacity", "3. Check"]) && (await ev(`document.querySelector('.steps [aria-current]').textContent`)) === "1. Full saturation");
check("Soil: the flood steps say to turn irrigation off", (await ev(`document.querySelector("#main").textContent`)).includes("Turn off any automatic irrigation"));
check("Soil: a 1 s probe gets no rate warning", !(await ev(`document.querySelector("#main").textContent`)).includes("reports every"));
await cClick("[data-cstart]");
check("Soil: Start records", (await ev(`ui.soilw.fsRun.stage`)) === "recording");
await cClick("[data-cfinish]");
const ceil = await ev(`ui.soilw.fsRun.result`);
check("Soil: full saturation is the ceiling", ceil.value === 92.6 && ceil.trusted === true, ceil);
check("Soil: not the flat stretch below it", ceil.shelf && Math.abs(ceil.shelf.level - 91.5) < 0.05 && (await ev(`document.querySelector("#main").textContent`)).includes("isn't used"), ceil);
check("Soil: the chart draws it", (await ev(`!!document.querySelector("#main .chart svg polyline")`)) === true);
await cClick("[data-cnextfs]");
check("Soil: field capacity starts waiting by itself after a flood", (await ev(`ui.soilw.step===3 && ui.soilw.fcRun.stage==="draining"`)) === true);
await goTab("Overview"); await setupOnly(); await cClick('[data-calw="garden"]');
check("Soil: leaving marks the probe as in progress", (await ev(`document.querySelector('[data-cprobe="g-s1"]').textContent`)) === "Continue" && (await ev(`document.querySelector("#cal-soil").textContent`)).includes("Waiting for field capacity"));
check("Soil: other probes aren't touched by it", (await ev(`document.querySelector('[data-cprobe="g-s3"]').textContent`)) === "Calibrate");
await cClick('[data-cprobe="g-s1"]');
check("Soil: coming back picks up where it was", (await ev(`ui.soilw.step===3 && ui.soilw.fcRun.stage==="draining"`)) === true);
await cClick("[data-cjump]");
check("Soil: field capacity is read once it holds", (await ev(`ui.soilw.fcRun.value`)) === 78.4, await ev(`ui.soilw.fcRun`));
await cClick("[data-cnextfc]");
const beforeSave = await soil("g-s1");
check("Soil: Check holds both results in boxes", (await ev(`document.querySelector("#cin-fs").value`)) === "92.6" && (await ev(`document.querySelector("#cin-fc").value`)) === "78.4");
check("Soil: it previews what happens to normalised VWC", (await ev(`document.querySelector("#cp-fs").textContent`)).includes("56.6%"), await ev(`document.querySelector("#cp-fs").textContent`));
check("Soil: it warns about what reads normalised VWC", (await ev(`document.querySelector("#main").textContent`)).includes("irrigation controller"));
check("Soil: it reminds you to put the report rate back", (await ev(`document.querySelector("#main").textContent`)).includes("back to 10 s"));
check("Soil: nothing has gone to the probe yet", (await ev(`soilSends.length`)) === 0 && beforeSave.fsLive === 90);
await tap("#cin-fs"); await type("9.2"); await key("Enter", 13);
check("Soil: a dropped digit is refused", (await ev(`document.querySelector("[data-csave]").disabled`)) === true && (await ev(`document.querySelector("#c-issues").textContent`)).includes("dropped digit"), await ev(`document.querySelector("#c-issues").textContent`));
await tap("#c-issues .notice");
check("Soil: Fix lands on the box", (await active()) === "cin-fs", await active());
await type("92,6"); await key("Enter", 13);
await tap("#cin-fc"); await type("95"); await key("Enter", 13);
check("Soil: field capacity can't reach full saturation", (await ev(`document.querySelector("#c-issues").textContent`)).includes("below full saturation"), await ev(`document.querySelector("#c-issues").textContent`));
await tap("#cin-fc"); await type(""); await ev(`document.activeElement.value=""`); await key("Enter", 13);
check("Soil: blank keeps the old value", (await ev(`ui.soilw.vals.fc`)) === 95);
await tap("#cin-fc"); await type("78.4"); await tap("#cin-fs");
check("Soil: moving between boxes keeps focus", (await active()) === "cin-fs", await active());
await key("Escape", 27);
await cClick("[data-csave]"); await cClick("[data-rapply]");
check("Soil: Save sends both to the probe", same(await ev(`soilSends.map(x=>x.entity_id+"="+x.value)`), ["number.soil_1_full_saturation=92.6", "number.soil_1_field_capacity=78.4"]), await ev(`soilSends`));
check("Soil: not saved until the probe reports it", (await soil("g-s1")).fsLive === 90 && (await ev(`document.querySelector("#main").textContent`)).includes("Sending to the probe"));
check("Soil: everything locks while waiting", (await ev(`document.querySelector("#cin-fs").disabled && document.querySelector("[data-csave]").disabled && document.querySelector("[data-cexit]").disabled`)) === true);
await sleep(ACK);
const afterSave = await soil("g-s1");
check("Soil: the probe's report is what's stored", afterSave.fsLive === 92.6 && afterSave.fcLive === 78.4, afterSave);
check("Soil: normalised VWC follows and raw doesn't", afterSave.vwc === 56.6 && Math.abs(afterSave.vwc * afterSave.fsLive - beforeSave.vwc * beforeSave.fsLive) < 5, afterSave);
check("Soil: then it closes back to Sensor Calibration and says so", (await ev(`!ui.soilw && !soilRuns["g-s1"] && !!document.querySelector("#cal-soil")`)) === true && (await ev(`document.querySelector("#toast").textContent`)).includes("on the probe"));
await ev(`soilSends.length=0`);
await toSoil("g-s3");
check("Soil: a slow probe is warned before flooding", (await ev(`document.querySelector("#main").textContent`)).includes("reports every 10 s"));
await cClick("[data-cstart]"); await cClick("[data-cfinish]");
check("Soil: too few readings near the peak says so", (await ev(`ui.soilw.fsRun.result.trusted`)) === false && (await ev(`document.querySelector("#main").textContent`)).includes("Too few readings close to the peak"), await ev(`ui.soilw.fsRun.result`));
check("Soil: and a rough figure isn't dressed up as exact", (await ev(`document.querySelector("#main").textContent`)).includes("Rough figure") && !(await ev(`document.querySelector("#main").textContent`)).includes("within 0."));
await cClick("[data-cagain]");
check("Soil: Run again starts over", (await ev(`ui.soilw.fsRun.stage`)) === "ready");
await cClick("[data-cskipfs]");
check("Soil: skipping a flood doesn't start the wait", (await ev(`ui.soilw.step===3 && ui.soilw.fcRun.stage==="ready"`)) === true);
await cClick("[data-cskipfc]");
check("Soil: skipping both leaves nothing to save", (await ev(`ui.soilw.step===4 && document.querySelector("[data-csave]").disabled`)) === true);
await tap("#cin-fc"); await type("74"); await key("Enter", 13);
await ev(`zones[0].sensors.find(s=>s.id==="g-s3").calStuck=true`);
await cClick("[data-csave]"); await cClick("[data-rapply]"); await sleep(GIVE_UP);
check("Soil: only the changed value is sent", same(await ev(`soilSends.map(x=>x.entity_id+"="+x.value)`), ["number.soil_3_field_capacity=74"]), await ev(`soilSends`));
check("Soil: no reply is never shown as saved", (await soil("g-s3")).fcLive === 72 && (await ev(`document.querySelector("#main").textContent`)).includes("Not confirmed. The probe still reports 72.0%"));
check("Soil: the typed value stays to try again", (await ev(`document.querySelector("#cin-fc").value`)) === "74.0" && (await ev(`document.querySelector("[data-csave]").disabled`)) === false);
check("Soil: the review says what wasn't confirmed", (await ev(`document.querySelector("#modal").textContent`)).includes("Field capacity: not confirmed. The probe still reports 72.0%"), await ev(`document.querySelector("#modal").textContent`));
await ev(`zones[0].sensors.find(s=>s.id==="g-s3").calStuck=false`);
await cClick("[data-rback]");
await cClick("[data-cexit]"); await ev(`document.querySelector("[data-gdiscard]")?.click()`); await sleep(30);
check("Soil: Cancel drops the run and changes nothing", (await ev(`!ui.soilw && !soilRuns["g-s3"] && !!document.querySelector("#cal-soil")`)) === true && (await soil("g-s3")).fcLive === 72);
for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await toSoil("g-s3"); await cClick("[data-cskipfs]"); await cClick("[data-cskipfc]"); await sleep(60);
  const hidden = [];
  for (const id of ["cin-fs", "cin-fc"]) {
    await tap(`#${id}`); await sleep(420);
    const r = await ev(`(()=>{const e=document.querySelector("#${id}").getBoundingClientRect(),bar=document.querySelector(".topbar"),head=getComputedStyle(bar).position==="sticky"?bar.getBoundingClientRect().bottom:0;return {top:e.top,bottom:e.bottom,head,h:innerHeight,active:document.activeElement.id}})()`);
    const line = r.h * (1 - kb);
    if (r.active !== id || r.top < r.head - 1 || r.bottom > line) hidden.push([id, Math.round(r.top), Math.round(r.bottom), "limit " + Math.round(line), r.active]);
    await key("Escape", 27); await sleep(40);
  }
  check(`Soil ${name} ${w}x${h}: every box stays above the keyboard and below the header`, hidden.length === 0, hidden);
  await cClick("[data-cexit]"); await ev(`document.querySelector("[data-gdiscard]")?.click()`); await sleep(30);
}
for (const [w, h] of [[390, 844], [320, 640]]) {
  await phone(w, h); await setupOnly(); await cClick('[data-calw="garden"]');
  const wide = [];
  const look = async (n) => { if (!(await ev(`document.documentElement.scrollWidth<=innerWidth`))) wide.push(n); };
  await look("probe"); await cClick('[data-cprobe="g-s3"]'); await look("flood"); await cClick("[data-cstart]"); await look("recording"); await cClick("[data-cfinish]"); await look("result");
  if (w === 390) await shot("soil-result-slow");
  await cClick("[data-cagain]"); await cClick("[data-cskipfs]"); await look("drain"); await cClick("[data-cskipfc]"); await look("check");
  check(`Soil ${w}px: no step scrolls sideways`, wide.length === 0, wide);
  if (w === 390) await shot("soil-check-phone");
  await cClick("[data-cexit]"); await ev(`document.querySelector("[data-gdiscard]")?.click()`); await sleep(30);
}
await phone(390, 844); await toSoil("g-s1"); await cClick("[data-cstart]"); await cClick("[data-cfinish]"); await shot("soil-result-phone");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await shot("soil-result-dark"); await send("Emulation.setEmulatedMedia", { features: [] });
await cClick("[data-cexit]"); await ev(`document.querySelector("[data-gdiscard]")?.click()`); await sleep(30);
await ev(`Object.assign(zones[0].sensors.find(s=>s.id==="g-s1"),{fsLive:90,fcLive:72,vwc:58.2});soilSends.length=0;ui.soilw=null;render()`);

// ---------- Adding and naming a zone
await phone(390, 844); await setupOnly();
const wizNext = () => cClick(`[data-wiz="next"]`), nextOff = () => ev(`document.querySelector('[data-wiz="next"]').disabled`);
const zoneCount = await ev(`zones.length`);
await cClick("[data-addzone]");
check("Zone: Add zone opens Placement on its name", (await ev(`ui.wiz.step===1 && !ui.wiz.id && document.querySelector("#main h1").textContent==="Add a zone" && !!document.querySelector("#wiz-name")`)) === true);
check("Zone: the name comes first in the steps", same(await ev(`[...document.querySelectorAll(".steps li")].map(e=>e.textContent)`), ["1. Zone", "2. Units", "3. Sensors"]));
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
check("Zone: a good name opens Next", (await nextOff()) === false && (await ev(`document.querySelector("#wiz-name-fix").hidden`)) === true);
await cClick('[data-wiz="back"]');
check("Zone: Cancel asks, and a name can't run as code in that either", (await ev(`document.querySelector("#modal").textContent`)).includes("Discard unsaved changes?") && (await ev(`!document.querySelector("#modal img") && !window.pwned`)) === true, await ev(`document.querySelector("#modal").textContent`));
await cClick("[data-gdiscard]");
check("Zone: Cancel creates nothing", (await ev(`zones.length`)) === zoneCount && (await ev(`!ui.wiz`)) === true);
await cClick("[data-addzone]"); await tap("#wiz-name"); await type(`Flower <img src=x onerror="window.pwned=1"> 2`);
await wizNext(); await wizNext();
check("Zone: Back keeps the name", await ev(`(()=>{document.querySelector('[data-wiz="back"]').click();document.querySelector('[data-wiz="back"]').click();return document.querySelector("#wiz-name").value.startsWith("Flower <img")})()`));
await sleep(40); await wizNext(); await wizNext();
check("Zone: with nothing to place it says what's next", (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Review and apply" && (await ev(`document.querySelector("#main").textContent`)).includes("No sensors to place yet"));
check("Zone: nothing is created before saving", (await ev(`zones.length`)) === zoneCount);
await shot("addzone-sensors-phone");
await wizNext();
check("Zone: the review lists the new zone", (await ev(`document.querySelector("#modal").textContent`)).includes("New zone") && (await ev(`document.querySelector("#modal").textContent`)).includes("Size"), await ev(`document.querySelector("#modal").textContent`));
check("Zone: a name can't run as code in the review", (await ev(`!document.querySelector("#modal img") && !window.pwned`)) === true);
await cClick("[data-rapply]");
const newId = await ev(`zones.at(-1).id`);
check("Zone: saving creates it and opens Map devices", (await ev(`zones.length`)) === zoneCount + 1 && (await ev(`!!ui.mapw && ui.mapw.id===zones.at(-1).id`)) === true);
check("Zone: it's in the tabs", (await ev(`[...document.querySelectorAll("#tabs button")].some(b=>b.textContent.startsWith("Flower <img"))`)) === true);
const newScreens = [];
for (const [e, name] of [[`ui.mapw=null;ui.screen="overview";render()`, "overview"], [`ui.screen="zone";ui.zone="${newId}";render()`, "zone"], [`ui.screen="devices";render()`, "devices"], [`ui.screen="setup";render()`, "setup"], [`openVpd("${newId}");render()`, "targets"], [`ui.vpdw=null;render()`, "setup again"]]) {
  await ev(e); await sleep(60);
  if (/NaN|undefined/.test(await ev(`document.querySelector("#main").textContent`))) newScreens.push(name);
}
check("Zone: a zone with no sensors shows no NaN anywhere", newScreens.length === 0, newScreens);
check("Zone: a name can't run as code", (await ev(`window.pwned === undefined && !document.querySelector("#main img, #tabs img")`)) === true);
check("Zone: it has no Sensor Calibration until it has sensors", same(await setupButtons(newId), ["Map devices", "Placement", "Day and night", "Targets", "Remove zone"]), await setupButtons(newId));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40);
check("Zone: no leaf link with no sensors to set", (await ev(`document.querySelectorAll("#main .tile [data-calw]").length`)) === 0);
await ev(`ui.screen="overview";render()`); await sleep(40);
check("Zone: an empty zone isn't reported as a problem", !(await ev(`document.querySelector("#main .notice")?.textContent || ""`)).includes("Flower"), await ev(`document.querySelector("#main .notice")?.textContent`));
await ev(`ui.screen="zone";ui.zone="${newId}";render()`); await sleep(40); await shot("newzone-phone");
await ev(`document.querySelector('#controls [data-mapw]').click()`); await sleep(40);
await ev(`ui.mapw.thenPlace=true;document.querySelector('[data-msensor="x-spare"]').click()`); await sleep(40);
await ev(`Object.assign(ui.mapw.choice["x-spare"],{temperature:"a",humidity:"a",vpd:"a",light:"a"});render()`); await sleep(40);
for (let i = 0; i < 3; i++) { await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(50); }
check("Zone: mapping can finish for a new zone", (await ev(`!document.querySelector('[data-mstep="next"]').disabled`)) === true, await ev(`document.querySelector("#main").textContent.slice(0,300)`));
await ev(`document.querySelector('[data-mstep="next"]').click()`); await sleep(60);
await ev(`document.querySelector("[data-rapply]")?.click()`); await sleep(60);
check("Zone: Map devices brings you back to place the sensors", (await ev(`!!ui.wiz && ui.wiz.step===3 && ui.wiz.pick==="x-spare" && !ui.mapw`)) === true);
await ev(`document.querySelector('[data-spot="0,0"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`); await sleep(40);
await wizNext(); await cClick("[data-rapply]");
check("Zone: placing it finishes on the new zone", (await ev(`ui.screen==="zone" && ui.zone==="${newId}" && zoneById("${newId}").sensors[0].pos.join()==="0,0"`)) === true);
check("Zone: its reading now shows", (await ev(`zoneById("${newId}").now.temperature`)) === 22);
await ev(`ui.wiz=null;ui.screen="setup";render()`); await sleep(40);
check("Zone: Sensor Calibration appears once it has sensors", same(await setupButtons(newId), ["Map devices", "Placement", "Day and night", "Sensor Calibration", "Targets", "Remove zone"]), await setupButtons(newId));
await ev(`document.querySelector('[data-wizard="veg"]').click()`); await sleep(40);
check("Zone: an existing zone's Placement can rename it", (await ev(`document.querySelector("#wiz-name").value`)) === "Veg" && (await nextOff()) === false);
await tap("#wiz-name"); await type("Veg north"); await wizNext(); await wizNext(); await wizNext(); await cClick("[data-rapply]");
check("Zone: renaming keeps its id and everything on it", (await ev(`zoneById("veg").name`)) === "Veg north" && (await ev(`zoneById("veg").sensors.length`)) > 0 && (await ev(`[...document.querySelectorAll("#tabs button")].some(b=>b.textContent==="Veg north")`)) === true);
await ev(`zoneById("veg").name="Veg";zones.pop();devices.forEach(d=>{d.zones=d.zones.filter(id=>id!=="${newId}")});ui.zone="garden";render()`);

await phone(390, 844); await reset(); await goTab("Garden"); await shot("controls-phone");
await ev(`window.scrollTo(0,520)`); await shot("controls-phone-2");
await sleep(60); await shot("zone-phone");
await openL(); await sleep(60); await shot("leaf-phone");
await ev(`zones[0].sensors.find(s=>s.id==="g-right").leafStuck=true`); await tap("#lin-g-right"); await type("1.5"); await key("Enter", 13); await leafSave(GIVE_UP);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await shot("leaf-phone-dark"); await send("Emulation.setEmulatedMedia", { features: [] });
await reset();

// Confirm edits: nothing moves until it's reviewed and applied, as PHASE does it
await phone(390, 844);
const modalText = () => ev(`document.querySelector("#modal").textContent`);
const modalOpen = () => ev(`!document.querySelector("#modal").hidden`);
const barOn = () => ev(`!document.querySelector("#draftbar").hidden`);
const barText = () => ev(`document.querySelector("#draftbar").textContent`);
const reviewBtn = () => ev(`document.querySelector("[data-dreview]").disabled`);
const clickIt = async (sel) => { await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(50); };
const openT = async (id) => { await ev(`ui.review=null;ui.guard=null;renderModal();ui.soilw=null;ui.leafw=null;ui.mapw=null;ui.wiz=null;ui.screen="setup";openVpd("${id}");render();window.scrollTo(0,0)`); await sleep(50); };
await ev(`leafSends.length=0;zones[0].sensors.forEach(s=>{delete s.leafStuck});zones[0].sensors.find(s=>s.id==="g-left").leafLive=-1;zones[0].sensors.find(s=>s.id==="g-right").leafLive=-1;zones[0].sensors.find(s=>s.id==="g-under").leaf=-0.5;zones[0].leafBasis=undefined`);
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
check("Confirm: the page behind can't be reached", (await ev(`document.querySelector("#main").inert && document.querySelector(".topbar").inert`)) === true);
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
await ev(`zones[0].sensors.find(s=>s.id==="g-left").leafLive=-1;zones[0].sensors.find(s=>s.id==="g-right").leafLive=-1;leafSends.length=0`);
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
check("Targets: Apply stores them and leaves", (await modalOpen()) === false && (await ev(`!ui.vpdw && ui.screen==="zone" && ui.zone==="nursery"`)) === true);
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
check("Linked: helper values are shown as a preview, not applied", (await modalText()).includes("stay a preview") && (await ev(`document.querySelector("[data-rapply]").textContent`)) === "Apply 1 change" && (await ev(`document.querySelectorAll(".review-list.preview .review-row").length`)) === 1, await modalText());
const lp = await ev(`ui.vpdw.period`), minBefore = await ev(`zones[0].bands["${lp}"].temperature[0]`), lowWant = await ev(`ui.vpdw.bands["${lp}"].temperature[1]`);
await clickIt("[data-rapply]");
check("Linked: only the one stored here moves", (await ev(`zones[0].bands["${lp}"].temperature[0]`)) === minBefore && (await ev(`zones[0].bands["${lp}"].temperature[1]`)) === lowWant);
await openT("garden"); await ev(`ui.vpdw.bands[ui.vpdw.period].temperature[0]-=1;render()`); await sleep(40);
check("Linked: helper values alone have nothing to apply", (await barText()).includes("preview only"), await barText());
await clickIt("[data-dreview]");
check("Linked: and Apply stays off", (await ev(`document.querySelector("[data-rapply]").disabled`)) === true);
await clickIt("[data-rback]");

await openT("nursery"); await tap("#vin-temperature-2"); await type("23.5"); await key("Enter", 13); await sleep(80);
await clickIt("[data-calw]");
await tap("#lin-n-env"); await type("1.5"); await key("Enter", 13); await sleep(80);
await clickIt("[data-lexit]");
check("Round trip: Back from offsets only names the offsets", (await modalText()).includes("1 unsaved change in Nursery"), await modalText());
await clickIt("[data-gdiscard]");
check("Round trip: the chart's draft survives", (await ev(`!!ui.vpdw && !ui.leafw`)) === true && (await barOn()) === true, await barText());
await goTab("Overview"); await sleep(60);
check("Round trip: a tab still asks about it", (await modalText()).includes("Discard unsaved changes?"), await modalText());
await clickIt("[data-gdiscard]");

await ev(`ui.screen="setup";ui.wiz=null;openWizard("veg");render()`); await sleep(40);
await clickIt('[data-wiz="next"]'); await clickIt('[data-wiz="next"]');
check("Placement: nothing changed just finishes", (await ev(`document.querySelector('[data-wiz="next"]').textContent`)) === "Finish", await ev(`document.querySelector('[data-wiz="next"]').textContent`));
await clickIt('[data-wiz="next"]');
check("Placement: without a review", (await modalOpen()) === false && (await ev(`!ui.wiz`)) === true);
await ev(`ui.screen="setup";openWizard("veg");ui.wiz.name="Veg two";render()`); await sleep(40);
await clickIt('[data-wiz="back"]');
check("Placement: Cancel asks once something changed", (await modalText()).includes("Discard unsaved changes?") && (await ev(`!!ui.wiz`)) === true, await modalText());
await clickIt("[data-gkeep]"); await clickIt('[data-wiz="next"]'); await clickIt('[data-wiz="next"]');
await ev(`ui.wiz.sensors[0].level="under";ui.wiz.sensors[0].pos=[0,0];render()`); await sleep(40);
await clickIt('[data-wiz="next"]');
check("Placement: the review lists name, spot and height", /Zone name.*Veg two/.test(await modalText()) && (await modalText()).includes("Veg environment position") && (await modalText()).includes("Veg environment height"), await modalText());
check("Placement: nothing's saved yet", (await ev(`zones[1].name`)) === "Veg");
await clickIt("[data-rapply]");
check("Placement: Apply saves it", (await ev(`zones[1].name`)) === "Veg two" && (await ev(`zones[1].sensors[0].level`)) === "under");
await ev(`zones[1].name="Veg";zones[1].sensors[0].level="above";zones[1].sensors[0].pos=[0.5,0.5]`);

await ev(`ui.screen="setup";ui.wiz=null;openMap("veg");render()`); await sleep(40);
for (let i = 0; i < 3; i++) await clickIt('[data-mstep="next"]');
check("Map: nothing changed just finishes", (await ev(`document.querySelector('[data-mstep="next"]').textContent`)) === "Finish", await ev(`document.querySelector('[data-mstep="next"]').textContent`));
await clickIt('[data-mstep="next"]');
check("Map: without a review", (await modalOpen()) === false && (await ev(`!ui.mapw`)) === true);
const wasLinked = await ev(`zones[1].linked`);
await ev(`openMap("veg");ui.mapw.band=${wasLinked} ? "here" : "helpers";ui.mapw.step=4;render()`); await sleep(40);
await clickIt('[data-mstep="next"]');
check("Map: the review lists what moved", (await modalText()).includes("Limits") && (await ev(`zones[1].linked`)) === wasLinked, await modalText());
await clickIt("[data-rback]"); await ev(`ui.mapw.step=1;render()`); await sleep(40);
await clickIt('[data-mstep="back"]');
check("Map: Cancel asks once something changed", (await modalText()).includes("Discard unsaved changes?"), await modalText());
await clickIt("[data-gdiscard]");
check("Map: discarding keeps what was saved", (await ev(`!ui.mapw`)) === true && (await ev(`zones[1].linked`)) === wasLinked);

await toSoil("g-s3"); await cClick("[data-cstart]"); await cClick("[data-cfinish]");
await cClick("[data-cexit]");
check("Soil: Cancel with readings asks", (await modalText()).includes("Discard this calibration?") && (await ev(`!!ui.soilw`)) === true, await modalText());
await cClick("[data-gkeep]");
check("Soil: Keep editing keeps the result", (await ev(`ui.soilw.fsRun.stage`)) === "done");
await goTab("Overview"); await sleep(60);
check("Soil: a tab keeps the run, so it doesn't ask", (await modalOpen()) === false && (await ev(`!!soilRuns["g-s3"]`)) === true);
await ev(`delete soilRuns["g-s3"]`);
await toSoil("g-s3"); await cClick("[data-cskipfs]"); await cClick("[data-cskipfc]"); await sleep(40);
await ev(`ui.soilw.vals.fc=ui.soilw.vals.fc-2;render()`); await sleep(40);
await cClick("[data-csave]");
check("Soil: the review shows before and after", (await modalText()).includes("Soil 3 field capacity") && (await ev(`document.querySelectorAll("#review-items .review-row").length`)) === 1, await modalText());
check("Soil: nothing's sent yet", (await ev(`ui.soilw.sending`)) === false);
await cClick("[data-rback]"); await cClick("[data-cexit]"); await ev(`delete soilRuns["g-s3"]`);

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
await ev(`toast("Testing the toast")`); await sleep(40);
check("Bar: the toast clears it", (await ev(`document.querySelector("#toast").getBoundingClientRect().bottom<=document.querySelector("#draftbar").getBoundingClientRect().top`)) === true);
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

// ---------- Lights in Controls
await reset(); await goTab("Garden");
check("Lights: last group, beside the light reading", (await ev(`[...document.querySelectorAll("[data-cgroup]")].at(-1).dataset.cgroup`)) === "Lights" && (await ev(`document.querySelector('[data-cgroup="Lights"] .ctl-reading').textContent`)).includes("lx"));
check("Lights: a controller shows its brightness", (await ev(`[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][0].textContent`)).includes("Brightness 80%"));
check("Lights: an off controller shows no stale brightness", await ev(`(()=>{ui.zone="veg";render();const t=[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][0].textContent;return t.includes("Brightness")&&!/Brightness \d/.test(t)&&t.includes("Off")})()`));
check("Lights: shared lights name who shares them", (await ev(`[...document.querySelectorAll('[data-cgroup="Lights"] .dev')][1].textContent`)).includes("Shared with Nursery"));
await ev(`ui.zone="garden";render()`); await sleep(40);
await ev(`document.querySelector('[data-cgroup="Lights"] [data-preview]').click()`); await sleep(40);
check("Lights: Preview like the rest, a tap sends nothing", (await ev(`document.querySelector("#toast").textContent`)) === (await ev(`SENT`)));
await shot("lights-phone");
await ev(`ui.screen="setup";render()`); await sleep(40);
await ev(`document.querySelector('[data-role="plug"][data-val="Light"]').click()`); await sleep(40); await goTab("Garden");
check("Lights: a plug marked Light joins them", (await groupNames()).includes("Plug 7"), await groupNames());
await ev(`devices.find(d=>d.id==="plug").type=null;render()`);
await ev(`openMap("garden");ui.mapw.step=2;render()`); await sleep(40);
check("Lights: Map devices lists them and offers Light as a type", (await ev(`!!document.querySelector('[data-mdevice="lc-over"]') && [...document.querySelector('[data-mrole="lc-over"]').options].some(o=>o.textContent==="Light")`)) === true);
await ev(`ui.mapw=null;render()`);

// ---------- Day and night
await phone(390, 844); await reset(); await setupOnly();
const setBox = async (k, v) => { await ev(`(()=>{const e=document.querySelector("#sin-${k}");e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("change",{bubbles:true}))})()`); await sleep(40); };
const schedOpen = async (id) => { await setupOnly(); await clickIt(`[data-schedw="${id}"]`); };
const schedModal = () => ev(`document.querySelector("#modal").textContent`);
const schedSent = () => ev(`schedSends.length`);
check("Sched: Setup says how long the day is", (await ev(`document.querySelector("#main").textContent`)).includes("12h 00m of light"));
await schedOpen("garden");
check("Sched: opens on the zone's times", (await ev(`document.querySelector("#sin-day").value+document.querySelector("#sin-night").value`)) === "07:0019:00");
check("Sched: says it's a v2 page", (await ev(`document.querySelector(".sched-title").textContent`)).includes("Coming in v2"));
check("Sched: shows the photoperiod", (await ev(`document.querySelector("#s-len").textContent`)) === "12h 00m of light, 12h 00m of dark", await ev(`document.querySelector("#s-len").textContent`));
check("Emerson: same sum as the HA failsafe", (await ev(`document.querySelector("#s-em").textContent`)) === "Red lights 06:55 - 07:10 and 18:50 - 19:05", await ev(`document.querySelector("#s-em").textContent`));
check("Sched: light limits aren't here, they belong to the sensors", (await ev(`!document.querySelector("#s-limits") && !document.querySelector("#sin-dayMin") && !document.querySelector("#main").textContent.includes(" lx")`)) === true);
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
check("Review: and the red windows", rv.includes("Red lights 06:55 - 07:10 and 17:50 - 18:05"), rv);
check("Review: and that it moves whatever reads the helper", rv.includes("anything reading them"), rv);
await shot("sched-review-phone");
const sentBefore = await schedSent();
await clickIt("[data-rapply]");
check("Apply: sends only what changed, to the right helper", (await schedSent()) === sentBefore + 1 && (await ev(`schedSends.at(-1).entity_id`)) === "input_datetime.garden_night_time" && (await ev(`schedSends.at(-1).value`)) === "18:00", await ev(`schedSends`));
check("Apply: never optimistic", (await ev(`zoneById("garden").nightAt`)) === 19 * 60 && (await ev(`document.querySelector("[data-rapply]").textContent`)).includes("verifying"));
await sleep(ACK);
check("Apply: counts once Home Assistant reports it", (await ev(`zoneById("garden").nightAt`)) === 18 * 60 && (await ev(`!ui.sched && !ui.review`)) === true);
await ev(`zoneById("garden").nightAt=19*60;render()`);
await schedOpen("veg");
check("Sched: across midnight the length is right", (await ev(`document.querySelector("#s-len").textContent`)) === "18h 00m of light, 6h 00m of dark", await ev(`document.querySelector("#s-len").textContent`));
check("Sched: shared helpers are named", (await ev(`document.querySelector("#s-times").textContent`)).includes("Nursery uses the same helpers"));
check("Emerson: only where it's set up", (await ev(`!document.querySelector("#s-emerson")`)) === true);
await setBox("day", "15:00"); await clickIt("[data-dreview]");
check("Review: names the zone that moves with it", (await schedModal()).includes("Veg and Nursery") && (await schedModal()).includes("Nursery uses the same helpers"), await schedModal());
await clickIt("[data-rapply]"); await sleep(ACK);
check("Apply: the sharing zone moves too", (await ev(`zoneById("veg").dayAt`)) === 15 * 60 && (await ev(`zoneById("nursery").dayAt`)) === 15 * 60);
await ev(`zoneById("veg").dayAt=16*60;zoneById("nursery").dayAt=16*60;render()`);
await schedOpen("garden"); await ev(`zoneById("garden").helperStuck=true`); await setBox("morning", "7");
await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(GIVE_UP);
check("Apply: no answer is never shown as saved", (await ev(`zoneById("garden").emerson.morning`)) === 5 && (await schedModal()).includes("still reports 5 min"), await schedModal());
check("Apply: the review stays open to try again", (await ev(`!!ui.review && !!ui.sched`)) === true && (await ev(`!document.querySelector("[data-rapply]").disabled`)) === true);
await ev(`zoneById("garden").helperStuck=false`); await clickIt("[data-rapply]"); await sleep(ACK);
check("Apply: and trying again works", (await ev(`zoneById("garden").emerson.morning`)) === 7 && (await ev(`!ui.review`)) === true);
await ev(`zoneById("garden").emerson.morning=5;render()`);
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
await clickIt("[data-sexit]");
check("Leaving: Back asks first", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Discard unsaved changes?" && (await ev(`!!ui.sched`)) === true);
await clickIt("[data-gkeep]"); await goTab("Overview");
check("Leaving: so does a tab", (await ev(`!!ui.guard`)) === true);
await clickIt("[data-gdiscard]");
check("Leaving: discarding leaves it unsaved", (await ev(`!ui.sched && zoneById("garden").emerson.morning===5`)) === true);
await ev(`zoneById("nursery").periodMode="fixed";zoneById("nursery").dayAt=16*60;render()`);
await schedOpen("nursery");
check("Sched: Set here shares with nobody", (await ev(`document.querySelector("#s-times").textContent`)).includes("Stored in Environment Control") && !(await ev(`document.querySelector("#s-times").textContent`)).includes("same helpers"));
await setBox("day", "15:30"); const sentFixed = await schedSent(); await clickIt("[data-dreview]"); await clickIt("[data-rapply]"); await sleep(40);
check("Sched: Set here saves at once and sends nothing", (await schedSent()) === sentFixed && (await ev(`zoneById("nursery").dayAt`)) === 15.5 * 60 && (await ev(`zoneById("veg").dayAt`)) === 16 * 60);
await ev(`zoneById("nursery").periodMode=undefined;zoneById("nursery").dayAt=16*60;zoneById("garden").periodMode="detected";zoneById("garden").lights=["switch.tent_lights"];render()`);
await schedOpen("garden");
check("Sched: Detected has no times to set", (await ev(`!document.querySelector("#sin-day") && document.querySelector("#s-times").textContent.includes("no times to set") && !!document.querySelector("#s-times [data-mapw]")`)) === true);
check("Sched: but its Emerson effect still works", (await ev(`!!document.querySelector("#sin-morning")`)) === true && !/NaN|undefined/.test(await ev(`document.querySelector("#main").textContent`)));
await setBox("morning", "9"); await clickIt("#s-times [data-mapw]");
check("Sched: Map devices from here asks before dropping an edit", (await ev(`!!ui.guard`)) === true);
await clickIt("[data-gkeep]"); await clickIt("[data-ddiscard]");
await ev(`zoneById("garden").periodMode=undefined;zoneById("garden").lights=[];ui.sched=null;render()`);
await reset(); await goTab("Setup");
await ev(`document.querySelector('#main [data-schedw="garden"]').click()`); await sleep(50);
await ev(`document.querySelector("[data-sexit]").click()`); await sleep(50);
check("Sched: Back returns to where you came from", (await ev(`ui.screen==="setup" && !ui.sched`)) === true);

/* Light limits are thresholds on the sensor, so they sit with the other thresholds. Same helpers, different zones: Veg and Nursery share a schedule but not these. */
const limitTables = () => ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[...t.querySelectorAll("tr")].pop().textContent)`);
const limitBox = () => ev(`document.querySelector("#vin-light-0").value`);
const limitCell = () => ev(`document.querySelector("#vin-light-0").closest("label").textContent`);
const period2 = async (p) => { await ev(`document.querySelector('[data-vperiod="${p}"]').click()`); await sleep(40); };
const typeLimit = async (v) => { await ev(`(()=>{const e=document.querySelector("#vin-light-0");e.focus();e.value="${v}";e.dispatchEvent(new Event("change",{bubbles:true}));e.blur()})()`); await sleep(40); };
const noChart = () => ev(`ui.vpdw.edit`);
await reset(); await goTab("Garden");
check("Limits: the zone page lists them with the other thresholds", same(await limitTables(), ["Lightlx2,000", "Lightlx200"]), await limitTables());
await ev(`document.querySelector('[data-vpd="garden"]').click()`); await sleep(50); await period2("day");
check("Limits: Day holds the minimum, in lux, in one column, with no Target", (await limitBox()) === "2000" && (await limitCell()) === "Min" && (await ev(`document.querySelector('[data-vrow="light"]').textContent`)) === "Light lxMin" && (await ev(`document.querySelector("#vin-light-0").closest("label").getBoundingClientRect().width<document.querySelector("#vin-temperature-0").closest("label").getBoundingClientRect().width*1.2`)) === true);
await period2("night");
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
check("Limits: a linked zone's change is a preview, as with its other helpers", (await schedModal()).includes("Day Light Min") && (await schedModal()).includes("2,500 lx") && (await ev(`vpdDraft(ui.vpdw).items.length`)) === 0 && (await ev(`vpdDraft(ui.vpdw).skipped.length`)) === 1, await schedModal());
await ev(`ui.review=null;render()`); await sleep(30);
await ev(`document.querySelector('[data-vstage="veg"]').click()`); await sleep(40);
check("Limits: an Athena stage leaves them alone", (await limitBox()) === "2500");
await clickIt("[data-ddiscard]");
check("Limits: Discard puts them back", (await limitBox()) === "2000" && (await ev(`document.querySelector("#draftbar").hidden`)) === true);
await ev(`zoneById("garden").linked=false;render()`); await typeLimit("2500"); await period2("night"); await typeLimit("150");
await clickIt("[data-dreview]");
check("Limits: a zone not on helpers lists both for review", (await ev(`vpdDraft(ui.vpdw).items.map((i)=>i.label).join()`)) === "Day Light Min,Night Light Max", await ev(`vpdDraft(ui.vpdw).items.map((i)=>i.label).join()`));
await clickIt("[data-rapply]"); await sleep(60);
check("Limits: and saves them, without touching the schedule", same(await ev(`[zoneById("garden").lightLimits.dayMin,zoneById("garden").lightLimits.nightMax,zoneById("garden").dayAt,schedSends.length]`), [2500, 150, 7 * 60, await schedSent()]), await ev(`zoneById("garden").lightLimits`));
check("Limits: no working field leaks into the saved bands", (await ev(`zoneById("garden").bands.day.light===undefined && zoneById("garden").bands.night.light===undefined`)) === true);
check("Limits: the zone page follows", same(await limitTables(), ["Lightlx2,500", "Lightlx150"]), await limitTables());
await ev(`Object.assign(zoneById("garden"),{linked:true,lightLimits:{dayMin:2000,nightMax:200}});render()`);
await reset(); await goTab("Veg");
const vegLimit = await ev(`zoneById("veg").lightLimits.dayMin`), nurseryLimit = await ev(`zoneById("nursery").lightLimits.dayMin`);
check("Limits: Veg and Nursery each have their own", vegLimit !== nurseryLimit, [vegLimit, nurseryLimit]);
for (const [w, h, name, kb] of [[800, 1000, "foldable", KEYBOARD.portrait], [390, 844, "phone", KEYBOARD.portrait], [320, 640, "small phone", KEYBOARD.portrait], [844, 390, "landscape", KEYBOARD.landscape]]) {
  await phone(w, h); await reset(); await goTab("Garden"); await ev(`document.querySelector('[data-vpd="garden"]').click()`); await sleep(60);
  await tap("#vin-light-0"); await sleep(420);
  const r = await ev(`(()=>{const e=document.querySelector("#vin-light-0").getBoundingClientRect();return {bottom:e.bottom,h:innerHeight,active:document.activeElement.id}})()`);
  check(`Limits ${name} ${w}x${h}: the box stays above the keyboard`, r.active === "vin-light-0" && r.bottom <= r.h * (1 - kb), r);
  await key("Escape", 27); await sleep(40);
  check(`Limits ${name}: no sideways scroll`, await ev(`document.documentElement.scrollWidth<=innerWidth`));
  if (w >= 500) { const e = await ev(`(()=>{const i=document.querySelector("#vin-light-0");i.value="10000";const r=[i.scrollWidth,i.clientWidth];i.value=2000;return r})()`); check(`Limits ${name}: the widest value fits one column`, e[0] <= e[1], e); }
  if (w === 800) { await ev(`document.querySelector('[data-vrow="light"]').scrollIntoView({block:"center"})`); await shot("limits-targets-foldable"); await reset(); await goTab("Garden"); await ev(`document.querySelector(".tbl-wrap").scrollIntoView({block:"center"})`); await sleep(40); await shot("limits-table-foldable"); check("Limits foldable: every table fits its card", await ev(`[...document.querySelectorAll(".tbl-wrap")].every((t)=>t.scrollWidth<=t.clientWidth)`), await ev(`[...document.querySelectorAll(".tbl-wrap")].map((t)=>[t.scrollWidth,t.clientWidth])`)); }
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

// Removing a zone. Last, because it takes the fixture's zones with it, so nothing here can call reset().
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await phone(390, 844); await setupNow();
const zoneIds = () => ev(`zones.map(z=>z.id)`);
const startZones = await zoneIds();
const askRemove = (id) => cClick(`[data-rmzone="${id}"]`);
const confirmRemove = () => cClick("[data-gdiscard]");
const dialog = () => ev(`document.querySelector("#modal").textContent`);
const mainText = () => ev(`document.querySelector("#main").textContent`);
const see = async (screen, zone) => { await ev(`ui.screen="${screen}";${zone ? `ui.zone="${zone}";` : ""}render();window.scrollTo(0,0)`); await sleep(40); return mainText(); };
const noJunk = (t) => !/NaN|undefined/.test(t);
check("Remove: every zone has the button, last in its row", (await ev(`zones.every(z=>document.querySelector('[data-mapw="'+z.id+'"]').parentElement.lastElementChild.dataset.rmzone===z.id)`)) === true);
const toRow = () => ev(`document.querySelector('[data-rmzone="garden"]').scrollIntoView({block:"center"})`);
await toRow(); await shot("remove-setup-phone");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await setupNow(); await toRow(); await shot("remove-setup-desktop"); await phone(390, 844); await setupNow();
await ev(`soilRuns["g-s1"]={id:"garden",step:2,probe:"g-s1",fsRun:{stage:"recording"},fcRun:{stage:"ready"},vals:null,status:{fs:"",fc:""},sending:false}`);
await askRemove("garden");
const askText = await dialog();
check("Remove: it asks first, named after the zone", (await ev(`document.querySelector("#dlg-title").textContent`)) === "Remove Garden?", askText);
check("Remove: the dialog says it can't be undone and that HA doesn't change", askText.includes("can't be undone") && askText.includes("Nothing in Home Assistant changes"), askText);
check("Remove: it names what goes", ["Placement", "Sensors", "Devices", "Targets", "Day and night"].every((w) => askText.includes(w)), askText);
check("Remove: shared hardware is shown staying in its other zones", /\d+ stay in Veg and Nursery/.test(askText), askText);
check("Remove: a soil run part way through is named", /Soil calibration.*part way through/.test(askText), askText);
check("Remove: focus lands on the title, not the red button", (await ev(`document.activeElement.id`)) === "dlg-title", await ev(`document.activeElement.outerHTML.slice(0,60)`));
check("Remove: the page behind is locked", (await ev(`document.querySelector("#main").inert`)) === true);
check("Remove: nothing goes before confirming", same(await zoneIds(), startZones), await zoneIds());
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
await cClick("[data-gkeep]"); await phone(390, 844); await setupNow();
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await sleep(60); await toRow(); await shot("remove-setup-dark"); await askRemove("garden"); await shot("remove-dialog-dark"); await cClick("[data-gkeep]");
await send("Emulation.setEmulatedMedia", { features: [] });

const beforeHeater = await ev(`devices.find(d=>d.id==="heater").zones`);
await ev(`ui.zone="garden"`); await askRemove("garden"); await confirmRemove(); await sleep(60);
check("Remove: the zone goes", !(await zoneIds()).includes("garden"), await zoneIds());
check("Remove: its tab goes", !(await ev(`[...document.querySelectorAll("[data-go=zone]")].some(b=>b.dataset.zone==="garden")`)));
check("Remove: its activity, lights and soil runs go", (await ev(`ACTIVITY.garden===undefined && LIGHTS.garden===undefined && !soilRuns["g-s1"]`)) === true);
check("Remove: no device still points at it", (await ev(`devices.every(d=>!d.zones.includes("garden"))`)) === true);
check("Remove: shared hardware stays in its other zones", same(await ev(`devices.find(d=>d.id==="heater").zones`), beforeHeater.filter((z) => z !== "garden")), await ev(`devices.find(d=>d.id==="heater").zones`));
check("Remove: the open zone moves to one that exists", (await ev(`!!zoneById(ui.zone)`)) === true, await ev(`ui.zone`));
check("Remove: it stays on Setup and says so", (await ev(`ui.screen`)) === "setup" && (await ev(`document.querySelector("#toast")?.textContent||document.querySelector(".toast").textContent`)).includes("Garden removed"));
check("Remove: focus lands on Add zone, not on nothing", (await ev(`document.activeElement.hasAttribute("data-addzone")`)) === true);
check("Remove: a Garden-only device leaves Devices, a shared one stays", await (async () => { const t = await see("devices"); return !t.includes("Air conditioner exhaust fan") && t.includes("Heater") && noJunk(t); })());
check("Remove: Setup stops asking about a device that's no longer mapped", await (async () => { await see("setup"); return !(await ev(`!!document.querySelector("#task-plug")`)); })());
check("Remove: its sensors are still findable, once each and unplaced", (await ev(`(()=>{const c=catalog().filter(s=>s.id==="g-left");return c.length===1 && c[0].pos===null})()`)) === true);
for (const id of ["veg", "nursery"]) check(`Remove: ${id} still renders`, noJunk(await see("zone", id)));
check("Remove: Overview still renders", noJunk(await see("overview")));

await setupNow(); await cClick('[data-mapw="veg"]');
await ev(`ui.mapw.q="left";render()`); await sleep(40);
check("Remove: search finds a freed sensor from Map devices", (await ev(`!!document.querySelector("#ms-g-left")`)) === true);
await cClick('[data-msensor="g-left"]');
for (let i = 0; i < 3; i++) await cClick('[data-mstep="next"]');
await ev(`ui.mapw.step=2;ui.mapw.q="air conditioner";render()`); await sleep(40);
check("Remove: search finds a freed device too", (await mainText()).includes("Air conditioner"), (await mainText()).slice(0, 200));
await ev(`ui.mapw.step=4;ui.mapw.q="";render()`); await sleep(40);
await cClick('[data-mstep="next"]'); await cClick("[data-rapply]"); await sleep(120);
check("Remove: a freed sensor can be mapped to another zone", (await ev(`(()=>{const s=zoneById("veg").sensors.find(x=>x.id==="g-left");return !!s && s.pos===null})()`)) === true, await ev(`zoneById("veg").sensors.map(x=>x.id)`));
await ev(`ui.review=null;ui.guard=null;renderModal();ui.mapw=null;ui.wiz=null;render()`);

await setupNow(); await cClick("[data-addzone]"); await ev(`ui.wiz.name="Garden";render()`); await sleep(30);
check("Remove: its name is free again", !(await ev(`document.querySelector('[data-wiz="next"]').disabled`)));
for (let i = 0; i < 3; i++) await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.mapw=null;render()`);
check("Remove: a new zone of that name starts clean", (await ev(`(()=>{const z=zoneById("garden");return !!z && !z.sensors.length && !ACTIVITY.garden.length && devices.every(d=>!d.zones.includes("garden"))})()`)) === true);
check("Remove: and its page renders", noJunk(await see("zone", "garden")));
await setupNow(); await askRemove("garden");
const emptyAsk = await dialog();
check("Remove: an empty zone's dialog leaves out what it doesn't have", !emptyAsk.includes("Sensors") && !emptyAsk.includes("Devices") && emptyAsk.includes("Placement"), emptyAsk);
await cClick("[data-gkeep]");

await cClick("[data-addzone]"); await ev(`ui.wiz.name='Bad <img src=x onerror="window.pwned=1"> zone';render()`); await sleep(30);
for (let i = 0; i < 3; i++) await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.mapw=null;render()`); await setupNow();
await askRemove(await ev(`zones.at(-1).id`)); await sleep(60);
check("Remove: a zone name can't run as code in the dialog", !(await ev(`window.pwned`)) && (await ev(`!document.querySelector("#modal img")`)) === true);
await confirmRemove();
check("Remove: nor in the toast", !(await ev(`window.pwned`)));

for (const id of await zoneIds()) { await setupNow(); await askRemove(id); await confirmRemove(); await sleep(40); }
check("Remove: the last zone can go too", (await zoneIds()).length === 0, await zoneIds());
check("Remove: no zones leaves no question and no calm notice", await (async () => { const t = await see("setup"); return t.includes("No zones yet") && !t.includes("Every device is identified") && !t.includes("Questions for you"); })());
await shot("remove-empty-setup");
check("Remove: Devices says it has none", (await see("devices")).includes("No devices are in a zone yet"));
const emptyOverview = await see("overview");
check("Remove: Overview offers Add a zone, not All zones ideal", emptyOverview.includes("No zones yet") && !emptyOverview.includes("All zones ideal") && noJunk(emptyOverview), emptyOverview);
await shot("remove-empty-overview");
await cClick("[data-addzone]");
check("Remove: Add a zone from Overview opens Placement on Setup", (await ev(`ui.screen==="setup" && !!ui.wiz && !ui.wiz.id && !!document.querySelector("#wiz-name")`)) === true);
await ev(`ui.wiz.name="Fresh start";render()`); await sleep(30);
for (let i = 0; i < 3; i++) await cClick('[data-wiz="next"]');
await cClick("[data-rapply]"); await sleep(80); await ev(`ui.mapw=null;render()`);
check("Remove: and the first zone is back on Overview", (await see("overview")).includes("Fresh start"));

check("no script errors", exceptions.length === 0, exceptions);

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); await finish();
