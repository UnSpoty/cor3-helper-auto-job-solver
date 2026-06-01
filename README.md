# COR3 Helper

Chrome MV3 / Firefox extension that augments [cor3.gg](https://cor3.gg) with
markets, expeditions, alarms, minigame solvers and a full auto-jobs pipeline.

**Compatibility:** cor3.gg `v1.19.43` and newer. Communicates with the game
over the site's Socket.IO connection using its MessagePack-encoded binary
wire format.

## Features

### Live game data
- **Markets** — Home, Dark (D4RK) and SRM markets with job lists, reset timers
  and reachability flags.
- **Expeditions** — active expedition tracker, container-open + collect-all
  workflow, archived-runs history with loot / cost / risk per run.
- **Pending decisions** — option list per expedition with risk score, deadline
  countdown, and the bundle's own riskScore for context.
- **Stash** — capacity bar and item list.
- **Mercs** — roster with cost / risk badges and per-merc Auto-send toggles.
- **Network Map** — BFS-depth-tagged server graph (used by the auto-jobs
  planner to prioritise leaves and avoid breaking hubs).
- **Daily Ops** — countdown to next reset, streak/level info.

### Automation
- **Auto Jobs** — end-to-end orchestrator that scans Home / Dark / SRM
  markets, qualifies jobs against per-server reachability and K/D state,
  accepts them in batches, opens the Network Map, connects through the right
  server, navigates SAI, and runs the matching flow:
  - 9 job types: `file_decryption`, `ip_injection`, `ip_cleanup`,
    `file_upload`, `log_deletion`, `log_download`, `file_elimination`,
    `data_download`, `decrypt_extract`
  - K/D detection (skipped for the timer's duration + safety buffer),
    server-unreachable detection, per-server priority sort, transitive
    blocking via `ajServerReadiness`, per-cycle reject list with reasons
    surfaced in the popup.
- **Auto-send mercenary** — when an expedition completes, opens the container,
  collects rewards, then re-launches with the cheapest available mercenary
  (configurable per merc, re-enabled when stash recovers from full).
- **Auto-choose decision** — picks the highest-scoring decision option a
  configurable amount of time before the deadline; single `Risk threshold`
  slider (0..10) drives the cut-off.
- **Auto-refresh markets** — periodic re-fetch of Home / Dark / SRM jobs.
- **Multi-alarm** — alarms tick every second, audio alerts via the Web Audio
  API; threshold, volume and continuous-mode are per-alarm.

### Minigame solvers
- **Decrypt** — solves the config-hack minimax minigame (arrow-key + click
  submit layer).
- **Ice Wall** — solves SAI's Porter-lite r4 break minigame: parses cells in
  grid coords, runs positive / elimination matching against the target
  preview, commits when a unique candidate survives, retries on missed
  clicks with an exclude-set. Adaptive partial-match thresholds support
  arbitrary target shapes.
- **Daily Ops** — full Game Center one-shot: opens the Game Center,
  starts the Daily Ops card, routes by puzzle type (System Log Integrity,
  Signal Hack), submits, watches for verified / reward / fail feedback.

### Appearance toggles
- Hide system messages, disable background animations, hide Network Map fog,
  disable map FX.

### UI
- **Module Manager** — every feature is a registered Module with a master
  switch and per-module log toggle, grouped by category.
- **Live log viewer** — every module's logs (200-entry ring buffer per
  module) streamed in the popup with module + level filters.
- **Pop-out window mode** — open the popup as a standalone window
  (`?mode=popout`).

## Install

1. `git clone https://github.com/UnSpoty/cor3-helper-auto-job-solver.git`
   (or download ZIP and extract).
2. `chrome://extensions/` → enable Developer Mode → **Load unpacked** →
   select the project folder.
3. Open [cor3.gg](https://cor3.gg) and log in. The WS interceptor installs
   at `document_start`; data starts arriving once the site's socket
   completes its handshake.
4. Open the popup or pin the side panel.

## Usage

| Tab | What's there |
|---|---|
| **Overview** | Daily ops timer, Home + Dark + SRM market resets, active expedition, pending decisions |
| **Stash** | Capacity bar, item list |
| **Mercs** | Roster with cost / risk badges, Auto-send toggles |
| **Auto Jobs** | Master toggle, current state pill, queue, rejected jobs with reasons, source filters (Home / Dark / SRM), debug mode, state-transition timeline, activity log |
| **Alarms** | Existing alarms + form to add a new one |
| **Modules** | Every registered module with on/off + log toggle, grouped by category |
| **Logs** | Live stream from all modules with module + level filters |
| **Settings** | Auto-refresh markets, auto-decrypt, auto-ice-wall, auto-daily-ops, auto-choose decision + risk threshold, appearance toggles |

## Project layout

```
cor3-helper/
├── manifest.json
├── README.md
├── CLAUDE.md              ← architecture cheat-sheet for AI assistants
├── docs/
│   ├── architecture.md    ← boot order, world topology, module lifecycle
│   ├── messaging.md       ← MSG / STORAGE / FLOW enums with payload shapes
│   ├── pipelines.md       ← auto-jobs / auto-send-merc / daily-ops flows
│   ├── debugging.md       ← chrome-devtools-mcp runbook + common issues
│   ├── glossary.md        ← K/D, SAI, Network Map terminology + DOM selectors
│   └── module-spec.md     ← Module contract + how to add a new one
└── src/
    ├── core/              ← Bus, Store, Logger, Module, Registry, Settings
    ├── shared/            ← constants, dom helpers, ws-frames (msgpack codec), errors
    ├── interceptors/      ← MAIN-world WS + HTTP wrapping; solver-loader
    ├── modules/
    │   ├── data/          ← 9 modules, one per WS payload
    │   ├── automation/    ← timers, auto-refresh, auto-jobs, auto-send-merc, …
    │   ├── game/          ← desktop-window, auto-jobs-bridge, loadout-panel, 9 Auto Jobs flows
    │   ├── solvers/       ← decrypt, daily-ops, ice-wall
    │   └── appearance/    ← system-messages, background, network-fog, map-fx
    ├── ui/                ← popup.html + popup.css + components/ + sections/
    └── entry/             ← content-early.js, content.js, background.js
```

~70 modules across 5 execution contexts (MAIN content, isolated content,
popup / side-panel, background SW, ad-hoc injected scripts).

## Development

No build step. Vanilla JavaScript. The manifest's `content_scripts.js`
arrays load files in dependency order; modules register themselves on the
global `window.COR3.*` namespace.

**Reload after changes:** `chrome://extensions/` → reload extension →
refresh the cor3.gg tab.

**Project-wide syntax check:**
```bash
find src -name '*.js' -exec node --check {} \;
```

**Adding a new module:** see [`docs/module-spec.md`](docs/module-spec.md).
Pattern is one IIFE per file that registers with
`COR3.Registry.register(new MyModule())` and declares `dependsOn` for
topo-sorted start-up. Every new MSG type or storage key goes into
[`src/shared/constants.js`](src/shared/constants.js) first — never inline
strings in module code.

**Debugging in the live site:** see
[`docs/debugging.md`](docs/debugging.md) for the chrome-devtools-mcp
runbook, the F12 state-probe one-liners, and the smoke-test script.

## Browser support

- **Chrome / Edge / Brave** (Chromium, MV3 service worker) — primary target.
- **Firefox 128+** — supported via `browser_specific_settings.gecko`.
  Background scripts loaded as classic `scripts: [...]` when the
  service-worker pref is off; `importScripts` is guarded.

## License

MIT — see [`LICENSE`](LICENSE).
