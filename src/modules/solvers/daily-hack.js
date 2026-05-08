// src/modules/solvers/daily-hack.js
// Auto-solver for cor3.gg daily-hack minigames:
//   • System Log Integrity — pick the 2 worst log lines, fix each error
//   • Signal Hack — decode pulse groups as Morse or Binary, report value
// Wraps the legacy daily-hack-solver.js logic in a Module. Lives in MAIN world.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    const MORSE_MAP = {
        LLLLL: '0', SLLLL: '1', SSLLL: '2', SSSLL: '3', SSSSL: '4',
        SSSSS: '5', LSSSS: '6', LLSSS: '7', LLLSS: '8', LLLLS: '9',
    };
    const BINARY_MAP = {
        SSSS: '0', SSSL: '1', SSLS: '2', SSLL: '3', SLSS: '4',
        SLSL: '5', SLLS: '6', SLLL: '7', LSSS: '8', LSSL: '9',
    };

    const VALID_TYPES = new Set(['AUTH', 'TEMP-SYNC', 'SCAN', 'ROUTE-CHECK', 'RADIO-TEST', 'PING', 'SYNC']);
    const VALID_STATUSES = new Set(['OK', 'WARN', 'ERROR']);
    const ERROR_LABELS = {
        TIME: 'Time format is incorrect',
        TYPE: 'Event type is incorrect',
        MISSING_SECTOR: 'Missing /sector parameter',
        MISSING_STATUS: 'Missing /status parameter',
        SECTOR_BAD: '/sector parameter is incorrect',
        STATUS_BAD: '/status parameter is incorrect',
    };

    function analyzeLogLine(rawText) {
        const issues = [];
        const text = (rawText || '').trim();
        const timeMatch = text.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+/);
        let rest = text;
        if (timeMatch) {
            const h = +timeMatch[1], m = +timeMatch[2], s = +timeMatch[3];
            if (!(Number.isInteger(h) && h >= 0 && h <= 23 &&
                  Number.isInteger(m) && m >= 0 && m <= 59 &&
                  Number.isInteger(s) && s >= 0 && s <= 59)) issues.push('TIME');
            rest = text.slice(timeMatch[0].length);
        } else issues.push('TIME');

        const typeMatch = rest.match(/^([A-Z-]+)\b/);
        if (typeMatch) {
            if (!VALID_TYPES.has(typeMatch[1])) issues.push('TYPE');
            rest = rest.slice(typeMatch[0].length).trim();
        } else issues.push('TYPE');

        const hasSector = /(^|\s)\/sector=/.test(rest);
        const hasStatus = /(^|\s)\/status=/.test(rest);
        if (!hasSector) issues.push('MISSING_SECTOR');
        if (!hasStatus) issues.push('MISSING_STATUS');
        if (hasSector) {
            const sm = rest.match(/\/sector=([^\s]+)/);
            const sv = sm ? sm[1] : null;
            const sn = sv != null && /^[0-9]+$/.test(sv) ? Number(sv) : NaN;
            if (!(Number.isInteger(sn) && sn >= 1 && sn <= 256)) issues.push('SECTOR_BAD');
        }
        if (hasStatus) {
            const stm = rest.match(/\/status=([^\s]+)/);
            const stv = stm ? stm[1] : null;
            if (!(stv != null && VALID_STATUSES.has(stv))) issues.push('STATUS_BAD');
        }
        return [...new Set(issues)];
    }

    function clickCheckbox(entryEl) {
        const input = entryEl.querySelector('input[type="checkbox"]') ||
                      entryEl.querySelector('.checkbox input') ||
                      entryEl.querySelector('[role="checkbox"]') ||
                      entryEl.querySelector('input');
        if (!input) return false;
        if (input.tagName === 'INPUT' && input.type === 'checkbox') {
            if (!input.checked) {
                input.checked = true;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return true;
        }
        input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
    }

    function findErrorTypeButton(container, label) {
        return Array.from(container.querySelectorAll('.error-type-button'))
            .find((b) => (b.textContent || '').trim() === label) || null;
    }

    async function solveSystemLogIntegrity(mod) {
        mod.info('detected System Log Integrity puzzle');
        const logContainer = document.querySelector('.log-entries') ||
                             document.querySelector('.log-entries-holder') ||
                             document.querySelector('.log-entries-container') ||
                             document.querySelector('.log');
        if (!logContainer) { mod.error('log-entries container not found'); return; }

        const entries = Array.from(logContainer.querySelectorAll('.log-entry'));
        if (!entries.length) { mod.error('no .log-entry elements'); return; }

        const analyzed = entries.map((el) => {
            const textEl = el.querySelector('span') || el.querySelector('.log-text') || el;
            const text = (textEl?.textContent || '').trim();
            return { el, text, issues: analyzeLogLine(text) };
        }).filter((e) => e.issues.length > 0);

        analyzed.sort((a, b) => b.issues.length - a.issues.length);
        const selected = analyzed.slice(0, 2);
        if (selected.length < 2) mod.warn(`only ${selected.length} invalid log(s)`);

        for (const entry of selected) clickCheckbox(entry.el);

        const confirmBtn = document.querySelector('.confirm-button');
        if (!confirmBtn) { mod.error('.confirm-button not found'); return; }
        confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await dom.sleep(1000);

        const analysisContainer = document.querySelector('.analysis-container');
        if (!analysisContainer) { mod.error('.analysis-container not found after confirm'); return; }

        const blocks = Array.from(analysisContainer.querySelectorAll('.error-analysis-block'));
        if (!blocks.length) { mod.error('no .error-analysis-block found'); return; }

        const issueMap = new Map(selected.map((e) => [e.text, e.issues]));
        for (const block of blocks) {
            const lineDisplay = block.querySelector('.log-line-display');
            const lineText = (lineDisplay?.textContent || '').trim();
            let issues = issueMap.get(lineText);
            if (!issues) {
                const match = selected.find((e) => e.text === lineText) ||
                              selected.find((e) => lineText && e.text && (e.text.includes(lineText) || lineText.includes(e.text)));
                issues = match ? match.issues : null;
            }
            if (!issues || !issues.length) {
                mod.warn(`could not map analysis block: ${lineText}`);
                continue;
            }
            const fixBtn = block.querySelector('.fix-error-button');
            if (fixBtn) {
                fixBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await dom.sleep(50);
                for (const iss of issues) {
                    const label = ERROR_LABELS[iss] || iss;
                    const errBtn = findErrorTypeButton(block, label);
                    if (errBtn) {
                        errBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        await dom.sleep(25);
                    } else mod.warn(`no error-type-button for: ${label}`);
                }
                mod.info(`fixed: ${lineText}`);
            } else mod.warn(`no .fix-error-button for: ${lineText}`);
        }
    }

    function solveSignalHack(mod) {
        mod.info('detected Signal Hack puzzle');
        const timeline = document.querySelector('.pulse-timeline');
        if (!timeline) { mod.error('.pulse-timeline not found'); return; }

        const groups = Array.from(timeline.querySelectorAll('.pulse-group'));
        const pulses = groups.map((g, i) => {
            const isShort = !!g.querySelector('.pulse-bar.short');
            const longCount = g.querySelectorAll('.pulse-bar.long').length;
            if (isShort) return 'S';
            if (longCount >= 3) return 'L';
            const bar = g.querySelector('.pulse-bar');
            if (bar?.classList.contains('short')) return 'S';
            if (bar?.classList.contains('long')) return 'L';
            mod.warn(`pulse group #${i} unclassifiable, using "?"`);
            return '?';
        });

        const decode = (groupSize, map) => {
            const result = [];
            for (let i = 0; i < pulses.length; i += groupSize) {
                const chunk = pulses.slice(i, i + groupSize);
                if (chunk.length < groupSize) break;
                result.push(map[chunk.join('')] ?? '?');
            }
            return result.join('');
        };

        const morseResult = decode(5, MORSE_MAP);
        const binaryResult = decode(4, BINARY_MAP);
        const countDigits = (s) => (s.match(/[0-9]/g) || []).length;
        const countUnknown = (s) => (s.match(/\?/g) || []).length;

        const md = countDigits(morseResult);
        const bd = countDigits(binaryResult);
        let encoding, value;
        if (md === 0 && bd === 0) { encoding = 'UNKNOWN'; value = ''; }
        else if (md > bd) { encoding = 'MORSE'; value = morseResult; }
        else if (bd > md) { encoding = 'BINARY'; value = binaryResult; }
        else if (countUnknown(morseResult) <= countUnknown(binaryResult)) { encoding = 'MORSE'; value = morseResult; }
        else { encoding = 'BINARY'; value = binaryResult; }

        mod.info(`signal hack — Type: ${encoding}, Value: ${value}, Pulses: ${pulses.join(' ')}`);
        Bus.window.post(MSG.SOLVER.DAILY_HACK_LOG, { message: `Signal Hack → Type: ${encoding}, Value: ${value}` });
    }

    function detectPuzzle() {
        if (document.querySelector('.pulse-timeline')) return 'signal';
        if (document.querySelector('.log-entries') || document.querySelector('.log-entries-holder') ||
            document.querySelector('.log-entries-container') || document.querySelector('.log')) return 'log';
        return null;
    }

    function getPuzzleSignature() {
        const timeline = document.querySelector('.pulse-timeline');
        if (timeline) {
            const groups = timeline.querySelectorAll('.pulse-group');
            return 'signal:' + groups.length + ':' + timeline.innerHTML.length;
        }
        const logContainer = document.querySelector('.log-entries') ||
                             document.querySelector('.log-entries-holder') ||
                             document.querySelector('.log-entries-container') ||
                             document.querySelector('.log');
        if (logContainer) {
            const entries = logContainer.querySelectorAll('.log-entry');
            return 'log:' + entries.length + ':' + logContainer.innerHTML.length;
        }
        return null;
    }

    async function runOnce(mod) {
        let puzzle = detectPuzzle();
        let waited = 0;
        while (!puzzle && waited < 30000 && !root.__dailyHackAbort) {
            await dom.sleep(500); waited += 500;
            puzzle = detectPuzzle();
        }
        if (root.__dailyHackAbort) { mod.info('aborted'); return; }

        try {
            if (puzzle === 'signal') solveSignalHack(mod);
            else if (puzzle === 'log') await solveSystemLogIntegrity(mod);
            else {
                mod.warn('no known puzzle detected after 30s');
                Bus.window.post(MSG.SOLVER.DAILY_HACK_LOG, {
                    message: 'No puzzle detected. Navigate to the daily hack page first.',
                });
            }
        } catch (e) {
            mod.error('error solving puzzle', { error: String(e) });
            Bus.window.post(MSG.SOLVER.DAILY_HACK_LOG, { message: `Error: ${e.message || e}` });
        }
    }

    async function watchLoop(mod) {
        await runOnce(mod);
        let lastSig = getPuzzleSignature();
        mod.info('finished, monitoring for new puzzles');

        while (!root.__dailyHackAbort) {
            await dom.sleep(2000);
            if (root.__dailyHackAbort) break;
            const sig = getPuzzleSignature();
            if (sig && sig !== lastSig) {
                mod.info('new puzzle detected');
                const puzzle = detectPuzzle();
                try {
                    if (puzzle === 'signal') solveSignalHack(mod);
                    else if (puzzle === 'log') await solveSystemLogIntegrity(mod);
                    lastSig = getPuzzleSignature();
                } catch (e) {
                    mod.error('error on new puzzle', { error: String(e) });
                    Bus.window.post(MSG.SOLVER.DAILY_HACK_LOG, { message: `Error: ${e.message || e}` });
                }
            }
        }

        root.__dailyHackActive = false;
        root.__dailyHackAbort = false;
        mod.info('daily-hack solver stopped');
    }

    // ─── Module ───────────────────────────────────────────────────────────
    class DailyHackSolverModule extends Module {
        constructor() {
            super({
                id: 'solver-daily-hack',
                name: 'Solver: Daily Hack',
                category: C.CATEGORY.SOLVER,
                owns: { busTypes: [MSG.SOLVER.STOP_DAILY_HACK, MSG.SOLVER.DAILY_HACK_LOG] },
            });
        }
        async start() {
            this.track(Bus.window.on('COR3_START_DAILY_HACK', () => {
                if (root.__dailyHackActive && !root.__dailyHackAbort) {
                    this.debug('start ignored — already active');
                    return;
                }
                root.__dailyHackAbort = false;
                root.__dailyHackActive = true;
                this.info('daily-hack solver started');
                watchLoop(this);
            }));
            this.track(Bus.window.on(MSG.SOLVER.STOP_DAILY_HACK, () => {
                root.__dailyHackAbort = true;
                root.__dailyHackActive = false;
                this.info('daily-hack solver stop requested');
            }));
        }
    }

    Registry.register(new DailyHackSolverModule());
})();
