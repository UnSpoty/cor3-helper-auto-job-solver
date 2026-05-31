// Auto-Jobs v2 "Download Log" bundle builder.
//
// Bundle: header (build/web/ext versions) + v2 settings + v2 RUNTIME STATE
// (pipeline node, job-queue board, bugged registry + reasons, master switches,
// server overrides — all v2-owned keys the orchestrator/flows write) + v2
// logger entries (module id `auto-jobs-v2` or `flow-v2-*`). No SERVER_PRIORITIES
// / NM_GRAPH — those are shared with v1 and would leak v1's configuration into
// a "v2-only" download.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, Logger, constants: C } = root.COR3;

    const RELEVANT_MODULE_PATTERN = /^(auto-jobs-v2|flow-v2-.+)$/;

    function fmtTs(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toISOString(); } catch (_) { return String(ts); }
    }

    async function buildDebugBundle() {
        const sl = C.STORAGE_LOCAL;
        const ss = C.STORAGE_SYNC;
        const local = await Store.local.get([
            sl.WEB_VERSION, sl.SYSTEM_VERSION,
            sl.AJV2_PIPELINE_STATE, sl.AJV2_JOB_QUEUE, sl.AJV2_BUGGED_JOBS,
            sl.AJV2_MASTER_SWITCHES, sl.AJV2_SERVER_OVERRIDES,
        ]);
        const sync  = await Store.sync.get([ss.AUTOJOBS_V2_SETTINGS]);

        const lines = [];
        lines.push(`=== COR3 Helper / Auto-Jobs v2 debug log — exported ${new Date().toISOString()} ===`);
        const bi = root.COR3 && root.COR3.buildInfo;
        const mv = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
            ? (chrome.runtime.getManifest().version || '?') : '?';
        lines.push(`Build: ${bi?.commit || 'unknown'} (${bi?.date || '?'})     ExtVersion: ${mv}`);
        lines.push(`WebVersion: ${local[sl.WEB_VERSION] || '?'}     SystemVersion: ${local[sl.SYSTEM_VERSION] || '?'}`);
        lines.push('');
        lines.push('Settings v2:');
        // Print the raw stored value. An ABSENT marker (not a fabricated
        // `{enabled:false}`) so a debug reader can tell "never written" from
        // "explicitly disabled".
        const v2settings = sync[ss.AUTOJOBS_V2_SETTINGS];
        lines.push('  ' + (v2settings === undefined ? '(ABSENT — never written)' : JSON.stringify(v2settings)));
        lines.push('');

        // ── Runtime state (v2-owned keys the orchestrator + flows write) ──
        lines.push('─── Runtime state (v2) ───');

        const ps = local[sl.AJV2_PIPELINE_STATE];
        lines.push('Pipeline (AJV2_PIPELINE_STATE):');
        lines.push('  ' + (ps
            ? `running=${!!ps.running} node=${ps.node || '—'} cycle=${ps.cycle != null ? ps.cycle : '—'} error=${ps.error || '—'} updatedAt=${fmtTs(ps.updatedAt)}`
            : '(none — orchestrator has not run this session)'));

        const bugged = local[sl.AJV2_BUGGED_JOBS];
        const buggedKeys = (bugged && typeof bugged === 'object') ? Object.keys(bugged) : [];
        lines.push(`Bugged jobs (AJV2_BUGGED_JOBS): ${buggedKeys.length}`);
        if (!buggedKeys.length) lines.push('  (none)');
        else for (const id of buggedKeys) {
            const b = bugged[id] || {};
            lines.push(`  ${id} — ${b.reason || '?'} (since ${fmtTs(b.since)})`);
        }

        const q = local[sl.AJV2_JOB_QUEUE];
        lines.push('Job queue (AJV2_JOB_QUEUE):');
        if (!q || !Array.isArray(q.jobs)) {
            lines.push('  (none — JOB_QUEUE has not been built this session)');
        } else {
            lines.push(`  cycle=${q.cycle != null ? q.cycle : '—'} computedAt=${fmtTs(q.computedAt)} jobs=${q.jobs.length}`);
            if (Array.isArray(q.markets)) for (const m of q.markets) {
                lines.push(`  market ${m.slot}: reachable=${!!m.reachable} avail=${m.jobCount} taken=${m.takenCount}${m.reason ? ` (${m.reason})` : ''}`);
            }
            for (const j of q.jobs) {
                const elig = j.eligible === true ? 'eligible' : (j.eligible === false ? 'SKIP' : 'pending');
                const reason = j.skipReason ? ` — ${j.skipReason}` : '';
                lines.push(`    [${j.status || '?'}] ${j.name || '?'} <${j.type || 'unrecognised'}> @${j.marketSlot || '?'} srv=${j.serverName || '—'} → ${elig}${reason}`);
            }
        }

        const ms = local[sl.AJV2_MASTER_SWITCHES];
        lines.push('Master switches (AJV2_MASTER_SWITCHES):');
        lines.push('  ' + (ms === undefined ? '(ABSENT — never written)' : JSON.stringify(ms)));

        const so = local[sl.AJV2_SERVER_OVERRIDES];
        const soKeys = (so && typeof so === 'object') ? Object.keys(so) : [];
        lines.push(`Server overrides (AJV2_SERVER_OVERRIDES): ${soKeys.length}`);
        if (soKeys.length) lines.push('  ' + JSON.stringify(so));

        lines.push('');
        lines.push('─── Logs (v2 only) ───');

        try {
            // Read straight from chrome.storage.local 'cor3_logs' — the SAME
            // source the on-screen Activity Log uses (log-viewer.js). The popup's
            // in-memory Logger.getAll() buffer is stale here: the popup is a
            // separate context from the content scripts that WRITE these logs,
            // and ensureBuffer() snapshots storage once then never re-reads it,
            // so Logger.getAll() froze the export at the first download.
            const all = (await Store.local.getOne(C.STORAGE_LOCAL.LOGS, {})) || {};
            if (all && typeof all === 'object') {
                const moduleIds = Object.keys(all).filter((id) => RELEVANT_MODULE_PATTERN.test(id)).sort();
                if (!moduleIds.length) {
                    lines.push('(no v2 log entries yet — no module is writing under the auto-jobs-v2 id)');
                }
                for (const id of moduleIds) {
                    const entries = Array.isArray(all[id])
                        ? all[id].slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))
                        : [];
                    if (!entries.length) continue;
                    lines.push('');
                    lines.push(`── ${id} (${entries.length} entries) ──`);
                    for (const e of entries) {
                        const ctx = e.ctx ? ` ${typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx)}` : '';
                        lines.push(`[${fmtTs(e.ts)}] ${String(e.level || '?').toUpperCase()}: ${e.msg || ''}${ctx}`);
                    }
                }
            } else {
                lines.push('(cor3_logs unavailable in this context)');
            }
        } catch (err) {
            lines.push(`(failed to read logs: ${String(err && err.message || err)})`);
        }

        return lines.join('\n');
    }

    async function downloadDebugBundle(filename) {
        const text = await buildDebugBundle();
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `cor3-autojobs-v2-debug-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return text.length;
    }

    root.COR3.autoJobsV2 = root.COR3.autoJobsV2 || {};
    root.COR3.autoJobsV2.logExport = { buildDebugBundle, downloadDebugBundle };
})();
