"""The panel's setup, kept in HA's own storage.

Writes are atomic, so a power cut mid-save leaves the previous setup whole. Every save carries the revision it was based
on, and a save from a stale copy is refused rather than merged, so one open panel can't silently undo another's change.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION
from .validation import validate_config


class RevisionConflict(Exception):
    """The save was based on a setup that has since changed."""


class ConfigStore:
    """Holds the setup in memory and on disk."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY, atomic_writes=True)
        self.data: dict[str, Any] = {"revision": 0, "zones": [], "devices": []}

    async def async_load(self) -> None:
        """Read what's stored. A first install has nothing, and starts with no zones."""
        stored = await self._store.async_load()
        if stored is not None:
            self.data = stored

    async def async_save(self, revision: int, config: dict[str, Any]) -> dict[str, Any]:
        """Check the setup and its revision, then write it with the revision moved on."""
        if revision != self.data["revision"]:
            raise RevisionConflict
        validate_config(config)
        nxt = {**config, "revision": self.data["revision"] + 1}
        await self._store.async_save(nxt)
        self.data = nxt
        return nxt
