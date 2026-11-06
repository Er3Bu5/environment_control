"use strict";
/* The panel element Home Assistant mounts, and the only code that holds your login. The whole UI runs in a sandboxed
   frame with its own origin and no network, and this element is its only way out: it hands the frame the states of
   mapped entities and runs the few actions in the v1 write table, looking every entity up in the config it fetched
   itself. The frame sends ids, never an entity or a service, and anything not on the allowlist is dropped. The one list
   it hands over beyond mapped entities is HA's number and time helpers, read only, so Setup can offer them to link.
   It also hands over HA's theme colours, each checked to be a plain colour, so the panel can match your theme.
   Kept small and dependency-free on purpose, because it runs with full trust. */
(() => {
  const WRITE_DOMAINS = ["switch", "light", "fan", "humidifier"];
  const ACTIONS = ["turn_on", "turn_off", "brightness", "mode", "humidity"];
  /* Only what the UI draws. Anything else an integration puts in its attributes stays here. */
  const ATTRS = ["friendly_name", "brightness", "supported_color_modes", "mode", "available_modes", "humidity", "current_humidity", "min_humidity", "max_humidity", "min", "max", "step", "unit_of_measurement"];
  const isId = (v) => typeof v === "string" && /^[a-z0-9_-]{1,64}$/.test(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const ENTITY = /^(switch|light|fan|humidifier)\.[a-z0-9_]{1,200}$/;
  const HELPER = /^input_(number|datetime)\.[a-z0-9_]{1,200}$/;
  /* The settings a zone can link to a helper. The frame names one of these, never an entity. */
  const SETTINGS = ["day", "night", "morning", "daylight", "evening", "light.dayMin", "light.nightMax",
    ...["day", "night"].flatMap((p) => ["temperature", "humidity", "vpd"].flatMap((k) => ["min", "target", "max"].map((slot) => `bands.${p}.${k}.${slot}`)))];
  const linkAt = (z, name) => name.split(".").reduce((o, key) => (o && typeof o === "object" ? o[key] : undefined), z.helpers || {});
  const helperLinks = (z) => SETTINGS.map((n) => linkAt(z, n)).filter((e) => typeof e === "string" && HELPER.test(e));
  /* HA's own theme colours, read from this element where HA's theme lands, each the first of its names that holds a plain
     colour. Anything else, such as a url() or a value carrying a semicolon, is left behind and the frame keeps its own. */
  const HA_COLORS = { primary: ["--primary-color"], bg: ["--primary-background-color"], card: ["--ha-card-background", "--card-background-color"],
    tile: ["--secondary-background-color"], fg: ["--primary-text-color"], muted: ["--secondary-text-color"], line: ["--divider-color"] };
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
  /* Appearance is per device, as HA's own theme choice is, so it lives in this browser rather than in the panel's storage. */
  const APPEARANCES = ["ha", "light", "dark"], APPEARANCE_KEY = "environment-control-appearance";
  /* Dark text on a light primary colour, white on any other. */
  const onColor = (c) => {
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(c);
    const rgb = hex ? (hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : hex[1].match(/../g)).map((x) => parseInt(x, 16))
      : ((/^rgba?\(([^)]*)\)/i.exec(c) || [])[1] || "").split(",").slice(0, 3).map(parseFloat);
    return rgb.length === 3 && rgb.every(Number.isFinite) && (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255 > 0.6 ? "#111111" : "#FFFFFF";
  };
  /* Allow stays off this long after the dialog appears or comes back into view, so a tap aimed at something else can't land on it. */
  const ARM_MS = 1000;
  const CAN = { switch: "Can be switched on and off.", fan: "Can be switched on and off.", light: "Can be switched on and off and dimmed.", humidifier: "Can be switched on and off, and its mode and target humidity set." };
  const DIALOG_CSS = `dialog{max-width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;border:0;border-radius:16px;padding:20px;font:15px/1.45 Roboto,system-ui,sans-serif;background:#FFFFFF;color:#212121;box-shadow:0 12px 40px rgba(0,0,0,.35)}
    dialog.dark{background:#1C1C1C;color:#E1E1E1}dialog::backdrop{background:rgba(0,0,0,.55)}
    h2{margin:0 0 6px;font-size:19px;font-weight:500;outline:none}p{margin:0 0 12px;opacity:.8;font-size:14px}
    ul{list-style:none;margin:0 0 16px;padding:0;max-height:50dvh;overflow:auto}li{padding:10px 0;border-top:1px solid rgba(128,128,128,.3);display:flex;flex-direction:column;gap:2px}
    code{font:600 14px ui-monospace,monospace;overflow-wrap:anywhere}span{font-size:13px;opacity:.8}strong{font-size:13px;font-weight:500;color:#D32F2F}dialog.dark strong{color:#EF9A9A}
    .row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}button{font:inherit;font-size:14px;min-height:40px;padding:0 16px;border-radius:20px;border:1px solid rgba(128,128,128,.5);background:none;color:inherit;cursor:pointer}
    summary{cursor:pointer;margin:0 0 8px;font-size:14px}details ul{max-height:30dvh}button.allow{background:var(--p,#03A9F4);border-color:var(--p,#03A9F4);color:var(--on-p,#FFFFFF)}button:disabled{opacity:.45;cursor:default}`;

  class EnvironmentControlPanel extends HTMLElement {
    constructor() {
      super();
      this.shadow = this.attachShadow({ mode: "closed" });
      this.forwarded = {};
      this.onMessage = this.onMessage.bind(this);
      /* The frame has no allow-modals, so it can't ask before the page closes. It says whether a draft is open, and this
         raises the browser's own leave prompt instead. The worst a compromised frame can do with that is ask needlessly.
         HA's sidebar changes pages without unloading this one, so it isn't covered. */
      this.onUnload = (e) => { if (this.draftOpen) { e.preventDefault(); e.returnValue = ""; } };
    }
    set hass(h) {
      const first = !this._hass;
      this._hass = h;
      if (first) this.start(); else this.forward();
    }
    get hass() { return this._hass; }
    disconnectedCallback() {
      window.removeEventListener("message", this.onMessage);
      window.removeEventListener("beforeunload", this.onUnload);
      this.draftOpen = false;
      if (this.onReady) this._hass.connection.removeEventListener("ready", this.onReady);
    }

    async start() {
      if (!this._hass.user || !this._hass.user.is_admin) { this.shadow.textContent = "Environment Control is for admins."; return; }
      /* HA reconnects after a restart without reloading this page, so what's stored is read again then. */
      if (!this.onReady) { this.onReady = () => this.reload(); this._hass.connection.addEventListener("ready", this.onReady); }
      try {
        this.config = await this._hass.connection.sendMessagePromise({ type: "environment_control/config" });
      } catch {
        this.shadow.textContent = "Can't reach Home Assistant. This panel opens when it's back.";
        return;
      }
      this.shadow.textContent = "";
      const style = document.createElement("style");
      style.textContent = ":host{display:block;height:100%}iframe{display:block;width:100%;height:100%;border:0}";
      this.frame = document.createElement("iframe");
      /* allow-scripts alone: adding allow-same-origin would let the frame reach this page and undo the sandbox. */
      this.frame.setAttribute("sandbox", "allow-scripts");
      this.frame.setAttribute("title", "Environment Control");
      this.frame.srcdoc = this.ui;
      window.addEventListener("message", this.onMessage);
      window.addEventListener("beforeunload", this.onUnload);
      this.shadow.append(style, this.frame);
    }

    mapped() {
      const out = new Set();
      for (const d of this.config.devices) if (d.entity && d.zones.length) out.add(d.entity);
      for (const z of this.config.zones) for (const x of z.sensors || []) if (x && typeof x.leafEntity === "string" && !x.leafUnused) out.add(x.leafEntity);
      for (const z of this.config.zones) for (const e of helperLinks(z)) out.add(e);
      return out;
    }
    pick(st) {
      if (!st) return null;
      const attributes = {};
      for (const k of ATTRS) if (k in st.attributes) attributes[k] = st.attributes[k];
      const c = st.context || {};
      return { state: String(st.state), attributes, by: c.user_id ? "user" : c.parent_id ? "automation" : "device" };
    }
    appearance() {
      let v = this.picked;
      if (!v) try { v = localStorage.getItem(APPEARANCE_KEY); } catch { /* No storage, so Home Assistant until one is picked. */ }
      return APPEARANCES.includes(v) ? v : "ha";
    }
    /* Light and Dark are the panel's own palettes. Home Assistant takes HA's dark mode and HA's colours, so the panel matches
       whatever theme and primary colour you've picked there. */
    theme() {
      const appearance = this.appearance(), colors = {};
      if (appearance !== "ha") return { appearance, mode: appearance, colors };
      const css = getComputedStyle(this);
      for (const [k, names] of Object.entries(HA_COLORS)) {
        const c = names.map((n) => css.getPropertyValue(n).trim()).find(Boolean);
        if (c && COLOR.test(c)) colors[k] = c;
      }
      return { appearance, mode: this._hass.themes && this._hass.themes.darkMode ? "dark" : "light", colors };
    }
    setAppearance(m) {
      if (!APPEARANCES.includes(m.value)) { this.reply(m.req, false, "Not an appearance."); return; }
      /* Held here too, so a browser that blocks storage keeps the choice until the panel closes. */
      this.picked = m.value;
      try { localStorage.setItem(APPEARANCE_KEY, m.value); } catch { /* Kept for this visit only. */ }
      this.reply(m.req, true);
      this.sendTheme();
    }
    sendTheme(force) {
      const t = this.theme(), key = JSON.stringify(t);
      if (force || key !== this.sentTheme) { this.sentTheme = key; if (!force) this.post({ type: "theme", theme: t }); }
      return t;
    }
    post(msg) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage({ v: 1, ...msg }, "*"); }

    init() {
      const states = {};
      for (const e of this.mapped()) { states[e] = this.pick(this._hass.states[e]); this.forwarded[e] = JSON.stringify(states[e]); }
      this.post({ type: "init", ...this.stored(), states, theme: this.sendTheme(true) });
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
      const changed = {};
      for (const e of this.mapped()) {
        const now = this.pick(this._hass.states[e]), key = JSON.stringify(now);
        if (this.forwarded[e] !== key) { changed[e] = now; this.forwarded[e] = key; }
      }
      if (Object.keys(changed).length) this.post({ type: "states", states: changed });
      this.sendTheme();
    }

    onMessage(e) {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object" || m.v !== 1 || typeof m.type !== "string") return;
      /* A frame that has just loaded holds no draft. */
      if (m.type === "ready") { this.draftOpen = false; this.init(); }
      else if (m.type === "draft") { if (typeof m.open === "boolean") this.draftOpen = m.open; }
      else if (m.type === "device") this.device(m);
      else if (m.type === "save") this.save(m);
      else if (m.type === "calibrate") this.calibrate(m);
      else if (m.type === "setting") this.setting(m);
      else if (m.type === "helpers") this.helpers(m);
      else if (m.type === "appearance") this.setAppearance(m);
    }
    /* Setup's helper picker: number helpers and time-only date helpers, with only the allowlisted attributes. Reading the list
       links nothing. A helper becomes writable only once a save links it, and that save asks you first. */
    helpers(m) {
      if (!Number.isInteger(m.req)) return;
      const list = [];
      for (const [e, st] of Object.entries(this._hass.states)) {
        if (!HELPER.test(e) || !st) continue;
        const a = st.attributes || {};
        if (e.startsWith("input_datetime.") && !(a.has_time === true && a.has_date === false)) continue;
        const { state, attributes } = this.pick(st);
        list.push({ entity: e, state, attributes });
        if (list.length >= 2000) break;
      }
      this.post({ type: "result", req: m.req, ok: true, helpers: list });
    }
    reply(req, ok, error) { if (Number.isInteger(req)) this.post({ type: "result", req, ok, ...(error ? { error } : {}) }); }

    /* The v1 write table's device rows. Everything is checked against this element's own copy of the config and HA's
       own state, so a frame that names a device it shouldn't, or a value the device can't take, gets nothing sent. */
    async device(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!isId(m.id) || !ACTIONS.includes(m.action)) return refuse("Not a device or action this panel knows.");
      const d = this.config.devices.find((x) => x.id === m.id);
      if (!d || !d.entity || !d.zones.length) return refuse("That device isn't mapped to a zone.");
      const entity = d.entity, domain = entity.split(".")[0], st = this._hass.states[entity];
      if (!WRITE_DOMAINS.includes(domain)) return refuse("This panel doesn't control that kind of entity.");
      if (!st) return refuse(`Home Assistant has no ${entity}.`);
      if (st.state === "unavailable") return refuse("It's unavailable in Home Assistant.");
      const a = st.attributes, target = { entity_id: entity };
      let call = null;
      if (m.action === "turn_on" || m.action === "turn_off") call = [domain, m.action, target];
      else if (m.action === "brightness" && domain === "light" && (a.supported_color_modes || []).some((c) => c !== "onoff") && Number.isInteger(m.value) && m.value >= 1 && m.value <= 100) call = ["light", "turn_on", { ...target, brightness_pct: m.value }];
      else if (m.action === "mode" && domain === "humidifier" && typeof m.value === "string" && (a.available_modes || []).includes(m.value)) call = ["humidifier", "set_mode", { ...target, mode: m.value }];
      else if (m.action === "humidity" && domain === "humidifier" && isNum(m.value) && m.value >= a.min_humidity && m.value <= a.max_humidity) call = ["humidifier", "set_humidity", { ...target, humidity: m.value }];
      if (!call) return refuse("That value isn't one this device takes.");
      try {
        await this._hass.callService(...call);
        this.reply(m.req, true);
      } catch (err) {
        refuse(String((err && err.message) || err));
      }
    }

    /* The calibration write: the frame names a sensor and a value, never an entity. The entity is that sensor's own, from this
       element's config, and the value has to sit inside the entity's own limits and step. */
    async calibrate(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!isId(m.sensor) || !isNum(m.value)) return refuse("Not a sensor or value this panel knows.");
      const sensor = this.config.zones.flatMap((z) => z.sensors || []).find((x) => x && x.id === m.sensor);
      if (!sensor || typeof sensor.leafEntity !== "string" || sensor.leafUnused || !/^number\.[a-z0-9_]{1,200}$/.test(sensor.leafEntity)) return refuse("That sensor has no leaf temperature offset on its board.");
      const st = this._hass.states[sensor.leafEntity];
      if (!st) return refuse(`Home Assistant has no ${sensor.leafEntity}.`);
      if (st.state === "unavailable") return refuse("The board is offline.");
      const a = st.attributes || {}, steps = (m.value - a.min) / a.step;
      if (a.unit_of_measurement !== "°C") return refuse("That setting isn't in °C, so it isn't a leaf temperature offset.");
      if (!(m.value >= a.min && m.value <= a.max) || Math.abs(steps - Math.round(steps)) > 1e-6) return refuse(`It has to be between ${a.min} and ${a.max} °C, in steps of ${a.step}.`);
      try {
        await this._hass.callService("number", "set_value", { entity_id: sensor.leafEntity, value: m.value });
        this.reply(m.req, true);
      } catch (err) {
        refuse(String((err && err.message) || err));
      }
    }

    /* The setting write: a zone and the name of one of its linked settings. The helper is the one that zone links to in this
       element's config, and the value has to fit that helper's own limits and step, or be a time for a time helper. */
    async setting(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!isId(m.zone) || !SETTINGS.includes(m.name)) return refuse("Not a setting this panel knows.");
      const z = this.config.zones.find((x) => x && x.id === m.zone), entity = z && linkAt(z, m.name);
      if (typeof entity !== "string" || !HELPER.test(entity)) return refuse("That setting isn't linked to a helper.");
      if (/^(bands|light)\./.test(m.name) && z.linked !== true) return refuse("That zone's limits are set in Environment Control, not on its helpers.");
      const st = this._hass.states[entity];
      if (!st || st.state === "unavailable") return refuse(`Home Assistant has no ${entity} it can set.`);
      let call;
      if (entity.startsWith("input_datetime.")) {
        if (typeof m.value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.value)) return refuse("That isn't a time.");
        call = ["input_datetime", "set_datetime", { entity_id: entity, time: `${m.value}:00` }];
      } else {
        const a = st.attributes || {}, steps = isNum(m.value) ? (m.value - a.min) / a.step : NaN;
        if (!isNum(m.value) || m.value < a.min || m.value > a.max || Math.abs(steps - Math.round(steps)) > 1e-6) return refuse(`It has to be between ${a.min} and ${a.max}, in steps of ${a.step}.`);
        call = ["input_number", "set_value", { entity_id: entity, value: m.value }];
      }
      try {
        await this._hass.callService(...call);
        this.reply(m.req, true);
      } catch (err) {
        refuse(String((err && err.message) || err));
      }
    }

    /* Setup changes only this integration's own storage, through its backend, which checks the whole config and the
       revision it was based on. The host keeps the backend's answer, never the frame's copy, as its config. */
    async save(m) {
      const refuse = (why) => this.reply(m.req, false, why);
      if (!Number.isInteger(m.base) || !m.config || typeof m.config !== "object") return refuse("That isn't a setup this panel can save.");
      if (JSON.stringify(m.config).length > 512 * 1024) return refuse("That setup is too large to save.");
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
        return refuse(String((err && err.message) || err));
      }
      this.post({ type: "result", req: m.req, ok: true, ...this.stored() });
      this.forward();
    }

    /* Entities this save would make controllable that aren't now. Removing one, or changing only its role, adds nothing. */
    newlyControlled(config) {
      if (!Array.isArray(config.devices) || !Array.isArray(config.zones)) return "That isn't a setup this panel can save.";
      const now = this.mapped(), out = [];
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
    describe(item, config) {
      const st = this._hass.states[item.entity], reg = (this._hass.entities || {})[item.entity] || {}, areas = this._hass.areas || {};
      const area = reg.area_id && areas[reg.area_id] ? areas[reg.area_id].name : null;
      const zones = item.zones.map((id) => (config.zones.find((z) => z && z.id === id) || {}).name).filter((n) => typeof n === "string");
      const domain = item.entity.split(".")[0], a = st.attributes || {};
      const can = item.helper ? "Its value can be changed." : domain === "light" && !(a.supported_color_modes || []).some((c) => c !== "onoff") ? CAN.switch : CAN[domain];
      /* Zone names are the user's own and can be a single letter, so each is named as an area or zone, and every line ends in
         a full stop, so a short name never reads as text cut off. */
      const flag = item.helper ? "" : !area ? "Has no area in Home Assistant." : zones.some((z) => z.toLowerCase() === area.toLowerCase()) ? "" : `In the ${area} area in Home Assistant, not in the ${zones.join(" or ")} area${zones.length > 1 ? "s" : ""}.`;
      const facts = [reg.platform, area].filter(Boolean).map(String).join(", ");
      return { name: String(a.friendly_name || item.entity), facts: facts ? `${facts}.` : "", can, flag, zones };
    }
    confirm(items, config) {
      this.asking = true;
      return new Promise((resolve) => {
        const make = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
        const rows = items.map((it) => ({ it, ...this.describe(it, config) }));
        const zones = [...new Set(rows.flatMap((r) => r.zones))];
        const t = this.theme(), dlg = make("dialog", undefined, t.mode);
        if (t.colors.primary) { dlg.style.setProperty("--p", t.colors.primary); dlg.style.setProperty("--on-p", onColor(t.colors.primary)); }
        dlg.setAttribute("aria-labelledby", "ec-confirm-title");
        const style = make("style", DIALOG_CSS), title = make("h2", "Allow Environment Control to control these?");
        title.id = "ec-confirm-title"; title.tabIndex = -1;
        const sub = make("p", `Asked for by the panel${zones.length ? `, for the ${zones.join(" and ")} zone${zones.length > 1 ? "s" : ""}` : ""}. Allow only what you meant to add: once allowed, the panel can switch it from now on.`);
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
        const count = (n, word) => (n ? `${n} ${word}${n > 1 ? "s" : ""}` : "");
        const cancel = make("button", "Cancel"), allow = make("button", `Allow ${[count(devices.length, "device"), count(helpers.length, "helper")].filter(Boolean).join(" and ")}`, "allow");
        cancel.dataset.host = "cancel"; allow.dataset.host = "allow";
        const row = make("div", undefined, "row"); row.append(cancel, allow);
        dlg.append(style, title, sub, ...(devices.length ? [list] : []), ...(helpers.length ? [fold] : []), row);
        let timer;
        const arm = () => { allow.disabled = true; clearTimeout(timer); timer = setTimeout(() => { allow.disabled = false; }, ARM_MS); };
        const seen = () => { if (document.visibilityState === "visible") arm(); };
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
  }
  if (!customElements.get("environment-control-panel")) customElements.define("environment-control-panel", EnvironmentControlPanel);
})();
