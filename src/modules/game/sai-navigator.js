// src/modules/game/sai-navigator.js
// Owns: SAI (Server Administration Interface) navigation primitives.
//   • findOrOpenSai(serverName) — high-level "get SAI ready or fail"
//   • closeAllSaiTerminals
//   • navigateToSection(sai, sectionSel) — switch SAI tabs
//   • waitForSaiContent / waitForServerAccess
//   • addIpViaModal — Transit-tab Add-IP dialog
//   • findRowByIconAndName + log/file row finders
//   • findFileInDownloads
//   • confirmDeleteDialog
//   • downloadsWatcher — singleton tracking Downloads folder file diffs
// Depends on: network-map, server-connect.
// Exposes: COR3.game.sai.*

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const NM = root.COR3.game && root.COR3.game.networkMap;
    const SC = root.COR3.game && root.COR3.game.serverConnect;
    if (!NM || !SC) {
        console.error('[COR3.sai-navigator] network-map and server-connect must load first');
        return;
    }

    const SEL = {
        APP:           '[data-sentry-component="ServerAdministrationInterfaceApplication"]',
        CLOSE_BTN:     '[data-sentry-component="CloseApp"]',
        TITLE:         '[data-sentry-element="SaiHeaderTitleStyled"]',
        TAB:           '[data-sentry-element="SaiTabStyled"]',
        ADD_BTN:       '[data-sentry-element="SaiAddButtonStyled"]',
        MODAL:         '[data-sentry-component="SaiAddIpModal"]',
        MODAL_INPUT:   '[data-sentry-element="SaiModalInputStyled"]',
        MODAL_BTN:     '[data-sentry-element="SaiModalButtonStyled"]',
        SCROLL:        '[data-sentry-element="SaiScrollContainerStyled"]',
        DELETE_MODAL:  '[data-sentry-element="SaiDeleteModalStyled"]',
        DELETE_CONFIRM:'[data-sentry-element="SaiDeleteConfirmButtonStyled"]',
        // Tabs / sections
        LOGS:          '[data-sentry-component="SaiLogs"]',
        FILES:         '[data-sentry-component="SaiFiles"]',
        TRANSIT:       '[data-sentry-component="SaiTransit"]',
        // Icons
        LOG_ICON:      '[data-sentry-component="LogIcon"]',
        DOWNLOAD_ICON: '[data-sentry-component="DownloadIcon"]',
        TRASH_ICON:    '[data-sentry-component="TrashIcon"]',
        FILE_ICON:     '[data-sentry-component="FileIcon"]',
        // Application-widget wrapper (close button climbs to here)
        APP_WIDGET:    '[data-sentry-component="ApplicationWidget"]',
        // Downloads folder app
        FOLDER_APP:    '[data-component-name="FolderApplication"]',
        DOWNLOADS_SHORTCUT: '[data-sentry-component="Shortcut"]',
        NOTIFICATION_ICON:  '[data-sentry-component="NotificationIcon"]',
    };

    // ─── Downloads folder watcher (singleton) ─────────────────────────────
    const downloadsWatcher = (() => {
        let _snapshot = new Set();

        function _scan() {
            const app = document.querySelector(SEL.FOLDER_APP);
            const names = new Set();
            if (!app) return names;
            for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                const nameDiv = [...item.children].find((c) => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
                const name = nameDiv?.textContent.trim().toLowerCase();
                if (name) names.add(name);
            }
            return names;
        }

        async function _ensureOpen(timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline && !root.__jobManagerAbort) {
                if (document.querySelector(SEL.FOLDER_APP)) return document.querySelector(SEL.FOLDER_APP);
                const shortcut = [...document.querySelectorAll(SEL.DOWNLOADS_SHORTCUT)]
                    .find((s) => s.textContent.trim().toLowerCase().includes('downloads'));
                if (shortcut) {
                    shortcut.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
                    await dom.sleep(600);
                } else {
                    await dom.sleep(400);
                }
            }
            return document.querySelector(SEL.FOLDER_APP);
        }

        return {
            snapshot() { _snapshot = _scan(); },
            async arm(timeoutMs = 15_000) {
                const folder = await _ensureOpen(timeoutMs);
                _snapshot = _scan();
                return folder;
            },
            async openFolder(timeoutMs = 15_000) { return _ensureOpen(timeoutMs); },
            async waitForNewFile(timeoutMs = 30_000) {
                const before = _snapshot;
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline && !root.__jobManagerAbort) {
                    const app = document.querySelector(SEL.FOLDER_APP);
                    if (app) {
                        for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                            const badge = item.querySelector(SEL.NOTIFICATION_ICON);
                            if (badge && badge.textContent.trim().toUpperCase() === 'NEW') return item;
                            const nameDiv = [...item.children].find((c) => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
                            const name = nameDiv?.textContent.trim().toLowerCase() || '';
                            if (name && !before.has(name)) return item;
                        }
                    }
                    await dom.sleep(300);
                }
                return null;
            },
        };
    })();

    // Take a baseline snapshot ASAP — files already in Downloads must NOT
    // count as "new" once a flow runs.
    downloadsWatcher.snapshot();

    // ─── SAI helpers ──────────────────────────────────────────────────────
    async function closeAllSaiTerminals() {
        const apps = [...document.querySelectorAll(SEL.APP)];
        if (!apps.length) return;
        Bus.window.post(C.MSG.JOB.LOG, { msg: `Closing ${apps.length} open SAI terminal(s) before starting`, level: 'info' });
        for (const sai of apps) {
            const widget = sai.closest(SEL.APP_WIDGET);
            if (!widget) continue;
            const closeBtn = widget.querySelector(SEL.CLOSE_BTN);
            if (closeBtn) {
                dom.clickEl(closeBtn);
                await dom.sleep(300);
            }
        }
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && document.querySelector(SEL.APP)) {
            await dom.sleep(200);
        }
    }

    async function navigateToSection(sai, sectionSel) {
        if (sai.querySelector(sectionSel)) return true;
        // The SAI app element appears in the DOM before React mounts its
        // tab strip — a same-tick querySelectorAll(SEL.TAB) on a freshly-
        // opened SAI returns []. Bailing on that yields a false-negative
        // "no Logs section" verdict that aborts the current attempt —
        // poll for tabs first.
        let tabs = [];
        for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
            tabs = [...sai.querySelectorAll(SEL.TAB)];
            if (tabs.length) break;
            await dom.sleep(200);
        }
        if (!tabs.length) return false;
        for (const tab of tabs) {
            dom.clickEl(tab);
            // Poll up to ~1.6 s for the section to mount instead of a
            // single 400 ms snapshot — a slow first activation used to
            // make the loop step on to the next tab and displace the one
            // we actually wanted.
            for (let j = 0; j < 8 && !root.__jobManagerAbort; j++) {
                await dom.sleep(200);
                if (sai.querySelector(sectionSel)) return true;
            }
        }
        return false;
    }

    async function waitForSaiContent(sai, timeoutMs = 5_000) {
        return !!(await dom.waitForEl(() => sai.querySelector(SEL.SCROLL), { timeout: timeoutMs }));
    }

    function hasServerAccess(sai) { return !!sai.querySelector(SEL.TAB); }

    async function waitForServerAccess(sai, _serverName) {
        for (let i = 0; i < 10; i++) {
            if (hasServerAccess(sai)) return true;
            await dom.sleep(500);
        }
        return false;
    }

    async function findOrOpenSai(serverName) {
        await closeAllSaiTerminals();
        await NM.ensureNetworkMapOpen(15_000);

        const ok = await SC.connect(serverName);
        if (!ok) return null;

        // Wait up to 15s for SAI app to appear after login. Periodic
        // breadcrumb every 2 s reports what we're actually seeing in the
        // DOM — visible in the activity log. Cheap insurance against the
        // "SAI opens then closes, no idea why" failure mode: if the title
        // is wrong, or another app is masquerading, the breadcrumb makes
        // it obvious without needing a console-level repro.
        const deadline = Date.now() + 15_000;
        let nextBreadcrumb = Date.now() + 2_000;
        while (Date.now() < deadline && !root.__jobManagerAbort) {
            const sai = SC.getSaiForServer(serverName);
            if (sai) return sai;
            if (Date.now() >= nextBreadcrumb) {
                const apps = Array.from(document.querySelectorAll(SEL.APP));
                const titles = apps.map((a) => {
                    const t = a.querySelector('[data-sentry-element="SaiHeaderTitleStyled"]');
                    return t ? `"${t.textContent.trim()}"` : '«no title»';
                });
                Bus.window.post(C.MSG.JOB.LOG, {
                    msg: `Waiting for SAI "${serverName}" — currently open: ${apps.length === 0 ? 'none' : titles.join(', ')}`,
                    level: 'debug',
                });
                nextBreadcrumb = Date.now() + 2_000;
            }
            await dom.sleep(400);
        }
        return null;
    }

    // ─── Add-IP modal ─────────────────────────────────────────────────────
    async function addIpViaModal(sai, ip) {
        const addBtn = sai.querySelector(SEL.ADD_BTN);
        if (!addBtn) return false;
        addBtn.click();
        await dom.sleep(400);

        const modal = await dom.waitForEl(SEL.MODAL, { timeout: 4_000 });
        if (!modal) return false;

        const input = modal.querySelector(SEL.MODAL_INPUT);
        if (!input) return false;
        dom.setReactInputValue(input, ip);
        await dom.sleep(200);

        const btns = modal.querySelectorAll(SEL.MODAL_BTN);
        const saveBtn = [...btns].find((b) => b.textContent.trim() === 'Save') || btns[btns.length - 1];
        if (!saveBtn) return false;
        saveBtn.click();

        for (let i = 0; i < 30; i++) {
            if (!document.querySelector(SEL.MODAL)) break;
            await dom.sleep(200);
        }
        await dom.sleep(400);
        return true;
    }

    async function confirmDeleteDialog() {
        await dom.sleep(250);
        const overlay = document.querySelector(SEL.DELETE_MODAL);
        if (!overlay || overlay.offsetParent === null) return;
        const confirmBtn = overlay.querySelector(SEL.DELETE_CONFIRM);
        if (confirmBtn) {
            confirmBtn.click();
            await dom.sleep(300);
        }
    }

    // ─── Row finders (Logs / Files tabs) ──────────────────────────────────
    // SaiFiles rows have no data-sentry-component on the FileIcon SVG, so an
    // icon-driven finder doesn't work there. Walk the ScrollArea container
    // directly: each top-level child div IS a row, no matter which tab. Same
    // helper handles SaiLogs (where LogIcon still exists).
    function rowsInSection(sai, sectionSel) {
        const section = sai.querySelector(sectionSel);
        if (!section) return [];
        const scroll = section.querySelector(SEL.SCROLL);
        if (!scroll) return [];
        // ScrollArea > inner-wrapper > rows…
        // The wrapper carries dynamic padding for the scrollbar; rows are its
        // direct children. Fallback to the ScrollArea itself if the layout
        // is ever simplified.
        const wrapper = scroll.querySelector('[data-component-name="ScrollArea"] > div')
                     || scroll.querySelector('[data-component-name="ScrollArea"]')
                     || scroll;
        return Array.from(wrapper.children);
    }

    function rowText(row) {
        return [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean).join(' ');
    }

    function findRowByName(sai, sectionSel, name) {
        const needle = name ? name.toLowerCase() : null;
        if (!needle) return null;
        for (const row of rowsInSection(sai, sectionSel)) {
            if (rowText(row).toLowerCase().includes(needle)) return row;
        }
        return null;
    }

    function findAllRowsByName(sai, sectionSel, name) {
        const needle = name ? name.toLowerCase() : null;
        if (!needle) return [];
        const out = [];
        for (const row of rowsInSection(sai, sectionSel)) {
            if (rowText(row).toLowerCase().includes(needle)) out.push(row);
        }
        return out;
    }

    function findLogRowByName(sai, logName)     { return findRowByName(sai, SEL.LOGS, logName); }
    function findAllLogRowsByName(sai, logName) { return findAllRowsByName(sai, SEL.LOGS, logName); }
    function findFileRowByName(sai, fileName)   { return findRowByName(sai, SEL.FILES, fileName); }
    function findAllFileRowsByName(sai, fileName){ return findAllRowsByName(sai, SEL.FILES, fileName); }

    function findLogRowByIndex(sai, logSeq) {
        const rows = rowsInSection(sai, SEL.LOGS);
        return (logSeq >= 0 && logSeq < rows.length) ? rows[logSeq] : null;
    }

    // Each Logs / Files row ends in an action area with a fixed pair of
    // buttons: [download, delete]. Files rows have no
    // DownloadIcon/TrashIcon data-sentry-components, so we use position-
    // based lookup — stable across both tabs.
    //
    // Returns null if the row has no action area (e.g. user scrolled past
    // the visible window — virtualised list).
    function rowActionButtons(row) {
        // Action area is the last child div of the row; it contains 2 <button>s.
        const action = row?.lastElementChild;
        const buttons = action ? action.querySelectorAll('button') : [];
        return buttons.length >= 2 ? { download: buttons[0], remove: buttons[1] } : null;
    }
    function clickRowDownload(row) {
        const btns = rowActionButtons(row);
        if (!btns) return false;
        dom.clickEl(btns.download);
        return true;
    }
    function clickRowRemove(row) {
        const btns = rowActionButtons(row);
        if (!btns) return false;
        dom.clickEl(btns.remove);
        return true;
    }

    async function findFileInDownloads(fileName, timeoutMs = 5_000) {
        if (!fileName) return null;
        const folder = await downloadsWatcher.openFolder(timeoutMs);
        if (!folder) return null;
        const needle = fileName.toLowerCase();
        for (const item of folder.querySelectorAll('.folder-application[data-app-id]')) {
            const nameDiv = [...item.children].find((c) => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
            const name = nameDiv?.textContent.trim().toLowerCase() || '';
            if (name.includes(needle)) return item;
        }
        return null;
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class SaiNavigatorModule extends Module {
        constructor() {
            super({
                id: 'sai-navigator',
                name: 'SAI Navigator',
                category: C.CATEGORY.GAME,
                dependsOn: ['network-map', 'server-connect'],
            });
        }
        async start() { this.info('sai-navigator ready'); }
    }
    Registry.register(new SaiNavigatorModule());

    // Expose helpers
    root.COR3.game = root.COR3.game || {};
    root.COR3.game.sai = {
        SEL,
        downloadsWatcher,
        findOrOpenSai,
        closeAllSaiTerminals,
        navigateToSection,
        waitForSaiContent,
        waitForServerAccess,
        hasServerAccess,
        addIpViaModal,
        confirmDeleteDialog,
        // Generic row helpers (work on Logs and Files tabs alike — see
        // rowsInSection comment for why this is structural now).
        rowsInSection,
        findRowByName,
        findAllRowsByName,
        findLogRowByName,
        findAllLogRowsByName,
        findLogRowByIndex,
        findFileRowByName,
        findAllFileRowsByName,
        findFileInDownloads,
        clickRowDownload,
        clickRowRemove,
    };
})();
