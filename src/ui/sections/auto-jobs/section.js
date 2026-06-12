// Auto Jobs section — Network Map, START/STOP, Activity log, Download log.
//
// Bare functionality:
//   - START/STOP writes to STORAGE_SYNC.AUTOJOBS_SETTINGS and dispatches a
//     `toggleAutoJobs` runtime message so the orchestrator reacts immediately.
//   - Activity log filtered to module ids 'auto-jobs' + 'flow-*'.
//   - Download Log goes through COR3.autoJobs.logExport.
//   - Network Map uses COR3.uiComponents.networkMap.

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C } = root.COR3;
    const uiComponents = root.COR3.uiComponents || {};
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
    let liveVisibilitySub = null;
    let panel = null;

    function renderHeader(host, settings, offSolvers) {
        host.innerHTML = '';
        offSolvers = offSolvers || [];

        const head = el('div', 'card');

        const topRow = el('div', 'card-row');
        topRow.innerHTML = `
            <span class="card-label">${escape(t('autojobs.title'))}</span>
            <span class="pill ${settings.enabled ? 'active' : 'idle'}">${settings.enabled ? t('common.on') : t('common.off')}</span>
        `;
        head.appendChild(topRow);

        // Block START while any required solver is OFF in Overview — Auto Jobs would
        // otherwise accept decrypt/hack jobs it can't actually solve. STOP is never
        // blocked (the user must always be able to stop a running pipeline).
        const blockStart = !settings.enabled && offSolvers.length > 0;

        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? t('common.stop') : t('common.start'));
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled && !blockStart);
        if (blockStart) {
            toggleBtn.disabled = true;
            toggleBtn.title = t('autojobs.requiredSolversTip', { names: offSolvers.join(', ') });
        }
        toggleBtn.addEventListener('click', async () => {
            if (blockStart) return;
            const nextSettings = { enabled: !settings.enabled };
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, nextSettings);
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS.TOGGLE, settings: nextSettings }).catch(() => {});
        });
        head.appendChild(toggleBtn);

        // Notification: which decrypt solvers are OFF in Overview. Shown whenever any
        // is off (even while the loop runs — it would stall on those minigames).
        if (offSolvers.length > 0) {
            const warn = el('div', 'mt-sm');
            Object.assign(warn.style, {
                padding: '6px 8px', borderRadius: '4px', fontSize: '11px', lineHeight: '1.35',
                background: 'rgba(255,90,90,0.12)', border: '1px solid rgba(255,90,90,0.55)', color: '#ffb3b3',
            });
            const action = settings.enabled ? t('autojobs.solversOffAvoidStalls') : t('common.start');
            warn.innerHTML = `⚠ ${escape(t('autojobs.solversOffLabel'))} <b>${escape(offSolvers.join(', '))}</b>.<br>`
                + escape(t('autojobs.solversOffWarn', { action }));
            head.appendChild(warn);
        }

        const downloadLabel = t('autojobs.downloadLog');
        const downloadBtn = el('button', 'btn small btn-block mt-sm', downloadLabel);
        downloadBtn.title = t('autojobs.downloadLogTip');
        downloadBtn.addEventListener('click', async () => {
            try {
                const exporter = root.COR3.autoJobs && root.COR3.autoJobs.logExport;
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

        const clearBuggedLabel = t('autojobs.clearBugged');
        const clearBuggedBtn = el('button', 'btn small btn-block mt-sm', clearBuggedLabel);
        clearBuggedBtn.title = t('autojobs.clearBuggedTip');
        clearBuggedBtn.addEventListener('click', async () => {
            await Store.local.setOne(C.STORAGE_LOCAL.AJ_BUGGED_JOBS, {});
            clearBuggedBtn.textContent = t('autojobs.cleared');
            setTimeout(() => { clearBuggedBtn.textContent = clearBuggedLabel; }, 1500);
        });
        head.appendChild(clearBuggedBtn);

        host.appendChild(head);
    }

    // the file_decryption + SAI-hack flows can mount ANY of the three minigames,
    // so all three solver toggles (Overview) must be ON for Auto Jobs to actually solve
    // them. Read them alongside the Auto Jobs settings so the header can warn + gate START.
    const REQUIRED_SOLVERS = [
        { key: 'AUTO_DECRYPT_ENABLED',        def: false, labelKey: 'overview.autoDecrypt' },
        { key: 'AUTO_SIMPLE_DECRYPT_ENABLED', def: false, labelKey: 'overview.autoSimpleDecrypt' },
        { key: 'AUTO_ICE_WALL_ENABLED',       def: true,  labelKey: 'overview.autoIceWall' },
    ];

    async function refreshHeader() {
        if (!panel) return;
        const [settings, ...states] = await Promise.all([
            Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_SETTINGS, DEFAULT_SETTINGS),
            ...REQUIRED_SOLVERS.map((s) => Store.sync.getOne(C.STORAGE_SYNC[s.key], s.def)),
        ]);
        const offSolvers = REQUIRED_SOLVERS.filter((s, i) => !states[i]).map((s) => t(s.labelKey));
        renderHeader(panel.headerHost, settings, offSolvers);
    }

    function buildPanel(container) {
        if (panel) tearDownPanel();

        container.innerHTML = '';
        const headerHost  = el('div');
        const masterHost  = el('div', 'aj-ms-host');
        const networkHost = el('div', 'aj-network-host');
        const jobsHost    = el('div', 'aj-jobs-host');
        const flowHost    = el('div', 'aj-flow-host');
        container.appendChild(headerHost);
        container.appendChild(masterHost);
        container.appendChild(networkHost);
        container.appendChild(jobsHost);
        container.appendChild(flowHost);

        if (uiComponents.masterSwitches && typeof uiComponents.masterSwitches.attach === 'function') {
            liveMasterSwitches = uiComponents.masterSwitches.attach(masterHost);
        }

        if (uiComponents.networkMap && typeof uiComponents.networkMap.attach === 'function') {
            liveNetworkMap = uiComponents.networkMap.attach(networkHost);
        }

        if (uiComponents.jobList && typeof uiComponents.jobList.attach === 'function') {
            liveJobList = uiComponents.jobList.attach(jobsHost);
        }

        if (uiComponents.flowMap && typeof uiComponents.flowMap.attach === 'function') {
            liveFlowMap = uiComponents.flowMap.attach(flowHost);
        }

        // The Activity-Log block (title + clear button + stream) is grouped under
        // one host so the "UI Show" master switch can hide it as a unit.
        const activityHost = el('div', 'aj-activity-host');
        container.appendChild(activityHost);
        activityHost.appendChild(el('div', 'section-title', t('autojobs.activityLog')));

        // Clear the Activity-Log buffer. Routed to the content world (where the
        // authoritative log ring lives — a popup-side wipe would be re-flushed by
        // it); only when no game tab is open do we wipe Auto Jobs entries from storage
        // directly.
        const clearLogLabel = t('autojobs.clearLog');
        const clearLogBtn = el('button', 'btn small btn-block mt-sm', clearLogLabel);
        clearLogBtn.title = t('autojobs.clearLogTip');
        clearLogBtn.addEventListener('click', async () => {
            const tab = await getCor3Tab();
            if (tab) {
                chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS.CLEAR_LOG }).catch(() => {});
            } else {
                const logs = (await Store.local.getOne(C.STORAGE_LOCAL.LOGS, {})) || {};
                for (const id of Object.keys(logs)) if (/^(auto-jobs|flow-.+)$/.test(id)) delete logs[id];
                await Store.local.setOne(C.STORAGE_LOCAL.LOGS, logs);
                if (liveLogViewer) liveLogViewer.refresh();
            }
            clearLogBtn.textContent = t('autojobs.cleared');
            setTimeout(() => { clearLogBtn.textContent = clearLogLabel; }, 1500);
        });
        activityHost.appendChild(clearLogBtn);

        const stream = el('div', 'log-stream');
        activityHost.appendChild(stream);
        if (uiComponents.logViewer && typeof uiComponents.logViewer.attach === 'function') {
            liveLogViewer = uiComponents.logViewer.attach(stream, { moduleFilter: /^(auto-jobs|flow-.+)$/ });
        }

        // "UI Show" master switches — purely visual. Hide a panel's host without
        // tearing down its component, so the orchestrator (content world) and each
        // panel's live subscriptions keep running while hidden. Default ON
        // (absent === shown), matching master-switches.js. Panel keys come from
        // C.AJ.UI_PANELS — the ONE list shared with the master-switches chips.
        const VIS_HOSTS = {
            networkMap:  networkHost,
            jobs:        jobsHost,
            flowMap:     flowHost,
            activityLog: activityHost,
        };
        function applyUiVisibility(switches) {
            const show = (switches && switches.uiShow) || {};
            for (const key of C.AJ.UI_PANELS) {
                VIS_HOSTS[key].style.display = show[key] === false ? 'none' : '';
            }
        }
        // A change event always carries the freshest value, so once one has
        // fired the initial getOne read is stale by definition — drop it. (A
        // toggle landing while getOne is in flight would otherwise be reverted
        // by the read-time value when the promise resolves.)
        let visSeenChange = false;
        liveVisibilitySub = Store.local.onChanged((c) => {
            if (c[C.STORAGE_LOCAL.AJ_MASTER_SWITCHES]) {
                visSeenChange = true;
                applyUiVisibility(c[C.STORAGE_LOCAL.AJ_MASTER_SWITCHES].newValue || {});
            }
        });
        Store.local.getOne(C.STORAGE_LOCAL.AJ_MASTER_SWITCHES, {}).then((s) => {
            if (!visSeenChange) applyUiVisibility(s || {});
        });

        panel = { container, headerHost, networkHost };
    }

    function tearDownPanel() {
        if (liveLogViewer)  { try { liveLogViewer.destroy();  } catch (_) {} liveLogViewer  = null; }
        if (liveMasterSwitches) { try { liveMasterSwitches.destroy(); } catch (_) {} liveMasterSwitches = null; }
        if (liveNetworkMap) { try { liveNetworkMap.destroy(); } catch (_) {} liveNetworkMap = null; }
        if (liveJobList)    { try { liveJobList.destroy();    } catch (_) {} liveJobList    = null; }
        if (liveFlowMap)    { try { liveFlowMap.destroy();    } catch (_) {} liveFlowMap    = null; }
        if (liveVisibilitySub) { try { liveVisibilitySub(); } catch (_) {} liveVisibilitySub = null; }
        panel = null;
    }

    let unsubSync = null;
    root.COR3.ui.autojobs = {
        mount(container) {
            unsubSync = Store.sync.onChanged((changes) => {
                if (!container.classList.contains('active')) return;
                // Re-render the header on Auto Jobs settings OR any required-solver toggle
                // (so the warning + START gate update live as the user flips them).
                if (changes[C.STORAGE_SYNC.AUTOJOBS_SETTINGS]
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
