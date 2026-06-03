// Auto Jobs "Download Log" bundle builder.
//
// Bundle: header (build/web/ext versions) + Auto Jobs settings + RUNTIME STATE
// (pipeline node, job-queue board, bugged registry + reasons, master switches,
// server overrides — all Auto-Jobs-owned keys the orchestrator/flows write) +
// logger entries (module id `auto-jobs` or `flow-*`). No NM_GRAPH — that is
// shared game state and would bloat an Auto-Jobs-only download.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, constants: C } = root.COR3;

    const RELEVANT_MODULE_PATTERN = /^(auto-jobs|flow-.+)$/;

    function fmtTs(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toISOString(); } catch (_) { return String(ts); }
    }

    async function buildDebugBundle() {
        const sl = C.STORAGE_LOCAL;
        const ss = C.STORAGE_SYNC;
        const local = await Store.local.get([
            sl.WEB_VERSION, sl.SYSTEM_VERSION,
            sl.AJ_PIPELINE_STATE, sl.AJ_JOB_QUEUE, sl.AJ_BUGGED_JOBS,
            sl.AJ_MASTER_SWITCHES, sl.AJ_SERVER_OVERRIDES,
        ]);
        const sync  = await Store.sync.get([ss.AUTOJOBS_SETTINGS]);

        const lines = [];
        lines.push(`=== COR3 Helper / Auto Jobs debug log — exported ${new Date().toISOString()} ===`);
        const bi = root.COR3 && root.COR3.buildInfo;
        const mv = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
            ? (chrome.runtime.getManifest().version || '?') : '?';
        lines.push(`Build: ${bi?.commit || 'unknown'} (${bi?.date || '?'})     ExtVersion: ${mv}`);
        lines.push(`WebVersion: ${local[sl.WEB_VERSION] || '?'}     SystemVersion: ${local[sl.SYSTEM_VERSION] || '?'}`);
        lines.push('');
        lines.push('Settings:');
        // Print the raw stored value. An ABSENT marker (not a fabricated
        // `{enabled:false}`) so a debug reader can tell "never written" from
        // "explicitly disabled".
        const v2settings = sync[ss.AUTOJOBS_SETTINGS];
        lines.push('  ' + (v2settings === undefined ? '(ABSENT — never written)' : JSON.stringify(v2settings)));
        lines.push('');

        // ── Runtime state (Auto-Jobs-owned keys the orchestrator + flows write) ──
        lines.push('─── Runtime state ───');

        const ps = local[sl.AJ_PIPELINE_STATE];
        lines.push('Pipeline (AJ_PIPELINE_STATE):');
        lines.push('  ' + (ps
            ? `running=${!!ps.running} node=${ps.node || '—'} cycle=${ps.cycle != null ? ps.cycle : '—'} error=${ps.error || '—'} updatedAt=${fmtTs(ps.updatedAt)}`
            : '(none — orchestrator has not run this session)'));

        const bugged = local[sl.AJ_BUGGED_JOBS];
        const buggedKeys = (bugged && typeof bugged === 'object') ? Object.keys(bugged) : [];
        lines.push(`Bugged jobs (AJ_BUGGED_JOBS): ${buggedKeys.length}`);
        if (!buggedKeys.length) lines.push('  (none)');
        else for (const id of buggedKeys) {
            const b = bugged[id] || {};
            lines.push(`  ${id} — ${b.reason || '?'} (since ${fmtTs(b.since)})`);
        }

        const q = local[sl.AJ_JOB_QUEUE];
        lines.push('Job queue (AJ_JOB_QUEUE):');
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

        const ms = local[sl.AJ_MASTER_SWITCHES];
        lines.push('Master switches (AJ_MASTER_SWITCHES):');
        lines.push('  ' + (ms === undefined ? '(ABSENT — never written)' : JSON.stringify(ms)));

        const so = local[sl.AJ_SERVER_OVERRIDES];
        const soKeys = (so && typeof so === 'object') ? Object.keys(so) : [];
        lines.push(`Server overrides (AJ_SERVER_OVERRIDES): ${soKeys.length}`);
        if (soKeys.length) lines.push('  ' + JSON.stringify(so));

        lines.push('');
        lines.push('─── Logs ───');

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
                    lines.push('(no log entries yet — no module is writing under the auto-jobs id)');
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
        a.download = filename || `cor3-autojobs-debug-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return text.length;
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.logExport = { buildDebugBundle, downloadDebugBundle };
})();
