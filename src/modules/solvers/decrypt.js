// Auto-solver for the cor3.gg "decrypt" config-hack minigame.
// Watch loop polls for [data-sentry-component="ConfigHackApplication"];
// when present, runs a Knuth-style minimax over the parameter combinations
// using "Mismatched N" feedback from the puzzle log.
//
// Submit layer: the puzzle UI uses arrow-key-driven ParameterCells. ↑ ↓
// cycle a cell's value, ← → switch focused cell, click SendButton submits.
// Lives in MAIN world. Logger forwards via Bus.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    // Stable component-name selectors (Goober "go…" hashes change between
    // builds, but data-sentry-* attributes stay).
    const SEL = {
        APP:    '[data-sentry-component="ConfigHackApplication"]',
        CELLS:  '[data-sentry-component="ParameterCells"]',
        LOG:    '[data-sentry-element="LogContentStyled"]',
        SEND:   '[data-sentry-element="SendButtonStyled"]',
    };

    // ─── DOM helpers ──────────────────────────────────────────────────────
    function getCellButtons() {
        const cells = document.querySelector(SEL.CELLS);
        if (!cells) return [];
        return Array.from(cells.querySelectorAll('button')).filter(
            (b) => !b.matches(SEL.SEND)
        );
    }

    function cellValue(idx) {
        const buttons = getCellButtons();
        const spans = buttons[idx]?.querySelectorAll('span');
        return spans?.[1]?.textContent.trim() ?? null;
    }

    function logLines() {
        const container = document.querySelector(SEL.LOG);
        if (!container) return [];
        return Array.from(container.querySelectorAll('div'))
            .map((d) => d.textContent.trim())
            .filter(Boolean);
    }

    /**
     * Click a cell button with a real-feeling mouse sequence (mousedown +
     * mouseup + click). React's onMouseDown is what advances focus to that
     * cell — calling .click() alone, or dispatching only a click event,
     * doesn't fire the focus handler.
     */
    async function focusCellByClick(idx) {
        const buttons = getCellButtons();
        const btn = buttons[idx];
        if (!btn) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        btn.dispatchEvent(new MouseEvent('mousedown', opts));
        btn.dispatchEvent(new MouseEvent('mouseup', opts));
        btn.dispatchEvent(new MouseEvent('click', opts));
        await dom.sleep(50);
        return true;
    }

    function sendArrowUp() {
        const target = document.querySelector(SEL.APP) || document.body;
        for (const type of ['keydown', 'keyup']) {
            target.dispatchEvent(new KeyboardEvent(type, {
                key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38,
                bubbles: true, cancelable: true,
            }));
        }
    }

    /**
     * Press ArrowUp until the focused cell shows targetValue. Up cycles
     * forward through the displayed option list (verified live: from v1.0,
     * ArrowDown → v2.0 → v1.1 → v1.0; ArrowUp goes the opposite way). The
     * value updates synchronously enough that DOM reads are reliable.
     */
    async function setFocusedValue(fieldIdx, targetValue, optionsCount) {
        let safety = optionsCount + 1;
        while (cellValue(fieldIdx) !== targetValue && safety-- > 0) {
            sendArrowUp();
            await dom.sleep(50);
        }
        return cellValue(fieldIdx) === targetValue;
    }

    async function clickSubmit() {
        const send = document.querySelector(SEL.SEND);
        if (!send) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        send.dispatchEvent(new MouseEvent('mousedown', opts));
        send.dispatchEvent(new MouseEvent('mouseup', opts));
        send.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    async function submitCombo(comboValues, FIELDS, mod) {
        for (let i = 0; i < FIELDS.length; i++) {
            if (root.__solverAbort) return false;
            if (!await focusCellByClick(i)) {
                mod.error(`could not focus field ${i}`);
                return false;
            }
            if (!await setFocusedValue(i, comboValues[i], FIELDS[i].length)) {
                mod.error(`could not set field ${i} to ${comboValues[i]} (current: ${cellValue(i)})`);
                return false;
            }
        }
        // Click SendButton instead of pressing Enter. Enter only fires
        // submit when focus is on the LAST cell, which is fragile — clicks
        // on the Send button work from any state.
        if (!await clickSubmit()) {
            mod.error('SendButton not found');
            return false;
        }
        return true;
    }

    /**
     * Parse the result of our most recent guess from the log. Each guess
     * adds 4 lines: `> v1.1 PUT LTE AES`, `Mismatched 2`, `attempts left ==
     * 5`, `Input: v1.1 PUT LTE AES Result: Mismatched 2 attempts left == 5`.
     * Scan bottom-up for the echo line `> <combo>`, then read the next line
     * for the digit. Locale-resilient: doesn't depend on the words "Input"
     * / "Mismatched" — just the `>` echo and the number that follows.
     */
    async function waitForResponse(combo, mod, timeout = 5000) {
        const echoLine = '> ' + combo;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (root.__solverAbort) return null;
            // Bail early if the puzzle window closed mid-wait (timer expired
            // or puzzle solved by another path).
            if (!document.querySelector(SEL.APP)) {
                mod.debug('puzzle closed while waiting for response');
                return null;
            }
            const lines = logLines();
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i] === echoLine) {
                    const nextLine = lines[i + 1] || '';
                    const m = nextLine.match(/(\d+)/);
                    if (m) return parseInt(m[1], 10);
                }
            }
            await dom.sleep(100);
        }
        mod.warn(`waitForResponse timeout for combo: ${combo}`);
        return null;
    }

    // ─── Solver internals (Knuth-style minimax — preserved verbatim) ──────
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
        if (!document.querySelector(SEL.CELLS)) { mod.error('ParameterCells not present'); return; }

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
        while (possibilities.length > 0) {
            if (root.__solverAbort) return;
            const best = getBestGuess(possibilities);
            const guessIndices = allGuesses[best.guess];
            const guessValues = guessIndices.map((vi, fi) => FIELDS[fi][vi]);
            const comboStr = guessValues.join(' ');
            mod.debug(`[guess ${++guessNum}] ${comboStr}`);
            const ok = await submitCombo(guessValues, FIELDS, mod);
            if (!ok) return;
            const m = await waitForResponse(comboStr, mod);
            if (m == null) return;
            if (m === 0) { mod.info(`solved in ${guessNum} guess(es): ${comboStr}`); return; }
            possibilities = possibilities.filter((p) => getDist(best.guess, p) === m);
            if (possibilities.length === 0) { mod.error('no possibilities left — feedback inconsistent'); return; }
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
            if (!document.querySelector(SEL.APP)) continue;
            // Wait until cells render — the puzzle goes through a brief
            // "loading" state before ParameterCells appear.
            if (!document.querySelector(SEL.CELLS)) continue;
            const lines = logLines();
            const ready = lines.some((l) => /^Attempts:/.test(l));
            if (!ready) continue;

            mod.info('minigame detected, running solver');
            await runSolver(mod);
            if (root.__solverAbort) break;

            mod.debug('waiting for minigame to close');
            while (!root.__solverAbort && document.querySelector(SEL.APP)) {
                await dom.sleep(200);
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
