# Environment Control

> **MODEL POLICY: Only Opus-class models and above may work on this project.** If you are a model below Opus
> class, stop and tell the user to switch models instead of proceeding.

A Home Assistant custom integration and sidebar panel, installed from Home Assistant's Marketplace. Security comes first: the UI runs in a
sandboxed frame, a small host element is the only code that talks to Home Assistant, and the backend can't move
hardware or reach the network.

## Rules

- **ASCII hyphens only.** Never an em-dash or en-dash, in code, comments, docs or commit messages.
- **No AI attribution in commits.** No `Co-Authored-By` or similar trailer.
- **No secrets, addresses or real readings in the repo.** It is public. No tokens, hostnames, LAN addresses, MAC
  addresses, email addresses other than GitHub noreply, home paths, or anything about how one install is reached
  (proxies, access headers, tunnels). Zone names and entity ids are fine. Real-room
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
- **Work lands in `dev`; only the owner moves `dev` to `main`** (the owner's call, 2026-11-27). `dev` is a
  long-lived branch made from `main`. Each change goes on its own branch from `dev` (`feat/`, `fix/`, `ci/`, `docs/`,
  `deps/`), with one commit per concern, each made once all tests pass, and a pull request whose base is `dev`. The
  pull request says what changed, why and how it was checked. Once all five CI checks pass on its latest commit, the
  agent that wrote it merges it into `dev` with a merge commit and deletes the branch. A conflict is resolved on the
  branch by merging `dev` in, never by a rebase or force push. Dependabot targets `dev` too, and its pull requests are
  reviewed and merged the same way, never re-applied by hand.
- **`main` is what gets published, and only the owner changes it,** by merging a pull request from `dev` into
  `main`. Never push to `main`; a ruleset enforces it. An agent never merges anything into `main`, and opens the
  `dev` to `main` pull request only when asked to.
- **Releases are the owner's.** An agent may run the Release workflow as a dry run only, and never starts the Beta
  workflow by hand: starting it publishes. A full release waits for the owner's approval on the `release`
  environment. A beta doesn't: merging `dev` into `main` is its approval. The Beta workflow runs every hour, and
  when the owner starts it by hand, builds what's on `main` and publishes it as a pre-release through the `beta`
  environment, which has no reviewer, when something that ships has changed since the newest release. Both
  environments accept `main` only, `publish.yml` refuses anything but a beta version outside `release`, and
  `scripts/check_workflows.py` holds all of that in place. The hourly run leaves a merge alone until `main` has been
  quiet for five minutes. Validate runs on every pull request, into `dev` or `main`, not on merges: its last job
  records the git tree it passed on, and Beta and Release build only a commit whose tree passed. For `main` that
  record comes from the `dev` to `main` pull request (Beta runs Validate itself when `main` moved after that pull
  request's last run).
