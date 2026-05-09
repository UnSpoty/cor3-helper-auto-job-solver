# COR3 Helper — Cross-Session Todo

Этот файл — единый чеклист между сессиями. **Раздел "Next session"** ниже —
основное место, куда смотреть при возвращении в проект. Под ним — история
переработки (Phases 1–6) для контекста.

Полный изначальный план: `C:\Users\Admin\.claude\plans\glistening-beaming-dawn.md`.

---

## Recently shipped — May 2026

### Auto-decrypt: keyboard puzzle → click-driven puzzle

cor3.gg перерисовал config-hack минигу. Раньше — текстовое поле с
placeholder'ом, в которое легаси-солвер набирал combo и слал Enter. Теперь
4 кнопки-ячейки (`ParameterCells` × 4 + `SendButtonStyled`), которые
управляются клавиатурой: ↑/↓ меняют значение в фокусной ячейке, ←/→
переключают фокус, Enter сабмитит **только когда фокус на последнем
поле**. Старый солвер 100% сломан — текстового input'а нет.

Что выяснил при инспекции live-страницы (5 прогонов на test-account
puzzle, потратили 3 свежих файла):

- **Селекторы**: `[data-sentry-component="ConfigHackApplication"]` —
  watch root (легаси `LogContentStyled[data-sentry-source-file="…"]`
  тоже жив, но ConfigHackApplication надёжнее как контейнер).
  `[data-sentry-component="ParameterCells"]` — строка ячеек.
  `[data-sentry-element="SendButtonStyled"]` — Send.
  `[data-sentry-element="LogContentStyled"]` — лог.
- **Фокус-индикатор**: одна из 4 кнопок ячеек имеет уникальный
  Goober-класс (`go1602054769`) против общего у трёх других
  (`go2563699149`). Хеши меняются между билдами — детектим по
  «уникальный-vs-остальные» структуре.
- **`.click()` НЕ фокусирует ячейку.** Нужен полноценный mouse
  sequence: `mousedown → mouseup → click`. React onMouseDown — это и
  есть focus handler.
- **Enter работает только когда фокус на последнем поле**, причём
  после Enter браузерный фокус уходит на SendButton (его класс
  меняется), и стрелки в этом состоянии теряются. Поэтому полагаемся
  на клик SendButton (с тем же mouse sequence) вместо Enter — работает
  из любого состояния.
- **`ArrowUp` цикл значений**: верифицировано — от v1.0 ↓→v2.0→v1.1
  →v1.0 (назад с wrap), ↑ — наоборот. Значения обновляются синхронно,
  DOM-чтение `cellValue(i)` сразу после press надёжно.
- **DOM-чтение фокуса лагает** относительно кейпрессов (~50ms) → race
  condition в первом подходе с unique-class детектом. Решено уходом
  на click-based фокусировку (детект больше не нужен — мы знаем что
  кликнули).

Архитектура нового solver-decrypt:
- `focusCellByClick(idx)` — mousedown+mouseup+click на нужной ячейке
- `setFocusedValue(idx, target, optsCount)` — `ArrowUp` keydown/keyup
  через ConfigHackApplication target, пока `cellValue(idx)` не совпадёт
- `clickSubmit()` — mousedown+mouseup+click на SendButton (никакого
  Enter)
- `waitForResponse(combo)` — сканирует `LogContentStyled` снизу вверх
  на `> <combo>` echo, читает следующую строку для числа `Mismatched
  N` (locale-resilient — не привязывается к слову "Mismatched"). Если
  паззл-окно закрылось во время ожидания — early exit.

Минимакс-алгоритм (Knuth-style) сохранён verbatim.

End-to-end проверено: 4 валидных guess'a подряд (`v1.0 GET LTE AES → 2`,
`v1.0 GET Fiber RSA → 2`, `v1.0 PUT LTE RSA → 2`, `v1.1 GET LTE RSA → 1`)
прежде чем таймер паззла истёк (накопилось много минут моих диагностик
в одном открытом окне). Алгоритм сходится корректно.

В UI секцию Auto solvers добавлена disabled-заготовка `Auto-? (coming
soon)` под следующий solver — заполнить лейбл и привязать к storage-key
когда определится какая мини-игра.

В дальнейшем этот watch-and-solve механизм должен использоваться в
auto-jobs (когда оркестратор берёт Decrypt job, не пишет свою логику —
полагается на уже включённый solver-decrypt watcher).

### Markets — get.jobs split

cor3.gg переехал с одного `market.get.options` на три отдельных action'а:
`get.options` (только метаданные/репутация), `get.lots` (HARDWARE
секции «Рынок»), и `get.jobs` (собственно работы). Старый интерсептор
парсил только `get.options`-овский shape `{market, jobs, recentJobs,
nextJobsResetAt}` — поскольку `jobs` оттуда исчезли, в `marketData`
оседал объект без работ, а UI показывал пусто.

Что прибавилось/поменялось:

- **`__cor3RequestMarket()` / `__cor3RequestDarkMarket()`** теперь
  шлют `market.get.jobs` (а не `get.options`). Dark по-прежнему сначала
  `network-map.set.endpoint` → через 1500мс `get.jobs`.
- **FIFO-роутинг ответов** — ответ на `get.jobs` не несёт `marketId`,
  поэтому `pendingMarketJobsRequests` queue хранит `{marketId, sentAt}`
  на каждый отправленный запрос; на ответ pop-аем oldest. Auto-expire
  через 30 сек для дропнутых запросов.
- **Storage shape поплоский** — `marketData = {marketId, jobs,
  recentJobs, nextJobsResetAt}`. Старая обёртка `marketData.market`
  убрана. `auto-jobs.js` обновлён читать `marketData.marketId` (две
  точки в `findCandidates()`).
- **`get.options` / `get.lots` ответы swallow-аются** (без forward в
  `MSG.WS.MARKET`) — сайт сам шлёт их когда юзер открывает Market UI
  вручную, не хотим засорять storage метаданными которые нам не нужны.
- **UUID не менялись**, захардкожены в interceptor: `HOME_MARKET_ID`,
  `DARK_MARKET_ID`, `DARK_SERVER_ID`.

End-to-end проверено: 7 работ распарсились в новый плоский shape,
`nextJobsResetAt` через ~5h45m, поля `id, name, jobType, conditions,
rewardCredits, deposit, corporation, relatedServers` присутствуют.

### Daily Ops solve (one-shot, post-Game-Center move)

cor3.gg переселил Daily Ops из тулбара в окно Game Center, и старый
"Auto daily-hack" toggle (passive watcher над `.pulse-timeline`) перестал
быть работоспособным — паззл рендерится только после явной навигации в
Game Center → Daily Ops → Start. Заменили toggle на одноразовую кнопку
"Solve" в Overview карточке Daily Ops.

Что прибавилось:

- **`src/modules/solvers/daily-ops.js`** (MAIN) — оркестратор. Общий
  начальный пайплайн (`ensureGameCenterOpen` → `ensureDailyOpsOpen` →
  WS gate → `clickStartButton` → puzzle window → generic `^Get \w+`
  intro click → optional `.play-button`), затем `detectPuzzleType()`
  роутит в один из двух солверов:
  - **Signal Decode** — `chooseEncoding` пробует 4-bit binary и 5-bit
    morse, сверяется с `.input-hint` "Code length: N digits", вводит
    через `setReactInputValue(.code-input, code)`, кликает
    `.submit-button` под WS gate.
  - **System Log Integrity** — порт `analyzeLogLine` + `ERROR_LABELS`
    из легаси `solver-daily-hack.js`. Чекбокс на 2 худших строках,
    `.confirm-button`, итерация `.error-analysis-block` с
    `.fix-error-button` + `.error-type-button` per-issue, финальный
    submit (новое — Daily Ops оборачивает легаси-паззл и ждёт явного
    submit для зачёта).
- **`__cor3IsWsReady()` + `__cor3WaitForWs(ms)`** в ws-interceptor —
  гейтят клик на Start и Submit. socket.io флапает на сетевом шуме;
  без гейта клик ушёл бы в "пустоту" пока активный сокет в reconnect.
- **`awaitSubmitFeedback()`** — до 5 с слушает `.game-container` на
  `verified|reward|credits|success` (ok) или `failed|invalid|incorrect|
  try again` (fail). Если ничего — пишет в UI-лог "no server feedback
  (WS hiccup?)" чтобы пользователь сразу понимал природу проблемы.
- **MSG.SOLVER.START_DAILY_OPS / .DAILY_OPS_LOG** — новые константы.
  `automation/daily-ops.js` форвардит popup `solveDailyOps` в MAIN,
  и зеркалит `DAILY_OPS_LOG` в `STORAGE_LOCAL.DAILY_HACK_LOG` (тот же
  ключ, что показывает Overview-карточка). На `solved:` префикс ещё
  и автоматически перевызывает `fetchOps()` через 1.5 с — карточка
  сразу флипает с "pending" на "claimed".
- **Overview UI** — заменили tooggle "Auto daily-hack" на кнопку
  "Solve". Refresh теперь в одном ряду с Solve. Карточка читает
  `daily.currentStreak` (бывший легаси-баг — читалось `daily.streak`,
  и потому фронт всегда показывал "streak 0").
- **WS log spam** — четыре `console.log` в ws-interceptor (`Tracking
  WebSocket`, `Active socket changed`, `WS connected`, `WS closed`)
  демотнуты в `console.debug`. Сами реконнекты — поведение socket.io
  при сетевом шуме, не от нашего расширения.

Локально-нейтральные селекторы: всё через `data-component-name` /
`data-sentry-component` или стабильные CSS-классы. English-keyword
couplings минимальны: `daily` (description карточки), `get` (intro
кнопка), `morse`/`binary` (encoding опции), `verified|reward|…`
(success heuristic), и легаси `ERROR_LABELS` (отдельно помечены как
locale-fragile).

End-to-end проверено через chrome-devtools-mcp на живой странице:
solver на Replay-режиме прошёл Signal-задачу до `DECODE STATUS:
VERIFIED, +525 Credits` (Morse `6458797498`, Morse `5733161629`,
Binary `4533115764` — три прогона).

### Daily Ops solve — System Log Integrity (доработка)

Сегодня daily-задача оказалась Log Integrity вместо Signal Decode.
Прогнали солвер на ней end-to-end и поправили три проблемы:

1. **intro-click слишком узкий**. Был regex `^get\s+\w+/i` который
   ловил "Get Signal" в Signal-паззле, но не "Start" в Log Integrity.
   Заменили на "клик по единственной enabled-кнопке внутри
   `GameWaitingScreen`" — экран по архитектуре однокнопочный, любой
   label сработает.
2. **`.log-entry-appearing` race**. Паззл анимирует появление строк
   одну за одной; чтение до конца анимации даёт частичный набор и
   паззл застревает на "Selected: 1 / 2" с disabled Confirm-кнопкой.
   Добавили `waitForLogScanComplete(container)` который опрашивает
   counter до 2 стабильных тиков подряд И исчезновения класса
   `.log-entry-appearing`.
3. **post-fix flow не доделан**. Легаси-`solver-daily-hack` после
   error-type кликов просто останавливался. Daily Ops оборачивает
   паззл во фрейм, который требует:
   - Confirm Fixes (`.confirm-button` #2, тот же класс что и
     "Confirm Selection" но на другом экране)
   - Run Re-scan (`.scan-button`) — это и есть момент WS round-trip,
     поэтому WS-gate ставим именно тут
   - детект `.result-screen.success` (вместо textContent regex)
   - Close + закрытие окна через `close-app-btn` (иначе паззл сам
     перекатывает новый раунд — он designed для replay-сессий, а
     daily reward уже заскорен на этом моменте)

Также `findErrorTypeButton` теперь делает text→position fallback:
текст по `ERROR_LABELS` — primary path (на сегодняшнем билде кнопки
английские даже на RU-локали), `ISSUE_BUTTON_INDEX` (TIME=0, TYPE=1,
MISSING_SECTOR=2, MISSING_STATUS=3, SECTOR_BAD=4, STATUS_BAD=5) —
fallback на случай локализации.

End-to-end на живой странице: 30 строк отсканировались, 2 битые
найдены, 4 fix-клика (TYPE+MISSING_SECTOR на одной, SECTOR_BAD+
STATUS_BAD на другой), `result-screen success`, окно закрылось,
`Завершено / +525 Кредиты` залочено.

### UI restructure (later in the same day)

Сократили вкладки с 8 до 5 и переразложили контент по
"что я хочу видеть рядом":

- **Overview**: Daily Ops (+ Auto daily-hack toggle inside the card) ·
  Markets — Home / Dark, каждая карточка несёт свой Auto-refresh toggle ·
  Auto solvers (только Auto-decrypt) · Game appearance (4 toggles) ·
  Alarms — collapsible `<details>`, default-open · versions footer.
- **Expeditions** (новая): Active expeditions · Pending decisions ·
  Auto-choose decision (toggle + risk slider) · Auto-send mercenary · Roster ·
  Stash.
- **Auto-Jobs / Modules / Logs** — без изменений.

Удалены секции `settings.js`, `alarms.js`, `stash.js`, `mercenaries.js`.
`timer.fmt()` теперь всегда показывает секунды, даже когда часы > 0
(было `${h}h ${m}m` без `s`). Добавлен `.gitignore` для
`.claude/settings.local.json` и root-level `.mcp.json`.

Главный принцип после второго прохода: тоггл живёт там же, где блок,
которым он управляет. Auto daily-hack — внутри Daily Ops карточки.
Auto-refresh — внутри карточки конкретного маркета (а не отдельной
сводной секции). Это сэкономило вертикаль и убрало мысленный шаг
"найди где включается то, что относится вот к этому".

Модуль `auto-refresh` сохранён — UI для него теперь живёт в карточках
маркетов в Overview.

### Bug fixes (предыдущий заход)

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
