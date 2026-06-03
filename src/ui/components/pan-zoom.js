// Shared pan / wheel-zoom / fit camera controller for the SVG maps.
//
// The Auto Jobs Network Map draws its world into an
// <svg><g class="…-camera"> over a CSS dotted-grid layer and pans/zooms that
// camera. This is the one implementation of that mechanic — drag-to-pan,
// wheel-zoom-to-cursor, fit-to-world, the 6-stop grid background string, and a
// debounced ResizeObserver refit. (The old Flow Map used it too before it was
// replaced by the compact pipeline status; the controller stays map-agnostic.)
//
// Neutral namespace (COR3.panZoom) so any map can use it.
//
// create({ svg, camera, canvasHost, gridLayer, zoomLabel, getWorld, ...opts })
//   → { cam, applyCamera, fit, destroy }
//
//   svg        — the <svg> element (pointer + wheel host, world measured here)
//   camera     — the <g> transformed by the camera
//   canvasHost — the positioned wrapper (wheel listener + ResizeObserver target)
//   gridLayer  — optional dotted-grid <div> scrolled/scaled with the camera
//   zoomLabel  — optional element whose textContent shows the zoom %
//   getWorld   — () => ({ worldW, worldH }) for fit() (read fresh each call)
//   zoomMin/zoomMax — hard wheel-zoom clamp (default 0.15 … 3)
//   fitMin/fitMax   — fit() clamp BEFORE zoomMin/zoomMax (default 0.35 … 1.2)
//   onTap      — optional (clientX, clientY, target) on a click WITHOUT a drag

(function () {
    const root = (typeof window !== 'undefined') ? window : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.panZoom) return;

    function create(opts) {
        const {
            svg, camera, canvasHost, gridLayer = null, zoomLabel = null,
            getWorld,
            zoomMin = 0.15, zoomMax = 3,
            fitMin = 0.35, fitMax = 1.2,
            onTap = null,
        } = opts;

        const cam = { x: 0, y: 0, zoom: 1 };

        // No defensive self-heal of cam values: the camera math has one path,
        // and a non-finite value (only reachable via a real bug) shows as a
        // visibly broken transform rather than being silently snapped to a
        // default — which is what the "no silent degradation" rule wants.
        function applyCamera() {
            const { x, y, zoom } = cam;
            camera.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
            if (gridLayer) {
                const gridUnit = 70 * zoom;
                const gridSub = 35 * zoom;
                gridLayer.style.backgroundPosition = `${x}px ${y}px, ${x + gridSub}px ${y + gridSub}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;
                gridLayer.style.backgroundSize = `${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridUnit}px ${gridUnit}px, ${gridSub}px ${gridSub}px, ${gridSub}px ${gridSub}px`;
            }
            if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
        }

        function fit() {
            const rect = svg.getBoundingClientRect();
            const w = (typeof getWorld === 'function' && getWorld()) || {};
            const ww = w.worldW || 0;
            const wh = w.worldH || 0;
            if (rect.width <= 0 || rect.height <= 0 || ww <= 0 || wh <= 0) {
                cam.x = 0; cam.y = 0; cam.zoom = 1;
                applyCamera();
                return;
            }
            const sx = rect.width / ww;
            const sy = rect.height / wh;
            const z = Math.max(fitMin, Math.min(sx, sy, fitMax));
            cam.zoom = Math.max(zoomMin, Math.min(zoomMax, z));
            cam.x = (rect.width - ww * cam.zoom) / 2;
            cam.y = (rect.height - wh * cam.zoom) / 2;
            applyCamera();
        }

        // ── Drag-to-pan (left button; ignores buttons/links/inputs) ────────
        let dragging = null;
        function onPointerDown(e) {
            if (e.button !== 0) return;
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input') return;
            dragging = {
                startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y,
                moved: false, target: e.target,
            };
            try { svg.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
            svg.classList.add('nm-grabbing');
            e.preventDefault();
        }
        function onPointerMove(e) {
            if (!dragging) return;
            if (Math.abs(e.clientX - dragging.startX) > 4 || Math.abs(e.clientY - dragging.startY) > 4) dragging.moved = true;
            cam.x = dragging.camX + (e.clientX - dragging.startX);
            cam.y = dragging.camY + (e.clientY - dragging.startY);
            applyCamera();
        }
        function endDrag(e, isUp) {
            if (!dragging) return;
            const d = dragging;
            try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
            dragging = null;
            svg.classList.remove('nm-grabbing');
            if (isUp && !d.moved && typeof onTap === 'function') onTap(e.clientX, e.clientY, d.target);
        }
        const onPointerUp = (e) => endDrag(e, true);
        const onPointerCancel = (e) => endDrag(e, false);

        // ── Wheel-zoom toward the cursor ───────────────────────────────────
        function onWheel(e) {
            const rect = svg.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top || e.clientY > rect.bottom) return;
            e.preventDefault();
            e.stopPropagation();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
            const newZoom = Math.max(zoomMin, Math.min(zoomMax, cam.zoom * factor));
            const worldX = (mx - cam.x) / cam.zoom;
            const worldY = (my - cam.y) / cam.zoom;
            cam.zoom = newZoom;
            cam.x = mx - worldX * newZoom;
            cam.y = my - worldY * newZoom;
            applyCamera();
        }

        svg.addEventListener('pointerdown', onPointerDown);
        svg.addEventListener('pointermove', onPointerMove);
        svg.addEventListener('pointerup', onPointerUp);
        svg.addEventListener('pointercancel', onPointerCancel);
        canvasHost.addEventListener('wheel', onWheel, { passive: false, capture: true });

        let resizeTimer = null;
        const resizeObs = ('ResizeObserver' in root) ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => fit(), 150);
        }) : null;
        if (resizeObs) resizeObs.observe(canvasHost);

        function destroy() {
            svg.removeEventListener('pointerdown', onPointerDown);
            svg.removeEventListener('pointermove', onPointerMove);
            svg.removeEventListener('pointerup', onPointerUp);
            svg.removeEventListener('pointercancel', onPointerCancel);
            canvasHost.removeEventListener('wheel', onWheel, { capture: true });
            if (resizeObs) resizeObs.disconnect();
            if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        }

        return { cam, applyCamera, fit, destroy };
    }

    root.COR3.panZoom = { create };
})();
