# Module Spec

Контракт всех фич COR3 Helper. Каждая фича — отдельный класс-наследник `COR3.Module`, зарегистрированный в `COR3.Registry`. Контекст исполнения (MAIN content world / isolated content world / background SW / popup) определяется тем, в каком entry-файле модуль регистрируется.

## Жизненный цикл

```
register()  →  init()  →  start()  ⇄  stop()
```

| Хук     | Когда вызывается                                                  | Что делать                                              |
|---------|-------------------------------------------------------------------|---------------------------------------------------------|
| `init`  | один раз при `Registry.boot()` независимо от `enabled`            | Подготовка, не имеющая видимых сайд-эффектов            |
| `start` | при `boot()` если `enabled=true`, или после переключения свича    | Подписки на bus / storage, запуск таймеров              |
| `stop`  | при выключении модуля или при cascade-stop (выключен upstream)    | Снятие подписок, остановка таймеров                     |

`start`/`stop` могут вызываться многократно. Регистрируйте все подписки через `this.track(unsubscribe)` — Module.\_runStop() автоматически их вызовет.

## Объявление модуля

```js
// src/modules/automation/example.js
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    class ExampleModule extends Module {
        constructor() {
            super({
                id: 'example',
                name: 'Example',
                category: C.CATEGORY.AUTOMATION,
                dependsOn: ['market'],   // upstream module ids
                owns: {
                    storageKeys: ['exampleSetting'],
                    busTypes: [C.MSG.GAME.OPEN_NETWORK_MAP],
                },
                defaultEnabled: true,
                defaultLogsEnabled: true,
            });
        }

        async init() {
            this.debug('init');
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.MARKET, (env) => {
                this.info('market frame', { count: env.data?.length });
            }));
            this.track(Store.local.onChanged((changes) => {
                if (changes.marketData) this.handleMarket(changes.marketData.newValue);
            }));
        }

        async stop() {
            // tracked unsubscribes run automatically
        }

        handleMarket(data) { /* ... */ }
    }

    Registry.register(new ExampleModule());
})();
```

## Контракт каждого модуля

| Поле              | Обязательно | Описание                                                            |
|-------------------|-------------|---------------------------------------------------------------------|
| `id`              | да          | kebab-case, уникален. Используется как ключ в `chrome.storage.sync.modules` и в логе |
| `name`            | да          | человекочитаемое имя для UI                                          |
| `category`        | да          | одно из `CATEGORY.*` — для группировки в Module Manager              |
| `dependsOn`       | нет         | массив id модулей, от которых зависит. Registry соблюдает порядок старта |
| `owns.storageKeys`| нет         | storage-ключи, которые модуль читает/пишет. Чистая документация для будущей поддержки. |
| `owns.busTypes`   | нет         | bus-типы, которые модуль слушает или эмитит. Документация.           |
| `defaultEnabled`  | нет         | `true` по умолчанию                                                  |
| `defaultLogsEnabled` | нет      | `true` по умолчанию                                                  |

## Логирование

```js
this.debug('msg', ctx);  // тонкие детали
this.info('msg', ctx);   // нормальные события
this.warn('msg', ctx);   // подозрительно, но не фатально
this.error('msg', ctx);  // ошибка, но модуль не падает
```

Все записи попадают в `chrome.storage.local.cor3_logs[<moduleId>]` (ring 200). UI читает их через `Logger.subscribe()` для live-стрима.

Если в Module Manager выключен «logs» для модуля — `this.log()` становится no-op.

## Зависимости

`dependsOn` — массив `id`. Registry делает топосортировку и стартует upstream первым. На циклах кидает `Error`. На неизвестные id (опечатки) пишет warn в лог 'registry' и пропускает.

При выключении модуля каскадно останавливаются те, кто его в `dependsOn` указывает.

## Storage

```js
const value = await Store.local.getOne('myKey', defaultValue);
await Store.local.setOne('myKey', value);
const unsub = Store.local.onChanged((changes) => { ... });
```

Локальные ключи — для game-data cache и runtime state, sync — для пользовательских настроек. Полный список в `src/shared/constants.js`.

## Bus

Два транспорта, **одинаковый envelope**: `{ type: string, payload?: any }`.

```js
// MAIN ↔ isolated content world (window.postMessage)
Bus.window.post(type, payload);
const unsub = Bus.window.on(type, (env) => { ... });

// isolated ↔ popup ↔ SW (chrome.runtime.sendMessage)
const reply = await Bus.runtime.send(type, payload);
const unsub = Bus.runtime.on(type, async (payload, sender) => { return reply; });
```

**Все типы должны жить в `src/shared/constants.js`** — никаких inline-строк в коде модулей.

## Контексты исполнения

| Контекст          | Что доступно                                          | Что НЕ доступно                          |
|-------------------|-------------------------------------------------------|------------------------------------------|
| MAIN content      | DOM, `window`, `WebSocket`, `fetch`, `Bus.window`     | `chrome.*`                                |
| Isolated content  | DOM (другая обёртка), `chrome.*`, `Bus.window`+`runtime` | `window`-методы из MAIN                |
| Background SW     | `chrome.*`, `Bus.runtime`                             | DOM, `window`, прямой доступ к WS        |
| Popup             | DOM popup-страницы, `chrome.*`, `Bus.runtime`         | DOM игровой страницы                     |

Модуль выбирает контекст по своей природе. Регистрируется в соответствующем entry-файле (Phase 2+).

## Как добавить новый модуль

1. Создаёшь файл в `src/modules/<category>/<id>.js`.
2. Внутри — IIFE, `class XxxModule extends COR3.Module`, `COR3.Registry.register(new XxxModule())`.
3. В нужном entry-файле (`src/entry/content.js` / `content-early.js` / `background.js` / `popup.js`) добавляешь файл в список загружаемых:
    - для content-script: добавь путь в `manifest.json` → `content_scripts[i].js`
    - для background SW: добавь в `background.scripts`
    - для popup: добавь `<script src="src/modules/.../my.js"></script>` в `src/ui/popup.html`
4. Если модуль владеет новыми storage-ключами или bus-типами — пропиши их в `src/shared/constants.js`.
5. Если у модуля есть юзер-настройки помимо master switch — Section в UI (Phase 5).

## Нюансы

- **Порядок загрузки:** Файлы в content_scripts загружаются по порядку в один контекст. `constants.js`, `bus.js`, `store.js`, `logger.js`, `module.js`, `registry.js` должны загружаться **до** любых модулей.
- **Идempotency:** регистрация одного и того же id дважды — silent (warn в лог), второй экземпляр игнорируется.
- **Errors не падают:** ошибка в `init()` или `start()` логируется, но Registry продолжает работать с остальными модулями.
