// --- registrasi route express anti-flicker, crud pengumuman, monitor trafik real-time, dan socket.io ---
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
  addGlobalAnnouncement,
  calculateDirectorySizeBytes,
  clearAllGlobalAnnouncements,
  deleteGlobalAnnouncementById,
  getGlobalAnnouncement,
  getGlobalAnnouncements,
  isPlatformAdminUser,
  readBotDatabase,
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
  advanceTrafficVelocityBucket,
  broadcastToBotGroups,
  computeNextJakartaDailyTimestamp,
  destroyBotSession,
  emitTerminalLog,
  emitUserStatsSnapshot,
  getRealtimeTrafficSnapshot,
  recordRealtimeActivityHit,
  resolveTargetWhatsappJid,
  restartWhatsAppSession,
  sendDirectWhatsAppMessage,
  startMessageSchedulerWorker,
  startWhatsAppSession,
  syncBotSettingsToGlobalDb,
  syncSessionStateToSocket
} from './session-manager.js';

let systemMetricsInterval = null;
let trafficVelocityInterval = null;
let activeSocketIoServer = null;
let cachedVolumeSizeBytes = 0;
let lastVolumeScanTimestamp = 0;
let lastImmediateVelocityEmitMs = 0;

// --- format ukuran byte ke satuan mudah dibaca ---
function formatBytesReadable(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- pancarkan pembaruan daftar pengumuman ke semua klien (format baru & lama) ---
function broadcastAnnouncementsUpdate(ioServer, announcementsList) {
  if (!ioServer) return;
  ioServer.emit('announcements:update', announcementsList);
  ioServer.emit('announcement:update', getGlobalAnnouncement());
}

// --- pancarkan snapshot live traffic dengan throttling ringan agar tidak membanjiri socket ---
function emitRealtimeVelocityThrottled(ioServer) {
  if (!ioServer || ioServer.engine.clientsCount === 0) return;
  const nowMs = Date.now();
  if (nowMs - lastImmediateVelocityEmitMs < 400) return;
  lastImmediateVelocityEmitMs = nowMs;
  ioServer.emit('traffic:velocity', getRealtimeTrafficSnapshot());
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

// --- mulai broadcast utilisasi cpu, ram, volume disk, dan live traffic velocity ---
function startRealtimeSystemBroadcaster(io) {
  if (!systemMetricsInterval) {
    let previousSnapshot = getCpuTimesSnapshot();

    systemMetricsInterval = setInterval(() => {
      try {
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
      } catch {
        // --- abaikan error sementara pembacaan metrik sistem ---
      }
    }, 1000);

    systemMetricsInterval.unref();
  }

  if (!trafficVelocityInterval) {
    trafficVelocityInterval = setInterval(() => {
      try {
        const snapshot = advanceTrafficVelocityBucket();
        if (io.engine.clientsCount > 0) {
          io.emit('traffic:velocity', snapshot);
        }
      } catch {
        // --- abaikan error pergeseran bucket velocity ---
      }
    }, 3000);

    trafficVelocityInterval.unref();
  }
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

// --- pasang route halaman, middleware pelacak trafik asli, proteksi admin, dan api ---
export function registerHttpRoutes(app) {
  const EXCLUSIVE_ADMIN_EMAIL = 'suryadev2105@gmail.com';
  const EXCLUSIVE_ADMIN_GOOGLE_ID = '113793372874509761088';

  // --- middleware pencatat hit asli untuk grafik live api traffic velocity ---
  app.use((request, _response, next) => {
    const cleanPath = String(request.path || '/').split('?')[0];
    const isAsset = /\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(cleanPath);
    if (!isAsset && !cleanPath.startsWith('/socket.io')) {
      recordRealtimeActivityHit(request.method, cleanPath);
      emitRealtimeVelocityThrottled(activeSocketIoServer);
    }
    next();
  });

  // --- verifikasi ketat hak akses eksklusif admin berdasarkan email atau google sub id ---
  function isExclusiveAdminSession(sessionUser) {
    if (!sessionUser) return false;
    const normalizedEmail = String(sessionUser.email || '').trim().toLowerCase();
    const normalizedGoogleId = String(sessionUser.googleId || '').trim();
    return (
      normalizedEmail === EXCLUSIVE_ADMIN_EMAIL ||
      normalizedGoogleId === EXCLUSIVE_ADMIN_GOOGLE_ID
    );
  }

  // --- middleware reusable untuk memproteksi endpoint api khusus admin utama ---
  function requireExclusiveAdminApi(request, response, next) {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.status(401).json({ isSuccess: false, errorMessage: 'Autentikasi diperlukan.' });
    }
    if (!isExclusiveAdminSession(sessionUser)) {
      return response.status(403).json({ isSuccess: false, errorMessage: 'Akses ditolak: khusus admin utama.' });
    }
    request.adminSessionUser = sessionUser;
    return next();
  }

  // --- sisipkan tombol navigasi panel admin ke dropdown profil hanya untuk admin eksklusif ---
  function buildDashboardHtmlForSession(sessionUser) {
    const dashboardFilePath = path.join(PUBLIC_ROOT_DIR, 'dashboard.html');
    const rawHtml = fs.readFileSync(dashboardFilePath, 'utf-8');

    if (!isExclusiveAdminSession(sessionUser)) {
      return rawHtml;
    }

    const adminNavButtonHtml = [
      '            <a id="navAdminPanelLink" href="/admin" onclick="toggleUserDropdownMenu()" class="w-full text-left px-3 py-2 flex items-center justify-between text-amber-300 hover:bg-amber-500/10 transition-colors font-semibold">',
      '              <span class="flex items-center gap-2">',
      '                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>',
      '                <span>Panel Admin</span>',
      '              </span>',
      '              <span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 font-mono-code">ADMIN</span>',
      '            </a>'
    ].join('\n');

    return rawHtml.replace(
      /(<div[^>]*id="userDropdownMenuPopup"[\s\S]*?<div\s+class="py-1">)/,
      `$1\n${adminNavButtonHtml}`
    );
  }

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

  // --- render halaman dashboard secara sinkron sesuai peran sesi tanpa efek flicker ---
  app.get(['/dashboard', '/dashboard.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.redirect(302, '/login');
    }

    const renderedHtml = buildDashboardHtmlForSession(sessionUser);
    return response.status(200).type('html').send(renderedHtml);
  });

  // --- proteksi ketat route halaman admin agar tidak bisa diakses langsung oleh user biasa ---
  app.get(['/admin', '/admin/', '/admin.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.redirect(302, '/login');
    }
    if (!isExclusiveAdminSession(sessionUser)) {
      return response.redirect(302, '/dashboard');
    }

    const adminFilePath = path.join(PUBLIC_ROOT_DIR, 'admin.html');
    if (!fs.existsSync(adminFilePath)) {
      return response.status(404).send('Halaman admin tidak ditemukan.');
    }
    return response.sendFile(adminFilePath);
  });

  app.use(express.static(PUBLIC_ROOT_DIR, { index: false }));

  app.get('/api/auth/config', (_request, response) => {
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
      isAdmin: isExclusiveAdminSession(sessionUser),
      user: sessionUser
    });
  });

  app.post('/api/auth/logout', (request, response) => {
    clearSessionCookie(request, response);
    response.status(200).json({ isLoggedOut: true });
  });

  // --- endpoint khusus admin eksklusif untuk memperpanjang masa aktif user target ---
  app.post('/api/admin/subscription/extend', requireExclusiveAdminApi, (request, response) => {
    try {
      const targetGoogleId = String(request.body?.googleUserId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const durationDays = Number(request.body?.durationDays || 0);

      if (!targetGoogleId) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Google ID target tidak valid.' });
      }
      if (![7, 30, 90].includes(durationDays)) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Durasi paket harus 7, 30, atau 90 hari.' });
      }

      const targetDatabase = readBotDatabase(targetGoogleId);
      const baseTimestamp = Math.max(Date.now(), Number(targetDatabase.subscription?.expiresAt || 0));
      const nextExpiresAt = baseTimestamp + durationDays * 24 * 60 * 60 * 1000;

      targetDatabase.subscription = {
        ...(targetDatabase.subscription || {}),
        plan: durationDays >= 90 ? 'Pro 90 Hari' : (durationDays >= 30 ? 'Pro 30 Hari' : 'Starter 7 Hari'),
        expiresAt: nextExpiresAt
      };

      writeBotDatabaseAtomic(targetGoogleId, targetDatabase);

      return response.status(200).json({
        isSuccess: true,
        googleUserId: targetGoogleId,
        subscription: targetDatabase.subscription
      });
    } catch (extendError) {
      return response.status(500).json({ isSuccess: false, errorMessage: extendError.message });
    }
  });

  // --- endpoint admin: ambil daftar pengumuman global ---
  app.get('/api/admin/announcements', requireExclusiveAdminApi, (_request, response) => {
    return response.status(200).json({
      isSuccess: true,
      announcements: getGlobalAnnouncements()
    });
  });

  // --- endpoint admin: terbitkan pengumuman baru dan pancarkan ke semua dashboard ---
  app.post('/api/admin/announcements', requireExclusiveAdminApi, (request, response) => {
    try {
      const title = String(request.body?.title || '').trim();
      const category = String(request.body?.category || 'INFO').toUpperCase();
      const text = String(request.body?.text || '').trim();

      if (!text) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Isi pengumuman wajib diisi.' });
      }

      const created = addGlobalAnnouncement({ title, category, text });
      broadcastAnnouncementsUpdate(activeSocketIoServer, created.list);

      return response.status(200).json({
        isSuccess: true,
        announcement: created.item,
        announcements: created.list
      });
    } catch (createError) {
      return response.status(500).json({ isSuccess: false, errorMessage: createError.message });
    }
  });

  // --- endpoint admin: hapus satu pengumuman berdasarkan id ---
  app.delete('/api/admin/announcements/:id', requireExclusiveAdminApi, (request, response) => {
    try {
      const updatedList = deleteGlobalAnnouncementById(request.params.id);
      if (!updatedList) {
        return response.status(404).json({ isSuccess: false, errorMessage: 'Pengumuman tidak ditemukan.' });
      }

      broadcastAnnouncementsUpdate(activeSocketIoServer, updatedList);

      return response.status(200).json({
        isSuccess: true,
        announcements: updatedList
      });
    } catch (deleteError) {
      return response.status(500).json({ isSuccess: false, errorMessage: deleteError.message });
    }
  });

  // --- endpoint admin: bersihkan seluruh pengumuman dari database.json ---
  app.delete('/api/admin/announcements', requireExclusiveAdminApi, (_request, response) => {
    try {
      const emptyList = clearAllGlobalAnnouncements();
      broadcastAnnouncementsUpdate(activeSocketIoServer, emptyList);

      return response.status(200).json({
        isSuccess: true,
        announcements: emptyList
      });
    } catch (clearError) {
      return response.status(500).json({ isSuccess: false, errorMessage: clearError.message });
    }
  });

  // --- unduh arsip backup zip berisi plugins dan database.json khusus admin eksklusif ---
  app.get('/api/backup/download', requireExclusiveAdminApi, async (_request, response) => {
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

  app.get('/health', (_request, response) => {
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
  activeSocketIoServer = io;
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);

  startRealtimeSystemBroadcaster(io);
  startMessageSchedulerWorker(io);

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
      recordRealtimeActivityHit('WS', '/socket/session-sync');
      emitRealtimeVelocityThrottled(io);
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

      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
      emitLog(
        authenticatedGoogleId,
        'INFO',
        `Pengaturan [${settingKey}] diubah ke: ${currentDatabase.settings[settingKey] ? 'AKTIF' : 'NONAKTIF'}`
      );
    });

    // --- perbarui konfigurasi bot, daftar owner, kategori nonaktif, dan auto-reply multi-mode ---
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
          .map((item) => {
            const rawMode = String(item.matchType || 'exact').trim().toLowerCase();
            const matchType = ['exact', 'contains', 'starts'].includes(rawMode) ? rawMode : 'exact';
            return {
              trigger: String(item.trigger).trim().slice(0, 80),
              response: String(item.response).trim().slice(0, 500),
              matchType
            };
          })
          .slice(0, 30);
      }

      currentDatabase.settings = nextSettings;
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      const activeSession = activeBotSessions.get(authenticatedGoogleId);
      const activeBotJid = activeSession?.socketInstance?.user?.jid;
      if (activeBotJid) {
        syncBotSettingsToGlobalDb(activeBotJid, nextSettings);
      }

      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
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
      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
      emitLog(
        authenticatedGoogleId,
        isEnabledNow ? 'SUCCESS' : 'WARN',
        `Kategori fitur [${categoryName}] ${isEnabledNow ? 'diaktifkan' : 'dinonaktifkan'} untuk bot Anda.`
      );
    });

    // --- manajemen multi-pengumuman global khusus admin via socket.io ---
    clientSocket.on('announcement:create', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Hanya admin yang dapat menerbitkan pengumuman.' });
        return;
      }

      try {
        const cleanText = String(payload?.text || '').trim();
        if (!cleanText) {
          clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Isi pengumuman tidak boleh kosong.' });
          return;
        }

        const created = addGlobalAnnouncement({
          title: payload?.title || 'Pengumuman / Update API',
          category: payload?.category || payload?.level || 'INFO',
          text: cleanText
        });

        broadcastAnnouncementsUpdate(io, created.list);
        clientSocket.emit('announcement:result', { isSuccess: true, action: 'created', announcement: created.item, announcements: created.list });
        emitLog(authenticatedGoogleId, 'INFO', `Pengumuman [${created.item.category}] diterbitkan: ${created.item.title}`);
      } catch (err) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    clientSocket.on('announcement:delete', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Hanya admin yang dapat menghapus pengumuman.' });
        return;
      }

      try {
        const updatedList = deleteGlobalAnnouncementById(payload?.id);
        if (!updatedList) {
          clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Pengumuman tidak ditemukan.' });
          return;
        }

        broadcastAnnouncementsUpdate(io, updatedList);
        clientSocket.emit('announcement:result', { isSuccess: true, action: 'deleted', announcements: updatedList });
        emitLog(authenticatedGoogleId, 'WARN', `Pengumuman [${payload?.id}] dihapus dari database.json.`);
      } catch (err) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    clientSocket.on('announcement:clear', () => {
      if (!isAdmin) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Hanya admin yang dapat menghapus semua pengumuman.' });
        return;
      }

      try {
        const emptyList = clearAllGlobalAnnouncements();
        broadcastAnnouncementsUpdate(io, emptyList);
        clientSocket.emit('announcement:result', { isSuccess: true, action: 'cleared', announcements: emptyList });
        emitLog(authenticatedGoogleId, 'WARN', 'Seluruh daftar pengumuman global telah dibersihkan.');
      } catch (err) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    // --- kompatibilitas event announcement:set lama ---
    clientSocket.on('announcement:set', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('announcement:result', { isSuccess: false, errorMessage: 'Hanya admin yang dapat mengirim pengumuman global.' });
        return;
      }

      const cleanText = String(payload?.text || '').trim();
      if (!cleanText) {
        const emptyList = clearAllGlobalAnnouncements();
        broadcastAnnouncementsUpdate(io, emptyList);
        clientSocket.emit('announcement:result', { isSuccess: true, action: 'cleared', announcements: emptyList });
        return;
      }

      const created = addGlobalAnnouncement({
        title: payload?.title || 'Pengumuman / Update API',
        category: payload?.level || payload?.category || 'INFO',
        text: cleanText
      });
      broadcastAnnouncementsUpdate(io, created.list);
      clientSocket.emit('announcement:result', { isSuccess: true, action: 'created', announcement: created.item, announcements: created.list });
    });

    // --- kirim pesan langsung ke satu grup atau nomor pribadi ---
    clientSocket.on('direct:send', async (payload) => {
      const result = await sendDirectWhatsAppMessage(io, authenticatedGoogleId, {
        targetJid: payload?.targetJid,
        message: payload?.message,
        mentionAll: Boolean(payload?.mentionAll)
      });
      clientSocket.emit('direct:result', result);
    });

    // --- manajemen pesan terjadwal & reminder otomatis ---
    clientSocket.on('schedule:list', () => {
      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      clientSocket.emit('schedule:list', currentDatabase.scheduledMessages || []);
    });

    clientSocket.on('schedule:create', (payload) => {
      const targetJid = resolveTargetWhatsappJid(payload?.targetJid);
      if (!targetJid) {
        clientSocket.emit('schedule:result', { isSuccess: false, errorMessage: 'Nomor tujuan atau ID Grup (@g.us) tidak valid.' });
        return;
      }

      const cleanMessage = String(payload?.message || '').trim().slice(0, 1500);
      if (!cleanMessage) {
        clientSocket.emit('schedule:result', { isSuccess: false, errorMessage: 'Isi pesan terjadwal tidak boleh kosong.' });
        return;
      }

      const repeatType = ['once', 'daily', 'interval'].includes(payload?.repeatType) ? payload.repeatType : 'once';
      const nowMs = Date.now();
      let nextRunAt = 0;
      let dailyTime = '';
      let intervalMinutes = 0;

      if (repeatType === 'once') {
        nextRunAt = Number(payload?.runAtMs || 0);
        if (!nextRunAt || nextRunAt < nowMs - 60000) {
          clientSocket.emit('schedule:result', { isSuccess: false, errorMessage: 'Waktu kirim sekali harus diatur ke waktu mendatang.' });
          return;
        }
      } else if (repeatType === 'daily') {
        dailyTime = String(payload?.dailyTime || '08:00').trim();
        if (!/^\d{2}:\d{2}$/.test(dailyTime)) {
          clientSocket.emit('schedule:result', { isSuccess: false, errorMessage: 'Format jam harian tidak valid (HH:MM).' });
          return;
        }
        nextRunAt = computeNextJakartaDailyTimestamp(dailyTime, nowMs);
      } else {
        intervalMinutes = Math.max(1, Math.min(10080, parseInt(payload?.intervalMinutes || '60', 10) || 60));
        nextRunAt = nowMs + intervalMinutes * 60 * 1000;
      }

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const existingSchedules = Array.isArray(currentDatabase.scheduledMessages) ? currentDatabase.scheduledMessages : [];
      if (existingSchedules.length >= 25) {
        clientSocket.emit('schedule:result', { isSuccess: false, errorMessage: 'Batas maksimal 25 jadwal pesan per akun tercapai.' });
        return;
      }

      const newScheduleItem = {
        id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: String(payload?.title || '').trim().slice(0, 60) || targetJid.split('@')[0],
        targetJid,
        targetLabel: String(payload?.targetLabel || '').trim().slice(0, 80) || targetJid.split('@')[0],
        message: cleanMessage,
        mentionAll: Boolean(payload?.mentionAll) && targetJid.endsWith('@g.us'),
        repeatType,
        dailyTime,
        intervalMinutes,
        nextRunAt,
        lastRunAt: 0,
        runCount: 0,
        isActive: true,
        lastStatus: 'SCHEDULED',
        createdAt: nowMs
      };

      currentDatabase.scheduledMessages = [newScheduleItem, ...existingSchedules];
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      io.to(`user_${authenticatedGoogleId}`).emit('schedule:list', currentDatabase.scheduledMessages);
      clientSocket.emit('schedule:result', { isSuccess: true, schedule: newScheduleItem });
      emitLog(authenticatedGoogleId, 'SUCCESS', `Jadwal pesan [${newScheduleItem.title}] ditambahkan (${repeatType.toUpperCase()}).`);
    });

    clientSocket.on('schedule:toggle', (payload) => {
      const scheduleId = String(payload?.id || '').trim();
      if (!scheduleId) return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const nowMs = Date.now();
      currentDatabase.scheduledMessages = (currentDatabase.scheduledMessages || []).map((item) => {
        if (item.id !== scheduleId) return item;
        const nextActive = !item.isActive;
        let nextRunAt = Number(item.nextRunAt || 0);
        if (nextActive && nextRunAt <= nowMs) {
          if (item.repeatType === 'daily') {
            nextRunAt = computeNextJakartaDailyTimestamp(item.dailyTime || '08:00', nowMs);
          } else if (item.repeatType === 'interval') {
            nextRunAt = nowMs + Math.max(1, Number(item.intervalMinutes || 60)) * 60 * 1000;
          } else {
            nextRunAt = nowMs + 60 * 1000;
          }
        }
        return {
          ...item,
          isActive: nextActive,
          nextRunAt,
          lastStatus: nextActive ? 'SCHEDULED' : 'PAUSED'
        };
      });

      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);
      io.to(`user_${authenticatedGoogleId}`).emit('schedule:list', currentDatabase.scheduledMessages);
    });

    clientSocket.on('schedule:delete', (payload) => {
      const scheduleId = String(payload?.id || '').trim();
      if (!scheduleId) return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      currentDatabase.scheduledMessages = (currentDatabase.scheduledMessages || []).filter((item) => item.id !== scheduleId);
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      io.to(`user_${authenticatedGoogleId}`).emit('schedule:list', currentDatabase.scheduledMessages);
      emitLog(authenticatedGoogleId, 'WARN', `Jadwal pesan [${scheduleId}] dihapus.`);
    });

    // --- kirim broadcast grup dengan jeda anti-spam dan format payload sinkron ---
    clientSocket.on('broadcast:groups', async (payload) => {
      recordRealtimeActivityHit('POST', '/api/whatsapp/broadcast');
      emitRealtimeVelocityThrottled(io);
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
      recordRealtimeActivityHit('GET', '/api/manage/entities');
      emitRealtimeVelocityThrottled(io);
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

    // --- pembaruan massal limit dan status premium reseller untuk user terpilih ---
    clientSocket.on('manage:users:bulkUpdate', (payload) => {
      const rawJids = Array.isArray(payload?.jids) ? payload.jids : [];
      const validJids = rawJids
        .map((j) => String(j || '').trim())
        .filter((j) => /(@s\.whatsapp\.net|@lid)$/i.test(j));

      if (validJids.length === 0) return;

      global.db = global.db || {};
      global.db.users = global.db.users || {};

      for (const targetJid of validJids) {
        const existingUser = global.db.users[targetJid] || {
          name: targetJid.split('@')[0],
          limit: 25,
          premium: false,
          banned: false
        };

        if (payload?.addLimit !== undefined && !Number.isNaN(Number(payload.addLimit))) {
          existingUser.limit = Math.max(0, Number(existingUser.limit || 0) + parseInt(payload.addLimit, 10));
        }
        if (payload?.setLimit !== undefined && !Number.isNaN(Number(payload.setLimit))) {
          existingUser.limit = Math.max(0, parseInt(payload.setLimit, 10));
        }
        if (typeof payload?.premium === 'boolean') {
          existingUser.premium = payload.premium;
        }
        if (typeof payload?.banned === 'boolean') {
          existingUser.banned = payload.banned;
        }

        global.db.users[targetJid] = existingUser;
      }

      if (coreModules.multidb && typeof coreModules.multidb.save === 'function') {
        coreModules.multidb.save();
      }

      emitLog(authenticatedGoogleId, 'SUCCESS', `Pembaruan massal diterapkan ke ${validJids.length} user.`);
      io.to(`user_${authenticatedGoogleId}`).emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
      clientSocket.emit('manage:users:bulkResult', { isSuccess: true, count: validJids.length });
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

      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
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