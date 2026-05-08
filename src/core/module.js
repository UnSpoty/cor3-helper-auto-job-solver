// src/core/module.js
// Base class for every feature module. A subclass declares its identity,
// dependencies, and the storage keys / bus types it owns; it overrides
// init/start/stop hooks. The Registry is what actually instantiates and
// drives the lifecycle.
// Registers into globalThis.COR3.Module.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.Module) return;

    const Logger = root.COR3.Logger;
    const C = root.COR3.constants;
    if (!Logger || !C) {
        console.error('[COR3.Module] constants/Logger must load before module.js');
        return;
    }

    class Module {
        /**
         * @param {object} cfg
         * @param {string}   cfg.id          unique module id (kebab-case)
         * @param {string}   cfg.name        human-readable label for UI
         * @param {string}   cfg.category    one of CATEGORY.*
         * @param {string[]} [cfg.dependsOn] module ids this depends on (start order)
         * @param {object}   [cfg.owns]      { storageKeys?: string[], busTypes?: string[] }
         * @param {boolean}  [cfg.defaultEnabled=true]
         * @param {boolean}  [cfg.defaultLogsEnabled=true]
         */
        constructor(cfg) {
            if (!cfg || !cfg.id) throw new Error('Module: id is required');
            if (!cfg.name) throw new Error('Module: name is required');
            this.id = cfg.id;
            this.name = cfg.name;
            this.category = cfg.category || C.CATEGORY.AUTOMATION;
            this.dependsOn = Array.isArray(cfg.dependsOn) ? cfg.dependsOn.slice() : [];
            this.owns = {
                storageKeys: (cfg.owns && cfg.owns.storageKeys) || [],
                busTypes: (cfg.owns && cfg.owns.busTypes) || [],
            };
            this.defaultEnabled = cfg.defaultEnabled !== false;
            this.defaultLogsEnabled = cfg.defaultLogsEnabled !== false;

            // Set by Registry once user state is known
            this.enabled = this.defaultEnabled;
            this.logsEnabled = this.defaultLogsEnabled;
            this.started = false;

            // For cleanup: hold all unsubscribe fns returned by Bus/Store
            this._cleanups = [];
        }

        // ─── Lifecycle hooks ─────────────────────────────────────────────
        // Override in subclasses. All are async-friendly (may return Promise).
        async init() {}
        async start() {}
        async stop() {}

        // ─── Helpers used by subclasses ─────────────────────────────────
        log(level, msg, ctx) {
            Logger.push(this.id, level, msg, ctx);
        }
        debug(msg, ctx) { this.log(C.LOG_LEVEL.DEBUG, msg, ctx); }
        info(msg, ctx)  { this.log(C.LOG_LEVEL.INFO,  msg, ctx); }
        warn(msg, ctx)  { this.log(C.LOG_LEVEL.WARN,  msg, ctx); }
        error(msg, ctx) { this.log(C.LOG_LEVEL.ERROR, msg, ctx); }

        /**
         * Track a cleanup fn (typically returned by Bus.window.on / Store.onChanged).
         * Will be invoked automatically on stop().
         */
        track(unsubscribe) {
            if (typeof unsubscribe === 'function') this._cleanups.push(unsubscribe);
            return unsubscribe;
        }

        /**
         * Internal: called by Registry. Do not override.
         */
        async _runStart() {
            if (this.started) return;
            this.info(`starting (deps: ${this.dependsOn.join(', ') || 'none'})`);
            try {
                await this.start();
                this.started = true;
                this.info('started');
            } catch (e) {
                this.error('start failed', { error: String(e), stack: e && e.stack });
                throw e;
            }
        }

        /**
         * Internal: called by Registry. Do not override.
         */
        async _runStop() {
            if (!this.started) return;
            this.info('stopping');
            try {
                for (const fn of this._cleanups) {
                    try { fn(); } catch (_) { /* swallow */ }
                }
                this._cleanups = [];
                await this.stop();
            } finally {
                this.started = false;
                this.info('stopped');
            }
        }
    }

    root.COR3.Module = Module;
})();
