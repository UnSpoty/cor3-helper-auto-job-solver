# COR3 Helper

Chrome MV3 / Firefox extension that augments [cor3.gg](https://cor3.gg) with
markets, expeditions, alarms, minigame solvers and a full auto-jobs pipeline.

**Compatibility:** cor3.gg `v1.19.43` and newer (tested against `v1.20.35`).
Communicates with the game over the site's Socket.IO connection using its
MessagePack-encoded binary wire format.

## Features

### Live game data
- **Markets** — Home, Dark (D4RK), SRM (SOYUZ) and USOL markets with job lists,
  reset timers and reachability flags.
- **Expeditions** — active expedition tracker, container-open + collect-all
  workflow, archived-runs history with loot / cost / risk per run.
- **Markets & mercenaries** — one block per faction market (Home / Dark / SRM /
  USOL) with faction reputation, mercenary trust + score breakdown, hire slots,
  regular merc cards and elite-merc cards with unlock progress.
- **Pending decisions** — option list per expedition with risk score, deadline
  countdown, and the bundle's own riskScore for context.
- **Stash** — capacity bar and item list.
- **Mercs** — per-market rosters with cost / risk badges and per-merc Auto-send
  toggles; fetched for every faction market (each works by market id without
  connecting to the server).
- **Network Map** — BFS-depth-tagged server graph (used by the auto-jobs
  planner to prioritise leaves and avoid breaking hubs).
- **Daily Ops** — countdown to next reset, streak/level info.

### Automation
- **Auto Jobs** — end-to-end orchestrator that scans Home / Dark / SRM / USOL
  markets, qualifies jobs against per-server reachability and K/D state,
  accepts and works them **sequentially, one server at a time** (connect +
  log into a server once, run its whole batch, then move on), all over WS:
  - 9 job types: `file_decryption`, `ip_injection`, `ip_cleanup`,
    `data_upload`, `log_deletion`, `log_download`, `file_elimination`,
    `data_download`, `decrypt_extract`
  - K/D / on-cooldown and unreachable servers are read from the Network Map
    graph and **postponed** (never failed); FAILED jobs are surfaced in the
    Job List with an opt-in auto-dismiss; every job's skip reason is shown
    live in the popup.
  - **Decrypt-power aware** — for `file_decryption` / `decrypt_extract` it reads
    the job's required CRYPT RATE, then installs / swaps owned software (and,
    if still short, the best owned hardware per slot) to clear that power bar
    before opening the file; a job whose required power can't be reached with
    any owned gear is bugged as `underpower` instead of being attempted.
- **Auto-send mercenary** — when an expedition completes, opens the container,
  collects rewards, then re-launches with the cheapest available mercenary
  (configurable per merc, re-enabled when stash recovers from full).
- **Auto-choose decision** — picks the highest-scoring decision option a
  configurable amount of time before the deadline; single `Risk threshold`
  slider (0..10) drives the cut-off.
- **Auto-refresh markets** — periodic re-fetch of Home / Dark / SRM / USOL jobs.
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
  An optional **Auto** toggle auto-launches this solver when the daily timer
  resets or the day is still unsolved.

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
- **Loadout panel** — a pill embedded next to cor3.gg's own Notifications
  widget that pops a panel of equipped / owned hardware + software with live
  resource-usage bars. Each software card shows its capability as
  *TYPE · power · targets*, and every capability target (a file extension for
  DECRYPT, a server type for HACK / SEARCH) is **clickable** — it opens a
  chooser listing every owned program that covers that target (callsign / tier /
  power band) so you can equip / unequip in one click.

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

The popup has **5 tabs** (see `TABS` in `src/ui/shell.js`):

| Tab | What's there |
|---|---|
| **Overview** | Daily Ops timer (+ Solve + Auto), Home / Dark / SRM / USOL market resets with per-market auto-refresh, auto-solver toggles (decrypt / ICE WALL / simple-decrypt), theme picker + appearance toggles, alarms (add + Test/Stop-all) |
| **Expeditions** | Active expeditions, recent runs (archived), pending decisions, auto-choose decision + risk threshold, auto-send mercenary, per-market Markets & mercenaries (faction reputation + trust + regular/elite mercs + hire slots), stash |
| **Auto Jobs** | START/STOP, Master Switches panel (per-market + per-type + behaviour), Network Map (context menu: Open SAI / Open Market / per-server skips), grouped Job List (Locate + Details + bugged/skip pills), compact pipeline status, activity log |
| **Modules** | Every registered module with on/off + log toggle, grouped by category |
| **Logs** | Live stream from all modules with module + level filters |

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
    │   ├── data/          ← 13 modules, one per WS payload
    │   ├── automation/    ← timers, auto-refresh, auto-jobs (+ auto-jobs/pipeline), auto-send-merc, …
    │   ├── game/          ← desktop-window, auto-jobs-bridge, loadout-panel, 9 Auto Jobs flows (+ _sai-flow base)
    │   ├── solvers/       ← decrypt, daily-ops, ice-wall, simple-decrypt
    │   └── appearance/    ← system-messages, background, network-fog, map-fx
    ├── ui/                ← popup.html + popup.css + shell.js + components/ + sections/
    └── entry/             ← content-early.js, content.js, background.js
```

~85 files across 5 execution contexts (MAIN content, isolated content,
popup / side-panel, background SW).

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
