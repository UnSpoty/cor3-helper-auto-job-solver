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
    let liveNetworkMap = null;
    let liveJobList = null;
    let liveFlowMap = null;
    let panel = null;

    function renderHeader(host, settings) {
        host.innerHTML = '';

        const head = el('div', 'card');

        const topRow = el('div', 'card-row');
        topRow.innerHTML = `
            <span class="card-label">${escape(t('autojobsV2.title'))}</span>
            <span class="pill ${settings.enabled ? 'active' : 'idle'}">${settings.enabled ? t('common.on') : t('common.off')}</span>
        `;
        head.appendChild(topRow);

        const toggleBtn = el('button', 'btn btn-block mt-sm', settings.enabled ? t('common.stop') : t('common.start'));
        toggleBtn.classList.toggle('btn-danger', !!settings.enabled);
        toggleBtn.classList.toggle('btn-success', !settings.enabled);
        toggleBtn.addEventListener('click', async () => {
            const nextSettings = { enabled: !settings.enabled };
            await Store.sync.setOne(C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS, nextSettings);
            const tab = await getCor3Tab();
            if (tab) chrome.tabs.sendMessage(tab.id, { action: C.MSG.AUTOJOBS_V2.TOGGLE, settings: nextSettings }).catch(() => {});
        });
        head.appendChild(toggleBtn);

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

        host.appendChild(head);
    }

    async function refreshHeader() {
        if (!panel) return;
        const settings = await Store.sync.getOne(C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS, DEFAULT_SETTINGS);
        renderHeader(panel.headerHost, settings);
    }

    function buildPanel(container) {
        if (panel) tearDownPanel();

        container.innerHTML = '';
        const headerHost  = el('div');
        const networkHost = el('div', 'aj-network-host');
        const jobsHost    = el('div', 'ajv2-jobs-host');
        const flowHost    = el('div', 'ajv2-flow-host');
        container.appendChild(headerHost);
        container.appendChild(networkHost);
        container.appendChild(jobsHost);
        container.appendChild(flowHost);

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
        const stream = el('div', 'log-stream');
        container.appendChild(stream);
        if (uiComponents.logViewer && typeof uiComponents.logViewer.attach === 'function') {
            liveLogViewer = uiComponents.logViewer.attach(stream, { moduleFilter: 'auto-jobs-v2' });
        }

        panel = { container, headerHost, networkHost };
    }

    function tearDownPanel() {
        if (liveLogViewer)  { try { liveLogViewer.destroy();  } catch (_) {} liveLogViewer  = null; }
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
                if (changes[C.STORAGE_SYNC.AUTOJOBS_V2_SETTINGS]) refreshHeader();
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
