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
