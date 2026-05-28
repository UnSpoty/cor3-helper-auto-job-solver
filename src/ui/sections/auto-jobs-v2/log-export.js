// Auto-Jobs v2 "Download Log" bundle builder.
//
// Minimal: header (build/web/ext versions) + v2 settings + v2 logger
// entries (module id `auto-jobs-v2` or `flow-v2-*`). No state/queue/
// reachability dumps — v2 has no runtime that would write them.
// No SERVER_PRIORITIES / NM_GRAPH — those are shared with v1 and would
// leak v1's configuration into a "v2-only" download.

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
        const local = await Store.local.get([sl.WEB_VERSION, sl.SYSTEM_VERSION]);
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
        lines.push('  ' + JSON.stringify(sync[ss.AUTOJOBS_V2_SETTINGS] || { enabled: false }));
        lines.push('');
        lines.push('─── Logs (v2 only) ───');

        try {
            const all = (Logger && typeof Logger.getAll === 'function') ? await Logger.getAll() : null;
            if (all && typeof all === 'object') {
                const moduleIds = Object.keys(all).filter((id) => RELEVANT_MODULE_PATTERN.test(id)).sort();
                if (!moduleIds.length) {
                    lines.push('(no v2 log entries yet — no module is writing under the auto-jobs-v2 id)');
                }
                for (const id of moduleIds) {
                    const entries = all[id] || [];
                    if (!entries.length) continue;
                    lines.push('');
                    lines.push(`── ${id} (${entries.length} entries) ──`);
                    for (const e of entries) {
                        const ctx = e.ctx ? ` ${typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx)}` : '';
                        lines.push(`[${fmtTs(e.ts)}] ${String(e.level || '?').toUpperCase()}: ${e.msg || ''}${ctx}`);
                    }
                }
            } else {
                lines.push('(Logger.getAll() unavailable in this context)');
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
