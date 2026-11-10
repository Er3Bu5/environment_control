"""The device catalog: how each device is connected, what it reports, and what it never reports."""

import json

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.environment_control.catalog import Link, classify
from custom_components.environment_control.const import DOMAIN

NONE: frozenset[str] = frozenset()
# Made up, and built here so the repo holds nothing shaped like a real hardware address.
FAKE_MAC = ":".join(["aa", "bb", "cc", "dd", "ee", "ff"])
FAKE_ZIGBEE = ":".join(["00", "17", "88", "01", "00", "00", "00"])


@pytest.mark.parametrize(
    ("platform", "connections", "hub", "iot_class", "service", "expected"),
    [
        ("tuya_local", NONE, False, "local_polling", False, Link("wifi", "local")),
        # A wired board and a WiFi board both show only a MAC, so ESPHome can't be told apart.
        ("esphome", frozenset({"mac"}), False, "local_push", False, Link("unknown", "local")),
        ("hue", frozenset({"zigbee"}), True, "local_push", False, Link("zigbee", "local")),
        # The hub carries a zigbee address too, but that says nothing about how the hub itself is connected.
        ("hue", frozenset({"mac", "zigbee"}), False, "local_push", False, Link("unknown", "local")),
        ("zha", frozenset({"zigbee"}), True, "local_polling", False, Link("zigbee", "local")),
        ("zwave_js", NONE, False, "local_push", False, Link("zwave", "local")),
        ("some_ble", frozenset({"bluetooth"}), False, "local_push", False, Link("bluetooth", "local")),
        ("lg_thinq", NONE, False, "cloud_push", False, Link("unknown", "cloud")),
        ("pulselabs", NONE, False, "cloud_polling", False, Link("unknown", "cloud")),
        ("crop_steering", NONE, False, "local_polling", True, Link("derived", "derived")),
        ("template", NONE, False, "local_push", False, Link("derived", "derived")),
        ("input_boolean", NONE, False, None, False, Link("derived", "derived")),
        ("never_heard_of_it", NONE, False, None, False, Link("unknown", "unknown")),
    ],
)
def test_classify(platform, connections, hub, iot_class, service, expected) -> None:
    got = classify(platform=platform, connection_types=connections, has_hub=hub, iot_class=iot_class, service=service)
    assert got == expected


@pytest.fixture
async def loaded(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


@pytest.fixture
def room(hass: HomeAssistant) -> None:
    """A board with a MAC, a serial and an address in its configuration URL, a zigbee bulb behind a hub, a helper."""
    areas, devices, entities = ar.async_get(hass), dr.async_get(hass), er.async_get(hass)
    garden = areas.async_create("Garden")

    esphome = MockConfigEntry(domain="esphome")
    esphome.add_to_hass(hass)
    board = devices.async_get_or_create(
        config_entry_id=esphome.entry_id,
        connections={(dr.CONNECTION_NETWORK_MAC, FAKE_MAC)},
        identifiers={("esphome", "board-serial-123")},
        name="Environment board",
        manufacturer="Espressif",
        model="PoE board",
        serial_number="SN-PRIVATE-9",
        configuration_url="http://example.com:6052/private-board-page",
        sw_version="2026.10.1",
    )
    devices.async_update_device(board.id, area_id=garden.id)
    temp = entities.async_get_or_create(
        "sensor", "esphome", "board-temp", device_id=board.id, original_device_class="temperature"
    )
    hass.states.async_set(
        temp.entity_id,
        "21.5",
        {"device_class": "temperature", "unit_of_measurement": "°C", "friendly_name": "Air temp"},
    )
    off = entities.async_get_or_create(
        "sensor", "esphome", "board-old", device_id=board.id, disabled_by=er.RegistryEntryDisabler.USER
    )
    hass.states.async_set(off.entity_id, "1")
    entities.async_get_or_create("button", "esphome", "board-restart", device_id=board.id)

    hue = MockConfigEntry(domain="hue")
    hue.add_to_hass(hass)
    bridge = devices.async_get_or_create(
        config_entry_id=hue.entry_id,
        identifiers={("hue", "bridge-id-77")},
        connections={(dr.CONNECTION_ZIGBEE, FAKE_ZIGBEE + ":01")},
        name="Hue bridge",
    )
    bulb = devices.async_get_or_create(
        config_entry_id=hue.entry_id,
        identifiers={("hue", "bulb-id-78")},
        connections={(dr.CONNECTION_ZIGBEE, FAKE_ZIGBEE + ":02")},
        via_device_id=bridge.id,
        name="Tent light",
    )
    entities.async_get_or_create("light", "hue", "bulb-light", device_id=bulb.id)

    entities.async_get_or_create("input_boolean", "input_boolean", "override", suggested_object_id="lights_override")
    entities.async_get_or_create("automation", "automation", "auto", suggested_object_id="lights_on")


async def _catalog(hass, client) -> dict:
    await client.send_json_auto_id({"type": f"{DOMAIN}/catalog"})
    reply = await client.receive_json()
    assert reply["success"], reply
    return reply["result"]


async def test_each_device_comes_with_its_usable_entities_and_how_it_is_connected(
    hass, loaded, room, hass_ws_client
) -> None:
    result = await _catalog(hass, await hass_ws_client(hass))
    by_name = {d["name"]: d for d in result["devices"]}

    board = by_name["Environment board"]
    assert (board["area"], board["integration"], board["link"], board["path"]) == (
        "Garden",
        "esphome",
        "unknown",
        "local",
    )
    assert (board["manufacturer"], board["model"]) == ("Espressif", "PoE board")
    # The disabled sensor and the button aren't offered.
    temp = er.async_get(hass).async_get_entity_id("sensor", "esphome", "board-temp")
    assert [e["entity_id"] for e in board["entities"]] == [temp]
    entity = board["entities"][0]
    assert (entity["device_class"], entity["unit"], entity["state"], entity["name"]) == (
        "temperature",
        "°C",
        "21.5",
        "Air temp",
    )

    bulb = by_name["Tent light"]
    assert (bulb["link"], bulb["hub"]) == ("zigbee", "Hue bridge")
    # The bridge has no entity setup could use, so it isn't listed.
    assert "Hue bridge" not in by_name

    loose = [e["entity_id"] for e in result["entities"]]
    assert loose == ["input_boolean.lights_override"]


async def test_a_number_comes_with_its_own_limits(hass, loaded, room, hass_ws_client) -> None:
    entities = er.async_get(hass)
    board = entities.async_get(entities.async_get_entity_id("sensor", "esphome", "board-temp")).device_id
    offset = entities.async_get_or_create("number", "esphome", "board-offset", device_id=board)
    hass.states.async_set(offset.entity_id, "-1.0", {"unit_of_measurement": "°C", "min": -5, "max": 2, "step": 0.1})
    result = await _catalog(hass, await hass_ws_client(hass))
    found = {e["entity_id"]: e for d in result["devices"] for e in d["entities"]}
    assert {k: found[offset.entity_id][k] for k in ("min", "max", "step", "unit")} == {
        "min": -5,
        "max": 2,
        "step": 0.1,
        "unit": "°C",
    }
    temp = entities.async_get_entity_id("sensor", "esphome", "board-temp")
    assert not {"min", "max", "step"} & set(found[temp])


async def test_no_identifier_address_serial_or_firmware_leaves_the_backend(hass, loaded, room, hass_ws_client) -> None:
    text = json.dumps(await _catalog(hass, await hass_ws_client(hass)))
    for private in (
        FAKE_MAC,
        FAKE_ZIGBEE,
        "board-serial-123",
        "bridge-id-77",
        "bulb-id-78",
        "SN-PRIVATE-9",
        "private-board-page",
        "2026.10.1",
    ):
        assert private.lower() not in text.lower(), private
    for key in ("identifiers", "connections", "serial_number", "configuration_url", "sw_version", "config_entries"):
        assert f'"{key}"' not in text, key


async def test_the_catalog_is_for_admins_only(hass, loaded, room, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json_auto_id({"type": f"{DOMAIN}/catalog"})
    reply = await client.receive_json()
    assert not reply["success"]
    assert reply["error"]["code"] == "unauthorized"
