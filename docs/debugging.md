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
| `window.COR3.Registry.list().length` | isolated **or** MAIN | how many modules registered (expect ~25 isolated, ~16 MAIN) |
| `window.COR3.Registry.snapshot()` | either | full list with `{id, category, dependsOn, started, enabled}` |
| `window.COR3.Registry.get('auto-jobs')?.started` | isolated | whether auto-jobs is currently active |
| `Object.keys(window.COR3.game ?? {})` | MAIN | should print `['networkMap','serverConnect','sai','flows']` |
| `await chrome.storage.local.get('cor3_logs')` | isolated/popup | full per-module ring buffers |
| `await chrome.storage.local.get(['autoJobsState','autoJobsQueue','buggedJobIds'])` | isolated/popup | auto-jobs runtime |
| `await chrome.storage.sync.get(['autoJobsSettings','modules','autoSendMerc'])` | isolated/popup | user prefs + module state |
| `window.__cor3WsInterceptorActive` | MAIN | confirms WS wrap is installed |
| `window.__cor3LastMarketId` | MAIN | last home market id seen by interceptor |
| `window.__cor3CachedMercIds` | MAIN | cached mercenary IDs for configure cascade |
| `window.__pipelineLocked`, `window.__autoJobsActive`, `window.__jobManagerAbort` | MAIN | flow-runner / UI-lock flags |

### Forcing actions from the console

```js
// Refresh markets
window.postMessage({ type: 'COR3_REFRESH_MARKET' }, '*');
window.postMessage({ type: 'COR3_REFRESH_DARK_MARKET' }, '*');

// Open Network Map + scrape servers
window.postMessage({ type: 'COR3_OPEN_NETWORK_MAP' }, '*');

// Stop a stuck flow
window.postMessage({ type: 'COR3_ABORT_JOB_FLOW' }, '*');

// Manually trigger a flow (FOR DEBUGGING — bypasses the auto-jobs queue)
window.postMessage({
    type: 'COR3_START_IP_INJECTION_FLOW',  // wrong — see flows.md
    type: 'COR3_START_IP_JOB_FLOW',
    jobId: 'fake-id', marketId: '019d3ea4-…',
    serverName: 'RM7-S4L4', ips: ['10.0.0.1'],
}, '*');

// Clear bugged-job blacklist
chrome.storage.local.set({ buggedJobIds: {} });

// Reset auto-jobs state to idle (use only when stuck)
chrome.storage.local.set({ autoJobsState: { status: 'idle', updatedAt: Date.now() } });
```

### F12 dump helper

`window.__cor3Dump()` (defined by the WS interceptor) posts
`COR3_REQ_DUMP` to the isolated world. **In the new architecture there is
currently no isolated-world handler for this** — it's a known gap from
the rewrite. Either:

- Read storage directly with the probes above, or
- Add a handler to `auto-jobs.js` (single setTimeout dump of all in-memory state)

Tracked in [`plans/todo.md`](../plans/todo.md).

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

Resolved May 2026, but documenting the failure mode in case anything similar
ever shows up again.

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

### "Auto-jobs status is stuck in `solving` and never completes"

Likely causes:
1. Solver minigame DOM didn't appear (90 s timeout in flow). Check the
   relevant flow in `src/modules/game/flows/<type>.js`.
2. K/D was missed on the target server — auto-jobs accepted before
   network-map could detect it. Check `kdSkipServers` map (in-memory only).
3. Server became unreachable mid-flow (route via K/D server). The flow
   posts `COR3_SERVER_UNREACHABLE` which auto-jobs handles.
4. Watchdog should kick in at 3 min and bug the job. If you don't see
   `solving watchdog 3min` in `cor3_logs['auto-jobs']`, the orchestrator
   itself has a bug.

**Force-recover:**
```js
window.postMessage({ type: 'COR3_ABORT_JOB_FLOW' }, '*');
chrome.storage.local.set({ autoJobsState: { status: 'idle', updatedAt: Date.now() } });
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
3. Open Auto-Jobs tab → toggle ON.
4. Network Map should open in-game; both market windows open with Job tabs.
5. If a qualifying job is on the board, expect (within a minute):
   - `[auto-jobs] tick: scanning markets` log line
   - `Accept: sending N request(s)…`
   - `accept-batch n=N` state transition
   - `flow START FileDecryption` (or other type)
6. Watch state machine step through `idle → accepting → solving → completing → idle`.
7. After completion, queue is drained, market refreshes, scan repeats.

## Disabling features without code changes

| Behavior | How |
|---|---|
| Disable auto-jobs entirely | Auto-Jobs tab → Stop |
| Skip a job type | Edit `chrome.storage.sync.autoJobsSettings.enabledJobTypes['file_decryption'] = false` (no UI yet) |
| Boost a server's priority | `chrome.storage.sync.serverPriorities['RM7-S4L4'] = 999` |
| Permanently bug a job | `chrome.storage.local.buggedJobIds['<id>'] = {ts: Date.now()+999*3600000, name: '?'}` |
| Stop alarms | Overview tab → Add alarm card → Stop all |
