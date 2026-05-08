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
        const tabs = [...sai.querySelectorAll(SEL.TAB)];
        if (!tabs.length) return false;
        for (const tab of tabs) {
            dom.clickEl(tab);
            await dom.sleep(400);
            if (sai.querySelector(sectionSel)) return true;
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

        // Wait up to 15s for SAI app to appear after login
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !root.__jobManagerAbort) {
            const sai = SC.getSaiForServer(serverName);
            if (sai) return sai;
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
    function findRowByIconAndName(sai, sectionSel, iconSel, name) {
        const section = sai.querySelector(sectionSel);
        if (!section) return null;
        const needle = name ? name.toLowerCase() : null;
        if (!needle) return null;
        for (const icon of section.querySelectorAll(iconSel)) {
            const row = icon.parentElement?.parentElement;
            if (!row || row === section || !section.contains(row)) continue;
            const text = [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean).join(' ');
            if (text.toLowerCase().includes(needle)) return row;
        }
        return null;
    }

    function findLogRowByName(sai, logName) {
        return findRowByIconAndName(sai, SEL.LOGS, SEL.LOG_ICON, logName);
    }

    function findAllLogRowsByName(sai, logName) {
        const section = sai.querySelector(SEL.LOGS);
        if (!section) return [];
        const needle = logName ? logName.toLowerCase() : null;
        if (!needle) return [];
        const rows = [];
        for (const icon of section.querySelectorAll(SEL.LOG_ICON)) {
            const row = icon.parentElement?.parentElement;
            if (!row || row === section || !section.contains(row)) continue;
            const text = [...row.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean).join(' ');
            if (text.toLowerCase().includes(needle)) rows.push(row);
        }
        return rows;
    }

    function findLogRowByIndex(sai, logSeq) {
        const section = sai.querySelector(SEL.LOGS);
        if (!section) return null;
        const icons = [...section.querySelectorAll(SEL.LOG_ICON)];
        if (logSeq >= 0 && logSeq < icons.length) return icons[logSeq].parentElement.parentElement;
        return null;
    }

    function findFileRowByName(sai, fileName) {
        return findRowByIconAndName(sai, SEL.FILES, SEL.FILE_ICON, fileName);
    }

    function findAllFileRowsByName(sai, fileName) {
        const section = sai.querySelector(SEL.FILES);
        if (!section) return [];
        const rows = [];
        for (const icon of section.querySelectorAll(SEL.FILE_ICON)) {
            const nameCell = icon.parentElement;
            const text = (nameCell.querySelector('span') || {}).textContent || '';
            if (fileName && text.trim().toLowerCase().includes(fileName.toLowerCase())) {
                rows.push(nameCell.parentElement);
            }
        }
        return rows;
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
        findRowByIconAndName,
        findLogRowByName,
        findAllLogRowsByName,
        findLogRowByIndex,
        findFileRowByName,
        findAllFileRowsByName,
        findFileInDownloads,
    };
})();
