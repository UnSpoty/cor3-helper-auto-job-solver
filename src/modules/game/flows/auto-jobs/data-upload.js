// Auto Jobs — Data Upload flow (MAIN world). jobType: data_upload
// (matches both "data upload" and the legacy "file upload" job name — one type,
// see pipeline JOB_TYPE_KEYWORDS). Push the job's target file(s) from the
// player's Downloads to the server over WS.
//
// file.upload wire: the server's upload DTO is { serverId, name, sizeMb } — it
// rejects a fileId (a local Downloads id means nothing on the target server),
// so we send the source file's name + sizeMb. (Earlier { serverId, fileId }
// guess was rejected with "property fileId should not exist; name must be <=128
// chars; sizeMb should not be empty".)
//
// SITE-UPDATE FIX: cor3.gg's desktop.open.folder file object DROPPED the `sizeMb`
// field (current fields: id, name, kind, gates, permission, systemFileId,
// folderId, imagePreview, canDelete, canRename, isNew, isValuable) — and the
// File Analysis / get.options snapshots don't carry it either, so there is no
// local source for the real size anymore. The server only requires sizeMb to be
// a non-empty number (verified live: an upload with sizeMb=1 succeeded), so we
// fall back to a default when the field is absent. Use file.sizeMb if cor3.gg
// ever restores it.
const DEFAULT_UPLOAD_SIZE_MB = 1;
(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!root.COR3 || !root.COR3.constants || !root.COR3.autoJobs || !root.COR3.autoJobs.saiFlow) return;
    const C = root.COR3.constants;
    const NODE = C.AJ.NODE;
    const SF = root.COR3.autoJobs.saiFlow;

    SF.defineFlow({
        id: 'flow-data-upload',
        name: 'Flow: Data Upload',
        jobType: C.FLOW.DATA_UPLOAD,
        // job: { jobId, marketId, jobType, serverId, serverType, serverName, fileNames:[…], files:[{id,name,ext}] }
        async run(job, h) {
            h.step(NODE.DU_ACCESS);
            const acc = await h.ensureAccess(job.serverId, job.serverType, job.serverName);
            if (!acc.ok) return { success: false, retryable: acc.retryable !== false, reason: acc.reason };
            if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };

            h.step(NODE.DU_UPLOAD);
            // {id,name,ext} descriptors (fallback to bare fileNames). The source
            // file is in the player's Downloads; resolve it by id → name → stem,
            // because cor3.gg's Downloads name can differ from the condition name
            // (same inconsistency decrypt_extract handles). Fetch the folder once.
            const descriptors = (Array.isArray(job.files) && job.files.length)
                ? job.files
                : (job.fileNames || []).map((n) => ({ id: null, name: n, ext: null }));
            const downloads = await h.listDownloads();
            let uploaded = 0, notFound = 0;
            for (const desc of descriptors) {
                if (h.abort()) return { success: false, retryable: true, reason: 'aborted' };
                const file = h.resolveFile(downloads, desc, 'id');
                if (!file) { notFound++; h.say('warn', `"${desc.name}" not in Downloads to upload (by id/name/stem)`); continue; }
                const sizeMb = (file.sizeMb != null) ? file.sizeMb : DEFAULT_UPLOAD_SIZE_MB;
                const r = await h.awaitAction(15000, () => root.__cor3SaiFileUpload(job.serverId, file.name, sizeMb));
                const ok = r && !r.error;
                if (ok) uploaded++;
                h.say('info', `file.upload ${file.name} (${sizeMb} MB) → ${ok ? 'uploaded' : 'failed'}${r && r.error ? ' [' + JSON.stringify(r.error) + ']' : ''}`);
            }

            // retryable — the source file may not have landed in Downloads yet,
            // and listDownloads() also returns [] on an open.folder timeout, so
            // "not found" here can be a transient read miss. The attempt budget
            // (MAX_FLOW_ATTEMPTS) bugs a persistent miss; never bug on the
            // first one (the old missing-retryable did exactly that).
            if (uploaded === 0) return { success: true, didWork: false, retryable: true, reason: `no file uploaded (${notFound} not in Downloads) — retrying` };

            h.step(NODE.DU_COMPLETE);
            h.complete();
            h.say('info', `Data Upload: uploaded ${uploaded}/${descriptors.length} to "${job.serverName}"`);
            return { success: true, didWork: true };
        },
    });
})();
