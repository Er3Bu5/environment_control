"use strict";
/* Stands in for Home Assistant on a dev machine, so the panel can be proven before it touches a real room.
   It hands the panel element a hass object shaped like the real one: states, callService and a connection for the
   panel's own commands. It behaves like this room where that matters: devices report a moment after a command,
   a Tuya plug can drop one silently, failsafes put some devices back, and a service refuses what HA would refuse. */
class FakeHA {
  constructor(seed) {
    this.states = JSON.parse(JSON.stringify(seed.states));
    this.config = JSON.parse(JSON.stringify(seed.config));
    this.failsafes = seed.failsafes || {};
    this.knobs = { reportMs: 600, dropNext: false, dropAll: false, failsafeMs: 1000, watchdogMs: 3000 };
    this.calls = [];
    this.panels = new Set();
    this.listeners = new Set();
    this.darkMode = false;
  }

  attach(panel) { this.panels.add(panel); panel.hass = this.hass(); }
  onCall(fn) { this.listeners.add(fn); }
  hass() {
    return {
      states: this.states,
      user: { is_admin: true },
      themes: { darkMode: this.darkMode },
      callService: (domain, service, data) => this.callService(domain, service, data),
      connection: { sendMessagePromise: (msg) => this.command(msg) },
    };
  }
  /* HA gives the panel a new hass object on every change, never a mutated one. */
  publish() { this.states = { ...this.states }; for (const p of this.panels) p.hass = this.hass(); }
  setState(entity, state, attributes, context) {
    const was = this.states[entity];
    this.states[entity] = { entity_id: entity, state, attributes: { ...(was ? was.attributes : {}), ...(attributes || {}) }, context: context || { user_id: null, parent_id: null } };
    this.publish();
    this.watch(entity, was && was.state);
  }
  setDark(dark) { this.darkMode = dark; this.publish(); }

  /* A failsafe here acts within seconds, where yours take 1 second (mains and fans) or up to 2 minutes (the light watchdogs). */
  watch(entity, was) {
    const f = this.failsafes[entity], now = this.states[entity];
    if (!f || !now || now.state === f.want || now.state === "unavailable" || was === now.state) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      const s = this.states[entity];
      if (s && s.state !== f.want && s.state !== "unavailable") this.setState(entity, f.want, f.want === "off" && entity.startsWith("light.") ? { brightness: null } : {}, { user_id: null, parent_id: f.by });
    }, f.kind === "watchdog" ? this.knobs.watchdogMs : this.knobs.failsafeMs);
  }

  fail(msg) { const e = new Error(msg); e.code = "invalid_format"; throw e; }
  /* What HA itself checks before a service runs. The panel's host checks first, so reaching one of these is a host bug. */
  validate(domain, service, data) {
    const entity = data && data.entity_id, s = this.states[entity];
    if (typeof entity !== "string" || !s) this.fail(`Entity ${entity} not found`);
    if (entity.split(".")[0] !== domain) this.fail(`${domain}.${service} can't act on ${entity}`);
    const a = s.attributes, num = (v) => typeof v === "number" && Number.isFinite(v);
    const key = `${domain}.${service}`;
    const known = ["switch.turn_on", "switch.turn_off", "fan.turn_on", "fan.turn_off", "light.turn_on", "light.turn_off", "humidifier.turn_on", "humidifier.turn_off", "humidifier.set_mode", "humidifier.set_humidity", "number.set_value", "input_number.set_value", "input_datetime.set_datetime"];
    if (!known.includes(key)) this.fail(`Service ${key} not found`);
    if (key === "light.turn_on" && data.brightness_pct !== undefined && !(num(data.brightness_pct) && data.brightness_pct >= 0 && data.brightness_pct <= 100)) this.fail(`Value ${data.brightness_pct} for brightness_pct is out of range`);
    if (key === "humidifier.set_mode" && !(a.available_modes || []).includes(data.mode)) this.fail(`Mode ${data.mode} is not one of ${(a.available_modes || []).join(", ")}`);
    if (key === "humidifier.set_humidity" && !(num(data.humidity) && data.humidity >= a.min_humidity && data.humidity <= a.max_humidity)) this.fail(`Humidity ${data.humidity} is outside ${a.min_humidity} to ${a.max_humidity}`);
    if (key.endsWith(".set_value")) {
      const v = data.value, off = num(v) ? Math.abs(((v - a.min) / a.step) - Math.round((v - a.min) / a.step)) : 1;
      if (!num(v) || v < a.min || v > a.max || off > 1e-6) this.fail(`Value ${v} for ${entity} must be ${a.min} to ${a.max} in steps of ${a.step}`);
    }
    if (key === "input_datetime.set_datetime" && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(data.time))) this.fail(`Time ${data.time} is not valid`);
  }
  outcome(domain, service, data, s) {
    const a = s.attributes;
    switch (`${domain}.${service}`) {
      case "light.turn_on": return ["on", { brightness: data.brightness_pct === undefined ? (a.brightness || 255) : Math.round((data.brightness_pct / 100) * 255) }];
      case "light.turn_off": return ["off", { brightness: null }];
      case "humidifier.set_mode": return [s.state, { mode: data.mode }];
      case "humidifier.set_humidity": return [s.state, { humidity: data.humidity }];
      case "input_datetime.set_datetime": return [String(data.time).length === 5 ? `${data.time}:00` : String(data.time), {}];
      default: return service === "turn_on" ? ["on", {}] : service === "turn_off" ? ["off", {}] : [String(data.value), {}];
    }
  }
  async callService(domain, service, data) {
    this.validate(domain, service, data);
    const entity = data.entity_id, s = this.states[entity];
    if (s.state === "unavailable") { const e = new Error(`${entity} is unavailable`); e.code = "home_assistant_error"; throw e; }
    const call = { domain, service, data: { ...data }, dropped: this.knobs.dropAll || this.knobs.dropNext };
    this.calls.push(call); this.knobs.dropNext = false;
    for (const fn of this.listeners) fn(call);
    /* HA accepts a call a Tuya plug then ignores, so a dropped command still returns success. */
    if (call.dropped) return { context: { id: `c${this.calls.length}` } };
    const [state, attrs] = this.outcome(domain, service, data, s);
    setTimeout(() => { if (this.states[entity].state !== "unavailable") this.setState(entity, state, attrs, { user_id: "you", parent_id: null }); }, this.knobs.reportMs);
    return { context: { id: `c${this.calls.length}` } };
  }

  /* The panel's own backend commands. */
  async command(msg) {
    if (!msg || typeof msg.type !== "string") this.fail("Bad message");
    if (msg.type === "environment_control/config") return JSON.parse(JSON.stringify(this.config));
    this.fail(`Unknown command ${msg.type}`);
  }

  offline(entity, down) {
    const s = this.states[entity]; if (!s) return;
    this.held = this.held || {};
    if (down) { if (s.state !== "unavailable") this.held[entity] = s.state; this.setState(entity, "unavailable"); }
    else if (s.state === "unavailable") this.setState(entity, this.held[entity] || "off");
  }
}
