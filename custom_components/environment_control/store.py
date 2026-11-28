"""The panel's setup, kept in HA's own storage.

Writes are atomic, so a power cut mid-save leaves the previous setup whole. Every save carries the revision it was based
on, and a save from a stale copy is refused rather than merged, so one open panel can't silently undo another's change.
"""

from __future__ import annotations

import asyncio
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import CHANGES_STORAGE_KEY, STORAGE_KEY, STORAGE_VERSION
from .leaf_links import check_leaf_links
from .limits import record_changes
from .validation import unlink_removed_parents, validate_config


class RevisionConflict(Exception):
    """The save was based on a setup that has since changed."""


class ConfigStore:
    """Holds the setup in memory and on disk."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY, atomic_writes=True)
        self.data: dict[str, Any] = {"revision": 0, "zones": [], "devices": []}
        self._changes: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, CHANGES_STORAGE_KEY, atomic_writes=True)
        self.changes: dict[str, Any] = {"since": {}, "entries": []}
        self.started = dt_util.utcnow().timestamp()
        # The write to disk yields, and self.data moves on only after it, so without this a second save at the same
        # revision could pass the check and be judged against the setup the first save replaces, losing the first.
        self._saving = asyncio.Lock()

    async def async_load(self) -> None:
        """Read what's stored. A first install has nothing, and starts with no zones."""
        stored = await self._store.async_load()
        if stored is not None:
            self.data = stored
        # A setup saved before the log existed has none; its zones are known from now, when this code started.
        self.started = dt_util.utcnow().timestamp()
        changes = await self._changes.async_load()
        if isinstance(changes, dict):
            self.changes = changes

    async def async_save(self, revision: int, config: dict[str, Any]) -> dict[str, Any]:
        """Check the setup and its revision, then write it with the revision moved on."""
        async with self._saving:
            if revision != self.data["revision"]:
                raise RevisionConflict
            config = unlink_removed_parents(self.data, config)
            validate_config(config, self.data)
            # A new offset link decides what a calibration can write, so it is checked against HA's registry too.
            check_leaf_links(self._hass, self.data, config)
            nxt = {**config, "revision": self.data["revision"] + 1}
            changes = record_changes(self.changes, self.data, nxt, dt_util.utcnow().timestamp(), self.started)
            await self._store.async_save(nxt)
            self.data = nxt
            # Written after the setup, so a crash between the two loses a change from the log rather than logging
            # one that was never saved.
            if changes != self.changes:
                await self._changes.async_save(changes)
                self.changes = changes
            return nxt

    def zone_changes(self, zone_id: str) -> tuple[list[dict[str, Any]], float]:
        """One zone's logged changes, oldest first, and the moment from which the log has all of them."""
        entries = [e for e in self.changes.get("entries") or [] if e.get("zone") == zone_id]
        return entries, (self.changes.get("since") or {}).get(zone_id, self.started)
