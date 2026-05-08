// src/modules/solvers/decrypt.js
// Auto-solver for the "decrypt" config-hack minigame on cor3.gg.
// Wraps the legacy decrypt-solver.js IIFE in a Module that listens for
// COR3_START_DECRYPT_SOLVER and runs the watcher loop. The minimax algorithm
// is preserved verbatim from the legacy implementation.
// Lives in MAIN world. Logger forwards via Bus.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    const MINIGAME_SEL = '[data-sentry-element="LogContentStyled"][data-sentry-source-file="config-hack-application.tsx"]';

    // ─── Solver internals (carried over verbatim) ─────────────────────────
    function reactSet(el, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function submit(el, text) {
        reactSet(el, text);
        await dom.sleep(10);
        ['keydown', 'keypress', 'keyup'].forEach((type) =>
            el.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13,
                charCode: type === 'keypress' ? 13 : 0,
                bubbles: true, cancelable: true,
            }))
        );
    }

    function logLines() {
        const container = document.querySelector(MINIGAME_SEL);
        return [...(container?.querySelectorAll('div') ?? [])].map((d) => d.textContent.trim()).filter(Boolean);
    }

    async function waitForResponse(inputEl, combo, timeout = 5000) {
        const pattern = new RegExp(
            `^Input: ${combo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nResult:\\nMismatched (\\d+)`
        );
        const start = Date.now();
        while (Date.now() - start < timeout && document.contains(inputEl)) {
            if (root.__solverAbort) return null;
            const lines = logLines();
            for (const line of lines) {
                const m = line.match(pattern);
                if (m) return parseInt(m[1]);
            }
            await dom.sleep(100);
        }
        return null;
    }

    function buildCombo(indices, fields) {
        return indices.map((vi, fi) => fields[fi][vi]).join(' ');
    }

    function detectFields(lines) {
        const fields = [];
        for (const line of lines) {
            const m = line.match(/→\s*(.+)/);
            if (m) fields.push(m[1].split('/').map((s) => s.trim()));
        }
        return fields;
    }

    function generateAllCombinations(numFields, optsPerField) {
        let results = [[]];
        for (let i = 0; i < numFields; i++) {
            const next = [];
            for (const r of results) {
                for (let j = 0; j < optsPerField[i]; j++) next.push([...r, j]);
            }
            results = next;
        }
        return results;
    }

    let cachedSolver = null;
    function getOrCreateSolver(FIELDS) {
        const key = FIELDS.map((f) => f.join('|')).join('||');
        if (cachedSolver && cachedSolver.key === key) return cachedSolver;
        const numFields = FIELDS.length;
        const allGuesses = generateAllCombinations(numFields, FIELDS.map((f) => f.length));
        const N = allGuesses.length;
        const distMatrix = new Uint8Array(N * N);
        for (let i = 0; i < N; i++) {
            for (let j = i; j < N; j++) {
                let d = 0;
                for (let k = 0; k < numFields; k++) {
                    if (allGuesses[i][k] !== allGuesses[j][k]) d++;
                }
                distMatrix[i * N + j] = d;
                distMatrix[j * N + i] = d;
            }
        }
        cachedSolver = { key, distMatrix, memo: new Map(), allGuesses, N, numFields };
        return cachedSolver;
    }

    async function runSolver(mod) {
        if (root.__solverAbort) return;
        const lines = logLines();
        const FIELDS = detectFields(lines);
        if (FIELDS.length === 0) { mod.warn('could not detect fields'); return; }

        const placeholder = FIELDS.map((f) => f[0]).join(' ');
        const input = document.querySelector(`input[placeholder="${placeholder}"]`);
        if (!input) { mod.error(`input field not found (placeholder="${placeholder}")`); return; }

        const solver = getOrCreateSolver(FIELDS);
        const { distMatrix, memo, allGuesses, N, numFields } = solver;
        const getDist = (a, b) => distMatrix[a * N + b];

        function getBestGuess(possibilities, parentBest = Infinity) {
            if (possibilities.length === 1) return { guess: possibilities[0], depth: 1 };
            const key = possibilities.join(',');
            if (memo.has(key)) return memo.get(key);

            let bestDepth = Infinity;
            let bestGuess = -1;

            for (let g = 0; g < N; g++) {
                const partitions = new Array(numFields + 1);
                for (let i = 0; i <= numFields; i++) partitions[i] = [];
                let isPossibleAnswer = false;
                for (let i = 0; i < possibilities.length; i++) {
                    const p = possibilities[i];
                    const d = getDist(g, p);
                    if (d === 0) isPossibleAnswer = true;
                    else partitions[d].push(p);
                }
                let dominated = false;
                for (let d = 1; d <= numFields; d++) {
                    if (partitions[d].length === possibilities.length) { dominated = true; break; }
                }
                if (dominated) continue;

                let currentMax = isPossibleAnswer ? 1 : 0;
                let aborted = false;
                for (let d = 1; d <= numFields; d++) {
                    if (partitions[d].length === 0) continue;
                    const res = getBestGuess(partitions[d], bestDepth);
                    const candidate = res.depth + 1;
                    if (candidate > currentMax) currentMax = candidate;
                    if (currentMax > bestDepth || currentMax >= parentBest) { aborted = true; break; }
                }
                if (aborted) continue;
                if (currentMax < bestDepth) { bestDepth = currentMax; bestGuess = g; }
                else if (currentMax === bestDepth) {
                    const newInSet = possibilities.includes(g);
                    const curInSet = possibilities.includes(bestGuess);
                    if (newInSet && !curInSet) bestGuess = g;
                }
            }
            const result = { guess: bestGuess, depth: bestDepth };
            memo.set(key, result);
            return result;
        }

        let possibilities = Array.from({ length: N }, (_, i) => i);
        let guessNum = 0;
        const doGuess = async (combo, label) => {
            if (root.__solverAbort) return null;
            mod.debug(`[${label}] ${combo}`);
            await submit(input, combo);
            return await waitForResponse(input, combo);
        };
        while (possibilities.length > 0) {
            if (root.__solverAbort) return;
            const best = getBestGuess(possibilities);
            const m = await doGuess(buildCombo(allGuesses[best.guess], FIELDS), `guess ${++guessNum}`);
            if (m == null || m === 0) return;
            possibilities = possibilities.filter((p) => getDist(best.guess, p) === m);
            if (possibilities.length === 0) { mod.error('no possibilities left'); return; }
        }
    }

    async function watchLoop(mod) {
        // Pre-warm cache for the most common 4-field minigame layout
        getOrCreateSolver([
            ['v1.0', 'v1.1', 'v2.0'],
            ['GET', 'PUT', 'POST'],
            ['LTE', 'Fiber', 'Sat'],
            ['AES', 'RSA', 'DES'],
        ]);

        while (!root.__solverAbort) {
            await dom.sleep(250);
            const container = document.querySelector(MINIGAME_SEL);
            if (!container) continue;
            const lines = logLines();
            const isReady = lines.length > 0 && lines[lines.length - 1].startsWith('Attempts:');
            if (!isReady) continue;

            mod.info('minigame detected, running solver');
            await runSolver(mod);
            if (root.__solverAbort) break;

            mod.debug('waiting for minigame to close');
            while (!root.__solverAbort && document.querySelector(MINIGAME_SEL)) {
                await dom.sleep(100);
            }
            if (!root.__solverAbort) mod.debug('minigame closed, watching for next one');
        }

        root.__solverActive = false;
        root.__solverAbort = false;
        mod.info('decrypt solver stopped');
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class DecryptSolverModule extends Module {
        constructor() {
            super({
                id: 'solver-decrypt',
                name: 'Solver: Decrypt minigame',
                category: C.CATEGORY.SOLVER,
                owns: { busTypes: [MSG.SOLVER.START_DECRYPT, MSG.SOLVER.STOP_DECRYPT] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.SOLVER.START_DECRYPT, () => {
                if (root.__solverActive && !root.__solverAbort) {
                    this.debug('start ignored — already active');
                    return;
                }
                root.__solverAbort = false;
                root.__solverActive = true;
                this.info('decrypt solver started');
                watchLoop(this);
            }));
            this.track(Bus.window.on(MSG.SOLVER.STOP_DECRYPT, () => {
                root.__solverAbort = true;
                this.info('decrypt solver stop requested');
            }));
        }
    }

    Registry.register(new DecryptSolverModule());
})();
