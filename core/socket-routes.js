// --- registrasi route express anti-flicker, backup zip, monitor sistem, dan handler socket.io ---
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GOOGLE_CLIENT_ID,
  MAIN_DATABASE_FILE_PATH,
  PLUGINS_ROOT_DIR,
  PUBLIC_ROOT_DIR,
  SESSIONS_VOLUME_ROOT
} from './config.js';
import {
  clearSessionCookie,
  createSignedSessionToken,
  getSessionUserFromCookieHeader,
  setSessionCookie,
  verifyGoogleCredentialToken
} from './auth.js';
import {
  buildLast7DaysTrafficSeries,
  calculateDirectorySizeBytes,
  getGlobalPlatformStatistics,
  isPlatformAdminUser,
  readBotDatabase,
  setGlobalAnnouncement,
  writeBotDatabaseAtomic
} from './database.js';
import {
  deletePluginFile,
  getAvailablePluginsList,
  getFeatureCatalogList,
  scanPluginFilesRecursive,
  togglePluginEnabledState,
  validateAndSavePlugin
} from './plugin-manager.js';
import {
  activeBotSessions,
  broadcastToBotGroups,
  destroyBotSession,
  emitTerminalLog,
  getTopCommandsLeaderboard,
  restartWhatsAppSession,
  startWhatsAppSession,
  syncBotSettingsToGlobalDb,
  syncSessionStateToSocket
} from './session-manager.js';

let systemMetricsInterval = null;
let cachedVolumeSizeBytes = 0;
let lastVolumeScanTimestamp = 0;

// --- format ukuran byte ke satuan mudah dibaca ---
function formatBytesReadable(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- ambil snapshot total dan idle tick cpu dari os ---
function getCpuTimesSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }

  return { idle, total };
}

// --- mulai broadcast utilisasi cpu, ram, dan volume disk ke dashboard ---
function startRealtimeSystemBroadcaster(io) {
  if (systemMetricsInterval) return;

  let previousSnapshot = getCpuTimesSnapshot();

  systemMetricsInterval = setInterval(() => {
    const currentSnapshot = getCpuTimesSnapshot();
    const idleDiff = currentSnapshot.idle - previousSnapshot.idle;
    const totalDiff = currentSnapshot.total - previousSnapshot.total;
    previousSnapshot = currentSnapshot;

    if (io.engine.clientsCount === 0) return;

    const rawUsage = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
    const usage = Math.max(0, Math.min(100, Math.round(rawUsage * 10) / 10));

    const memUsage = process.memoryUsage();
    const ramRssMb = Math.round((memUsage.rss / (1024 * 1024)) * 10) / 10;
    const ramHeapMb = Math.round((memUsage.heapUsed / (1024 * 1024)) * 10) / 10;
    const ramTotalMb = Math.round(os.totalmem() / (1024 * 1024));

    const nowMs = Date.now();
    if (nowMs - lastVolumeScanTimestamp > 15000) {
      cachedVolumeSizeBytes = calculateDirectorySizeBytes(SESSIONS_VOLUME_ROOT);
      lastVolumeScanTimestamp = nowMs;
    }

    io.emit('cpu-update', {
      usage,
      cores: os.cpus().length,
      ramRssMb,
      ramHeapMb,
      ramTotalMb,
      volumeSizeBytes: cachedVolumeSizeBytes,
      volumeSizeLabel: formatBytesReadable(cachedVolumeSizeBytes),
      timestamp: nowMs
    });
  }, 1000);

  systemMetricsInterval.unref();
}

// --- susun daftar user (termasuk @lid dan @s.whatsapp.net) serta grup aktif ---
function buildManagedEntitiesPayload(googleUserId) {
  const botDb = readBotDatabase(googleUserId);
  const globalUsers = global.db?.users || {};
  const globalGroups = global.db?.groups || {};
  const globalMetadata = global.db?.metadata || {};

  const usersMap = new Map();

  for (const rawNum of botDb.uniqueUsers || []) {
    const cleanNum = String(rawNum || '').replace(/\D/g, '');
    if (!cleanNum) continue;
    const jid = `${cleanNum}@s.whatsapp.net`;
    const dbEntry = globalUsers[jid] || {};
    usersMap.set(jid, {
      jid,
      number: cleanNum,
      name: dbEntry.name || cleanNum,
      limit: Number(dbEntry.limit ?? 25),
      premium: Boolean(dbEntry.premium),
      banned: Boolean(dbEntry.banned)
    });
  }

  for (const [jid, dbEntry] of Object.entries(globalUsers)) {
    if (!/(@s\.whatsapp\.net|@lid)$/i.test(jid)) continue;
    const cleanNum = jid.split('@')[0];
    usersMap.set(jid, {
      jid,
      number: cleanNum,
      name: dbEntry?.name || cleanNum,
      limit: Number(dbEntry?.limit ?? 25),
      premium: Boolean(dbEntry?.premium),
      banned: Boolean(dbEntry?.banned)
    });
  }

  const groupsMap = new Map();
  const allGroupIds = new Set([...Object.keys(globalGroups), ...Object.keys(globalMetadata)]);

  for (const groupId of allGroupIds) {
    if (!groupId.endsWith('@g.us')) continue;
    const grpEntry = globalGroups[groupId] || {};
    const metaEntry = globalMetadata[groupId] || {};
    groupsMap.set(groupId, {
      jid: groupId,
      subject: metaEntry.subject || grpEntry.name || groupId.split('@')[0],
      participantsCount: Array.isArray(metaEntry.participants) ? metaEntry.participants.length : 0,
      banned: Boolean(grpEntry.banned)
    });
  }

  return {
    users: Array.from(usersMap.values()).sort((a, b) => Number(b.premium) - Number(a.premium)),
    groups: Array.from(groupsMap.values())
  };
}

// --- pasang route halaman, backup zip, dan api autentikasi express ---
export function registerHttpRoutes(app) {
  app.get('/', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    return response.redirect(302, sessionUser ? '/dashboard' : '/login');
  });

  app.get(['/login', '/login.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (getSessionUserFromCookieHeader(request.headers.cookie)) {
      return response.redirect(302, '/dashboard');
    }
    return response.sendFile(path.join(PUBLIC_ROOT_DIR, 'login.html'));
  });

  app.get(['/dashboard', '/dashboard.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!getSessionUserFromCookieHeader(request.headers.cookie)) {
      return response.redirect(302, '/login');
    }
    return response.sendFile(path.join(PUBLIC_ROOT_DIR, 'dashboard.html'));
  });

  app.use(express.static(PUBLIC_ROOT_DIR, { index: false }));

  app.get('/api/auth/config', (request, response) => {
    response.status(200).json({
      googleClientId: GOOGLE_CLIENT_ID,
      volumePath: SESSIONS_VOLUME_ROOT,
      pluginsPath: PLUGINS_ROOT_DIR
    });
  });

  app.post('/api/auth/google', async (request, response) => {
    try {
      const verifiedUser = await verifyGoogleCredentialToken(request.body?.credential);
      setSessionCookie(request, response, createSignedSessionToken(verifiedUser));
      response.status(200).json({ isAuthenticated: true, user: verifiedUser });
    } catch (authError) {
      response.status(401).json({ isAuthenticated: false, errorMessage: authError.message });
    }
  });

  app.get('/api/auth/me', (request, response) => {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) return response.status(401).json({ isAuthenticated: false });
    return response.status(200).json({
      isAuthenticated: true,
      isAdmin: isPlatformAdminUser(sessionUser),
      user: sessionUser
    });
  });

  app.post('/api/auth/logout', (request, response) => {
    clearSessionCookie(request, response);
    response.status(200).json({ isLoggedOut: true });
  });

  // --- unduh arsip backup zip berisi plugins dan database.json khusus admin ---
  app.get('/api/backup/download', async (request, response) => {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.status(401).json({ errorMessage: 'Autentikasi diperlukan.' });
    }
    if (!isPlatformAdminUser(sessionUser)) {
      return response.status(403).json({ errorMessage: 'Akses backup hanya untuk admin platform.' });
    }

    try {
      const { zipSync } = await import('fflate');
      const zipEntries = {};

      if (fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
        zipEntries['database.json'] = new Uint8Array(fs.readFileSync(MAIN_DATABASE_FILE_PATH));
      }

      const pluginFiles = scanPluginFilesRecursive(PLUGINS_ROOT_DIR);
      for (const relativePath of pluginFiles) {
        const fullPluginPath = path.join(PLUGINS_ROOT_DIR, relativePath);
        if (fs.existsSync(fullPluginPath)) {
          zipEntries[`plugins/${relativePath}`] = new Uint8Array(fs.readFileSync(fullPluginPath));
        }
      }

      const archiveBuffer = Buffer.from(zipSync(zipEntries, { level: 6 }));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="jadibot-backup-${stamp}.zip"`);
      return response.status(200).send(archiveBuffer);
    } catch (backupError) {
      return response.status(500).json({ errorMessage: `Gagal membuat arsip backup: ${backupError.message}` });
    }
  });

  app.get('/health', (request, response) => {
    response.status(200).json({
      status: 'ok',
      volumeRoot: SESSIONS_VOLUME_ROOT,
      pluginsRoot: PLUGINS_ROOT_DIR,
      uptime: process.uptime()
    });
  });
}

// --- pasang event listener socket.io terproteksi cookie sesi dan peran admin ---
export function registerSocketHandlers(io, coreModules) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);

  startRealtimeSystemBroadcaster(io);

  io.on('connection', (clientSocket) => {
    const sessionUser = getSessionUserFromCookieHeader(clientSocket.handshake.headers.cookie);

    if (!sessionUser) {
      clientSocket.emit('auth:expired', { errorMessage: 'Sesi login telah berakhir, silakan masuk kembali.' });
      clientSocket.disconnect(true);
      return;
    }

    const authenticatedGoogleId = sessionUser.googleId;
    const isAdmin = isPlatformAdminUser(sessionUser);

    clientSocket.join(`user_${authenticatedGoogleId}`);
    if (isAdmin) {
      clientSocket.join('platform_admins');
    }

    syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser);

    clientSocket.on('session:sync', () => {
      syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser);
    });

    clientSocket.on('session:connect', async (payload) => {
      const method = payload?.method === 'pairing' ? 'pairing' : 'qr';
      const phoneNumber = payload?.phoneNumber || '';
      await startWhatsAppSession(io, coreModules, authenticatedGoogleId, method, phoneNumber, 1, true);
    });

    clientSocket.on('session:restart', async () => {
      await restartWhatsAppSession(io, coreModules, authenticatedGoogleId);
    });

    clientSocket.on('session:logout', async () => {
      await destroyBotSession(io, coreModules, authenticatedGoogleId, true);
    });

    clientSocket.on('settings:toggle', (payload) => {
      const settingKey = payload?.key;
      const allowedBooleanKeys = ['autoRead', 'publicMode', 'isNoPrefix', 'allowedPc'];
      if (!allowedBooleanKeys.includes(settingKey)) return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      currentDatabase.settings[settingKey] = !currentDatabase.settings[settingKey];
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      const activeSession = activeBotSessions.get(authenticatedGoogleId);
      const activeBotJid = activeSession?.socketInstance?.user?.jid;
      if (activeBotJid) {
        syncBotSettingsToGlobalDb(activeBotJid, currentDatabase.settings);
      }

      io.to(`user_${authenticatedGoogleId}`).emit('stats:update', {
        userStats: {
          ...currentDatabase,
          expiresAt: currentDatabase.subscription?.expiresAt || 0
        },
        globalStats: getGlobalPlatformStatistics(activeBotSessions),
        trafficSeries: buildLast7DaysTrafficSeries(currentDatabase.trafficHistory),
        topCommands: getTopCommandsLeaderboard(5)
      });
      emitLog(
        authenticatedGoogleId,
        'INFO',
        `Pengaturan [${settingKey}] diubah ke: ${currentDatabase.settings[settingKey] ? 'AKTIF' : 'NONAKTIF'}`
      );
    });

    // --- perbarui konfigurasi bot, daftar owner, kategori nonaktif, dan auto-reply ---
    clientSocket.on('settings:update', (payload) => {
      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const nextSettings = { ...currentDatabase.settings };

      if (typeof payload?.botName === 'string' && payload.botName.trim()) {
        nextSettings.botName = payload.botName.trim().slice(0, 60);
      }
      if (typeof payload?.packname === 'string') {
        nextSettings.packname = payload.packname.trim().slice(0, 60);
      }
      if (typeof payload?.author === 'string') {
        nextSettings.author = payload.author.trim().slice(0, 60);
      }
      if (typeof payload?.isNoPrefix === 'boolean') {
        nextSettings.isNoPrefix = payload.isNoPrefix;
      }
      if (typeof payload?.allowedPc === 'boolean') {
        nextSettings.allowedPc = payload.allowedPc;
      }
      if (Array.isArray(payload?.toxic)) {
        nextSettings.toxic = payload.toxic
          .map((w) => String(w).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 100);
      }
      if (Array.isArray(payload?.owners)) {
        nextSettings.owners = Array.from(
          new Set(
            payload.owners
              .map((num) => String(num).replace(/\D/g, ''))
              .filter((num) => num.length >= 6 && num.length <= 18)
          )
        ).slice(0, 20);
      }
      if (Array.isArray(payload?.disabledCategories)) {
        nextSettings.disabledCategories = Array.from(
          new Set(
            payload.disabledCategories
              .map((cat) => String(cat).trim().toLowerCase())
              .filter(Boolean)
          )
        );
      }
      if (Array.isArray(payload?.autoReplies)) {
        nextSettings.autoReplies = payload.autoReplies
          .filter((item) => item && String(item.trigger || '').trim() && String(item.response || '').trim())
          .map((item) => ({
            trigger: String(item.trigger).trim().slice(0, 80),
            response: String(item.response).trim().slice(0, 500)
          }))
          .slice(0, 30);
      }

      currentDatabase.settings = nextSettings;
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      const activeSession = activeBotSessions.get(authenticatedGoogleId);
      const activeBotJid = activeSession?.socketInstance?.user?.jid;
      if (activeBotJid) {
        syncBotSettingsToGlobalDb(activeBotJid, nextSettings);
      }

      io.to(`user_${authenticatedGoogleId}`).emit('stats:update', {
        userStats: {
          ...currentDatabase,
          expiresAt: currentDatabase.subscription?.expiresAt || 0
        },
        globalStats: getGlobalPlatformStatistics(activeBotSessions),
        trafficSeries: buildLast7DaysTrafficSeries(currentDatabase.trafficHistory),
        topCommands: getTopCommandsLeaderboard(5)
      });
      clientSocket.emit('settings:saved', { isSuccess: true, settings: nextSettings });
      emitLog(authenticatedGoogleId, 'SUCCESS', 'Konfigurasi bot berhasil diperbarui dari dashboard.');
    });

    // --- toggle kategori fitur khusus untuk bot milik pengguna ---
    clientSocket.on('catalog:toggleCategory', (payload) => {
      const categoryName = String(payload?.category || '').trim().toLowerCase();
      if (!categoryName) return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const disabledSet = new Set(
        (currentDatabase.settings.disabledCategories || []).map((c) => String(c).toLowerCase())
      );

      let isEnabledNow = true;
      if (disabledSet.has(categoryName)) {
        disabledSet.delete(categoryName);
        isEnabledNow = true;
      } else {
        disabledSet.add(categoryName);
        isEnabledNow = false;
      }

      currentDatabase.settings.disabledCategories = Array.from(disabledSet);
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      io.to(`user_${authenticatedGoogleId}`).emit('stats:update', {
        userStats: {
          ...currentDatabase,
          expiresAt: currentDatabase.subscription?.expiresAt || 0
        },
        globalStats: getGlobalPlatformStatistics(activeBotSessions),
        trafficSeries: buildLast7DaysTrafficSeries(currentDatabase.trafficHistory),
        topCommands: getTopCommandsLeaderboard(5)
      });
      emitLog(
        authenticatedGoogleId,
        isEnabledNow ? 'SUCCESS' : 'WARN',
        `Kategori fitur [${categoryName}] ${isEnabledNow ? 'diaktifkan' : 'dinonaktifkan'} untuk bot Anda.`
      );
    });

    // --- pancarkan pengumuman global ke seluruh dashboard online khusus admin ---
    clientSocket.on('announcement:set', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Hanya admin yang dapat mengirim pengumuman global.' });
        return;
      }

      const updatedAnnouncement = setGlobalAnnouncement(payload?.text || '', payload?.level || 'info');
      io.emit('announcement:update', updatedAnnouncement);
      clientSocket.emit('announcement:result', { isSuccess: true, announcement: updatedAnnouncement });
      emitLog(
        authenticatedGoogleId,
        'INFO',
        updatedAnnouncement.text ? `Pengumuman global dipancarkan: ${updatedAnnouncement.text}` : 'Pengumuman global dihapus.'
      );
    });

    // --- kirim broadcast grup dengan jeda anti-spam dan format payload sinkron ---
    clientSocket.on('broadcast:groups', async (payload) => {
      const result = await broadcastToBotGroups(
        io,
        authenticatedGoogleId,
        payload?.message,
        payload?.delaySeconds
      );
      clientSocket.emit('broadcast:result', {
        ...result,
        sentCount: result?.successCount ?? 0,
        totalGroups: result?.total ?? 0
      });
    });

    clientSocket.on('manage:list', () => {
      clientSocket.emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
    });

    clientSocket.on('manage:user:update', (payload) => {
      const targetJid = String(payload?.jid || '').trim();
      if (!/(@s\.whatsapp\.net|@lid)$/i.test(targetJid)) return;

      global.db = global.db || {};
      global.db.users = global.db.users || {};
      const existingUser = global.db.users[targetJid] || {
        name: targetJid.split('@')[0],
        limit: 25,
        premium: false,
        banned: false
      };

      if (payload?.limit !== undefined && !Number.isNaN(Number(payload.limit))) {
        existingUser.limit = Math.max(0, parseInt(payload.limit, 10));
      }
      if (typeof payload?.premium === 'boolean') {
        existingUser.premium = payload.premium;
      }
      if (typeof payload?.banned === 'boolean') {
        existingUser.banned = payload.banned;
      }

      global.db.users[targetJid] = existingUser;
      if (coreModules.multidb && typeof coreModules.multidb.save === 'function') {
        coreModules.multidb.save();
      }

      emitLog(
        authenticatedGoogleId,
        'INFO',
        `User [${targetJid.split('@')[0]}] diperbarui (Limit: ${existingUser.limit}, Premium: ${existingUser.premium ? 'Ya' : 'Tidak'}, Banned: ${existingUser.banned ? 'Ya' : 'Tidak'}).`
      );
      io.to(`user_${authenticatedGoogleId}`).emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
    });

    // --- hapus data user dari global.db, lid.json, dan daftar uniqueUsers ---
    clientSocket.on('manage:user:delete', async (payload) => {
      const targetJid = String(payload?.jid || '').trim();
      if (!/(@s\.whatsapp\.net|@lid)$/i.test(targetJid)) return;

      const lidModule = coreModules.lid || (await import('../system/lid.js').then((m) => m.default).catch(() => null));
      const mappedPairJid = lidModule
        ? (targetJid.endsWith('@lid') ? lidModule.get(targetJid) : lidModule.getLid(targetJid))
        : null;

      const candidateJids = new Set([targetJid, mappedPairJid].filter(Boolean));
      const candidateNumbers = new Set(
        [...candidateJids]
          .map((id) => String(id).split('@')[0].split(':')[0].replace(/\D/g, ''))
          .filter(Boolean)
      );

      if (global.db?.users) {
        for (const jid of candidateJids) {
          if (global.db.users[jid]) {
            delete global.db.users[jid];
          }
        }
      }

      if (lidModule && typeof lidModule.delete === 'function') {
        for (const id of candidateJids) {
          lidModule.delete(id);
        }
      }

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      if (Array.isArray(currentDatabase.uniqueUsers)) {
        currentDatabase.uniqueUsers = currentDatabase.uniqueUsers.filter((num) => {
          const cleanEntry = String(num).split('@')[0].split(':')[0].replace(/\D/g, '');
          return !candidateNumbers.has(cleanEntry);
        });
        writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);
      }

      if (coreModules.multidb && typeof coreModules.multidb.save === 'function') {
        coreModules.multidb.save();
      }

      const labelNumber = [...candidateNumbers][0] || targetJid.split('@')[0];
      emitLog(authenticatedGoogleId, 'WARN', `User [${labelNumber}] telah dihapus permanen dari database.`);

      io.to(`user_${authenticatedGoogleId}`).emit('stats:update', {
        userStats: {
          ...currentDatabase,
          expiresAt: currentDatabase.subscription?.expiresAt || 0
        },
        globalStats: getGlobalPlatformStatistics(activeBotSessions),
        trafficSeries: buildLast7DaysTrafficSeries(currentDatabase.trafficHistory),
        topCommands: getTopCommandsLeaderboard(5)
      });
      io.to(`user_${authenticatedGoogleId}`).emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
      clientSocket.emit('manage:user:deleted', { jid: targetJid, number: labelNumber });
    });

    clientSocket.on('manage:group:update', (payload) => {
      const targetGroupJid = String(payload?.jid || '').trim();
      if (!targetGroupJid.endsWith('@g.us')) return;

      global.db = global.db || {};
      global.db.groups = global.db.groups || {};
      const existingGroup = global.db.groups[targetGroupJid] || { banned: false };

      if (typeof payload?.banned === 'boolean') {
        existingGroup.banned = payload.banned;
      }

      global.db.groups[targetGroupJid] = existingGroup;
      if (coreModules.multidb && typeof coreModules.multidb.save === 'function') {
        coreModules.multidb.save();
      }

      emitLog(
        authenticatedGoogleId,
        'INFO',
        `Grup [${targetGroupJid.split('@')[0]}] ${existingGroup.banned ? 'dibanned' : 'diaktifkan kembali'}.`
      );
      io.to(`user_${authenticatedGoogleId}`).emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
    });

    clientSocket.on('plugin:save', async (payload) => {
      if (!isAdmin) {
        clientSocket.emit('plugin:save:result', {
          isSuccess: false,
          errorMessage: 'Akses ditolak: hanya admin platform yang dapat menyunting plugin.'
        });
        return;
      }

      const { fileName, codeContent } = payload || {};
      emitLog(authenticatedGoogleId, 'INFO', `Menguji validitas sintaks plugin [${fileName}]...`);
      const validationResult = await validateAndSavePlugin(authenticatedGoogleId, fileName, codeContent, emitLog);

      if (validationResult.isSuccess) {
        const latestCatalog = await getFeatureCatalogList();
        io.to('platform_admins').emit('plugin:list', getAvailablePluginsList());
        io.emit('catalog:update', latestCatalog);
        clientSocket.emit('plugin:save:result', {
          isSuccess: true,
          fileName: validationResult.fileName
        });
      } else {
        emitLog(
          authenticatedGoogleId,
          'ERROR',
          `Validasi Gagal [${fileName}]: ${validationResult.errorType}${validationResult.lineNumber ? ` (Baris ${validationResult.lineNumber})` : ''}`
        );
        clientSocket.emit('plugin:save:result', {
          isSuccess: false,
          errorType: validationResult.errorType,
          lineNumber: validationResult.lineNumber,
          errorMessage: validationResult.errorMessage
        });
      }
    });

    clientSocket.on('plugin:toggle', async (payload) => {
      if (!isAdmin) return;
      const result = togglePluginEnabledState(authenticatedGoogleId, payload?.fileName, emitLog);
      if (result.isSuccess) {
        const latestCatalog = await getFeatureCatalogList();
        io.to('platform_admins').emit('plugin:list', getAvailablePluginsList());
        io.emit('catalog:update', latestCatalog);
      }
    });

    clientSocket.on('plugin:delete', async (payload) => {
      if (!isAdmin) return;
      const deleted = deletePluginFile(authenticatedGoogleId, payload?.fileName, emitLog);
      if (deleted) {
        const latestCatalog = await getFeatureCatalogList();
        io.to('platform_admins').emit('plugin:list', getAvailablePluginsList());
        io.emit('catalog:update', latestCatalog);
      }
    });
  });
}
