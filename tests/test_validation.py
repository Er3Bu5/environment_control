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
    "follows a non on/off entity": (lambda c: c["zones"][0].update(lights=["sensor.x"]), "on or off"),
    "description too long": (lambda c: c["zones"][0].update(description="x" * 201), "short text"),
    "leaf offset not a number entity": (
        lambda c: c["zones"][0].update(sensors=[{"id": "s", "leafEntity": "sensor.x"}]),
        "number entity",
    ),
    "VPD chart offset that isn't a sensor id": (lambda c: c["zones"][0].update(leafBasis="<b>"), "VPD chart"),
    "virtual device with an entity": (
        lambda c: c["zones"][0].update(virtual=[{"id": "v-tank", "name": "Tank", "pos": [0, 0], "entity": "switch.x"}]),
        "a name and a spot",
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
