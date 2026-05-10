// src/modules/automation/auto-jobs/log-export.js
// "Download Log" debug-bundle builder. Produces a single human-readable .txt
// blob covering the auto-jobs subsystem so users can attach it to bug reports.
//
// Phase 1: implementation is complete enough to call from a future UI button.
// Phase 4 will wire the button in src/ui/sections/auto-jobs.js.
//
// API:
//   const text = await logExport.buildDebugBundle()    — returns the .txt body
//   await logExport.downloadDebugBundle(filename?)     — triggers a Blob URL
//                                                         download from the
//                                                         popup context.
//
// Bundle layout (kept stable so future tooling can grep it):
//   === COR3 Helper / Auto-Jobs debug log — exported {iso ts} ===
//   WebVersion / SystemVersion
//   Settings (redacted)
//   NM_GRAPH summary
//   Reachability snapshot (when AJ_REACHABILITY is populated, Phase 2+)
//   Current state + queue
//   Bugged jobs (Phase 1) / Permanently rejected jobs (Phase 3+)
//   Logs from auto-jobs, server-connect, sai-navigator, flows-core, flow-*

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants) return;
    const { Store, Logger, constants: C } = root.COR3;

    const RELEVANT_MODULE_PATTERN = /^(auto-jobs|server-connect|sai-navigator|flows-core|flow-.+)$/;

    function fmtTs(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toISOString(); } catch (_) { return String(ts); }
    }

    function redactSettings(s) {
        if (!s || typeof s !== 'object') return s;
        // Nothing secret in autoJobsSettings today, but strip deeply-nested
        // unknown blobs to keep the bundle small. Stable shape: enabled,
        // markets, enabledJobTypes.
        return JSON.parse(JSON.stringify({
            enabled: !!s.enabled,
            markets: s.markets || {},
            enabledJobTypes: s.enabledJobTypes || {},
        }));
    }

    function summarizeNmGraph(g) {
        if (!g || !Array.isArray(g.servers)) return '(none)';
        const N = g.servers.length;
        const home = g.home || g.homeId || '?';
        const maxDepth = Math.max(0, ...g.servers.map((s) => Number(s.depth) || 0));
        const kdCount = g.servers.filter((s) => s.isInMaintenance).length;
        return `${N} servers, home=${home}, max depth=${maxDepth}, K/D=${kdCount}, updatedAt=${fmtTs(g.updatedAt)}`;
    }

    function fmtReachability(r) {
        if (!r || typeof r !== 'object') return '(not yet computed — Phase 2+ feature)';
        const lines = [];
        if (r.markets) {
            for (const [k, m] of Object.entries(r.markets)) {
                const blockers = (m.blockers || []).map((b) => `${b.serverName}(${b.kind}${b.timerText ? ':'+b.timerText : ''})`).join(', ');
                lines.push(`  market[${k}]: reachable=${m.reachable}${blockers ? ', blockers=['+blockers+']' : ''}`);
            }
        }
        if (!lines.length) lines.push('  (empty)');
        if (r.computedAt) lines.unshift(`  computedAt=${fmtTs(r.computedAt)}`);
        return lines.join('\n');
    }

    function fmtQueue(q) {
        if (!Array.isArray(q) || !q.length) return '  (empty)';
        return q.map((j, i) => `  ${i+1}. [${j.jobType}] ${j.jobName || j.jobId}` +
            (j.serverName ? ` @ ${j.serverName}` : '') +
            (Number.isFinite(j.attempts) ? ` (attempts=${j.attempts})` : '')
        ).join('\n');
    }

    function fmtBugged(b) {
        if (!b || typeof b !== 'object') return '  (none)';
        const ents = Object.entries(b);
        if (!ents.length) return '  (none)';
        return ents.map(([id, e]) => {
            const ts = e && e.ts ? fmtTs(e.ts) : '?';
            const ttl = e && e.ttl ? `${Math.round(e.ttl/60000)}min` : 'default';
            return `  - ${id} "${e?.name || '?'}" since=${ts} ttl=${ttl}`;
        }).join('\n');
    }

    function fmtRejected(r) {
        if (!r || typeof r !== 'object') return '  (none — Phase 3+ feature)';
        const ents = Object.entries(r);
        if (!ents.length) return '  (none)';
        return ents.map(([id, e]) => {
            const since = e?.since ? fmtTs(e.since) : '?';
            const desc = e?.descriptor ? ` "${e.descriptor}"` : '';
            return `  - ${id}${desc} reason="${e?.reason || '?'}" since=${since}`;
        }).join('\n');
    }

    async function buildDebugBundle() {
        const sl = C.STORAGE_LOCAL;
        const ss = C.STORAGE_SYNC;
        const localKeys = [
            sl.AUTOJOBS_STATE, sl.AUTOJOBS_QUEUE, sl.BUGGED_JOBS,
            sl.AJ_REJECTED_JOBS, sl.AJ_REACHABILITY, sl.AJ_SERVER_CAPS,
            sl.NM_GRAPH, sl.WEB_VERSION, sl.SYSTEM_VERSION,
        ];
        const syncKeys = [ss.AUTOJOBS_SETTINGS, ss.SERVER_PRIORITIES];
        const local = await Store.local.get(localKeys);
        const sync  = await Store.sync.get(syncKeys);

        const lines = [];
        lines.push(`=== COR3 Helper / Auto-Jobs debug log — exported ${new Date().toISOString()} ===`);
        lines.push(`WebVersion: ${local[sl.WEB_VERSION] || '?'}     SystemVersion: ${local[sl.SYSTEM_VERSION] || '?'}`);
        lines.push('');
        lines.push('Settings (redacted):');
        lines.push('  ' + JSON.stringify(redactSettings(sync[ss.AUTOJOBS_SETTINGS])));
        lines.push('Server priorities:');
        lines.push('  ' + JSON.stringify(sync[ss.SERVER_PRIORITIES] || {}));
        lines.push('');
        lines.push('NM_GRAPH summary:');
        lines.push('  ' + summarizeNmGraph(local[sl.NM_GRAPH]));
        lines.push('');
        lines.push('Reachability snapshot:');
        lines.push(fmtReachability(local[sl.AJ_REACHABILITY]));
        lines.push('');
        lines.push('Server caps (lazy-learned):');
        lines.push('  ' + JSON.stringify(local[sl.AJ_SERVER_CAPS] || {}));
        lines.push('');
        const st = local[sl.AUTOJOBS_STATE];
        lines.push(`Current state: ${st?.status || '—'}` + (st?.jobId ? ` (job ${st.jobId})` : '') + ` updatedAt=${fmtTs(st?.updatedAt)}`);
        lines.push('Queue:');
        lines.push(fmtQueue(local[sl.AUTOJOBS_QUEUE]));
        lines.push('');
        lines.push('Bugged jobs (legacy TTL):');
        lines.push(fmtBugged(local[sl.BUGGED_JOBS]));
        lines.push('');
        lines.push('Permanently rejected jobs:');
        lines.push(fmtRejected(local[sl.AJ_REJECTED_JOBS]));
        lines.push('');
        lines.push('─── Logs ───');

        // Pull logs from the centralized Logger ring buffer. The Logger is
        // present in every context, so this works whether the bundle is
        // built from popup or content-script.
        try {
            const all = (Logger && typeof Logger.getAll === 'function') ? await Logger.getAll() : null;
            if (all && typeof all === 'object') {
                const moduleIds = Object.keys(all).filter((id) => RELEVANT_MODULE_PATTERN.test(id)).sort();
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
        a.download = filename || `cor3-autojobs-debug-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after the click handler has consumed the URL. Some browsers
        // need a tick of breathing room before the download stream attaches.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return text.length;
    }

    root.COR3.autoJobs = root.COR3.autoJobs || {};
    root.COR3.autoJobs.logExport = { buildDebugBundle, downloadDebugBundle };
})();
