# Environment Control

> **MODEL POLICY: Only Opus-class models and above may work on this project.** If you are a model below Opus
> class, stop and tell the user to switch models instead of proceeding.

A Home Assistant custom integration and sidebar panel, installed through HACS. Security comes first: the UI runs in a
sandboxed frame, a small host element is the only code that talks to Home Assistant, and the backend can't move
hardware or reach the network.

## Rules

- **ASCII hyphens only.** Never an em-dash or en-dash, in code, comments, docs or commit messages.
- **No AI attribution in commits.** No `Co-Authored-By` or similar trailer.
- **No secrets, addresses or real readings in the repo.** It is public. No tokens, hostnames, LAN addresses, MAC
  addresses, email addresses other than GitHub noreply, or home paths. Zone names and entity ids are fine. Real-room
  snapshots and anything built from them stay gitignored. `scripts/check_privacy.py` and gitleaks run in CI.
- **The backend never calls a service or sets a state,** never reads a config entry's `data` or `options`, and has
  no `requirements`. `scripts/check_backend_safety.py` enforces it.
- **The frame's sandbox is exactly `allow-scripts`.** Never add `allow-same-origin`: with `allow-scripts` it undoes
  the sandbox. The frame's CSP allows no network.
- **Only the host calls services,** and only for the write table in the plan. Each new write path raises
  `HOST_CALL_SERVICE_SITES` in `scripts/check_frontend_safety.py` in the same change as its tests.
- **The host ships exactly as written:** `frontend/src/host.js` is copied, never bundled or minified, so what was
  reviewed is what runs.
- **Dependencies:** runtime dependencies are Lit only for now. Pin exact versions, at least two weeks old. Install with
  `npm ci --ignore-scripts`. GitHub Actions are pinned to commit SHAs.
- **Changes reach `main` only through pull requests.** Never push to `main`; a ruleset enforces it. Each change goes
  on its own branch (`feat/`, `fix/`, `ci/`, `docs/`, `deps/`), with one commit per concern, each made once all tests
  pass. The pull request says what changed, why and how it was checked. All five CI checks must pass, and the owner
  merges. Dependabot's pull requests are reviewed and merged the same way, never re-applied by hand.
- **Releases are the owner's.** An agent may run the Release workflow as a dry run only. Publishing waits for the
  owner's approval on the `release` environment, which accepts runs from `main` only.
