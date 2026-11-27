"use strict";
/* FAKED TEST DATA FOR MOCK PURPOSES. Every reading, limit, time, layout and device below is invented to exercise the
   design mock and the tests; none of it is measured from a real room.
   It is what the fake Home Assistant starts with: what the panel's backend has stored, and what HA reports for each
   entity. build-snapshot.py writes the same shape from a real room, and that output is never committed. */
const SEED = (() => {
  /* Each limit is [min, low, target, high, max]. Min and max are critical, and low to high is the ideal zone. */
  const bandsA = { day: { temperature: [23, 24, 25, 27, 28], humidity: [55, 60, 64, 67, 70], vpd: [0.8, 0.95, 1.1, 1.2, 1.3] }, night: { temperature: [16, 20, 23, 25, 26], humidity: [55, 58, 62, 65, 68], vpd: [0.7, 0.85, 1.0, 1.1, 1.2] } };
  const bandsB = () => ({ day: { temperature: [22, 23, 25, 27, 28], humidity: [55, 58, 62, 67, 70], vpd: [0.7, 0.8, 0.9, 1.05, 1.2] }, night: { temperature: [18, 19, 21, 23, 25], humidity: [55, 58, 62, 67, 70], vpd: [0.7, 0.75, 0.85, 1.0, 1.1] } });
  const zones = [
    { id: "garden", name: "Garden", dayAt: 7 * 60, nightAt: 19 * 60, now: { temperature: 26.8, humidity: 63.4, vpd: 1.06, light: 41200 }, bands: bandsA, linked: true, lightLimits: { dayMin: 2000, nightMax: 200 }, emerson: { morning: 5, daylight: 10, evening: 5 },
      layout: { w: 2.4, d: 1.2, units: 12, rows: 3, cols: 4 },
      sensors: [
        { id: "g-left", name: "Environment left", short: "Env left", kind: "env", pos: [0.5, 0], level: "in", t: 26.6, h: 64.2, link: "Ethernet", leafEntity: "number.environment_left_leaf_temperature_offset", leafLive: -1 },
        { id: "g-right", name: "Environment right", short: "Env right", kind: "env", pos: [0.5, 3], level: "above", t: 27.0, h: 62.6, link: "Ethernet", leafEntity: "number.environment_right_leaf_temperature_offset", leafLive: -1 },
        { id: "g-under", name: "Environment under", short: "Env under", kind: "env", pos: [1.5, 1.5], level: "under", t: 24.9, h: 71.0, link: "Ethernet", leaf: -0.5 },
      ] },
    { id: "veg", name: "Veg", dayAt: 16 * 60, nightAt: 10 * 60, now: { temperature: 20.4, humidity: 72.1, vpd: 0.59, light: 0 }, bands: bandsB(), linked: true, lightLimits: { dayMin: 800, nightMax: 200 },
      layout: { w: 1.2, d: 1.2, units: 4, rows: 2, cols: 2 },
      sensors: [{ id: "v-env", name: "Veg environment", short: "Veg env", kind: "env", pos: [0.5, 0.5], level: "above", t: 20.4, h: 72.1, link: "Not known yet", leafEntity: "number.veg_environment_leaf_temperature_offset", leafLive: -1 }] },
    { id: "nursery", name: "Nursery", dayAt: 16 * 60, nightAt: 10 * 60, now: { temperature: 21.1, humidity: 66.0, vpd: 0.74, light: 0 }, bands: bandsB(), linked: false, lightLimits: { dayMin: 300, nightMax: 200 },
      layout: { w: 1.2, d: 0.6, units: 8, rows: 2, cols: 4 },
      sensors: [{ id: "n-env", name: "Nursery environment", short: "Nursery env", kind: "env", pos: [0.5, 1.5], level: "in", t: 21.1, h: 66.0, link: "Ethernet", leafEntity: "number.nursery_environment_leaf_temperature_offset", leafLive: -1 }] },
  ];
  const tuya = { integration: "tuya_local", family: "Tuya", link: "wifi", source: "detected", path: "Local", hub: "" };
  const esphome = { integration: "esphome", family: "ESPHome", link: "ethernet", source: "confirmed", path: "Local", hub: "" };
  const devices = [
    { id: "dehu", name: "Dehumidifier", type: "Dehumidifier", icon: "drop", ctl: "humidifier", ...tuya, zones: ["garden"], entity: "humidifier.garden_dehumidifier", place: { garden: [2.5, 0] } },
    { id: "aux", name: "Auxiliary dehumidifier", type: "Dehumidifier", icon: "drop", ctl: "humidifier", ...tuya, zones: ["garden", "veg", "nursery"], entity: "humidifier.auxiliary_dehumidifier", note: "Unit sensor, not room RH" },
    { id: "ac", name: "Air conditioner", type: "Air conditioner", icon: "gauge", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.air_conditioner", place: { garden: [-0.5, 3] } },
    { id: "heater", name: "Heater", type: "Heater", icon: "thermo", ctl: "switch", ...tuya, zones: ["garden", "veg", "nursery"], entity: "switch.heater_mains", place: { garden: [2.5, 3] } },
    { id: "intake", name: "Intake fan", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.garden_intake_fan", place: { garden: [1, -0.5] } },
    { id: "acfan", name: "Air conditioner exhaust fan", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.air_conditioner_exhaust_fan" },
    { id: "plug", name: "Plug 7", type: null, icon: "plug", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.plug_7" },
    { id: "fans", name: "Oscillating fans", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["veg", "nursery"], entity: "switch.veg_oscillating_fans", place: { veg: [-0.5, 0.5] } },
    { id: "lc-over", name: "Overhead light controller", type: "Light", icon: "sun", ctl: "dimmer", ...esphome, zones: ["garden"], entity: "light.garden_light_controller_overhead" },
    { id: "lp-1", name: "Overhead lights 1", type: "Light", icon: "sun", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.garden_lights_1" },
    { id: "lp-2", name: "Overhead lights 2", type: "Light", icon: "sun", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.garden_lights_2" },
    { id: "lc-under", name: "Under canopy light controller", type: "Light", icon: "sun", ctl: "dimmer", ...esphome, zones: ["garden"], entity: "light.garden_light_controller_under_canopy" },
    { id: "lp-red", name: "Red lights", type: "Light", icon: "sun", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.garden_lights_red" },
    { id: "lc-tent", name: "Tent light controller", type: "Light", icon: "sun", ctl: "dimmer", ...esphome, zones: ["veg", "nursery"], entity: "light.tent_light_controller" },
    { id: "lp-tent", name: "Tent lights", type: "Light", icon: "sun", ctl: "switch", ...tuya, zones: ["veg", "nursery"], entity: "switch.tent_lights" },
    { id: "spare-plug", name: "Spare plug", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: [], entity: "switch.spare_plug" },
    { id: "b-left", name: "Environment left", type: "Sensor board", ...esphome, zones: ["garden"], state: "Online" },
    { id: "b-veg", name: "Veg environment", type: "Sensor board", ...esphome, link: "unknown", source: "unknown", zones: ["veg"], state: "Online" },
    { id: "pulse", name: "Air monitor", type: "Sensor", integration: "pulselabs", family: "Pulse", link: "wifi", source: "detected", path: "Cloud", hub: "", zones: ["veg"], state: "Stale, 9 min old", stale: true },
    { id: "door", name: "Door contact", type: "Sensor", integration: "hue", family: "Hue", link: "zigbee", source: "detected", path: "Local", hub: "Hue Bridge", zones: ["garden"], state: "Online" },
    { id: "vpd", name: "Average VPD", type: "Calculated", integration: "template", family: "Template", link: "derived", source: "detected", path: "Local", hub: "", zones: ["garden"], state: "Online" },
  ];
  const sw = (state, name) => ({ state, attributes: { friendly_name: name } });
  const dim = (state, pct, name) => ({ state, attributes: { friendly_name: name, supported_color_modes: ["brightness"], brightness: pct === null ? null : Math.round((pct / 100) * 255) } });
  const states = {
    "humidifier.garden_dehumidifier": { state: "on", attributes: { friendly_name: "Garden Dehumidifier", mode: "normal", available_modes: ["sleep", "comfort", "eco", "boost"], humidity: 55, current_humidity: 56, min_humidity: 35, max_humidity: 80 } },
    "humidifier.auxiliary_dehumidifier": { state: "on", attributes: { friendly_name: "Auxiliary Dehumidifier", mode: "laundry", available_modes: ["normal", "eco", "boost", "laundry"], humidity: 50, current_humidity: 41, min_humidity: 35, max_humidity: 80 } },
    "switch.air_conditioner": sw("on", "Air Conditioner"),
    "switch.heater_mains": sw("off", "Heater Mains"),
    "switch.garden_intake_fan": sw("on", "Garden Intake Fan"),
    "switch.air_conditioner_exhaust_fan": sw("unavailable", "Air Conditioner Exhaust Fan"),
    "switch.plug_7": sw("off", "Plug 7"),
    "switch.veg_oscillating_fans": sw("on", "Veg Oscillating Fans"),
    "light.garden_light_controller_overhead": dim("on", 80, "Garden Light Controller Overhead"),
    "switch.garden_lights_1": sw("on", "Garden Lights 1"),
    "switch.garden_lights_2": sw("on", "Garden Lights 2"),
    "light.garden_light_controller_under_canopy": dim("on", 45, "Garden Light Controller Under Canopy"),
    "switch.garden_lights_red": sw("off", "Garden Lights Red"),
    "light.tent_light_controller": dim("off", null, "Tent Light Controller"),
    "switch.tent_lights": sw("off", "Tent Lights"),
    "switch.spare_plug": sw("off", "Spare Plug"),
    ...Object.fromEntries(["environment_left", "environment_right", "veg_environment", "nursery_environment"].map((b) => [`number.${b}_leaf_temperature_offset`,
      { state: "-1.0", attributes: { friendly_name: `${b.replace(/_/g, " ")} leaf temperature offset`, min: -5, max: 2, step: 0.1, unit_of_measurement: "°C" } }])),
    "switch.reservoir_pump": sw("off", "Reservoir Pump"),
  };
  /* HA's own entity and area registries, which the host reads to show what a device really is. */
  const area = { "humidifier.garden_dehumidifier": "garden", "humidifier.auxiliary_dehumidifier": "garden", "switch.air_conditioner": "garden", "switch.heater_mains": "garden", "switch.garden_intake_fan": "garden",
    "switch.air_conditioner_exhaust_fan": "garden", "switch.veg_oscillating_fans": "veg", "light.garden_light_controller_overhead": "garden", "switch.garden_lights_1": "garden", "switch.garden_lights_2": "garden",
    "light.garden_light_controller_under_canopy": "garden", "switch.garden_lights_red": "garden", "light.tent_light_controller": "veg", "switch.tent_lights": "veg", "switch.reservoir_pump": "reservoir" };
  const entities = Object.fromEntries(Object.keys(states).map((e) => [e, { entity_id: e, platform: e.startsWith("light.") ? "esphome" : "tuya_local", area_id: area[e] || null }]));
  const automationEntities = () => { for (const [id, , where] of AUTOMATIONS) entities[`automation.${id}`] = { entity_id: `automation.${id}`, platform: "automation", area_id: where }; };
  const areas = Object.fromEntries(["Garden", "Veg", "Nursery", "Reservoir"].map((n) => [n.toLowerCase(), { area_id: n.toLowerCase(), name: n }]));
  /* The helpers each zone links to, as the backend stores them, and what HA reports for each. Veg and Nursery share their
     schedule helpers. Nursery's limits are set in Environment Control, so it links no threshold helpers. */
  const bandLinks = (zone) => Object.fromEntries(["day", "night"].map((p) => [p, Object.fromEntries(["temperature", "humidity", "vpd"].map((k) =>
    [k, { min: `input_number.${zone}_${p}_${k}_min_threshold`, target: `input_number.${zone}_${p}_${k}_target`, max: `input_number.${zone}_${p}_${k}_max_threshold` }]))]));
  const lightLinks = (zone) => ({ dayMin: `input_number.day_lights_${zone}_min_threshold`, nightMax: `input_number.night_lights_${zone}_max_threshold` });
  zones[0].helpers = { day: "input_datetime.garden_day_time", night: "input_datetime.garden_night_time", morning: "input_number.emerson_effect_morning_extension",
    daylight: "input_number.emerson_effect_daylight_time", evening: "input_number.emerson_effect_evening_extension", bands: bandLinks("garden"), light: lightLinks("garden") };
  zones[1].helpers = { day: "input_datetime.veg_day_time", night: "input_datetime.veg_night_time", bands: bandLinks("veg"), light: lightLinks("veg") };
  zones[2].helpers = { day: "input_datetime.veg_day_time", night: "input_datetime.veg_night_time" };
  /* HA writes Celsius both ways, so Garden's temperature helpers say ℃ and the rest °C, as in this room. */
  const LIMITS = { temperature: [-20, 50, 0.1, "°C"], humidity: [0, 100, 0.1, "%"], vpd: [0, 3, 0.01, "kPa"], light: [0, 10000, 10, "lx"], minutes: [0, 59, 1, "minutes"] };
  const helper = (value, [min, max, step, unit], name) => ({ state: String(value), attributes: { friendly_name: name, min, max, step, mode: "box", unit_of_measurement: unit } });
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  const time = (m, name) => ({ state: clock(m), attributes: { friendly_name: name, has_date: false, has_time: true } });
  for (const z of zones) {
    const h = z.helpers;
    states[h.day] = time(z.dayAt, h.day);
    states[h.night] = time(z.nightAt, h.night);
    for (const k of ["morning", "daylight", "evening"]) if (h[k]) states[h[k]] = helper(z.emerson[k], LIMITS.minutes, h[k]);
    for (const [p, metrics] of Object.entries(h.bands || {})) for (const [k, slots] of Object.entries(metrics)) for (const [slot, e] of Object.entries(slots)) states[e] = helper(z.bands[p][k][{ min: 0, target: 2, max: 4 }[slot]], k === "temperature" && z.id === "garden" ? [...LIMITS.temperature.slice(0, 3), "℃"] : LIMITS[k], e);
    for (const [k, e] of Object.entries(h.light || {})) states[e] = helper(z.lightLimits[k], LIMITS.light, e);
  }
  /* Helpers HA has that nothing links yet, for the picker. Nursery's own thresholds exist, as in this room, but its limits are
     set here until someone links them. The rest are what a real HA also holds: wrong units, and a date-and-time helper the
     picker must leave out. */
  for (const p of ["day", "night"]) for (const k of ["temperature", "humidity", "vpd"]) for (const [slot, i] of [["min", 0], ["max", 4]]) {
    const e = `input_number.nursery_${p}_${k}_${slot}_threshold`;
    states[e] = helper(zones[2].bands[p][k][i], LIMITS[k], e);
  }
  states["input_number.day_lights_nursery_min_threshold"] = helper(zones[2].lightLimits.dayMin, LIMITS.light, "input_number.day_lights_nursery_min_threshold");
  states["input_number.night_lights_nursery_max_threshold"] = helper(zones[2].lightLimits.nightMax, LIMITS.light, "input_number.night_lights_nursery_max_threshold");
  states["input_number.spare_vpd_threshold"] = helper(0.9, LIMITS.vpd, "Spare VPD threshold");
  states["input_number.reservoir_target_ec"] = helper(1.8, [0, 5, 0.1, "mS/cm"], "Reservoir target EC");
  states["input_datetime.reservoir_refill_time"] = time(9 * 60, "Reservoir refill time");
  states["input_datetime.last_reservoir_refill"] = { state: "2026-11-03 09:12:00", attributes: { friendly_name: "Last reservoir refill", has_date: true, has_time: true } };
  /* The automations behind each zone's alerts, failsafes and light schedule. Home Assistant runs them; the panel only
     switches them on and off. Veg and Nursery share their light schedule, so they share its automations and failsafes.
     Each is [object id, friendly name, area, on, last triggered in hours before the mock's time or null for never]. */
  const AUTOMATIONS = [
    ["critical_garden_temperature_high_day", "Critical Garden Temperature High Day", "garden", true, 30],
    ["critical_garden_temperature_low_day", "Critical Garden Temperature Low Day", "garden", true, null],
    ["critical_garden_humidity_high_day", "Critical Garden Humidity High Day", "garden", true, 3],
    ["critical_garden_humidity_low_day", "Critical Garden Humidity Low Day", "garden", true, null],
    ["critical_garden_vpd_high_day", "Critical Garden VPD High Day", "garden", true, 52],
    ["critical_garden_vpd_low_day", "Critical Garden VPD Low Day", "garden", true, 3],
    ["critical_garden_lights_low_day", "Critical Garden Lights Low Day", "garden", true, null],
    ["critical_garden_temperature_high_night", "Critical Garden Temperature High Night", "garden", true, null],
    ["critical_garden_temperature_low_night", "Critical Garden Temperature Low Night", "garden", true, 14],
    ["critical_garden_humidity_high_night", "Critical Garden Humidity High Night", "garden", true, 15],
    ["critical_garden_vpd_low_night", "Critical Garden VPD Low Night", "garden", false, 40],
    ["critical_garden_lights_high_night", "Critical Garden Lights High Night", "garden", true, null],
    ["critical_garden_environment_sensor_unavailable", "Critical Garden Environment Sensor Unavailable", "garden", true, 96],
    ["critical_garden_climate_control_device_unavailable", "Critical Garden Climate Control Device Unavailable", "garden", true, 1],
    ["critical_garden_dehumidifier_full", "Critical Garden Dehumidifier Full", "garden", true, 20],
    ["critical_garden_light_controller_overhead_off_day", "Critical Garden Light Controller Overhead Off Day", "garden", true, null],
    ["failsafe_garden_lights_recovery", "Failsafe Garden Lights Recovery", "garden", true, 0.1],
    ["failsafe_garden_red_lights_recovery", "Failsafe Garden Red Lights Recovery", "garden", true, 26],
    ["failsafe_dehumidifier_mains_auto_on", "Failsafe Dehumidifier Mains Auto On", "garden", true, 70],
    ["garden_lights_on", "Garden Lights On", "garden", true, 7],
    ["garden_lights_off", "Garden Lights Off", "garden", true, 19],
    ["garden_red_lights_on", "Garden Red Lights On", "garden", true, 7.1],
    ["garden_red_lights_off", "Garden Red Lights Off", "garden", true, 18.9],
    ["critical_veg_temperature_high_day", "Critical Veg Temperature High Day", "veg", true, null],
    ["critical_veg_temperature_low_day", "Critical Veg Temperature Low Day", "veg", true, 22],
    ["critical_veg_temperature_high_night", "Critical Veg Temperature High Night", "veg", true, null],
    ["critical_veg_temperature_low_night", "Critical Veg Temperature Low Night", "veg", true, 10],
    ["critical_veg_environment_sensor_unavailable", "Critical Veg Environment Sensor Unavailable", "veg", true, null],
    ["warning_veg_auxiliary_dehumidifier_full", "Warning Veg Auxiliary Dehumidifier Full", "veg", true, 33],
    ["failsafe_veg_fans_auto_on", "Failsafe Veg Fans Auto On", "veg", true, 5],
    ["failsafe_tent_lights_recovery", "Failsafe Tent Lights Recovery", "veg", true, 0.05],
    ["tent_lights_on", "Tent Lights On", "veg", true, 4],
    ["tent_lights_off", "Tent Lights Off", "veg", true, 10],
    ["critical_nursery_temperature_high_day", "Critical Nursery Temperature High Day", "nursery", true, null],
    ["critical_nursery_temperature_low_night", "Critical Nursery Temperature Low Night", "nursery", true, 9],
    ["critical_nursery_environment_sensor_unavailable", "Critical Nursery Environment Sensor Unavailable", "nursery", true, null],
    /* Not linked to any zone yet, for the picker: one the name suggests for Nursery, a climate limit, and two that belong
       to the house and must never be suggested. */
    ["critical_nursery_vpd_high_day", "Critical Nursery VPD High Day", "nursery", true, null],
    ["day_humidity_upper_limit", "Day Humidity Upper Limit", "garden", false, 400],
    ["porch_light_on", "Porch Light On", null, true, 8],
    ["reservoir_refill_reminder", "Reservoir Refill Reminder", "reservoir", true, 50],
  ];
  /* The mock's own clock: 13:30 on a fixed day, so "last triggered" reads the same on every run. */
  const MOCK_NOW = Date.parse("2026-11-17T13:30:00+13:00");
  for (const [id, name, , on, ago] of AUTOMATIONS) states[`automation.${id}`] = { state: on ? "on" : "off", attributes: { friendly_name: name, last_triggered: ago === null ? null : new Date(MOCK_NOW - ago * 3600e3).toISOString() } };
  const link = (ids, group) => ids.map((id) => ({ entity: `automation.${id}`, group }));
  const numbered = (list) => list.map((a, i) => ({ id: `a${i + 1}`, ...a }));
  zones[0].automations = numbered([
    ...link(["critical_garden_temperature_high_day", "critical_garden_temperature_low_day", "critical_garden_humidity_high_day", "critical_garden_humidity_low_day", "critical_garden_vpd_high_day", "critical_garden_vpd_low_day", "critical_garden_lights_low_day"], "alert_day"),
    ...link(["critical_garden_temperature_high_night", "critical_garden_temperature_low_night", "critical_garden_humidity_high_night", "critical_garden_vpd_low_night", "critical_garden_lights_high_night"], "alert_night"),
    /* Named _day, but kept with the device alerts, as the garden dashboard has it: the name only suggests a group. */
    ...link(["critical_garden_environment_sensor_unavailable", "critical_garden_climate_control_device_unavailable", "critical_garden_dehumidifier_full", "critical_garden_light_controller_overhead_off_day"], "alert_device"),
    ...link(["failsafe_garden_lights_recovery", "failsafe_garden_red_lights_recovery", "failsafe_dehumidifier_mains_auto_on"], "failsafe"),
    ...link(["garden_lights_on", "garden_lights_off", "garden_red_lights_on", "garden_red_lights_off"], "control"),
  ]);
  const tent = [...link(["failsafe_veg_fans_auto_on", "failsafe_tent_lights_recovery"], "failsafe"), ...link(["tent_lights_on", "tent_lights_off"], "control")];
  zones[1].automations = numbered([
    ...link(["critical_veg_temperature_high_day", "critical_veg_temperature_low_day"], "alert_day"),
    ...link(["critical_veg_temperature_high_night", "critical_veg_temperature_low_night"], "alert_night"),
    ...link(["critical_veg_environment_sensor_unavailable", "warning_veg_auxiliary_dehumidifier_full"], "alert_device"),
    ...tent,
  ]);
  zones[2].automations = numbered([
    ...link(["critical_nursery_temperature_high_day"], "alert_day"),
    ...link(["critical_nursery_temperature_low_night"], "alert_night"),
    ...link(["critical_nursery_environment_sensor_unavailable"], "alert_device"),
    ...tent,
  ]);
  /* One helper sets how often every alert in Home Assistant may buzz a phone, so it's linked once, for the whole room. */
  states["input_number.alert_repeat_rate"] = helper(15, [0, 120, 1, "min"], "Alert repeat rate");
  const room = { alertRepeat: "input_number.alert_repeat_rate" };
  /* What each failsafe holds a device to at the mock's time: fans always on, and light plugs on their schedule. */
  const failsafes = {
    "switch.veg_oscillating_fans": { want: "on", kind: "failsafe", by: "Veg fans auto on" },
    "switch.garden_lights_1": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.garden_lights_2": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.tent_lights": { want: "off", kind: "watchdog", by: "Tent lights recovery" },
  };
  automationEntities();
  return { config: { revision: 1, zones, devices, room }, states, failsafes, registry: { entities, areas } };
})();
