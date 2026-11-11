import { describe, expect, it } from "vitest";
import { CTL_FLIP_MS, type Ctl, ctlLine, deviceView, humidityChoices, onReport, wantOf, wanted, zoneControls } from "../../src/frame/controls";
import type { HaState } from "../../src/frame/readings";

const st = (state: string, attributes: Record<string, unknown> = {}): HaState => ({ state, attributes, at: null });
const dev = (id: string, entity: string, type: string | null, zones: string[]) => ({ id, entity, name: id, type, zones, family: "Tuya", link: "wifi" });
const config = {
  zones: [{ id: "garden" }, { id: "veg" }],
  devices: [
    dev("dehu", "humidifier.dehu", "Dehumidifier", ["garden"]),
    dev("heater", "switch.heater", "Heater", ["garden", "veg"]),
    dev("lamp", "light.lamp", "Light", ["garden"]),
    dev("fan", "switch.fan", "Fan", ["garden"]),
    dev("plug", "switch.plug", null, ["garden"]),
    dev("pump", "switch.pump", "Other", ["garden"]),
    dev("vegfan", "switch.vegfan", "Fan", ["veg"]),
    { id: "board", name: "Sensor board", type: "Sensor board", zones: ["garden"] },
  ],
};

describe("what a zone's page offers", () => {
  it("groups climate hardware and lights by what they move, holds back a device with no role, and leaves Other on Devices", () => {
    const { groups, unknown } = zoneControls(config, "garden");
    expect(groups.map((g) => [g.title, g.devices.map((d) => d.id)])).toEqual([
      ["Humidity", ["dehu"]],
      ["Temperature", ["heater"]],
      ["Airflow", ["fan"]],
      ["Lights", ["lamp"]],
    ]);
    expect(unknown.map((d) => d.id)).toEqual(["plug"]);
    expect(zoneControls(config, "veg").groups.flatMap((g) => g.devices.map((d) => d.id))).toEqual(["heater", "vegfan"]);
  });
});

describe("what a device reports", () => {
  it("reads a dimmer's brightness, and a light that only switches as a switch", () => {
    expect(deviceView("light.lamp", st("on", { supported_color_modes: ["brightness"], brightness: 204 }))).toEqual(expect.objectContaining({ kind: "dimmer", on: true, brightness: 80, text: "On, 80%" }));
    expect(deviceView("light.lamp", st("off", { supported_color_modes: ["brightness"], brightness: null }))).toEqual(expect.objectContaining({ kind: "dimmer", brightness: null, text: "Off" }));
    expect(deviceView("light.plain", st("on", { supported_color_modes: ["onoff"] })).kind).toBe("switch");
  });

  it("shows a humidifier's actual mode, even one missing from its own list, and labels its own reading as unit RH", () => {
    const v = deviceView("humidifier.dehu", st("on", { mode: "normal", available_modes: ["eco", "boost"], humidity: 55, current_humidity: 56, min_humidity: 35, max_humidity: 80 }));
    expect([v.kind, v.text, v.offList, v.unitRh, v.setpoint]).toEqual(["humidifier", "On, normal mode", true, 56, 55]);
  });

  it("never turns a dead device into off", () => {
    for (const s of [undefined, st("unavailable"), st("unknown")]) expect(deviceView("switch.fan", s)).toEqual(expect.objectContaining({ down: true, on: false, text: "Unavailable" }));
  });

  it("offers whole-percent targets inside the device's own limits, keeping whatever it's set to now", () => {
    const v = deviceView("humidifier.dehu", st("on", { humidity: 52.5, min_humidity: 50, max_humidity: 54 }));
    expect(humidityChoices(v)).toEqual([50, 51, 52, 52.5, 53, 54]);
    expect(humidityChoices(deviceView("humidifier.x", st("on", { humidity: 50 })))).toEqual([50]);
  });
});

describe("a control moves only when the device reports it", () => {
  it("counts a command only once HA reports exactly what was asked", () => {
    expect(wanted(st("on"), wantOf("turn_on"))).toBe(true);
    expect(wanted(st("off"), wantOf("turn_on"))).toBe(false);
    expect(wanted(st("on", { brightness: 102 }), wantOf("brightness", 40))).toBe(true);
    expect(wanted(st("on", { brightness: 255 }), wantOf("brightness", 40))).toBe(false);
    expect(wanted(st("on", { mode: "eco" }), wantOf("mode", "eco"))).toBe(true);
    expect(wanted(st("on", { humidity: 50 }), wantOf("humidity", 45))).toBe(false);
    expect(wanted(undefined, wantOf("turn_off"))).toBe(false);
  });

  it("turns a sent or unconfirmed command into done once reported, however late", () => {
    const want = wantOf("turn_on");
    expect(onReport({ status: "sending", want, since: 0 }, st("off"), "device", 1)?.status).toBe("sending");
    expect(onReport({ status: "sending", want, since: 0 }, st("on"), "user", 1)).toEqual({ status: "done", want, at: 1 });
    expect(onReport({ status: "stuck", want }, st("on"), "user", 50_000)).toEqual({ status: "done", want, at: 50_000 });
  });

  it("says a change was put back when anything but a person undoes it soon after, and lets a person's own change stand", () => {
    const done: Ctl = { status: "done", want: wantOf("turn_off"), at: 0 };
    expect(onReport(done, st("on"), "automation", 1_000)).toEqual({ status: "back", by: "automation" });
    expect(onReport(done, st("on"), "device", 1_000)).toEqual({ status: "back", by: "other" });
    expect(onReport(done, st("on"), "user", 1_000)).toBe(done);
    expect(onReport(done, st("on"), "automation", CTL_FLIP_MS + 1)).toBe(done);
  });

  it("words each outcome, naming what the device still reports", () => {
    const d = { id: "fan", entity: "switch.fan", name: "Intake fan", role: "Fan", zones: ["garden"], family: "Tuya", link: "wifi" };
    const v = deviceView("switch.fan", st("off"));
    expect(ctlLine({ status: "sending", want: wantOf("turn_on"), since: 0 }, d, v)?.text).toBe("Sent. Waiting for Intake fan to report back.");
    expect(ctlLine({ status: "stuck", want: wantOf("turn_on") }, d, v)).toEqual({ text: "Not confirmed. Intake fan still reports off. A Tuya plug can drop a command without saying, so try again.", tone: "crit" });
    expect(ctlLine({ status: "stuck", want: wantOf("turn_on") }, { ...d, family: "ESPHome" }, v)?.text).toContain("Try again, or check the device.");
    expect(ctlLine({ status: "back", by: "automation" }, d, v)?.text).toBe("Put back by Home Assistant straight after, most likely a failsafe or the light schedule.");
    expect(ctlLine({ status: "error", error: "It's unavailable in Home Assistant." }, d, v)).toEqual({ text: "Not sent. It's unavailable in Home Assistant.", tone: "crit" });
    expect(ctlLine({ status: "done", want: wantOf("turn_on"), at: 0 }, d, v)).toBeNull();
  });
});
