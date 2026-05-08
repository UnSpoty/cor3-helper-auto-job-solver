// src/core/registry.js
// Module registry. Knows about every module instance, resolves dependency
// order, and drives start/stop in response to settings changes. There's
// exactly one Registry per execution context (MAIN / isolated / SW / popup);
// each context registers only the modules that belong to it.
// Registers into globalThis.COR3.Registry.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Registry) return;

    const Logger = root.COR3.Logger;
    const Settings = root.COR3.Settings; // may be undefined in MAIN world (no chrome.storage); guarded
    const C = root.COR3.constants;
    if (!Logger || !C) {
        console.error('[COR3.Registry] constants/Logger must load before registry.js');
        return;
    }

    const modules = new Map(); // id -> Module instance
    let bootDone = false;

    function register(mod) {
        if (!mod || !mod.id) throw new Error('Registry.register: module without id');
        if (modules.has(mod.id)) {
            Logger.push('registry', C.LOG_LEVEL.WARN, `duplicate registration for "${mod.id}", ignoring second`);
            return modules.get(mod.id);
        }
        modules.set(mod.id, mod);
        Logger.push('registry', C.LOG_LEVEL.DEBUG, `registered ${mod.id} (category=${mod.category})`);
        return mod;
    }

    function get(id) { return modules.get(id); }
    function list() { return Array.from(modules.values()); }
    function snapshot() {
        return list().map((m) => ({
            id: m.id,
            name: m.name,
            category: m.category,
            dependsOn: m.dependsOn.slice(),
            enabled: m.enabled,
            logsEnabled: m.logsEnabled,
            started: m.started,
            owns: { storageKeys: m.owns.storageKeys.slice(), busTypes: m.owns.busTypes.slice() },
        }));
    }

    /**
     * Topological sort by dependsOn. Throws on cycles. Modules registered but
     * referenced as deps by no one still appear in the order (in registration order).
     */
    function topoSort() {
        const out = [];
        const seen = new Set();
        const inProgress = new Set();
        function visit(id) {
            if (seen.has(id)) return;
            if (inProgress.has(id)) throw new Error(`Registry: dependency cycle through "${id}"`);
            const m = modules.get(id);
            if (!m) {
                Logger.push('registry', C.LOG_LEVEL.WARN, `unknown dependency "${id}", skipping`);
                return;
            }
            inProgress.add(id);
            for (const dep of m.dependsOn) visit(dep);
            inProgress.delete(id);
            seen.add(id);
            out.push(m);
        }
        for (const id of modules.keys()) visit(id);
        return out;
    }

    /**
     * Initialize all modules then start the ones flagged as enabled in Settings.
     * Idempotent: subsequent calls re-sync state with Settings (start newly
     * enabled, stop newly disabled).
     */
    async function boot() {
        // Hydrate enabled/logsEnabled from Settings, if it exists in this context
        if (Settings && typeof Settings.load === 'function') {
            const state = await Settings.load();
            for (const mod of modules.values()) {
                const s = state[mod.id];
                if (s) {
                    if (typeof s.enabled === 'boolean') mod.enabled = s.enabled;
                    if (typeof s.logsEnabled === 'boolean') mod.logsEnabled = s.logsEnabled;
                }
                Logger.setLogsEnabled(mod.id, mod.logsEnabled);
            }
        } else {
            for (const mod of modules.values()) Logger.setLogsEnabled(mod.id, mod.logsEnabled);
        }

        const ordered = topoSort();

        // Run init() once for every module, regardless of enabled state.
        if (!bootDone) {
            for (const mod of ordered) {
                try { await mod.init(); }
                catch (e) {
                    Logger.push(mod.id, C.LOG_LEVEL.ERROR, `init failed: ${e && e.message}`, { stack: e && e.stack });
                }
            }
            bootDone = true;
        }

        // Start modules in dep order; stop modules in reverse order.
        for (const mod of ordered) {
            if (mod.enabled && !mod.started) {
                try { await mod._runStart(); } catch (_) { /* logged inside _runStart */ }
            } else if (!mod.enabled && mod.started) {
                try { await mod._runStop(); } catch (_) {}
            }
        }
        const reversed = ordered.slice().reverse();
        for (const mod of reversed) {
            if (!mod.enabled && mod.started) {
                try { await mod._runStop(); } catch (_) {}
            }
        }
    }

    /**
     * Apply a single module state change (enabled/logsEnabled) and, if needed,
     * start/stop the module. Cascades stop to dependents when disabling.
     */
    async function setModuleState(id, partial) {
        const mod = modules.get(id);
        if (!mod) return;
        const prevEnabled = mod.enabled;

        if (typeof partial.logsEnabled === 'boolean') {
            mod.logsEnabled = partial.logsEnabled;
            Logger.setLogsEnabled(id, partial.logsEnabled);
        }
        if (typeof partial.enabled === 'boolean') {
            mod.enabled = partial.enabled;
        }
        if (Settings && typeof Settings.setModuleState === 'function') {
            await Settings.setModuleState(id, { enabled: mod.enabled, logsEnabled: mod.logsEnabled });
        }

        if (prevEnabled !== mod.enabled) {
            if (mod.enabled) {
                // Ensure all upstream deps are running too
                const ordered = topoSort();
                for (const m of ordered) {
                    if (m.id === id) break;
                    if (m.enabled && !m.started) await m._runStart();
                }
                await mod._runStart();
            } else {
                // Stop dependents first, in reverse-topo order
                const reversed = topoSort().reverse();
                for (const m of reversed) {
                    if (m.id === id) continue;
                    if (m.dependsOn.includes(id) && m.started) await m._runStop();
                }
                await mod._runStop();
            }
        }
    }

    root.COR3.Registry = { register, get, list, snapshot, boot, setModuleState };
})();
