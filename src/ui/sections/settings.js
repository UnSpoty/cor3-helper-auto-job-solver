// src/ui/sections/settings.js — appearance toggles + risk threshold + auto-decrypt/auto-daily-hack

(function () {
    const root = window;
    root.COR3.ui = root.COR3.ui || {};
    const { Store, constants: C } = root.COR3;

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    function toggleRow(label, key, currentValue) {
        const row = el('div', 'card');
        row.innerHTML = `
            <div class="card-row">
                <span class="card-label">${label}</span>
                <label class="switch"><input type="checkbox" data-k="${key}" ${currentValue ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
        `;
        row.querySelector('input').addEventListener('change', (e) => {
            Store.sync.setOne(key, e.target.checked);
        });
        return row;
    }

    async function render(container) {
        container.innerHTML = '';

        const sync = await Store.sync.get([
            C.STORAGE_SYNC.AUTO_REFRESH, C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED,
            C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, C.STORAGE_SYNC.RISK_THRESHOLD,
            C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, C.STORAGE_SYNC.DISABLE_BACKGROUND, C.STORAGE_SYNC.DISABLE_NETWORK_FOG,
            'disableMapFxEnabled',
        ]);

        // Auto-refresh markets
        container.appendChild(el('div', 'section-title', 'Auto-refresh markets'));
        const ar = sync[C.STORAGE_SYNC.AUTO_REFRESH] || { home_jobs: false, dark_jobs: false };
        const arCard = el('div', 'card');
        arCard.innerHTML = `
            <div class="card-row"><span class="card-label">Home market</span><label class="switch"><input type="checkbox" data-ar="home_jobs" ${ar.home_jobs ? 'checked' : ''}><span class="switch-slider"></span></label></div>
            <div class="card-row mt-sm"><span class="card-label">Dark market</span><label class="switch"><input type="checkbox" data-ar="dark_jobs" ${ar.dark_jobs ? 'checked' : ''}><span class="switch-slider"></span></label></div>
        `;
        arCard.querySelectorAll('input[data-ar]').forEach((inp) => {
            inp.addEventListener('change', async (e) => {
                const cur = (await Store.sync.getOne(C.STORAGE_SYNC.AUTO_REFRESH, {})) || {};
                cur[e.target.dataset.ar] = e.target.checked;
                await Store.sync.setOne(C.STORAGE_SYNC.AUTO_REFRESH, cur);
            });
        });
        container.appendChild(arCard);

        // Auto solvers
        container.appendChild(el('div', 'section-title', 'Auto solvers'));
        container.appendChild(toggleRow('Auto-decrypt', C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED, sync[C.STORAGE_SYNC.AUTO_DECRYPT_ENABLED]));
        container.appendChild(toggleRow('Auto daily-hack', C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED, sync[C.STORAGE_SYNC.AUTO_DAILY_HACK_ENABLED]));

        // Auto-choose decision
        container.appendChild(el('div', 'section-title', 'Auto-choose decision'));
        const dec = el('div', 'card');
        const threshold = Number(sync[C.STORAGE_SYNC.RISK_THRESHOLD] ?? 5);
        dec.innerHTML = `
            <div class="card-row"><span class="card-label">Enabled</span><label class="switch"><input type="checkbox" id="ac-en" ${sync[C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED] ? 'checked' : ''}><span class="switch-slider"></span></label></div>
            <div class="card-row mt-sm">
                <span class="card-label">Risk threshold</span>
                <span class="mono" id="rt-label">${threshold}</span>
            </div>
            <input type="range" id="rt-slider" min="0" max="10" step="1" value="${threshold}" class="mt-sm">
            <div class="muted xs mt-sm">0 = strong risk penalty · 10 = ignore risk</div>
        `;
        dec.querySelector('#ac-en').addEventListener('change', (e) =>
            Store.sync.setOne(C.STORAGE_SYNC.AUTO_CHOOSE_ENABLED, e.target.checked));
        const rtSlider = dec.querySelector('#rt-slider');
        const rtLabel = dec.querySelector('#rt-label');
        rtSlider.addEventListener('input', (e) => { rtLabel.textContent = e.target.value; });
        rtSlider.addEventListener('change', (e) => Store.sync.setOne(C.STORAGE_SYNC.RISK_THRESHOLD, Number(e.target.value)));
        container.appendChild(dec);

        // Appearance
        container.appendChild(el('div', 'section-title', 'Game appearance'));
        container.appendChild(toggleRow('Hide system messages', C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES, sync[C.STORAGE_SYNC.DISABLE_SYSTEM_MESSAGES]));
        container.appendChild(toggleRow('Disable background', C.STORAGE_SYNC.DISABLE_BACKGROUND, sync[C.STORAGE_SYNC.DISABLE_BACKGROUND]));
        container.appendChild(toggleRow('Disable network fog', C.STORAGE_SYNC.DISABLE_NETWORK_FOG, sync[C.STORAGE_SYNC.DISABLE_NETWORK_FOG]));
        container.appendChild(toggleRow('Disable map FX', 'disableMapFxEnabled', sync.disableMapFxEnabled));
    }

    let unsub = null;
    root.COR3.ui.settings = {
        mount(container) {
            unsub = Store.sync.onChanged((_changes) => {
                if (container.classList.contains('active')) render(container);
            });
            render(container);
        },
        activate(container) { render(container); },
    };
})();
