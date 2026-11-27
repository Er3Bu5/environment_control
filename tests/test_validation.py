"""The backend's own checks on a setup, the same ones the mock's fake backend makes."""

import copy

import pytest

from custom_components.environment_control.validation import InvalidConfig, validate_config


def test_the_sample_room_is_valid(sample_config) -> None:
    validate_config({"zones": sample_config["zones"], "devices": sample_config["devices"]})


def _bad(sample_config, change):
    c = copy.deepcopy({"zones": sample_config["zones"], "devices": sample_config["devices"]})
    change(c)
    return c


CASES = {
    "not zones and devices": (lambda c: c.pop("devices"), "isn't zones and devices"),
    "too many zones": (
        lambda c: c.update(zones=[{"id": f"z{i}"} for i in range(21)], devices=[]),
        "isn't zones and devices",
    ),
    "duplicate zone id": (lambda c: c["zones"].append(copy.deepcopy(c["zones"][0])), "unique slugs"),
    "zone id not a slug": (lambda c: c["zones"][0].update(id="Bad Id"), "unique slugs"),
    "device in a missing zone": (lambda c: c["devices"].append({"id": "x", "zones": ["nowhere"]}), "doesn't exist"),
    "uncontrollable entity": (
        lambda c: c["devices"].append({"id": "x", "zones": [], "entity": "lock.door"}),
        "can't control",
    ),
    "sensor reading from a lock": (
        lambda c: c["zones"][0]["sensors"][0].update(entities={"temperature": "lock.door"}),
        "isn't a sensor entity",
    ),
    "sensor reading slot that isn't a reading": (
        lambda c: c["zones"][0]["sensors"][0].update(entities={"door": "sensor.x"}),
        "isn't a sensor entity",
    ),
    "sensor of a kind the panel doesn't know": (
        lambda c: c["zones"][0]["sensors"][0].update(kind="radar"),
        "kind of sensor",
    ),
    "sensor id with odd characters": (
        lambda c: c["zones"][0]["sensors"][0].update(id="a b/c"),
        "id this panel can't use",
    ),
    "too many sensors": (
        lambda c: c["zones"][0].update(sensors=[{"id": f"s{i}"} for i in range(51)]),
        "short list",
    ),
    "offset kept here out of range": (lambda c: c["zones"][0]["sensors"][0].update(leaf=40), "outside -10 to 10"),
    "average flag that isn't a boolean": (lambda c: c["zones"][0]["sensors"][0].update(avg="yes"), "true or false"),
    "device id with odd characters": (lambda c: c["devices"][0].update(id="<b>"), "id this panel can't use"),
    "device name too long": (lambda c: c["devices"][0].update(name="x" * 101), "short text"),
    "layout too big": (lambda c: c["zones"][0]["layout"].update(w=500), "size outside"),
    "grid too small for its units": (lambda c: c["zones"][0]["layout"].update(units=99), "doesn't hold its units"),
    "unit count that isn't whole": (lambda c: c["zones"][0]["layout"].update(units=2.5), "unit count outside"),
    "label on a unit the zone doesn't have": (
        lambda c: c["zones"][0]["layout"].update(labels={"999": "GG4"}),
        "unit label",
    ),
    "label on a unit numbered oddly": (lambda c: c["zones"][0]["layout"].update(labels={"01": "GG4"}), "unit label"),
    "unit label that's too long": (lambda c: c["zones"][0]["layout"].update(labels={"1": "x" * 13}), "unit label"),
    "unit label that's blank": (lambda c: c["zones"][0]["layout"].update(labels={"1": "  "}), "unit label"),
    "unit labels that aren't by unit": (lambda c: c["zones"][0]["layout"].update(labels=["GG4"]), "unit label"),
    "sensor outside the wall": (lambda c: c["zones"][0]["sensors"][0].update(pos=[-1, 0]), "can't go"),
    "sensor off the half-steps": (lambda c: c["zones"][0]["sensors"][0].update(pos=[0.25, 0]), "can't go"),
    "soil probe in an aisle": (
        lambda c: c["zones"][0]["sensors"][0].update(kind="soil", pos=[0.5, 0]),
        "soil probe can't go",
    ),
    "height the panel doesn't know": (lambda c: c["zones"][0]["sensors"][0].update(level="roof"), "height this panel"),
    "time setting on a number helper": (
        lambda c: c["zones"][0].update(helpers={"day": "input_number.x"}),
        "time helper",
    ),
    "number setting on a time helper": (
        lambda c: c["zones"][0].update(helpers={"morning": "input_datetime.x"}),
        "number helper",
    ),
    "helper that isn't a helper": (lambda c: c["zones"][0].update(helpers={"day": "switch.x"}), "isn't a helper"),
    "unknown red light source": (lambda c: c["zones"][0].update(emersonMode="magic"), "doesn't know"),
    "red light extension out of range": (
        lambda c: c["zones"][0].update(emersonMode="fixed", emerson={"morning": 60, "daylight": 0, "evening": 0}),
        "0 to 59",
    ),
    "limits for one period only": (lambda c: c["zones"][0]["bands"].pop("night"), "day and night"),
    "limits missing a reading": (lambda c: c["zones"][0]["bands"]["day"].pop("vpd"), "temperature, humidity and VPD"),
    "four limits where five go": (
        lambda c: c["zones"][0]["bands"]["day"].update(temperature=[20, 22, 24, 26]),
        "Min, Low, Target, High and Max",
    ),
    "a limit that isn't a number": (
        lambda c: c["zones"][0]["bands"]["day"].update(humidity=[50, "60", 62, 65, 70]),
        "humidity limit outside",
    ),
    "a missing Min": (lambda c: c["zones"][0]["bands"]["night"].update(vpd=[None, 0.8, 1, 1.1, 1.2]), "vpd limit"),
    "a limit far outside": (
        lambda c: c["zones"][0]["bands"]["day"].update(temperature=[20, 22, 24, 26, 500]),
        "outside",
    ),
    "a light limit below nothing": (lambda c: c["zones"][0].update(lightLimits={"dayMin": -5}), "light limits"),
    "a light limit that isn't one": (lambda c: c["zones"][0].update(lightLimits={"noon": 5}), "light limits"),
    "unknown day and night source": (lambda c: c["zones"][0].update(periodMode="sundial"), "day and night source"),
    "times from helpers without both linked": (
        lambda c: c["zones"][0].update(periodMode="helper", helpers={"day": "input_datetime.on"}),
        "doesn't link both",
    ),
    "a time past midnight's minutes": (lambda c: c["zones"][0].update(dayAt=1440), "minutes into the day"),
    "a time that isn't whole minutes": (lambda c: c["zones"][0].update(nightAt=60.5), "minutes into the day"),
    "unknown day rule": (lambda c: c["zones"][0].update(rule="most"), "day rule"),
    "red lights from helpers without all three linked": (
        lambda c: c["zones"][0].update(emersonMode="helper", helpers={"morning": "input_number.m"}),
        "all three",
    ),
    "follows a non on/off entity": (lambda c: c["zones"][0].update(lights=["sensor.x"]), "on or off"),
    "description too long": (lambda c: c["zones"][0].update(description="x" * 201), "short text"),
    "History opening on a graph it doesn't have": (
        lambda c: c["zones"][0].update(history={"metric": "pressure", "hours": 24}),
        "History",
    ),
    "History opening on a range it doesn't have": (
        lambda c: c["zones"][0].update(history={"metric": "vpd", "hours": 48}),
        "History",
    ),
    "History opening on a range that isn't a number": (
        lambda c: c["zones"][0].update(history={"metric": "vpd", "hours": True}),
        "History",
    ),
    "History opening on something with more to it": (
        lambda c: c["zones"][0].update(history={"metric": "vpd", "hours": 24, "entity": "sensor.x"}),
        "History",
    ),
    "History opening on something that isn't a choice": (lambda c: c["zones"][0].update(history="vpd"), "History"),
    "leaf offset not a number entity": (
        lambda c: c["zones"][0].update(sensors=[{"id": "s", "leafEntity": "sensor.x"}]),
        "number entity",
    ),
    "VPD chart offset that isn't a sensor id": (lambda c: c["zones"][0].update(leafBasis="<b>"), "VPD chart"),
    "virtual device with an entity": (
        lambda c: c["zones"][0].update(virtual=[{"id": "v-tank", "name": "Tank", "pos": [0, 0], "entity": "switch.x"}]),
        "a name and a spot",
    ),
    "virtual device of an unknown type": (
        lambda c: c["zones"][0].update(virtual=[{"id": "v-tank", "name": "Tank", "pos": [0, 0], "type": "Spaceship"}]),
        "kind of virtual device",
    ),
    "virtual device off the map": (
        lambda c: c["zones"][0].update(virtual=[{"id": "v-tank", "name": "Tank", "pos": [99, 0]}]),
        "outside",
    ),
    "device placed off the half-steps": (
        lambda c: c["devices"].append(
            {"id": "x", "zones": [c["zones"][0]["id"]], "place": {c["zones"][0]["id"]: [0.3, 0]}}
        ),
        "outside",
    ),
    "device placed in a zone it isn't in": (
        lambda c: c["devices"].append({"id": "x", "zones": [], "place": {c["zones"][0]["id"]: [0, 0]}}),
        "isn't in",
    ),
    "too large": (lambda c: c["zones"][0].update(name="x" * 600_000), "too large"),
    "automation links that aren't a list": (
        lambda c: c["zones"][0].update(automations={"a1": "automation.x"}),
        "short list",
    ),
    "too many automation links": (
        lambda c: c["zones"][0].update(
            automations=[{"id": f"a{i}", "entity": f"automation.x{i}", "group": "control"} for i in range(201)]
        ),
        "short list",
    ),
    "automation link that names a service": (
        lambda c: c["zones"][0].update(
            automations=[{"id": "a1", "entity": "automation.x", "group": "control", "service": "automation.trigger"}]
        ),
        "an id, an entity and a group",
    ),
    "automation link without a group": (
        lambda c: c["zones"][0].update(automations=[{"id": "a1", "entity": "automation.x"}]),
        "an id, an entity and a group",
    ),
    "automation link that isn't an object": (
        lambda c: c["zones"][0].update(automations=["automation.x"]),
        "an id, an entity and a group",
    ),
    "automation link id with odd characters": (
        lambda c: c["zones"][0].update(automations=[{"id": "A 1", "entity": "automation.x", "group": "control"}]),
        "unique ids",
    ),
    "two automation links with one id": (
        lambda c: c["zones"][0].update(
            automations=[
                {"id": "a1", "entity": "automation.x", "group": "control"},
                {"id": "a1", "entity": "automation.y", "group": "control"},
            ]
        ),
        "unique ids",
    ),
    "automation link to a pump": (
        lambda c: c["zones"][0].update(
            automations=[{"id": "a1", "entity": "switch.reservoir_pump", "group": "control"}]
        ),
        "isn't an automation",
    ),
    "automation link to a script": (
        lambda c: c["zones"][0].update(automations=[{"id": "a1", "entity": "script.x", "group": "control"}]),
        "isn't an automation",
    ),
    "one automation linked twice in a zone": (
        lambda c: c["zones"][0].update(
            automations=[
                {"id": "a1", "entity": "automation.x", "group": "alert_day"},
                {"id": "a2", "entity": "automation.x", "group": "failsafe"},
            ]
        ),
        "or one twice",
    ),
    "automation with a trailing newline": (
        lambda c: c["zones"][0].update(automations=[{"id": "a1", "entity": "automation.x\n", "group": "control"}]),
        "isn't an automation",
    ),
    "one automation linked twice in a zone, once with a trailing newline": (
        lambda c: c["zones"][0].update(
            automations=[
                {"id": "a1", "entity": "automation.x", "group": "alert_day"},
                {"id": "a2", "entity": "automation.x\n", "group": "failsafe"},
            ]
        ),
        "isn't an automation",
    ),
    "one automation in two zones, once with a trailing newline": (
        lambda c: (
            c["zones"][0].update(automations=[{"id": "a1", "entity": "automation.x", "group": "control"}]),
            c["zones"][1].update(automations=[{"id": "a1", "entity": "automation.x\n", "group": "control"}]),
        ),
        "isn't an automation",
    ),
    "device entity with a trailing newline": (
        lambda c: c["devices"].append({"id": "x", "zones": [], "entity": "switch.x\n"}),
        "can't control",
    ),
    "sensor reading with a trailing newline": (
        lambda c: c["zones"][0]["sensors"][0].update(entities={"temperature": "sensor.x\n"}),
        "isn't a sensor entity",
    ),
    "helper with a trailing newline": (
        lambda c: c["zones"][0].update(helpers={"day": "input_datetime.x\n"}),
        "isn't a helper",
    ),
    "alert repeat with a trailing newline": (
        lambda c: c.update(room={"alertRepeat": "input_number.x\n"}),
        "isn't a number helper",
    ),
    "zone id with a trailing newline": (lambda c: c["zones"][0].update(id=c["zones"][0]["id"] + "\n"), "unique slugs"),
    "automation in a group the panel doesn't know": (
        lambda c: c["zones"][0].update(automations=[{"id": "a1", "entity": "automation.x", "group": "other"}]),
        "group this panel doesn't know",
    ),
    "room settings that aren't settings": (lambda c: c.update(room=["input_number.x"]), "Room settings"),
    "room setting the panel doesn't have": (
        lambda c: c.update(room={"pump": "switch.reservoir_pump"}),
        "Room settings",
    ),
    "alert repeat on a time helper": (
        lambda c: c.update(room={"alertRepeat": "input_datetime.x"}),
        "isn't a number helper",
    ),
    "alert repeat on a board's number": (
        lambda c: c.update(room={"alertRepeat": "number.leaf_offset"}),
        "isn't a number helper",
    ),
    "alert repeat that isn't an entity": (lambda c: c.update(room={"alertRepeat": 15}), "isn't a number helper"),
    "something that isn't zones, devices or room settings": (
        lambda c: c.update(scripts=["script.x"]),
        "zones, devices and room settings",
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_a_bad_setup_is_refused_with_why(sample_config, name) -> None:
    change, why = CASES[name]
    with pytest.raises(InvalidConfig, match=why):
        validate_config(_bad(sample_config, change))


def test_a_boolean_is_not_a_minute(sample_config) -> None:
    c = _bad(
        sample_config,
        lambda c: c["zones"][0].update(emersonMode="fixed", emerson={"morning": True, "daylight": 0, "evening": 0}),
    )
    with pytest.raises(InvalidConfig):
        validate_config(c)


def test_a_mapping_the_panel_makes_is_valid(sample_config) -> None:
    c = copy.deepcopy({"zones": sample_config["zones"], "devices": sample_config["devices"]})
    c["zones"][0]["sensors"].append(
        {
            "id": "0123456789abcdef0123456789abcdef",
            "name": "Environment board",
            "kind": "env",
            "pos": None,
            "entities": {"temperature": "sensor.board_air_temp", "humidity": "sensor.board_humidity"},
            "leafUnused": True,
            "leaf": -1.5,
            "avg": True,
            "link": "unknown",
            "linkSource": "detected",
        }
    )
    c["zones"][0]["sensors"].append(
        {
            "id": "soilprobe01",
            "name": "Soil 1",
            "kind": "soil",
            "pos": [0, 0],
            "entities": {
                "moisture": "sensor.soil_1_vwc",
                "ec": "sensor.soil_1_pore_water_ec",
                "temperature": "sensor.soil_1_temp",
            },
            "avg": True,
        }
    )
    c["devices"].append({"id": "d-0a1b2c3d", "entity": "switch.spare_plug", "type": "Heater", "zones": ["garden"]})
    validate_config(c)


def test_a_zone_that_aims_for_no_target_stores_none(sample_config) -> None:
    c = _bad(
        sample_config, lambda c: [v.__setitem__(2, None) for p in c["zones"][0]["bands"].values() for v in p.values()]
    )
    validate_config(c)


def test_a_zone_can_say_what_its_history_opens_on(sample_config) -> None:
    sample_config["zones"][0]["history"] = {"metric": "humidity", "hours": 72}
    validate_config(sample_config)


def test_a_dehumidifier_can_leave_modes_out_of_controls(sample_config) -> None:
    sample_config["devices"].append(
        {
            "id": "d-x",
            "entity": "humidifier.x",
            "zones": [sample_config["zones"][0]["id"]],
            "hiddenModes": ["comfort", "sleep"],
        }
    )
    validate_config(sample_config)


@pytest.mark.parametrize(
    "device",
    [
        {"entity": "switch.x", "hiddenModes": ["sleep"]},
        {"entity": "humidifier.x", "hiddenModes": []},
        {"entity": "humidifier.x", "hiddenModes": "sleep"},
        {"entity": "humidifier.x", "hiddenModes": ["sleep", "sleep"]},
        {"entity": "humidifier.x", "hiddenModes": ["  "]},
        {"entity": "humidifier.x", "hiddenModes": ["x" * 41]},
        {"entity": "humidifier.x", "hiddenModes": ["sl\neep"]},
        {"entity": "humidifier.x", "hiddenModes": [5]},
        {"entity": "humidifier.x", "hiddenModes": [f"m{n}" for n in range(21)]},
        {"hiddenModes": ["sleep"]},
    ],
)
def test_hidden_modes_are_a_short_list_of_names_on_a_humidifier_only(sample_config, device) -> None:
    sample_config["devices"].append({"id": "d-x", "zones": [sample_config["zones"][0]["id"]], **device})
    with pytest.raises(InvalidConfig, match="hidden modes"):
        validate_config(sample_config)


def test_a_dehumidifier_can_have_an_extra_mode(sample_config) -> None:
    sample_config["devices"].append(
        {"id": "d-x", "entity": "humidifier.x", "zones": [sample_config["zones"][0]["id"]], "nudgeMode": "normal"}
    )
    validate_config(sample_config)


@pytest.mark.parametrize(
    "device",
    [
        {"entity": "switch.x", "nudgeMode": "normal"},
        {"entity": "humidifier.x", "nudgeMode": "  "},
        {"entity": "humidifier.x", "nudgeMode": "x" * 41},
        {"entity": "humidifier.x", "nudgeMode": "nor\nmal"},
        {"entity": "humidifier.x", "nudgeMode": 5},
        {"nudgeMode": "normal"},
    ],
)
def test_an_extra_mode_is_a_short_name_on_a_humidifier_only(sample_config, device) -> None:
    sample_config["devices"].append({"id": "d-x", "zones": [sample_config["zones"][0]["id"]], **device})
    with pytest.raises(InvalidConfig, match="extra mode"):
        validate_config(sample_config)


def test_a_unit_can_have_a_label(sample_config) -> None:
    sample_config["zones"][0]["layout"].update(labels={"1": "GG4", "2": "Plant twelve"})
    validate_config(sample_config)


def test_a_virtual_device_waits_for_its_spot(sample_config) -> None:
    """Added in Device identification, it has no spot until Device placement gives it one."""
    sample_config["zones"][0].update(
        virtual=[{"id": "v-tank", "name": "Drain tank", "type": "Tank"}, {"id": "v-lid", "name": "Lid", "pos": None}]
    )
    validate_config(sample_config)


def test_a_virtual_device_can_say_what_it_is(sample_config) -> None:
    c = _bad(
        sample_config,
        lambda c: c["zones"][0].update(virtual=[{"id": "v-tank", "name": "Drain tank", "pos": [0, 0], "type": "Tank"}]),
    )
    validate_config(c)


GROUPS = ("alert_day", "alert_night", "alert_device", "failsafe", "control")


def test_a_zone_can_link_automations_in_every_group(sample_config) -> None:
    """Only links are stored: which automation, under what id, in which group. Home Assistant keeps running them."""
    c = _bad(
        sample_config,
        lambda c: c["zones"][0].update(
            automations=[{"id": f"a{i}", "entity": f"automation.x_{g}", "group": g} for i, g in enumerate(GROUPS)]
        ),
    )
    validate_config(c)


def test_two_zones_cannot_link_one_automation(sample_config) -> None:
    """Even in different groups and under different ids: switched off for one zone it would stop in the other."""
    c = _bad(sample_config, lambda c: [z.update(automations=[]) for z in c["zones"]])
    c["zones"][0]["automations"] = [{"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}]
    c["zones"][2]["automations"] = [
        {"id": "a1", "entity": "automation.tent_lights_on", "group": "control"},
        {"id": "a2", "entity": "automation.failsafe_veg_fans_auto_on", "group": "alert_device"},
    ]
    with pytest.raises(InvalidConfig, match=r"^An automation can only be linked to one zone\.$"):
        validate_config(c)


def test_an_automation_can_be_linked_by_one_zone(sample_config) -> None:
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    for zone in range(3):
        c = _bad(sample_config, lambda c: [z.update(automations=[]) for z in c["zones"]])
        c["zones"][zone]["automations"] = [dict(link)]
        validate_config(c)


def test_a_zone_can_link_no_automations(sample_config) -> None:
    validate_config(_bad(sample_config, lambda c: c["zones"][0].update(automations=[])))


@pytest.mark.parametrize("room", [{}, {"alertRepeat": "input_number.alert_repeat_rate"}])
def test_the_room_can_link_the_alert_repeat_helper_or_nothing(sample_config, room) -> None:
    validate_config(_bad(sample_config, lambda c: c.update(room=room)))
