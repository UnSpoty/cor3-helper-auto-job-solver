# COR3 Helper

A Chrome / Firefox extension (Manifest V3) that augments [cor3.gg](https://cor3.gg) with timers, market info, decision auto-pick, mercenary auto-send, and a full auto-jobs solver pipeline.

> **Heads up:** the project was rewritten in May 2026 from a 5-file monolith into a ~70-file modular architecture. If you have local clones from before, expect almost everything to have moved. See [`docs/architecture.md`](docs/architecture.md).

## Features

- **Markets** — live timers + job lists for Home Market and D4RK Market
- **Daily Ops** — countdown to next reset, streak info
- **Expeditions** — active expedition tracking + pending decision UI
- **Auto-choose decision** — picks the highest-scoring option < 60 s before deadline, single tunable `Risk threshold` slider
- **Auto-send mercenary** — when an expedition completes, opens container → collects rewards → optionally re-launches with the cheapest available mercenary
- **Auto-Jobs** — full pipeline that scans both markets, accepts qualifying jobs, opens the Network Map, connects through the right server, navigates SAI, and runs the corresponding flow:
  - 9 job types: file decryption, IP injection, IP cleanup, file upload, log deletion, log download, file elimination, data download, decrypt&extract
  - K/D server detection (skips for the timer's duration), server-unreachable detection, bugged-job blacklist (2 h TTL), per-server priority sort
- **Auto-decrypt** — solves the config-hack minigame whenever it appears
- **Auto daily-hack** — solves System Log Integrity puzzles, decodes Signal Hack pulses
- **Multi-alarm** — audio alerts on any timer (daily, market reset, expedition ETA) with configurable threshold + volume + continuous mode
- **Game-appearance toggles** — hide system messages, kill background animations, hide Network Map fog, disable map FX
- **Module Manager UI** — every feature is a registered Module with master switch + per-module log toggle
- **Live log viewer** — every module's logs (200-entry ring buffer) streamed in the popup with module + level filters

## Install

1. `git clone https://github.com/Femtoce11/cor3-helper.git` (or download ZIP, extract)
2. `chrome://extensions/` → enable Developer Mode → **Load unpacked** → select the project folder.
3. Open [cor3.gg](https://cor3.gg) and log in. The extension auto-installs the WS interceptor at `document_start`.
4. Open the popup or pin the side panel.

## Usage

| Tab | What's there |
|---|---|
| **Overview** | Daily ops timer, both market resets, active expedition, pending decisions |
| **Stash** | Capacity bar, item list |
| **Mercs** | Roster with cost/risk badges, Auto-send toggles |
| **Auto-Jobs** | Master toggle, current state, queue, bugged jobs, source filters (Home/Dark), debug mode, activity log |
| **Alarms** | Existing alarms + form to add a new one |
| **Modules** | Every registered module with on/off + log toggle, grouped by category |
| **Logs** | Live stream from all modules with module + level filters |
| **Settings** | Auto-refresh markets, auto-decrypt, auto-daily-hack, auto-choose decision + risk threshold, appearance toggles |

## Project layout

```
cor3-helper/
├── manifest.json
├── CLAUDE.md           ← architecture cheat-sheet for AI assistants
├── README.md
├── docs/
│   ├── architecture.md     ← boot order, world topology, module lifecycle
│   ├── messaging.md        ← all MSG / STORAGE / FLOW enums with payload shapes
│   ├── pipelines.md        ← flow diagrams: auto-jobs / auto-send-merc / daily-ops
│   ├── debugging.md        ← chrome-devtools-mcp runbook + common issues
│   ├── glossary.md         ← K/D, SAI, Network Map terminology
│   └── module-spec.md      ← Module contract + how to add a new one
├── plans/
│   └── todo.md             ← cross-session todo / next-session priorities
└── src/
    ├── core/               ← Bus, Store, Logger, Module, Registry, Settings
    ├── shared/             ← constants, dom helpers, ws-frames, errors
    ├── interceptors/       ← MAIN-world WS + HTTP wrapping; solver-loader
    ├── modules/
    │   ├── data/           ← 9 modules, one per WS payload
    │   ├── automation/     ← timers, auto-refresh, auto-jobs, auto-send-merc, etc.
    │   ├── game/           ← network-map, server-connect, sai-navigator, 9 flows
    │   ├── solvers/        ← decrypt minigame, daily hack
    │   └── appearance/     ← system-messages, background, network-fog, map-fx
    ├── ui/                 ← popup.html + popup.css + components/ + sections/
    └── entry/              ← content-early.js, content.js, background.js
```

Total: ~70 modules across 6 execution contexts (MAIN content, isolated content, popup, side-panel, background SW, plus ad-hoc injected scripts).

## Development

No build step. Vanilla JavaScript. Manifest's `content_scripts.js` array loads files in dependency order; modules register on the global `window.COR3.*` namespace.

**Reload after changes:** `chrome://extensions/` → reload → re-open popup.

**Syntax check (project-wide):**
```bash
find src -name '*.js' -exec node --check {} \;
```

**Adding a new module:** see [`docs/module-spec.md`](docs/module-spec.md). Pattern is one IIFE per file, registers itself with `COR3.Registry.register(new MyModule())`, declares `dependsOn` for topo-sorted start-up.

## Browser support

- **Chrome / Edge / Brave** (Chromium-based, MV3 service worker) — primary target.
- **Firefox 128+** — supported via `browser_specific_settings.gecko`. Background scripts loaded as classic `scripts: [...]` when service-worker pref is off; `importScripts` is guarded.

## License

MIT
