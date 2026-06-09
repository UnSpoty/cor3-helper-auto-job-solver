// src/ui/components/timer.js
// Reusable countdown component. Pass an ISO string or epoch ms; updates
// every second. Returns { el, stop() }.

(function () {
    const root = window;
    root.COR3.uiComponents = root.COR3.uiComponents || {};

    function fmt(seconds) {
        if (seconds < 0) return '0s';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    /**
     * @param {number|string|Date} target  epoch ms, ISO string, or Date
     * @param {object} [opts]
     * @param {number}   [opts.warnUnder=60]
     * @param {function} [opts.onExpire]  fired ONCE when the countdown first
     *                                    crosses ≤ 0 (lets callers clear stale
     *                                    state / re-evaluate when a timer runs out)
     * @returns {{el: HTMLElement, stop: () => void}}
     */
    function create(target, opts = {}) {
        const warnUnder = opts.warnUnder || 60;
        const onExpire = typeof opts.onExpire === 'function' ? opts.onExpire : null;
        const el = document.createElement('span');
        el.className = 'timer';
        let intervalId = null;
        let expiredFired = false;

        function update() {
            if (!target) { el.textContent = '—'; return; }
            const t = (typeof target === 'number') ? target
                    : (target instanceof Date) ? target.getTime()
                    : new Date(target).getTime();
            const diff = Math.floor((t - Date.now()) / 1000);
            el.textContent = fmt(diff);
            el.classList.remove('warn', 'err');
            if (diff <= 0) el.classList.add('err');
            else if (diff <= warnUnder) el.classList.add('warn');
            if (diff <= 0 && onExpire && !expiredFired) {
                expiredFired = true;
                try { onExpire(); } catch (_) { /* caller's problem; keep ticking */ }
            }
        }
        update();
        intervalId = setInterval(update, 1000);
        return { el, stop: () => { if (intervalId) clearInterval(intervalId); } };
    }

    root.COR3.uiComponents.timer = { create, fmt };
})();
