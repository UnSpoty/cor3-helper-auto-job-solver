// src/ui/components/icons.js
// Small inline SVG icon helpers, exposed on COR3.uiComponents.icons.

(function () {
    const root = window;
    root.COR3.uiComponents = root.COR3.uiComponents || {};

    function svg(d, viewBox = '0 0 16 16') {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="14" height="14" fill="currentColor"><path d="${d}"/></svg>`;
    }

    const icons = {
        play:    svg('M3 2l10 6-10 6V2z'),
        stop:    svg('M3 3h10v10H3z'),
        refresh: svg('M8 3a5 5 0 1 0 4.9 6h-2A3 3 0 1 1 8 5v2l4-3-4-3v2z'),
        trash:   svg('M5 2h6v1h3v1H2V3h3V2zm-1 4h8l-1 8H5L4 6z'),
        plus:    svg('M7 2h2v5h5v2H9v5H7V9H2V7h5V2z'),
        check:   svg('M6 12L2 8l1.5-1.5L6 9l6.5-6.5L14 4l-8 8z'),
        cross:   svg('M3 3l10 10M13 3L3 13'),
        clock:   svg('M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 2a5 5 0 1 0 0 10A5 5 0 0 0 8 3zm-.5 2h1v3.5l3 1.7-.5.85-3.5-2V5z'),
    };

    root.COR3.uiComponents.icons = icons;
})();
