# Debugging Runbook

How to inspect a live extension session, what to look for when things go
wrong, and how to use chrome-devtools-mcp for AI-driven debugging.

## chrome-devtools-mcp

The MCP server is configured in [`.claude/.mcp.json`](../.claude/.mcp.json) and
[`.vscode/mcp.json`](../.vscode/mcp.json). It launches via
`npx -y chrome-devtools-mcp@latest` and lets a Claude session drive a real
Chrome tab: navigate, click, read DOM, run code in either the page (MAIN)
or the extension's content-script (ISOLATED) world.

### When to reach for it

- Verifying a DOM selector still matches after a cor3.gg deploy
- Watching `cor3_logs` accumulate in real time while reproducing a flow
- Confirming auto-jobs reaches `solving` for a specific job type before
  rolling out a code change
- Inspecting `window.COR3.Registry` / `Bus` / module state without round-tripping
  through the popup UI

### Recommended workflow

1. Open `https://cor3.gg` in the MCP-controlled tab.
2. Wait for the WS connect (look for `[COR3] WS connected — scheduling initial data fetch` in console).
3. Run reads against `window.COR3.*` to check module state.
4. Trigger user actions (click toggles in popup, accept jobs, etc.).
5. Read `chrome.storage.local.cor3_logs` to see per-module activity.
6. Make a code change locally.
7. `chrome://extensions/` → reload → re-test the same scenario.

### Live state probes

Run any of these in the MCP browser console:

| Probe | World | What it tells you |
|---|---|---|
| `window.COR3.Registry.list().length` | isolated **or** MAIN | how many modules registered (expect ~26 isolated, ~14 MAIN; the `auto-jobs-bridge` and `desktop-window` IIFEs are not counted) |
| `window.COR3.Registry.snapshot()` | either | full list with `{id, category, dependsOn, started, enabled}` |
| `Object.keys(window.COR3.game ?? {})` | MAIN | should print `['loadout','desktop']` (the Auto Jobs game-core helpers) |
| `await chrome.storage.local.get('cor3_logs')` | isolated/popup | full per-module ring buffers |
| `await chrome.storage.local.get(['ajPipelineState','ajJobQueue','ajBuggedJobs'])` | isolated/popup | **Auto Jobs** runtime: `ajPipelineState.node` = the live flowchart node; `ajJobQueue.jobs[].status` = `AVAILABLE`/`TAKEN` |
| `window.COR3.Registry.get('auto-jobs')?.started` | isolated | whether the orchestrator loop is running |
| `Object.keys(window.COR3.autoJobs?.pipeline?.stages ?? {})` | isolated | the stage objects (getServers, checkAccess, updateMarkets, jobQueue, buggedJobs, checkCondition, jobAcception) |
| `await chrome.storage.sync.get(['autoJobsSettings','modules','autoSendMerc'])` | isolated/popup | user prefs + module state (Auto Jobs is `{enabled}`) |
| `window.__cor3WsInterceptorActive` | MAIN | confirms WS wrap is installed |
| `window.__cor3LastMarketId` | MAIN | last home market id seen by interceptor |
| `window.__cor3CachedMercIds` | MAIN | cached mercenary IDs for configure cascade |
| `window.__cor3Abort`, `window.__cor3FlowLock`, `window.__cor3SaiSession` | MAIN | Auto Jobs flow abort flag / cross-module busy guard / shared SAI batch session |

### Forcing actions from the console

```js
// Refresh markets
window.postMessage({ type: 'COR3_REFRESH_MARKET' }, '*');
window.postMessage({ type: 'COR3_REFRESH_DARK_MARKET' }, '*');

// Re-request the Network Map graph (interceptor replies COR3_NM_GRAPH,
// which the orchestrator persists to STORAGE_LOCAL.NM_GRAPH)
window.postMessage({ type: 'COR3_REQUEST_NM_MAP' }, '*');

// ── Auto Jobs ──
// Start / stop the loop (from isolated or popup console — the orchestrator
// reacts to the sync key; the runtime message makes it immediate on Firefox).
chrome.storage.sync.set({ autoJobsSettings: { enabled: true } });
chrome.runtime.sendMessage({ action: 'toggleAutoJobs', settings: { enabled: true } });
// Clear the bugged registry
chrome.storage.local.set({ ajBuggedJobs: {} });
```

### F12 dump helper

`window.__cor3Dump()` (defined by the WS interceptor) posts
`COR3_REQ_DUMP` to the isolated world. **There is currently no
isolated-world handler for this**. Either:

- Read storage directly with the probes above, or
- Add a handler to `auto-jobs.js` (single setTimeout dump of all in-memory state)

## Reading logs

Logger writes per-module ring buffers (200 entries each) to
`chrome.storage.local.cor3_logs`. The popup's **Logs** tab streams them
live with module + level filters.

From console:

```js
const { cor3_logs } = await chrome.storage.local.get('cor3_logs');
console.table(cor3_logs['auto-jobs'].slice(-20));
```

Group by level:

```js
Object.fromEntries(
    Object.entries((await chrome.storage.local.get('cor3_logs')).cor3_logs)
          .map(([id, entries]) => [id, entries.length])
);
```

## Common issues

### "cor3.gg tab freezes solid the moment the extension loads — F12 won't even open"

Failure mode worth documenting in case anything similar shows up again.

**Symptom:** with the extension enabled, the cor3.gg tab hangs at first
paint. DevTools (`F12` / Ctrl+Shift+I) never opens because the renderer
process is wedged in synchronous JS execution. Disabling the extension
restores the site immediately.

**Root cause:** `src/core/logger.js` registered its bus tracer
unconditionally. In MAIN world `Logger.push()` forwards every entry via
`Bus.window.post('COR3_LOG_REMOTE', …)`, and `Bus.window.post` calls the
trace function **synchronously** before posting. The trace handler called
`push('bus', DEBUG, …)` which posted again, fired the trace again, …
unbounded synchronous recursion. The first log line during boot was enough
to overflow the stack and freeze the tab so hard the browser couldn't
service the F12 keypress.

**Fix:** see `src/core/logger.js` — the `Bus.setTrace(...)` registration is
now gated on `HAS_STORAGE`, so MAIN never installs a tracer; an `inTrace`
re-entry guard and a `COR3_LOG_REMOTE` filter add belt-and-suspenders. See
[architecture.md → Bus tracer recursion](architecture.md#bus-tracer-recursion-resolved-may-2026)
for full detail.

**If the tab ever freezes like this again:**
1. Don't try to F12 the wedged tab — it will keep hanging. Open
   `chrome://extensions`, disable COR3 Helper, then refresh cor3.gg to
   confirm the extension is the cause.
2. Reproduce in chrome-devtools-mcp: `await page.goto('https://cor3.gg')`.
   The MCP browser doesn't load this extension, so the page itself works
   there — useful for isolating "extension vs site" questions.
3. Search for new sync `setTrace` / `subscribe(...)` callbacks in
   `src/core/*` that loop back into `Bus.window.post`. The same recursion
   shape can appear in any subscribe→post→subscribe chain.

### "Service worker keeps logging `Receiving end does not exist`"

Background SW pings the cor3.gg tab every 30 s with
`chrome.tabs.sendMessage({action:'keepWorkerAlive'})`. If the tab matches
the URL pattern but has no content script attached yet (page loading,
just-reloaded extension, navigation between pages), Chrome rejects with
"Receiving end does not exist". This is harmless and self-heals on the
next tick. `src/entry/background.js → isNoReceiverError()` filters this
specific message so it doesn't flood the SW's `cor3LogError` log; any
other exception still logs.

### "Auto Jobs parks on a JOB_FLOW and never moves on"

The orchestrator dispatches a TAKEN job via `MSG.AUTOJOBS.FLOW_START` and parks
on `FLOW_RESULT`. Likely causes:
1. Solver minigame DOM didn't appear. Check the relevant flow in
   `src/modules/game/flows/auto-jobs/<type>.js` and `cor3_logs['flow-<type>']`.
2. The flow never replied. After `AJ.LOOP.FLOW_TIMEOUT_MS` (5 min) the
   orchestrator gives up and writes the job to `AJ_BUGGED_JOBS`.

**Force-recover:** STOP from the popup (sends `FLOW_ABORT`), or from the console:
```js
chrome.storage.sync.set({ autoJobsSettings: { enabled: false } });
chrome.runtime.sendMessage({ action: 'toggleAutoJobs', settings: { enabled: false } });
chrome.storage.local.set({ ajBuggedJobs: {} });   // un-bug everything
```

### "Popup shows no data"

1. Confirm `chrome.storage.local.get('marketData')` returns something. If yes,
   the data layer is fine — UI bug.
2. If empty, check the WS interceptor:
   - `window.__cor3WsInterceptorActive` should be `true` in MAIN.
   - Console should show `[COR3] Tracking WebSocket: …`.
   - Post a manual refresh: `window.postMessage({type:'COR3_REFRESH_MARKET'}, '*')`.
3. If still empty, the server-side WS protocol may have changed. Inspect
   raw frames via DevTools → Network → WS tab → Messages.

### "Module Manager toggles do nothing for MAIN modules"

Known limitation. MAIN's Registry doesn't subscribe to
`chrome.storage.sync.modules`. Plan to fix:
1. In `src/entry/content.js` add a `Settings.onChange` listener that
   broadcasts `Bus.window.post('COR3_MODULE_STATE_CHANGE', {id, state})`.
2. In `src/entry/content-early.js` add a corresponding `Bus.window.on`
   listener that calls `Registry.setModuleState(id, state)`.

For now, reload the page after toggling — MAIN modules respect the
settings on cold boot.

### "K/D detected on a server that's actually accessible"

Check `network-map.js → checkServerKD()`. The current heuristic:

```
hasKD = MaintenanceTimer exists AND MaintenanceTimer contains TimerIcon SVG
```

Plain text-only `MaintenanceTimer` (no icon child) is a *cooldown*, not
K/D — server is still reachable. If the heuristic mis-classifies, the
DOM has changed. Re-verify the SVG component name in the live DOM.

### "Auto-send merc launches with the wrong merc"

Sort key in `auto-send-merc.js` is `(totalCost, riskScore)`. If a cheaper
but riskier merc is being picked, the user wants the threshold to weight
risk more — but `auto-send-merc` doesn't have a threshold, only `auto-choose-decision`
does. Either:

- The user pinned a specific `mercenaryId` (overrides auto-choose). Check
  `chrome.storage.sync.autoSendMerc.mercenaryId`.
- The merc list / config data is stale. Force refresh:
  `window.postMessage({type:'COR3_REQUEST_MERCENARIES'}, '*')`.

### "Daily ops never updates"

Daily ops fetches from `https://svc-corie.cor3.gg/api/user-daily-claim`
using the captured bearer token. Possible failures:

1. Bearer not yet captured — `chrome.storage.local.get('bearerToken')` empty.
2. Token expired (400/401/403) — `dailyOpsError = 'token_expired'`.
3. Service unreachable — silent. Check Network tab.

Manually trigger:
```js
window.postMessage({ type: 'COR3_FETCH_DAILY_OPS' }, '*');
```

The card reads `daily.currentStreak` (the field name returned by the
server). If you see "streak 0" but the in-game streak is non-zero, the
build is reading the wrong key (`daily.streak`).

### "Solve button does nothing / hangs / submits but no reward"

The Solve button on the Daily Ops Overview card sends `solveDailyOps` →
isolated `automation/daily-ops.js` → `Bus.window.post(MSG.SOLVER.START_DAILY_OPS)`
→ MAIN `solver-daily-ops`. To watch each step live, filter the cor3.gg
DevTools console by `[solver-daily-ops]` (Logger module id) and look in
`STORAGE_LOCAL.DAILY_HACK_LOG` for the user-facing trail. Common symptoms:

- **Nothing happens after click** — the runtime message didn't reach
  isolated. Reload the cor3.gg tab; the popup may have been opened before
  the content script booted.
- **`Game Center tab not found`** — the dock-tab heuristic
  (`KNOWN_TAB_NAMES` exclusion) failed. Run in DevTools:
  ```js
  document.querySelectorAll('[data-component-name^="TabBarItem-"]')
      .forEach(it => console.log(it.dataset.componentName));
  ```
  If Game Center has a clean name (not a UUID), update `KNOWN_TAB_NAMES`
  in `src/modules/solvers/daily-ops.js`.
- **`Daily Ops card not found`** — the card description heuristic
  (`/\bdaily\b/i`) failed. The card description is English brand text
  ("Daily objective terminal …") and changes very rarely.
- **`waiting for connection (Start)…` followed by `connection still down`** —
  socket.io is mid-reconnect. The site itself has a flap on noisy networks
  (status bar shows "СОЕДИНЕНИЕ РАЗОРВАНО" / "ПОВТОРИТЬ"). The solver
  waits up to 8 s, then proceeds best-effort. If the puzzle window opens
  but the click doesn't register server-side, retry from a stable session.
- **`no server feedback (WS hiccup?)`** — submit clicked, but
  `awaitSubmitFeedback()` saw neither success nor failure text within 5 s.
  Likely WS dropped between Submit and ack. Refresh and retry; the puzzle
  state is server-authoritative.
- **Wrong encoding picked (signal puzzles)** — `chooseEncoding()` falls
  back to binary on a tie when no `.input-hint` is present. Check
  `console.debug` for `pre-encoding analysis: …`. If both Morse and
  Binary decode validly without a hint, it's ambiguous; the heuristic is
  documented in the function body.
- **Log puzzle: `no error-type-button for: <issue>`** — neither the
  English `ERROR_LABELS` text match nor the `ISSUE_BUTTON_INDEX`
  position fallback found a button for the given issue. The position
  fallback assumes 6 buttons in TIME / TYPE / MISSING_SECTOR /
  MISSING_STATUS / SECTOR_BAD / STATUS_BAD order — verify in DevTools
  that today's puzzle still renders all 6 buttons in that order, and
  update the index map if not.
- **Log puzzle: Confirm Selection stays disabled, "Selected: 1 / 2"** —
  the analyzer ran before all `.log-entry` rows finished animating in
  (`.log-entry-appearing` class). `waitForLogScanComplete()` should
  guard this; if it fired too early, increase the timeout there.

WS readiness probes (exposed by ws-interceptor) are usable from the F12
console for diagnosis:

```js
__cor3IsWsReady()              // boolean
await __cor3WaitForWs(8000)    // resolves true when active socket is OPEN
```

### "Logger entries from MAIN-world modules don't appear in popup"

The cross-world bridge is in `src/entry/content.js`:
```js
Bus.window.on('COR3_LOG_REMOTE', (env) => {
    Logger.ingest(env.moduleId, env.entry);
});
```

If MAIN's logs aren't ingested, possibilities:
1. `entry/content.js` didn't boot (check isolated console for
   `[COR3.Registry] boot done` info log).
2. `Bus.window.on` subscriber list is empty in isolated world (the
   listener was registered before `Bus` was loaded — load order issue).

## Reload checklist

After any code change:

1. `find src -name '*.js' -exec node --check {} \;` — syntax check.
2. `chrome://extensions/` → click reload icon on COR3 Helper. Watch the
   "errors" badge for parse errors.
3. Refresh the cor3.gg tab to re-install content scripts.
4. Open popup; if first-time after a reload, expect a 1–2 s settle while
   `Registry.boot()` runs.

## Smoke test (full path)

1. Open cor3.gg, log in, wait for "WS connected".
2. Expect popup Overview tab to show daily ops timer + market timers within
   ~10 s (initial-fetch cascade is staggered by 1–6 s).
3. Open Auto Jobs tab → toggle ON (requires the decrypt/ICE-WALL solvers ON in
   Overview, else START is blocked).
4. Watch the Flow Map highlight step through the pipeline nodes
   (`GET_SERVERS → CHECK_ACCESS → UPDATE_MARKETS → JOB_QUEUE → …`); the Job List
   fills from `AJ_JOB_QUEUE`.
5. If a qualifying AVAILABLE job is on the board, expect (within a minute):
   - `cor3_logs['auto-jobs']` shows the cycle + `JOB_ACCEPTION · take …` lines.
   - The job reappears `TAKEN` next cycle and JOB_FLOW dispatches it
     (`cor3_logs['flow-<type>']`).
6. On success the flow sends `job.complete`; the job leaves the board.

## Disabling features without code changes

| Behavior | How |
|---|---|
| Disable Auto Jobs entirely | Auto Jobs tab → Stop |
| Skip a market / job type globally | Auto Jobs tab → Master Switches panel (writes `STORAGE_LOCAL.ajMasterSwitches`) |
| Skip a server / a type on one server | Network Map context menu (writes `STORAGE_LOCAL.ajServerOverrides`) |
| Permanently bug a job | `chrome.storage.local.get('ajBuggedJobs').then(o => chrome.storage.local.set({ ajBuggedJobs: { ...o.ajBuggedJobs, '<id>': { reason: 'manual', since: Date.now() } } }))` |
| Stop alarms | Overview tab → Add alarm card → Stop all |
