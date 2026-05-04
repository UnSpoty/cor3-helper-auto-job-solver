// job-manager.js — injected into MAIN world by content.js
(function () {
    if (window.__jobManagerActive) return;
    window.__jobManagerActive = true;
    window.__jobManagerAbort = false;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const postJobLog = (msg, level = 'info') => window.postMessage({ type: 'COR3_JOB_LOG', msg, level }, '*');

    // ─── Debug logging ────────────────────────────────────────────────────────
    // All job-manager logs use the [JM] prefix. Filter F12 console by "[JM]"
    // for solver-side activity or "[AJ]" for content.js pipeline events.
    const JM_PREFIX = '[JM]';
    const jmLog  = (...args) => console.log  (JM_PREFIX, ...args);
    const jmWarn = (...args) => console.warn (JM_PREFIX, ...args);
    const jmErr  = (...args) => console.error(JM_PREFIX, ...args);

    // ─── Selectors ────────────────────────────────────────────────────────────

    // Network Map
    const NM_SERVER_ITEM_SEL     = '[data-sentry-component="ServerItem"]';
    const NM_SERVER_NAME_SEL     = '[data-sentry-element="ServerItemNameStyled"] span';
    const NM_SERVER_ICON_SEL     = '[data-sentry-element="ServerIconStyled"]';
    const NM_MAINT_TIMER_SEL     = '[data-sentry-component="MaintenanceTimer"]';
    const NM_PANEL_NAME_SEL      = '[data-sentry-element="ServerNameStyled"]';
    const NM_CONNECT_BTN_SEL     = '[data-sentry-component="ConnectIcon"]';
    const NM_LOGIN_BTN_SEL       = '[data-sentry-component="LoginIcon"]';
    const NM_LOGIN_PANEL_SEL     = '[data-sentry-element="SaiBottomPanelStyled"][data-sentry-source-file="sai-login.tsx"]';

    // SAI (Server Administration Interface)
    const SAI_APP_SEL                = '[data-sentry-component="ServerAdministrationInterfaceApplication"]';
    const SAI_CLOSE_BTN_SEL          = '[data-sentry-component="CloseApp"]';
    const SAI_TITLE_SEL              = '[data-sentry-element="SaiHeaderTitleStyled"]';
    const SAI_TAB_SEL                = '[data-sentry-element="SaiTabStyled"]';
    const SAI_ADD_BTN_SEL            = '[data-sentry-element="SaiAddButtonStyled"]';
    const SAI_MODAL_SEL              = '[data-sentry-component="SaiAddIpModal"]';
    const SAI_INPUT_SEL              = '[data-sentry-element="SaiModalInputStyled"]';
    const SAI_MODAL_BTN_SEL          = '[data-sentry-element="SaiModalButtonStyled"]';
    const SAI_ACTIVE_ACCESS_SEL      = '[data-sentry-component="SaiActiveAccess"]';
    const SAI_ACTIVE_ACCESS_LIST_SEL = '[data-sentry-element="SaiPanelListStyled"][data-sentry-source-file="sai-active-access.tsx"]';
    const SAI_SCROLL_SEL             = '[data-sentry-element="SaiScrollContainerStyled"]';

    // SAI Logs tab
    const SAI_LOGS_SEL          = '[data-sentry-component="SaiLogs"]';
    const SAI_LOG_ICON_SEL      = '[data-sentry-component="LogIcon"]';
    const SAI_DOWNLOAD_ICON_SEL = '[data-sentry-component="DownloadIcon"]';
    const SAI_TRASH_ICON_SEL    = '[data-sentry-component="TrashIcon"]';

    // SAI Files tab
    const SAI_FILES_SEL      = '[data-sentry-component="SaiFiles"]';
    const SAI_FILE_ICON_SEL  = '[data-sentry-component="FileIcon"]';

    // SAI Transit Access tab
    const SAI_TRANSIT_SEL = '[data-sentry-component="SaiTransit"]';

    // File operations
    const MINIGAME_SEL               = '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]';
    const DOWNLOADS_SHORTCUT_SEL     = '[data-sentry-component="Shortcut"]';
    const FOLDER_APP_SEL             = '[data-component-name="FolderApplication"]';
    const FILE_PICKER_SEL            = '[data-sentry-component="FilePickerGrid"]';
    const FILE_PICKER_GRID_SEL       = '[data-sentry-element="FilePickerGridStyled"]';
    const FILE_PICKER_UPLOAD_BTN_SEL = '[data-sentry-element="FilePickerAttachButtonStyled"]';

    let watchingJob = false;

    // ─── Downloads folder watcher ─────────────────────────────────────────────
    // Tracks what files were in the in-game Downloads folder at a known point in
    // time so that newly downloaded files can be reliably identified by diff.

    const downloadsWatcher = (() => {
        let _snapshot = new Set();

        function _scan() {
            const app = document.querySelector(FOLDER_APP_SEL);
            const names = new Set();
            if (!app) return names;
            for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                const nameDiv = [...item.children]
                    .find(c => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
                const name = nameDiv?.textContent.trim().toLowerCase();
                if (name) names.add(name);
            }
            return names;
        }

        async function _ensureOpen(timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline && !window.__jobManagerAbort) {
                if (document.querySelector(FOLDER_APP_SEL)) return document.querySelector(FOLDER_APP_SEL);
                const shortcut = [...document.querySelectorAll(DOWNLOADS_SHORTCUT_SEL)]
                    .find(s => s.textContent.trim().toLowerCase().includes('downloads'));
                if (shortcut) {
                    shortcut.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
                    await sleep(600);
                } else {
                    await sleep(400);
                }
            }
            return document.querySelector(FOLDER_APP_SEL);
        }

        return {
            // Synchronously snapshot whatever is currently in the Downloads folder.
            // Call once at script start so any file downloaded after injection is "new".
            snapshot() {
                _snapshot = _scan();
                console.log(`[JM] Downloads watcher: snapshot — ${_snapshot.size} file(s)`);
            },

            // Open the Downloads folder and re-snapshot its contents.
            // Call immediately BEFORE the action that triggers a file download so
            // the watcher can detect the new file by comparing against this state.
            async arm(timeoutMs = 15_000) {
                const folder = await _ensureOpen(timeoutMs);
                _snapshot = _scan();
                console.log(`[JM] Downloads watcher: armed — ${_snapshot.size} file(s)`);
                return folder;
            },

            // Open the Downloads folder without changing the snapshot.
            // Use when the snapshot should stay as the script-start baseline.
            async openFolder(timeoutMs = 15_000) {
                return _ensureOpen(timeoutMs);
            },

            // Poll until a file that was NOT in the last snapshot appears, or a file
            // with a "NEW" badge is found. Returns the element, or null on timeout/abort.
            async waitForNewFile(timeoutMs = 30_000) {
                const before = _snapshot;
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline && !window.__jobManagerAbort) {
                    const app = document.querySelector(FOLDER_APP_SEL);
                    if (app) {
                        for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                            const badge = item.querySelector('[data-sentry-component="NotificationIcon"]');
                            if (badge && badge.textContent.trim().toUpperCase() === 'NEW') return item;
                            const nameDiv = [...item.children]
                                .find(c => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
                            const name = nameDiv?.textContent.trim().toLowerCase() || '';
                            if (name && !before.has(name)) return item;
                        }
                    }
                    await sleep(300);
                }
                return null;
            }
        };
    })();

    // Baseline snapshot: captures any files already in Downloads before jobs run.
    downloadsWatcher.snapshot();

    jmLog('Job manager loaded');
    window.postMessage({ type: 'COR3_JOB_MANAGER_READY' }, '*');

    // ─── Generic helpers ──────────────────────────────────────────────────────

    async function waitForEl(sel, timeoutMs = 10_000, root = document) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !window.__jobManagerAbort) {
            const el = root.querySelector(sel);
            if (el) return el;
            await sleep(200);
        }
        return null;
    }

    function clickEl(el) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
    }

    // ─── Network Map helpers ──────────────────────────────────────────────────

    function findServerItemByName(serverName) {
        for (const item of document.querySelectorAll(NM_SERVER_ITEM_SEL)) {
            const nameEl = item.querySelector(NM_SERVER_NAME_SEL);
            if (nameEl && nameEl.textContent.trim() === serverName) return item;
        }
        return null;
    }

    // Returns { hasKD: bool, timerText: string|null }
    // K/D = MaintenanceTimer contains a TimerIcon SVG (red icon); plain text-only timer = accessible
    function checkServerKD(serverItem) {
        const timer = serverItem.querySelector(NM_MAINT_TIMER_SEL);
        if (!timer) return { hasKD: false, timerText: null };
        const icon = timer.querySelector('[data-sentry-component="TimerIcon"]');
        return { hasKD: !!icon, timerText: timer.textContent.trim() };
    }

    // Full connect flow: select server → Connect → Login → (login method if dialog appears) → SAI open
    async function connectToServer(serverName) {
        postJobLog(`Connecting to server: "${serverName}"`);
        // Step 1: locate server in Network Map
        const item = findServerItemByName(serverName);
        if (!item) {
            console.warn('[JM] Server not found in Network Map:', serverName);
            postJobLog(`Server not found in Network Map: "${serverName}"`, 'error');
            return false;
        }

        // Step 2: K/D check
        const { hasKD, timerText } = checkServerKD(item);
        if (hasKD) {
            console.warn(`[JM] Server "${serverName}" has K/D timer (${timerText}) — skipping`);
            postJobLog(`Server "${serverName}" has K/D timer (${timerText}) — skipping`, 'warn');
            window.postMessage({ type: 'COR3_JOB_KD_DETECTED', serverName, timerText }, '*');
            return false;
        }

        // Step 3: click server icon to select it and update the side panel
        const icon = item.querySelector(NM_SERVER_ICON_SEL);
        clickEl(icon || item);
        await sleep(400);

        // Wait for side panel to reflect this server
        let panelReady = false;
        for (let i = 0; i < 20 && !window.__jobManagerAbort; i++) {
            const nameEl = document.querySelector(NM_PANEL_NAME_SEL);
            if (nameEl && nameEl.textContent.trim() === serverName) { panelReady = true; break; }
            await sleep(250);
        }
        if (!panelReady) {
            console.warn('[JM] Side panel did not update for server:', serverName);
            return false;
        }

        // Step 4: click Connect — skip if server already connected (Login already visible)
        window.__connectStartedAt = Date.now();
        if (!document.querySelector(NM_LOGIN_BTN_SEL)) {
            const connectIcon = await waitForEl(NM_CONNECT_BTN_SEL, 3_000);
            if (connectIcon) {
                console.log('[JM] Clicking Connect for server:', serverName);
                clickEl(connectIcon.closest('button') || connectIcon);
                await sleep(700);
            } else if (!document.querySelector(NM_LOGIN_BTN_SEL)) {
                console.warn('[JM] Connect button not found for server:', serverName);
                return false;
            }
        }

        // Step 5: wait for Login button — or detect if SAI opened directly (auto-login)
        let loginIcon = null;
        const loginDeadline = Date.now() + 12_000;
        while (Date.now() < loginDeadline && !window.__jobManagerAbort) {
            loginIcon = document.querySelector(NM_LOGIN_BTN_SEL);
            if (loginIcon) break;
            if (getSaiForServer(serverName)) {
                console.log('[JM] SAI opened directly after Connect (auto-login) for server:', serverName);
                return true;
            }
            // Connect button reappeared → connection was rejected by server
            if (document.querySelector(NM_CONNECT_BTN_SEL)) {
                console.warn('[JM] Connect button reappeared — connection rejected for server:', serverName);
                window.postMessage({ type: 'COR3_SERVER_UNREACHABLE', serverName }, '*');
                return false;
            }
            // WS reported no-path-to-server after our connect attempt started
            if (window.__serverPathFailed > (window.__connectStartedAt || 0)) {
                console.warn('[JM] No path to server (WS):', serverName);
                window.__serverPathFailed = 0;
                // Scan the Network Map for servers currently on K/D — one of them is
                // likely blocking the path to this server (chain: KD-server → target).
                const blockedByKD = [];
                for (const item of document.querySelectorAll(NM_SERVER_ITEM_SEL)) {
                    const { hasKD, timerText } = checkServerKD(item);
                    if (!hasKD) continue;
                    const nameEl = item.querySelector(NM_SERVER_NAME_SEL);
                    const kdName = nameEl?.textContent.trim();
                    if (kdName && kdName !== serverName) {
                        blockedByKD.push({ serverName: kdName, timerText });
                    }
                }
                window.postMessage({ type: 'COR3_SERVER_UNREACHABLE', serverName, blockedByKD }, '*');
                return false;
            }
            await sleep(200);
        }
        if (!loginIcon) {
            console.warn('[JM] Login button did not appear after Connect for server:', serverName);
            return false;
        }
        clickEl(loginIcon.closest('button') || loginIcon);
        await sleep(700);

        // Step 6: if login method selection panel appeared, click first Active Access entry.
        // Race condition guard: the login panel mounts with a login-form skeleton first, then
        // Active Access rows render a few hundred ms later (async fetch + React re-render).
        // If we query immediately on panel-appear we hit the gap and silently skip the click,
        // leaving the user staring at the Admin/Password form. Wait on the deepest selector
        // (the arrow inside SaiActiveAccess) so we only proceed once a real entry exists.
        const loginPanel = await waitForEl(NM_LOGIN_PANEL_SEL, 5_000);
        if (loginPanel) {
            const arrow = await waitForEl(
                `${SAI_ACTIVE_ACCESS_SEL} [data-sentry-component="ArrowRightIcon"]`,
                5_000,
                loginPanel
            );
            // ArrowRightIcon SVG → arrow container div → row div
            const row = arrow?.parentElement?.parentElement;
            if (row) {
                clickEl(row);
                await sleep(700);
                console.log('[JM] Clicked Active Access entry for server:', serverName);
            } else {
                console.warn('[JM] Login panel found but no Active Access entry within 5s for server:', serverName);
                postJobLog(`SAI login: no Active Access entry for "${serverName}" — solver will fail`, 'warn');
            }
        }

        postJobLog(`Connected to server: "${serverName}"`, 'ok');
        return true;
    }

    // ─── SAI helpers ─────────────────────────────────────────────────────────

    function getSaiForServer(serverName) {
        const apps = document.querySelectorAll(SAI_APP_SEL);
        for (const app of apps) {
            const title = app.querySelector(SAI_TITLE_SEL);
            if (title && title.textContent.trim() === serverName) return app;
        }
        return null;
    }

    async function closeAllSaiTerminals() {
        const saiApps = [...document.querySelectorAll(SAI_APP_SEL)];
        if (!saiApps.length) return;
        postJobLog(`Closing ${saiApps.length} open SAI terminal(s) before starting`, 'info');
        for (const sai of saiApps) {
            const widget = sai.closest('[data-sentry-component="ApplicationWidget"]');
            if (!widget) continue;
            const closeBtn = widget.querySelector(SAI_CLOSE_BTN_SEL);
            if (closeBtn) {
                clickEl(closeBtn);
                await sleep(300);
            }
        }
        // Wait up to 3 s for all SAI apps to disappear
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && document.querySelector(SAI_APP_SEL)) {
            await sleep(200);
        }
    }

    async function navigateToSection(sai, sectionSel) {
        // Short-circuit: section already active
        if (sai.querySelector(sectionSel)) return true;
        // Click through tabs until the target content section appears
        const tabs = [...sai.querySelectorAll(SAI_TAB_SEL)];
        if (!tabs.length) {
            console.warn('[JM] No SAI tabs found for section:', sectionSel);
            return false;
        }
        for (const tab of tabs) {
            clickEl(tab);
            await sleep(400);
            if (sai.querySelector(sectionSel)) return true;
        }
        console.warn('[JM] Section not found after trying all tabs:', sectionSel);
        return false;
    }

    async function waitForSaiContent(sai, timeoutMs = 5_000) {
        return !!(await waitForEl(SAI_SCROLL_SEL, timeoutMs, sai));
    }

    // Find a row in a SAI tab section by icon selector and name match.
    // Walks up the DOM from each icon (up to 4 levels, stopping at the section) to find
    // the innermost ancestor whose span text includes the name. Handles any cell depth.
    function findRowByIconAndName(sai, sectionSel, iconSel, name) {
        const section = sai.querySelector(sectionSel);
        if (!section) {
            console.warn('[JM] section not found:', sectionSel);
            return null;
        }
        const icons = [...section.querySelectorAll(iconSel)];
        if (!icons.length) {
            console.warn('[JM] no icons found in section:', sectionSel, iconSel);
            return null;
        }
        const needle = name ? name.toLowerCase() : null;
        if (!needle) return null;
        for (const icon of icons) {
            // Row is 2 levels up from the icon (consistent with findLogRowByIndex and DOM debug dumps)
            const row = icon.parentElement?.parentElement;
            if (!row || row === section || !section.contains(row)) continue;
            const text = [...row.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).join(' ');
            if (text.toLowerCase().includes(needle)) return row;
        }
        return null;
    }

    function findLogRowByName(sai, logName) {
        return findRowByIconAndName(sai, SAI_LOGS_SEL, SAI_LOG_ICON_SEL, logName);
    }

    function findAllLogRowsByName(sai, logName) {
        const section = sai.querySelector(SAI_LOGS_SEL);
        if (!section) return [];
        const needle = logName ? logName.toLowerCase() : null;
        if (!needle) return [];
        const rows = [];
        for (const icon of section.querySelectorAll(SAI_LOG_ICON_SEL)) {
            const row = icon.parentElement?.parentElement;
            if (!row || row === section || !section.contains(row)) continue;
            const text = [...row.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).join(' ');
            if (text.toLowerCase().includes(needle)) rows.push(row);
        }
        return rows;
    }

    function findLogRowByIndex(sai, logSeq) {
        const section = sai.querySelector(SAI_LOGS_SEL);
        if (!section) return null;
        const icons = [...section.querySelectorAll(SAI_LOG_ICON_SEL)];
        if (logSeq >= 0 && logSeq < icons.length) return icons[logSeq].parentElement.parentElement;
        return null;
    }

    function findFileRowByName(sai, fileName) {
        return findRowByIconAndName(sai, SAI_FILES_SEL, SAI_FILE_ICON_SEL, fileName);
    }

    function findAllFileRowsByName(sai, fileName) {
        const section = sai.querySelector(SAI_FILES_SEL);
        if (!section) return [];
        const rows = [];
        for (const icon of section.querySelectorAll(SAI_FILE_ICON_SEL)) {
            const nameCell = icon.parentElement;
            const text = (nameCell.querySelector('span') || {}).textContent || '';
            if (fileName && text.trim().toLowerCase().includes(fileName.toLowerCase())) {
                rows.push(nameCell.parentElement);
            }
        }
        return rows;
    }

    // Find a file element by name in the currently-open Downloads folder.
    // Returns the .folder-application element or null. Does NOT use the snapshot.
    async function findFileInDownloads(fileName, timeoutMs = 5_000) {
        if (!fileName) return null;
        const folder = await downloadsWatcher.openFolder(timeoutMs);
        if (!folder) return null;
        const needle = fileName.toLowerCase();
        for (const item of folder.querySelectorAll('.folder-application[data-app-id]')) {
            const nameDiv = [...item.children].find(c => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
            const name = nameDiv?.textContent.trim().toLowerCase() || '';
            if (name.includes(needle)) return item;
        }
        return null;
    }

    function setReactInput(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function hasServerAccess(sai) {
        // After login, SAI shows tab navigation; login screen has no tabs
        return !!sai.querySelector(SAI_TAB_SEL);
    }

    async function waitForServerAccess(sai, serverName) {
        for (let i = 0; i < 10; i++) {
            if (hasServerAccess(sai)) return true;
            await sleep(500);
        }
        console.warn('[JM] No active access on server:', serverName);
        return false;
    }

    // Find an open SAI for serverName, or open one via Network Map connect flow.
    async function findOrOpenSai(serverName) {
        await closeAllSaiTerminals();

        // Best-effort: auto-open Network Map if not visible.
        // connectToServer already handles "server not found" gracefully if NM isn't open.
        await ensureNetworkMapOpen(15_000);

        const ok = await connectToServer(serverName);
        if (!ok) return null;

        // Wait up to 15 s for SAI app to appear after login
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !window.__jobManagerAbort) {
            const sai = getSaiForServer(serverName);
            if (sai) return sai;
            await sleep(400);
        }
        console.warn('[JM] SAI did not open after connect for server:', serverName);
        return null;
    }

    // ─── SAI: IP modal helper ─────────────────────────────────────────────────

    async function addIpViaModal(sai, ip) {
        const addBtn = sai.querySelector(SAI_ADD_BTN_SEL);
        if (!addBtn) { console.warn('[JM] SAI add button not found'); return false; }
        addBtn.click();
        await sleep(400);

        const modal = await waitForEl(SAI_MODAL_SEL, 4_000);
        if (!modal) { console.warn('[JM] Add IP modal did not appear'); return false; }

        const input = modal.querySelector(SAI_INPUT_SEL);
        if (!input) { console.warn('[JM] IP input not found'); return false; }
        setReactInput(input, ip);
        await sleep(200);

        const btns = modal.querySelectorAll(SAI_MODAL_BTN_SEL);
        const saveBtn = [...btns].find(b => b.textContent.trim() === 'Save') || btns[btns.length - 1];
        if (!saveBtn) { console.warn('[JM] Save button not found'); return false; }
        saveBtn.click();

        for (let i = 0; i < 30; i++) {
            if (!document.querySelector(SAI_MODAL_SEL)) break;
            await sleep(200);
        }
        await sleep(400);
        console.log('[JM] IP added:', ip);
        return true;
    }

    // ─── File Decryption flow ─────────────────────────────────────────────────
    // fileCondition is required: either an exact filename ("temp_1390.eb52x")
    // or just an extension starting with "." (".eb52x"). Both come from the
    // resolved API conditions — there is no DOM-derived fallback. If the file
    // is not found in Downloads within the timeout, the job is failed (bugged).

    async function solveFdFlow(jobId, marketId, fileCondition) {
        if (watchingJob) return;
        watchingJob = true;

        if (!fileCondition) {
            console.warn('[JM] File Decryption — missing fileCondition, aborting');
            postJobLog('File Decryption: no fileCondition — aborting', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Open Downloads folder — no snapshot-arm needed because we no longer
        // accept "any new file" as a target.
        await downloadsWatcher.openFolder(30_000);

        const needle    = fileCondition.toLowerCase();
        const isExtOnly = needle.startsWith('.');
        console.log('[JM] File Decryption — looking for', isExtOnly ? `*${needle}` : needle);
        postJobLog(`File Decryption: looking for "${fileCondition}"`);

        function matchesFile(item) {
            const nameDiv = [...item.children].find(c => c.tagName === 'DIV' && !c.classList.contains('folder-application-icon'));
            const fname = nameDiv?.textContent.trim().toLowerCase() || '';
            return isExtOnly ? fname.endsWith(needle) : fname === needle;
        }

        // Poll for the target file for up to 60 s.
        let fileEl = null;
        const deadline = Date.now() + 60_000;
        while (!window.__jobManagerAbort && Date.now() < deadline && !fileEl) {
            const app = document.querySelector(FOLDER_APP_SEL);
            if (app) {
                for (const item of app.querySelectorAll('.folder-application[data-app-id]')) {
                    if (matchesFile(item)) { fileEl = item; break; }
                }
            }
            if (!fileEl) await sleep(500);
        }

        if (!fileEl) {
            if (window.__jobManagerAbort) { watchingJob = false; return; }
            console.warn('[JM] File Decryption — file not found in Downloads:', fileCondition);
            postJobLog(`File Decryption: file not found ("${fileCondition}") — failing job`, 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await sleep(200);
        fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        console.log('[JM] Clicked file in Downloads:', fileEl.querySelector('div:not(.folder-application-icon)')?.textContent?.trim());

        const start = Date.now();
        let appeared = false;
        while (!window.__jobManagerAbort && Date.now() - start < 90_000) {
            if (document.querySelector(MINIGAME_SEL)) { appeared = true; break; }
            await sleep(250);
        }
        if (!appeared) {
            console.warn('[JM] Minigame did not appear within 90 s');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Minigame detected, waiting for solver...');
        while (!window.__jobManagerAbort && document.querySelector(MINIGAME_SEL)) {
            await sleep(100);
        }
        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] Minigame closed — File Decryption done!');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── IP Injection flow ────────────────────────────────────────────────────

    async function solveIpJobFlow(jobId, marketId, serverName, ips) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] IP Injection — server:', serverName, 'IPs:', ips);

        if (!ips || ips.length === 0) {
            console.warn('[JM] IP Injection — no target IPs, aborting (conditions not parsed)');
            postJobLog('IP Injection: no target IPs parsed — aborting to avoid injecting nothing', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for IP Injection server:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await waitForServerAccess(sai, serverName)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        await navigateToSection(sai, SAI_TRANSIT_SEL);

        for (const ip of ips) {
            if (window.__jobManagerAbort) break;
            await addIpViaModal(sai, ip);
            await sleep(300);
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] All IPs added — IP Injection done!');
        postJobLog(`IP Injection done — ${ips.length} IP(s) added`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── IP Cleanup flow ──────────────────────────────────────────────────────

    async function confirmDeleteDialog() {
        await sleep(250);
        const overlay = document.querySelector('[data-sentry-element="SaiDeleteModalStyled"]');
        if (!overlay || overlay.offsetParent === null) return;
        const confirmBtn = overlay.querySelector('[data-sentry-element="SaiDeleteConfirmButtonStyled"]');
        if (confirmBtn) {
            confirmBtn.click();
            console.log('[JM] confirmed delete dialog');
            await sleep(300);
        }
    }

    async function solveIpCleanupFlow(jobId, marketId, serverName, ips) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] IP Cleanup — server:', serverName, 'IPs:', ips);

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for IP Cleanup server:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        const allTabs = [...sai.querySelectorAll(SAI_TAB_SEL)].map(t => t.textContent.trim());
        console.log('[JM] IP Cleanup — SAI tabs:', allTabs.join(', '));

        if (!await navigateToSection(sai, SAI_TRANSIT_SEL)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        const scroll = await waitForEl(SAI_SCROLL_SEL, 6_000, sai);
        if (!scroll) {
            console.warn('[JM] IP Cleanup — scroll container not found after tab switch');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Helper: find the row element for a given IP address in the scroll container.
        // DOM structure: SaiScrollContainerStyled > ScrollArea > inner > row[n]
        //   row > ipCell > [iconSpan, ipSpan] | timefameCell | actionCell > button
        // We locate the IP span directly, then walk up to the row (ipCell.parentElement).
        function findIpRow(scrollEl, targetIp) {
            const ipSpan = [...scrollEl.querySelectorAll('span')]
                .find(s => s.textContent.trim() === targetIp);
            if (!ipSpan) return null;
            // ipSpan → ipCell → row (row has the action button as a sibling child)
            const row = ipSpan.parentElement?.parentElement;
            return row || null;
        }

        // No IPs provided — cannot determine which entries to remove; abort to avoid wiping the whole list.
        if (ips.length === 0) {
            console.warn('[JM] IP Cleanup — no target IPs, aborting (check conditions parsing)');
            postJobLog('IP Cleanup: no target IPs parsed — aborting to avoid clearing the entire transit list', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        let deletedCount = 0;
        const missingIps  = [];
        for (const ip of ips) {
            if (window.__jobManagerAbort) break;
            // Re-query scroll each iteration — React may replace the container after a delete
            const currentScroll = await waitForEl(SAI_SCROLL_SEL, 5_000, sai);
            if (!currentScroll) { console.warn('[JM] IP Cleanup — scroll lost after delete'); break; }

            const row = findIpRow(currentScroll, ip);
            if (!row) {
                // IP not present in rendered DOM. Don't assume "already removed" —
                // the server would reject the complete with job-conditions-not-met,
                // creating an error spam loop. Treat this as a hard fail so the
                // job gets bugged out and the script moves on.
                console.warn('[JM] IP Cleanup — IP not in list (virtualized? stale conditions?):', ip);
                missingIps.push(ip);
                continue;
            }

            const deleteBtn = row.querySelector('button');
            if (!deleteBtn) { console.warn('[JM] IP Cleanup — no button for IP:', ip); continue; }

            console.log('[JM] IP Cleanup — deleting IP:', ip);
            deleteBtn.click();
            await sleep(500);
            await confirmDeleteDialog();
            await sleep(300);
            deletedCount++;
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }

        if (missingIps.length > 0) {
            console.warn('[JM] IP Cleanup — aborting, IPs not found in DOM:', missingIps.join(', '));
            postJobLog(`IP Cleanup: ${missingIps.length}/${ips.length} target IP(s) not in DOM (${missingIps.join(', ')}) — aborting to avoid false complete`, 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
        } else if (deletedCount === ips.length) {
            console.log('[JM] IP Cleanup done —', deletedCount, 'IPs deleted');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        } else {
            console.warn('[JM] IP Cleanup — deleted', deletedCount, '/', ips.length, 'IPs');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
        }
        watchingJob = false;
    }

    // ─── Data Upload flow ─────────────────────────────────────────────────────

    function findPickerItem(grid, name) {
        for (const item of grid.children) {
            const nameEl = item.querySelector('.file-picker-name');
            if (nameEl && nameEl.textContent.trim().toLowerCase().includes(name.toLowerCase())) return item;
        }
        return null;
    }

    async function solveUploadJobFlow(jobId, marketId, serverName, fileCondition) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] Upload — server:', serverName, 'file:', fileCondition);

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for Upload server:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await waitForServerAccess(sai, serverName)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        await navigateToSection(sai, SAI_FILES_SEL);

        const addBtn = sai.querySelector(SAI_ADD_BTN_SEL);
        if (addBtn) { addBtn.click(); await sleep(500); }
        else console.warn('[JM] SAI add/attach button not found');

        const picker = await waitForEl(FILE_PICKER_SEL, 7_500);
        if (!picker) {
            console.warn('[JM] FilePicker did not appear');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Navigate into Downloads folder (re-query grid each iteration — React may replace it)
        let downloadsItem = null;
        for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
            const g = document.querySelector(FILE_PICKER_GRID_SEL);
            if (g) downloadsItem = findPickerItem(g, 'downloads');
            if (downloadsItem) break;
            await sleep(300);
        }
        if (!downloadsItem) {
            console.warn('[JM] Downloads folder not found in file picker');
            const closeBtn = document.querySelector('[data-sentry-element="FilePickerCloseButtonStyled"]');
            if (closeBtn) closeBtn.click();
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Snapshot current item names to detect navigation
        const prevNames = new Set([...document.querySelectorAll(`${FILE_PICKER_GRID_SEL} .file-picker-name`)].map(n => n.textContent.trim()));
        downloadsItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        console.log('[JM] Double-clicked Downloads folder');

        // Wait for grid contents to change after navigation
        for (let i = 0; i < 20 && !window.__jobManagerAbort; i++) {
            await sleep(300);
            const newNames = [...document.querySelectorAll(`${FILE_PICKER_GRID_SEL} .file-picker-name`)].map(n => n.textContent.trim());
            if (newNames.length !== prevNames.size || newNames.some(n => !prevNames.has(n))) break;
        }

        if (!fileCondition) {
            console.warn('[JM] No fileCondition for Upload — cannot select file');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Find target file — re-query grid each iteration so stale React refs don't break us
        let fileItem = null;
        for (let i = 0; i < 20 && !fileItem && !window.__jobManagerAbort; i++) {
            const g = document.querySelector(FILE_PICKER_GRID_SEL);
            if (g) fileItem = findPickerItem(g, fileCondition);
            if (!fileItem) await sleep(300);
        }
        if (!fileItem) {
            console.warn('[JM] File not found in Downloads:', fileCondition);
            const closeBtn = document.querySelector('[data-sentry-element="FilePickerCloseButtonStyled"]');
            if (closeBtn) closeBtn.click();
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        clickEl(fileItem);
        console.log('[JM] Selected file in Downloads:', fileCondition);
        await sleep(400);

        for (let i = 0; i < 20 && !window.__jobManagerAbort; i++) {
            const uploadBtn = document.querySelector(FILE_PICKER_UPLOAD_BTN_SEL);
            if (uploadBtn && !uploadBtn.disabled) {
                uploadBtn.click();
                console.log('[JM] Clicked Upload button');
                break;
            }
            await sleep(300);
        }

        for (let i = 0; i < 40; i++) {
            if (!document.querySelector(FILE_PICKER_SEL)) break;
            await sleep(300);
        }
        await sleep(500);

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] Upload done!');
        postJobLog(`Upload done — "${fileCondition}" → "${serverName}"`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── Log Deletion flow ────────────────────────────────────────────────────

    async function solveLogDeletionFlow(jobId, marketId, serverName, logName, logSeqs) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] Log Deletion — server:', serverName, 'log:', logName, 'seqs:', logSeqs);

        if (!logName && (!logSeqs || !logSeqs.length)) {
            postJobLog('Log Deletion: no logName or logSeqs — aborting', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for Log Deletion:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        console.log('[JM] Log Deletion — SAI opened for', serverName);

        if (!await navigateToSection(sai, SAI_LOGS_SEL)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        console.log('[JM] Log Deletion — navigated to Logs tab');

        if (!await waitForSaiContent(sai)) {
            console.warn('[JM] Log Deletion — scroll container not found');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        console.log('[JM] Log Deletion — content ready');

        const _logSection = sai.querySelector(SAI_LOGS_SEL);
        if (_logSection) {
            const _logIcons = [..._logSection.querySelectorAll(SAI_LOG_ICON_SEL)];
            const _logNames = _logIcons.map((icon, i) => {
                const row = icon.parentElement?.parentElement;
                const text = row ? [...row.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).join(' | ') : '?';
                return `[${i}] ${text}`;
            });
            console.log('[JM] Log Deletion — visible logs:', _logNames.join('  //  '));
        } else {
            console.warn('[JM] Log Deletion — logs section not found:', SAI_LOGS_SEL);
        }

        // Name-first strategy: logName takes priority; logSeqs only as fallback
        const deleteCount = (Array.isArray(logSeqs) && logSeqs.length > 0) ? logSeqs.length : 1;
        let deletedCount = 0;

        if (logName) {
            console.log('[JM] Log Deletion — searching by name:', logName, '(need', deleteCount, ')');
            postJobLog(`Log Deletion: name "${logName}", deleting ${deleteCount}`);
            while (!window.__jobManagerAbort && deletedCount < deleteCount) {
                let row = null;
                for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
                    row = findLogRowByName(sai, logName);
                    if (row) break;
                    await sleep(300);
                }
                if (!row) {
                    if (deletedCount === 0) {
                        console.warn('[JM] Log Deletion — log not found by name:', logName);
                        window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                        watchingJob = false;
                        return;
                    }
                    break; // fewer logs than expected — treat as done
                }
                console.log(`[JM] Log Deletion — deleting (${deletedCount + 1}/${deleteCount}):`, logName);
                const deleteBtn = row.querySelector(SAI_TRASH_ICON_SEL)?.closest('button');
                if (!deleteBtn) {
                    console.warn('[JM] Log Deletion — delete button not found');
                    window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                    watchingJob = false;
                    return;
                }
                deleteBtn.click();
                await sleep(400);
                await confirmDeleteDialog();
                await sleep(500);
                deletedCount++;
            }
        } else {
            // Seq fallback — logSeqs is a DB sequence ID, not a DOM index, so this may be unreliable
            const targets = [...logSeqs].sort((a, b) => b - a);
            postJobLog(`Log Deletion: seq fallback [${targets.join(', ')}]`);
            for (const seq of targets) {
                if (window.__jobManagerAbort) { watchingJob = false; return; }
                let row = null;
                for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
                    row = findLogRowByIndex(sai, seq);
                    if (row) break;
                    await sleep(300);
                }
                if (!row) {
                    console.warn('[JM] Log Deletion — log not found by seq:', seq);
                    window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                    watchingJob = false;
                    return;
                }
                const deleteBtn = row.querySelector(SAI_TRASH_ICON_SEL)?.closest('button');
                if (!deleteBtn) {
                    console.warn('[JM] Log Deletion — delete button not found, seq:', seq);
                    window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                    watchingJob = false;
                    return;
                }
                console.log('[JM] Log Deletion — deleting seq:', seq);
                deleteBtn.click();
                await sleep(400);
                await confirmDeleteDialog();
                await sleep(500);
                deletedCount++;
            }
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] Log Deletion done! Deleted:', deletedCount);
        postJobLog(`Log Deletion done — ${deletedCount} log(s) deleted`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── Log Download flow ────────────────────────────────────────────────────

    async function solveLogDownloadFlow(jobId, marketId, serverName, logName, logSeqs) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] Log Download — server:', serverName, 'log:', logName, 'seqs:', logSeqs);

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for Log Download:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Log Download — SAI opened for', serverName);

        if (!await navigateToSection(sai, SAI_LOGS_SEL)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Log Download — navigated to Logs tab');

        if (!await waitForSaiContent(sai)) {
            console.warn('[JM] Log Download — scroll container not found');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Log Download — content ready');

        // Dump all visible log entries
        const _logSection = sai.querySelector(SAI_LOGS_SEL);
        if (_logSection) {
            const _logIcons = [..._logSection.querySelectorAll(SAI_LOG_ICON_SEL)];
            const _logNames = _logIcons.map((icon, i) => {
                const row = icon.parentElement?.parentElement;
                const text = row ? [...row.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).join(' | ') : '?';
                return `[${i}] ${text}`;
            });
            console.log('[JM] Log Download — visible logs:', _logNames.join('  //  '));
            postJobLog(`Log Download: visible logs (${_logIcons.length}): ${_logNames.join('  //  ')}`);
        } else {
            console.warn('[JM] Log Download — logs section not found:', SAI_LOGS_SEL);
        }

        let downloadedCount = 0;
        let downloadCount = 0;

        if (logName) {
            // Find all rows matching the name first, then download each one
            let allRows = [];
            for (let attempt = 0; attempt < 15 && !window.__jobManagerAbort; attempt++) {
                allRows = findAllLogRowsByName(sai, logName);
                if (allRows.length > 0) break;
                await sleep(300);
            }
            downloadCount = allRows.length;
            console.log('[JM] Log Download — need to download', downloadCount, 'log(s)');
            postJobLog(`Log Download: name "${logName}", downloading ${downloadCount}`);

            for (let i = 0; i < allRows.length && !window.__jobManagerAbort; i++) {
                const row = allRows[i];
                const _selectedText = [...row.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean).join(' | ');
                console.log(`[JM] Log Download — downloading (${i + 1}/${downloadCount}):`, _selectedText);
                postJobLog(`Log Download: downloading (${i + 1}/${downloadCount}): ${_selectedText}`);

                const downloadBtn = row.querySelector(SAI_DOWNLOAD_ICON_SEL)?.closest('button');
                if (!downloadBtn) {
                    console.warn('[JM] Log Download — download button not found in row', i);
                    postJobLog(`Log Download: download button not found for row ${i + 1}`, 'error');
                    break;
                }
                downloadBtn.click();
                await sleep(1500);
                downloadedCount++;
            }
        } else if (Array.isArray(logSeqs) && logSeqs.length > 0) {
            // Seq fallback
            downloadCount = logSeqs.length;
            console.log('[JM] Log Download — need to download', downloadCount, 'log(s)');
            postJobLog(`Log Download: seqs ${JSON.stringify(logSeqs)}, downloading ${downloadCount}`);
            for (let i = 0; i < logSeqs.length && !window.__jobManagerAbort; i++) {
                let row = null;
                for (let attempt = 0; attempt < 15 && !window.__jobManagerAbort; attempt++) {
                    row = findLogRowByIndex(sai, logSeqs[i]);
                    if (row) break;
                    await sleep(300);
                }
                if (!row) {
                    console.warn('[JM] Log Download — seq', logSeqs[i], 'not found');
                    postJobLog(`Log Download: seq ${logSeqs[i]} not found`, 'error');
                    break;
                }
                const downloadBtn = row.querySelector(SAI_DOWNLOAD_ICON_SEL)?.closest('button');
                if (!downloadBtn) {
                    postJobLog(`Log Download: download button not found for seq ${logSeqs[i]}`, 'error');
                    break;
                }
                downloadBtn.click();
                await sleep(700);
                downloadedCount++;
            }
        } else {
            console.warn('[JM] Log Download — no logName or logSeqs');
            postJobLog('Log Download: no logName or logSeqs — aborting', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        if (downloadedCount === 0) {
            postJobLog('Log Download: nothing downloaded', 'error');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Log Download done! downloaded:', downloadedCount);
        postJobLog(`Log Download done (${downloadedCount}/${downloadCount})`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── File Elimination flow ────────────────────────────────────────────────

    async function solveFileEliminationFlow(jobId, marketId, serverName, fileName) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] File Elimination — server:', serverName, 'file:', fileName);

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for File Elimination:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await navigateToSection(sai, SAI_FILES_SEL)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await waitForSaiContent(sai)) {
            console.warn('[JM] File Elimination — scroll container not found');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Wait for at least one matching row to appear
        let initialRows = [];
        for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
            initialRows = findAllFileRowsByName(sai, fileName);
            if (initialRows.length > 0) break;
            await sleep(300);
        }

        if (initialRows.length === 0) {
            console.warn('[JM] File Elimination — file not found:', fileName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Delete all matching files one by one, re-querying each time (React re-renders after delete)
        let deletedCount = 0;
        while (!window.__jobManagerAbort) {
            const row = findFileRowByName(sai, fileName);
            if (!row) break;

            const deleteBtn = row.querySelector(SAI_TRASH_ICON_SEL)?.closest('button');
            if (!deleteBtn) {
                console.warn('[JM] File Elimination — delete button not found');
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            console.log('[JM] File Elimination — deleting file #' + (deletedCount + 1) + ':', fileName);
            deleteBtn.click();
            await sleep(400);
            await confirmDeleteDialog();
            await sleep(500);
            deletedCount++;
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] File Elimination done! Deleted:', deletedCount, 'file(s)');
        postJobLog(`File Elimination done — deleted ${deletedCount} file(s)`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── Data Download flow ───────────────────────────────────────────────────

    async function solveDataDownloadFlow(jobId, marketId, serverName, fileNames) {
        if (watchingJob) return;
        watchingJob = true;
        const names = Array.isArray(fileNames)
            ? fileNames.filter(Boolean)
            : (fileNames ? [fileNames] : []);
        console.log('[JM] Data Download — server:', serverName, 'files:', names);

        if (names.length === 0) {
            console.warn('[JM] Data Download — no file names supplied');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        const sai = await findOrOpenSai(serverName);
        if (!sai) {
            console.warn('[JM] SAI not found for Data Download:', serverName);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await navigateToSection(sai, SAI_FILES_SEL)) {
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (!await waitForSaiContent(sai)) {
            console.warn('[JM] Data Download — scroll container not found');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        // Collect rows for every requested filename. findAllFileRowsByName uses a
        // substring match, so dedupe when the same row matches more than one name.
        function collectRowsForAllNames() {
            const seen = new Set();
            const out = [];
            for (const name of names) {
                for (const row of findAllFileRowsByName(sai, name)) {
                    if (!seen.has(row)) { seen.add(row); out.push(row); }
                }
            }
            return out;
        }

        let rows = [];
        for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
            rows = collectRowsForAllNames();
            if (rows.length >= names.length) break;
            await sleep(300);
        }

        if (rows.length === 0) {
            console.warn('[JM] Data Download — no matching files found:', names);
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }

        if (rows.length < names.length) {
            console.warn('[JM] Data Download — found', rows.length, 'row(s) for', names.length, 'requested file(s); proceeding with what we have');
        }

        let downloaded = 0;
        for (let idx = 0; idx < rows.length && !window.__jobManagerAbort; idx++) {
            const downloadBtn = rows[idx].querySelector(SAI_DOWNLOAD_ICON_SEL)?.closest('button');
            if (!downloadBtn) {
                console.warn('[JM] Data Download — download button not found for file #' + (idx + 1));
                continue;
            }
            console.log('[JM] Data Download — downloading file #' + (idx + 1) + ' of ' + rows.length);
            downloadBtn.click();
            downloaded++;
            await sleep(500);
        }

        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] Data Download done! Downloaded:', downloaded, 'file(s)');
        postJobLog(`Data Download done — ${downloaded} file(s)`, 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── Decrypt & Extract flow ───────────────────────────────────────────────

    async function solveDecryptExtractFlow(jobId, marketId, serverName, fileName) {
        if (watchingJob) return;
        watchingJob = true;
        console.log('[JM] Decrypt & Extract — server:', serverName, 'file:', fileName);

        let fileEl = null;

        // Check if the file is already in Downloads (task description: "previously downloaded file")
        const existingFile = await findFileInDownloads(fileName, 5_000);
        if (existingFile) {
            console.log('[JM] Decrypt & Extract — file already in Downloads, skipping server download:', fileName);
            fileEl = existingFile;
        } else {
            // Part 1: Connect to server, navigate Files tab, download the file
            const sai = await findOrOpenSai(serverName);
            if (!sai) {
                console.warn('[JM] SAI not found for Decrypt & Extract:', serverName);
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            if (!await navigateToSection(sai, SAI_FILES_SEL)) {
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            if (!await waitForSaiContent(sai)) {
                console.warn('[JM] Decrypt & Extract — scroll container not found');
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            let row = null;
            for (let i = 0; i < 15 && !window.__jobManagerAbort; i++) {
                row = findFileRowByName(sai, fileName);
                if (row) break;
                await sleep(300);
            }

            if (!row) {
                console.warn('[JM] Decrypt & Extract — file not found on server:', fileName);
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            const downloadBtn = row.querySelector(SAI_DOWNLOAD_ICON_SEL)?.closest('button');
            if (!downloadBtn) {
                console.warn('[JM] Decrypt & Extract — download button not found');
                window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
                watchingJob = false;
                return;
            }

            // Arm the watcher (open Downloads folder + snapshot) BEFORE clicking download
            // so the new file can be identified by diff against the current state.
            await downloadsWatcher.arm(10_000);
            downloadBtn.click();
            console.log('[JM] Decrypt & Extract — download triggered, waiting for file in Downloads...');

            // Part 2: wait for the newly downloaded file to appear
            fileEl = await downloadsWatcher.waitForNewFile(30_000);
            if (!fileEl && !window.__jobManagerAbort) {
                console.warn('[JM] Decrypt & Extract — new file not detected in Downloads after 30 s');
            }
        }

        // Run the file (either pre-existing or newly downloaded)
        if (fileEl && !window.__jobManagerAbort) {
            fileEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            await sleep(200);
            fileEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            console.log('[JM] Decrypt & Extract — clicked file:', fileEl.querySelector('div:not(.folder-application-icon)')?.textContent?.trim());
        }

        // Part 3: Wait for minigame to appear and be solved by decrypt-solver
        const start = Date.now();
        let appeared = false;
        while (!window.__jobManagerAbort && Date.now() - start < 90_000) {
            if (document.querySelector(MINIGAME_SEL)) { appeared = true; break; }
            await sleep(250);
        }
        if (!appeared) {
            console.warn('[JM] Decrypt & Extract — minigame did not appear within 90 s');
            window.postMessage({ type: 'COR3_JOB_MINIGAME_TIMEOUT', jobId, marketId }, '*');
            watchingJob = false;
            return;
        }
        console.log('[JM] Decrypt & Extract — minigame detected, waiting for solver...');
        while (!window.__jobManagerAbort && document.querySelector(MINIGAME_SEL)) {
            await sleep(100);
        }
        if (window.__jobManagerAbort) { watchingJob = false; return; }
        console.log('[JM] Decrypt & Extract done!');
        postJobLog('Decrypt & Extract done', 'ok');
        window.postMessage({ type: 'COR3_JOB_MINIGAME_DONE', jobId, marketId }, '*');
        watchingJob = false;
    }

    // ─── UI Lock ─────────────────────────────────────────────────────────────
    // Two independent locks:
    //   __pipelineLocked    — true while a single solver flow is running
    //                         (blocks both NM and SAI close)
    //   __autoJobsActive    — true the entire time auto-jobs is enabled
    //                         (blocks NM close only — SAI may still be closed
    //                          between flows)

    window.__pipelineLocked = false;
    window.__autoJobsActive = false;

    document.addEventListener('click', function (e) {
        if (!window.__pipelineLocked && !window.__autoJobsActive) return;
        // Both SAI and Network Map use [data-sentry-component="CloseApp"].
        // The CloseApp sits inside Application > ApplicationWidget, so we check
        // the closest Application ancestor to determine which app is being closed.
        const closeBtn = e.target.closest('[data-sentry-component="CloseApp"]');
        if (!closeBtn) return;
        const parentApp = closeBtn.closest('[data-sentry-component="Application"]');
        if (!parentApp) return;
        if (parentApp.querySelector('[data-sentry-component="NetworkMapApplication"]')) {
            // Either a flow is running OR auto-jobs is on — NM is needed in both cases.
            if (!window.__pipelineLocked && !window.__autoJobsActive) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            const reason = window.__pipelineLocked ? 'pipeline running' : 'auto-jobs running';
            console.warn(`[JM] UI Lock: blocked Network Map close (${reason})`);
            postJobLog(`Cannot close Network Map — ${reason}`, 'warn');
        } else if (parentApp.querySelector('[data-sentry-component="ServerAdministrationInterfaceApplication"]')) {
            // SAI is only locked while a flow is actually executing.
            if (!window.__pipelineLocked) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            console.warn('[JM] UI Lock: blocked SAI close (pipeline running)');
            postJobLog('Cannot close SAI terminal — pipeline is running', 'warn');
        }
    }, true); // capture phase so we intercept before React handlers

    // ─── Network Map server-list scraper ──────────────────────────────────────
    // Walks every ServerItem currently rendered in the Network Map and posts
    // the unique non-Home server names back to content.js. Used by the auto-jobs
    // priority UI so the popup can show all known servers.

    function scrapeAndPostNetworkMapServers() {
        const items = document.querySelectorAll(NM_SERVER_ITEM_SEL);
        if (items.length === 0) {
            jmWarn('scrapeNetworkMapServers: no ServerItem elements found');
            return;
        }
        const names = new Set();
        for (const item of items) {
            // Skip the Home server tile — it's not a job target.
            if (item.querySelector('[data-sentry-component="HomeServerIcon"]')) continue;
            const nameEl = item.querySelector(NM_SERVER_NAME_SEL);
            const name = nameEl ? nameEl.textContent.trim() : '';
            if (name) names.add(name);
        }
        const list = [...names].sort();
        jmLog(`scrapeNetworkMapServers: ${list.length} server(s) — ${list.join(', ')}`);
        window.postMessage({ type: 'COR3_NM_SERVERS', servers: list }, '*');
    }

    // ─── Network Map auto-opener ──────────────────────────────────────────────
    // Finds the Network Map shortcut on the desktop and double-clicks it.

    const NM_APP_SEL = '[data-sentry-component="NetworkMapApplication"]';

    async function ensureNetworkMapOpen(timeoutMs = 15_000) {
        const serverItemCount = document.querySelectorAll(NM_SERVER_ITEM_SEL).length;
        console.log(`[COR3 DBG] ensureNetworkMapOpen: NM_SERVER_ITEM_SEL found ${serverItemCount} items`);
        // Already open?
        if (serverItemCount > 0) return true;

        // Dump all TabBarItem-* components to help identify the correct selector
        const tabItems = document.querySelectorAll('[data-component-name^="TabBarItem"]');
        console.log(`[COR3 DBG] ensureNetworkMapOpen: TabBarItem elements found: ${tabItems.length} — names: ${[...tabItems].map(el=>el.getAttribute('data-component-name')).join(', ')||'none'}`);

        // Click the Network Map tab in the taskbar
        const nmTabBtn = document.querySelector('[data-component-name="TabBarItem-NETWORK_MAP"]');
        console.log('[COR3 DBG] ensureNetworkMapOpen: TabBarItem-NETWORK_MAP found:', !!nmTabBtn);
        if (!nmTabBtn) {
            jmWarn('Network Map tab button not found in taskbar');
            postJobLog('Network Map button not found in taskbar — open it manually', 'error');
            return false;
        }

        nmTabBtn.click();
        console.log('[JM] Opening Network Map…');
        postJobLog('Opening Network Map…');

        // Wait for server items to appear
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !window.__jobManagerAbort) {
            if (document.querySelector(NM_SERVER_ITEM_SEL)) return true;
            await sleep(300);
        }
        console.warn('[JM] Network Map did not open in time');
        postJobLog('Network Map failed to open in time', 'error');
        return false;
    }

    // Opens the market for a given server via NM → server click → Market button click.
    // serverName = null means home server (first item in NM list).
    // serverName = 'D4RK RM7MI' (or similar) for dark market.
    async function openServerMarket(serverName, timeoutMs = 20_000) {
        // Already showing job cards — market is open
        if (document.querySelector('[data-component-name="JobCard"]')) return true;

        // Make sure Network Map is open
        const nmOk = await ensureNetworkMapOpen(Math.min(timeoutMs / 2, 12_000));
        if (!nmOk) return false;

        // Find the server item in NM
        let item;
        if (serverName) {
            item = findServerItemByName(serverName);
            if (!item) {
                console.warn('[JM] openServerMarket: server not found in NM:', serverName);
                postJobLog(`Market: server "${serverName}" not found in NM`, 'error');
                return false;
            }
        } else {
            item = document.querySelector(NM_SERVER_ITEM_SEL); // home = first server
            if (!item) return false;
        }

        // Click the server icon to select it and show the side panel
        const icon = item.querySelector(NM_SERVER_ICON_SEL);
        clickEl(icon || item);
        await sleep(600);

        const deadline = Date.now() + timeoutMs;

        // For non-home servers: click Connect if needed, then wait for it to clear
        if (serverName) {
            const connectBtn = document.querySelector(NM_CONNECT_BTN_SEL);
            if (connectBtn) {
                console.log('[JM] openServerMarket: clicking Connect for', serverName);
                clickEl(connectBtn.closest('button') || connectBtn);
                while (Date.now() < deadline && !window.__jobManagerAbort) {
                    if (!document.querySelector(NM_CONNECT_BTN_SEL)) break;
                    await sleep(400);
                }
                await sleep(500);
            }
        }

        // Wait for the MarketIcon button to appear in the side panel
        while (Date.now() < deadline && !window.__jobManagerAbort) {
            const mktBtn = document.querySelector('[data-sentry-component="MarketIcon"]')?.closest('button');
            if (mktBtn) {
                const label = serverName ? `D4RK Market` : 'Home Market';
                postJobLog(`Opening ${label}…`);
                console.log(`[JM] Opening ${label}…`);
                mktBtn.click();
                await sleep(800);
                // If market opened on a non-Job tab, click the Job tab explicitly
                if (!document.querySelector('[data-component-name="JobCard"]')) {
                    const nav = document.querySelector('[data-component-name="MarketNav"]');
                    const jobTabBtn = nav && nav.querySelectorAll('button')[1]; // Job is always 2nd tab
                    if (jobTabBtn) { jobTabBtn.click(); await sleep(500); }
                }
                // Wait for JobCard elements to confirm market is on Jobs tab
                const cardDeadline = Date.now() + 8_000;
                while (Date.now() < cardDeadline && !window.__jobManagerAbort) {
                    if (document.querySelector('[data-component-name="JobCard"]')) return true;
                    await sleep(300);
                }
                postJobLog(`${label} opened but no job cards visible`, 'warn');
                return false;
            }
            await sleep(400);
        }
        console.warn('[JM] openServerMarket: Market button not found for', serverName || 'home server');
        postJobLog(`Market button not found for ${serverName || 'home server'}`, 'error');
        return false;
    }

    // ─── Message listener ─────────────────────────────────────────────────────

    window.addEventListener('message', function (event) {
        if (event.source !== window || !event.data) return;

        if (event.data.type === 'COR3_LOCK_UI') {
            window.__pipelineLocked = true;
            jmLog('UI locked');
        }

        if (event.data.type === 'COR3_UNLOCK_UI') {
            window.__pipelineLocked = false;
            jmLog('UI unlocked');
        }

        if (event.data.type === 'COR3_OPEN_NETWORK_MAP') {
            jmLog('open Network Map (request)');
            (async () => {
                const ok = await ensureNetworkMapOpen();
                if (ok) {
                    // Brief settle so React finishes rendering all server tiles before scraping.
                    await sleep(400);
                    scrapeAndPostNetworkMapServers();
                }
            })();
        }

        if (event.data.type === 'COR3_REQUEST_NM_SERVERS') {
            (async () => {
                const ok = await ensureNetworkMapOpen();
                if (!ok) return;
                await sleep(400);
                scrapeAndPostNetworkMapServers();
            })();
        }

        if (event.data.type === 'COR3_AUTOJOBS_ACTIVE_CHANGED') {
            window.__autoJobsActive = !!event.data.active;
            jmLog(`auto-jobs active = ${window.__autoJobsActive}`);
        }

        if (event.data.type === 'COR3_OPEN_MARKET_JOBS') {
            const { home, dark } = event.data;
            jmLog(`open markets — home=${home !== false} dark=${dark !== false}`);
            (async () => {
                if (home !== false) await openServerMarket(null, 20_000);
                if (dark !== false) await openServerMarket('D4RK RM7MI', 20_000);
            })();
        }

        // Single helper for every START_*_FLOW handler — sets locks, logs the
        // entry with full params, then awaits the solver and clears locks.
        function startFlow(name, fn, params) {
            window.__jobManagerAbort = false;
            window.__pipelineLocked  = true;
            watchingJob              = false;
            jmLog(`flow START ${name}`, params);
            fn().then(() => {
                jmLog(`flow END ${name} jobId=${params.jobId}`);
            }).catch(err => {
                jmErr(`flow CRASH ${name} jobId=${params.jobId}`, err);
            }).finally(() => {
                window.__pipelineLocked = false;
            });
        }

        if (event.data.type === 'COR3_START_JOB_FLOW') {
            const { jobId, marketId, fileCondition } = event.data;
            startFlow('FileDecryption', () => solveFdFlow(jobId, marketId, fileCondition),
                { jobId, marketId, fileCondition });
        }
        if (event.data.type === 'COR3_START_UPLOAD_JOB_FLOW') {
            const { jobId, marketId, serverName, fileCondition } = event.data;
            startFlow('Upload', () => solveUploadJobFlow(jobId, marketId, serverName, fileCondition),
                { jobId, marketId, serverName, fileCondition });
        }
        if (event.data.type === 'COR3_START_IP_JOB_FLOW') {
            const { jobId, marketId, serverName, ips } = event.data;
            startFlow('IPInjection', () => solveIpJobFlow(jobId, marketId, serverName, ips),
                { jobId, marketId, serverName, ips });
        }
        if (event.data.type === 'COR3_START_IP_CLEANUP_FLOW') {
            const { jobId, marketId, serverName, ips } = event.data;
            startFlow('IPCleanup', () => solveIpCleanupFlow(jobId, marketId, serverName, ips),
                { jobId, marketId, serverName, ips });
        }
        if (event.data.type === 'COR3_START_LOG_DELETION_FLOW') {
            const { jobId, marketId, serverName, fileCondition, logSeqs } = event.data;
            startFlow('LogDeletion', () => solveLogDeletionFlow(jobId, marketId, serverName, fileCondition, logSeqs),
                { jobId, marketId, serverName, fileCondition, logSeqs });
        }
        if (event.data.type === 'COR3_START_LOG_DOWNLOAD_FLOW') {
            const { jobId, marketId, serverName, fileCondition, logSeqs } = event.data;
            startFlow('LogDownload', () => solveLogDownloadFlow(jobId, marketId, serverName, fileCondition, logSeqs),
                { jobId, marketId, serverName, fileCondition, logSeqs });
        }
        if (event.data.type === 'COR3_START_FILE_ELIMINATION_FLOW') {
            const { jobId, marketId, serverName, fileCondition } = event.data;
            startFlow('FileElimination', () => solveFileEliminationFlow(jobId, marketId, serverName, fileCondition),
                { jobId, marketId, serverName, fileCondition });
        }
        if (event.data.type === 'COR3_START_DATA_DOWNLOAD_FLOW') {
            const { jobId, marketId, serverName, fileNames } = event.data;
            startFlow('DataDownload', () => solveDataDownloadFlow(jobId, marketId, serverName, fileNames),
                { jobId, marketId, serverName, fileNames });
        }
        if (event.data.type === 'COR3_START_DECRYPT_EXTRACT_FLOW') {
            const { jobId, marketId, serverName, fileCondition } = event.data;
            startFlow('DecryptExtract', () => solveDecryptExtractFlow(jobId, marketId, serverName, fileCondition),
                { jobId, marketId, serverName, fileCondition });
        }

        if (event.data.type === 'COR3_ABORT_JOB_FLOW') {
            window.__jobManagerAbort = true;
            window.__pipelineLocked = false;
            watchingJob = false;
            jmWarn('flow ABORTED');
        }

        // WS "no-path-to-server" received — flag for step 5 fast-fail in connectToServer
        if (event.data.type === 'COR3_WS_DARK_MARKET_UNREACHABLE') {
            window.__serverPathFailed = Date.now();
            jmWarn('WS reported no path to dark market server');
        }
    });
})();
