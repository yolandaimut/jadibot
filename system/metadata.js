// system/metadata.js
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import chalk from 'chalk';
import lid from './lid.js';
import func from './functions.js'; 

const pendingBatches = new Map();
const lastFetchTime = new Map(); // Tracker kapan terakhir kali metadata grup ditarik

const BATCH_WINDOW_MS = 1000; // Antrian lokal 1 detik
const GLOBAL_DELAY_MS = 2000; // Jeda antar grup 2 detik agar tidak rate-limit
const CACHE_TTL_MS = 10 * 60 * 1000; // COOLDOWN 5 MENIT untuk pesan masuk

let globalMetadataQueue = Promise.resolve();

const metadataHandler = async (client, groupId, forceRefresh = false) => {
    try {
        const botId = jidNormalizedUser(client.user.id);
        
        if (global.db?.setting?.[botId]?.maintenance) return;
        if (!groupId || !groupId.endsWith('@g.us')) return;

        const now = Date.now();
        const lastFetch = lastFetchTime.get(groupId) || 0;
        const isCacheExpired = (now - lastFetch) > CACHE_TTL_MS;

        // Jika tidak dipaksa (pesan masuk biasa) DAN cache masih valid (belum 5 menit), kembalikan cache
        if (!forceRefresh && global.db.metadata[groupId] && !isCacheExpired) {
            return global.db.metadata[groupId];
        }

        const groupName = global.db.metadata[groupId]?.subject || groupId;

        // TAHAP 1: LOCAL BATCHING (Mencegah eksekusi ganda di detik yang sama)
        if (!pendingBatches.has(groupId)) {
            const batchPromise = new Promise((resolveGroup) => {
                setTimeout(() => {
                    let resolveGlobal;
                    const nextQueueReady = new Promise(res => resolveGlobal = res);

                    globalMetadataQueue = globalMetadataQueue.then(async () => {
                        try {
                            console.log(chalk.cyanBright(`[META FETCH] Pulling latest data for "${groupName}"...`));

                            const newGroupMetadata = await client.groupMetadata(groupId).catch((e) => {
                                const errText = e.message || String(e);
                                if (errText.toLowerCase().includes('rate-overlimit') || errText.includes('429') || errText.toLowerCase().includes('rate')) {
                                    func.logAndWrite('overlimit', `[META RATELIMIT] Group ${groupName}: ${errText}`);
                                } else {
                                    func.logAndWrite('overlimit', `[META FAIL] Fetch ${groupName}: ${errText}`);
                                }
                                return null;
                            });

                            if (newGroupMetadata) {
                                global.db.metadata[groupId] = {
                                    ...newGroupMetadata,
                                    participants: lid.formatGroupParticipants(newGroupMetadata)
                                };
                                
                                // Catat waktu sukses penarikan data
                                lastFetchTime.set(groupId, Date.now()); 
                                
                                console.log(chalk.greenBright(`[META SUCCESS] Updated "${groupName}" metadata.`));
                                resolveGroup(global.db.metadata[groupId]);
                            } else {
                                resolveGroup(global.db.metadata[groupId]); 
                            }
                        } catch (err) {
                            func.logAndWrite('overlimit', `[META ERROR] Queue execution for ${groupId}: ${err.message}`);
                            resolveGroup(global.db.metadata[groupId]);
                        } finally {
                            pendingBatches.delete(groupId);
                            setTimeout(resolveGlobal, GLOBAL_DELAY_MS);
                        }
                    });

                }, BATCH_WINDOW_MS);
            });

            pendingBatches.set(groupId, batchPromise);
        } else {
            // Hanya log jika itu forceRefresh (dari detects.js), biar terminal gak spam saat pesan biasa masuk
            if (forceRefresh) {
                console.log(chalk.yellow(`[META MERGED] Spam detected on "${groupName}", merged into active queue.`));
            }
        }

        return await pendingBatches.get(groupId);

    } catch (error) {
        const errText = error.message || String(error);
        func.logAndWrite('overlimit', `[META FATAL] Error in ${groupId}: ${errText}`);
        console.error(chalk.redBright(`[META FATAL] ${groupId}:`), error);
        
        if (pendingBatches.has(groupId)) pendingBatches.delete(groupId);
    }
};

export default metadataHandler;