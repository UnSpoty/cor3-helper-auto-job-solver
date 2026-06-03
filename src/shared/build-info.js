// src/shared/build-info.js
// Build identification surfaced in the auto-jobs debug bundle AND the popup
// header (next to the "COR3 helper" title) so user bug reports — and a glance
// at the UI — tell us which build they're running. No build step in this repo,
// so these constants are updated by hand at commit time (the same hand-edit
// that touches the bugfix file).
//
// `commit` = short git hash of the commit this code ships with.
// `date`   = release date (yyyy-mm-dd) — coarse signal when the user pasted
//            an old bundle without checking.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    root.COR3.buildInfo = {
        commit: '12960bf',
        date: '2026-06-03',
    };
})();
