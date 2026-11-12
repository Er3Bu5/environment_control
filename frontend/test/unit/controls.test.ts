import { describe, expect, it } from "vitest";
import { CTL_FLIP_MS, type Ctl, choiceDown, choiceUp, ctlLine, deviceView, dialArc, dialAt, dialT, dialValue, humidityChoices, modeChoices, nearestChoice, nudgeTargets, onReport, stepDown, stepUp, wantOf, wanted, zoneControls } from "../../src/frame/controls";
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

  it("lists what can have a dial first in its group, and otherwise keeps the order devices were added in", () => {
    const mixed = {
      zones: [{ id: "garden" }],
      devices: [
        dev("plug1", "switch.lights_1", "Light", ["garden"]),
        dev("over", "light.controller_overhead", "Light", ["garden"]),
        dev("plug2", "switch.lights_2", "Light", ["garden"]),
        dev("under", "light.controller_under", "Light", ["garden"]),
        dev("mains", "switch.dehumidifier_mains", "Dehumidifier", ["garden"]),
        dev("dehu", "humidifier.dehu", "Dehumidifier", ["garden"]),
        dev("fan2", "switch.fan_2", "Fan", ["garden"]),
        dev("fan1", "switch.fan_1", "Fan", ["garden"]),
      ],
    };
    expect(zoneControls(mixed, "garden").groups.map((g) => g.devices.map((d) => d.id))).toEqual([["dehu", "mains"], ["fan2", "fan1"], ["over", "under", "plug1", "plug2"]]);
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

  it("takes a number the device moved to as its answer, and says where it went", () => {
    const sending: Ctl = { status: "sending", want: wantOf("brightness", 78), since: 0, from: 60 };
    const landed = onReport(sending, st("on", { brightness: 204 }), "user", 5);
    expect(landed).toEqual({ status: "done", want: { state: "on", brightness: 80 }, at: 5, asked: 78 });
    expect(onReport({ status: "stuck", want: wantOf("humidity", 47), from: 50 }, st("on", { humidity: 45 }), "device", 9)).toEqual({ status: "done", want: { humidity: 45 }, at: 9, asked: 47 });
    /* A light that was off had no number, so any number it comes on at is its answer. */
    expect(onReport({ ...sending, from: null }, st("on", { brightness: 38 }), "user", 5)).toEqual(expect.objectContaining({ status: "done", asked: 78 }));
  });

  it("keeps waiting while the number hasn't moved, or the device still isn't on", () => {
    const sending: Ctl = { status: "sending", want: wantOf("brightness", 82), since: 0, from: 80 };
    expect(onReport(sending, st("on", { brightness: 204 }), "user", 5)).toBe(sending);
    expect(onReport({ ...sending, from: null }, st("off", { brightness: null }), "user", 5)?.status).toBe("sending");
    const target: Ctl = { status: "sending", want: wantOf("humidity", 45), since: 0, from: 50 };
    expect(onReport(target, st("on", { humidity: 50, current_humidity: 61 }), "user", 5)).toBe(target);
  });

  it("drops the note when a light fading through other numbers reaches the one asked, and still sees a put back after a rounded answer", () => {
    const landed: Ctl = { status: "done", want: { state: "on", brightness: 60 }, at: 5, asked: 40 };
    expect(onReport(landed, st("on", { brightness: 102 }), "user", 900)).toEqual({ status: "done", want: { state: "on", brightness: 40 }, at: 5 });
    expect(onReport({ ...landed, want: { state: "on", brightness: 80 }, asked: 78 }, st("off", { brightness: null }), "automation", 900)).toEqual({ status: "back", by: "automation" });
  });

  it("says a change was put back when anything but a person undoes it soon after, and lets a person's own change stand", () => {
    const done: Ctl = { status: "done", want: wantOf("turn_off"), at: 0 };
    expect(onReport(done, st("on"), "automation", 1_000)).toEqual({ status: "back", by: "automation" });
    expect(onReport(done, st("on"), "device", 1_000)).toEqual({ status: "back", by: "other" });
    expect(onReport(done, st("on"), "user", 1_000)).toBe(done);
    expect(onReport(done, st("on"), "automation", CTL_FLIP_MS + 1)).toBe(done);
  });

  it("words each outcome, naming what the device still reports", () => {
    const d = { id: "fan", entity: "switch.fan", name: "Intake fan", role: "Fan", zones: ["garden"], family: "Tuya", link: "wifi", extraMode: "", hiddenModes: [] };
    const v = deviceView("switch.fan", st("off"));
    expect(ctlLine({ status: "sending", want: wantOf("turn_on"), since: 0 }, d, v)?.text).toBe("Sent. Waiting for Intake fan to report back.");
    expect(ctlLine({ status: "stuck", want: wantOf("turn_on") }, d, v)).toEqual({ text: "Not confirmed. Intake fan still reports off. A Tuya plug can drop a command without saying, so try again.", tone: "crit" });
    expect(ctlLine({ status: "stuck", want: wantOf("turn_on") }, { ...d, family: "ESPHome" }, v)?.text).toContain("Try again, or check the device.");
    expect(ctlLine({ status: "back", by: "automation" }, d, v)?.text).toBe("Put back by Home Assistant straight after, most likely a failsafe or the light schedule.");
    expect(ctlLine({ status: "error", error: "It's unavailable in Home Assistant." }, d, v)).toEqual({ text: "Not sent. It's unavailable in Home Assistant.", tone: "crit" });
    expect(ctlLine({ status: "done", want: wantOf("turn_on"), at: 0 }, d, v)).toBeNull();
    const lamp = { ...d, name: "Overhead", family: "ESPHome" }, at80 = deviceView("light.lamp", st("on", { supported_color_modes: ["brightness"], brightness: 204 }));
    expect(ctlLine({ status: "done", want: { state: "on", brightness: 80 }, at: 0, asked: 78 }, lamp, at80)).toEqual({ text: "Went to 80%, not 78%. Overhead keeps to its own steps and limits.", tone: "" });
    expect(ctlLine({ status: "stuck", want: wantOf("brightness", 82), from: 80 }, lamp, at80)?.text).toBe("Not confirmed. Overhead still reports 80%. It may not take 82%, so try another value.");
    expect(ctlLine({ status: "stuck", want: wantOf("brightness", 82), from: null }, lamp, deviceView("light.lamp", st("off", { supported_color_modes: ["brightness"] })))?.text).toBe("Not confirmed. Overhead still reports off. Try again, or check the device.");
  });
});

describe("the dial a number is set on", () => {
  const near = ([x, y]: [number, number]) => [Math.round(x), Math.round(y)];

  it("runs from bottom left, over the top, to bottom right", () => {
    expect([near(dialAt(0)), near(dialAt(0.5)), near(dialAt(1))]).toEqual([[26, 94], [60, 12], [94, 94]]);
    expect(dialArc(0, 1)).toBe("M26.06 93.94A48 48 0 1 1 93.94 93.94");
    expect(dialArc(0, 0.5)).toBe("M26.06 93.94A48 48 0 0 1 60.00 12.00");
  });

  it("reads the number under a point, and gets back the point a number sits at", () => {
    expect(dialValue(60, 12, 1, 100)).toBe(51);
    expect(dialValue(12, 60, 35, 80)).toBe(43);
    for (const n of [1, 15, 40, 80, 100]) expect(dialValue(...dialAt(dialT(n, 1, 100)), 1, 100)).toBe(n);
  });

  it("stops at the nearer end for a point in the gap at the bottom, and never jumps to the other", () => {
    expect(dialValue(50, 110, 1, 100)).toBe(1);
    expect(dialValue(70, 110, 1, 100)).toBe(100);
  });

  it("steps to the next whole step either way, inside the limits", () => {
    expect([stepUp(78, 5, 100), stepDown(78, 5, 1), stepUp(80, 5, 100), stepDown(80, 5, 1)]).toEqual([80, 75, 85, 75]);
    expect([stepUp(98, 5, 100), stepUp(100, 5, 100), stepDown(3, 5, 1), stepUp(0, 5, 100)]).toEqual([100, 100, 1, 5]);
    expect([stepUp(50, 1, 54), stepUp(54, 1, 54), stepDown(50, 1, 50)]).toEqual([51, 54, 50]);
  });
});

describe("a device that says its target moves in steps", () => {
  const v = deviceView("humidifier.dehu", st("on", { humidity: 65, min_humidity: 35, max_humidity: 80, target_humidity_step: 5 }));

  it("is offered its own steps and nothing between, and a number between goes to the nearest", () => {
    expect([v.stepRh, humidityChoices(v)]).toEqual([5, [35, 40, 45, 50, 55, 60, 65, 70, 75, 80]]);
    expect([nearestChoice(humidityChoices(v), 63), nearestChoice(humidityChoices(v), 62), nearestChoice([], 7)]).toEqual([65, 60, 7]);
  });

  it("goes up and down a step at a time, and stops at either end", () => {
    const c = humidityChoices(v);
    expect([choiceUp(c, 65), choiceDown(c, 65), choiceUp(c, 80), choiceDown(c, 35), choiceUp(c, 62)]).toEqual([70, 60, 80, 35, 65]);
  });

  it("is taken at whole percents when it names no step", () => {
    const plain = deviceView("humidifier.dehu", st("on", { humidity: 52, min_humidity: 50, max_humidity: 54, target_humidity_step: 0 }));
    expect([plain.stepRh, humidityChoices(plain)]).toEqual([null, [50, 51, 52, 53, 54]]);
  });
});

describe("a mode Home Assistant doesn't list", () => {
  const dehu = (attrs: Record<string, unknown>) => deviceView("humidifier.dehu", st("on", { available_modes: ["eco", "boost"], mode: "boost", ...attrs }));

  it("is offered after the device's own modes, once, and only when one is set", () => {
    const v = dehu({});
    expect([modeChoices(v, "normal"), modeChoices(v, "eco"), modeChoices(v, "")]).toEqual([["eco", "boost", "normal"], ["eco", "boost"], ["eco", "boost"]]);
    const stored = { zones: [{ id: "garden" }], devices: [{ id: "dehu", entity: "humidifier.dehu", name: "Dehu", type: "Dehumidifier", zones: ["garden"], nudgeMode: " normal " }] };
    expect(zoneControls(stored, "garden").groups[0].devices[0].extraMode).toBe("normal");
  });

  it("leaves out the modes hidden in Device identification, but never the one the device is in", () => {
    const v = dehu({ available_modes: ["sleep", "comfort", "eco", "boost"] });
    expect(modeChoices(v, "normal", ["sleep", "comfort"])).toEqual(["eco", "boost", "normal"]);
    /* It's in boost, so boost stays on the row though it's hidden; the extra mode can be hidden like any other. */
    expect(modeChoices(v, "normal", ["boost", "normal"])).toEqual(["sleep", "comfort", "eco", "boost"]);
    expect(modeChoices(dehu({ mode: "normal" }), "normal", ["normal", "eco", "boost"])).toEqual(["normal"]);
    const stored = { zones: [{ id: "garden" }], devices: [{ id: "dehu", entity: "humidifier.dehu", name: "Dehu", type: "Dehumidifier", zones: ["garden"], hiddenModes: ["sleep", 5, "comfort"] }] };
    expect(zoneControls(stored, "garden").groups[0].devices[0].hiddenModes).toEqual(["sleep", "comfort"]);
  });

  it("is reached by moving the target one whole percent and back, inside the device's limits", () => {
    expect(nudgeTargets(dehu({ humidity: 55, min_humidity: 35, max_humidity: 80 }))).toEqual([56, 55]);
    /* At the top there's no room above, so it steps down and back. */
    expect(nudgeTargets(dehu({ humidity: 80, min_humidity: 35, max_humidity: 80 }))).toEqual([79, 80]);
    expect(nudgeTargets(dehu({ humidity: 52.5, min_humidity: 35, max_humidity: 80 }))).toEqual([53, 52]);
    /* A unit that says its target moves in steps of 5 ignores a 1% move, so the step is one of its own. */
    expect(nudgeTargets(dehu({ humidity: 65, min_humidity: 35, max_humidity: 80, target_humidity_step: 5 }))).toEqual([70, 65]);
    expect(nudgeTargets(dehu({ humidity: 80, min_humidity: 35, max_humidity: 80, target_humidity_step: 5 }))).toEqual([75, 80]);
    expect(nudgeTargets(dehu({ humidity: 50, min_humidity: 50, max_humidity: 50 }))).toBeNull();
    expect(nudgeTargets(dehu({ humidity: 50 }))).toBeNull();
    expect(nudgeTargets(dehu({ min_humidity: 35, max_humidity: 80 }))).toBeNull();
  });

  it("says what it's doing while the steps are sent", () => {
    const d = { id: "dehu", entity: "humidifier.dehu", name: "Dehu", role: "Dehumidifier", zones: ["garden"], family: "Tuya", link: "wifi", extraMode: "normal", hiddenModes: [] };
    expect(ctlLine({ status: "sending", want: wantOf("humidity", 56), since: 0, note: "Moving the target one step and back." }, d, dehu({}))?.text).toBe("Moving the target one step and back.");
    expect(ctlLine({ status: "stuck", want: { mode: "normal" } }, d, dehu({}))?.text).toBe("Not confirmed. Dehu still reports on, boost mode. Moving its target didn't put it in normal mode.");
    /* A mode Home Assistant does list was asked for by name, so a missing report is the usual story. */
    expect(ctlLine({ status: "stuck", want: { mode: "eco" } }, d, dehu({}))?.text).toContain("A Tuya plug can drop a command");
  });
});
