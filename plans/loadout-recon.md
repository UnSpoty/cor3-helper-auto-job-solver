# LOADOUT — разведка (2026-05-22)

> **Update 2026-05-22 (вторая итерация):** мутации (`equip.software`,
> `unequip.software`, `equip.hardware`) разведаны — см. раздел
> **«Mutation actions (captured)»** ниже. POWER toggle оказался чисто
> клиентским (localStorage), без WS-обмена.


Точечный отчёт о вкладке **Снаряжение / LOADOUT** на cor3.gg, собранный через
chrome-devtools-mcp на залогиненной сессии (PATHFINDER, FREEL_019D98EC-87D5).
Цель: научить расширение читать loadout и (позже) менять его, плюс использовать
данные в Auto-Jobs.

## TL;DR

- LOADOUT — это отдельное desktop-приложение (последняя иконка в dock,
  компонент `loadout-tab-bar-item.tsx`).
- Открытие приложения шлёт WS `join-room` с `{room: "loadout"}` и в ответ
  получает один большой msgpack-фрейм `event: "loadout"`,
  `action: "get.options"` со ВСЕМ снаряжением и ресурсами.
- Этого фрейма достаточно, чтобы:
  - вычислить динамический allow-list расширений файлов для
    `file_decryption` / `decrypt_extract` (через
    `equippedSoftware[].specs[type=="DECRYPT"].fileTypes`),
  - заранее отклонять `ip_injection` / `ip_cleanup` / `data_download` /
    `file_upload` / `log_*` если в loadout нет ничего с
    `specs[type=="HACK"]`,
  - заранее отклонять `data_download` если нет
    `specs[type=="SEARCH"]` (нужно проверить — см. «Открытые вопросы»),
  - показать в popup инфу «можешь ли ты вообще играть» (`resources.canBoot`).
- Мутирующие операции (CHANGE железа, INSTALL/UNINSTALL софта, POWER ON/OFF,
  Сброс) не трогали — ждём явного разрешения юзера, потому что они меняют
  игровое состояние. Названия WS-action для них пока неизвестны.

---

## 1. UI и иконка

- Dock = `div.go2090060298`, 13 элементов.
- LOADOUT-иконка — `children[12]`, отличается от остальных классом
  `go3222340407` (vs `go2460475144` для обычных) и содержит компонент
  `loadout-tab-bar-item.tsx`.
- Раскладка приложения (после открытия):
  - **Левая колонка**: визуализация сервер-рэка (картинка), 4 слота
    железа (CPU/GPU/RAM/PSU), таблица "Тип / Использование / Доступно"
    (ЧАСТОТА CPU, ЯДРА CPU, МОЩНОСТЬ GPU, ПАМЯТЬ GPU, ЧАСТОТА RAM,
    ПАМЯТЬ RAM, МОЩНОСТЬ PSU).
  - **Шапка**: кнопка `POWER ON`, Назад, Отменить действие, Помощь,
    «Восстановить до последней сессии», «Сброс».
  - **Правая колонка**: список программ с фильтрами «Сортировать по / Все
    / Поиск», у каждой карточка с ФУНКЦ (DECRYPT/HACK/SEARCH X/Y),
    блоком ТРЕБУЕТСЯ БАЗОВОЕ (cpu/gpu/ram requirements) и кнопкой
    `УСТАНОВИТЬ` или `УДАЛИТЬ`.

### React-компоненты (найдены через walk fiber):

| Компонент | Props | Что делает |
|---|---|---|
| `Pe` | `hardware, onInfo, actions` | Один слот железа (CPU/GPU/RAM/PSU карточка слева) |
| `Ne` | `equippedHardware, onChoose` | Контейнер всех 4 слотов; `onChoose(category)` открывает модалку выбора |
| `Ft` | `software, isEquipped` | Карточка одной программы справа |
| `ha` | `ownedSoftware, equippedSoftware` | Список программ |
| `$k` | `url, getAuth, isInitiated` | WS-провайдер; `url == "wss://svc-corie.cor3.gg"` |

### Обработчики действий:

```js
onInfo  = () => G(le.HARDWARE_INFO, {hardware: i})    // открывает modal info
onChoose = e => G(le.HARDWARE_SELECT, {category: e})  // CPU/GPU/RAM/PSU
onBack  = () => oC.set("os")                          // вернуться на десктоп
```

`G(le.X, payload)` — диспатчер модалок, `le` — enum модалок. Реальные
мутации (выбор железа из модалки, install/uninstall, power, reset)
скрыты внутри их собственных компонентов — не дампали (нужны клики).

---

## 2. WebSocket-протокол

### Транспорт

- URL: `wss://svc-corie.cor3.gg:443/socket.io/?language=ru-RU&EIO=4&transport=websocket`
- Socket.IO v4 поверх WebSocket.
- Engine.IO control-фреймы текстовые (`0{sid,...}`, `2` ping, `3` pong).
- Все Socket.IO-уровневые фреймы — **бинарные msgpack** с конвертом
  `{ type, data, nsp }` (см. `src/shared/ws-frames.js` — поддержка уже
  есть).

### Frame для loadout

**outbound (open LOADOUT):**

```js
{
  type: 2,
  nsp: "/",
  data: ["join-room", { room: "loadout", jwtToken: "Bearer ..." }]
}
```

(размер ≈ 418 байт — почти весь JWT)

**inbound (initial snapshot):**

```js
{
  type: 2,
  nsp: "/",
  data: ["loadout", {
    event:     { name: "loadout", action: "get.options" },
    requestId: "<uuid>",
    data:      { ownedHardware, ownedSoftware, equippedHardware,
                 equippedSoftware, resources }
  }]
}
```

(размер ≈ 16 KB у нашего тестового аккаунта)

### Реальный ответ get.options (сокращённо)

```jsonc
{
  "ownedHardware": [
    {
      "id": "019d5a00-0001-7000-8000-000000000001",
      "category": "CPU",                    // CPU | GPU | RAM | PSU
      "name": "Hex Lattice 14+",
      "manufacturer": "ViiBot",
      "description": "...",
      "image": "https://cdn.cor3.gg/.../hardware_hex_lattice_14+.png",
      "tier": 2,                            // 1..3 (на нашем аккаунте)
      "price": 21800,
      "itemVulnerability": 30,              // %, чем меньше тем лучше
      "specs": {                            // shape зависит от category
        "cpuFrequency": 14.6,               //   CPU: cpuFrequency, cpuCores, cpuConsuming
        "cpuCores":     6,                  //   GPU: gpuPower, gpuMemory, gpuConsuming
        "cpuConsuming": 1.25                //   RAM: ramFrequency, ramMemory
      },                                    //   PSU: psuPower, psuProtection
      "isNew": false
    }
    // ... ещё 12 элементов: 4 CPU, 2 GPU, 4 RAM, 3 PSU на нашем аккаунте
  ],
  "ownedSoftware": [
    {
      "id":           "019d0b28-3af7-764a-9c73-32f00b7d2ef4",
      "name":         "Cypher+ v1.4",
      "manufacturer": "CORIE",
      "description":  "...",
      "image":        "https://cdn.cor3.gg/.../software_cypher_v1.4.png",
      "tier":         1,
      "price":        5600,
      // Что ПО ест из ресурсов:
      // Каждый поле — массив [low, mid?, high]; UI показывает low/high как "ТРЕБУЕТСЯ БАЗОВОЕ"
      "consuming": {
        "cpu_frequency": [5,    14.4],
        "cpu_cores":     [1, 2,  6],
        "gpu_power":     [0.06, 0.44, 0.88],
        "gpu_memory":    [0.1,  0.2,  0.34],
        "ram_frequency": [0.4,  1.2],
        "ram_memory":    [1.3,  2.5,  6]
      },
      // ЧТО ПО умеет — ключевая часть для Auto-Jobs!
      "specs": [
        {
          "type":      "DECRYPT",           // DECRYPT | HACK | SEARCH
          "fileTypes": [".eb52x", ".ab52p"],// только для DECRYPT
          "power":     [8, 25],             // min/max power, зависит от железа
          "remote":    false                // true = можно делать remote (DARK/SRM?)
        }
      ],
      "isNew": false
    }
    // ... 6 штук на нашем аккаунте
  ],
  "equippedHardware": {
    "cpu": { ...один из ownedHardware с category==CPU },
    "gpu": { ... },
    "ram": { ... },
    "psu": { ... }
  },
  "equippedSoftware": [
    // подмножество ownedSoftware которое включено (УДАЛИТЬ кнопка вместо УСТАНОВИТЬ)
  ],
  "resources": {
    "supply": {                             // что даёт equipped железо
      "cpu_frequency": 14.6,
      "cpu_cores":     6,
      "gpu_power":     1.03,
      "gpu_memory":    1.5,
      "ram_frequency": 1.46,
      "ram_memory":    10,
      "psu_power":     3
    },
    "demand": {                             // что съел equipped софт
      "cpu_frequency": 12.5,
      "cpu_cores":     2,
      "gpu_power":     0.27,
      "gpu_memory":    0.27,
      "ram_frequency": 0.95,
      "ram_memory":    8.4,
      "psu_total":     2.85
    },
    "canBoot": true,                        // система запускается? (POWER ON активна)
    "softwarePower": [
      { "moduleId": "019d0b28-...", "ratio": 1.0,
        "abilities": [{ "type": "DECRYPT", "computedPower": 38 }] },
      { "moduleId": "019dd91b-...", "ratio": 0.344,
        "abilities": [{ "type": "DECRYPT", "computedPower": 25 }] }
      // ratio — насколько железо удовлетворяет нужды софта (1.0 = идеально).
      // computedPower — фактическая операционная мощность для каждой abilities[].type.
    ]
  }
}
```

### Полный список нашего аккаунта (на момент разведки)

**Equipped hardware:**
- CPU: Hex Lattice 14+ (tier 2, 14.6 GHz, 6 cores, 30% vuln)
- GPU: Force Recon 13D (tier 1, 1.03 PFLOPS, 1.5 TB)
- RAM: C-Stack 10.8 (tier 3, 1.46 GHz, 10 TB)
- PSU: IP-Feichang K3S6 (tier 3, 3 kW, 45% protection)

**Owned software (6 шт.):**
- Cypher+ v1.4 (t1) — DECRYPT [.eb52x, .ab52p] P=8/25
- Porter-lite r4 (t1) — HACK P=6/17
- Seeker-IV v0.6 (t1) — SEARCH P=4/18
- 5CRYPt0L 09 (t2) — DECRYPT [.eb52x, .ab52p, .eb54x] P=14/38  **equipped**
- Lyapun AA8 (t3) — DECRYPT [.eb54x, .12vvsh, .xvct] P=20/35  **equipped**
- A/Bver 410 (t3) — HACK P=12/26; SEARCH P=6/22

**Эффективный allow-list расширений на этом аккаунте:**
`.eb52x ∪ .ab52p ∪ .eb54x ∪ .12vvsh ∪ .xvct`

Заметь — `.12vvsh` не было в моей памяти `feedback_minigame_file_allowlist`
(там `.eb52x/.eb54x/.ab52p/.tar.ab52p`). Память **устарела** на 5 дней; кроме
того, никакого `MINIGAME_FILE_EXTS` в текущем коде нет (`grep` ничего не
нашёл — допустимо, что было удалено или вообще не закоммитили). Динамический
allow-list из equippedSoftware **заменяет** этот хардкод по дизайну.

**Equipped HACK софта: НЕТ.** Значит, на этом аккаунте ip_injection /
ip_cleanup / log_deletion / log_download / file_elimination / data_download /
file_upload **не могут быть выполнены** прямо сейчас — нужно сначала
установить Porter-lite r4 или A/Bver 410.

---

## 3. План интеграции в наш код

### Шаг 1 — данные на стороне MAIN (interceptor)

В `src/interceptors/ws-interceptor.js` в `dispatchEvent` добавить:

```js
if (eventName === 'loadout' && payload && payload.data) {
    post(MSG.WS.LOADOUT, { data: payload.data });
    return;
}
```

В `src/shared/constants.js`:

```js
MSG.WS.LOADOUT = 'COR3_WS_LOADOUT';
STORAGE_LOCAL.LOADOUT    = 'loadoutData';
STORAGE_LOCAL.LOADOUT_AT = 'loadoutDataUpdatedAt';
```

### Шаг 2 — data-модуль `src/modules/data/loadout.js`

По шаблону `src/modules/data/stash.js`:

- Подписывается на `MSG.WS.LOADOUT` через `this.track`.
- Пишет в `chrome.storage.local[STORAGE_LOCAL.LOADOUT]` весь объект +
  вычисляет «удобные» производные поля (хранить ВСЁ — лишних 16 КБ —
  чтобы UI не дёргал ws):
  - `decryptExtensions` = `Set( ⋃ equippedSoftware[].specs[t=DECRYPT].fileTypes )`
  - `capabilities` = `Set` из `equippedSoftware[].specs[].type`
    (например `{ "DECRYPT", "HACK" }`)
  - `canBoot` = `resources.canBoot`
- Регистрирует ID `loadout` в `Registry`. Категория `data`.
- Добавить путь файла в `manifest.json` рядом с `stash.js` (тот же
  content_scripts блок, isolated world).

### Шаг 3 — Auto-Jobs planner uses loadout

В `src/modules/automation/auto-jobs/planner.js`:

- Загружать `loadoutData` параллельно с другими сторами в начале цикла.
- Новые reject-причины:
  - `reject:no-decrypt-software` — для `file_decryption` / `decrypt_extract`,
    если `capabilities` не содержит `DECRYPT`.
  - `reject:unsupported-file-type` — если расширение `fileCondition` не
    в `decryptExtensions` (берётся `endsWith(.ext)` или substring после
    последней `.`).
  - `reject:no-hack-software` — для `ip_injection`, `ip_cleanup`,
    `log_deletion`, `log_download`, `file_elimination`, `file_upload`
    если в `capabilities` нет `HACK`. (Нужно подтвердить экспериментом
    — см. «Открытые вопросы».)
- Возможно: `reject:system-offline` если `canBoot === false` (юзер
  выключил систему / не хватает PSU).

### Шаг 4 — popup UI

Маленький блок в Overview-секции:

```
[💻] Loadout
  CPU 12.5/14.6 GHz   GPU 0.27/1.03 PFLOPS
  RAM 8.4/10 TB       PSU 2.85/3 kW
  Decrypt: .eb52x .ab52p .eb54x .12vvsh .xvct
  Hack:    ✗ (нет ПО)
  Search:  ✗ (нет ПО)
```

Это даёт юзеру моментально понять, почему Auto-Jobs пропускает
определённые типы джоб.

### Шаг 5 — refresh

LOADOUT-фрейм приходит только при открытии окна. Чтобы получить свежие
данные без F5:

1. **Пассивно**: подписаться на любые `loadout`-фреймы с `action: "update"`
   (если сервер их шлёт после CHANGE/INSTALL — не проверяли).
2. **Активно**: повторить `join-room {room: "loadout"}`. На прочих
   модулях (mercenaries, market) это работает — сервер отвечает свежим
   snapshot. Не тестировали для loadout.

Для MVP оба варианта не нужны: data-модуль кэширует snapshot из
первого open, и юзер сам открывает LOADOUT когда сменил железо/софт.

---

## Mutation actions (captured 2026-05-22, second pass)

Все три мутации идут по тому же envelope-шаблону что и read-операция
(`event` event, `loadout` event-name, action-suffix снизу). Только
**ключ `options.compress` тут `true`**, а не `false` как у наших RPC
(`market`, `expeditions`). Сервер примет любой — но если хочется быть
бит-в-бит изоморфным с тем что шлёт сайт, ставим `true` для loadout.

Аккаунт-ID в `data.moduleConfigId` — это `id` соответствующего
hardware или software item-а из snapshot'а (`ownedHardware[].id` или
`ownedSoftware[].id`). Категория железа НЕ нужна в payload —
сервер её сам выводит по hwId (id уже знает к чему привязан).

### `loadout / equip.software`

```jsonc
{
  "type": 2,
  "data": ["event", {
    "event":   { "name": "loadout", "action": "equip.software" },
    "data":    { "moduleConfigId": "<ownedSoftware[].id>" }
  }],
  "options": { "compress": true },
  "nsp":     "/"
}
```

Кладёт указанный софт в `equippedSoftware`. Ответ — полный
`loadout` snapshot (та же форма что и от `get.options`, только
`event.action === "equip.software"`).

### `loadout / unequip.software`

То же самое, action заменён на `unequip.software`. payload идентичен.

### `loadout / equip.hardware`

Тот же envelope, action `equip.hardware`, `moduleConfigId` это
`ownedHardware[].id`. Категория слота определяется сервером — он
сам знает что Hex Lattice 14+ это CPU. Свапает текущий equipped HW
этой категории на указанный.

### POWER toggle — **НЕ WS**

Кнопка POWER ON/OFF в LOADOUT-app шапке — чисто клиентское
переключение. onClick (взято из React props):

```js
() => {
  const e = !Q.get();                            // Q — внутренний observable
  Q.set(e);
  localStorage.setItem(L.LoadoutPowered, JSON.stringify(e));
  // потом показывает тост "powerOn" / "powerOff.toggle"
}
```

То есть состояние хранится только в `localStorage["loadout-powered"]`
(JSON-boolean) и в in-memory observable. На сервер не уходит ничего.
`resources.canBoot` в snapshot'е — это лишь «хватает ли ресурсов для
включения», а не «включено сейчас или нет». Похоже, что серверу всё
равно: оно либо работает (canBoot=true) либо нет.

**Вывод для нашей панели:** для toggle делаем простое чтение и запись
`localStorage["loadout-powered"]`. Никакого `wsSendRpc` не нужно.
Чтобы родной UI cor3.gg тоже подхватил наш toggle (а не только наш
панельный индикатор), при изменении ещё диспатчим `storage` event
вручную — для same-window cor3.gg react-нативно слушает observable Q,
который завязан только на тот же `localStorage.setItem`, так что без
лишних триггеров React не подхватит. Минимум для версии — обновлять
только наш индикатор; cor3.gg-UI подхватит при следующем re-mount
LOADOUT-окна.

## 4. Открытые вопросы / следующая разведка

Эти пункты требуют **активных кликов** (мутации) и должны делаться с
явного разрешения юзера, идеально на отдельном dev-аккаунте:

1. **WS-action для CHANGE-hardware.** Какой outbound фрейм шлёт
   `loadout-row-select` в модалке "Добавить CPU"? Вероятные кандидаты:
   - `event: "loadout"`, `action: "change.hardware"`, `data: {category, hardwareId}`
   - либо отдельный namespace типа `loadout/change`
2. **WS-action для INSTALL/UNINSTALL software.** Кнопка `УСТАНОВИТЬ` /
   `УДАЛИТЬ`. Очевидные кандидаты: `install.software` / `uninstall.software`
   с `{softwareId}`.
3. **POWER ON/OFF.** Кнопка сверху. Скорее всего `power.toggle` или
   `boot` / `shutdown`.
4. **«Сброс» и «Восстановить до последней сессии».** Что они делают
   серверу? Какой rollback-семантика? Безопасно ли использовать «откат»
   программно?
5. **Action "update".** Шлёт ли сервер пуш-обновления loadout, или
   данные обновляются только в ответ на наши RPC-запросы?
6. **SEARCH-софт.** Под какие именно job-types он нужен? Кандидаты:
   `data_download` (Seeker, A/Bver). Нужно проверить — сейчас на нашем
   аккаунте SEARCH-софта нет в equipped, но есть в owned, можно
   попробовать включить и посмотреть, какие job-types перестали падать.
7. **`specs[].remote: bool`.** Когда true? Только у софта, который
   умеет работать с DARK Market / SRM Market? Нужны примеры с
   `remote: true` для подтверждения.
8. **`itemVulnerability`** на hardware — влияет на что? Возможно
   уязвимость к атакам из network-map (если кто-то нас взламывает).
   Out of scope для Auto-Jobs, но интересно для UI.

---

## 5. Артефакты разведки

Сессия в DevTools, использованные инструменты:

- WebSocket-hook был установлен через `initScript` при reload-навигации
  и логировал ВСЕ msgpack-фреймы (полные байты, не truncated).
- msgpack decoder (мини-копия `src/shared/ws-frames.js mpDecode`)
  использовался для распаковки.
- React fiber walk от leaf-элемента с текстом "hex lattice" вверх до
  компонента `$k` (WS-провайдер).
- Скрипты в `window.__cor3_ws_log` / `window.__cor3_ws_bin` /
  `window.__cor3_decode` остаются доступны в текущей сессии браузера
  для дополнительных запросов (но при F5 сбросятся).

Скриншоты:
- `C:\Users\Admin\AppData\Local\Temp\chrome-devtools-mcp-BWmhCf\screenshot.png`
  — основной экран LOADOUT.

---

## 6. Mini-changelog для существующих memo

- `feedback_minigame_file_allowlist.md` устарел: (а) текущий код
  **не содержит** `MINIGAME_FILE_EXTS`, (б) реально владимый
  allow-list на этом аккаунте включает `.12vvsh` и `.xvct` которые в
  памяти не упоминаются. После реализации Шага 2 эту память можно
  заменить на новую: "allow-list расширений вычисляется из
  loadout.equippedSoftware[].specs[type==DECRYPT].fileTypes, не из
  хардкода".
