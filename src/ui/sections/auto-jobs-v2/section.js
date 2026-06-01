// Auto-Jobs v2 section — Network Map, START/STOP, Activity log, Download log.
//
// Bare functionality:
//   - START/STOP writes to STORAGE_SYNC.AUTOJOBS_V2_SETTINGS (NOT
//     AUTOJOBS_SETTINGS), so toggling v2 leaves v1 untouched. Also
//     dispatches a `toggleAutoJobsV2` runtime message for forward
//     compatibility — no content script handles it yet.
//   - Activity log filtered to module id 'auto-jobs-v2'. No backend
//     module writes under that id yet, so the log is empty until v2's
//     runtime exists.
//   - Download Log goes through COR3.autoJobsV2.logExport (v2 settings
//     + v2-only logs).
//   - Network Map uses COR3.uiComponentsV2.networkMap.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C, uiComponents } = root.COR3;
    const uiComponentsV2 = root.COR3.uiComponentsV2 || {};
    const t = (k, vars) => root.COR3.i18n.t(k, vars);

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    async function getCor3Tab() {
        const [tab] = await chrome.tabs.query({ url: ['https://cor3.gg/*', 'https://os.cor3.gg/*'] });
        return tab || null;
    }

    const DEFAULT_SETTINGS = { enabled: false };

    let liveLogViewer = null;
    let liveMasterSwitches = null;
    let liveNetworkMap = null;
    let liveJobList = null;
    let liveFlowMap = null;
    let panel = null;

    function renderHeader(host, settings, offSolvers) {
        host.innerHTML = '';
        offSolvers = offSolvers || [];

        const head = el('div', 'card');

        const topRow = el('div', 'card-row');
        topRow.innerHTML = `
            <span class="card-label">${escape(t('autojobsV2.title'))}</span>
            <span class="pill ${settings.enabled ? 'active' : 'idle'}">${settings.enabled ? t('common.on') : t('common.off')}</span>
        `;
        head.appendChild(topRow);

        // Block START while any required solver is OFF in Overview — v2 would
        // otherwise accept decrypt/hack jobs it can't actually solve. STOP is never
        // blocked (the user must always be able to stop a running pipeline).
        const blockStart = !settings.enabled && offSolvers.length > 0;

        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? t('common.stop') : t('common.start'));
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled && !blockStart);
        if (blockStart) {
            toggleBtn.disabled = true;
            toggleBtn.title = `Enable the disabled solver(s) in Overview first: ${offSolvers.join(', ')}`;
        }
        toggleBtn.addEventListener('click', async () => {
            if (blockStart) return;
            const nextSettings = { enabled: !settings.enabled };
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS, nextSettings);
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS_V2.TOGGLE, settings: nextSettings }).catch(() => {});
        });
        head.appendChild(toggleBtn);

        // Notification: which decrypt solvers are OFF in Overview. Shown whenever any
        // is off (even while v2 runs — it would stall on those minigames).
        if (offSolvers.length > 0) {
            const warn = el('div', 'mt-sm');
            Object.assign(warn.style, {
                padding: '6px 8px', borderRadius: '4px', fontSize: '11px', lineHeight: '1.35',
                background: 'rgba(255,90,90,0.12)', border: '1px solid rgba(255,90,90,0.55)', color: '#ffb3b3',
            });
            warn.innerHTML = `⚠ Solver(s) OFF in Overview: <b>${escape(offSolvers.join(', '))}</b>.<br>`
                + `Auto-Jobs v2 can't solve the minigames without them — enable them in Overview to `
                + `${settings.enabled ? 'avoid stalls' : 'START'}.`;
            head.appendChild(warn);
        }

        const downloadLabel = t('autojobs.downloadLog');
        const downloadBtn = el('button', 'btn small btn-block mt-sm', downloadLabel);
        downloadBtn.title = t('autojobs.downloadLogTip');
        downloadBtn.addEventListener('click', async () => {
            try {
                const exporter = root.COR3.autoJobsV2 && root.COR3.autoJobsV2.logExport;
                if (!exporter || typeof exporter.downloadDebugBundle !== 'function') {
                    alert(t('autojobs.downloadUnavailable'));
                    return;
                }
                downloadBtn.disabled = true;
                downloadBtn.textContent = t('autojobs.downloadBuilding');
                const bytes = await exporter.downloadDebugBundle();
                downloadBtn.textContent = t('autojobs.downloadDone', { kb: Math.ceil((bytes || 0) / 1024) });
                setTimeout(() => { downloadBtn.disabled = false; downloadBtn.textContent = downloadLabel; }, 2500);
            } catch (err) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = downloadLabel;
                alert(t('autojobs.downloadFailed', { error: (err && err.message) || err }));
            }
        });
        head.appendChild(downloadBtn);

        const clearBuggedBtn = el('button', 'btn small btn-block mt-sm', 'Clear Bugged');
        clearBuggedBtn.title = 'Remove all jobs from the v2 bugged list';
        clearBuggedBtn.addEventListener('click', async () => {
            await Store.local.setOne(C.STORAGE_LOCAL.AJV2_BUGGED_JOBS, {});
            clearBuggedBtn.textContent = 'Cleared';
            setTimeout(() => { clearBuggedBtn.textContent = 'Clear Bugged'; }, 1500);
        });
        head.appendChild(clearBuggedBtn);

        host.appendChild(head);
    }

    // v2's file_decryption + SAI-hack flows can mount ANY of the three minigames,
    // so all three solver toggles (Overview) must be ON for v2 to actually solve
    // them. Read them alongside the v2 settings so the header can warn + gate START.
    const REQUIRED_SOLVERS = [
        { key: 'AUTO_DECRYPT_ENABLED',        def: false, label: 'Auto-decrypt' },
        { key: 'AUTO_SIMPLE_DECRYPT_ENABLED', def: false, label: 'Auto-simple-decrypt' },
        { key: 'AUTO_ICE_WALL_ENABLED',       def: true,  label: 'Auto ICE WALL' },
    ];

    async function refreshHeader() {
        if (!panel) return;
        const [settings, ...states] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS, DEFAULT_SETTINGS),
            ...REQUIRED_SOLVERS.map((s) => Store.sync.getOne(C.STORAGE_SYNC[s.key], s.def)),
        ]);
        const offSolvers = REQUIRED_SOLVERS.filter((s, i) => !states[i]).map((s) => s.label);
        renderHeader(panel.headerHost, settings, offSolvers);
    }

    function buildPanel(container) {
        if (panel) tearDownPanel();

        container.innerHTML = '';
        const headerHost  = el('div');
        const masterHost  = el('div', 'ajv2-ms-host');
        const networkHost = el('div', 'aj-network-host');
        const jobsHost    = el('div', 'ajv2-jobs-host');
        const flowHost    = el('div', 'ajv2-flow-host');
        container.appendChild(headerHost);
        container.appendChild(masterHost);
        container.appendChild(networkHost);
        container.appendChild(jobsHost);
        container.appendChild(flowHost);

        if (uiComponentsV2.masterSwitches && typeof uiComponentsV2.masterSwitches.attach === 'function') {
            liveMasterSwitches = uiComponentsV2.masterSwitches.attach(masterHost);
        }

        if (uiComponentsV2.networkMap && typeof uiComponentsV2.networkMap.attach === 'function') {
            liveNetworkMap = uiComponentsV2.networkMap.attach(networkHost);
        }

        if (uiComponentsV2.jobList && typeof uiComponentsV2.jobList.attach === 'function') {
            liveJobList = uiComponentsV2.jobList.attach(jobsHost);
        }

        if (uiComponentsV2.flowMap && typeof uiComponentsV2.flowMap.attach === 'function') {
            liveFlowMap = uiComponentsV2.flowMap.attach(flowHost);
        }

        container.appendChild(el('div', 'section-title', t('autojobs.activityLog')));

        // Clear the Activity-Log buffer. Routed to the content world (where the
        // authoritative log ring lives — a popup-side wipe would be re-flushed by
        // it); only when no game tab is open do we wipe v2 entries from storage
        // directly. (Label hardcoded to match the sibling "Clear Bugged"; the
        // full i18n pass localises both together — see #10.)
        const clearLogBtn = el('button', 'btn small btn-block mt-sm', 'Clear Log');
        clearLogBtn.title = 'Clear the Auto-Jobs v2 activity log buffer';
        clearLogBtn.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) {
                chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS_V2.CLEAR_LOG }).catch(() => {});
            } else {
                const logs = (await Store.local.getOne(C.STORAGE_LOCAL.LOGS, {})) || {};
                for (const id of Object.keys(logs)) if (/^(auto-jobs-v2|flow-v2-.+)$/.test(id)) delete logs[id];
                await Store.local.setOne(C.STORAGE_LOCAL.LOGS, logs);
                if (liveLogViewer) liveLogViewer.refresh();
            }
            clearLogBtn.textContent = 'Cleared';
            setTimeout(() => { clearLogBtn.textContent = 'Clear Log'; }, 1500);
        });
        container.appendChild(clearLogBtn);

        const stream = el('div', 'log-stream');
        container.appendChild(stream);
        if (uiComponents.logViewer && typeof uiComponents.logViewer.attach === 'function') {
            liveLogViewer = uiComponents.logViewer.attach(stream, { moduleFilter: /^(auto-jobs-v2|flow-v2-.+)$/ });
        }

        panel = { container, headerHost, networkHost };
    }

    function tearDownPanel() {
        if (liveLogViewer)  { try { liveLogViewer.destroy();  } catch (_) {} liveLogViewer  = null; }
        if (liveMasterSwitches) { try { liveMasterSwitches.destroy(); } catch (_) {} liveMasterSwitches = null; }
        if (liveNetworkMap) { try { liveNetworkMap.destroy(); } catch (_) {} liveNetworkMap = null; }
        if (liveJobList)    { try { liveJobList.destroy();    } catch (_) {} liveJobList    = null; }
        if (liveFlowMap)    { try { liveFlowMap.destroy();    } catch (_) {} liveFlowMap    = null; }
        panel = null;
    }

    let unsubSync = null;
    root.COR3.ui.autojobsV2 = {
        mount(container) {
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                // Re-render the header on v2 settings OR any required-solver toggle
                // (so the warning + START gate update live as the user flips them).
                if (changes[C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS]
                    || REQUIRED_SOLVERS.some((s) => changes[C.STORAGE_SYNC[s.key]])) refreshHeader();
            });
            buildPanel(container);
            refreshHeader();
        },
        activate(container) {
            buildPanel(container);
            refreshHeader();
        },
        deactivate() {
            tearDownPanel();
        },
    };
})();
