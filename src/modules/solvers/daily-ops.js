// src/modules/solvers/daily-ops.js
// MAIN-world one-shot solver for the Game Center "Daily Ops" minigames.
// Triggered by COR3_START_DAILY_OPS window envelope (popup → isolated → MAIN).
//
// Architecture: a single common pipeline opens Game Center → Daily Ops →
// presses Start, then dispatches based on which puzzle DOM appears.
// Currently routes to:
//   • Signal Decode  — .pulse-timeline / .encoding-option / .code-input
//   • System Log Integrity — .log-entries / .error-analysis-block /
//     .error-type-button (logic carried over verbatim from the legacy
//     daily-hack solver, where it was already working)
//
// Locale-neutral: matches data-component-name attributes and CSS classes,
// not user-facing strings. Brand keywords like "daily" / "morse" / "binary"
// stay English even on RU locale.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const MSG = C.MSG;

    // ─── Signal Decode tables ─────────────────────────────────────────────
    // 5-pulse groups encode digits 0-9 in modified Morse
    const MORSE_MAP = {
        LLLLL: '0', SLLLL: '1', SSLLL: '2', SSSLL: '3', SSSSL: '4',
        SSSSS: '5', LSSSS: '6', LLSSS: '7', LLLSS: '8', LLLLS: '9',
    };
    // 4-bit groups: S=0, L=1, decoded as digits 0-9 (rejects A-F)
    const BINARY_MAP = {
        SSSS: '0', SSSL: '1', SSLS: '2', SSLL: '3', SLSS: '4',
        SLSL: '5', SLLS: '6', SLLL: '7', LSSS: '8', LSSL: '9',
    };

    // ─── System Log Integrity tables ──────────────────────────────────────
    const VALID_TYPES = new Set(['AUTH', 'TEMP-SYNC', 'SCAN', 'ROUTE-CHECK', 'RADIO-TEST', 'PING', 'SYNC']);
    const VALID_STATUSES = new Set(['OK', 'WARN', 'ERROR']);
    // The site renders these as exact-match button labels. If a future
    // localization wraps them, .error-type-button text matching breaks —
    // log handler will warn and continue, leaving the user to finish.
    const ERROR_LABELS = {
        TIME: 'Time format is incorrect',
        TYPE: 'Event type is incorrect',
        MISSING_SECTOR: 'Missing /sector parameter',
        MISSING_STATUS: 'Missing /status parameter',
        SECTOR_BAD: '/sector parameter is incorrect',
        STATUS_BAD: '/status parameter is incorrect',
    };

    // Static dock IDs that are NOT Game Center. Anything else is a candidate.
    const KNOWN_TAB_NAMES = new Set([
        'BROWSER', 'RADIO', 'WEATHER', 'NETWORK_MAP', 'CODEX', 'DISK_READER',
        'MESSENGER', 'UPDATER', 'NOTEBOOK', 'TERMINAL', 'EXPEDITIONS',
        'GEAR', 'SHOP', 'MR7_MEDIA_READER', 'MR_7_MEDIA_READER',
    ]);

    function logUi(message) {
        Bus.window.post(MSG.SOLVER.DAILY_OPS_LOG, { message });
    }

    // WS readiness gate. Daily Ops Start and Submit both round-trip through
    // socket.io; if the active socket is mid-reconnect, the click is a no-op
    // and the solver hangs on a DOM update that never arrives. We give the
    // socket a few seconds to come back, then continue best-effort with a
    // warning so the user knows why nothing happened.
    async function waitForWsReady(mod, label) {
        const probe = root.__cor3WaitForWs;
        if (typeof probe !== 'function') return true; // interceptor not present
        if (root.__cor3IsWsReady && root.__cor3IsWsReady()) return true;
        mod.warn(`${label}: WS not ready, waiting up to 8s for reconnect`);
        logUi(`waiting for connection (${label})…`);
        const ok = await probe(8000);
        if (!ok) {
            mod.error(`${label}: WS still not ready after 8s — proceeding anyway`);
            logUi(`connection still down, ${label} may not register`);
        }
        return ok;
    }

    // After a submit click we want to know whether the server actually
    // accepted it. Look for the post-submit success badge (".verified" /
    // "VERIFIED"/"+N Credits" text) within a few seconds. If nothing shows
    // up, the WS round-trip likely missed.
    async function awaitSubmitFeedback(mod) {
        const seen = await dom.waitFor(() => {
            const game = document.querySelector('.game-container');
            if (!game) return null;
            // Site renders "DECODE STATUS: VERIFIED" or similar success block
            // after a good submit. The exact wording localizes, but the word
            // "Reward" / English digits stay in English.
            const t = (game.textContent || '');
            if (/verified|reward|credits|success/i.test(t)) return 'ok';
            // Failure path the site shows when submit lands wrong:
            if (/failed|invalid|incorrect|try\s*again/i.test(t)) return 'fail';
            return null;
        }, { timeout: 5000 });
        if (seen === 'ok') { mod.info('submit acknowledged by server'); return true; }
        if (seen === 'fail') { mod.warn('submit rejected — answer or state mismatch'); logUi('server rejected submit'); return false; }
        mod.warn('no submit feedback within 5s — WS round-trip may have missed');
        logUi('no server feedback (WS hiccup?)');
        return false;
    }

    // ─── Common navigation helpers ────────────────────────────────────────
    function findGameCenterTab() {
        const items = document.querySelectorAll('[data-component-name^="TabBarItem-"]');
        for (const it of items) {
            const name = (it.dataset.componentName || '').replace(/^TabBarItem-/, '');
            // Game Center is registered as a UUID-named tab (not in KNOWN_TAB_NAMES).
            // UUIDs include '-' and length > 16 — that's the heuristic.
            if (!KNOWN_TAB_NAMES.has(name) && name.length > 16 && name.includes('-')) return it;
        }
        return null;
    }

    function findDailyOpsCard() {
        const cards = document.querySelectorAll('.game-center-card');
        for (const c of cards) {
            const desc = c.querySelector('.game-center-card-description');
            // English brand keyword: cor3.gg ships card descriptions in English
            // even on RU locale. "daily" appears for the Daily Ops card.
            if (desc && /\bdaily\b/i.test(desc.textContent || '')) return c;
        }
        return null;
    }

    function findPuzzleWindow() {
        // The puzzle launches as GameWaitingScreen first (intro button: e.g.
        // "Get Signal" / "Get Logs"), then transitions to .game-container
        // after the user pulls the data.
        return document.querySelector('.game-container') ||
               document.querySelector('[data-sentry-component="GameWaitingScreen"]');
    }

    function findEnabledButtonByText(textRegex, scope = document) {
        const buttons = scope.querySelectorAll('button');
        for (const b of buttons) {
            if (b.disabled) continue;
            if (textRegex.test((b.textContent || '').trim())) return b;
        }
        return null;
    }

    async function ensureGameCenterOpen(mod) {
        if (document.querySelector('[data-sentry-component="GameCenterApplication"]')) return true;
        const tab = findGameCenterTab();
        if (!tab) {
            mod.error('Game Center tab not found in dock');
            logUi('Game Center tab not found');
            return false;
        }
        dom.clickEl(tab);
        const opened = await dom.waitForEl('[data-sentry-component="GameCenterApplication"]', { timeout: 5000 });
        if (!opened) {
            mod.error('Game Center did not open');
            logUi('Game Center did not open');
            return false;
        }
        return true;
    }

    async function ensureDailyOpsOpen(mod) {
        if (document.querySelector('[data-component-name="DailyOpsMainScreen"]')) return true;
        const card = await dom.waitForEl(findDailyOpsCard, { timeout: 4000 });
        if (!card) {
            mod.error('Daily Ops card not found in Game Center');
            logUi('Daily Ops card not found');
            return false;
        }
        dom.clickEl(card);
        const screen = await dom.waitForEl('[data-component-name="DailyOpsMainScreen"]', { timeout: 5000 });
        if (!screen) {
            mod.error('Daily Ops main screen did not render');
            logUi('Daily Ops did not open');
            return false;
        }
        return true;
    }

    async function clickStartButton(mod) {
        const btn = await dom.waitForEl(() => {
            const b = document.querySelector('[data-component-name="DailyOpsStartButton"]');
            return (b && !b.disabled) ? b : null;
        }, { timeout: 4000 });
        if (!btn) {
            mod.warn('DailyOpsStartButton not enabled (in progress?)');
            logUi('Start button not available');
            return false;
        }
        // The Start click registers a new game session over WS. If the socket
        // is mid-reconnect, the puzzle window won't actually open server-side
        // even though it renders locally.
        await waitForWsReady(mod, 'Start');
        dom.clickEl(btn);
        return true;
    }

    // ─── Puzzle type detection ────────────────────────────────────────────
    function detectPuzzleType() {
        if (document.querySelector('.pulse-timeline')) return 'signal';
        if (document.querySelector('.log-entries') ||
            document.querySelector('.log-entries-holder') ||
            document.querySelector('.log-entries-container') ||
            document.querySelector('.log-entry')) return 'log';
        return null;
    }

    // ─── Signal Decode solver ─────────────────────────────────────────────
    function readPulses() {
        const groups = document.querySelectorAll('.pulse-timeline .pulse-group');
        const pulses = [];
        groups.forEach((g) => {
            if (g.querySelector('.pulse-bar.short')) { pulses.push('S'); return; }
            const longCount = g.querySelectorAll('.pulse-bar.long').length;
            if (longCount >= 1) { pulses.push('L'); return; }
            const bar = g.querySelector('.pulse-bar');
            if (bar?.classList.contains('short')) pulses.push('S');
            else if (bar?.classList.contains('long')) pulses.push('L');
            else pulses.push('?');
        });
        return pulses;
    }

    function decodeWith(pulses, groupSize, map) {
        const digits = [];
        for (let i = 0; i + groupSize <= pulses.length; i += groupSize) {
            const ch = pulses.slice(i, i + groupSize).join('');
            digits.push(map[ch] ?? '?');
        }
        return digits.join('');
    }

    function chooseEncoding(pulses) {
        const morse = decodeWith(pulses, 5, MORSE_MAP);
        const binary = decodeWith(pulses, 4, BINARY_MAP);
        const morseValid = morse && !morse.includes('?') && pulses.length % 5 === 0;
        const binaryValid = binary && !binary.includes('?') && pulses.length % 4 === 0;
        if (morseValid && !binaryValid) return { encoding: 'morse', code: morse };
        if (binaryValid && !morseValid) return { encoding: 'binary', code: binary };
        if (morseValid && binaryValid) {
            const hint = document.querySelector('.input-hint')?.textContent || '';
            const m = hint.match(/(\d+)\s*digit/i);
            const expected = m ? Number(m[1]) : null;
            if (expected === morse.length) return { encoding: 'morse', code: morse };
            if (expected === binary.length) return { encoding: 'binary', code: binary };
            return { encoding: 'binary', code: binary };
        }
        const morseUnknown = (morse.match(/\?/g) || []).length;
        const binaryUnknown = (binary.match(/\?/g) || []).length;
        return binaryUnknown <= morseUnknown
            ? { encoding: 'binary', code: binary }
            : { encoding: 'morse', code: morse };
    }

    async function solveSignal(mod) {
        mod.info('routing to Signal Decode solver');
        logUi('signal puzzle');

        // Pre-encoding read (guess from preview pulses, fallback if absent)
        await dom.waitForEl('.pulse-timeline .pulse-group', { timeout: 8000 });
        await dom.sleep(300);
        let pulses = readPulses();
        let pick = chooseEncoding(pulses);
        mod.info(`pre-encoding: ${pick.encoding} → ${pick.code} (${pulses.length} pulses)`);

        // SELECT ENCODING (.next-button, enabled)
        const toEncoding = await dom.waitForEl(() => {
            return Array.from(document.querySelectorAll('.game-container .next-button'))
                .find((b) => !b.disabled) || null;
        }, { timeout: 4000 });
        if (toEncoding) { dom.clickEl(toEncoding); await dom.sleep(300); }

        const optionsReady = await dom.waitForEl('.encoding-option', { timeout: 4000 });
        if (!optionsReady) { mod.error('encoding-option not rendered'); logUi('encoding screen missing'); return; }
        const opts = document.querySelectorAll('.encoding-option');
        let target = null;
        for (const o of opts) {
            const t = (o.textContent || '').toLowerCase();
            if (pick.encoding === 'morse' && /morse/.test(t)) { target = o; break; }
            if (pick.encoding === 'binary' && /binary/.test(t)) { target = o; break; }
        }
        if (!target) { mod.error(`no ${pick.encoding} option`); logUi(`no ${pick.encoding} option`); return; }
        dom.clickEl(target);
        await dom.sleep(300);

        // DECODE SIGNAL
        const toDecode = await dom.waitForEl(() => {
            return Array.from(document.querySelectorAll('.game-container .next-button'))
                .find((b) => !b.disabled) || null;
        }, { timeout: 4000 });
        if (!toDecode) { mod.error('decode .next-button stuck'); logUi('decode button stuck'); return; }
        dom.clickEl(toDecode);
        await dom.sleep(400);

        const input = await dom.waitForEl('.code-input', { timeout: 5000 });
        if (!input) { mod.error('code-input not found'); logUi('input missing'); return; }
        await dom.waitForEl('.pulse-timeline .pulse-group', { timeout: 5000 });
        await dom.sleep(400);
        pulses = readPulses();
        const re = chooseEncoding(pulses);
        let code = re.code && !re.code.includes('?') ? re.code : pick.code;
        if (!code || code.includes('?')) {
            mod.error(`could not decode pulses cleanly: ${pulses.join('')}`);
            logUi('decode failed');
            return;
        }

        dom.setReactInputValue(input, code);
        await dom.sleep(250);

        const submit = await dom.waitForEl(() => {
            const b = document.querySelector('.game-container .submit-button');
            return (b && !b.disabled) ? b : null;
        }, { timeout: 4000 });
        if (!submit) { mod.error('submit-button not enabled after typing code'); logUi('submit blocked'); return; }
        await waitForWsReady(mod, 'Submit');
        dom.clickEl(submit);

        mod.info(`submitted daily ops (signal): ${code} (${pick.encoding})`);
        const ok = await awaitSubmitFeedback(mod);
        if (ok) logUi(`solved: ${code} (${pick.encoding})`);
    }

    // ─── System Log Integrity solver ──────────────────────────────────────
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

    async function solveLogIntegrity(mod) {
        mod.info('routing to System Log Integrity solver');
        logUi('log puzzle');

        const logContainer = document.querySelector('.log-entries') ||
                             document.querySelector('.log-entries-holder') ||
                             document.querySelector('.log-entries-container') ||
                             document.querySelector('.log');
        if (!logContainer) { mod.error('log-entries container not found'); logUi('log container missing'); return; }

        const entries = Array.from(logContainer.querySelectorAll('.log-entry'));
        if (!entries.length) { mod.error('no .log-entry elements'); logUi('no log entries'); return; }

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
        if (!confirmBtn) { mod.error('.confirm-button not found'); logUi('confirm missing'); return; }
        dom.clickEl(confirmBtn);
        await dom.sleep(1000);

        const analysisContainer = document.querySelector('.analysis-container');
        if (!analysisContainer) { mod.error('.analysis-container not found after confirm'); logUi('analysis screen missing'); return; }

        const blocks = Array.from(analysisContainer.querySelectorAll('.error-analysis-block'));
        if (!blocks.length) { mod.error('no .error-analysis-block found'); logUi('no analysis blocks'); return; }

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
                dom.clickEl(fixBtn);
                await dom.sleep(60);
                for (const iss of issues) {
                    const label = ERROR_LABELS[iss] || iss;
                    const errBtn = findErrorTypeButton(block, label);
                    if (errBtn) {
                        dom.clickEl(errBtn);
                        await dom.sleep(40);
                    } else mod.warn(`no error-type-button for: ${label}`);
                }
                mod.info(`fixed: ${lineText}`);
            } else mod.warn(`no .fix-error-button for: ${lineText}`);
        }

        // Final submit (Daily Ops wraps the legacy puzzle in a frame that
        // expects a submit click to claim the reward). Best-effort: try the
        // generic .submit-button class, then fall back to any visible
        // "submit"/"confirm"/"complete" labelled button.
        await dom.sleep(400);
        const submit = document.querySelector('.game-container .submit-button')
            || document.querySelector('.submit-button')
            || findEnabledButtonByText(/submit|confirm|complete/i, document.querySelector('.game-container') || document);
        if (submit && !submit.disabled) {
            await waitForWsReady(mod, 'Submit');
            dom.clickEl(submit);
            mod.info('clicked final submit');
            const ok = await awaitSubmitFeedback(mod);
            if (ok) logUi('solved: log integrity');
        } else {
            // No explicit submit button — the puzzle likely auto-confirms once
            // every error is fixed. Probe the container for success text.
            const ok = await awaitSubmitFeedback(mod);
            if (ok) logUi('solved: log integrity');
        }
    }

    // ─── Orchestrator ─────────────────────────────────────────────────────
    async function runOnce(mod) {
        logUi('starting…');

        // Common entry pipeline. Skip if we're already on the Daily Ops
        // screen — re-clicking the dock tab while a puzzle window is open
        // would toggle the wrong thing.
        if (!document.querySelector('[data-component-name="DailyOpsMainScreen"]')) {
            if (!await ensureGameCenterOpen(mod)) return;
            if (!await ensureDailyOpsOpen(mod)) return;
        }
        if (!await clickStartButton(mod)) return;

        // Wait for puzzle window — first state is GameWaitingScreen with an
        // intro button (e.g. "Get Signal" / "Get Logs"); .game-container
        // appears after that click.
        const puzzle = await dom.waitForEl(findPuzzleWindow, { timeout: 8000 });
        if (!puzzle) { mod.error('puzzle window did not open'); logUi('puzzle window missing'); return; }

        // Click the intro "Get …" button if it exists. Both signal and log
        // puzzles share this entry pattern (English brand keyword "Get").
        const introBtn = await dom.waitForEl(
            () => findEnabledButtonByText(/^get\s+\w+/i, findPuzzleWindow() || document),
            { timeout: 4000 }
        );
        if (introBtn) { dom.clickEl(introBtn); await dom.sleep(500); }

        // For signal puzzles, also press PLAY SIGNAL to render the timeline.
        // For log puzzles, the entry-click reveals .log-entries directly,
        // so this step is a no-op there.
        const playBtn = document.querySelector('.game-container .play-button');
        if (playBtn && !playBtn.disabled) { dom.clickEl(playBtn); await dom.sleep(400); }

        // Route based on what showed up
        const type = await dom.waitFor(detectPuzzleType, { timeout: 8000 });
        if (type === 'signal') return solveSignal(mod);
        if (type === 'log') return solveLogIntegrity(mod);
        mod.warn('unknown puzzle type — neither .pulse-timeline nor .log-entries appeared');
        logUi('unknown puzzle type');
    }

    class DailyOpsSolverModule extends Module {
        constructor() {
            super({
                id: 'solver-daily-ops',
                name: 'Solver: Daily Ops',
                category: C.CATEGORY.SOLVER,
                owns: { busTypes: [MSG.SOLVER.START_DAILY_OPS, MSG.SOLVER.DAILY_OPS_LOG] },
            });
            this.busy = false;
        }
        async start() {
            this.track(Bus.window.on(MSG.SOLVER.START_DAILY_OPS, async () => {
                if (this.busy) { this.debug('start ignored — already running'); return; }
                this.busy = true;
                try { await runOnce(this); }
                catch (e) { this.error('daily-ops solver crashed', { error: String(e) }); logUi(`Error: ${e.message || e}`); }
                finally { this.busy = false; }
            }));
        }
    }

    Registry.register(new DailyOpsSolverModule());
})();
