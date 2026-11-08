# Environment Control

A Home Assistant panel for grow-room climate and lights: live readings against your targets, the
placement of every sensor and device in each zone, and, in later releases, the controls, thresholds
and schedules that today live across several dashboards.

**Status: early development.** This release adds an empty, admin-only panel. It proves the install,
the update path and the sandbox, and it can't move any hardware.

## Built for security first

- **The UI runs in a sandboxed frame** with its own origin and no network. It can't read your login,
  HA's page or your browser's storage, and it can't send anything anywhere.
- **Only a small host element talks to Home Assistant,** and it accepts a fixed list of messages
  from the UI. This release makes no service calls at all.
- **The backend can't move hardware or reach the network:** no service calls, no state writes, no
  external packages, checked on every change.
- **Admins only,** for the panel and for every command it uses.
- **Releases are built by CI from a tagged commit.** HACS installs the built zip, never the default
  branch.

## Install

Through [HACS](https://hacs.xyz), once the repository is public: add it as a custom repository of
type Integration, install Environment Control, restart Home Assistant, then add the integration
under Settings, Devices and services. The panel appears in the sidebar for admins.

Requires Home Assistant 2026.10 or later.

## Development

```sh
# Backend: Python 3.14
python -m venv .venv && .venv/bin/pip install -r requirements_test.txt
.venv/bin/python -m pytest -q && .venv/bin/ruff check custom_components tests scripts

# Frontend
cd frontend && npm ci --ignore-scripts
npm run typecheck && npm test && npm run build && npm run e2e

# Safety and privacy checks
python3 scripts/check_backend_safety.py && python3 scripts/check_frontend_safety.py && python3 scripts/check_privacy.py
```

The design mock and its browser suite live in [`design/`](design/README.md).

## License

Copyright (C) 2026 Er3Bu5. Licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
