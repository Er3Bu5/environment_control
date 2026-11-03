"use strict";
/* Made-up room for the fake Home Assistant: what the panel's backend has stored, and what HA reports for each entity.
   build-snapshot.py writes the same shape from a real room. */
const SEED = (() => {
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
  };
  /* What each failsafe holds a device to at the mock's time: fans always on, and light plugs on their schedule. */
  const failsafes = {
    "switch.veg_oscillating_fans": { want: "on", kind: "failsafe", by: "Veg fans auto on" },
    "switch.garden_lights_1": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.garden_lights_2": { want: "on", kind: "watchdog", by: "Garden lights recovery" },
    "switch.tent_lights": { want: "off", kind: "watchdog", by: "Tent lights recovery" },
  };
  return { config: { devices }, states, failsafes };
})();
