// Auto Jobs — pipeline live status (compact).
//
// Replaces the old SVG flowchart "Flow Map": a one-/two-line readout of what the
// orchestrator is doing RIGHT NOW — current stage, cycle number, and a DELAY
// countdown bar while it sleeps between cycles. It reads the SAME
// STORAGE_LOCAL.AJ_PIPELINE_STATE the orchestrator stamps on every node
// transition (node ids from COR3.constants.AJ.NODE), so it stays in lock-step
// with the live pipeline without any layout to maintain.
//
// Still exposed as COR3.uiComponents.flowMap.attach() (same mount contract in
// section.js) — only the rendering changed.

(function () {
    const root = window;
    if (!root.COR3 || !root.COR3.constants) return;
    const C = root.COR3.constants;
    const { Store } = root.COR3;
    const t = (k, vars) => root.COR3.i18n.t(k, vars);
    const NODE = C.AJ.NODE;
    const SL = C.STORAGE_LOCAL;

    // node id → readable phrase. Flow node names intentionally stay English (the
    // established i18n policy for the flow internals). Built from the constants so
    // it can't drift from the ids the orchestrator / flows actually stamp.
    const LABELS = {};
    const set = (id, label) => { if (id) LABELS[id] = label; };
    set(NODE.START, 'Start');
    set(NODE.DELAY_INITIAL, 'Startup delay');
    set(NODE.GET_SERVERS, 'Get servers');
    set(NODE.CHECK_ACCESS, 'Check server access');
    set(NODE.UPDATE_MARKETS, 'Update markets');
    set(NODE.JOB_QUEUE, 'Build job queue');
    set(NODE.READY_TO_COMPLETE, 'Complete finished jobs');
    set(NODE.DISMISS_FAILED, 'Dismiss failed jobs');
    set(NODE.QUEUE_EMPTY, 'Queue empty?');
    set(NODE.HAVE_TASKS_IN_PROGRESS, 'Tasks in progress?');
    set(NODE.BUGGED_JOBS, 'In-progress bugged?');
    set(NODE.JOB_SKIP, 'Skip bugged flows');
    set(NODE.CHECK_CONDITION, 'Check job conditions');
    set(NODE.JOB_ACCEPTION, 'Accept jobs');
    set(NODE.JOB_FLOW, 'Run job flows');
    set(NODE.MARK_AS_BUGGED, 'Mark job bugged');
    set(NODE.DELAY_CYCLE, 'Cycle delay');
    // file_decryption sub-flow.
    set(NODE.FD_READ_FORMAT, 'Decrypt · read format');
    set(NODE.FD_CHECK_LOADOUT, 'Decrypt · check software');
    set(NODE.FD_INSTALL_SW, 'Decrypt · install/swap software');
    set(NODE.FD_OPEN_DOWNLOADS, 'Decrypt · open file');
    set(NODE.FD_SOLVE, 'Decrypt · solve minigame');
    set(NODE.FD_COMPLETE, 'Decrypt · complete');
    // decrypt_extract sub-flow.
    set(NODE.DE_ACCESS, 'Decrypt+extract · access');
    set(NODE.DE_DOWNLOAD, 'Decrypt+extract · download');
    set(NODE.DE_INSTALL_SW, 'Decrypt+extract · install/swap software');
    set(NODE.DE_SOLVE, 'Decrypt+extract · solve minigame');
    set(NODE.DE_COMPLETE, 'Decrypt+extract · complete');
    // SAI shared hack step.
    set(NODE.SAI_HACK, 'SAI · hack for access');
    // SAI mutation flows: <access> → <action> → <complete>.
    const sai = (acc, act, comp, name, actWord) => {
        set(acc, `${name} · access`);
        set(act, `${name} · ${actWord}`);
        set(comp, `${name} · complete`);
    };
    sai(NODE.II_ACCESS, NODE.II_INJECT, NODE.II_COMPLETE, 'IP inject', 'inject IPs');
    sai(NODE.IC_ACCESS, NODE.IC_CLEANUP, NODE.IC_COMPLETE, 'IP cleanup', 'remove IPs');
    sai(NODE.FE_ACCESS, NODE.FE_DELETE, NODE.FE_COMPLETE, 'Delete file', 'delete');
    sai(NODE.DD_ACCESS, NODE.DD_DOWNLOAD, NODE.DD_COMPLETE, 'Download', 'download');
    sai(NODE.FU_ACCESS, NODE.FU_UPLOAD, NODE.FU_COMPLETE, 'Upload', 'upload');
    sai(NODE.LG_ACCESS, NODE.LG_DOWNLOAD, NODE.LG_COMPLETE, 'Download log', 'download');
    sai(NODE.LD_ACCESS, NODE.LD_DELETE, NODE.LD_COMPLETE, 'Delete log', 'delete');

    // DELAY node → its total duration, used as the fallback when the orchestrator
    // hasn't published the ACTUAL wait (state.delayMs, 5s active vs 30s idle, which
    // is preferred when present — see renderState).
    const DELAY_MS = {
        [NODE.DELAY_INITIAL]: C.AJ.LOOP.INITIAL_DELAY_MS,
        [NODE.DELAY_CYCLE]: C.AJ.LOOP.CYCLE_DELAY_MS,
    };

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function attach(container) {
        container.classList.add('aj-flow-host');
        container.innerHTML = '';

        const wrap = el('div', 'aj-pipe');

        const head = el('div', 'aj-flow-head');
        head.appendChild(el('span', 'card-label', t('autojobs.flowMap')));
        const badge = el('span', 'muted xs aj-flow-status', t('autojobs.flowIdle'));
        head.appendChild(badge);
        wrap.appendChild(head);

        const nowLine = el('div', 'aj-pipe-now');

        const delayWrap = el('div', 'aj-pipe-delay');
        const delayLabel = el('span', 'aj-pipe-delay-label muted xs');
        const delayTrack = el('div', 'aj-pipe-delay-track');
        const delayBar = el('div', 'aj-pipe-delay-bar');
        delayTrack.appendChild(delayBar);
        delayWrap.appendChild(delayLabel);
        delayWrap.appendChild(delayTrack);

        wrap.appendChild(nowLine);
        wrap.appendChild(delayWrap);
        container.appendChild(wrap);

        // DELAY countdown — runs locally between storage writes (the orchestrator
        // is asleep during a delay, so it won't tick the state).
        let delayTimer = null;
        function stopDelay() {
            if (delayTimer) { clearInterval(delayTimer); delayTimer = null; }
            delayWrap.style.display = 'none';
        }
        function startDelay(durMs, startTs) {
            const dur = Number(durMs) || 0;
            if (!dur) { stopDelay(); return; }
            delayWrap.style.display = '';
            const ts = Number(startTs) || Date.now();
            const tick = () => {
                const elapsed = Date.now() - ts;
                const frac = Math.max(0, Math.min(1, elapsed / dur));
                const remaining = Math.max(0, Math.ceil((dur - elapsed) / 1000));
                delayBar.style.width = (frac * 100).toFixed(1) + '%';
                delayLabel.textContent = `DELAY ${remaining}s`;
            };
            if (delayTimer) clearInterval(delayTimer);
            tick();
            delayTimer = setInterval(tick, 200);
        }

        function renderState(state) {
            if (!state || !state.running) {
                badge.textContent = t('autojobs.flowIdle');
                nowLine.textContent = '—';
                stopDelay();
                return;
            }
            // Running → always show a cycle badge (cycle 0 during START / startup
            // delay before the first cycle), never a blank.
            badge.textContent = t('autojobs.cycleN', { n: state.cycle || 0 });
            nowLine.textContent = state.error
                ? t('autojobs.flowError', { error: state.error })
                : (LABELS[state.node] || state.node || '—');
            // Prefer the orchestrator's published delayMs; fall back to the node's
            // static duration so the countdown still shows if delayMs is ever absent.
            if (state.node && DELAY_MS[state.node]) startDelay(state.delayMs || DELAY_MS[state.node], state.updatedAt);
            else stopDelay();
        }

        const unsub = Store.local.onChanged((changes) => {
            if (changes[SL.AJ_PIPELINE_STATE]) renderState(changes[SL.AJ_PIPELINE_STATE].newValue);
        });
        Store.local.getOne(SL.AJ_PIPELINE_STATE, null).then(renderState);

        return {
            destroy() {
                if (typeof unsub === 'function') unsub();
                if (delayTimer) clearInterval(delayTimer);
                container.innerHTML = '';
            },
        };
    }

    root.COR3.uiComponents = root.COR3.uiComponents || {};
    root.COR3.uiComponents.flowMap = { attach };
})();
