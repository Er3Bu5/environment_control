// @ts-check
/* The panel element Home Assistant mounts, and the only code that holds your login. The whole UI runs in a sandboxed
   frame with its own origin and no network, and this element is its only way out: it hands the frame the stored setup,
   the states of mapped entities with allowlisted attributes, HA's theme colours, each checked to be a plain colour, and,
   when Setup asks, the backend's catalog of what HA has, which carries no identifiers, addresses or serials.
   Anything the frame sends that isn't on the allowlist is dropped.

   It saves Setup to the integration's own storage through the backend, and asks you first, in a dialog it draws itself,
   before a save makes any device controllable or links a helper. This release moves nothing: there is no service call
   here. Device controls, calibration and setting writes arrive in the releases that use them, each checked here against
   the setup this element fetched itself, never the frame's copy.
   Kept small and dependency-free on purpose, because it runs with full trust, and shipped exactly as written. */
import FRAME_HTML from "./frame.js";

/* Only what the UI draws. Anything else an integration puts in its attributes stays here. */
const ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "unit_of_measurement"];
const HELPER = /^input_(number|datetime)\.[a-z0-9_]{1,200}$/;
const ENTITY = /^(switch|light|fan|humidifier)\.[a-z0-9_]{1,200}$/;
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
/* The bar asking for a reload after an update, in HA's own colours where its theme sets them. */
const UPDATED_CSS = ".updated{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 16px;font:14px/1.4 Roboto,system-ui,sans-serif;background:var(--secondary-background-color,#E5E5E5);color:var(--primary-text-color,#212121)}.updated button{font:inherit;min-height:36px;padding:0 16px;border-radius:18px;border:0;background:var(--primary-color,#03A9F4);color:var(--text-primary-color,#FFFFFF);cursor:pointer}";
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
    /** @type {HTMLElement | null} */
    this.updatedBar = null;
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
    if (this.frame && !this.updatedBar && this.stale()) this.showUpdated();
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
  /* The old panel stays usable underneath, so a draft can still be applied before reloading. */
  showUpdated() {
    const bar = make("div", undefined, "updated"), go = make("button", "Reload");
    bar.setAttribute("role", "status");
    bar.append(make("span", "Environment Control was updated. Reload to use the new version."), go);
    go.addEventListener("click", () => location.reload());
    this.updatedBar = bar;
    this.shadow.prepend(bar);
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
    style.textContent = ":host{display:flex;flex-direction:column;height:calc(100dvh - var(--safe-area-inset-top, 0px) - var(--safe-area-inset-bottom, 0px))}iframe{display:block;width:100%;flex:1;min-height:0;border:0}" + UPDATED_CSS;
    this.frame = document.createElement("iframe");
    /* allow-scripts alone: adding allow-same-origin would let the frame reach this page and undo the sandbox. */
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("title", "Environment Control");
    this.frame.srcdoc = FRAME_HTML;
    window.addEventListener("message", this.onMessage);
    window.addEventListener("beforeunload", this.onUnload);
    window.addEventListener("click", this.onClick, true);
    if (navigation()) navigation().addEventListener("navigate", this.onNavigate);
    this.shadow.append(style, this.frame);
  }

  mapped() {
    const out = new Set();
    for (const d of this.config.devices || []) if (d && typeof d.entity === "string" && Array.isArray(d.zones) && d.zones.length) out.add(d.entity);
    for (const z of this.config.zones || []) for (const x of z.sensors || []) if (x && typeof x.leafEntity === "string" && !x.leafUnused) out.add(x.leafEntity);
    for (const z of this.config.zones || []) for (const e of helperLinks(z)) out.add(e);
    return out;
  }
  /** @param {any} st */
  pick(st) {
    if (!st) return null;
    /** @type {Record<string, unknown>} */
    const attributes = {};
    for (const k of ATTRS) if (k in st.attributes) attributes[k] = st.attributes[k];
    const c = st.context || {};
    return { state: String(st.state), attributes, by: c.user_id ? "user" : c.parent_id ? "automation" : "device" };
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
    else if (m.type === "appearance") this.setAppearance(m);
    else if (m.type === "catalog") this.catalog(m);
    else if (m.type === "save") this.save(m);
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
    const area = reg.area_id && areas[reg.area_id] ? areas[reg.area_id].name : null;
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
