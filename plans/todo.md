# COR3 Helper — Cross-Session Todo

Этот файл — единый чеклист между сессиями. **Раздел "Next session"** ниже —
основное место, куда смотреть при возвращении в проект. Под ним — история
переработки (Phases 1–6) для контекста.

Полный изначальный план: `C:\Users\Admin\.claude\plans\glistening-beaming-dawn.md`.

---

## Recently fixed — May 2026

Три бага найдены и починены в одну сессию (один коммит):

1. **MAIN-мир падал в синхронную бесконечную рекурсию через Logger.**
   `Logger` всегда регистрировал `Bus.setTrace(...)`. В MAIN `push()` форвардит
   запись через `Bus.window.post('COR3_LOG_REMOTE', …)`, а `Bus.window.post`
   синхронно вызывает trace → `push('bus', …)` → снова `post` → … stack
   overflow на первой же лог-строке. Симптом: cor3.gg-таб полностью виснет
   при запуске расширения, F12 не открывается. Фикс: gating tracer на
   `HAS_STORAGE`, `inTrace` re-entry guard, фильтр `COR3_LOG_REMOTE` чтобы
   не дублировать. См. `src/core/logger.js` и
   `docs/architecture.md → Bus tracer recursion`.
2. **Дублирование контента в Overview и Logs.** `shell.js` для активной
   вкладки звал `mount(el)` и сразу `activate(el)`. У этих двух секций оба
   метода вызывали async `render()`. Оба клира `container.innerHTML = ''`
   успевали отработать **до** первых `appendChild`, и контент дописывался
   дважды. Фикс: убрал `render()` из `mount()` в `overview.js` и
   `logs-panel.js`. У остальных секций mount уже только подписывался —
   они не были затронуты.
3. **Шум "Receiving end does not exist" в SW логах.** `keepAlive` падал каждые
   30 с, когда контент-скрипт ещё не успел подгрузиться. Не баг — нормальное
   поведение Chrome — но захламляло `cor3LogError`. Фикс: `isNoReceiverError`
   глушит конкретно эту строку в `src/entry/background.js`.

---

## Next session — start here

### Setup

- [ ] Подключить chrome-devtools-mcp (уже зарегистрирован в `.claude/.mcp.json`):
    ```
    npx -y chrome-devtools-mcp@latest
    ```
    Должен запуститься как MCP-сервер. Проверить — спросить у меня "открой cor3.gg".
- [ ] Перезагрузить расширение в `chrome://extensions/` если давно не загружали — посмотреть есть ли parse-errors на новом коде.
- [ ] Открыть cor3.gg → DevTools console; ожидаем:
    - `[COR3] WebSocket interceptor installed (modular)`
    - `[COR3] HTTP interceptor installed`
    - `[COR3.entry/content-early] MAIN-world boot complete — 16 modules`

### High-priority items

#### 1. Cross-world Module Manager state sync (~30 lines)

MAIN-world Registry не реагирует на изменения `chrome.storage.sync.modules`,
потому что у MAIN нет `chrome.*`. Toggle в UI Module Manager сохраняется,
но не останавливает MAIN-модули до перезагрузки.

**Fix:** в `src/entry/content.js` после `Registry.boot()` добавить:
```js
Settings.onChange((id, next) => {
    Bus.window.post('COR3_MODULE_STATE_CHANGE', { id, state: next });
});
```
В `src/entry/content-early.js` (после `Registry.boot()`) добавить:
```js
Bus.window.on('COR3_MODULE_STATE_CHANGE', ({ id, state }) => {
    Registry.setModuleState(id, state);
});
```
Также добавить `'COR3_MODULE_STATE_CHANGE'` в `MSG.*` (можно в новую группу
`MSG.SYS` или подгруппу) — никаких inline строк.

Verify через chrome-devtools-mcp: переключить switch в Module Manager →
проверить что `Registry.get(id).started` поменялся.

#### 2. Restore `__cor3Dump()` debug helper

В новой архитектуре `window.__cor3Dump()` посылает `COR3_REQ_DUMP`, но
никто не слушает. Добавить handler в `auto-jobs.js` или в отдельный
debug-модуль:

```js
this.track(Bus.window.on('COR3_REQ_DUMP', () => {
    console.group('[AJ] STATE DUMP');
    console.log('autoJobsState:', state);
    console.log('autoJobsQueue:', queue);
    console.log('buggedJobIds:', buggedJobs);
    console.log('kdSkipServers:', [...kdSkipServers.entries()]);
    console.log('settings:', settings);
    console.groupEnd();
}));
```

#### 3. Per-job-type UI toggles

`autoJobsSettings.enabledJobTypes` уже работает в orchestrator'е, но в UI
этих контролов нет. Добавить sub-section в `src/ui/sections/auto-jobs.js`
(после Sources card, перед Queue):

```js
container.appendChild(el('div', 'section-title', 'Job types'));
const types = el('div', 'card');
for (const [id, label] of [
    ['file_decryption', 'File Decryption'],
    ['ip_injection', 'IP Injection'],
    ['ip_cleanup', 'IP Cleanup'],
    ['data_upload', 'File Upload'],
    ['log_deletion', 'Log Deletion'],
    ['log_download', 'Log Download'],
    ['file_elimination', 'File Elimination'],
    ['data_download', 'Data Download'],
    ['decrypt_extract', 'Decrypt & Extract'],
]) {
    // toggle row reading/writing settings.enabledJobTypes[id]
}
```

#### 4. `debugTriggerJobType` legacy feature

Старый popup имел кнопку "trigger one of these jobs now" — для тестирования.
В новой архитектуре auto-jobs `debugMode` toggle есть, но нет UI чтобы
запустить конкретный job по типу. Добавить в Auto-Jobs section debug
panel — кнопки "Trigger file_decryption", "Trigger ip_injection" и т.д.

Реализация: расширить runtime-bridge:
```js
this.track(Bus.runtime.on('debugTriggerJobType', (payload) => {
    // …port from legacy content.js debugTriggerJobType handler…
}));
```

### Medium-priority items

- [ ] **`pinnedTimers`** — старая sync-key, не используется в новом UI. Решить: удалить из `STORAGE_SYNC.*` или добавить pinned-timer фичу обратно.
- [ ] **`selectedTheme`** — те же. Дропнули 6 тем, но ключ остался.
- [ ] **`COR3_WS_LOG`** envelope — interceptor его всё ещё эмитит, но никто не консьюмит. Удалить из interceptor для скорости.
- [ ] **WS_ARCHIVED_EXPEDITIONS** — UI tab дропнут, но WS event ещё парсится и хранится в `archivedExpeditionsData`. Удалить из interceptor если уверены.
- [ ] **`scripting`** permission — добавлен только для Module Manager. Если cross-world sync (item 1) сделает Module Manager не нужным `executeScript`, можно убрать.

### Low-priority / nice-to-have

- [ ] **Server-priorities UI.** `chrome.storage.sync.serverPriorities` уже учитывается auto-jobs orchestrator'ом, но UI для редактирования нет. Сейчас редактируется только через DevTools.
- [ ] **`COR3.dom.findContainsText`** — определена в `dom.js`, но не используется. Удалить или начать использовать.
- [ ] **Notebook-friendly storage inspection.** Маленький `src/ui/sections/storage.js` для просмотра/редактирования произвольных storage keys без F12.
- [ ] **Per-flow timeout customization.** Сейчас magic numbers (90 s minigame, 60 s file-search) разбросаны по flow модулям. Вынести в `LIMITS.*`.

### Refactor opportunities (если будет время)

- **Auto-jobs.js (~600 строк)** — самый крупный модуль. Можно вынести
  scanning/accepting/executing в sub-модули, но текущая монолитность
  оправдана сильной связью state machine. Не трогать без необходимости.
- **Manifest content_scripts.** 33 файла в isolated, 29 в MAIN — лоадер
  работает, но если хочется bundling, можно добавить esbuild build step
  и сократить manifest до 4 entry-файлов. Trade-off: build step против
  "vanilla JS" принципа.

---

## History — Phase 1 ✅

- [x] Создать каталоги `src/core/`, `src/shared/`, `docs/`, `plans/`
- [x] `src/shared/constants.js` — все MSG/STORAGE/FLOW в одном месте
- [x] `src/shared/dom.js` — sleep, waitForEl, click, react-input
- [x] `src/shared/ws-frames.js` — Socket.IO v4 parser
- [x] `src/shared/errors.js` — error capture
- [x] `src/core/bus.js` — Bus.window + Bus.runtime
- [x] `src/core/store.js` — Promise-обёртка над chrome.storage
- [x] `src/core/logger.js` — ring buffer + subscribe
- [x] `src/core/module.js` — Module base
- [x] `src/core/registry.js` — boot/setModuleState
- [x] `src/core/settings.js` — module enable/log persistence
- [x] `docs/module-spec.md` — контракт + how to add new
- [x] `CLAUDE.md` — секция Modules
- [x] `plans/todo.md` — этот файл
- [x] `node --check` всех новых файлов
- [x] Manifest НЕ трогаем; legacy продолжает работать

**Чекпоинт:** перезагрузить расширение → должно работать как раньше (legacy untouched).

## Phase 2 — Data layer migration ✅

- [x] `src/interceptors/ws-interceptor.js` — wraps WebSocket, parses via wsFrames, emits via Bus.window; preserves all `window.__cor3*` outbound helpers
- [x] `src/interceptors/http-interceptor.js` — fetch+XHR captures bearer + translation.json version + users/me systemVersion + daily rewards
- [x] `src/interceptors/solver-loader.js` — `inject(path)` helper for Phase 3 game modules
- [x] `src/modules/data/auth.js` (bearer + 3 version keys + daily rewards)
- [x] `src/modules/data/expeditions.js`, `decisions.js`, `market.js`, `dark-market.js`, `stash.js`, `mercenaries.js`, `merc-config.js`, `expedition-config.js`
- [x] `src/entry/content-early.js` — MAIN-world boot stub (interceptors do the work)
- [x] `src/entry/content.js` — calls Registry.boot() + Settings.onChange live re-sync
- [x] Manifest updated:
    - content_scripts[0] (MAIN) = 9 files (shared/core/interceptors/entry)
    - content_scripts[1] (isolated) = 21 files (shared/core/data-modules/entry/legacy content.js)
- [x] Legacy `content-early.js`, `errors.js`, `ws-messages.js`, `ws-interceptor.js` no longer in content_scripts — kept on disk for rollback only
- [x] `node --check` all new files OK
- [x] `cor3LogWsMessage` stubbed as no-op in `src/shared/errors.js` (legacy content.js still calls it)

**Skipped intentionally:** `daily-ops.js` data module — daily-ops fetch logic is HTTP-driven and lives in legacy content.js; will migrate alongside automation in Phase 4.

**Migration topology:**
```
MAIN world (document_start, fully replaced):
  shared → core/bus → interceptors → entry/content-early
Isolated world (document_idle, parallel-load):
  shared → core/* → data modules → entry/content [Registry.boot] → legacy content.js
```

**Чекпоинт:** перезагрузить расширение в `chrome://extensions/`. Должно работать как раньше:
- popup рендерит markets, expeditions, mercenaries, stash, decisions
- auto-jobs продолжает работать (legacy content.js + legacy job-manager.js)
- auto-send-merc продолжает работать (legacy content.js)
- alarms продолжают работать
- В DevTools console игровой страницы должно быть:
  - `[COR3] WebSocket interceptor installed (modular)`
  - `[COR3] HTTP interceptor installed`
  - `[COR3.entry/content-early] MAIN-world boot complete`
- В DevTools console для popup или service-worker'а:
  - `[COR3.Logger]` — записи под module id `bus`, `auth`, `expeditions`, `market`, … когда приходят данные
- Storage key `chrome.storage.local.cor3_logs` должен заполниться записями.

## Phase 3 — Game layer ✅

- [x] `src/modules/game/network-map.js` — selectors, find/scrape servers, K/D detect, ensureNetworkMapOpen, openServerMarket, UI Lock click handler
- [x] `src/modules/game/server-connect.js` — full Connect→K/D→Login→ActiveAccess pipeline; depends on network-map
- [x] `src/modules/game/sai-navigator.js` — SAI tab switching, downloadsWatcher singleton, row finders for Logs/Files/Transit, addIpViaModal, confirmDeleteDialog
- [x] `src/modules/game/flows/_shared.js` — single-flow guard, startFlow wrapper, sendDone/sendTimeout/userLog helpers, abort listener, exposes COR3.game.flows
- [x] All 9 flow modules: file-decryption, ip-injection, ip-cleanup (virtual-scroll re-query), file-upload, log-deletion (name + seq fallback), log-download, file-elimination, data-download, decrypt-extract
- [x] `src/modules/solvers/decrypt.js` — config-hack minimax solver (logic verbatim from legacy)
- [x] `src/modules/solvers/daily-hack.js` — System Log Integrity + Signal Hack
- [x] Logger now forwards MAIN-world entries via `COR3_LOG_REMOTE` Bus envelope; isolated content.js registers a log-bridge that calls `Logger.ingest()`
- [x] Manifest updated: 28-file MAIN content_scripts list (shared/core/interceptors/game/flows/solvers/entry); web_accessible_resources emptied (solvers no longer dynamically injected)
- [x] Legacy deleted: `job-manager.js`, `decrypt-solver.js`, `daily-hack-solver.js`, `ws-interceptor.js`, `content-early.js`
- [x] `node --check` all Phase 3 files OK

**Modules registered (MAIN world): 16**
- network-map, server-connect, sai-navigator (game core)
- flows-core
- 9 flow modules (flow-file-decryption, flow-ip-injection, …, flow-decrypt-extract)
- solver-decrypt, solver-daily-hack

**Cross-world log bridge:**
```
MAIN module.this.info('msg')  →  Logger.push (no chrome.storage)
                              →  Bus.window.post('COR3_LOG_REMOTE', {moduleId, entry})
                              →  isolated content.js: Bus.window.on('COR3_LOG_REMOTE')
                              →  Logger.ingest(moduleId, entry)
                              →  cor3_logs[moduleId][...]
```

**Known limitation (deferred to Phase 5):** Module Manager UI in MAIN-world cannot be controlled by the `chrome.storage.sync.modules` toggles because MAIN has no chrome.* APIs. MAIN modules always start. To truly disable a flow, use `autoJobsSettings.enabledJobTypes` (the auto-jobs orchestrator in isolated world won't dispatch the START message).

**Чекпоинт:** перезагрузить расширение в `chrome://extensions/`. Auto-jobs продолжает решать задачи. В DevTools console игровой страницы должно быть:
- `[COR3] WebSocket interceptor installed (modular)`
- `[COR3] HTTP interceptor installed`
- `[COR3.entry/content-early] MAIN-world boot complete — 16 modules`

В UI popup (или через `chrome.storage.local.get('cor3_logs', console.log)`) — записи под module id'ами `network-map`, `server-connect`, `flow-file-decryption` и т.д. когда auto-jobs прогоняет очередную задачу.

Тестируйте минимум 2 flow вживую: `file_decryption` (если есть в маркете) и `ip_injection`. Если что-то не работает — `git checkout HEAD~1 -- job-manager.js decrypt-solver.js daily-hack-solver.js ws-interceptor.js content-early.js manifest.json` восстановит legacy.

## Phase 4 — Automation modules ✅

- [x] `src/modules/automation/timers.js` — alarms tick engine (chrome.storage.sync.alarms)
- [x] `src/modules/automation/auto-refresh.js` — market polling on timer expiry
- [x] `src/modules/automation/auto-send-merc.js` — completed expedition → container → collect → relaunch (cheapest merc)
- [x] `src/modules/automation/auto-choose-decision.js` — risk-threshold formula (replaces loot/risk slider modifiers)
- [x] `src/modules/automation/auto-jobs.js` — full state machine: idle/accepting/solving/completing; bugged blacklist; K/D server skip; server priorities; debug confirmation gate; watchdogs (60s accept, 3min solving, 45s completing)
- [x] `src/modules/automation/auto-decrypt.js`, `auto-daily-hack.js` — toggle solver via Bus
- [x] `src/modules/automation/daily-ops.js` — fetch from svc-corie.cor3.gg
- [x] `src/modules/automation/runtime-bridge.js` — chrome.runtime → window.postMessage relay (replaces legacy content.js handler)
- [x] 4 appearance modules: system-messages, background, network-fog, map-fx

## Phase 5 — UI rebuild ✅

- [x] `src/ui/popup.css` — cor3.gg palette (single theme, --os-color-* variables from ui_exmpl.html)
- [x] `src/ui/popup.html` — minimal shell with header + tabs + 8 section containers
- [x] `src/ui/shell.js` — entry, mode detection (?mode=popout), tab routing, section lifecycle
- [x] Components: `icons.js`, `timer.js`, `module-card.js`, `log-viewer.js`
- [x] Sections: `overview` (daily ops + markets + expeditions + decisions), `stash`, `mercenaries`, `auto-jobs`, `alarms`, `modules-panel`, `logs-panel`, `settings`
- [x] Pop-out mode + side-panel mode (header buttons)
- [x] Module Manager UI uses `chrome.scripting.executeScript` to read snapshot from BOTH worlds (isolated + MAIN)
- [x] Live Log Viewer reads `chrome.storage.local.cor3_logs` with module + level filter

## Phase 6 — Cleanup + verify ✅

- [x] Deleted legacy: `content.js`, `popup.js`, `popup.html`, `errors.js`, `ws-messages.js`, `background.js`, `versions.json`
- [x] New `src/entry/background.js` — keep-alive + expedition polling for auto-features
- [x] Manifest finalized:
    - `background.service_worker` = `src/entry/background.js` (Chrome) + `scripts:[...]` (Firefox compat)
    - `content_scripts[0]` (MAIN, document_start): 29 files
    - `content_scripts[1]` (isolated, document_idle): 33 files (no more legacy content.js)
    - `action.default_popup` + `side_panel.default_path` = `src/ui/popup.html`
    - Added `scripting` permission for Module Manager UI
    - `web_accessible_resources` = empty
- [x] `node --check` all files in `src/` — OK

## Final state

```
cor3-helper/
├── manifest.json
├── CLAUDE.md
├── ui_exmpl.html              (kept as reference)
├── icon/
├── docs/
│   └── module-spec.md
├── plans/
│   └── todo.md
└── src/
    ├── core/             (6 files: bus, store, logger, module, registry, settings)
    ├── shared/           (4 files: constants, dom, ws-frames, errors)
    ├── interceptors/     (3 files: ws, http, solver-loader)
    ├── modules/
    │   ├── data/         (9 files)
    │   ├── automation/   (9 files: timers, auto-refresh, auto-send-merc,
    │   │                  auto-choose-decision, auto-jobs, auto-decrypt,
    │   │                  auto-daily-hack, daily-ops, runtime-bridge)
    │   ├── game/         (3 + flows/ + …)
    │   │   ├── network-map, server-connect, sai-navigator
    │   │   └── flows/    (10 files: _shared + 9 flows)
    │   ├── solvers/      (2 files: decrypt, daily-hack)
    │   └── appearance/   (4 files)
    ├── ui/
    │   ├── popup.html, popup.css, shell.js
    │   ├── components/   (4 files)
    │   └── sections/     (8 files)
    └── entry/            (3 files: content-early, content, background)
```

**Total:** 65+ source files, ~6500 lines of new code, 0 lines of legacy code.

## Verification (next checkpoint)

When you can test:
1. Reload extension at `chrome://extensions/`. Watch for errors there.
2. Open cor3.gg → DevTools console → expect:
   - `[COR3] WebSocket interceptor installed (modular)`
   - `[COR3] HTTP interceptor installed`
   - `[COR3.entry/content-early] MAIN-world boot complete — 16 modules`
3. Open the popup (or side panel). New cor3.gg-styled UI loads with 8 tabs.
4. Test each tab:
   - **Overview**: shows daily ops timer, markets, expeditions, pending decisions
   - **Stash**: capacity bar + items
   - **Mercs**: roster + auto-send toggles
   - **Auto-Jobs**: master toggle, queue, bugged, log
   - **Alarms**: existing alarms + form to add new
   - **Modules**: full registry list grouped by category, master + log switches per module
   - **Logs**: live stream with module + level filter
   - **Settings**: auto-refresh / auto-solvers / risk threshold / appearance toggles
5. Toggle auto-jobs ON. Should:
   - Open Network Map
   - Open both markets (home + dark)
   - Start scanning, accepting, solving jobs
6. Live log should show entries from `network-map`, `auto-jobs`, `flow-*`, `solver-*`.

Rollback: `git checkout HEAD~N -- .` (where N is whatever pre-rewrite commit).

## Known limitations (deferred)

- **Cross-world Module Manager state sync**: master switches only persist via `chrome.storage.sync.modules`. The Settings.onChange listener in `entry/content.js` re-syncs the isolated-world Registry. MAIN-world Registry doesn't subscribe to sync changes (no chrome.* APIs). To fully control MAIN modules from the UI, add a Bus.window broadcast from isolated → MAIN when settings change. Tracked here for the next session.
- **`debugTriggerJobType`** (legacy popup debug feature): not exposed in new UI. Auto-jobs `debugMode` toggle still gates dispatch behind a confirmation, but the per-type "trigger one of these jobs now" button is gone. Re-add in a future session if needed.
- **Per-job-type enable/disable** in `autoJobsSettings.enabledJobTypes`: persisted but no UI control yet — add a sub-section to the Auto-Jobs tab if you want to disable specific flows.

## Полезные команды между сессиями

```bash
# Найти все TODO/FIXME в src
rg -n "TODO|FIXME" src/

# Lint всё новое
node --check src/core/*.js src/shared/*.js src/interceptors/*.js \
             src/modules/**/*.js src/entry/*.js

# Посмотреть текущий manifest
cat manifest.json
```

## Принципы между сессиями

1. **Не дописывать в один файл бесконечно** — если модуль > 300 строк, вытащить хелперы в shared/.
2. **Только storage keys и MSG types из constants.js** — никаких inline-строк.
3. **Логи через `this.info/debug/warn/error`** — никаких `console.log` в модулях.
4. **`this.track(unsub)`** для каждой подписки.
5. **Перед коммитом: `node --check src/**/*.js`**.
