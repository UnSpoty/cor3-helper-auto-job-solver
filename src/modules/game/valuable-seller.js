// src/modules/game/valuable-seller.js
// Valuable Seller ENGINE (MAIN world) — the income loop adapted from the
// competitor's auto-valuable-seller: scan reachable servers for valuable
// (basePrice > 0, tagged) files/logs, download the selected finds, then sell
// everything each market accepts, in USOL → SRM → DARK → HOME priority.
//
// Everything runs over pure WS on our existing machinery — no DOM scraping,
// no hardcoded topology:
//   • server access  → COR3.autoJobs.saiFlow.ensureAccess (set.endpoint +
//     Active-Access login, or a full WS hack via COR3.game.loadout.ensureHack
//     + sai.hack.start + the standalone solvers)
//   • SEARCH loadout → COR3.game.loadout.ensureSearch (maximize-power optimizer)
//   • reads/writes   → __cor3SaiGetFiles/GetLogs/FileDownload/LogDownload,
//     __cor3SaiFileSearchValuable/LogSearchValuable (replies on MSG.WS.SAI_*)
//   • selling        → __cor3MarketGetSellableItems / __cor3MarketSellItems
//     (replies on MSG.WS.MARKET_SELLABLE_ITEMS / MARKET_SELL_RESULT)
//
// Driven by the isolated valuable-seller orchestrator over MSG.VALUABLE.*
// (SCAN_START / SELL_START / STOP in; SERVER_RESULT / DOWNLOADS_RESULT /
// PROGRESS / DONE out). The orchestrator supplies the server list (computed
// off NM_GRAPH reachability) — this engine holds no topology of its own.
//
// Mutual exclusion with Auto Jobs: the engine takes the shared
// __cor3FlowLock for its whole run (a FLOW_START arriving meanwhile gets the
// standard 'flow-busy' retryable reply from the flow modules) and refuses to
// start while a flow is already running. ensureAccess also takes
// __pipelineLocked per server (released between servers so queued WS dances
// can breathe, exactly like the SAI batch flows do).

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.Bus) return;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;
    const VS = MSG.VALUABLE;
    const sleep = (ms) => dom.sleep(ms);
    // Human-ish pacing between WS mutations (mirrors the flows' cadence).
    const pace = () => sleep(800 + Math.floor(Math.random() * 500));

    let running = false;

    // Fire trigger(), resolve the next MSG.WS.SAI_ACTION envelope whose
    // `action` matches (other actions are ignored, NOT consumed as a miss) or
    // null on timeout. saiFlow.awaitAction resolves on ANY next action — too
    // loose here because a stray user-driven SAI click could interleave.
    function awaitSaiAction(action, timeoutMs, trigger) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) return; done = true; try { unsub(); } catch (_) { /* noop */ } clearTimeout(timer); resolve(v); };
            const unsub = Bus.window.on(MSG.WS.SAI_ACTION, (env) => { if (env && env.action === action) finish(env); });
            const timer = setTimeout(() => finish(null), timeoutMs);
            try { trigger(); } catch (_) { finish(null); }
        });
    }

    const valuableOf = (list, idField) => (Array.isArray(list) ? list : [])
        .filter((x) => x && Number(x.basePrice) > 0 && Array.isArray(x.tags) && x.tags.length > 0)
        .map((x) => ({
            [idField]: x[idField],
            name: x.name || x.message || '',
            message: x.message || null,
            basePrice: Number(x.basePrice) || 0,
            detectRate: (typeof x.detectRate === 'number') ? x.detectRate : null,
            tags: (x.tags || []).map((t) => (typeof t === 'string' ? { key: t, label: t } : { key: t.key || t.label || '', label: t.label || t.key || '' })),
        }));

    class ValuableSellerEngine extends Module {
        constructor() {
            super({
                id: 'valuable-seller-engine',
                name: 'Valuable Seller Engine',
                category: C.CATEGORY.GAME,
                dependsOn: ['loadout-panel'],
                owns: { busTypes: [VS.SCAN_START, VS.SELL_START, VS.STOP, VS.SERVER_RESULT, VS.DOWNLOADS_RESULT, VS.PROGRESS, VS.DONE] },
            });
        }

        _progress(phase, level, msg) {
            const f = this[level] || this.info;
            f.call(this, msg);
            Bus.window.post(VS.PROGRESS, { phase, level, msg });
        }

        _saiFlow() {
            const sf = root.COR3.autoJobs && root.COR3.autoJobs.saiFlow;
            if (!sf || typeof sf.ensureAccess !== 'function') return null;
            return sf;
        }

        // Take the shared flow lock for a whole engine run. Returns a release
        // fn, or null if a flow (or another engine run) is already busy.
        _takeRunLock(mode) {
            const lock = (root.__cor3FlowLock = root.__cor3FlowLock || { busy: false, jobId: null });
            if (running || lock.busy) return null;
            running = true;
            lock.busy = true;
            lock.jobId = `valuable-${mode}`;
            root.__cor3Abort = false;   // fresh run — same shared abort flag the saiFlow helpers poll
            return () => {
                lock.busy = false;
                lock.jobId = null;
                root.__pipelineLocked = false;   // ensureAccess's per-server hold
                running = false;
            };
        }

        async _accessServer(sf, srv, phase) {
            this._progress(phase, 'info', `[${srv.name}] connecting (access or hack)…`);
            const say = (lvl, m) => this._progress(phase, lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'info', `[${srv.name}] ${m}`);
            const acc = await sf.ensureAccess(srv.id, srv.serverType, srv.name, say);
            if (!acc.ok) this._progress(phase, 'warn', `[${srv.name}] skipped — ${acc.reason || 'no access'}`);
            return acc.ok;
        }

        // ── SCAN: access every candidate, list its valuable files/logs ──────
        async _runScan(servers) {
            const sf = this._saiFlow();
            if (!sf) { Bus.window.post(VS.DONE, { mode: 'scan', ok: false, reason: 'saiflow-missing' }); return; }
            const total = servers.length;
            this._progress('scan', 'info', `scan started — ${total} reachable server(s), furthest first`);
            for (let i = 0; i < total; i++) {
                if (root.__cor3Abort) break;
                const srv = servers[i];
                this._progress('scan', 'info', `server ${i + 1}/${total}: ${srv.name}`);
                if (!await this._accessServer(sf, srv, 'scan')) {
                    Bus.window.post(VS.SERVER_RESULT, { serverId: srv.id, serverName: srv.name, status: 'skipped', reason: 'no-access', files: [], logs: [] });
                    root.__pipelineLocked = false;   // release ensureAccess's hold between servers
                    continue;
                }
                await pace();
                const filesData = await sf.getFiles(srv.id);
                const files = valuableOf(filesData && filesData.files, 'fileId');
                await pace();
                const logsData = await sf.getLogs(srv.id);
                const logs = valuableOf(logsData && logsData.logs, 'seq');
                const status = (files.length + logs.length) > 0 ? 'open' : 'empty';
                if (status === 'open') this._progress('scan', 'info', `[${srv.name}] ${files.length} valuable file(s), ${logs.length} valuable log(s)`);
                Bus.window.post(VS.SERVER_RESULT, { serverId: srv.id, serverName: srv.name, status, files, logs });
                root.__pipelineLocked = false;
                await pace();
            }
            if (!root.__cor3Abort) await this._scanDownloads(sf);
            await this._goHome();
            this._progress('scan', 'info', root.__cor3Abort ? 'scan stopped' : 'scan complete');
            Bus.window.post(VS.DONE, { mode: 'scan', ok: !root.__cor3Abort });
        }

        // List valuable files already sitting in Downloads (with tags/source
        // from the read-only File Analysis request).
        async _scanDownloads(sf) {
            this._progress('scan', 'info', 'scanning Downloads folder…');
            const all = await sf.listDownloads();
            const valuables = all.filter((f) => f && f.isValuable);
            const out = [];
            for (const f of valuables) {
                if (root.__cor3Abort) break;
                const resp = await sf.awaitBus(MSG.WS.DESKTOP_FILE_ANALYSIS, 10000, () => root.__cor3DesktopGetFileAnalysis(f.id));
                const a = (resp && !resp.error && resp.data) ? resp.data : null;
                out.push({
                    id: f.id,
                    name: f.name,
                    source: (a && a.source) || null,
                    tags: ((a && a.tags) || []).map((t) => (typeof t === 'string' ? { key: t, label: t } : { key: t.key || t.label || '', label: t.label || t.key || '' })),
                });
                await sleep(300);
            }
            this._progress('scan', 'info', `Downloads: ${out.length} valuable file(s)`);
            Bus.window.post(VS.DOWNLOADS_RESULT, { files: out });
        }

        // ── SELL: search + download on the selected servers, then sell ──────
        async _runSell(servers) {
            const sf = this._saiFlow();
            if (!sf) { Bus.window.post(VS.DONE, { mode: 'sell', ok: false, reason: 'saiflow-missing' }); return; }
            const LO = root.COR3.game && root.COR3.game.loadout;
            this._progress('sell', 'info', `sell started — ${servers.length} server(s)`);

            for (let i = 0; i < servers.length; i++) {
                if (root.__cor3Abort) break;
                const srv = servers[i];
                this._progress('sell', 'info', `server ${i + 1}/${servers.length}: ${srv.name}`);
                if (!await this._accessServer(sf, srv, 'sell')) {
                    Bus.window.post(VS.SERVER_RESULT, { serverId: srv.id, serverName: srv.name, status: 'skipped', reason: 'no-access', files: [], logs: [] });
                    root.__pipelineLocked = false;
                    continue;
                }
                await pace();

                // Best owned SEARCH tool for this server type (maximize-power).
                // 'none' = we own nothing that searches this type — proceed, the
                // search-valuable RPC then reveals only what is already visible.
                if (LO && typeof LO.ensureSearch === 'function' && srv.serverType) {
                    const sr = await LO.ensureSearch(srv.serverType, (lvl, m) => this._progress('sell', lvl === 'error' ? 'warn' : lvl, `[${srv.name}] ${m}`));
                    if (!sr.ok && sr.status !== 'none') this._progress('sell', 'warn', `[${srv.name}] search loadout not applied (${sr.status}) — searching with current rig`);
                    await pace();
                }

                // Reveal valuables. The reply's found[] carries what THIS search
                // detected; a null reply (timeout / sai-logs-not-available) means
                // "no filter" — everything already visible stays eligible.
                const fs = await awaitSaiAction('file.search-valuable', 30000, () => root.__cor3SaiFileSearchValuable(srv.id));
                const detectedFiles = new Set(((fs && !fs.error && fs.data && fs.data.found) || []).filter((x) => Number(x.basePrice) > 0).map((x) => x.id));
                if (fs && fs.data && fs.data.searchPowerUsed != null) this._progress('sell', 'info', `[${srv.name}] file search done — ${detectedFiles.size} detected (power ${fs.data.searchPowerUsed})`);
                await pace();
                const ls = await awaitSaiAction('log.search-valuable', 30000, () => root.__cor3SaiLogSearchValuable(srv.id));
                const detectedLogs = new Set(((ls && !ls.error && ls.data && ls.data.found) || []).filter((x) => Number(x.basePrice) > 0).map((x) => String(x.id != null ? x.id : x.seq)));
                await pace();

                // Re-read the lists post-search and download every eligible find.
                const filesData = await sf.getFiles(srv.id);
                let files = valuableOf(filesData && filesData.files, 'fileId');
                if (detectedFiles.size > 0) files = files.filter((f) => detectedFiles.has(f.fileId));
                for (const f of files) {
                    if (root.__cor3Abort) break;
                    this._progress('sell', 'info', `[${srv.name}] downloading file "${f.name}" (${f.basePrice})`);
                    const r = await awaitSaiAction('file.download', 30000, () => root.__cor3SaiFileDownload(srv.id, f.fileId));
                    if (!r || r.error) this._progress('sell', 'warn', `[${srv.name}] file download failed: ${r && r.error ? (r.error.message || r.error.kind || 'error') : 'timeout'}`);
                    await pace();
                }

                const logsData = await sf.getLogs(srv.id);
                let logs = valuableOf(logsData && logsData.logs, 'seq');
                if (detectedLogs.size > 0) logs = logs.filter((l) => detectedLogs.has(String(l.seq)));
                for (const l of logs) {
                    if (root.__cor3Abort) break;
                    this._progress('sell', 'info', `[${srv.name}] downloading log "${l.name}" (${l.basePrice})`);
                    const r = await awaitSaiAction('log.download', 30000, () => root.__cor3SaiLogDownload(srv.id, l.seq));
                    if (!r || r.error) this._progress('sell', 'warn', `[${srv.name}] log download failed: ${r && r.error ? (r.error.message || r.error.kind || 'error') : 'timeout'}`);
                    await pace();
                }

                Bus.window.post(VS.SERVER_RESULT, { serverId: srv.id, serverName: srv.name, status: 'downloaded', files, logs });
                root.__pipelineLocked = false;
            }

            let tally = { items: 0, credits: 0, rep: 0 };
            if (!root.__cor3Abort) tally = await this._sellAtMarkets();
            await this._goHome();
            this._progress('sell', 'info', root.__cor3Abort ? 'sell stopped' : `sell complete — ${tally.items} item(s), +${tally.credits} CR, +${tally.rep} rep`);
            Bus.window.post(VS.DONE, { mode: 'sell', ok: !root.__cor3Abort, sold: tally.items, credits: tally.credits, rep: tally.rep });
        }

        // Sell everything each market accepts. Priority = C.MARKETS reversed
        // (USOL → SRM → DARK → HOME): the remote/faction markets pay reputation
        // where it is scarcer, HOME mops up the rest. A remote market needs the
        // endpoint on its own server first (same rule as get.jobs). Returns the
        // run tally { items, credits, rep } — get.sellable-items carries a
        // per-item `price` + `repGain` (verified live), so profit is attributed
        // exactly on each successful sell, not estimated.
        async _sellAtMarkets() {
            const order = C.MARKETS.slice().reverse();
            const tally = { items: 0, credits: 0, rep: 0 };
            // Hold the dance lock across the whole phase — a queued auto-refresh
            // flipping the endpoint mid-sell would break the remote-market rule.
            if (typeof root.__cor3AwaitWsChainsIdle === 'function') await root.__cor3AwaitWsChainsIdle();
            root.__pipelineLocked = true;
            try {
                for (const market of order) {
                    if (root.__cor3Abort) break;
                    this._progress('sell', 'info', `market ${market.label}: checking sellable items…`);
                    if (market.id === C.HOME_MARKET_ID) {
                        if (typeof root.__cor3EnsureHomeEndpoint === 'function') root.__cor3EnsureHomeEndpoint();
                    } else {
                        root.__cor3SetEndpoint(market.serverId);
                    }
                    await sleep(1500);
                    const resp = await this._saiFlow().awaitBus(MSG.WS.MARKET_SELLABLE_ITEMS, 15000, () => root.__cor3MarketGetSellableItems(market.id));
                    if (!resp || resp.error) {
                        this._progress('sell', 'warn', `market ${market.label}: ${resp && resp.error ? (resp.error.message || 'error') : 'no reply'} — skipping`);
                        continue;
                    }
                    const d = resp.data || {};
                    const items = (Array.isArray(d.items) ? d.items : [])
                        .map((it) => ({ itemType: it.itemType || 'file', itemId: it.itemId || it.id || it.fileId, price: Number(it.price) || 0, repGain: Number(it.repGain) || 0 }))
                        .filter((it) => it.itemId);
                    if (!items.length) { this._progress('sell', 'info', `market ${market.label}: nothing sellable`); continue; }
                    this._progress('sell', 'info', `market ${market.label}: ${items.length} item(s), total ${d.totalPrice || 0} CR, rep +${d.totalRepGain || 0}`);
                    for (const it of items) {
                        if (root.__cor3Abort) break;
                        const r = await this._saiFlow().awaitBus(MSG.WS.MARKET_SELL_RESULT, 15000, () => root.__cor3MarketSellItems(market.id, [it]));
                        if (r && !r.error) {
                            tally.items++; tally.credits += it.price; tally.rep += it.repGain;
                            this._progress('sell', 'info', `sold +${it.price} CR / +${it.repGain} rep (run total ${tally.credits} CR)`);
                        } else {
                            this._progress('sell', 'warn', `market ${market.label}: sell failed for ${it.itemId} (${r && r.error ? (r.error.message || 'error') : 'timeout'})`);
                        }
                        await pace();
                    }
                }
            } finally {
                root.__pipelineLocked = false;
            }
            return tally;
        }

        async _goHome() {
            if (typeof root.__cor3EnsureHomeEndpoint === 'function') { root.__cor3EnsureHomeEndpoint(); await sleep(800); }
        }

        async start() {
            this.track(Bus.window.on(VS.SCAN_START, async (env) => {
                const servers = (env && Array.isArray(env.servers)) ? env.servers : [];
                if (!servers.length) { Bus.window.post(VS.DONE, { mode: 'scan', ok: false, reason: 'no-servers' }); return; }
                const release = this._takeRunLock('scan');
                if (!release) { Bus.window.post(VS.DONE, { mode: 'scan', ok: false, reason: 'busy' }); return; }
                try { await this._runScan(servers); }
                catch (e) {
                    this.error('scan crashed', { error: String(e), stack: e && e.stack });
                    Bus.window.post(VS.DONE, { mode: 'scan', ok: false, reason: 'crash' });
                }
                finally { release(); }
            }));

            this.track(Bus.window.on(VS.SELL_START, async (env) => {
                const servers = (env && Array.isArray(env.servers)) ? env.servers : [];
                const release = this._takeRunLock('sell');
                if (!release) { Bus.window.post(VS.DONE, { mode: 'sell', ok: false, reason: 'busy' }); return; }
                try { await this._runSell(servers); }
                catch (e) {
                    this.error('sell crashed', { error: String(e), stack: e && e.stack });
                    Bus.window.post(VS.DONE, { mode: 'sell', ok: false, reason: 'crash' });
                }
                finally { release(); }
            }));

            this.track(Bus.window.on(VS.STOP, () => {
                if (!running) return;
                this.warn('STOP received — aborting run');
                root.__cor3Abort = true;
            }));

            this.info('valuable-seller engine ready');
        }
    }

    Registry.register(new ValuableSellerEngine());
})();
