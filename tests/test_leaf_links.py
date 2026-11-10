"""The guard on the calibration write: a new offset link is a °C number entity on the sensor's own device."""

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.environment_control.const import DOMAIN


@pytest.fixture
async def loaded(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


@pytest.fixture
def boards(hass: HomeAssistant) -> dict[str, str]:
    """Two boards, each with an offset number in °C, plus a number on the first that isn't in °C."""
    esphome = MockConfigEntry(domain="esphome")
    esphome.add_to_hass(hass)
    devices, entities, out = dr.async_get(hass), er.async_get(hass), {}
    for name in ("left", "right"):
        device = devices.async_get_or_create(
            config_entry_id=esphome.entry_id, identifiers={("esphome", name)}, name=name
        )
        number = entities.async_get_or_create("number", "esphome", f"{name}-offset", device_id=device.id)
        hass.states.async_set(number.entity_id, "-1.0", {"unit_of_measurement": "°C", "min": -5, "max": 2, "step": 0.1})
        out[name], out[f"{name}_offset"] = device.id, number.entity_id
    brightness = entities.async_get_or_create("number", "esphome", "left-brightness", device_id=out["left"])
    hass.states.async_set(brightness.entity_id, "50", {"unit_of_measurement": "%"})
    out["left_brightness"] = brightness.entity_id
    switch = entities.async_get_or_create("switch", "esphome", "left-relay", device_id=out["left"])
    out["left_switch"] = switch.entity_id
    return out


def _zone(sensor: str, leaf: str) -> dict:
    return {
        "zones": [{"id": "garden", "name": "Garden", "sensors": [{"id": sensor, "name": "Left", "leafEntity": leaf}]}],
        "devices": [],
    }


async def _save(client, revision: int, config: dict) -> dict:
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": revision, "config": config})
    return await client.receive_json()


async def test_a_board_s_own_offset_in_celsius_links(hass, loaded, boards, hass_ws_client) -> None:
    r = await _save(await hass_ws_client(hass), 0, _zone(boards["left"], boards["left_offset"]))
    assert r["success"], r


@pytest.mark.parametrize(
    ("leaf", "why"),
    [
        ("right_offset", "isn't on the same device"),
        ("left_brightness", "isn't in °C"),
        ("left_switch", "isn't a number entity"),
        ("number.not_in_ha", "isn't a number entity"),
    ],
)
async def test_any_other_link_is_refused(hass, loaded, boards, hass_ws_client, leaf, why) -> None:
    r = await _save(await hass_ws_client(hass), 0, _zone(boards["left"], boards.get(leaf, leaf)))
    assert not r["success"]
    assert r["error"]["code"] == "invalid_config"
    assert why in r["error"]["message"]


async def test_a_link_already_stored_stays_without_being_checked_again(hass, loaded, boards, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    assert (await _save(client, 0, _zone(boards["left"], boards["left_offset"])))["success"]
    er.async_get(hass).async_remove(boards["left_offset"])
    r = await _save(client, 1, _zone(boards["left"], boards["left_offset"]))
    assert r["success"], r


async def test_an_offset_kept_here_needs_no_entity(hass, loaded, boards, hass_ws_client) -> None:
    config = _zone(boards["left"], boards["right_offset"])
    config["zones"][0]["sensors"][0].update(leafUnused=True, leaf=-1.5)
    r = await _save(await hass_ws_client(hass), 0, config)
    assert r["success"], r
