"""The panel's backend commands: admin only, revision-checked, validated, and stored."""

import copy

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.environment_control.const import DOMAIN


@pytest.fixture
async def loaded(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _send(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_a_first_install_has_no_zones(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == {"revision": 0, "zones": [], "devices": []}


async def test_a_save_is_stored_and_moves_the_revision_on(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg)
    assert r["success"], r
    assert r["result"]["revision"] == 1
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["revision"] == 1
    assert [z["id"] for z in hass_storage[DOMAIN]["data"]["zones"]] == [z["id"] for z in sample_config["zones"]]
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1


async def test_a_save_survives_reloading_the_integration(hass, loaded, hass_ws_client, sample_unlinked) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg))["success"]
    assert await hass.config_entries.async_reload(loaded.entry_id)
    await hass.async_block_till_done()
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1 and len(r["result"]["zones"]) == len(sample_config["zones"])


async def test_a_save_from_a_stale_copy_is_refused(hass, loaded, hass_ws_client, hass_storage) -> None:
    client = await hass_ws_client(hass)
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [], "devices": []}))[
        "success"
    ]
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [{"id": "late"}], "devices": []})
    assert not r["success"] and r["error"]["code"] == "revision_conflict"
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["zones"] == []


async def test_an_invalid_setup_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_config
) -> None:
    client = await hass_ws_client(hass)
    bad = copy.deepcopy({"zones": sample_config["zones"], "devices": sample_config["devices"]})
    bad["devices"].append({"id": "lock", "zones": [bad["zones"][0]["id"]], "entity": "lock.front_door"})
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=bad)
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert "can't control" in r["error"]["message"]
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


async def test_a_malformed_message_is_refused(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config/save", revision="1", config={})
    assert not r["success"] and r["error"]["code"] == "invalid_format"


async def test_both_commands_are_for_admins_only(hass, loaded, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    for msg in (
        {"type": f"{DOMAIN}/config"},
        {"type": f"{DOMAIN}/config/save", "revision": 0, "config": {"zones": [], "devices": []}},
    ):
        r = await _send(client, **msg)
        assert not r["success"] and r["error"]["code"] == "unauthorized"


async def test_commands_say_so_when_the_integration_is_not_loaded(hass, loaded, hass_ws_client) -> None:
    assert await hass.config_entries.async_unload(loaded.entry_id)
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert not r["success"] and r["error"]["code"] == "not_loaded"


async def test_automation_links_and_the_room_setting_are_stored_and_read_back(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    links = [
        {"id": "a1", "entity": "automation.critical_garden_humidity_high_day", "group": "alert_day"},
        {"id": "a2", "entity": "automation.failsafe_garden_lights_recovery", "group": "failsafe"},
    ]
    room = {"alertRepeat": "input_number.alert_repeat_rate"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[0]["automations"] = links
    client = await hass_ws_client(hass)
    # A revision sent inside the setup is ignored: the store sets its own.
    cfg = {"zones": zones, "devices": sample_unlinked["devices"], "room": room, "revision": 99}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg)
    assert r["success"], r
    assert r["result"]["revision"] == 1
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert stored["zones"][0]["automations"] == links and stored["room"] == room and stored["revision"] == 1
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["zones"][0]["automations"] == links and r["result"]["room"] == room


async def test_a_link_to_anything_but_an_automation_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[0]["automations"] = [{"id": "a1", "entity": "switch.reservoir_pump", "group": "failsafe"}]
    client = await hass_ws_client(hass)
    r = await _send(
        client,
        type=f"{DOMAIN}/config/save",
        revision=0,
        config={"zones": zones, "devices": sample_unlinked["devices"]},
    )
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert "isn't an automation" in r["error"]["message"]
    assert DOMAIN not in hass_storage
    assert (await _send(client, type=f"{DOMAIN}/config"))["result"]["revision"] == 0


async def test_an_automation_linked_by_a_second_zone_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[1]["automations"] = [dict(link)]
    zones[2]["automations"] = [dict(link)]
    client = await hass_ws_client(hass)
    r = await _send(
        client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": zones, "devices": sample_unlinked["devices"]}
    )
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert r["error"]["message"] == "An automation can only be linked to one zone."
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


async def test_an_automation_moves_zone_in_two_saves(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    """Unlinked where it is in one save, then linked in the new zone in the next."""
    link = {"id": "a1", "entity": "automation.failsafe_veg_fans_auto_on", "group": "failsafe"}
    zones = copy.deepcopy(sample_unlinked["zones"])
    zones[1]["automations"] = [dict(link)]
    zones[2]["automations"] = []
    devices = sample_unlinked["devices"]
    client = await hass_ws_client(hass)
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    zones[2]["automations"] = [dict(link)]
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=1, config={"zones": zones, "devices": devices})
    assert not r["success"] and r["error"]["message"] == "An automation can only be linked to one zone."
    zones[1]["automations"] = []
    zones[2]["automations"] = []
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=1, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    zones[2]["automations"] = [dict(link)]
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=2, config={"zones": zones, "devices": devices}))[
        "success"
    ]
    await hass.async_block_till_done()
    stored = hass_storage[DOMAIN]["data"]
    assert stored["revision"] == 3
    assert [z.get("automations") for z in stored["zones"][1:]] == [[], [link]]
