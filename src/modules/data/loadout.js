// src/modules/data/loadout.js
// Owns: loadoutData (loadoutDataUpdatedAt).
//
// Listens for MSG.WS.LOADOUT (full snapshot from the cor3.gg
// loadout/get.options frame, fired in reply to our join-room) and
// persists it under STORAGE_LOCAL.LOADOUT. The raw snapshot is stored
// as-is so future modules / popup can mine it freely; we also compute
// a few derived fields up-front so the Auto-Jobs planner doesn't have
// to recompute them every cycle:
//
//   decryptExtensions  Set of file extensions the currently EQUIPPED
//                      software can decrypt. Union of every
//                      equippedSoftware[].specs[type==="DECRYPT"].fileTypes.
//                      Serialized as a plain array to survive
//                      structuredClone into chrome.storage.
//   capabilities       Array of capability strings — distinct values of
//                      equippedSoftware[].specs[].type. E.g.
//                      ["DECRYPT","HACK"]. Used to reject job types
//                      that need an ability the user doesn't have
//                      installed.
//   canBoot            Mirrored from data.resources.canBoot. Cached
//                      separately for cheap reads.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Store, Registry, constants: C } = root.COR3;

    function deriveCaps(snap) {
        const equipped = Array.isArray(snap && snap.equippedSoftware) ? snap.equippedSoftware : [];
        const exts = new Set();
        const caps = new Set();
        for (const sw of equipped) {
            const specs = Array.isArray(sw && sw.specs) ? sw.specs : [];
            for (const sp of specs) {
                if (sp && typeof sp.type === 'string') caps.add(sp.type);
                if (sp && sp.type === 'DECRYPT' && Array.isArray(sp.fileTypes)) {
                    for (const e of sp.fileTypes) {
                        if (typeof e === 'string' && e.length > 0) exts.add(e.toLowerCase());
                    }
                }
            }
        }
        return {
            decryptExtensions: [...exts],
            capabilities: [...caps],
            canBoot: !!(snap && snap.resources && snap.resources.canBoot),
        };
    }

    class LoadoutModule extends Module {
        constructor() {
            super({
                id: 'loadout',
                name: 'Loadout',
                category: C.CATEGORY.DATA,
                owns: {
                    storageKeys: [C.STORAGE_LOCAL.LOADOUT, C.STORAGE_LOCAL.LOADOUT_AT],
                    busTypes: [C.MSG.WS.LOADOUT],
                },
            });
        }

        async start() {
            this.track(Bus.window.on(C.MSG.WS.LOADOUT, (env) => {
                const snap = env && env.data;
                if (!snap || typeof snap !== 'object') return;
                const derived = deriveCaps(snap);
                Store.local.set({
                    [C.STORAGE_LOCAL.LOADOUT]: { ...snap, _derived: derived },
                    [C.STORAGE_LOCAL.LOADOUT_AT]: Date.now(),
                });
                this.debug('loadout snapshot', {
                    ownedHw: Array.isArray(snap.ownedHardware) ? snap.ownedHardware.length : 0,
                    ownedSw: Array.isArray(snap.ownedSoftware) ? snap.ownedSoftware.length : 0,
                    equippedSw: Array.isArray(snap.equippedSoftware) ? snap.equippedSoftware.length : 0,
                    caps: derived.capabilities,
                    exts: derived.decryptExtensions,
                    canBoot: derived.canBoot,
                });
            }));
        }
    }

    Registry.register(new LoadoutModule());
})();
