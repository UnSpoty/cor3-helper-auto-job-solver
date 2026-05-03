// content.js

// Check if extension context is still valid
function isContextValid() {
    try { return !!chrome.runtime.id; } catch (e) { return false; }
}

// --- Listen for data relayed from content-early.js (MAIN world) ---
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!isContextValid()) return; // Extension was reloaded/updated
    const now = Date.now();

    // WS message logging (sent/received from content-early.js)
    if (event.data && event.data.type === 'COR3_WS_LOG') {
        cor3LogWsMessage(event.data.direction, event.data.message);
    }
    // Relay debug logs from job-manager.js (MAIN world) into the popup log
    if (event.data && event.data.type === 'COR3_JOB_LOG') {
        pushAutoJobLog(event.data.msg, event.data.level || 'info');
        return;
    }

    if (event.data && event.data.type === 'COR3_WS_EXPEDITIONS') {
        chrome.storage.local.set({ expeditionsData: event.data.expeditions, expeditionsDataUpdatedAt: now });
        // Check for completed expeditions to trigger auto-send flow
        checkAutoSendOnExpeditionData(event.data.expeditions);
    }
    // Update decisions — always replace with fresh data from expedition messages
    if (event.data && event.data.type === 'COR3_WS_DECISIONS') {
        chrome.storage.local.set({ expeditionDecisions: event.data.decisions });
    }
    if (event.data && event.data.type === 'COR3_WS_STASH') {
        chrome.storage.local.set({ stashData: event.data.stash, stashDataUpdatedAt: now });

        // Check if auto-send was disabled due to full stash and if we now have space
        chrome.storage.sync.get('autoSendMerc', (settings) => {
            if (settings.autoSendMerc &&
                settings.autoSendMerc.disabledReason === 'stash_full' &&
                !settings.autoSendMerc.enabled) {

                const stash = event.data.stash;
                let hasSpace = false;
                let spaceNeeded = 2; // Require at least 2 spaces for safety

                if (stash && stash.maxCapacity && stash.currentUsage !== undefined) {
                    const availableSpace = stash.maxCapacity - stash.currentUsage;
                    hasSpace = availableSpace >= spaceNeeded;
                }

                if (hasSpace) {
                    console.log('[COR3 Helper] Stash has space again, re-enabling auto-send mercenary');
                    chrome.storage.sync.set({
                        autoSendMerc: {
                            ...settings.autoSendMerc,
                            enabled: true,
                            disabledReason: null
                        }
                    });
                    // Notify user
                    window.postMessage({
                        type: 'COR3_AUTO_SEND_REENABLED',
                        message: 'Stash space available. Auto-send mercenary re-enabled.'
                    }, '*');
                }
            }
        });
    }
    if (event.data && event.data.type === 'COR3_WS_MARKET') {
        chrome.storage.local.set({ marketData: event.data.market, marketDataUpdatedAt: now });
        // Do NOT clear sentAcceptIds here. The pruner in findNextAutoJob removes
        // IDs that are no longer present in any market — that's the only safe
        // signal that a job has actually left AVAILABLE state.
        if (autoJobsSettings.enabled && !autoJobsSettings.debugMode) {
            // Pick up TAKEN copies (full conditions for ip/log types) into the
            // queue. Idempotent — dedupes against autoJobsQueue and current job.
            setTimeout(tryResumeInProgressJob, 500);
            if (autoJobState.status === 'idle') setTimeout(tryAcceptNextJob, 2000);
        }
    }
    if (event.data && event.data.type === 'COR3_WS_DARK_MARKET') {
        chrome.storage.local.set({ darkMarketData: event.data.market, darkMarketAvailable: true, darkMarketDataUpdatedAt: now });
        if (autoJobsSettings.enabled && !autoJobsSettings.debugMode) {
            setTimeout(tryResumeInProgressJob, 500);
            if (autoJobState.status === 'idle') setTimeout(tryAcceptNextJob, 2000);
        }
    }
    // Handle dark market unreachable — keep cached data, set flag
    if (event.data && event.data.type === 'COR3_WS_DARK_MARKET_UNREACHABLE') {
        chrome.storage.local.set({ darkMarketAvailable: false, darkMarketDataUpdatedAt: now });
    }
    if (event.data && event.data.type === 'COR3_BEARER_TOKEN') {
        chrome.storage.local.set({ bearerToken: event.data.token });
    }
    // Store web version and system version
    if (event.data && event.data.type === 'COR3_WEB_VERSION') {
        chrome.storage.local.set({ webVersion: event.data.version });
    }
    if (event.data && event.data.type === 'COR3_SYSTEM_VERSION') {
        chrome.storage.local.set({ systemVersion: event.data.version });
    }
    // Store daily rewards data for streak bonus calculation
    if (event.data && event.data.type === 'COR3_DAILY_REWARDS') {
        chrome.storage.local.set({ dailyRewardsData: event.data.rewards });
    }
    // Store archived expeditions
    if (event.data && event.data.type === 'COR3_WS_ARCHIVED_EXPEDITIONS') {
        chrome.storage.local.set({ archivedExpeditionsData: event.data.data, archivedExpeditionsUpdatedAt: now });
    }
    // Store mercenary data
    if (event.data && event.data.type === 'COR3_WS_MERCENARIES') {
        chrome.storage.local.set({ mercenariesData: event.data.data, mercenariesUpdatedAt: now });
    }
    // Store expedition config data
    if (event.data && event.data.type === 'COR3_WS_EXPEDITION_CONFIG') {
        chrome.storage.local.set({ expeditionConfigData: event.data.data, expeditionConfigUpdatedAt: now });
    }
    // Store mercenary configure data (cost/risk per mercenary)
    if (event.data && event.data.type === 'COR3_WS_MERC_CONFIGURE' && event.data.mercenaryId) {
        chrome.storage.local.get('mercConfigData', (result) => {
            const configs = result.mercConfigData || {};
            configs[event.data.mercenaryId] = event.data.data;
            chrome.storage.local.set({ mercConfigData: configs, mercConfigUpdatedAt: now });
        });
    }
    // Auto-send: container opened — check inventory space before collecting all
    if (event.data && event.data.type === 'COR3_WS_CONTAINER_OPENED') {
        if (autoSendInProgress && autoSendExpeditionId) {
            console.log('[COR3 Helper] Auto-send: Container opened, checking inventory space...');
            const containerData = event.data.data;

            // Calculate space needed based on container contents
            let spaceNeeded = 2; // Default fallback
            if (containerData && containerData.items && Array.isArray(containerData.items)) {
                spaceNeeded = containerData.items.length;
                console.log('[COR3 Helper] Container contains', spaceNeeded, 'items');
            } else if (containerData && containerData.containerItems && Array.isArray(containerData.containerItems)) {
                spaceNeeded = containerData.containerItems.length;
                console.log('[COR3 Helper] Container contains', spaceNeeded, 'items (containerItems)');
            }

            // Check stash data to ensure we have enough space
            chrome.storage.local.get('stashData', (result) => {
                const stash = result.stashData;
                let hasSpace = true;

                if (stash && stash.maxCapacity && stash.currentUsage !== undefined) {
                    const availableSpace = stash.maxCapacity - stash.currentUsage;
                    hasSpace = availableSpace >= spaceNeeded;
                    console.log('[COR3 Helper] Inventory check:', availableSpace, 'available, need', spaceNeeded);
                }

                if (hasSpace) {
                    console.log('[COR3 Helper] Auto-send: Sufficient space, collecting all...');
                    setTimeout(() => {
                        window.postMessage({ type: 'COR3_COLLECT_ALL', expeditionId: autoSendExpeditionId }, '*');
                    }, 1000 + Math.floor(Math.random() * 500));
                } else {
                    console.log('[COR3 Helper] Auto-send: Insufficient space, disabling auto-container-claim');
                    // Disable auto-send temporarily due to full stash
                    chrome.storage.sync.get('autoSendMerc', (settings) => {
                        if (settings.autoSendMerc) {
                            chrome.storage.sync.set({
                                autoSendMerc: {
                                    ...settings.autoSendMerc,
                                    enabled: false,
                                    disabledReason: 'stash_full'
                                }
                            });
                        }
                    });
                    // Notify user with specific space information
                    const availableSpace = stash ? stash.maxCapacity - stash.currentUsage : 0;
                    window.postMessage({
                        type: 'COR3_STASH_FULL_WARNING',
                        message: `Stash is full. Need ${spaceNeeded} spaces but only ${availableSpace} available. Clear stash before claiming more items. Auto-send mercenary disabled.`
                    }, '*');
                    autoSendInProgress = false;
                }
            });
        }
    }
    // Handle stash full error from collect.all
    if (event.data && event.data.type === 'COR3_WS_STASH_FULL') {
        console.log('[COR3 Helper] Stash full error detected, disabling auto-send mercenary');
        // Disable auto-send temporarily due to full stash
        chrome.storage.sync.get('autoSendMerc', (settings) => {
            if (settings.autoSendMerc) {
                chrome.storage.sync.set({
                    autoSendMerc: {
                        ...settings.autoSendMerc,
                        enabled: false,
                        disabledReason: 'stash_full'
                    }
                });
            }
        });
        // Notify user
        window.postMessage({
            type: 'COR3_STASH_FULL_WARNING',
            message: 'Stash is full. Clear stash before claiming more items. Auto-send mercenary disabled.'
        }, '*');
        autoSendInProgress = false;
        autoSendExpeditionId = null;
    }
    // Handle insufficient credits error from expedition launch
    if (event.data && event.data.type === 'COR3_WS_INSUFFICIENT_CREDITS') {
        console.log('[COR3 Helper] Insufficient credits for expedition launch, disabling auto-send mercenary');
        // Disable auto-send temporarily due to insufficient credits
        chrome.storage.sync.get('autoSendMerc', (settings) => {
            if (settings.autoSendMerc) {
                chrome.storage.sync.set({
                    autoSendMerc: {
                        ...settings.autoSendMerc,
                        enabled: false,
                        disabledReason: 'insufficient_credits'
                    }
                });
            }
        });
        autoSendInProgress = false;
        autoSendExpeditionId = null;
    }
    // Auto-send: collected all — proceed to get mercenaries and launch
    if (event.data && event.data.type === 'COR3_WS_COLLECTED_ALL') {
        if (autoSendInProgress && autoSendExpeditionId) {
            console.log('[COR3 Helper] Auto-send: All collected, refreshing mercenaries...');
            autoSendExpeditionId = null; // done with old expedition
            // Refresh stash in background
            setTimeout(() => {
                window.postMessage({ type: 'COR3_REQUEST_STASH' }, '*');
            }, 500);
            // Now get mercenaries and launch selected one
            setTimeout(() => {
                window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
            }, 2500 + Math.floor(Math.random() * 1000));
            // Wait for mercenaries data, then launch
            autoSendAwaitingMercenaries = true;
        }
    }
    // Auto-send: mercenaries data arrived — configure and launch selected mercenary
    if (event.data && event.data.type === 'COR3_WS_MERCENARIES' && autoSendAwaitingMercenaries) {
        autoSendAwaitingMercenaries = false;
        chrome.storage.sync.get('autoSendMerc', (settings) => {
            if (!settings.autoSendMerc || !settings.autoSendMerc.enabled) {
                console.log('[COR3 Helper] Auto-send: disabled, aborting');
                autoSendInProgress = false;
                return;
            }
            let mercs = event.data.data;
            if (mercs && !Array.isArray(mercs) && mercs.mercenaries) mercs = mercs.mercenaries;
            if (!Array.isArray(mercs)) {
                console.log('[COR3 Helper] Auto-send: cannot parse mercenary list, aborting');
                autoSendInProgress = false;
                return;
            }
            let mercId = settings.autoSendMerc.mercenaryId;
            // If auto-choose mercenary is enabled, pick cheapest AVAILABLE (least risk on tie)
            if (settings.autoSendMerc.autoChooseMerc) {
                chrome.storage.local.get('mercConfigData', (cfgResult) => {
                    const configs = cfgResult.mercConfigData || {};
                    const available = mercs.filter(m => m.status === 'AVAILABLE' && configs[m.id]);
                    if (available.length > 0) {
                        available.sort((a, b) => {
                            const costA = (configs[a.id] && configs[a.id].totalCost) || Infinity;
                            const costB = (configs[b.id] && configs[b.id].totalCost) || Infinity;
                            if (costA !== costB) return costA - costB;
                            const riskA = (configs[a.id] && configs[a.id].riskScore) || 0;
                            const riskB = (configs[b.id] && configs[b.id].riskScore) || 0;
                            return riskA - riskB;
                        });
                        mercId = available[0].id;
                        console.log('[COR3 Helper] Auto-choose merc: selected', available[0].callsign, 'cost:', configs[available[0].id].totalCost);
                    }
                    proceedWithMerc(mercId, mercs, settings);
                });
                return; // async path — proceedWithMerc handles the rest
            }
            proceedWithMerc(mercId, mercs, settings);
        });

        function proceedWithMerc(mercId, mercs, settings) {
            if (!mercId) {
                console.log('[COR3 Helper] Auto-send: no mercenary selected, aborting');
                autoSendInProgress = false;
                return;
            }
            const selectedMerc = mercs.find(m => m.id === mercId);
            if (!selectedMerc || selectedMerc.status !== 'AVAILABLE') {
                console.log('[COR3 Helper] Auto-send: selected mercenary not AVAILABLE (status: ' + (selectedMerc ? selectedMerc.status : 'not found') + '), aborting');
                autoSendInProgress = false;
                return;
            }
            // Get expedition config IDs from storage and launch
            chrome.storage.local.get('expeditionConfigData', (result) => {
                const config = result.expeditionConfigData;
                if (!config || !config.locations || config.locations.length === 0) {
                    console.log('[COR3 Helper] Auto-send: no expedition config available, aborting');
                    autoSendInProgress = false;
                    return;
                }
                const loc = config.locations[0];
                const zone = loc.zones && loc.zones[0] ? loc.zones[0] : null;
                const objective = zone && zone.objectives && zone.objectives[0] ? zone.objectives[0] : null;
                if (!zone || !objective) {
                    console.log('[COR3 Helper] Auto-send: missing zone/objective config, aborting');
                    autoSendInProgress = false;
                    return;
                }
                const launchConfig = {
                    mercenaryId: mercId,
                    marketId: '019d3ea4-85bd-7389-904d-8f7c85841134',
                    locationConfigId: loc.id,
                    zoneConfigId: zone.id,
                    objectiveId: objective.id,
                    hasInsurance: false
                };
                console.log('[COR3 Helper] Auto-send: launching expedition with mercenary:', selectedMerc.callsign);
                setTimeout(() => {
                    chrome.storage.local.set({ lastExpeditionLaunchData: launchConfig });
                    window.postMessage({ type: 'COR3_LAUNCH_EXPEDITION', config: launchConfig }, '*');
                    // Refresh mercenaries after launch to update UI
                    setTimeout(() => {
                        window.postMessage({ type: 'COR3_REQUEST_EXPEDITIONS' }, '*');
                    }, 1000);
                    setTimeout(() => {
                        window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
                        autoSendInProgress = false;
                    }, 2000);
                }, 1500 + Math.floor(Math.random() * 500));
            });
        }
    }
    // Auto-send: expedition launched confirmation
    if (event.data && event.data.type === 'COR3_WS_EXPEDITION_LAUNCHED') {
        console.log('[COR3 Helper] Expedition launched successfully');
    }
    // Handle expedition launch error
    if (event.data && event.data.type === 'COR3_WS_EXPEDITION_LAUNCH_ERROR') {
        console.log('[COR3 Helper] Expedition launch error:', event.data.error);
        // Store error for UI display
        chrome.storage.local.set({
            expeditionLaunchError: {
                error: event.data.error,
                retryAfter: event.data.retryAfter,
                timestamp: Date.now()
            }
        });
        // Clear any previous successful launch message
        chrome.storage.local.remove('expeditionLaunched');
    }
    // Handle expedition launch retry
    if (event.data && event.data.type === 'COR3_WS_EXPEDITION_RETRY_LAUNCH') {
        console.log('[COR3 Helper] Retrying expedition launch');
        chrome.storage.local.get('lastExpeditionLaunchData', (result) => {
            if (result.lastExpeditionLaunchData) {
                // Retry the expedition launch with the same data
                window.postMessage({
                    type: 'COR3_RELAUNCH_EXPEDITION',
                    data: result.lastExpeditionLaunchData
                }, '*');
            }
        });
    }
    // ── Auto Jobs: WS responses ───────────────────────────────────────────────
    if (event.data && event.data.type === 'COR3_WS_JOB_ACCEPTED') {
        if (autoJobState.status !== 'accepting') {
            ajWarn(`WS_JOB_ACCEPTED ignored — state is ${autoJobState.status}, not accepting`);
            return;
        }

        bulkAcceptCount++;
        const sentJob = bulkSentOrder.shift() || null;
        const recentJobs = (event.data.data && event.data.data.recentJobs) || [];
        const takenIds = recentJobs.filter(r => r.status === 'TAKEN').map(r => r.id);
        ajLog(`WS_JOB_ACCEPTED ${bulkAcceptCount}/${bulkAcceptTotal} sent=${sentJob?.id || '—'} (${sentJob?.type || '?'}) error=${!!event.data.error} TAKEN-in-payload=[${takenIds.join(',') || 'none'}]`);

        if (event.data.error) {
            const errMsg = typeof event.data.error === 'string'
                ? event.data.error
                : (event.data.error?.message || JSON.stringify(event.data.error));
            ajErr(`accept error for "${sentJob?.name || sentJob?.id || '?'}":`, errMsg);
            pushAutoJobLog(`Accept: error for "${sentJob?.name || sentJob?.id || '?'}" — ${errMsg}`, 'error');
        } else if (sentJob && sentJob.apiJob) {
            // Resolve from the apiJob we captured at scan time, but the AVAILABLE
            // copy intentionally omits ipAddresses / logNames / logSeqs — those
            // fields appear only on the TAKEN copy in data.recentJobs[].
            // Strategy:
            //   - prefer a fresh TAKEN entry if the WS accept-response carried one
            //   - else try the scan-time apiJob (works for file_decryption, etc.)
            //   - else don't bug — just wait for the next WS_MARKET refresh; it
            //     will land the TAKEN copy in recentJobs and tryResumeInProgressJob
            //     will pick it up.
            if (autoJobsQueue.find(q => q.jobId === sentJob.id)) {
                ajLog(`  skip ${sentJob.id} — already in queue`);
            } else {
                const taken  = recentJobs.find(r => r.status === 'TAKEN' && r.id === sentJob.id);
                const source = taken || sentJob.apiJob;
                const r = resolveJobParams(sentJob.type, source);
                if (!r.ok) {
                    ajLog(`  awaiting market refresh ${sentJob.id} [${sentJob.type}] — ${r.reason} (will resume from TAKEN)`);
                    pushAutoJobLog(`Accept: "${sentJob.name || sentJob.id}" awaiting full conditions from server`, 'warn');
                } else {
                    const params = r.params;
                    autoJobsQueue.push({
                        jobId:         sentJob.id,
                        marketId:      sentJob.marketId,
                        jobType:       sentJob.type,
                        jobName:       sentJob.name || sentJob.id,
                        serverName:    params.serverName    || null,
                        fileCondition: params.fileCondition || null,
                        fileNames:     params.fileNames     || null,
                        ips:           params.ips           || null,
                        logSeqs:       params.logSeqs       || null,
                    });
                    const detail =
                        (params.serverName    ? ` server:${params.serverName}`     : '') +
                        (params.fileCondition ? ` file:${params.fileCondition}`    : '') +
                        (params.ips           ? ` ips:[${params.ips.join(',')}]`   : '') +
                        (params.logSeqs       ? ` seqs:[${params.logSeqs.join(',')}]` : '');
                    ajLog(`  queued ${sentJob.id} [${sentJob.type}]${detail} (source: ${taken ? 'WS-TAKEN' : 'scan-apiJob'})`);
                    pushAutoJobLog(`Accept: queued "${sentJob.name || sentJob.id}" [${sentJob.type}]${detail}`, 'ok');
                }
            }
        } else if (!sentJob) {
            ajWarn(`WS_JOB_ACCEPTED OK but bulkSentOrder was empty — out-of-order or stale response`);
        }

        if (bulkAcceptCount >= bulkAcceptTotal) {
            saveAutoJobsQueue();
            bulkPendingJobs    = [];
            bulkSentOrder      = [];
            bulkAcceptCount    = 0;
            bulkAcceptTotal    = 0;
            bulkAcceptStartedAt = 0;
            pushAutoJobLog(`Accept done — queue: ${autoJobsQueue.length} job(s)`, 'ok');
            ajLog(`accept batch DONE — queue depth ${autoJobsQueue.length}`);
            resetAutoJobState('accept-batch-complete');
            // Request a market refresh so TAKEN copies (with full conditions for
            // ip/log job types) land in recentJobs[] ASAP. The WS_MARKET handler
            // then runs tryResumeInProgressJob which queues anything we couldn't
            // resolve from the AVAILABLE-state copy.
            setTimeout(() => requestMarketRefresh('accept-batch-done'), 500);
            setTimeout(executeNextFromQueue, 1000);
        }
        return;
    }

    // wsSend returned false (no open socket) — that send never reached the server,
    // so no WS_JOB_ACCEPTED is coming back for it. Drop the slot now so the batch
    // can finalize on the responses we *do* get instead of waiting out the 60s
    // accept watchdog. Jobs that did reach the server still arrive as TAKEN and
    // tryResumeInProgressJob picks them up on the next market refresh.
    if (event.data && event.data.type === 'COR3_ACCEPT_JOB_SEND_FAILED') {
        if (autoJobState.status !== 'accepting') return;
        const failedId = event.data.jobId;
        const orderIdx = bulkSentOrder.findIndex(p => p.id === failedId);
        if (orderIdx !== -1) bulkSentOrder.splice(orderIdx, 1);
        // Unblock retry on the next scan — the job is still AVAILABLE on the server.
        sentAcceptIds.delete(failedId);
        if (bulkAcceptTotal > 0) bulkAcceptTotal--;
        ajWarn(`accept SEND_FAILED ${failedId} — no active socket (now ${bulkAcceptCount}/${bulkAcceptTotal})`);
        pushAutoJobLog(`Accept: send failed for ${failedId} — no socket (will retry)`, 'warn');
        if (bulkAcceptCount >= bulkAcceptTotal) {
            saveAutoJobsQueue();
            bulkPendingJobs    = [];
            bulkSentOrder      = [];
            bulkAcceptCount    = 0;
            bulkAcceptTotal    = 0;
            bulkAcceptStartedAt = 0;
            pushAutoJobLog(`Accept done — queue: ${autoJobsQueue.length} job(s)`, 'ok');
            ajLog(`accept batch DONE (with send failures) — queue depth ${autoJobsQueue.length}`);
            resetAutoJobState('accept-batch-complete');
            setTimeout(() => requestMarketRefresh('accept-batch-done'), 500);
            setTimeout(executeNextFromQueue, 1000);
        }
        return;
    }

    if (event.data && event.data.type === 'COR3_WS_JOB_COMPLETED') {
        if (autoJobState.status === 'completing') {
            if (event.data.error) {
                const errMsg = typeof event.data.error === 'string' ? event.data.error : (event.data.error?.message || JSON.stringify(event.data.error));
                ajErr(`WS_JOB_COMPLETED error for ${autoJobState.jobId}:`, errMsg);
                pushAutoJobLog('Complete failed: ' + errMsg, 'error');
            } else {
                ajLog(`WS_JOB_COMPLETED OK ${autoJobState.jobId} (${autoJobState.jobType})`);
                pushAutoJobLog('Job completed!', 'ok');
            }
            const completedJobId = autoJobState.jobId;
            // Remember completion so a stale TAKEN entry in recentJobs[] (server
            // hasn't pruned yet) doesn't cause tryResumeInProgressJob to re-queue
            // an already-solved job. TTL covers the server-prune lag (~seconds).
            if (completedJobId) completedJobIds.set(completedJobId, Date.now());
            resetAutoJobState();
            const qi = autoJobsQueue.findIndex(j => j.jobId === completedJobId);
            if (qi !== -1) { autoJobsQueue.splice(qi, 1); saveAutoJobsQueue(); }
            setTimeout(() => requestMarketRefresh('job-completed'), 2000);
            if (autoJobsQueue.length > 0) {
                setTimeout(executeNextFromQueue, 3000);
            }
        }
    }

    // ── Auto Jobs: Network Map server list (for priority UI) ────────────────
    if (event.data && event.data.type === 'COR3_NM_SERVERS' && Array.isArray(event.data.servers)) {
        chrome.storage.local.get(['networkMapServers'], r => {
            const prev = Array.isArray(r.networkMapServers) ? r.networkMapServers : [];
            // Union previous + freshly scraped, preserving every server we've ever seen.
            const merged = [...new Set([...prev, ...event.data.servers])].sort();
            const changed = merged.length !== prev.length || merged.some((s, i) => s !== prev[i]);
            if (changed) {
                chrome.storage.local.set({ networkMapServers: merged });
                ajLog(`networkMapServers updated: ${merged.length} server(s)`);
            }
        });
    }

    // ── Auto Jobs: job-manager events ────────────────────────────────────────
    if (event.data && event.data.type === 'COR3_JOB_MANAGER_READY') {
        jobManagerReady = true;
        ajLog('Job manager ready');
        chrome.storage.local.remove(['autoJobsPendingConfirm', 'autoJobsConfirmResult']);

        // Drain queue if it was populated before the manager became ready
        if (autoJobState.status === 'idle' && autoJobsQueue.length > 0) {
            setTimeout(executeNextFromQueue, 1000);
            return;
        }
        // Restore mid-solve flow after page reload
        if (autoJobState.status === 'solving' && autoJobState.jobId) {
            setTimeout(() => {
                if (!dispatchSolveFlow(autoJobState)) {
                    console.warn('[AJ] cannot restore unknown type', autoJobState.jobType);
                    resetAutoJobState();
                }
            }, 1000);
        }
        // Re-send job.complete if page reloaded mid-completion
        if (autoJobState.status === 'completing' && autoJobState.jobId) {
            setTimeout(() => {
                window.postMessage({ type: 'COR3_COMPLETE_JOB', jobId: autoJobState.jobId, marketId: autoJobState.marketId }, '*');
            }, 1000);
        }
    }

    if (event.data && event.data.type === 'COR3_JOB_MINIGAME_DONE') {
        if (autoJobState.status === 'solving' && event.data.jobId === autoJobState.jobId) {
            pushAutoJobLog('Task solved — sending complete', 'ok');
            autoJobState.status = 'completing';
            autoJobSolvingStartedAt = 0;
            autoJobCompletingStartedAt = Date.now();
            updateAutoJobStateStorage();
            setTimeout(() => {
                window.postMessage({
                    type: 'COR3_COMPLETE_JOB',
                    jobId: autoJobState.jobId,
                    marketId: autoJobState.marketId
                }, '*');
            }, 2000 + Math.floor(Math.random() * 1000));
        }
    }

    if (event.data && event.data.type === 'COR3_JOB_MINIGAME_TIMEOUT') {
        if (autoJobState.status === 'solving') {
            const timedOutJobId = autoJobState.jobId;
            ajWarn(`MINIGAME_TIMEOUT for ${timedOutJobId} (${autoJobState.jobType})`);
            if (timedOutJobId) {
                bugJob(timedOutJobId, autoJobState.jobName || autoJobState.jobType || 'Unknown', 'minigame timeout');
                pushAutoJobLog(`Timeout: "${autoJobState.jobName || autoJobState.jobType}" — bugged, skipping`, 'warn');
                const qi = autoJobsQueue.findIndex(j => j.jobId === timedOutJobId);
                if (qi !== -1) { autoJobsQueue.splice(qi, 1); saveAutoJobsQueue(); }
            }
            autoJobsCooldownUntil = Date.now() + 20000;
            autoJobSolvingStartedAt = 0;
            resetAutoJobState('minigame-timeout');
            setTimeout(() => requestMarketRefresh('minigame-timeout'), 2000);
            if (autoJobsQueue.length > 0) {
                setTimeout(executeNextFromQueue, 22000);
            }
        }
    }

    if (event.data && event.data.type === 'COR3_JOB_KD_DETECTED') {
        const { serverName, timerText } = event.data;
        if (serverName) {
            const expiry = Date.now() + parseKDTimerMs(timerText);
            kdSkipServers.set(serverName, expiry);
            ajWarn(`K/D blocklist: "${serverName}" for ${timerText || '~6h'} (until ${new Date(expiry).toISOString()})`);
            pushAutoJobLog(`Server "${serverName}" K/D (${timerText || '~6h'}) — skipped`, 'warn');
        }
    }
    if (event.data && event.data.type === 'COR3_SERVER_UNREACHABLE') {
        const { serverName, blockedByKD } = event.data;
        if (serverName) {
            // If K/D servers are blocking the path, use their timer as the skip duration
            // so we don't retry until those servers come back online.
            let skipMs = 30 * 60 * 1000; // default 30 min
            if (Array.isArray(blockedByKD) && blockedByKD.length > 0) {
                for (const { serverName: kdName, timerText } of blockedByKD) {
                    const kdMs = parseKDTimerMs(timerText);
                    kdSkipServers.set(kdName, Date.now() + kdMs);
                    console.log(`[AJ] K/D server "${kdName}" (${timerText}) blocking path to "${serverName}"`);
                    pushAutoJobLog(`K/D server "${kdName}" (${timerText || '?'}) is blocking path to "${serverName}"`, 'warn');
                    skipMs = Math.max(skipMs, kdMs);
                }
            }
            kdSkipServers.set(serverName, Date.now() + skipMs);
            console.log(`[AJ] Server "${serverName}" unreachable — skipping for ${Math.round(skipMs / 60000)} min`);
            pushAutoJobLog(`Server "${serverName}" unreachable — skip ${Math.round(skipMs / 60000)} min`, 'warn');
            if (autoJobState.status === 'solving') {
                autoJobSolvingStartedAt = 0;
                resetAutoJobState();
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Relay daily hack log messages to storage for popup to read
    if (event.data && event.data.type === 'COR3_DAILY_HACK_LOG') {
        chrome.storage.local.set({
            dailyHackLog: event.data.message,
            dailyHackLogUpdatedAt: Date.now()
        });
    }
    // Auto-fetch daily ops on page load (triggered from content-early.js)
    if (event.data && event.data.type === 'COR3_FETCH_DAILY_OPS') {
        console.log('[COR3 Helper] Requesting daily ops data');
        chrome.storage.local.get('bearerToken', (result) => {
            const token = result.bearerToken;
            if (!token) return;
            fetch('https://svc-corie.cor3.gg/api/user-daily-claim', {
                headers: { 'Authorization': token }
            })
            .then(r => {
                if (r.ok) return r.json();
                if (r.status === 400 || r.status === 401 || r.status === 403) {
                    chrome.storage.local.set({ dailyOpsError: 'token_expired', dailyOpsErrorUpdatedAt: Date.now() });
                    return null;
                }
                return null;
            })
            .then(data => {
                if (data) {
                    chrome.storage.local.set({ dailyOpsData: data, dailyOpsUpdatedAt: Date.now(), dailyOpsError: null });
                    // Also fetch rewards for streak bonus calculation
                    fetchDailyRewards(token);
                }
            })
            .catch(() => {});
        });
    }
});

// Fetch daily claim rewards for streak bonus calculation
function fetchDailyRewards(token) {
    fetch('https://svc-corie.cor3.gg/api/user-daily-claim/rewards', {
        headers: { 'Authorization': token }
    })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
        if (data && Array.isArray(data)) {
            chrome.storage.local.set({ dailyRewardsData: data });
        }
    })
    .catch(() => {});
}

// --- Auto-Send Mercenary State ---
let autoSendInProgress = false;
let autoSendExpeditionId = null;
let autoSendAwaitingMercenaries = false;

function checkAutoSendOnExpeditionData(expeditions) {
    if (!expeditions || !Array.isArray(expeditions) || autoSendInProgress) return;
    chrome.storage.sync.get('autoSendMerc', (settings) => {
        if (!settings.autoSendMerc || !settings.autoSendMerc.enabled) return;
        if (!settings.autoSendMerc.mercenaryId && !settings.autoSendMerc.autoChooseMerc) return;

        // Check for no active expeditions case
        const hasActiveExpeditions = expeditions.length > 0;
        if (!hasActiveExpeditions) {
            console.log('[COR3 Helper] Auto-send: No active expeditions, proceeding directly to mercenary launch');
            // Directly proceed to mercenary launch flow
            autoSendInProgress = true;
            autoSendExpeditionId = null;
            // Get mercenaries and launch selected one
            setTimeout(() => {
                window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
            }, 1000 + Math.floor(Math.random() * 500));
            // Wait for mercenaries data, then launch
            autoSendAwaitingMercenaries = true;
            return;
        }

        // Look for a COMPLETED expedition that hasn't been fully collected yet
        for (const exp of expeditions) {
            if (exp.status === 'COMPLETED' && !exp.completedAt) {
                autoSendInProgress = true;
                autoSendExpeditionId = exp.id;
                if (!exp.containerOpenedAt) {
                    // Container not opened yet — Step 1: open container
                    console.log('[COR3 Helper] Auto-send: Detected COMPLETED expedition:', exp.id, '- opening container');
                    setTimeout(() => {
                        window.postMessage({ type: 'COR3_OPEN_CONTAINER', expeditionId: exp.id }, '*');
                    }, 1000 + Math.floor(Math.random() * 500));
                } else {
                    // Container already opened but not collected — Step 2: collect all
                    console.log('[COR3 Helper] Auto-send: Detected COMPLETED expedition:', exp.id, '- container already open, collecting');
                    setTimeout(() => {
                        window.postMessage({ type: 'COR3_COLLECT_ALL', expeditionId: exp.id }, '*');
                    }, 1000 + Math.floor(Math.random() * 500));
                }
                return; // process one at a time
            }
        }
    });
}

// ─── Auto Jobs ────────────────────────────────────────────────────────────────

let autoJobsSettings = { enabled: false, debugMode: false, markets: { home: true, dark: true }, enabledJobTypes: {} };
// Per-server execution priority, e.g. { "RM7-S4L4": 999, "RM7-E1L5": 1 }.
// Higher = run earlier. Missing entries are treated as 0. Stored in
// chrome.storage.sync so the popup and content.js stay in sync.
let serverPriorities = {};
// States: 'idle' | 'accepting' | 'solving' | 'completing'
//   accepting — one or more COR3_ACCEPT_JOB requests sent, waiting for WS confirmations
//   solving   — exactly one job is being run by job-manager
//   completing — minigame done, COR3_COMPLETE_JOB sent, waiting for WS confirmation
// IDLE_STATE / resetAutoJobState() defined later (after updateAutoJobStateStorage).
let autoJobState = { status: 'idle', jobId: null, marketId: null, jobName: null, jobType: null, serverName: null, ips: null, fileCondition: null, fileNames: null };

// ── Accept-batch + execute queue ─────────────────────────────────────────────
// autoJobsQueue holds resolved job descriptors waiting to be solved.
// Jobs are executed one by one; queue is persisted across page reloads.
let autoJobsQueue       = [];  // [{jobId, marketId, jobType, jobName, serverName, fileCondition, ips, logSeqs}]
let bulkPendingJobs     = [];  // {id, marketId, type, name} for each in-flight COR3_ACCEPT_JOB
let bulkAcceptCount     = 0;   // WS confirmations received in current accept batch
let bulkAcceptTotal     = 0;   // total accepts sent in current accept batch
let bulkAcceptStartedAt = 0;   // timestamp for stuck-state watchdog
let bulkSentOrder       = [];  // {id,marketId,type,name} in the order COR3_ACCEPT_JOB was posted (for 1:1 error correlation)

let jobManagerInjected = false;
let jobManagerReady = false;
let autoJobsCheckIntervalId = null;
let autoJobsCooldownUntil = 0; // timestamp — don't accept new jobs until after this
let autoJobCompletingStartedAt = 0; // set when entering 'completing' state to detect stuck cases
let autoJobSolvingStartedAt   = 0; // set when entering 'solving' state to detect stuck cases

// buggedJobIds: { [jobId]: { ts: timestamp, name: jobName } } — persisted to storage
let buggedJobIds = {};
const BUGGED_JOB_TTL_MS = 2 * 3600 * 1000; // 2 hours

// Job IDs for which a COR3_ACCEPT_JOB has already been sent this market cycle.
// Cleared when fresh marketData or darkMarketData arrives from the server.
// IDs no longer present in market data are pruned on each scan. As a safety net,
// remaining entries expire after 3 minutes in case no WS update ever arrives.
const SENT_ACCEPT_TTL_MS = 3 * 60 * 1000;
const sentAcceptIds = new Map(); // jobId → timestamp

// Job IDs we've finished completing on the server. Server's recentJobs[] keeps
// them as TAKEN for some seconds before pruning, so tryResumeInProgressJob would
// otherwise re-queue (and re-attempt to solve) a job we just finished. Entries
// expire after 2 minutes — by then the server's marketData has refreshed.
const COMPLETED_JOB_TTL_MS = 2 * 60 * 1000;
const completedJobIds = new Map(); // jobId → timestamp

// Periodic market poll: __cor3RequestMarket is normally only sent on initial WS
// connect / after accept-batch / after completion. If the queue is empty and no
// jobs ever appear, we'd never re-ask the server and miss the next market timer.
// tryAcceptNextJob nudges this interval whenever it ticks idle.
const MARKET_REFRESH_INTERVAL_MS = 30 * 1000;
let lastMarketRefreshAt = 0;
function requestMarketRefresh(reason) {
    lastMarketRefreshAt = Date.now();
    ajLog(`market refresh requested [${reason || 'manual'}]`);
    window.postMessage({ type: 'COR3_REFRESH_MARKET' }, '*');
    window.postMessage({ type: 'COR3_REFRESH_DARK_MARKET' }, '*');
}

function saveBuggedJobIds() {
    if (!isContextValid()) return;
    chrome.storage.local.set({ buggedJobIds });
}

// K/D server blocklist: serverName → expiry timestamp ms
const kdSkipServers = new Map();

// Parse "5H:51M" → ms (adds 5 min buffer)
function parseKDTimerMs(timerText) {
    if (!timerText) return 6 * 3600 * 1000;
    const m = timerText.match(/(?:(\d+)H)?:?(?:(\d+)M)?/i);
    const h = parseInt((m && m[1]) || '0');
    const min = parseInt((m && m[2]) || '0');
    return (h * 60 + min + 5) * 60 * 1000;
}

try {
    chrome.storage.sync.get(['autoJobsSettings', 'serverPriorities'], data => {
        if (data.autoJobsSettings) autoJobsSettings = data.autoJobsSettings;
        if (data.serverPriorities && typeof data.serverPriorities === 'object') {
            serverPriorities = data.serverPriorities;
        }
        // Restore persisted job state so we don't lose progress on page reload.
        // startAutoJobsMonitor is called INSIDE the inner callback so that autoJobState
        // is fully restored before tryResumeInProgressJob runs.
        chrome.storage.local.get(['autoJobsState', 'buggedJobIds', 'autoJobsQueue'], ls => {
            if (ls.autoJobsState && ls.autoJobsState.status !== 'idle') {
                const age = Date.now() - (ls.autoJobsState.updatedAt || 0);
                // Discard mid-batch 'accepting' state on reload — the in-flight WS responses
                // are gone and the queue will be repopulated on the next market refresh tick.
                if (ls.autoJobsState.status === 'accepting') {
                    console.log('[AJ] discarding stale accepting state on reload');
                    chrome.storage.local.set({ autoJobsState: { status: 'idle', updatedAt: Date.now() } });
                } else if (age < 5 * 60 * 1000) {
                    autoJobState = ls.autoJobsState;
                    console.log('[AJ] restored state from storage:', autoJobState.status, autoJobState.jobId);
                } else {
                    console.log('[AJ] stale state discarded (age:', Math.round(age / 1000), 's)');
                    chrome.storage.local.set({ autoJobsState: { status: 'idle', updatedAt: Date.now() } });
                }
            }
            if (ls.buggedJobIds) {
                const now = Date.now();
                buggedJobIds = {};
                for (const [id, entry] of Object.entries(ls.buggedJobIds)) {
                    if (now - (entry.ts || entry) < BUGGED_JOB_TTL_MS) buggedJobIds[id] = entry;
                }
                if (Object.keys(buggedJobIds).length > 0) {
                    console.log('[AJ] loaded', Object.keys(buggedJobIds).length, 'bugged job(s) from storage');
                }
            }
            // Restore pre-accepted job queue, filtering out any jobs that later got bugged
            if (ls.autoJobsQueue && Array.isArray(ls.autoJobsQueue)) {
                autoJobsQueue = ls.autoJobsQueue.filter(j => !buggedJobIds[j.jobId]);
                if (autoJobsQueue.length > 0) {
                    console.log('[AJ] restored', autoJobsQueue.length, 'queued job(s) from storage');
                }
            }
            if (autoJobsSettings.enabled) startAutoJobsMonitor();
        });
    });
    // Live-update serverPriorities when the popup edits them, so the next
    // executeNextFromQueue uses the new values without needing a page reload.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.serverPriorities && changes.serverPriorities.newValue) {
            serverPriorities = changes.serverPriorities.newValue;
        }
    });
} catch (e) {}

// ─── Debug logging ───────────────────────────────────────────────────────────
// All auto-jobs logs use the [AJ] prefix so the user can filter F12 console
// output by typing "[AJ]" in the console filter box. Errors and warnings use
// console.error / console.warn so they surface in red/yellow.

const AJ_PREFIX = '[AJ]';
function ajLog(...args)  { console.log  (AJ_PREFIX, ...args); }
function ajWarn(...args) { console.warn (AJ_PREFIX, ...args); }
function ajErr(...args)  { console.error(AJ_PREFIX, ...args); }

// Compact one-line state snapshot for inline log lines.
function ajStateSnapshot() {
    return `{status=${autoJobState.status} jobId=${autoJobState.jobId || '—'} type=${autoJobState.jobType || '—'} queue=${autoJobsQueue?.length ?? '?'}}`;
}

// Single source of truth for the "idle" shape.
// All transitions back to idle should call resetAutoJobState() instead of duplicating this literal.
const IDLE_STATE = Object.freeze({
    status: 'idle', jobId: null, marketId: null, jobName: null,
    jobType: null, serverName: null, ips: null, fileCondition: null,
    fileNames: null, logSeqs: null, conditions: null, relatedServers: null,
});

function resetAutoJobState(reason) {
    const wasStatus = autoJobState.status;
    const wasJobId  = autoJobState.jobId;
    autoJobState = { ...IDLE_STATE };
    updateAutoJobStateStorage();
    if (wasStatus !== 'idle') {
        ajLog(`state: ${wasStatus}(${wasJobId || '—'}) → idle${reason ? ` [${reason}]` : ''}`);
    }
}

// Log a state transition into a non-idle state. Call AFTER mutating autoJobState.
function ajLogTransition(fromStatus, fromJobId, reason) {
    ajLog(`state: ${fromStatus}(${fromJobId || '—'}) → ${ajStateSnapshot()}${reason ? ` [${reason}]` : ''}`);
}

// Mark a job as bugged with a clear log line (so the user always sees WHY).
function bugJob(jobId, name, reason) {
    if (!jobId) return;
    buggedJobIds[jobId] = { ts: Date.now(), name: name || 'Unknown' };
    saveBuggedJobIds();
    ajWarn(`bugged: ${jobId} "${name || '?'}" — ${reason}`);
}

// ─── F12 debug snapshot ──────────────────────────────────────────────────────
// Type `__cor3Dump()` in the Console to get a full state snapshot. The actual
// snapshot lives in the isolated content-script world, so we listen for a
// postMessage from MAIN and dump via console.* (which is shared between worlds
// via DevTools). Result: snapshot lines appear in the page console regardless
// of which JS context the user is in.
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'COR3_REQ_DUMP') return;
    const cooldownLeft = autoJobsCooldownUntil > Date.now() ? Math.round((autoJobsCooldownUntil - Date.now()) / 1000) + 's' : 'none';
    console.group(`${AJ_PREFIX} === STATE DUMP @ ${new Date().toISOString()} ===`);
    console.log('autoJobState:', JSON.parse(JSON.stringify(autoJobState)));
    console.log('autoJobsQueue:', JSON.parse(JSON.stringify(autoJobsQueue)));
    console.log('bulkPendingJobs:', JSON.parse(JSON.stringify(bulkPendingJobs)));
    console.log('bulkSentOrder:', JSON.parse(JSON.stringify(bulkSentOrder)));
    console.log(`bulkAcceptCount/Total: ${bulkAcceptCount}/${bulkAcceptTotal}`);
    console.log('autoJobsSettings:', JSON.parse(JSON.stringify(autoJobsSettings)));
    console.log('buggedJobIds:', JSON.parse(JSON.stringify(buggedJobIds)));
    console.log('kdSkipServers:', [...kdSkipServers.entries()].map(([k, v]) => `${k} until ${new Date(v).toISOString()}`));
    console.log('sentAcceptIds:', [...sentAcceptIds.entries()].map(([k, v]) => `${k} ${Math.round((Date.now()-v)/1000)}s ago`));
    console.log('cooldown remaining:', cooldownLeft);
    console.log('jobManagerInjected/Ready:', jobManagerInjected, '/', jobManagerReady);
    console.groupEnd();
});

function updateAutoJobStateStorage() {
    if (!isContextValid()) return;
    chrome.storage.local.set({ autoJobsState: { ...autoJobState, updatedAt: Date.now() } });
}

function buildDebugInfo() {
    return {
        jobId:              autoJobState.jobId,
        jobType:            autoJobState.jobType,
        jobName:            autoJobState.jobName,
        marketId:           autoJobState.marketId,
        resolvedServer:     autoJobState.serverName,
        resolvedFile:       autoJobState.fileCondition,
        resolvedLogSeqs:    autoJobState.logSeqs  || null,
        resolvedIPs:        autoJobState.ips       || null,
        apiConditions:      autoJobState.conditions     ? JSON.stringify(autoJobState.conditions)     : null,
        apiRelatedServers:  autoJobState.relatedServers ? JSON.stringify(autoJobState.relatedServers) : null,
    };
}

// Pause flow and wait for user to approve/reject in popup (max timeoutMs).
// Returns true if approved, false if rejected or timed out.
async function waitForUserConfirmation(confirmData, timeoutMs = 300_000) {
    if (!isContextValid()) return false;
    const ts = Date.now();
    await new Promise(r => chrome.storage.local.set({
        autoJobsPendingConfirm: { ...confirmData, ts },
        autoJobsConfirmResult:  null
    }, r));
    return new Promise(resolve => {
        const deadline = ts + timeoutMs;
        function check() {
            if (!isContextValid()) { resolve(false); return; }
            chrome.storage.local.get('autoJobsConfirmResult', r => {
                const cfr = r.autoJobsConfirmResult;
                if (cfr && cfr.requestTs === ts) {
                    chrome.storage.local.remove(['autoJobsPendingConfirm', 'autoJobsConfirmResult']);
                    resolve(cfr.approved === true);
                } else if (Date.now() >= deadline) {
                    chrome.storage.local.remove('autoJobsPendingConfirm');
                    resolve(false);
                } else {
                    setTimeout(check, 500);
                }
            });
        }
        check();
    });
}

function pushAutoJobLog(msg, level = 'info') {
    if (!isContextValid()) return;
    const entry = { ts: Date.now(), msg, level };
    chrome.storage.local.get('autoJobsLog', result => {
        const log = result.autoJobsLog || [];
        log.push(entry);
        if (log.length > 100) log.splice(0, log.length - 100);
        chrome.storage.local.set({ autoJobsLog: log });
    });
}

function injectJobManager() {
    if (jobManagerInjected) return;
    jobManagerInjected = true;
    // Also ensure decrypt solver is running (needed to solve the minigame)
    injectDecryptSolver();
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('job-manager.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

// ─── API extractors ──────────────────────────────────────────────────────────
// Single source of truth for pulling fields out of the WS API job payload.
// resolveJobParams() below assembles a per-type result; nothing else should
// "fall back" to DOM scraping for these values.

function extractServerFromJob(job) {
    if (!job) return null;
    const rs = job.relatedServers;
    if (!rs) return null;
    if (typeof rs === 'string') return rs || null;
    if (Array.isArray(rs) && rs.length > 0) {
        const first = rs[0];
        if (typeof first === 'string') return first || null;
        if (first && typeof first === 'object') return first.name || first.serverName || first.server || null;
    }
    return null;
}

function extractLogSeqsFromJob(job) {
    if (!job) return null;
    const items = job.conditions && job.conditions.items;
    if (!Array.isArray(items)) return null;
    for (const item of items) {
        const d = item.details;
        if (d && Array.isArray(d.logSeqs) && d.logSeqs.length > 0) return d.logSeqs.slice();
    }
    return null;
}

function extractIPsFromJob(job) {
    if (!job) return [];

    function collectFromObj(d, out) {
        if (!d) return;
        if (Array.isArray(d.ipAddresses))                          out.push(...d.ipAddresses);
        else if (Array.isArray(d.ips))                             out.push(...d.ips);
        else if (typeof d.ipAddress === 'string' && d.ipAddress)   out.push(d.ipAddress);
        else if (typeof d.ip        === 'string' && d.ip)          out.push(d.ip);
    }

    const ips = [];

    // Check items[].details
    const items = job.conditions && job.conditions.items;
    if (Array.isArray(items)) {
        for (const item of items) collectFromObj(item.details, ips);
    }

    // Check root conditions level
    if (ips.length === 0) collectFromObj(job.conditions, ips);

    return ips.filter(ip => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip));
}

// ─── Type-specific resolver ──────────────────────────────────────────────────
// resolveJobParams is the SOLE place where API job data is interpreted into
// solver parameters. It rejects (returns ok:false) if the conditions for the
// requested type are absent or malformed — there is intentionally no DOM
// fallback. A job that cannot be resolved is bugged-out, not guessed at.

function resolveJobParams(type, apiJob) {
    const result = _resolveJobParamsInner(type, apiJob);
    if (result.ok) {
        ajLog(`resolve[${type}] OK ${apiJob?.id || '?'}:`, result.params);
    } else {
        // FAIL log dumps the full payload so you can paste it into a chat and
        // we can see exactly what the server returned.
        ajWarn(`resolve[${type}] FAIL ${apiJob?.id || '?'} (${apiJob?.name || '?'}) — ${result.reason}`);
        ajWarn(`  conditions:`, apiJob?.conditions ? JSON.parse(JSON.stringify(apiJob.conditions)) : null);
        ajWarn(`  relatedServers:`, apiJob?.relatedServers ? JSON.parse(JSON.stringify(apiJob.relatedServers)) : null);
    }
    return result;
}

function _resolveJobParamsInner(type, apiJob) {
    if (!apiJob) return { ok: false, reason: 'no apiJob' };
    const items = (apiJob.conditions && apiJob.conditions.items) || [];

    function pickDetail(predicate) {
        for (const item of items) {
            const d = item && item.details;
            if (!d) continue;
            const v = predicate(d);
            if (v != null && v !== '') return v;
        }
        return null;
    }

    const server = extractServerFromJob(apiJob);

    switch (type) {
        case 'file_decryption': {
            // FD always specifies an extension; sometimes also a concrete filename.
            const fileName = pickDetail(d => d.fileNames?.[0] || d.fileName || d.files?.[0]?.name);
            const fileExt  = pickDetail(d => d.extensions?.[0]?.ext);
            const fileCondition = fileName || fileExt;
            if (!fileCondition) return { ok: false, reason: 'no fileName/extension in conditions' };
            return { ok: true, params: { fileCondition } };
        }
        case 'data_upload':
        case 'file_elimination':
        case 'decrypt_extract': {
            if (!server) return { ok: false, reason: 'no server in relatedServers' };
            const fileName = pickDetail(d => d.fileNames?.[0] || d.fileName || d.files?.[0]?.name);
            if (!fileName) return { ok: false, reason: 'no fileName in conditions' };
            return { ok: true, params: { serverName: server, fileCondition: fileName } };
        }
        case 'data_download': {
            // Data Download conditions can list multiple files (e.g. backup_3125.dat
            // and backup_3125.eb52x). Collect every filename across all condition
            // items so the solver can download each one.
            if (!server) return { ok: false, reason: 'no server in relatedServers' };
            const names = [];
            for (const item of items) {
                const d = item && item.details;
                if (!d) continue;
                if (Array.isArray(d.fileNames)) for (const n of d.fileNames) if (n) names.push(n);
                if (typeof d.fileName === 'string' && d.fileName) names.push(d.fileName);
                if (Array.isArray(d.files)) for (const f of d.files) if (f?.name) names.push(f.name);
            }
            const fileNames = [...new Set(names)];
            if (fileNames.length === 0) return { ok: false, reason: 'no fileName in conditions' };
            return { ok: true, params: { serverName: server, fileCondition: fileNames[0], fileNames } };
        }
        case 'ip_injection':
        case 'ip_cleanup': {
            if (!server) return { ok: false, reason: 'no server in relatedServers' };
            const ips = extractIPsFromJob(apiJob);
            if (!ips.length) return { ok: false, reason: 'no ipAddresses in conditions' };
            return { ok: true, params: { serverName: server, ips } };
        }
        case 'log_deletion':
        case 'log_download': {
            if (!server) return { ok: false, reason: 'no server in relatedServers' };
            const logName = pickDetail(d => d.logNames?.[0] || d.logName);
            const logSeqs = extractLogSeqsFromJob(apiJob);
            if (!logName && !(logSeqs && logSeqs.length)) {
                return { ok: false, reason: 'no logName/logSeqs in conditions' };
            }
            return { ok: true, params: { serverName: server, fileCondition: logName || null, logSeqs: logSeqs || null } };
        }
    }
    return { ok: false, reason: `unknown job type "${type}"` };
}

// ─── Solve-flow dispatch ─────────────────────────────────────────────────────
// Single dispatch table — used by executeNextFromQueue, JOB_MANAGER_READY
// restoration, and any other place that needs to start a solver. Adding a new
// job type means adding one entry here and one case to resolveJobParams.

const FLOW_DISPATCH = {
    file_decryption:  (j) => ({ type: 'COR3_START_JOB_FLOW',              jobId: j.jobId, marketId: j.marketId, fileCondition: j.fileCondition }),
    ip_injection:     (j) => ({ type: 'COR3_START_IP_JOB_FLOW',           jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, ips: j.ips || [] }),
    ip_cleanup:       (j) => ({ type: 'COR3_START_IP_CLEANUP_FLOW',       jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, ips: j.ips || [] }),
    data_upload:      (j) => ({ type: 'COR3_START_UPLOAD_JOB_FLOW',       jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
    log_deletion:     (j) => ({ type: 'COR3_START_LOG_DELETION_FLOW',     jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition, logSeqs: j.logSeqs }),
    log_download:     (j) => ({ type: 'COR3_START_LOG_DOWNLOAD_FLOW',     jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition, logSeqs: j.logSeqs }),
    file_elimination: (j) => ({ type: 'COR3_START_FILE_ELIMINATION_FLOW', jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
    data_download:    (j) => ({ type: 'COR3_START_DATA_DOWNLOAD_FLOW',    jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileNames: (Array.isArray(j.fileNames) && j.fileNames.length) ? j.fileNames : (j.fileCondition ? [j.fileCondition] : []) }),
    decrypt_extract:  (j) => ({ type: 'COR3_START_DECRYPT_EXTRACT_FLOW',  jobId: j.jobId, marketId: j.marketId, serverName: j.serverName, fileCondition: j.fileCondition }),
};

function dispatchSolveFlow(job) {
    const builder = FLOW_DISPATCH[job.jobType];
    if (!builder) {
        ajErr(`dispatchSolveFlow: unknown type "${job.jobType}"`);
        pushAutoJobLog(`Unknown job type "${job.jobType}" — cannot dispatch`, 'warn');
        return false;
    }
    const payload = builder(job);
    ajLog(`dispatch → ${payload.type}`, payload);
    window.postMessage(payload, '*');
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────

const JOB_TYPE_KEYWORDS = {
    file_decryption:  ['file decryption',  'file_decryption'],
    ip_cleanup:       ['ip cleanup',        'ip_cleanup'],
    ip_injection:     ['ip injection',      'ip_injection'],
    log_deletion:     ['log deletion',      'log_deletion'],
    log_download:     ['log download',      'log_download'],
    file_elimination: ['file elimination',  'file_elimination'],
    data_download:    ['data download',     'data_download'],
    data_upload:      ['data upload',       'data_upload'],
    decrypt_extract:  ['decrypt & extract', 'decrypt and extract', 'decrypt_extract'],
};

function detectJobType(job) {
    if (!job || job.isCompleted || job.isExpired) return null;
    const name = (job.name || job.category || '').toLowerCase();
    for (const [type, keywords] of Object.entries(JOB_TYPE_KEYWORDS)) {
        if (keywords.some(kw => name.includes(kw))) return type;
    }
    if (name) ajLog(`detectJobType: unknown name "${job.name || job.category}" — ignoring`);
    return null;
}

function findNextAutoJob(callback) {
    if (!isContextValid()) { callback(null); return; }
    chrome.storage.local.get(['marketData', 'darkMarketData', 'darkMarketAvailable'], result => {
        const candidates = [];
        const dropped = []; // {id, name, type, reason} — for end-of-scan summary log

        function scanMarket(jobs, mid, source) {
            for (const job of jobs) {
                const type = detectJobType(job);
                if (!type) continue;
                const tag = `${source}/${type}/${job.name || job.id}`;
                if (autoJobsSettings.enabledJobTypes && autoJobsSettings.enabledJobTypes[type] === false) {
                    dropped.push({ tag, reason: 'jobType-disabled' });
                    continue;
                }
                const sentTs = sentAcceptIds.get(job.id);
                if (sentTs && Date.now() - sentTs < SENT_ACCEPT_TTL_MS) {
                    dropped.push({ tag, reason: `sent-recently (${Math.round((Date.now()-sentTs)/1000)}s ago)` });
                    continue;
                }
                if (buggedJobIds[job.id]) {
                    const entry = buggedJobIds[job.id];
                    if (Date.now() - (entry.ts || entry) < BUGGED_JOB_TTL_MS) {
                        dropped.push({ tag, reason: 'bugged' });
                        continue;
                    }
                    delete buggedJobIds[job.id]; // expired — remove silently
                }
                // Pre-accept K/D check for server-requiring job types.
                // Server name comes from API (relatedServers), never from DOM.
                if (['ip_injection', 'ip_cleanup', 'data_upload', 'log_deletion', 'log_download', 'file_elimination', 'data_download', 'decrypt_extract'].includes(type)) {
                    const srvName = extractServerFromJob(job);
                    if (srvName) {
                        const kdExpiry = kdSkipServers.get(srvName);
                        if (kdExpiry) {
                            if (Date.now() < kdExpiry) {
                                dropped.push({ tag, reason: `K/D blocklist "${srvName}" until ${new Date(kdExpiry).toISOString()}` });
                                continue;
                            }
                            kdSkipServers.delete(srvName);
                        }
                        // Live DOM check — catches K/D on first encounter before accepting
                        const serverItem = [...document.querySelectorAll('[data-sentry-component="ServerItem"]')]
                            .find(el => {
                                const nameEl = el.querySelector('[data-sentry-element="ServerItemNameStyled"] span');
                                return nameEl && nameEl.textContent.trim() === srvName;
                            });
                        if (serverItem) {
                            const timer = serverItem.querySelector('[data-sentry-component="MaintenanceTimer"]');
                            if (timer && timer.querySelector('[data-sentry-component="TimerIcon"]')) {
                                const timerText = timer.textContent.trim();
                                kdSkipServers.set(srvName, Date.now() + parseKDTimerMs(timerText));
                                dropped.push({ tag, reason: `DOM K/D "${srvName}" ${timerText}` });
                                continue;
                            }
                        }
                    }
                }
                candidates.push({ ...job, marketId: mid, source, type });
            }
        }

        const homeJobsArr  = result.marketData?.jobs;
        const darkJobsArr  = result.darkMarketData?.jobs;

        // Prune sentAcceptIds: remove IDs no longer present in any market data.
        // Those jobs left the market (accepted/expired), so unblocking them is safe.
        if (sentAcceptIds.size > 0) {
            const currentIds = new Set([
                ...(homeJobsArr?.map(j => j.id) || []),
                ...(darkJobsArr?.map(j => j.id) || []),
            ]);
            for (const id of sentAcceptIds.keys()) {
                if (!currentIds.has(id)) sentAcceptIds.delete(id);
            }
        }

        ajLog(`scan: home.jobs=${homeJobsArr?.length??'—'} dark.jobs=${darkJobsArr?.length??'—'} darkAvail=${result.darkMarketAvailable}`);

        if (autoJobsSettings.markets.home && result.marketData && result.marketData.jobs) {
            const mid = result.marketData.market && result.marketData.market.id;
            if (mid) scanMarket(result.marketData.jobs, mid, 'home');
        }
        if (autoJobsSettings.markets.dark &&
            result.darkMarketAvailable !== false &&
            result.darkMarketData && result.darkMarketData.jobs) {
            const mid = result.darkMarketData.market && result.darkMarketData.market.id;
            if (mid) scanMarket(result.darkMarketData.jobs, mid, 'dark');
        }

        if (dropped.length) {
            ajLog(`scan: dropped ${dropped.length} —`, dropped.map(d => `${d.tag}: ${d.reason}`).join(' | '));
        }
        ajLog(`scan: ${candidates.length} candidate(s) →`, candidates.map(c => `${c.source}/${c.type}:${c.id}`).join(', ') || 'none');
        callback(candidates);
    });
}

function tryAcceptNextJob() {
    if (!autoJobsSettings.enabled) return;
    if (!isContextValid()) return;
    if (Date.now() < autoJobsCooldownUntil) {
        const rem = Math.ceil((autoJobsCooldownUntil - Date.now()) / 1000);
        ajLog(`tick: skip — cooldown ${rem}s left`);
        return;
    }

    // If queue has pre-accepted jobs, drain the queue (non-debug only — debug uses manual trigger)
    if (!autoJobsSettings.debugMode && autoJobsQueue.length > 0 && autoJobState.status === 'idle') {
        ajLog(`tick: draining queue (${autoJobsQueue.length} job(s))`);
        executeNextFromQueue();
        return;
    }

    if (autoJobsSettings.debugMode) return;
    if (autoJobState.status !== 'idle') return;

    // The cached marketData only updates when the server pushes (after our
    // get.options or after the in-game UI triggers a connect). With nothing
    // to do, no refresh is otherwise sent, so we'd never see the next market
    // timer fire. Nudge a refresh every MARKET_REFRESH_INTERVAL_MS.
    if (Date.now() - lastMarketRefreshAt > MARKET_REFRESH_INTERVAL_MS) {
        requestMarketRefresh('idle-poll');
    }

    ajLog(`tick: scanning markets ${ajStateSnapshot()}`);
    findNextAutoJob(candidates => {
        if (!candidates || candidates.length === 0) return;
        acceptCandidatesBatch(candidates);
    });
}

// ─── Queue persistence ───────────────────────────────────────────────────────

function saveAutoJobsQueue() {
    if (!isContextValid()) return;
    chrome.storage.local.set({ autoJobsQueue });
}

// ─── Phase: ACCEPT ───────────────────────────────────────────────────────────
// Send COR3_ACCEPT_JOB for each candidate (with stagger), then wait for the
// matching COR3_WS_JOB_ACCEPTED responses. The WS handler is responsible for
// running resolveJobParams against the WS recentJobs payload and pushing
// fully-resolved entries onto autoJobsQueue.
//
// No DOM is touched here. If the WS payload lacks the conditions needed to
// resolve a job, that job is bugged-out — we never guess from description text.

function acceptCandidatesBatch(candidates) {
    if (autoJobState.status !== 'idle') {
        ajWarn(`acceptCandidatesBatch: skip — status is ${autoJobState.status}, not idle`);
        return;
    }
    if (!candidates || candidates.length === 0) return;

    const fromStatus = autoJobState.status, fromJobId = autoJobState.jobId;
    autoJobState = {
        ...IDLE_STATE,
        status:  'accepting',
        jobName: `Accepting ${candidates.length} job(s)`,
    };
    updateAutoJobStateStorage();
    ajLogTransition(fromStatus, fromJobId, `accept-batch n=${candidates.length}`);

    injectJobManager();
    pushAutoJobLog(`Accept: sending ${candidates.length} request(s)…`);

    // Carry the full apiJob (conditions[], relatedServers[]) so resolveJobParams
    // has its canonical source after accept — independent of whatever the WS
    // accept-response payload happens to include.
    bulkPendingJobs = candidates.map(c => ({
        id: c.id, marketId: c.marketId, type: c.type, name: c.name || c.id,
        apiJob: c,
    }));
    bulkSentOrder      = [];
    bulkAcceptCount    = 0;
    bulkAcceptTotal    = bulkPendingJobs.length;
    bulkAcceptStartedAt = Date.now();

    for (let i = 0; i < bulkPendingJobs.length; i++) {
        const pending = bulkPendingJobs[i];
        const delay = i * 1200 + 800 + Math.floor(Math.random() * 300);
        sentAcceptIds.set(pending.id, Date.now());
        ajLog(`accept[${i+1}/${bulkPendingJobs.length}] schedule ${pending.id} (${pending.type}) in ${delay}ms`);
        setTimeout(() => {
            bulkSentOrder.push(pending);
            ajLog(`accept[${i+1}/${bulkPendingJobs.length}] SEND ${pending.id} (${pending.type})`);
            window.postMessage({ type: 'COR3_ACCEPT_JOB', jobId: pending.id, marketId: pending.marketId }, '*');
        }, delay);
    }
}

// ─── Phase: EXECUTE ──────────────────────────────────────────────────────────
// Pop the first job from autoJobsQueue, transition to 'solving', and dispatch
// the matching START_*_FLOW message to job-manager. In debug mode, pause for
// user confirmation before dispatching.

const FILE_BASED_TYPES = new Set(['data_upload', 'file_decryption', 'log_deletion', 'log_download', 'file_elimination', 'data_download', 'decrypt_extract']);

// Higher number = picked first. file_decryption has no server target (just open
// a downloaded file + minigame) so it's the cheapest/safest job in the queue —
// always pick it before anything that touches a server.
const NO_SERVER_PRIORITY = Number.POSITIVE_INFINITY;
function jobPriority(job) {
    if (!job.serverName || job.jobType === 'file_decryption') return NO_SERVER_PRIORITY;
    const p = serverPriorities[job.serverName];
    return Number.isFinite(p) ? p : 0;
}
function sortQueueByPriority() {
    // Stable sort: jobs with equal priority keep their original (FIFO) order.
    autoJobsQueue.sort((a, b) => jobPriority(b) - jobPriority(a));
}

async function executeNextFromQueue() {
    if (autoJobsQueue.length === 0) {
        if (autoJobState.status !== 'idle') resetAutoJobState('queue-empty');
        return;
    }
    if (autoJobState.status !== 'idle') {
        ajLog(`executeNextFromQueue: skip — status is ${autoJobState.status}`);
        return;
    }

    sortQueueByPriority();
    const job = autoJobsQueue[0];
    if (!FLOW_DISPATCH[job.jobType]) {
        ajWarn(`queue: unknown type "${job.jobType}" — dropping ${job.jobId}`);
        pushAutoJobLog(`Queue: unknown type "${job.jobType}" — skipping`, 'warn');
        autoJobsQueue.shift();
        saveAutoJobsQueue();
        setTimeout(executeNextFromQueue, 500);
        return;
    }

    pushAutoJobLog(`Queue (${autoJobsQueue.length} left): "${job.jobName}" [${job.jobType}]`);
    injectJobManager();

    const fromStatus = autoJobState.status, fromJobId = autoJobState.jobId;
    autoJobState = {
        ...IDLE_STATE,
        status:        'solving',
        jobId:         job.jobId,
        marketId:      job.marketId,
        jobName:       job.jobName,
        jobType:       job.jobType,
        serverName:    job.serverName    || null,
        ips:           job.ips           || null,
        fileCondition: job.fileCondition || null,
        fileNames:     job.fileNames     || null,
        logSeqs:       job.logSeqs       || null,
    };
    autoJobSolvingStartedAt = Date.now();
    updateAutoJobStateStorage();
    ajLogTransition(fromStatus, fromJobId, `pop queue, solve "${job.jobName}"`);

    pushAutoJobLog(`━━━ ${job.jobName || job.jobType} [${job.jobType}] ━━━`, 'separator');

    // Debug confirmation gate — only file-based jobs ever asked for it before;
    // preserved here so the popup confirm UI keeps working in debugMode.
    if (autoJobsSettings.debugMode && FILE_BASED_TYPES.has(job.jobType)) {
        pushAutoJobLog('Debug: waiting for confirmation in popup (5 min)…', 'warn');
        const confirmed = await waitForUserConfirmation({
            jobType:       job.jobType,
            jobName:       job.jobName,
            serverName:    job.serverName,
            fileCondition: job.fileCondition,
            logSeqs:       job.logSeqs || null,
            ips:           job.ips     || null,
            debugInfo:     buildDebugInfo(),
        });
        if (!confirmed) {
            pushAutoJobLog('Debug: rejected/timeout — dropping job (60s cooldown)', 'warn');
            autoJobsQueue.shift();
            saveAutoJobsQueue();
            autoJobsCooldownUntil = Date.now() + 60_000;
            resetAutoJobState();
            return;
        }
        pushAutoJobLog('Debug: confirmed — starting flow', 'ok');
    }

    setTimeout(() => dispatchSolveFlow(job), 500);
}

// ─────────────────────────────────────────────────────────────────────────────

function tryResumeInProgressJob() {
    console.log(`[AJ] tryResumeInProgressJob: status=${autoJobState.status} queue=${autoJobsQueue.length}`);
    if (autoJobState.status !== 'idle') { console.log('[AJ] tryResumeInProgressJob: skip — status is', autoJobState.status); return; }

    // Prune expired completedJobIds so the dedup set doesn't grow forever.
    const nowTs = Date.now();
    for (const [id, ts] of completedJobIds) {
        if (nowTs - ts > COMPLETED_JOB_TTL_MS) completedJobIds.delete(id);
    }

    chrome.storage.local.get(['marketData', 'darkMarketData', 'darkMarketAvailable'], result => {
        function collectTaken(data, mid, out) {
            if (!data || !mid) return;
            for (const job of (data.recentJobs || [])) {
                if (job.status !== 'TAKEN') continue;
                const type = detectJobType(job);
                if (!type) continue;
                if (autoJobsSettings.enabledJobTypes && autoJobsSettings.enabledJobTypes[type] === false) continue;
                if (buggedJobIds[job.id]) continue;
                out.push({ ...job, marketId: mid, type });
            }
        }

        const takenJobs = [];
        if (autoJobsSettings.markets.home && result.marketData?.market?.id) {
            collectTaken(result.marketData, result.marketData.market.id, takenJobs);
        }
        if (autoJobsSettings.markets.dark && result.darkMarketAvailable !== false && result.darkMarketData?.market?.id) {
            collectTaken(result.darkMarketData, result.darkMarketData.market.id, takenJobs);
        }
        console.log('[AJ] tryResumeInProgressJob: found', takenJobs.length, 'TAKEN job(s)');

        let added = 0;
        for (const job of takenJobs) {
            if (autoJobsQueue.find(q => q.jobId === job.id)) continue;
            if (autoJobState.jobId === job.id) continue;
            if (completedJobIds.has(job.id)) {
                ajLog(`resume: skip ${job.id} — completed ${Math.round((nowTs - completedJobIds.get(job.id))/1000)}s ago, server hasn't pruned yet`);
                continue;
            }

            const r = resolveJobParams(job.type, job);
            if (!r.ok) {
                // Don't bug here — this runs on every market refresh, so a transient
                // missing-conditions state would permanently shadow the job. If the
                // TAKEN copy genuinely never populates, the solving watchdog will
                // catch it once it reaches that state.
                ajLog(`resume: skip ${job.id} [${job.type}] — ${r.reason} (will retry next refresh)`);
                continue;
            }
            autoJobsQueue.push({
                jobId:         job.id,
                marketId:      job.marketId,
                jobType:       job.type,
                jobName:       job.name || job.category || job.id,
                serverName:    r.params.serverName    || null,
                fileCondition: r.params.fileCondition || null,
                fileNames:     r.params.fileNames     || null,
                ips:           r.params.ips           || null,
                logSeqs:       r.params.logSeqs       || null,
            });
            pushAutoJobLog(`Resume queue: "${job.name || job.id}" [${job.type}]`, 'warn');
            added++;
        }

        if (added > 0) {
            saveAutoJobsQueue();
            injectJobManager();
            // Job manager may not be ready yet — COR3_JOB_MANAGER_READY will also call executeNextFromQueue
            if (jobManagerReady) setTimeout(executeNextFromQueue, 2000);
        }
    });
}

function startAutoJobsMonitor() {
    if (autoJobsCheckIntervalId) return;
    injectJobManager();
    tryResumeInProgressJob();
    autoJobsCheckIntervalId = setInterval(() => {
        if (!isContextValid()) { clearInterval(autoJobsCheckIntervalId); autoJobsCheckIntervalId = null; return; }
        if (!autoJobsSettings.enabled) return;
        // Watchdog: if autoSendInProgress stuck for >120s without finishing — reset
        if (autoSendInProgress && autoSendStartedAt > 0 && Date.now() - autoSendStartedAt > 120000) {
            console.warn('[COR3 Helper] Auto-send: Stuck for >120s — resetting');
            autoSendInProgress = false;
            autoSendExpeditionId = null;
            autoSendAwaitingMercenaries = false;
            autoSendStartedAt = 0;
        }
        // Watchdog: stuck in 'accepting' for >60s — assume the WS responses were lost
        if (autoJobState.status === 'accepting' && bulkAcceptStartedAt > 0 && Date.now() - bulkAcceptStartedAt > 60000) {
            console.warn('[AJ] Stuck in accepting for >60s — resetting');
            pushAutoJobLog('Accept watchdog: timeout — reset to idle', 'warn');
            saveAutoJobsQueue();
            bulkPendingJobs    = [];
            bulkSentOrder      = [];
            bulkAcceptCount    = 0;
            bulkAcceptTotal    = 0;
            bulkAcceptStartedAt = 0;
            resetAutoJobState();
            if (autoJobsQueue.length > 0) setTimeout(executeNextFromQueue, 1000);
            return;
        }
        // Watchdog: stuck in 'solving' for >3min — mark job as bugged and reset
        if (autoJobState.status === 'solving' && autoJobSolvingStartedAt > 0 && Date.now() - autoJobSolvingStartedAt > 180000) {
            ajWarn(`watchdog: solving stuck >3min for ${autoJobState.jobId} (${autoJobState.jobType})`);
            pushAutoJobLog('Solving watchdog: 3min timeout — marking bugged, reset to idle', 'warn');
            if (autoJobState.jobId) {
                bugJob(autoJobState.jobId, autoJobState.jobName || autoJobState.jobType || 'Unknown', 'solving watchdog 3min');
                const qi = autoJobsQueue.findIndex(j => j.jobId === autoJobState.jobId);
                if (qi !== -1) { autoJobsQueue.splice(qi, 1); saveAutoJobsQueue(); }
            }
            autoJobSolvingStartedAt = 0;
            window.postMessage({ type: 'COR3_ABORT_JOB_FLOW' }, '*');
            resetAutoJobState('solving-watchdog');
            if (autoJobsQueue.length > 0) setTimeout(executeNextFromQueue, 3000);
            return;
        }
        // Watchdog: stuck in 'completing' for >45s — WS response likely missed
        if (autoJobState.status === 'completing' && autoJobCompletingStartedAt > 0 && Date.now() - autoJobCompletingStartedAt > 45000) {
            console.warn('[AJ] Stuck in completing for >45s — resetting');
            pushAutoJobLog('Completion watchdog: no WS response — reset to idle', 'warn');
            autoJobCompletingStartedAt = 0;
            resetAutoJobState();
            setTimeout(() => requestMarketRefresh('completing-watchdog'), 1000);
            return;
        }
        tryAcceptNextJob();
    }, 5000);
}

function stopAutoJobsMonitor() {
    if (autoJobsCheckIntervalId) { clearInterval(autoJobsCheckIntervalId); autoJobsCheckIntervalId = null; }
    window.postMessage({ type: 'COR3_ABORT_JOB_FLOW' }, '*');
    autoJobsQueue      = [];
    bulkPendingJobs    = [];
    bulkSentOrder      = [];
    bulkAcceptCount    = 0;
    bulkAcceptTotal    = 0;
    bulkAcceptStartedAt = 0;
    saveAutoJobsQueue();
    resetAutoJobState();
}

// ─────────────────────────────────────────────────────────────────────────────

let alarms = []; // array of alarm objects from storage
let alarmTriggered = {}; // keyed by alarm id
let audioContext = null;
let continuousInterval = null;
let isAlarmActive = false;

// Load alarms
chrome.storage.sync.get('alarms', (data) => {
    alarms = data.alarms || [];
});

function playAlarm(volumePercent) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(volumePercent / 100, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(now + 0.5);
}

function startContinuousAlarm(volume) {
    if (continuousInterval) clearInterval(continuousInterval);
    isAlarmActive = true;
    chrome.runtime.sendMessage({ action: "alarmActiveStatus", isActive: true }).catch(()=>{});
    playAlarm(volume);
    continuousInterval = setInterval(() => {
        playAlarm(volume);
    }, 2000);
}

function stopAlarm() {
    if (continuousInterval) {
        clearInterval(continuousInterval);
        continuousInterval = null;
    }
    isAlarmActive = false;
    chrome.runtime.sendMessage({ action: "alarmActiveStatus", isActive: false }).catch(()=>{});
}

function getTimerRemainingSeconds(timerSource) {
    return new Promise((resolve) => {
        if (!isContextValid()) { resolve(null); return; }
        if (timerSource === 'daily') {
            chrome.storage.local.get('dailyOpsData', (result) => {
                if (result.dailyOpsData && result.dailyOpsData.nextTaskTime) {
                    const diff = new Date(result.dailyOpsData.nextTaskTime).getTime() - Date.now();
                    resolve(diff > 0 ? Math.floor(diff / 1000) : 0);
                } else {
                    resolve(null);
                }
            });
        } else if (timerSource === 'home_jobs') {
            chrome.storage.local.get('marketData', (result) => {
                if (result.marketData && result.marketData.nextJobsResetAt) {
                    const diff = new Date(result.marketData.nextJobsResetAt).getTime() - Date.now();
                    resolve(diff > 0 ? Math.floor(diff / 1000) : 0);
                } else {
                    resolve(null);
                }
            });
        } else if (timerSource === 'dark_jobs') {
            chrome.storage.local.get('darkMarketData', (result) => {
                if (result.darkMarketData && result.darkMarketData.nextJobsResetAt) {
                    const diff = new Date(result.darkMarketData.nextJobsResetAt).getTime() - Date.now();
                    resolve(diff > 0 ? Math.floor(diff / 1000) : 0);
                } else {
                    resolve(null);
                }
            });
        } else if (timerSource.startsWith('exp_')) {
            const expId = timerSource.substring(4);
            chrome.storage.local.get('expeditionsData', (result) => {
                const exps = result.expeditionsData || [];
                const exp = exps.find(e => e.id === expId);
                if (exp && exp.endTime) {
                    const diff = new Date(exp.endTime).getTime() - Date.now();
                    resolve(diff > 0 ? Math.floor(diff / 1000) : 0);
                } else {
                    resolve(null);
                }
            });
		} else {
            resolve(null);
        }
    });
}

// Interval IDs — stored so we can clear them on context invalidation
let alarmsIntervalId = null;
let autoRefreshIntervalId = null;

function clearAllIntervals() {
    if (alarmsIntervalId) { clearInterval(alarmsIntervalId); alarmsIntervalId = null; }
    if (autoRefreshIntervalId) { clearInterval(autoRefreshIntervalId); autoRefreshIntervalId = null; }
    if (autoJobsCheckIntervalId) { clearInterval(autoJobsCheckIntervalId); autoJobsCheckIntervalId = null; }
}

async function checkAlarms() {
    try {
        if (!isContextValid()) { clearAllIntervals(); return; }
        for (const alarm of alarms) {
            if (!alarm.enabled || alarm.thresholdSeconds <= 0) continue;
            const remaining = await getTimerRemainingSeconds(alarm.timerSource);
            if (remaining === null) continue;

            if (remaining <= alarm.thresholdSeconds && remaining > 0 && !alarmTriggered[alarm.id]) {
                alarmTriggered[alarm.id] = true;
                if (alarm.continuous) {
                    startContinuousAlarm(alarm.volume);
                } else {
                    playAlarm(alarm.volume);
                }
            } else if (remaining > alarm.thresholdSeconds) {
                alarmTriggered[alarm.id] = false;
            }
        }
    } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) clearAllIntervals();
    }
}

// Check alarms every second
alarmsIntervalId = setInterval(() => checkAlarms(), 1000);

// --- Auto-Refresh for Market Job Timers ---
let autoRefreshSettings = { home_jobs: false, dark_jobs: false };
let autoRefreshRetryPending = { home_jobs: false, dark_jobs: false };

// Load auto-refresh settings on startup
try { chrome.storage.sync.get('autoRefresh', (data) => {
    if (data.autoRefresh) autoRefreshSettings = data.autoRefresh;
}); } catch (e) {}

function getMarketTimerSeconds(which) {
    return new Promise((resolve) => {
        if (!isContextValid()) { resolve(null); return; }
        try {
            const key = which === 'home_jobs' ? 'marketData' : 'darkMarketData';
            chrome.storage.local.get(key, (result) => {
                const data = result[key];
                if (data && data.nextJobsResetAt) {
                    const diff = new Date(data.nextJobsResetAt).getTime() - Date.now();
                    resolve(diff > 0 ? Math.floor(diff / 1000) : 0);
                } else {
                    resolve(null);
                }
            });
        } catch (e) { resolve(null); }
    });
}

function doAutoRefreshMarket(which) {
    if (which === 'home_jobs') {
        window.postMessage({ type: 'COR3_REFRESH_MARKET' }, '*');
    } else {
        window.postMessage({ type: 'COR3_REFRESH_DARK_MARKET' }, '*');
    }
}

async function checkAutoRefresh() {
    try {
        if (!isContextValid()) { clearAllIntervals(); return; }
        for (const key of ['home_jobs', 'dark_jobs']) {
            if (!autoRefreshSettings[key]) continue;
            if (autoRefreshRetryPending[key]) continue;

            const sec = await getMarketTimerSeconds(key);
            if (sec !== null && sec <= 0) {
                autoRefreshRetryPending[key] = true;
                doAutoRefreshMarket(key);

                // After 10s, re-check. If still 0, retry.
                setTimeout(async () => {
                    autoRefreshRetryPending[key] = false;
                    const newSec = await getMarketTimerSeconds(key);
                    if (newSec !== null && newSec <= 0) {
                        // Will be picked up by next checkAutoRefresh cycle
                    }
                }, 10000);
            }
        }
    } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) clearAllIntervals();
    }
}

// Check auto-refresh every second
autoRefreshIntervalId = setInterval(() => checkAutoRefresh(), 1000);

// --- Auto Decrypt Solver ---
let decryptSolverInjected = false;

function injectDecryptSolver() {
    if (decryptSolverInjected) {
        // Solver already injected, just signal restart
        window.postMessage({ type: 'COR3_START_DECRYPT_SOLVER' }, '*');
        return;
    }
    decryptSolverInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('decrypt-solver.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

function stopDecryptSolver() {
    window.postMessage({ type: 'COR3_STOP_DECRYPT_SOLVER' }, '*');
    decryptSolverInjected = false;
}

// --- Auto Daily Hack Solver ---
let dailyHackInjected = false;

function injectDailyHackSolver() {
    if (dailyHackInjected) {
        window.postMessage({ type: 'COR3_STOP_DAILY_HACK' }, '*');
        dailyHackInjected = false;
        setTimeout(() => injectDailyHackSolver(), 300);
        return;
    }
    dailyHackInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('daily-hack-solver.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

function stopDailyHackSolver() {
    window.postMessage({ type: 'COR3_STOP_DAILY_HACK' }, '*');
    dailyHackInjected = false;
}

// Auto-start solver if it was enabled before page load
chrome.storage.sync.get('autoDecryptEnabled', (data) => {
    if (data.autoDecryptEnabled) {
        injectDecryptSolver();
    }
});

// --- Disable FX (videos + SVG filters + background effects) ---
function applyMapFxDisable(disable) {
    const STYLE_ID = 'cor3-helper-mapfx-disable';
    const existing = document.getElementById(STYLE_ID);
    if (disable) {
        if (!existing) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                // SVG glow filters on network map
                'svg * { filter: none !important; }',
                // Video background overlays (global)
                '#video-glitch, #video-waves { display: none !important; }',
                // Fog videos inside Network Map (fog.mp4, fog_layer_2.mp4)
                'video[data-sentry-component="FogVideo"] { display: none !important; }',
                // Static glitch PNG overlay (mix-blend-mode: color-dodge)
                '#glitch-background { display: none !important; }',
                // CRT scanlines (0.1s infinite animation via ::before pseudo)
                '.crt-effect::before { display: none !important; animation: none !important; }',
                // Override glitch/TV distortion keyframes to no-ops
                '@keyframes go248007083 { 0%,100% { transform: none; } }',
                '@keyframes go3433233158 { 0%,100% { transform: none; } }',
                '@keyframes go1942270456 { 0%,100% { transform: none; } }',
                '@keyframes go3457846050 { 0%,100% { opacity: 0; } }',
                '@keyframes go3062458513 { 0%,100% { transform: none; filter: none; opacity: 1; } }',
            ].join('\n');
            document.head.appendChild(style);
        }
        document.querySelectorAll('#video-glitch video, #video-waves video, video[data-sentry-component="FogVideo"]').forEach(v => v.pause());
    } else {
        if (existing) existing.remove();
        document.querySelectorAll('#video-glitch video, #video-waves video, video[data-sentry-component="FogVideo"]').forEach(v => v.play().catch(() => {}));
    }
}

chrome.storage.sync.get('disableMapFxEnabled', (data) => {
    if (data.disableMapFxEnabled) applyMapFxDisable(true);
});


// Message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateAlarms") {
        alarms = request.alarms || [];
        alarmTriggered = {}; // reset triggers on update
        sendResponse({ success: true });
    } else if (request.action === "testAlarm") {
        const vol = request.volume !== undefined ? request.volume : 50;
        if (request.continuous) {
            startContinuousAlarm(vol);
        } else {
            playAlarm(vol);
        }
        sendResponse({ success: true });
    } else if (request.action === "stopAlarm") {
        stopAlarm();
        sendResponse({ success: true });
    } else if (request.action === "requestExpeditions") {
        window.postMessage({ type: 'COR3_REQUEST_EXPEDITIONS' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestStash") {
        window.postMessage({ type: 'COR3_REQUEST_STASH' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestMarket") {
        window.postMessage({ type: 'COR3_REQUEST_MARKET' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "refreshMarket") {
        window.postMessage({ type: 'COR3_REFRESH_MARKET' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestDarkMarket") {
        window.postMessage({ type: 'COR3_REQUEST_DARK_MARKET' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "refreshDarkMarket") {
        window.postMessage({ type: 'COR3_REFRESH_DARK_MARKET' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "leaveStash") {
        window.postMessage({ type: 'COR3_LEAVE_STASH' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "sellItem") {
        window.postMessage({ type: 'COR3_SELL_ITEM', itemId: request.itemId, quantity: request.quantity || 1 }, '*');
        sendResponse({ success: true });
    } else if (request.action === "keepWorkerAlive") {
        window.postMessage({ type: 'COR3_KEEP_ALIVE' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "updateAutoRefresh") {
        if (request.autoRefresh) {
            autoRefreshSettings = request.autoRefresh;
        }
        sendResponse({ success: true });
    } else if (request.action === "toggleDecryptSolver") {
        if (request.enabled) {
            injectDecryptSolver();
        } else {
            stopDecryptSolver();
        }
        sendResponse({ success: true });
    } else if (request.action === "toggleDailyHackSolver") {
        if (request.enabled) {
            injectDailyHackSolver();
        } else {
            stopDailyHackSolver();
        }
        sendResponse({ success: true });
    } else if (request.action === "respondDecision") {
        // Relay decision response to content-early.js
        window.postMessage({
            type: 'COR3_RESPOND_DECISION',
            expeditionId: request.expeditionId,
            messageId: request.messageId,
            selectedOption: request.selectedOption
        }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestArchivedExpeditions") {
        // Request archived expeditions
        window.postMessage({ type: 'COR3_REQUEST_ARCHIVED_EXPEDITIONS' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestMercenaries") {
        window.postMessage({ type: 'COR3_REQUEST_MERCENARIES' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "requestExpeditionConfig") {
        window.postMessage({ type: 'COR3_REQUEST_EXPEDITION_CONFIG', mercenaryId: request.mercenaryId }, '*');
        sendResponse({ success: true });
    } else if (request.action === "launchExpedition") {
        chrome.storage.local.set({ lastExpeditionLaunchData: request.config });
        window.postMessage({ type: 'COR3_LAUNCH_EXPEDITION', config: request.config }, '*');
        sendResponse({ success: true });
    } else if (request.action === "openContainer") {
        window.postMessage({ type: 'COR3_OPEN_CONTAINER', expeditionId: request.expeditionId }, '*');
        sendResponse({ success: true });
    } else if (request.action === "collectAll") {
        window.postMessage({ type: 'COR3_COLLECT_ALL', expeditionId: request.expeditionId }, '*');
        sendResponse({ success: true });
    } else if (request.action === "toggleAutoJobs") {
        if (request.settings) autoJobsSettings = request.settings;
        if (autoJobsSettings.enabled) {
            startAutoJobsMonitor();
            // Lock NM closure for the entire auto-jobs session (job-manager
            // checks this flag in its capture-phase click handler).
            window.postMessage({ type: 'COR3_AUTOJOBS_ACTIVE_CHANGED', active: true }, '*');
            // Open Network Map and Market (Jobs tab) every time auto-jobs is manually started;
            // also refresh WS market data immediately. The Network Map open also
            // triggers a server-list scrape used by the priority UI.
            setTimeout(() => {
                window.postMessage({ type: 'COR3_OPEN_NETWORK_MAP' }, '*');
                window.postMessage({
                    type: 'COR3_OPEN_MARKET_JOBS',
                    home: autoJobsSettings.markets.home !== false,
                    dark: autoJobsSettings.markets.dark !== false,
                }, '*');
                requestMarketRefresh('autojobs-toggle-on');
            }, 800);
        } else {
            stopAutoJobsMonitor();
            window.postMessage({ type: 'COR3_AUTOJOBS_ACTIVE_CHANGED', active: false }, '*');
        }
        sendResponse({ success: true });
    } else if (request.action === "rescanNetworkMap") {
        window.postMessage({ type: 'COR3_REQUEST_NM_SERVERS' }, '*');
        sendResponse({ success: true });
    } else if (request.action === "debugTriggerJobType") {
        if (autoJobState.status !== 'idle') {
            console.log('[AJ] DebugTrigger: state was', autoJobState.status, '— force-resetting to idle for debug');
            window.postMessage({ type: 'COR3_ABORT_JOB_FLOW' }, '*');
            resetAutoJobState();
        }
        const requestedType = request.jobType;
        chrome.storage.local.get(['marketData', 'darkMarketData', 'darkMarketAvailable'], result => {
            const allMatches = [];
            function collect(jobs, mid) {
                if (!jobs || !mid) return;
                for (const job of jobs) {
                    if (detectJobType(job) === requestedType) {
                        allMatches.push({ ...job, marketId: mid, type: requestedType });
                    }
                }
            }
            if (autoJobsSettings.markets.home && result.marketData?.market?.id) {
                collect(result.marketData.jobs,       result.marketData.market.id);
                collect(result.marketData.recentJobs, result.marketData.market.id);
            }
            if (autoJobsSettings.markets.dark && result.darkMarketAvailable !== false && result.darkMarketData?.market?.id) {
                collect(result.darkMarketData.jobs,       result.darkMarketData.market.id);
                collect(result.darkMarketData.recentJobs, result.darkMarketData.market.id);
            }

            const nonBugged = allMatches.filter(j => !buggedJobIds[j.id]);
            const found = nonBugged[0] || null;
            if (!found) {
                sendResponse({ error: allMatches.length > 0
                    ? `all jobs for type ${requestedType} are bugged`
                    : `no job found for type: ${requestedType}` });
                return;
            }
            if (!found.marketId) {
                sendResponse({ error: 'marketId missing — refresh market and try again' });
                return;
            }

            const isInProgress = !!(found.isCompleted || found.isTaken || found.takenAt ||
                (found.status && found.status !== 'AVAILABLE' && found.status !== 'available'));
            console.log('[AJ] DebugTrigger: found', found.type, found.id, '| in-progress:', isInProgress);

            injectJobManager();

            if (isInProgress) {
                // Already accepted — resolve params from API, push to front of queue, kick off
                const r = resolveJobParams(found.type, found);
                if (!r.ok) {
                    pushAutoJobLog(`Debug trigger: cannot resolve "${found.name || found.id}" — ${r.reason}`, 'error');
                    sendResponse({ error: 'cannot resolve: ' + r.reason });
                    return;
                }
                autoJobsQueue.unshift({
                    jobId:         found.id,
                    marketId:      found.marketId,
                    jobType:       found.type,
                    jobName:       found.name || found.id,
                    serverName:    r.params.serverName    || null,
                    fileCondition: r.params.fileCondition || null,
                    fileNames:     r.params.fileNames     || null,
                    ips:           r.params.ips           || null,
                    logSeqs:       r.params.logSeqs       || null,
                });
                saveAutoJobsQueue();
                setTimeout(executeNextFromQueue, 500);
            } else {
                // Not yet taken — go through the standard accept pipeline (single-item batch).
                acceptCandidatesBatch([found]);
            }
            sendResponse({ success: true, jobId: found.id, jobType: found.type, inProgress: isInProgress });
        });
        return true; // async response
    } else if (request.action === "toggleMapFx") {
        applyMapFxDisable(request.disable);
        sendResponse({ success: true });
    } else if (request.action === "clearBuggedJobs") {
        buggedJobIds = {};
        saveBuggedJobIds();
        sendResponse({ success: true });
    } else if (request.action === "getAutoJobsState") {
        sendResponse({ state: autoJobState });
    } else if (request.action === "fetchDailyOps") {
        // Fetch daily ops in page context using stored bearer token
        chrome.storage.local.get('bearerToken', (result) => {
            const token = result.bearerToken;
            if (!token) {
                sendResponse({ error: 'no token' });
                return;
            }
            fetch('https://svc-corie.cor3.gg/api/user-daily-claim', {
                headers: { 'Authorization': token }
            })
            .then(r => {
                if (r.ok) return r.json();
                if (r.status === 400 || r.status === 401 || r.status === 403) return r.json().then(d => { throw new Error(d.message || 'token_expired'); }).catch(() => { throw new Error('token_expired'); });
                return null;
            })
            .then(data => {
                if (data) {
                    chrome.storage.local.set({ dailyOpsData: data, dailyOpsUpdatedAt: Date.now() });
                    fetchDailyRewards(token);
                }
                sendResponse({ data: data });
            })
            .catch(e => { cor3LogError('content.js', e, { action: 'fetchDailyOps' }); sendResponse({ error: e.message || 'fetch failed' }); });
        });
        return true; // keep channel open for async sendResponse
    } else if (request.action === "disableSystemMessages") {
        // Disable system message notifications
        chrome.storage.sync.get('disableSystemMessages', (result) => {
            if (!result.disableSystemMessages) {
                chrome.storage.sync.set({ disableSystemMessages: true });
                // Apply system message hiding
                hideSystemMessages();
                console.log('[COR3 Helper] System messages disabled');
            }
            sendResponse({ success: true });
        });
    } else if (request.action === "enableSystemMessages") {
        // Enable system message notifications
        chrome.storage.sync.set({ disableSystemMessages: false });
        // Show system messages again
        showSystemMessages();
        console.log('[COR3 Helper] System messages enabled');
        sendResponse({ success: true });
    } else if (request.action === "disableBackground") {
        // Disable background elements (delete them)
        chrome.storage.sync.set({ disableBackground: true });
        deleteBackgroundElements();
        console.log('[COR3 Helper] Background elements deleted');
        sendResponse({ success: true });
    } else if (request.action === "enableBackground") {
        // Enable background elements (just clear the setting, they will be restored on page reload)
        chrome.storage.sync.set({ disableBackground: false });
        console.log('[COR3 Helper] Background elements will be restored on page reload');
        sendResponse({ success: true });
    } else if (request.action === "disableNetworkFog") {
        chrome.storage.sync.set({ disableNetworkFog: true });
        startNetworkFogObserver();
        hideNetworkFogVideos();
        console.log('[COR3 Helper] Network fog disabled');
        sendResponse({ success: true });
    } else if (request.action === "enableNetworkFog") {
        chrome.storage.sync.set({ disableNetworkFog: false });
        stopNetworkFogObserver();
        showNetworkFogVideos();
        console.log('[COR3 Helper] Network fog re-enabled');
        sendResponse({ success: true });
    } else if (request.action === "getVersionFallbacks") {
        // Return version fallbacks from global variables
        sendResponse({
            webVersion: window.__cor3WebVersion,
            systemVersion: window.__cor3SystemVersion
        });
    }
});

// --- System Message Notifications ---
function hideSystemMessages() {
    // Hide system message notifications on the page
    // This targets common system message selectors in the cor3.gg interface
    const systemMessageSelectors = [
        '[class*="system-message"]',
        '[class*="notification"]',
        '[class*="alert"]',
        '[id*="system-message"]',
        '[id*="notification"]',
        '.toast-container',
        '.notification-container',
        '[role="alert"]'
    ];

    systemMessageSelectors.forEach(selector => {
        try {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                if (el && el.style) {
                    el.style.display = 'none';
                    el.setAttribute('data-cor3-hidden', 'true');
                }
            });
        } catch (e) {
            // Ignore errors for selectors that might not exist
        }
    });

    // Also hide any system messages that might appear later
    observeAndHideSystemMessages();
}

function showSystemMessages() {
    // Show previously hidden system message notifications
    const hiddenElements = document.querySelectorAll('[data-cor3-hidden="true"]');
    hiddenElements.forEach(el => {
        if (el && el.style) {
            el.style.display = '';
            el.removeAttribute('data-cor3-hidden');
        }
    });

    // Stop observing for new system messages
    if (systemMessageObserver) {
        systemMessageObserver.disconnect();
        systemMessageObserver = null;
    }
}

let systemMessageObserver = null;

function observeAndHideSystemMessages() {
    if (systemMessageObserver) return;

    systemMessageObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // Check if this element or its children are system messages
                    const systemMessageSelectors = [
                        '[class*="system-message"]',
                        '[class*="notification"]',
                        '[class*="alert"]',
                        '[id*="system-message"]',
                        '[id*="notification"]',
                        '.toast-container',
                        '.notification-container',
                        '[role="alert"]'
                    ];

                    systemMessageSelectors.forEach(selector => {
                        if (node.matches && node.matches(selector)) {
                            node.style.display = 'none';
                            node.setAttribute('data-cor3-hidden', 'true');
                        }

                        // Also check children
                        try {
                            const children = node.querySelectorAll(selector);
                            children.forEach(child => {
                                child.style.display = 'none';
                                child.setAttribute('data-cor3-hidden', 'true');
                            });
                        } catch (e) {
                            // Ignore errors
                        }
                    });
                }
            });
        });
    });

    // Observe the entire document for new elements
    systemMessageObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// --- Background Elements Functions ---
function deleteBackgroundElements() {
    // Delete the specific background elements mentioned by the user
    const backgroundElements = [
        '#app-background',
        '#glitch-background',
        '#video-glitch',
        '#video-waves'
    ];

    backgroundElements.forEach(selector => {
        try {
            const element = document.querySelector(selector);
            if (element) {
                element.remove();
                console.log('[COR3 Helper] Deleted background element:', selector);
            }
        } catch (e) {
            // Ignore errors for elements that might not exist
        }
    });
}

// Apply system message hiding on page load if setting is enabled
chrome.storage.sync.get('disableSystemMessages', (result) => {
    if (result.disableSystemMessages) {
        // Wait a bit for the page to load
        setTimeout(() => {
            hideSystemMessages();
        }, 1000);
    }
});

// Apply background elements deletion on page load if setting is enabled
chrome.storage.sync.get('disableBackground', (result) => {
    if (result.disableBackground) {
        // Wait a bit for the page to load
        setTimeout(() => {
            deleteBackgroundElements();
        }, 1000);
    }
});

// --- Network Fog Functions ---
let networkFogObserver = null;

function isNetworkMapVisible() {
    const divs = document.querySelectorAll('div');
    for (const div of divs) {
        if (div.textContent.trim() === 'Network map') return true;
    }
    return false;
}

function hideNetworkFogVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
        const src = v.getAttribute('src') || '';
        if (src.includes('/video/network-map/fog.mp4') || src.includes('/video/network-map/fog_layer_2.mp4')) {
            v.style.display = 'none';
            v.pause();
            v.setAttribute('data-cor3-fog-hidden', 'true');
        }
    });
}

function showNetworkFogVideos() {
    const hiddenVideos = document.querySelectorAll('[data-cor3-fog-hidden="true"]');
    hiddenVideos.forEach(v => {
        v.style.display = '';
        v.removeAttribute('data-cor3-fog-hidden');
        v.play().catch(() => {});
    });
}

function startNetworkFogObserver() {
    if (networkFogObserver) return;
    networkFogObserver = new MutationObserver(() => {
        if (isNetworkMapVisible()) {
            hideNetworkFogVideos();
        }
    });
    networkFogObserver.observe(document.body, { childList: true, subtree: true });
}

function stopNetworkFogObserver() {
    if (networkFogObserver) {
        networkFogObserver.disconnect();
        networkFogObserver = null;
    }
}

// Apply network fog hiding on page load if setting is enabled
chrome.storage.sync.get('disableNetworkFog', (result) => {
    if (result.disableNetworkFog) {
        setTimeout(() => {
            hideNetworkFogVideos();
            startNetworkFogObserver();
        }, 1000);
    }
});
