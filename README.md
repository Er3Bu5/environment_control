# Environment Control

A Home Assistant panel for grow-room climate and lights: live readings against your targets, the
placement of every sensor and device in each zone, and, in later releases, the controls, thresholds
and schedules that today live across several dashboards.

**Status: early development, in betas.** Zones are set up in the panel: their sensors and devices, layout and
placement, leaf temperature offsets, and their day and night times and limits, with live readings and history
judged against them. It changes two things in Home Assistant so far, each only after you review and apply: a
sensor's leaf temperature offset on its own board, and the helpers you link a zone's times and limits to.

## Built for security first

- **The UI runs in a sandboxed frame** with its own origin and no network. It can't read your login,
  HA's page or your browser's storage, and it can't send anything anywhere.
- **Only a small host element talks to Home Assistant,** and it accepts a fixed list of messages
  from the UI. It makes two kinds of service call so far, and the UI never names an entity for either. A
  leaf temperature offset: the UI names a sensor and a value, and the host checks the number is in °C on
  that sensor's own device and inside its own limits. A zone's time or limit: the UI names the zone and
  the setting, and the host writes the helper that zone links to it, a link you approved in a dialog the
  host draws itself, inside the helper's own limits.
- **The backend can't move hardware or reach the network:** no service calls, no state writes, no
  external packages, checked on every change.
- **Admins only,** for the panel and for every command it uses.
- **Releases are built by CI from a tagged commit** and carry a build attestation. Home Assistant
  installs that zip, never the default branch.

## Install

From Home Assistant's Marketplace (2026.11 and later), which needs a GitHub connection for a
repository added by link:

1. Go to Settings, Marketplace, select **Add from link**, and enter `Er3Bu5/environment_control`.
2. While every release is a beta, open the three-dot menu on its page and select **Include pre-releases**.
   Otherwise the Marketplace offers the latest commit, which doesn't contain the built panel.
3. Select **Install**. The Marketplace downloads the release zip and opens the setup step.

The panel appears in the sidebar for admins. Updates are offered in the Marketplace and need a
restart, which a repair notice offers to do.

Requires Home Assistant 2026.10 or later. On 2026.10, which predates the Marketplace, add the
repository to HACS as a custom repository of type Integration instead.

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
python3 scripts/check_marketplace.py && .venv/bin/python scripts/check_workflows.py
```

The design mock and its browser suite live in [`design/`](design/README.md).

## License

Copyright (C) 2026 Er3Bu5. Licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
