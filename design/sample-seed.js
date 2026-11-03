"use strict";
/* Made-up room for the fake Home Assistant: what the panel's backend has stored, and what HA reports for each entity.
   build-snapshot.py writes the same shape from a real room. */
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
    { id: "dehu", name: "Dehumidifier", type: "Dehumidifier", icon: "drop", ctl: "humidifier", ...tuya, zones: ["garden"], entity: "humidifier.garden_dehumidifier" },
    { id: "aux", name: "Auxiliary dehumidifier", type: "Dehumidifier", icon: "drop", ctl: "humidifier", ...tuya, zones: ["garden", "veg", "nursery"], entity: "humidifier.auxiliary_dehumidifier", note: "Unit sensor, not room RH" },
    { id: "ac", name: "Air conditioner", type: "Air conditioner", icon: "gauge", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.air_conditioner" },
    { id: "heater", name: "Heater", type: "Heater", icon: "thermo", ctl: "switch", ...tuya, zones: ["garden", "veg", "nursery"], entity: "switch.heater_mains" },
    { id: "intake", name: "Intake fan", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.garden_intake_fan" },
    { id: "acfan", name: "Air conditioner exhaust fan", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.air_conditioner_exhaust_fan" },
    { id: "plug", name: "Plug 7", type: null, icon: "plug", ctl: "switch", ...tuya, zones: ["garden"], entity: "switch.plug_7" },
    { id: "fans", name: "Oscillating fans", type: "Fan", icon: "fan", ctl: "switch", ...tuya, zones: ["veg", "nursery"], entity: "switch.veg_oscillating_fans" },
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
    "switch.reservoir_pump": sw("off", "Reservoir Pump"),
  };
  /* HA's own entity and area registries, which the host reads to show what a device really is. */
  const area = { "humidifier.garden_dehumidifier": "garden", "humidifier.auxiliary_dehumidifier": "garden", "switch.air_conditioner": "garden", "switch.heater_mains": "garden", "switch.garden_intake_fan": "garden",
    "switch.air_conditioner_exhaust_fan": "garden", "switch.veg_oscillating_fans": "veg", "light.garden_light_controller_overhead": "garden", "switch.garden_lights_1": "garden", "switch.garden_lights_2": "garden",
    "light.garden_light_controller_under_canopy": "garden", "switch.garden_lights_red": "garden", "light.tent_light_controller": "veg", "switch.tent_lights": "veg", "switch.reservoir_pump": "reservoir" };
  const entities = Object.fromEntries(Object.keys(states).map((e) => [e, { entity_id: e, platform: e.startsWith("light.") ? "esphome" : "tuya_local", area_id: area[e] || null }]));
  const areas = Object.fromEntries(["Garden", "Veg", "Nursery", "Reservoir"].map((n) => [n.toLowerCase(), { area_id: n.toLowerCase(), name: n }]));
  /* What each failsafe holds a device to at the mock's time: fans always on, and light plugs on their schedule. */
  const failsafes = {
    "switch.veg_oscillating_fans": { want: "on", kind: "failsafe", by: "Veg fans auto on" },
    "switch.garden_lights_1": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.garden_lights_2": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.tent_lights": { want: "off", kind: "watchdog", by: "Tent lights recovery" },
  };
  return { config: { revision: 1, zones, devices }, states, failsafes, registry: { entities, areas } };
})();
