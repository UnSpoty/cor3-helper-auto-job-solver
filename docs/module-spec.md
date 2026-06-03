# Module Spec

Контракт всех фич COR3 Helper. Каждая фича — отдельный класс, наследующий
`COR3.Module`, и зарегистрированный в `COR3.Registry`. Контекст исполнения
(MAIN content world / isolated content world / background SW / popup)
определяется тем, в каком entry-файле модуль регистрируется и в каком
content_scripts-блоке manifest он стоит.

См. также: [architecture.md](architecture.md), [messaging.md](messaging.md),
[pipelines.md](pipelines.md).

## Жизненный цикл

```
register()  →  init()  →  start()  ⇄  stop()
```

| Хук     | Когда вызывается                                                  | Что делать                                              |
|---------|-------------------------------------------------------------------|---------------------------------------------------------|
| `init`  | один раз при `Registry.boot()` независимо от `enabled`            | Подготовка, не имеющая видимых сайд-эффектов            |
| `start` | при `boot()` если `enabled=true`, или после переключения свича    | Подписки на bus / storage, запуск таймеров              |
| `stop`  | при выключении модуля или при cascade-stop (выключен upstream)    | Снятие подписок, остановка таймеров                     |

`start`/`stop` могут вызываться многократно. Регистрируйте все подписки
через `this.track(unsubscribe)` — `Module._runStop()` автоматически
вызовет каждую функцию из `_cleanups`.

## Минимальный модуль

```js
// src/modules/automation/example.js
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ExampleModule extends Module {
        constructor() {
            super({
                id: 'example',
                name: 'Example feature',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market'],
                owns: {
                    storageKeys: ['exampleSetting'],
                    busTypes: [C.MSG.GAME.REFRESH_MARKET],
                },
                defaultEnabled: true,
                defaultLogsEnabled: true,
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MARKET, (env) => {
                this.info('market frame', { jobs: env.market?.jobs?.length });
            }));
        }
    }

    Registry.register(new ExampleModule());
})();
```

## Поля конструктора

| Поле                 | Обязательно | Описание                                                            |
|----------------------|-------------|---------------------------------------------------------------------|
| `id`                 | да          | kebab-case, уникален. Ключ в `chrome.storage.sync.modules` и moduleId в логе |
| `name`               | да          | человекочитаемое имя для Module Manager UI                          |
| `category`           | да          | одно из `CATEGORY.*` — для группировки в UI                         |
| `dependsOn`          | нет         | массив id модулей, от которых зависит. Registry соблюдает порядок старта; cascade-stop при выключении upstream |
| `owns.storageKeys`   | нет         | storage-ключи, которые модуль читает/пишет — документация            |
| `owns.busTypes`      | нет         | bus-типы, которые модуль слушает или эмитит — документация           |
| `defaultEnabled`     | нет         | `true` по умолчанию                                                  |
| `defaultLogsEnabled` | нет         | `true` по умолчанию                                                  |

## Логирование

```js
this.debug('msg', ctx);  // тонкие детали
this.info('msg', ctx);   // нормальные события
this.warn('msg', ctx);   // подозрительно, но не фатально
this.error('msg', ctx);  // ошибка, но модуль не упал
```

Все записи попадают в `chrome.storage.local.cor3_logs[moduleId]` (ring 200).
UI Logs panel субскрайбится через `Logger.subscribe(fn)` для live-стрима.

Если в Module Manager выключен toggle «logs» для модуля —
`Logger.isLogsEnabled(id)` вернёт `false`, и `this.log()` станет no-op.

В MAIN-world (нет chrome.storage) Logger форвардит запись через
`Bus.window.post('COR3_LOG_REMOTE', {moduleId, entry})`. Isolated-entry
её ингестит и пишет в storage. См.
[architecture.md → Cross-world logging](architecture.md#cross-world-logging).

## Storage

```js
const value = await Store.local.getOne('myKey', defaultValue);
await Store.local.setOne('myKey', value);
await Store.local.set({ k1: v1, k2: v2 });
await Store.local.remove('myKey');

const unsub = Store.local.onChanged((changes) => {
    if (changes.myKey) this.handle(changes.myKey.newValue);
});
this.track(unsub);

// Same surface for sync
await Store.sync.getOne('autoJobsSettings', defaults);
await Store.sync.setOne('autoJobsSettings', settings);
```

Полный список ключей: [messaging.md → STORAGE_LOCAL / STORAGE_SYNC](messaging.md#storage_local--chromestoragelocal-keys).

## Bus

Два транспорта, **одинаковый envelope** `{ type: string, payload?: any }`.

```js
// MAIN ↔ isolated content (window.postMessage)
Bus.window.post(C.MSG.GAME.REFRESH_MARKET, null);
const unsub = Bus.window.on(C.MSG.WS.MARKET, (env) => { /* env = the posted payload */ });

// isolated ↔ popup ↔ SW (chrome.runtime)
const reply = await Bus.runtime.send('toggleAutoJobs', { settings });
const unsub = Bus.runtime.on('toggleAutoJobs', async (payload, sender) => {
    /* payload = the posted payload, OR the whole {action, ...flat} message
       for popup envelopes */
    return { success: true };
});
```

`Bus.runtime.on` принимает оба envelope-формата:
- `{ type, payload }` (Bus-style)
- `{ action, ...flat }` (popup style; payload = whole msg)

**Никаких inline-строк в коде модулей** — все типы в
[`src/shared/constants.js`](../src/shared/constants.js).

## Контексты исполнения

| Контекст          | Что доступно                                                | Что НЕ доступно                  |
|-------------------|-------------------------------------------------------------|----------------------------------|
| MAIN content      | DOM, `window`, `WebSocket`, `fetch`, `Bus.window`           | `chrome.*`                       |
| Isolated content  | DOM (другой realm), `chrome.*`, `Bus.window`+`runtime`      | `window`-globals из MAIN          |
| Background SW    | `chrome.*`, `Bus.runtime`                                    | DOM, `window`, page-side WS       |
| Popup / side panel | popup DOM, `chrome.*`, `Bus.runtime`                       | DOM игровой страницы              |

Модуль выбирает контекст по своей природе:

- **Game-side операции** (DOM, WebSocket capture) → MAIN
- **Storage-driven логика, fetch'и через captured token** → isolated
- **Cross-tab координация** (keep-alive, polling) → background SW
- **UI rendering** → popup (но это UI-section, не Module — другой паттерн)

Регистрируется в соответствующем entry-файле через manifest.

## Как добавить новый модуль

### Data module (isolated world)

Слушает один MSG.WS.* тип, пишет в один-два storage ключа.

```js
// src/modules/data/foobar.js
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class FoobarModule extends Module {
        constructor() {
            super({
                id: 'foobar',
                name: 'Foobar',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.FOOBAR],
                    busTypes: [C.MSG.WS.FOOBAR],
                },
            });
        }
        async start() {
            this.track(Bus.window.on(C.MSG.WS.FOOBAR, (env) => {
                if (!env.data) return;
                Store.local.set({
                    [C.STORAGE_LOCAL.FOOBAR]: env.data,
                    foobarUpdatedAt: Date.now(),
                });
                this.debug('foobar frame', { count: env.data.length });
            }));
        }
    }
    Registry.register(new FoobarModule());
})();
```

Регистрация в manifest:
```diff
 "content_scripts": [
   { "world": "MAIN", ... },
   {
     "js": [
       ...,
       "src/modules/data/auth.js",
+      "src/modules/data/foobar.js",
       ...,
       "src/entry/content.js"
     ]
   }
 ]
```

Добавить в `constants.js`:
```diff
 const MSG = {
     WS: {
         ...,
+        FOOBAR: 'COR3_WS_FOOBAR',
     },
 };
 const STORAGE_LOCAL = {
     ...,
+    FOOBAR: 'foobarData',
 };
```

И обновить interceptor в `src/interceptors/ws-interceptor.js`, чтобы он
эмитил `MSG.WS.FOOBAR` при обнаружении соответствующего WS-фрейма.

### Automation module (isolated world)

Реагирует на storage / bus events, координирует чужие действия.

Шаблон: см. `src/modules/automation/auto-refresh.js` (простой) или
`src/modules/automation/auto-send-merc.js` (с выбором кандидатов).

Регистрация в `manifest.content_scripts[1].js` после data-модулей.

### Auto Jobs: оркестратор + стейджи (isolated world)

Отдельный паттерн **только для Auto Jobs** (см. [CLAUDE.md → Auto Jobs subsystem](../CLAUDE.md)
и [pipelines.md → Auto Jobs](pipelines.md)). Правила строгие: никаких
fallback'ов/тихих скипов, свои ключи `AJ_*`, лог под id `auto-jobs`.

- **Один зарегистрированный Module** — оркестратор
  (`src/modules/automation/auto-jobs.js`, id `auto-jobs`). Владеет
  START/STOP и крутит бесконечный цикл. Отмена через generation-token: STOP
  инвалидирует in-flight цикл, чтобы половина прохода не «протекла».
- **Стейджи — обычные объекты**, НЕ Module и НЕ в Registry. Живут на
  `COR3.autoJobs.pipeline.stages.*`
  (`src/modules/automation/auto-jobs/pipeline.js`). Контракт у всех один:

  ```js
  const myStage = {
      id: AJ.NODE.MY_STAGE,           // из constants.AJ.NODE
      async run(packet, ctx) {
          if (!packet.somePrereq) throw new Error('MY_STAGE: prereq missing');  // громко, без fallback
          // …читаем shared read-only state, считаем, пишем в свои AJ_* ключи…
          ctx.log.info('MY_STAGE → done');
          return stamp(packet, this.id, { summary: 1 });
      },
  };
  ```

- **Packet** — один растущий конверт (`type: 'aj/packet'`), течёт stage→stage,
  обогащаясь на каждом шаге (см. `createPacket()`).
- **`ctx`** даёт оркестратор: `{ store, bus, C, alive, log:{debug,info,warn,error} }`.
  `log` пишет под id `auto-jobs`; `alive()` позволяет длинным стейджам
  (paced-приём в JOB_ACCEPTION) бросить работу сразу при STOP.
- **Node ids — единый источник правды.** Каждый узел флоучарта объявлен в
  `constants.AJ.NODE.*`. Оркестратор штампует активный узел в
  `STORAGE_LOCAL.AJ_PIPELINE_STATE`, а компактный статус пайплайна
  (`COR3.uiComponents.flowMap` — readout в `flow-map.js`, бывший SVG Flow Map
  убран) читает те же id и подписывает активный узел.
- **Загрузка:** `pipeline.js` в manifest идёт ДО `auto-jobs.js` (оркестратор
  читает стейджи на `start()`).

Новый стейдж: добавить объект в `pipeline.js` + экспорт в `stages`, узел в
`constants.AJ.NODE`, вызов в нужном месте `_runCycle()` оркестратора и
(если нужна читаемая метка в статусе) запись в `LABELS` в `flow-map.js`.

### Game module (MAIN world)

Делает что-то с DOM игры или с WebSocket'ом.

Шаблон: `src/modules/game/loadout-panel.js`.

Регистрация в `manifest.content_scripts[0].js` (MAIN). Helpers экспортируем
на `root.COR3.game.<id>` для вызова из других модулей:

```js
root.COR3.game = root.COR3.game || {};
root.COR3.game.foobar = { open, close, find };
```

### Job flow (MAIN world)

Один тип job для Auto Jobs пайплайна. Слушает `MSG.AUTOJOBS.FLOW_START` для
своего `jobType` и отвечает `MSG.AUTOJOBS.FLOW_RESULT`. Локальный flow
(file_decryption) исполняется сам; SAI-типы строятся фабрикой `_sai-flow.js`
(connect + Active-Access/hack login, затем get.*/mutate.* по WS, затем
`job.complete`).

Шаблон: `src/modules/game/flows/auto-jobs/file-decryption.js` (локальный) или
`src/modules/game/flows/auto-jobs/_sai-flow.js` (фабрика для SAI-типов).

```js
class FoobarFlow extends Module {
    constructor() {
        super({
            id: 'flow-foobar',
            name: 'Flow: Foobar',
            category: C.CATEGORY.GAME,
            owns: { busTypes: [MSG.AUTOJOBS.FLOW_START, MSG.AUTOJOBS.FLOW_RESULT] },
        });
    }
    async start() {
        this.track(Bus.window.on(MSG.AUTOJOBS.FLOW_START, async (env) => {
            if (env.jobType !== 'foobar') return;   // not my type
            // ...do the work; report sub-steps via MSG.AUTOJOBS.FLOW_STEP...
            // result: { jobId, marketId, success, didWork, retryable, reason }
            Bus.window.post(MSG.AUTOJOBS.FLOW_RESULT, await run(env));
        }));
    }
}
```

Также добавить:
- `FLOW.FOOBAR` (`'foobar'`) в `constants.js`
- case в `detectJobType()` + парсинг условий в `auto-jobs/pipeline.js`
- ветку в orchestrator JOB_FLOW batch dispatch (`auto-jobs.js`)
- регистрация в `manifest.content_scripts[0].js`

### Solver module (MAIN world)

Реактивно решает ин-гейм минигру при появлении.

Шаблон: `src/modules/solvers/decrypt.js`. Слушает старт через
`MSG.SOLVER.START_*`, опрашивает DOM, решает, ждёт следующего вызова.

### Appearance module (isolated world)

CSS-инжекция / DOM-удаление. Storage-driven.

Шаблон: `src/modules/appearance/system-messages.js`.

### UI section (popup context)

**Не Module** — отдельный паттерн. Регистрируется на `COR3.ui.<id>`
с `mount(el)` / `activate(el)` / `deactivate(el)` хуками. Шелл
([src/ui/shell.js](../src/ui/shell.js)) вызывает их при переключении
вкладок. Шаблон: `src/ui/sections/overview.js`.

Добавить:
- `<script src="sections/<id>.js"></script>` в `popup.html`
- запись `{ id, label }` в массив `TABS` в `shell.js`
- `<section data-tab="<id>" id="section-<id>">` в `popup.html` body

**Важно:** для активной (initial) вкладки шелл вызывает `mount()` *и* сразу
`activate()`. Если оба зовут `render()`, а сам `render()` async (await
Store), то оба `container.innerHTML = ''` отработают **до** первых
`appendChild` и контент задвоится. Поэтому в `mount()` ставь только
подписки (`Store.local.onChanged` и т.п.), а первый рендер делай в
`activate()`. См. `overview.js` / `expeditions.js`. Этот баг укусил
overview и logs-panel в мае 2026; не наступай ещё раз.

## Тонкости

- **Порядок загрузки.** Файлы content_scripts грузятся по порядку в один
  контекст. `constants.js`, `bus.js`, `store.js`, `logger.js`, `module.js`,
  `registry.js` должны идти **до** любых модулей. См.
  [architecture.md → Boot order](architecture.md#boot-order).
- **Идемпотентность.** Регистрация одного и того же `id` дважды → warn
  в `cor3_logs['registry']`, второй экземпляр игнорируется. Каждая
  фича-IIFE сама проверяет: `if (root.COR3.constants) return;` и аналог.
- **Ошибки не валят Registry.** Исключение в `init()` или `start()`
  логируется в `cor3_logs[<id>]`, но Registry продолжает работать
  с остальными модулями.
- **Cascade-stop.** Выключение `loadout-panel` через Module Manager
  останавливает всех, у кого `loadout-panel` в `dependsOn` (например, все
  flow-модули). При повторном включении — каскадный re-start.
- **MAIN-world Module Manager не работает.** См.
  [debugging.md → "Module Manager toggles do nothing for MAIN modules"](debugging.md#module-manager-toggles-do-nothing-for-main-modules).
- **`this.track()` обязательно** для каждой подписки, иначе после `stop()`
  останется висеть слушатель и при повторном `start()` будут дубли.
