// @ts-check
/* The panel element Home Assistant mounts, and the only code that holds your login. The whole UI runs in a sandboxed
   frame with its own origin and no network, and this element is its only way out: it hands the frame the stored setup,
   the states of mapped entities with allowlisted attributes, HA's theme colours, each checked to be a plain colour, and,
   when Setup asks, the backend's catalog of what HA has, which carries no identifiers, addresses or serials.
   Anything the frame sends that isn't on the allowlist is dropped.

   It saves Setup to the integration's own storage through the backend, and asks you first, in a dialog it draws itself,
   before a save makes any device controllable or links a helper. It is the only code that calls a service, and only
   for its fixed write table: a mapped device on or off, its brightness, mode or target humidity; a sensor's leaf
   temperature offset; a zone's linked helper. Each is checked here against the setup this element fetched itself and
   HA's own state, never the frame's copy, and the frame never names an entity or a service.
   Kept small and dependency-free on purpose, because it runs with full trust, and shipped exactly as written. */
import FRAME_HTML from "./frame.js";

/* Only what the UI draws. Anything else an integration puts in its attributes stays here. */
const ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "target_humidity_step", "min", "max", "step", "unit_of_measurement"];
const HELPER = /^input_(number|datetime)\.[a-z0-9_]{1,200}$/;
const SENSOR = /^sensor\.[a-z0-9_]{1,200}$/;
/* On and off entities a zone can follow for day and night or for red lights: read, never switched from here. */
const ON_OFF = /^(switch|light|input_boolean)\.[a-z0-9_]{1,200}$/;
const ENTITY = /^(switch|light|fan|humidifier)\.[a-z0-9_]{1,200}$/;
const NUMBER = /^number\.[a-z0-9_]{1,200}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CELSIUS = ["°C", "℃"];
/* What a device's control can ask for, and the roles a control is shown for. A device whose role isn't said, or is
   Other, has no control in the panel, so nothing is sent to it either. */
const ACTIONS = ["turn_on", "turn_off", "brightness", "mode", "humidity"];
/* A device that says its target moves in steps takes only a target on one of them: this room's dehumidifiers step by 5
   and take anything between without a word, changing nothing. One that names no step takes any whole percent. */
/** @param {number} value @param {number} min @param {unknown} step */
const onStep = (value, min, step) => !(typeof step === "number" && Number.isFinite(step) && step > 0) || Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-9;
const CONTROL_ROLES = ["Dehumidifier", "Humidifier", "Air conditioner", "Heater", "Fan", "Light"];
/* The ranges the panel draws: the light card's 4 hours and the History card's four. The backend holds the same list. */
const HISTORY_HOURS = [4, 6, 24, 72, 168];
/* The backend's own limit, checked here too so a frame can't make this element send something huge. */
const MAX_CONFIG_BYTES = 512 * 1024;
/* Allow stays off this long after the dialog appears or comes back into view, so a tap aimed at something else can't land on it. */
const ARM_MS = 1000;
/** @type {Record<string, string>} */
const CAN = { switch: "Can be switched on and off.", fan: "Can be switched on and off.", light: "Can be switched on and off and dimmed.", humidifier: "Can be switched on and off, and its mode and target humidity set." };
/* The settings a zone can link to a helper. */
const SETTINGS = ["day", "night", "morning", "daylight", "evening", "light.dayMin", "light.nightMax",
  ...["day", "night"].flatMap((p) => ["temperature", "humidity", "vpd"].flatMap((k) => ["min", "target", "max"].map((slot) => `bands.${p}.${k}.${slot}`)))];
/** @param {any} z @param {string} name */
const linkAt = (z, name) => name.split(".").reduce((o, key) => (o && typeof o === "object" ? o[key] : undefined), z.helpers || {});
/** @param {any} z */
const helperLinks = (z) => SETTINGS.map((n) => linkAt(z, n)).filter((e) => typeof e === "string" && HELPER.test(e));
/* HA's own theme colours, read from this element where HA's theme lands, each the first of its names that holds a plain
   colour. Anything else, such as a url() or a value carrying a semicolon, is left behind and the frame keeps its own. */
/** @type {Record<string, string[]>} */
const HA_COLORS = { primary: ["--primary-color"], bg: ["--primary-background-color"], card: ["--ha-card-background", "--card-background-color"],
  tile: ["--secondary-background-color"], fg: ["--primary-text-color"], muted: ["--secondary-text-color"], line: ["--divider-color"] };
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
/* Appearance is per device, as HA's own theme choice is, so it lives in this browser rather than in the panel's storage. */
const APPEARANCES = ["ha", "light", "dark"], APPEARANCE_KEY = "environment-control-appearance";
/* HA's own test for a click it turns into a page change (isNavigationClick in its frontend): a plain left click on a
   same-origin link with no target. HA leaves a click alone once something has cancelled it, which is how this holds the
   page. Its sidebar entries are links like this, inside open shadow roots, so they show in the click's path. */
/** @param {MouseEvent} e @returns {HTMLAnchorElement | null} */
const leavingVia = (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  const a = /** @type {HTMLAnchorElement | undefined} */ (e.composedPath().find((n) => /** @type {Element} */ (n).tagName === "A"));
  if (!a || a.target || a.hasAttribute("download") || a.getAttribute("rel") === "external") return null;
  let url;
  try { url = new URL(a.href); } catch { return null; }
  if (url.origin !== location.origin) return null;
  return url.pathname + url.search + url.hash === location.pathname + location.search + location.hash ? null : a;
};
/* Dark text on a light primary colour, white on any other. */
/** @param {string} c */
const onColor = (c) => {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(c);
  const rgb = hex ? (hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : /** @type {string[]} */ (hex[1].match(/../g))).map((x) => parseInt(x, 16))
    : ((/^rgba?\(([^)]*)\)/i.exec(c) || [])[1] || "").split(",").slice(0, 3).map(parseFloat);
  return rgb.length === 3 && rgb.every(Number.isFinite) && (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255 > 0.6 ? "#111111" : "#FFFFFF";
};
/* A reload turned down with Later isn't asked for again for this long. */
const RELOAD_QUIET_MS = 10 * 60_000;
/* The browser's Navigation API, where it has one. */
/** @returns {any} */
const navigation = () => /** @type {any} */ (window).navigation;
/** @param {string} tag @param {string} [text] @param {string} [cls] */
const make = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const DIALOG_CSS = `dialog{max-width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;border:0;border-radius:16px;padding:20px;font:15px/1.45 Roboto,system-ui,sans-serif;background:#FFFFFF;color:#212121;box-shadow:0 12px 40px rgba(0,0,0,.35)}
  dialog.dark{background:#1C1C1C;color:#E1E1E1}dialog::backdrop{background:rgba(0,0,0,.55)}
  h2{margin:0 0 6px;font-size:19px;font-weight:500;outline:none}p{margin:0 0 12px;opacity:.8;font-size:14px}
  ul{list-style:none;margin:0 0 16px;padding:0;max-height:50dvh;overflow:auto}li{padding:10px 0;border-top:1px solid rgba(128,128,128,.3);display:flex;flex-direction:column;gap:2px}
  code{font:600 14px ui-monospace,monospace;overflow-wrap:anywhere}span{font-size:13px;opacity:.8}strong{font-size:13px;font-weight:500;color:#D32F2F}dialog.dark strong{color:#EF9A9A}
  .row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}button{font:inherit;font-size:14px;min-height:40px;padding:0 16px;border-radius:20px;border:1px solid rgba(128,128,128,.5);background:none;color:inherit;cursor:pointer}
  summary{cursor:pointer;margin:0 0 8px;font-size:14px}details ul{max-height:30dvh}button.allow{background:var(--p,#03A9F4);border-color:var(--p,#03A9F4);color:var(--on-p,#FFFFFF)}
  button.leave{color:#D32F2F;border-color:#D32F2F}dialog.dark button.leave{color:#EF9A9A;border-color:#EF9A9A}button:disabled{opacity:.45;cursor:default}`;

class EnvironmentControlPanel extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "closed" });
    /** @type {Record<string, string>} */
    this.forwarded = {};
    /** @type {any} */
    this._hass = null;
    /** @type {any} */
    this.config = null;
    /** @type {HTMLIFrameElement | null} */
    this.frame = null;
    this.ready = false;
    this.draftOpen = false;
    this.passing = false;
    /** @type {string | null} */
    this.passUrl = null;
    this.asking = false;
    /** @type {string | null} */
    this.picked = null;
    /** @type {string | undefined} */
    this.sentTheme = undefined;
    /** @type {(() => void) | null} */
    this.onReady = null;
    this._narrow = false;
    /* Until when a reload turned down with Later stays quiet. */
    this.reloadQuietUntil = 0;
    /* Back inside the panel. The frame's pages aren't in the browser's history, so a back gesture left the panel, and
       on Android the app. While the frame has somewhere to go back to, one history entry of this page's own is kept in
       front. Going back from it is heard here and passed to the frame, which steps back and says whether to keep one. */
    this.backArmed = false;
    this.backSkips = 0;
    /** @param {PopStateEvent} e */
    this.onPop = (e) => {
      if (this.backSkips > 0) { this.backSkips--; return; }
      if (!this.backArmed || (e.state && e.state.ecBack)) return;
      this.backArmed = false;
      if (this.ready) this.post({ type: "back" });
    };
    this.onMessage = this.onMessage.bind(this);
    /* The frame has no allow-modals, so it can't ask before the page closes. It says whether a draft is open, and this
       raises the browser's own leave prompt instead. The worst a compromised frame can do with that is ask needlessly. */
    /** @param {BeforeUnloadEvent} e */
    this.onUnload = (e) => { if (this.draftOpen) { e.preventDefault(); e.returnValue = ""; } };
    /* HA's sidebar changes pages without unloading this one, so the browser never asks. A link click that would take HA
       elsewhere is held here first, before HA's own listener, and goes ahead only once you say so. */
    /** @param {MouseEvent} e */
    this.onClick = (e) => {
      if (!this.draftOpen || this.passing) return;
      const link = leavingVia(e);
      if (!link) return;
      e.preventDefault();
      if (this.asking) return;
      this.askLeave().then((go) => {
        if (!go) return;
        /* The same link clicked again, so HA changes page its own way. */
        this.passing = true;
        try { link.click(); } finally { this.passing = false; }
      });
    };
    /* Navigation with no click to hold: the back gesture, a notification tap, the quick bar, a Companion app command.
       Only the browser's Navigation API sees these, and the panel is used in the Companion app, whose Android WebView has
       it. Each is held while a draft is open and goes ahead only once you say so, the way HA's own navigate() does it:
       history first, then location-changed for its router, or the same history step again for back and forward. A
       navigation the browser won't let a page cancel goes ahead, and the leave prompt covers one that unloads the page. */
    /** @param {any} e */
    this.onNavigate = (e) => {
      if (!this.draftOpen || !e.cancelable || !e.destination.sameDocument) return;
      const url = String(e.destination.url);
      if (this.passing || url === this.passUrl) { this.passUrl = null; return; }
      if (url === location.href) return;
      e.preventDefault();
      if (this.asking) return;
      const type = e.navigationType, key = e.destination.key;
      this.askLeave().then((go) => {
        if (!go) return;
        this.passUrl = url;
        if (type === "traverse") { navigation().traverseTo(key); return; }
        const replace = type === "replace";
        if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
        window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace } }));
      });
    };
  }
  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) this.start(); else this.forward();
    if (this.frame && this.stale()) this.askReload();
  }
  /* After an update HA serves the new release from a new path and registers the panel there, but a page that stayed
     open, a browser tab or the Companion app, keeps this element: a custom element can't be defined twice, so HA goes on
     building the panel from the old code until the page reloads. HA's panel list says where the panel now comes from;
     when that isn't where this element was loaded from, an update has happened behind an open page. */
  stale() {
    const panel = this._hass && this._hass.panels && this._hass.panels["environment-control"];
    const url = panel && panel.config && panel.config._panel_custom && panel.config._panel_custom.module_url;
    if (typeof url !== "string") return false;
    try { return new URL(url, location.origin).pathname !== new URL(import.meta.url).pathname; } catch { return false; }
  }
  /* Only a yes or a no is taken from the frame. The worst a compromised frame can do with it is hold one back gesture,
     which the next one gets past, since an entry is only ever added once per answer. */
  /** @param {boolean} on */
  armBack(on) {
    if (on && !this.backArmed) {
      this.backArmed = true;
      history.pushState({ ecBack: true }, "", location.href);
    } else if (!on && this.backArmed) {
      this.backArmed = false;
      if (history.state && history.state.ecBack) { this.backSkips++; history.back(); }
    }
  }

  /* Asks in a dialog of its own, over the page, since a bar across the top was easy to miss. Later keeps the old panel
     in use, so a draft can still be applied before reloading, and it's asked again after a while. */
  askReload() {
    if (this.asking || Date.now() < this.reloadQuietUntil) return;
    this.asking = true;
    const t = this.theme(), dlg = /** @type {HTMLDialogElement} */ (make("dialog", undefined, t.mode));
    if (t.colors.primary) { dlg.style.setProperty("--p", t.colors.primary); dlg.style.setProperty("--on-p", onColor(t.colors.primary)); }
    dlg.setAttribute("aria-labelledby", "ec-reload-title");
    const title = make("h2", "Environment Control was updated");
    title.id = "ec-reload-title"; title.tabIndex = -1;
    const text = this.draftOpen
      ? "Reload to use the new version. You have changes that aren't applied yet, and reloading discards them: choose Later to apply them first."
      : "Reload to use the new version.";
    const later = make("button", "Later"), reload = make("button", "Reload", "allow");
    later.dataset.host = "later"; reload.dataset.host = "reload";
    const row = make("div", undefined, "row"); row.append(later, reload);
    dlg.append(make("style", DIALOG_CSS), title, make("p", text), row);
    const close = () => { dlg.close(); dlg.remove(); this.asking = false; };
    const wait = () => { this.reloadQuietUntil = Date.now() + RELOAD_QUIET_MS; close(); };
    later.addEventListener("click", wait);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); wait(); });
    /* Said yes to losing the draft above, so the browser's own leave prompt would only ask again. */
    reload.addEventListener("click", () => { this.draftOpen = false; close(); location.reload(); });
    this.shadow.append(dlg);
    dlg.showModal();
    title.focus();
  }
  get hass() { return this._hass; }
  /* HA hides its sidebar in a narrow window, the Fold folded for one, and a panel then has to offer a way to open it. */
  set narrow(v) {
    const now = v === true;
    if (now === this._narrow) return;
    this._narrow = now;
    if (this.ready) this.post({ type: "narrow", narrow: now });
  }
  get narrow() { return this._narrow; }
  disconnectedCallback() {
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("beforeunload", this.onUnload);
    window.removeEventListener("popstate", this.onPop);
    window.removeEventListener("click", this.onClick, true);
    if (navigation()) navigation().removeEventListener("navigate", this.onNavigate);
    this.draftOpen = false;
    if (this.onReady) this._hass.connection.removeEventListener("ready", this.onReady);
  }

  async start() {
    if (!this._hass.user || !this._hass.user.is_admin) { this.shadow.textContent = "Environment Control is for admins."; return; }
    /* HA reconnects after a restart without reloading this page, so what's stored is read again then. */
    if (!this.onReady) { this.onReady = () => { this.reload(); }; this._hass.connection.addEventListener("ready", this.onReady); }
    try {
      this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config" });
    } catch {
      this.shadow.textContent = "Can't reach Home Assistant. This panel opens when it's back.";
      return;
    }
    this.shadow.textContent = "";
    const style = document.createElement("style");
    /* HA mounts a panel in a container with no height of its own, padded for the safe areas, so the panel sizes itself
       to the window less that padding. A height of 100% would resolve to nothing and leave the frame at 150px. */
    style.textContent = ":host{display:flex;flex-direction:column;height:calc(100dvh - var(--safe-area-inset-top, 0px) - var(--safe-area-inset-bottom, 0px))}iframe{display:block;width:100%;flex:1;min-height:0;border:0}";
    this.frame = document.createElement("iframe");
    /* allow-scripts alone: adding allow-same-origin would let the frame reach this page and undo the sandbox. */
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("title", "Environment Control");
    this.frame.srcdoc = FRAME_HTML;
    window.addEventListener("message", this.onMessage);
    window.addEventListener("beforeunload", this.onUnload);
    window.addEventListener("popstate", this.onPop);
    window.addEventListener("click", this.onClick, true);
    if (navigation()) navigation().addEventListener("navigate", this.onNavigate);
    this.shadow.append(style, this.frame);
  }

  mapped() {
    const out = new Set();
    for (const d of this.config.devices || []) if (d && typeof d.entity === "string" && Array.isArray(d.zones) && d.zones.length) out.add(d.entity);
    for (const z of this.config.zones || []) for (const x of z.sensors || []) if (x && typeof x.leafEntity === "string" && !x.leafUnused) out.add(x.leafEntity);
    for (const e of this.readings()) out.add(e);
    for (const z of this.config.zones || []) for (const e of [...((z && z.lights) || []), ...((z && z.redLights) || [])]) if (typeof e === "string" && ON_OFF.test(e)) out.add(e);
    for (const z of this.config.zones || []) for (const e of helperLinks(z)) out.add(e);
    return out;
  }
  /* A mapped sensor's readings, which the panel draws. Only sensor entities, as the backend only stores those. */
  readings() {
    const out = new Set();
    for (const z of this.config.zones || []) for (const x of z.sensors || []) for (const e of Object.values((x && x.entities) || {})) if (typeof e === "string" && SENSOR.test(e)) out.add(e);
    return out;
  }
  /** @param {any} st */
  pick(st) {
    if (!st) return null;
    /** @type {Record<string, unknown>} */
    const attributes = {};
    for (const k of ATTRS) if (k in st.attributes) attributes[k] = st.attributes[k];
    const c = st.context || {};
    /* When it last updated, so a reading that stopped can be marked stale rather than shown as current. */
    const at = typeof st.last_updated === "string" ? st.last_updated : null;
    return { state: String(st.state), attributes, by: c.user_id ? "user" : c.parent_id ? "automation" : "device", at };
  }
  appearance() {
    let v = this.picked;
    if (!v) try { v = localStorage.getItem(APPEARANCE_KEY); } catch { /* No storage, so Home Assistant until one is picked. */ }
    return v && APPEARANCES.includes(v) ? v : "ha";
  }
  /* Light and Dark are the panel's own palettes. Home Assistant takes HA's dark mode and HA's colours, so the panel matches
     whatever theme and primary colour you've picked there. */
  theme() {
    const appearance = this.appearance();
    /** @type {Record<string, string>} */
    const colors = {};
    if (appearance !== "ha") return { appearance, mode: appearance, colors };
    const css = getComputedStyle(this);
    for (const [k, names] of Object.entries(HA_COLORS)) {
      const c = names.map((n) => css.getPropertyValue(n).trim()).find(Boolean);
      if (c && COLOR.test(c)) colors[k] = c;
    }
    return { appearance, mode: this._hass.themes && this._hass.themes.darkMode ? "dark" : "light", colors };
  }
  /** @param {any} m */
  setAppearance(m) {
    if (!APPEARANCES.includes(m.value)) { this.reply(m.req, false, "Not an appearance."); return; }
    /* Held here too, so a browser that blocks storage keeps the choice until the panel closes. */
    this.picked = m.value;
    try { localStorage.setItem(APPEARANCE_KEY, m.value); } catch { /* Kept for this visit only. */ }
    this.reply(m.req, true);
    this.sendTheme();
  }
  /** @param {boolean} [force] */
  sendTheme(force) {
    const t = this.theme(), key = JSON.stringify(t);
    if (force || key !== this.sentTheme) { this.sentTheme = key; if (!force) this.post({ type: "theme", theme: t }); }
    return t;
  }
  /** @param {Record<string, unknown>} msg */
  post(msg) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage({ v: 1, ...msg }, "*"); }

  init() {
    /** @type {Record<string, unknown>} */
    const states = {};
    for (const e of this.mapped()) { states[e] = this.pick(this._hass.states[e]); this.forwarded[e] = JSON.stringify(states[e]); }
    this.post({ type: "init", ...this.stored(), states, theme: this.sendTheme(true), narrow: this._narrow });
    this.ready = true;
  }
  stored() { return { revision: this.config.revision, zones: this.config.zones, devices: this.config.devices }; }
  async reload() {
    if (!this.frame) { this.start(); return; }
    try { this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config" }); } catch { return; }
    if (this.ready) { this.post({ type: "config", ...this.stored() }); this.forward(); }
  }
  forward() {
    if (!this.ready) return;
    /** @type {Record<string, unknown>} */
    const changed = {};
    for (const e of this.mapped()) {
      const now = this.pick(this._hass.states[e]), key = JSON.stringify(now);
      if (this.forwarded[e] !== key) { changed[e] = now; this.forwarded[e] = key; }
    }
    if (Object.keys(changed).length) this.post({ type: "states", states: changed });
    this.sendTheme();
  }

  /** @param {MessageEvent} e */
  onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.v !== 1 || typeof m.type !== "string") return;
    /* A frame that has just loaded holds no draft. */
    if (m.type === "ready") { this.draftOpen = false; this.init(); }
    else if (m.type === "draft") { if (typeof m.open === "boolean") this.draftOpen = m.open; }
    else if (m.type === "nav") { if (typeof m.back === "boolean") this.armBack(m.back); }
    else if (m.type === "appearance") this.setAppearance(m);
    else if (m.type === "catalog") this.catalog(m);
    else if (m.type === "save") this.save(m);
    else if (m.type === "calibrate") this.calibrate(m);
    else if (m.type === "history") this.history(m);
    else if (m.type === "setting") this.setting(m);
    else if (m.type === "device") this.device(m);
    /* HA's own event for opening its sidebar, the one its panels fire from their menu button. It carries nothing. */
    else if (m.type === "sidebar") this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
  }
  /* Setup's picker: the devices and entities HA has, with how each device is connected, as the backend lists them. Reading
     it links nothing and makes nothing controllable; that takes a save, which asks you first. */
  /** @param {any} m */
  async catalog(m) {
    if (!Number.isInteger(m.req)) return;
    try {
      const catalog = await this._hass.connection.sendMessagePromise({ type: "environment_control/catalog" });
      this.post({ type: "result", req: m.req, ok: true, catalog });
    } catch {
      this.reply(m.req, false, "Home Assistant couldn't list its devices. Try again in a moment.");
    }
  }
  /* The setting write: a zone and the name of one of its settings, never an entity. The helper is the one the stored
     setup links that zone to for that setting, which a person said yes to when the link was saved. Lights on and off
     go to a time-only date and time helper as a time; everything else goes to a number helper, inside its own limits
     and step. A yes means HA took the call: the frame waits for the helper to report the value. */
  /** @param {any} m */
  async setting(m) {
    /** @param {string} why */
    const refuse = (why) => this.reply(m.req, false, why);
    if (typeof m.zone !== "string" || !ITEM_ID.test(m.zone) || !SETTINGS.includes(m.name)) return refuse("Not a setting this panel knows.");
    /** @type {any[]} */
    const zones = this.config.zones || [];
    const z = zones.find((x) => x && x.id === m.zone), entity = z && linkAt(z, m.name);
    if (typeof entity !== "string" || !HELPER.test(entity)) return refuse("That setting isn't linked to a helper.");
    const time = m.name === "day" || m.name === "night";
    if (entity.startsWith("input_datetime.") !== time) return refuse("That helper isn't the right kind for that setting.");
    const st = this._hass.states[entity];
    if (!st || st.state === "unavailable" || st.state === "unknown") return refuse(`Home Assistant has no ${entity} it can set.`);
    const a = st.attributes || {};
    /** @type {[string, string, Record<string, unknown>]} */
    let call;
    if (time) {
      if (a.has_date !== false || a.has_time !== true) return refuse("That helper holds a date as well as a time.");
      if (typeof m.value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.value)) return refuse("That isn't a time.");
      call = ["input_datetime", "set_datetime", { entity_id: entity, time: `${m.value}:00` }];
    } else {
      const num = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
      if (!num(m.value)) return refuse("That isn't a number.");
      if (!num(a.min) || !num(a.max) || !num(a.step) || a.step <= 0) return refuse("That helper doesn't say its limits.");
      const steps = (m.value - a.min) / a.step;
      if (m.value < a.min || m.value > a.max || Math.abs(steps - Math.round(steps)) > 1e-6) return refuse(`It has to be between ${a.min} and ${a.max}, in steps of ${a.step}.`);
      call = ["input_number", "set_value", { entity_id: entity, value: m.value }];
    }
    try {
      await this._hass.callService(...call);
    } catch (err) {
      return refuse(String((err && /** @type {any} */ (err).message) || err));
    }
    this.reply(m.req, true);
  }
  /* The device write: a device id and an action, never an entity or a service. The entity is the one the stored setup
     maps to a zone, which a person said yes to when it was saved, and the action has to be one that entity takes by HA's
     own account: brightness only on a light that dims, a mode from the humidifier's own list, a target inside its own
     limits. A yes means HA took the call, not that the device did it: the frame waits for the device to report. */
  /** @param {any} m */
  async device(m) {
    /** @param {string} why */
    const refuse = (why) => this.reply(m.req, false, why);
    if (typeof m.id !== "string" || !ITEM_ID.test(m.id) || !ACTIONS.includes(m.action)) return refuse("Not a device or action this panel knows.");
    /** @type {any[]} */
    const devices = this.config.devices || [], zones = this.config.zones || [];
    const d = devices.find((x) => x && x.id === m.id);
    const mapped = d && typeof d.entity === "string" && ENTITY.test(d.entity) && Array.isArray(d.zones) && d.zones.some((/** @type {unknown} */ id) => zones.some((/** @type {any} */ z) => z && z.id === id));
    if (!mapped) return refuse("That device isn't mapped to a zone.");
    if (!CONTROL_ROLES.includes(d.type)) return refuse("Say what that device is in Device identification first.");
    const entity = d.entity, domain = entity.split(".")[0], st = this._hass.states[entity];
    if (!st) return refuse(`Home Assistant has no ${entity}.`);
    if (st.state === "unavailable") return refuse("It's unavailable in Home Assistant.");
    const a = st.attributes || {}, target = { entity_id: entity }, num = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
    /** @type {[string, string, Record<string, unknown>] | null} */
    let call = null;
    if (m.action === "turn_on" || m.action === "turn_off") call = [domain, m.action, target];
    else if (m.action === "brightness") {
      const dims = domain === "light" && Array.isArray(a.supported_color_modes) && a.supported_color_modes.some((/** @type {unknown} */ c) => c !== "onoff");
      if (dims && Number.isInteger(m.value) && m.value >= 1 && m.value <= 100) call = ["light", "turn_on", { ...target, brightness_pct: m.value }];
    } else if (m.action === "mode") {
      if (domain === "humidifier" && typeof m.value === "string" && Array.isArray(a.available_modes) && a.available_modes.includes(m.value)) call = ["humidifier", "set_mode", { ...target, mode: m.value }];
    } else if (domain === "humidifier" && Number.isInteger(m.value) && num(a.min_humidity) && num(a.max_humidity) && m.value >= a.min_humidity && m.value <= a.max_humidity && onStep(m.value, a.min_humidity, a.target_humidity_step)) {
      call = ["humidifier", "set_humidity", { ...target, humidity: m.value }];
    }
    if (!call) return refuse("That isn't something this device takes.");
    try {
      await this._hass.callService(...call);
    } catch (err) {
      return refuse(String((err && /** @type {any} */ (err).message) || err));
    }
    this.reply(m.req, true);
  }
  /* A chart's readings: only a mapped sensor's own readings, over a range the panel draws. The backend checks both again
     and buckets them, so a week of 10 second readings never reaches the frame. */
  /** @param {any} m */
  async history(m) {
    if (!Number.isInteger(m.req)) return;
    /** @param {string} why */
    const refuse = (why) => this.reply(m.req, false, why);
    const readings = this.readings();
    if (!Array.isArray(m.entities) || !m.entities.length || m.entities.length > 24 || !m.entities.every((/** @type {unknown} */ e) => typeof e === "string" && readings.has(e)))
      return refuse("History is only for the readings of a sensor in a zone.");
    if (!HISTORY_HOURS.includes(m.hours) || !Number.isInteger(m.buckets) || m.buckets < 12 || m.buckets > 1000) return refuse("That isn't a range this panel draws.");
    try {
      const history = await this._hass.connection.sendMessagePromise({ type: "environment_control/history", entities: m.entities, hours: m.hours, buckets: m.buckets });
      this.post({ type: "result", req: m.req, ok: true, history });
    } catch (err) {
      refuse(String((err && /** @type {any} */ (err).message) || err));
    }
  }
  /** @param {unknown} req @param {boolean} ok @param {string} [error] */
  reply(req, ok, error) { if (Number.isInteger(req)) this.post({ type: "result", req, ok, ...(error ? { error } : {}) }); }

  /* Setup changes only this integration's own storage, through its backend, which checks the whole config and the
     revision it was based on. The host keeps the backend's answer, never the frame's copy, as its config. */
  /** @param {any} m */
  async save(m) {
    /** @param {string} why */
    const refuse = (why) => this.reply(m.req, false, why);
    if (!Number.isInteger(m.base) || !m.config || typeof m.config !== "object") return refuse("That isn't a setup this panel can save.");
    if (JSON.stringify(m.config).length > MAX_CONFIG_BYTES) return refuse("That setup is too large to save.");
    const config = { zones: m.config.zones, devices: m.config.devices };
    /* A mapping decides what a button moves, so a device becomes controllable only once a person says yes here, outside the frame. */
    const added = this.newlyControlled(config);
    if (typeof added === "string") return refuse(added);
    if (added.length) {
      if (this.asking) return refuse("Home Assistant is already asking you about another change.");
      if (!(await this.confirm(added, config))) return refuse("Not allowed, so nothing was saved.");
    }
    try {
      this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config/save", revision: m.base, config });
    } catch (err) {
      return refuse(String((err && /** @type {any} */ (err).message) || err));
    }
    this.post({ type: "result", req: m.req, ok: true, ...this.stored() });
    this.forward();
  }
  /* The calibration write: a sensor's leaf temperature offset, on its own board. The frame names a sensor and a value,
     never an entity. The entity is the one the stored setup links that sensor to, which the backend only accepts as a °C
     number on the sensor's own device; that is checked again here against HA's registry, since a link stored by an
     earlier release wasn't checked when it was saved. The value has to sit inside the entity's own limits and step. A
     yes here means HA accepted the call, not that the board took it: the frame waits for the board to report it. */
  /** @param {any} m */
  async calibrate(m) {
    /** @param {string} why */
    const refuse = (why) => this.reply(m.req, false, why);
    if (typeof m.sensor !== "string" || !ITEM_ID.test(m.sensor) || typeof m.value !== "number" || !Number.isFinite(m.value)) return refuse("Not a sensor or value this panel knows.");
    /** @type {any[]} */
    const zones = this.config.zones || [];
    const sensor = zones.flatMap((z) => (z && Array.isArray(z.sensors) ? z.sensors : [])).find((x) => x && x.id === m.sensor);
    const entity = sensor && !sensor.leafUnused && typeof sensor.leafEntity === "string" && NUMBER.test(sensor.leafEntity) ? sensor.leafEntity : null;
    if (!entity) return refuse("That sensor has no leaf temperature offset on its board.");
    const entry = this._hass.entities && this._hass.entities[entity];
    if (!entry || entry.device_id !== m.sensor) return refuse(`Home Assistant doesn't list ${entity} on that sensor's own device.`);
    const st = this._hass.states[entity];
    if (!st) return refuse(`Home Assistant has no ${entity}.`);
    if (st.state === "unavailable") return refuse("The board is offline.");
    const a = st.attributes || {}, num = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
    if (!CELSIUS.includes(a.unit_of_measurement)) return refuse("That setting isn't in °C, so it isn't a leaf temperature offset.");
    if (!num(a.min) || !num(a.max) || !num(a.step) || a.step <= 0) return refuse("That setting doesn't say its limits.");
    const steps = (m.value - a.min) / a.step;
    if (m.value < a.min || m.value > a.max || Math.abs(steps - Math.round(steps)) > 1e-6) return refuse(`It has to be between ${a.min} and ${a.max} °C, in steps of ${a.step}.`);
    try {
      await this._hass.callService("number", "set_value", { entity_id: entity, value: m.value });
    } catch (err) {
      return refuse(String((err && /** @type {any} */ (err).message) || err));
    }
    this.reply(m.req, true);
  }
  /* Entities this save would make controllable, or helpers it would link, that aren't now. Removing one, or changing only
     its role, adds nothing. */
  /** @param {any} config @returns {string | {entity: string, zones: string[], helper?: boolean}[]} */
  newlyControlled(config) {
    if (!Array.isArray(config.devices) || !Array.isArray(config.zones)) return "That isn't a setup this panel can save.";
    const now = this.mapped();
    /** @type {{entity: string, zones: string[], helper?: boolean}[]} */
    const out = [];
    for (const d of config.devices) {
      if (!d || typeof d.entity !== "string" || !Array.isArray(d.zones) || !d.zones.length || now.has(d.entity) || out.some((x) => x.entity === d.entity)) continue;
      if (!ENTITY.test(d.entity)) return "That isn't something this panel can control.";
      if (!this._hass.states[d.entity]) return `Home Assistant has no ${d.entity}.`;
      out.push({ entity: d.entity, zones: d.zones });
    }
    const linked = new Set(this.config.zones.flatMap(helperLinks));
    for (const z of config.zones) for (const e of z && typeof z === "object" ? helperLinks(z) : []) {
      if (linked.has(e) || out.some((x) => x.entity === e)) continue;
      if (!this._hass.states[e]) return `Home Assistant has no ${e}.`;
      out.push({ entity: e, zones: [z.id], helper: true });
    }
    return out;
  }
  /* Everything shown comes from Home Assistant's own state and registries, never from the frame, and is set as text. */
  /** @param {{entity: string, zones: string[], helper?: boolean}} item @param {any} config */
  describe(item, config) {
    const st = this._hass.states[item.entity], reg = (this._hass.entities || {})[item.entity] || {}, areas = this._hass.areas || {};
    /* An entity with no area of its own is in its device's area, which is where HA keeps it for most hardware. */
    const areaId = reg.area_id || ((this._hass.devices || {})[reg.device_id] || {}).area_id;
    const area = areaId && areas[areaId] ? areas[areaId].name : null;
    /** @type {string[]} */
    const zones = item.zones.map((id) => (config.zones.find((/** @type {any} */ z) => z && z.id === id) || {}).name).filter((n) => typeof n === "string");
    const domain = item.entity.split(".")[0], a = st.attributes || {};
    const can = item.helper ? "Its value can be changed." : domain === "light" && !(a.supported_color_modes || []).some((/** @type {string} */ c) => c !== "onoff") ? CAN.switch : CAN[domain];
    /* Zone names are the user's own and can be a single letter, so each is named as an area or zone, and every line ends in
       a full stop, so a short name never reads as text cut off. */
    const flag = item.helper ? "" : !area ? "Has no area in Home Assistant." : zones.some((z) => z.toLowerCase() === area.toLowerCase()) ? "" : `In the ${area} area in Home Assistant, not in the ${zones.join(" or ")} area${zones.length > 1 ? "s" : ""}.`;
    const facts = [reg.platform, area].filter(Boolean).map(String).join(", ");
    return { name: String(a.friendly_name || item.entity), facts: facts ? `${facts}.` : "", can, flag, zones };
  }
  /** @param {{entity: string, zones: string[], helper?: boolean}[]} items @param {any} config @returns {Promise<boolean>} */
  confirm(items, config) {
    this.asking = true;
    return new Promise((resolve) => {
      const rows = items.map((it) => ({ it, ...this.describe(it, config) }));
      const zones = [...new Set(rows.flatMap((r) => r.zones))];
      const t = this.theme(), dlg = /** @type {HTMLDialogElement} */ (make("dialog", undefined, t.mode));
      if (t.colors.primary) { dlg.style.setProperty("--p", t.colors.primary); dlg.style.setProperty("--on-p", onColor(t.colors.primary)); }
      dlg.setAttribute("aria-labelledby", "ec-confirm-title");
      const style = make("style", DIALOG_CSS), title = make("h2", "Allow Environment Control to control these?");
      title.id = "ec-confirm-title"; title.tabIndex = -1;
      const sub = make("p", `Asked for by the panel${zones.length ? `, for the ${zones.join(" and ")} zone${zones.length > 1 ? "s" : ""}` : ""}. Allow only what you meant to add: once allowed, the panel can switch it from now on.`);
      /** @param {typeof rows[number]} r */
      const item = (r) => {
        const li = make("li");
        li.append(make("code", r.it.entity), make("span", r.facts ? `${r.name}. ${r.facts}` : `${r.name}.`), make("span", r.can));
        if (r.flag) li.append(make("strong", r.flag));
        return li;
      };
      /* Devices move hardware, so they're always listed. Helpers fold away under a count. */
      const devices = rows.filter((r) => !r.it.helper), helpers = rows.filter((r) => r.it.helper), list = make("ul");
      devices.forEach((r) => list.append(item(r)));
      const fold = make("details"), hlist = make("ul");
      fold.append(make("summary", `${helpers.length} helper${helpers.length > 1 ? "s" : ""}: values can be changed.`), hlist);
      helpers.forEach((r) => hlist.append(item(r)));
      /** @param {number} n @param {string} word */
      const count = (n, word) => (n ? `${n} ${word}${n > 1 ? "s" : ""}` : "");
      const cancel = make("button", "Cancel"), allow = /** @type {HTMLButtonElement} */ (make("button", `Allow ${[count(devices.length, "device"), count(helpers.length, "helper")].filter(Boolean).join(" and ")}`, "allow"));
      cancel.dataset.host = "cancel"; allow.dataset.host = "allow";
      const row = make("div", undefined, "row"); row.append(cancel, allow);
      dlg.append(style, title, sub, ...(devices.length ? [list] : []), ...(helpers.length ? [fold] : []), row);
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const arm = () => { allow.disabled = true; clearTimeout(timer); timer = setTimeout(() => { allow.disabled = false; }, ARM_MS); };
      const seen = () => { if (document.visibilityState === "visible") arm(); };
      /** @param {boolean} yes */
      const finish = (yes) => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", seen); window.removeEventListener("focus", arm);
        dlg.close(); dlg.remove(); this.asking = false; resolve(yes);
      };
      allow.addEventListener("click", (e) => { if (e.isTrusted && !allow.disabled) finish(true); });
      cancel.addEventListener("click", () => finish(false));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
      document.addEventListener("visibilitychange", seen); window.addEventListener("focus", arm);
      this.shadow.append(dlg);
      dlg.showModal();
      title.focus();
      arm();
    });
  }

  /** @returns {Promise<boolean>} */
  askLeave() {
    this.asking = true;
    return new Promise((resolve) => {
      const t = this.theme(), dlg = /** @type {HTMLDialogElement} */ (make("dialog", undefined, t.mode));
      dlg.setAttribute("aria-labelledby", "ec-leave-title");
      const title = make("h2", "Discard unsaved changes?");
      title.id = "ec-leave-title"; title.tabIndex = -1;
      const keep = make("button", "Keep editing"), leave = make("button", "Discard and leave", "leave");
      keep.dataset.host = "keep"; leave.dataset.host = "leave";
      const row = make("div", undefined, "row"); row.append(keep, leave);
      dlg.append(make("style", DIALOG_CSS), title, make("p", "Environment Control has changes you haven't applied. Leaving discards them, and nothing is sent to Home Assistant."), row);
      /** @param {boolean} yes */
      const finish = (yes) => { dlg.close(); dlg.remove(); this.asking = false; resolve(yes); };
      keep.addEventListener("click", () => finish(false));
      leave.addEventListener("click", () => finish(true));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
      this.shadow.append(dlg);
      dlg.showModal();
      title.focus();
    });
  }
}
if (!customElements.get("environment-control-panel")) customElements.define("environment-control-panel", EnvironmentControlPanel);
