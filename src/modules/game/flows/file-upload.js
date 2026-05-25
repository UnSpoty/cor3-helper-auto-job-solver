// Job type: file_upload. Opens SAI Files → Add → file picker → Downloads
// folder → selects target file → clicks Upload.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    const { Module, Bus, Registry, dom, constants: C } = root.COR3;
    const SAI = root.COR3.game.sai;
    const flows = root.COR3.game.flows;
    const MSG = C.MSG;

    const FILE_PICKER_SEL = '[data-sentry-component="FilePickerGrid"]';
    const FILE_PICKER_GRID_SEL = '[data-sentry-element="FilePickerGridStyled"]';
    const FILE_PICKER_UPLOAD_BTN_SEL = '[data-sentry-element="FilePickerAttachButtonStyled"]';
    const FILE_PICKER_CLOSE_SEL = '[data-sentry-element="FilePickerCloseButtonStyled"]';

    function findPickerItem(grid, name) {
        for (const item of grid.children) {
            const nameEl = item.querySelector('.file-picker-name');
            if (nameEl && nameEl.textContent.trim().toLowerCase().includes(name.toLowerCase())) return item;
        }
        return null;
    }

    async function run(jobId, marketId, serverName, fileCondition, mod) {
        if (flows.isWatching()) return;
        flows.setWatching(true);

        const sai = await SAI.findOrOpenSai(serverName);
        if (!sai) { flows.sendTimeout(jobId, marketId, { transient: true }); flows.setWatching(false); return; }
        if (!await SAI.waitForServerAccess(sai, serverName)) { flows.sendTimeout(jobId, marketId); flows.setWatching(false); return; }

        await SAI.navigateToSection(sai, SAI.SEL.FILES);

        const addBtn = sai.querySelector(SAI.SEL.ADD_BTN);
        if (addBtn) { addBtn.click(); await dom.sleep(500); }
        else mod.warn('SAI add/attach button not found');

        const picker = await dom.waitForEl(FILE_PICKER_SEL, { timeout: 7_500 });
        if (!picker) {
            mod.warn('FilePicker did not appear');
            flows.sendTimeout(jobId, marketId);
            flows.setWatching(false);
            return;
        }

        // Navigate into Downloads folder (re-query grid each iteration — React replaces it)
        let downloadsItem = null;
        for (let i = 0; i < 15 && !root.__jobManagerAbort; i++) {
            const g = document.querySelector(FILE_PICKER_GRID_SEL);
            if (g) downloadsItem = findPickerItem(g, 'downloads');
            if (downloadsItem) break;
            await dom.sleep(300);
        }
        if (!downloadsItem) {
            // 4.5 s of polling and Downloads folder never rendered. Runtime
            // issue, not structural — transient timeout so we retry next cycle.
            mod.warn('Downloads folder not found in file picker');
            const closeBtn = document.querySelector(FILE_PICKER_CLOSE_SEL);
            if (closeBtn) closeBtn.click();
            flows.sendTimeout(jobId, marketId, { transient: true });
            flows.setWatching(false);
            return;
        }

        const prevNames = new Set([...document.querySelectorAll(`${FILE_PICKER_GRID_SEL} .file-picker-name`)].map((n) => n.textContent.trim()));
        downloadsItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));

        for (let i = 0; i < 20 && !root.__jobManagerAbort; i++) {
            await dom.sleep(300);
            const newNames = [...document.querySelectorAll(`${FILE_PICKER_GRID_SEL} .file-picker-name`)].map((n) => n.textContent.trim());
            if (newNames.length !== prevNames.size || newNames.some((n) => !prevNames.has(n))) break;
        }

        if (!fileCondition) {
            mod.warn('no fileCondition');
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'no-file-condition' });
            flows.setWatching(false);
            return;
        }

        let fileItem = null;
        for (let i = 0; i < 20 && !fileItem && !root.__jobManagerAbort; i++) {
            const g = document.querySelector(FILE_PICKER_GRID_SEL);
            if (g) fileItem = findPickerItem(g, fileCondition);
            if (!fileItem) await dom.sleep(300);
        }
        if (!fileItem) {
            // 6 s of polling, file truly isn't in Downloads. Permanent skip
            // (the user needs to grab it off another server first or the
            // job is stale).
            mod.warn(`File not found in Downloads: ${fileCondition}`);
            flows.userLog(`File Upload: file "${fileCondition}" not in Downloads — permanently skipping`, 'warn');
            const closeBtn = document.querySelector(FILE_PICKER_CLOSE_SEL);
            if (closeBtn) closeBtn.click();
            flows.sendResult(jobId, marketId, { success: true, didWork: false, reason: 'file-not-in-downloads' });
            flows.setWatching(false);
            return;
        }

        dom.clickEl(fileItem);
        await dom.sleep(400);

        for (let i = 0; i < 20 && !root.__jobManagerAbort; i++) {
            const uploadBtn = document.querySelector(FILE_PICKER_UPLOAD_BTN_SEL);
            if (uploadBtn && !uploadBtn.disabled) {
                uploadBtn.click();
                break;
            }
            await dom.sleep(300);
        }

        for (let i = 0; i < 40; i++) {
            if (!document.querySelector(FILE_PICKER_SEL)) break;
            await dom.sleep(300);
        }
        await dom.sleep(500);

        if (root.__jobManagerAbort) { flows.setWatching(false); return; }
        flows.userLog(`Upload done — "${fileCondition}" → "${serverName}"`, 'ok');
        flows.sendDone(jobId, marketId);
        flows.setWatching(false);
    }

    class FileUploadFlow extends Module {
        constructor() {
            super({
                id: 'flow-file-upload',
                name: 'Flow: File Upload',
                category: C.CATEGORY.GAME,
                dependsOn: ['flows-core', 'sai-navigator'],
                owns: { busTypes: [MSG.JOB.START_UPLOAD] },
            });
        }
        async start() {
            this.track(Bus.window.on(MSG.JOB.START_UPLOAD, (env) => {
                const { jobId, marketId, serverName, fileCondition } = env;
                flows.startFlow('Upload', { jobId, marketId, serverName, fileCondition },
                    () => run(jobId, marketId, serverName, fileCondition, this), this);
            }));
        }
    }
    Registry.register(new FileUploadFlow());
})();
