"""The panel's backend commands, for admins only: read the setup, save it, and list what Home Assistant has."""

from __future__ import annotations

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .catalog import async_build_catalog
from .const import DOMAIN
from .history import HOURS, MAX_BUCKETS, MAX_ENTITIES, MIN_BUCKETS, async_history, mapped_readings
from .store import ConfigStore, RevisionConflict
from .validation import InvalidConfig

CONFLICT = "Setup was saved from somewhere else since this was opened. Reopen the panel to see it."


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register the commands."""
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_config_save)
    websocket_api.async_register_command(hass, ws_catalog)
    websocket_api.async_register_command(hass, ws_history)


def _store(hass: HomeAssistant) -> ConfigStore | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/config"})
@callback
def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Return the stored setup."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    connection.send_result(msg["id"], store.data)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/config/save",
        probatio.Required("revision"): int,
        probatio.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_config_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Store a new setup, if it's valid and based on the current revision."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    try:
        saved = await store.async_save(msg["revision"], msg["config"])
    except RevisionConflict:
        connection.send_error(msg["id"], "revision_conflict", CONFLICT)
    except InvalidConfig as err:
        connection.send_error(msg["id"], "invalid_config", str(err))
    else:
        connection.send_result(msg["id"], saved)


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/catalog"})
@websocket_api.async_response
async def ws_catalog(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """List the devices and entities setup can pick from, with how each device is connected."""
    if _store(hass) is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    connection.send_result(msg["id"], await async_build_catalog(hass))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/history",
        probatio.Required("entities"): list,
        probatio.Required("hours"): int,
        probatio.Required("buckets"): int,
    }
)
@websocket_api.async_response
async def ws_history(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Bucketed readings for a chart: only entities the setup maps as a sensor's readings, over a fixed range."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    entities, hours, buckets = msg["entities"], msg["hours"], msg["buckets"]
    if hours not in HOURS or not MIN_BUCKETS <= buckets <= MAX_BUCKETS:
        connection.send_error(msg["id"], "invalid_format", "That isn't a range this panel draws.")
        return
    mapped = mapped_readings(store.data)
    if not 0 < len(entities) <= MAX_ENTITIES or not all(isinstance(e, str) and e in mapped for e in entities):
        connection.send_error(msg["id"], "unauthorized", "History is only for the readings of a sensor in a zone.")
        return
    if "recorder" not in hass.config.components:
        connection.send_error(
            msg["id"], "no_recorder", "Home Assistant's recorder isn't running, so there's no history."
        )
        return
    connection.send_result(msg["id"], await async_history(hass, list(dict.fromkeys(entities)), hours, buckets))
