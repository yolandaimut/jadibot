// --- registrasi route express, api gateway, otp password, voucher, monitor admin, dan socket.io ---
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
  loginLocalEmailAccount,
  registerLocalEmailAccount,
  setSessionCookie,
  verifyGoogleCredentialToken
} from './auth.js';
import {
  addGlobalAnnouncement,
  calculateDirectorySizeBytes,
  changeLocalAccountPassword,
  clearAllGlobalAnnouncements,
  createPasswordResetOtp,
  createVoucher,
  deleteGlobalAnnouncementById,
  deleteVoucher,
  extendUserSubscriptionAtomic,
  findAuthAccountByEmail,
  findUserByApiKey,
  formatBytesReadable,
  generateUserApiKey,
  getAllUsersGlobalMonitorSnapshot,
  getGlobalAnnouncement,
  getGlobalAnnouncements,
  isPlatformAdminUser,
  listVouchers,
  readBotDatabase,
  recordApiKeyUsage,
  redeemVoucherForUser,
  revokeUserApiKey,
  updateVoucher,
  verifyAndResetPasswordWithOtp,
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
  clearUserSessionPreKeys,
  computeNextJakartaDailyTimestamp,
  destroyBotSession,
  emitAdminGlobalSessionsSnapshot,
  emitTerminalLog,
  emitUserStatsSnapshot,
  getRealtimeTrafficSnapshot,
  isBotSubscriptionExpired,
  recordRealtimeActivityHit,
  resolveTargetWhatsappJid,
  restartWhatsAppSession,
  sendDirectWhatsAppMessage,
  sendSystemOtpWhatsAppMessage,
  startMessageSchedulerWorker,
  startWhatsAppSession,
  syncBotSettingsToGlobalDb,
  syncSessionStateToSocket
} from './session-manager.js';

let systemMetricsInterval = null;
let trafficVelocityInterval = null;
let activeSocketIoServer = null;
let activeCoreModules = null;
let cachedVolumeSizeBytes = 0;
let lastVolumeScanTimestamp = 0;
let lastImmediateVelocityEmitMs = 0;

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

// --- eksekusi aksi admin tunggal maupun massal pada sesi user target ---
async function executeAdminSessionControlAction({ action = '', targetUserIds = [], durationDays = 30 } = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const validActions = ['force_restart', 'force_logout', 'clear_prekeys', 'extend'];
  if (!validActions.includes(normalizedAction)) {
    throw new Error('Aksi admin tidak valid. Gunakan: force_restart, force_logout, clear_prekeys, atau extend.');
  }

  const cleanedIds = Array.from(
    new Set(
      (Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds])
        .map((id) => String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter(Boolean)
    )
  );

  if (cleanedIds.length === 0) {
    throw new Error('Minimal satu User ID target wajib dipilih.');
  }

  const results = [];
  for (const targetUserId of cleanedIds) {
    try {
      if (normalizedAction === 'force_restart') {
        const ok = await restartWhatsAppSession(activeSocketIoServer, activeCoreModules || {}, targetUserId);
        results.push({ userId: targetUserId, isSuccess: ok, message: ok ? 'Restart dipicu' : 'Sesi tersimpan tidak ditemukan' });
      } else if (normalizedAction === 'force_logout') {
        await destroyBotSession(activeSocketIoServer, activeCoreModules || {}, targetUserId, true, 'ADMIN_FORCE_LOGOUT');
        results.push({ userId: targetUserId, isSuccess: true, message: 'Sesi diputus & dihapus' });
      } else if (normalizedAction === 'clear_prekeys') {
        const res = clearUserSessionPreKeys(activeSocketIoServer, targetUserId);
        results.push({ userId: targetUserId, isSuccess: res.isSuccess, deletedCount: res.deletedCount, freedLabel: res.freedLabel });
      } else if (normalizedAction === 'extend') {
        const updatedDb = extendUserSubscriptionAtomic(targetUserId, durationDays);
        emitUserStatsSnapshot(activeSocketIoServer, targetUserId, updatedDb);
        results.push({ userId: targetUserId, isSuccess: true, expiresAt: updatedDb.subscription?.expiresAt || 0 });
      }
    } catch (err) {
      results.push({ userId: targetUserId, isSuccess: false, errorMessage: err.message });
    }
  }

  emitAdminGlobalSessionsSnapshot(activeSocketIoServer);
  return {
    action: normalizedAction,
    processedCount: results.length,
    successCount: results.filter((r) => r.isSuccess).length,
    results,
    monitor: getAllUsersGlobalMonitorSnapshot(activeBotSessions)
  };
}

// --- pasang route halaman, middleware pelacak trafik, api gateway, otp, voucher, dan admin ---
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

  // --- middleware reusable untuk memproteksi endpoint api user terautentikasi ---
  function requireAuthenticatedUserApi(request, response, next) {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.status(401).json({ isSuccess: false, errorMessage: 'Autentikasi diperlukan.' });
    }
    request.sessionUser = sessionUser;
    return next();
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

  app.get(['/dashboard', '/dashboard.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.redirect(302, '/login');
    }

    const renderedHtml = buildDashboardHtmlForSession(sessionUser);
    return response.status(200).type('html').send(renderedHtml);
  });

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

  app.get(['/terms-of-service', '/terms-of-service.html'], (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pageFilePath = path.join(PUBLIC_ROOT_DIR, 'terms-of-service.html');
    if (!fs.existsSync(pageFilePath)) return response.status(404).send('Halaman Terms of Service tidak ditemukan.');
    return response.sendFile(pageFilePath);
  });

  app.get(['/privacy-policy', '/privacy-policy.html'], (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pageFilePath = path.join(PUBLIC_ROOT_DIR, 'privacy-policy.html');
    if (!fs.existsSync(pageFilePath)) return response.status(404).send('Halaman Privacy Policy tidak ditemukan.');
    return response.sendFile(pageFilePath);
  });

  app.get(['/sewa-beli-paket', '/sewa-beli-paket.html'], (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pageFilePath = path.join(PUBLIC_ROOT_DIR, 'sewa-beli-paket.html');
    if (!fs.existsSync(pageFilePath)) return response.status(404).send('Halaman Sewa/Beli Paket tidak ditemukan.');
    return response.sendFile(pageFilePath);
  });

  app.get(['/dokumentasi', '/dokumentasi.html'], (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pageFilePath = path.join(PUBLIC_ROOT_DIR, 'dokumentasi.html');
    if (!fs.existsSync(pageFilePath)) return response.status(404).send('Halaman Dokumentasi tidak ditemukan.');
    return response.sendFile(pageFilePath);
  });

  app.get(['/tutorial', '/tutorial.html'], (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const pageFilePath = path.join(PUBLIC_ROOT_DIR, 'tutorial.html');
    if (!fs.existsSync(pageFilePath)) return response.status(404).send('Halaman Tutorial tidak ditemukan.');
    return response.sendFile(pageFilePath);
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

  // --- endpoint login akun lokal menggunakan email dan kata sandi ---
  app.post('/api/auth/login', (request, response) => {
    try {
      const verifiedUser = loginLocalEmailAccount({
        email: request.body?.email,
        password: request.body?.password
      });
      setSessionCookie(request, response, createSignedSessionToken(verifiedUser));
      return response.status(200).json({ isAuthenticated: true, user: verifiedUser });
    } catch (authError) {
      return response.status(401).json({ isAuthenticated: false, errorMessage: authError.message });
    }
  });

  // --- endpoint pendaftaran akun lokal baru hanya dengan email dan kata sandi ---
  app.post('/api/auth/register', (request, response) => {
    try {
      const createdUser = registerLocalEmailAccount({
        email: request.body?.email,
        password: request.body?.password
      });
      setSessionCookie(request, response, createSignedSessionToken(createdUser));
      return response.status(201).json({ isAuthenticated: true, user: createdUser });
    } catch (registerError) {
      return response.status(400).json({ isAuthenticated: false, errorMessage: registerError.message });
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

  // --- endpoint ganti kata sandi akun lokal untuk user yang sedang login ---
  app.post('/api/auth/password/change', requireAuthenticatedUserApi, (request, response) => {
    try {
      const updated = changeLocalAccountPassword({
        userId: request.sessionUser.googleId,
        email: request.sessionUser.email,
        currentPassword: request.body?.currentPassword,
        newPassword: request.body?.newPassword
      });
      return response.status(200).json({
        isSuccess: true,
        email: updated.email,
        message: 'Kata sandi akun berhasil diperbarui.'
      });
    } catch (changeErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: changeErr.message });
    }
  });

  // --- endpoint minta kode otp reset password yang dikirim ke nomor whatsapp owner terdaftar ---
  app.post('/api/auth/password/request-otp', async (request, response) => {
    try {
      const normalizedEmail = String(request.body?.email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Alamat email wajib diisi.' });
      }

      const account = findAuthAccountByEmail(normalizedEmail);
      if (!account) {
        return response.status(404).json({ isSuccess: false, errorMessage: 'Email lokal tidak terdaftar di sistem.' });
      }

      const userDb = readBotDatabase(account.userId);
      const registeredOwners = [
        ...(Array.isArray(userDb.settings?.owners) ? userDb.settings.owners : []),
        userDb.phoneNumber
      ]
        .map((n) => String(n || '').replace(/\D/g, ''))
        .filter((n) => n.length >= 8);

      const targetPhone = registeredOwners[0];
      if (!targetPhone) {
        return response.status(400).json({
          isSuccess: false,
          errorMessage: 'Akun ini belum memiliki nomor WhatsApp owner atau bot terhubung untuk menerima OTP.'
        });
      }

      const otpRecord = createPasswordResetOtp({
        email: normalizedEmail,
        userId: account.userId,
        targetPhone
      });

      const sendResult = await sendSystemOtpWhatsAppMessage(activeSocketIoServer, {
        preferredUserId: account.userId,
        targetPhone: otpRecord.targetPhone,
        email: normalizedEmail,
        otpCode: otpRecord.otpCode
      });

      if (!sendResult.isSuccess) {
        return response.status(503).json({ isSuccess: false, errorMessage: sendResult.errorMessage });
      }

      const maskedPhone = `${targetPhone.slice(0, 4)}****${targetPhone.slice(-3)}`;
      return response.status(200).json({
        isSuccess: true,
        maskedPhone,
        expiresAt: otpRecord.expiresAt,
        message: `Kode OTP 6 digit telah dikirim ke WhatsApp ${maskedPhone}.`
      });
    } catch (otpErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: otpErr.message });
    }
  });

  // --- endpoint verifikasi otp whatsapp dan simpan kata sandi baru ---
  app.post('/api/auth/password/verify-otp', (request, response) => {
    try {
      const result = verifyAndResetPasswordWithOtp({
        email: request.body?.email,
        otpCode: request.body?.otpCode,
        newPassword: request.body?.newPassword
      });
      return response.status(200).json({
        isSuccess: true,
        email: result.email,
        message: 'Kata sandi berhasil direset. Silakan masuk dengan kata sandi baru Anda.'
      });
    } catch (verifyErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: verifyErr.message });
    }
  });

  // --- endpoint whatsapp api gateway eksternal berbasis api key per user ---
  app.post('/api/v1/gateway/send', async (request, response) => {
    try {
      const authHeader = String(request.headers.authorization || '').trim();
      const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      const rawApiKey = String(request.headers['x-api-key'] || request.headers['apikey'] || bearerKey || '').trim();

      if (!rawApiKey) {
        return response.status(401).json({
          isSuccess: false,
          errorMessage: 'API Key wajib disertakan pada header x-api-key atau Authorization: Bearer <apiKey>.'
        });
      }

      const ownerMatch = findUserByApiKey(rawApiKey);
      if (!ownerMatch) {
        return response.status(403).json({ isSuccess: false, errorMessage: 'API Key tidak valid atau telah dicabut.' });
      }

      if (isBotSubscriptionExpired(ownerMatch.googleUserId, ownerMatch.userDatabase)) {
        return response.status(402).json({ isSuccess: false, errorMessage: 'Masa aktif langganan bot telah berakhir.' });
      }

      const targetJid = request.body?.targetJid || request.body?.to || request.body?.number;
      const messageText = request.body?.message || request.body?.text;
      const mentionAll = Boolean(request.body?.mentionAll);

      const sendResult = await sendDirectWhatsAppMessage(activeSocketIoServer, ownerMatch.googleUserId, {
        targetJid: request.body?.targetJid || request.body?.to || request.body?.number,
        mediaType: request.body?.mediaType || 'text',
        message: request.body?.message || request.body?.text,
        caption: request.body?.caption,
        mediaUrl: request.body?.mediaUrl,
        mediaBase64: request.body?.mediaBase64,
        ptt: Boolean(request.body?.ptt),
        fileName: request.body?.fileName,
        mimetype: request.body?.mimetype,
        location: request.body?.location,
        contact: request.body?.contact,
        mentionAll: Boolean(request.body?.mentionAll),
        sourceRoute: '/api/v1/gateway/send'
      });

      if (!sendResult.isSuccess) {
        return response.status(400).json(sendResult);
      }

      const updatedStats = recordApiKeyUsage(ownerMatch.googleUserId);
      return response.status(200).json({
        isSuccess: true,
        targetJid: sendResult.targetJid,
        messageId: sendResult.messageId,
        apiKeyStats: updatedStats
      });
    } catch (gatewayErr) {
      return response.status(500).json({ isSuccess: false, errorMessage: gatewayErr.message });
    }
  });

  // --- endpoint manajemen api key milik user di dashboard ---
  app.get('/api/gateway/key', requireAuthenticatedUserApi, (request, response) => {
    const userDb = readBotDatabase(request.sessionUser.googleId);
    return response.status(200).json({
      isSuccess: true,
      apiKey: userDb.apiKey || null,
      apiKeyStats: userDb.apiKeyStats || { createdAt: 0, lastUsedAt: 0, totalCalls: 0 }
    });
  });

  app.post('/api/gateway/key/generate', requireAuthenticatedUserApi, (request, response) => {
    const generated = generateUserApiKey(request.sessionUser.googleId);
    return response.status(200).json({ isSuccess: true, ...generated });
  });

  app.delete('/api/gateway/key', requireAuthenticatedUserApi, (request, response) => {
    revokeUserApiKey(request.sessionUser.googleId);
    return response.status(200).json({ isSuccess: true, apiKey: null });
  });

  // --- endpoint klaim kode voucher trial / perpanjangan oleh user ---
  app.post('/api/vouchers/redeem', requireAuthenticatedUserApi, (request, response) => {
    try {
      const redeemed = redeemVoucherForUser(request.sessionUser.googleId, request.body?.code);
      emitUserStatsSnapshot(activeSocketIoServer, request.sessionUser.googleId, redeemed.userDatabase);
      emitAdminGlobalSessionsSnapshot(activeSocketIoServer);
      if (activeSocketIoServer) {
        activeSocketIoServer.to('platform_admins').emit('admin:vouchers:data', listVouchers());
      }
      return response.status(200).json({
        isSuccess: true,
        addedDays: redeemed.addedDays,
        subscription: redeemed.userDatabase.subscription
      });
    } catch (redeemErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: redeemErr.message });
    }
  });

  // --- endpoint bersihkan cache pre-key sesi baileys milik user tanpa menghapus creds.json ---
  app.post('/api/session/clear-prekeys', requireAuthenticatedUserApi, (request, response) => {
    const result = clearUserSessionPreKeys(activeSocketIoServer, request.sessionUser.googleId);
    if (!result.isSuccess) {
      return response.status(400).json(result);
    }
    return response.status(200).json(result);
  });

  // --- endpoint khusus admin: perpanjang masa aktif user target ---
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

      const updatedDb = extendUserSubscriptionAtomic(targetGoogleId, durationDays);
      emitUserStatsSnapshot(activeSocketIoServer, targetGoogleId, updatedDb);
      emitAdminGlobalSessionsSnapshot(activeSocketIoServer);

      return response.status(200).json({
        isSuccess: true,
        googleUserId: targetGoogleId,
        subscription: updatedDb.subscription
      });
    } catch (extendError) {
      return response.status(500).json({ isSuccess: false, errorMessage: extendError.message });
    }
  });

  // --- endpoint khusus admin: crud kode voucher ---
  app.get('/api/admin/vouchers', requireExclusiveAdminApi, (_request, response) => {
    return response.status(200).json({ isSuccess: true, vouchers: listVouchers() });
  });

  app.post('/api/admin/vouchers', requireExclusiveAdminApi, (request, response) => {
    try {
      const created = createVoucher({
        code: request.body?.code,
        durationDays: request.body?.durationDays,
        planName: request.body?.planName,
        maxUses: request.body?.maxUses,
        expiresAt: request.body?.expiresAt
      });
      const latestList = listVouchers();
      if (activeSocketIoServer) {
        activeSocketIoServer.to('platform_admins').emit('admin:vouchers:data', latestList);
      }
      return response.status(201).json({ isSuccess: true, voucher: created, vouchers: latestList });
    } catch (err) {
      return response.status(400).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  app.patch('/api/admin/vouchers/:code', requireExclusiveAdminApi, (request, response) => {
    try {
      const updated = updateVoucher(request.params.code, request.body || {});
      const latestList = listVouchers();
      if (activeSocketIoServer) {
        activeSocketIoServer.to('platform_admins').emit('admin:vouchers:data', latestList);
      }
      return response.status(200).json({ isSuccess: true, voucher: updated, vouchers: latestList });
    } catch (err) {
      return response.status(400).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  app.delete('/api/admin/vouchers/:code', requireExclusiveAdminApi, (request, response) => {
    const deleted = deleteVoucher(request.params.code);
    if (!deleted) {
      return response.status(404).json({ isSuccess: false, errorMessage: 'Kode voucher tidak ditemukan.' });
    }
    const latestList = listVouchers();
    if (activeSocketIoServer) {
      activeSocketIoServer.to('platform_admins').emit('admin:vouchers:data', latestList);
    }
    return response.status(200).json({ isSuccess: true, vouchers: latestList });
  });

  // --- endpoint khusus admin: monitor sesi global terpusat dan aksi massal ---
  app.get('/api/admin/sessions', requireExclusiveAdminApi, (_request, response) => {
    const monitor = getAllUsersGlobalMonitorSnapshot(activeBotSessions);
    return response.status(200).json({ isSuccess: true, ...monitor });
  });

  app.post('/api/admin/sessions/action', requireExclusiveAdminApi, async (request, response) => {
    try {
      const actionResult = await executeAdminSessionControlAction({
        action: request.body?.action,
        targetUserIds: request.body?.userIds || request.body?.userId,
        durationDays: request.body?.durationDays
      });
      return response.status(200).json({ isSuccess: true, ...actionResult });
    } catch (actionErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: actionErr.message });
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
  app.get('/api/backup/download', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');

    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      return response.status(401).json({
        isSuccess: false,
        errorMessage: 'Access Denied: The authentication session is invalid or has expired.'
      });
    }

    const resolvedRole = isExclusiveAdminSession(sessionUser) ? 'admin' : 'user';
    if (resolvedRole !== 'admin') {
      return response.status(403).json({
        isSuccess: false,
        errorMessage: 'Access Denied: Only admin roles are allowed to download Backup ZIP.'
      });
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
      return response.status(500).json({
        isSuccess: false,
        errorMessage: `Gagal membuat arsip backup: ${backupError.message}`
      });
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
  activeCoreModules = coreModules;
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

    // --- bersihkan cache pre-key sesi user tanpa menghapus creds.json ---
    clientSocket.on('session:clear-prekeys', () => {
      const result = clearUserSessionPreKeys(io, authenticatedGoogleId);
      clientSocket.emit('session:clear-prekeys:result', result);
    });

    // --- toggle saklar cepat termasuk fitur ai persona ---
    clientSocket.on('settings:toggle', (payload) => {
      const settingKey = payload?.key;
      const allowedBooleanKeys = ['autoRead', 'publicMode', 'isNoPrefix', 'allowedPc', 'isAiEnabled', 'aiGroupAutoReply'];
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

    // --- event khusus toggle & pembaruan persona ai per bot ---
    clientSocket.on('ai:toggle', (payload) => {
      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const nextValue = typeof payload?.enabled === 'boolean'
        ? payload.enabled
        : !Boolean(currentDatabase.settings.isAiEnabled);

      currentDatabase.settings.isAiEnabled = nextValue;
      if (typeof payload?.aiGroupAutoReply === 'boolean') {
        currentDatabase.settings.aiGroupAutoReply = payload.aiGroupAutoReply;
      }
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      const activeSession = activeBotSessions.get(authenticatedGoogleId);
      const activeBotJid = activeSession?.socketInstance?.user?.jid;
      if (activeBotJid) {
        syncBotSettingsToGlobalDb(activeBotJid, currentDatabase.settings);
      }

      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
      clientSocket.emit('ai:updated', {
        isSuccess: true,
        isAiEnabled: currentDatabase.settings.isAiEnabled,
        aiGroupAutoReply: currentDatabase.settings.aiGroupAutoReply,
        aiSystemPrompt: currentDatabase.settings.aiSystemPrompt
      });
      emitLog(authenticatedGoogleId, 'INFO', `AI Persona Auto-Reply: ${nextValue ? 'AKTIF' : 'NONAKTIF'}.`);
    });

    clientSocket.on('ai:update', (payload) => {
      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      if (typeof payload?.isAiEnabled === 'boolean') {
        currentDatabase.settings.isAiEnabled = payload.isAiEnabled;
      }
      if (typeof payload?.aiGroupAutoReply === 'boolean') {
        currentDatabase.settings.aiGroupAutoReply = payload.aiGroupAutoReply;
      }
      if (typeof payload?.aiSystemPrompt === 'string') {
        currentDatabase.settings.aiSystemPrompt = payload.aiSystemPrompt.trim().slice(0, 2000);
      }

      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);
      const activeSession = activeBotSessions.get(authenticatedGoogleId);
      const activeBotJid = activeSession?.socketInstance?.user?.jid;
      if (activeBotJid) {
        syncBotSettingsToGlobalDb(activeBotJid, currentDatabase.settings);
      }

      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
      clientSocket.emit('ai:updated', {
        isSuccess: true,
        isAiEnabled: currentDatabase.settings.isAiEnabled,
        aiGroupAutoReply: currentDatabase.settings.aiGroupAutoReply,
        aiSystemPrompt: currentDatabase.settings.aiSystemPrompt
      });
      emitLog(authenticatedGoogleId, 'SUCCESS', 'Konfigurasi AI Persona berhasil disimpan.');
    });

    // --- manajemen api key whatsapp gateway via socket ---
    clientSocket.on('gateway:key:generate', () => {
      const generated = generateUserApiKey(authenticatedGoogleId);
      const latestDb = readBotDatabase(authenticatedGoogleId);
      emitUserStatsSnapshot(io, authenticatedGoogleId, latestDb);
      clientSocket.emit('gateway:key:updated', { isSuccess: true, ...generated });
      emitLog(authenticatedGoogleId, 'SUCCESS', 'API Key WhatsApp Gateway baru telah diterbitkan.');
    });

    clientSocket.on('gateway:key:revoke', () => {
      revokeUserApiKey(authenticatedGoogleId);
      const latestDb = readBotDatabase(authenticatedGoogleId);
      emitUserStatsSnapshot(io, authenticatedGoogleId, latestDb);
      clientSocket.emit('gateway:key:updated', {
        isSuccess: true,
        apiKey: null,
        apiKeyStats: { createdAt: 0, lastUsedAt: 0, totalCalls: 0 }
      });
      emitLog(authenticatedGoogleId, 'WARN', 'API Key WhatsApp Gateway telah dicabut.');
    });

    // --- klaim voucher trial/perpanjangan dari dashboard user ---
    clientSocket.on('voucher:redeem', (payload) => {
      try {
        const redeemed = redeemVoucherForUser(authenticatedGoogleId, payload?.code);
        emitUserStatsSnapshot(io, authenticatedGoogleId, redeemed.userDatabase);
        emitAdminGlobalSessionsSnapshot(io);
        io.to('platform_admins').emit('admin:vouchers:data', listVouchers());
        clientSocket.emit('voucher:redeem:result', {
          isSuccess: true,
          addedDays: redeemed.addedDays,
          subscription: redeemed.userDatabase.subscription
        });
        emitLog(
          authenticatedGoogleId,
          'SUCCESS',
          `Voucher [${redeemed.voucher.code}] berhasil diklaim (+${redeemed.addedDays} hari masa aktif).`
        );
      } catch (err) {
        clientSocket.emit('voucher:redeem:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    // --- perbarui konfigurasi bot, daftar owner, ai persona, kategori nonaktif, dan auto-reply ---
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
      if (typeof payload?.isAiEnabled === 'boolean') {
        nextSettings.isAiEnabled = payload.isAiEnabled;
      }
      if (typeof payload?.aiGroupAutoReply === 'boolean') {
        nextSettings.aiGroupAutoReply = payload.aiGroupAutoReply;
      }
      if (typeof payload?.aiSystemPrompt === 'string') {
        nextSettings.aiSystemPrompt = payload.aiSystemPrompt.trim().slice(0, 2000);
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

    // --- operasional panel admin: monitor sesi global, aksi massal, dan crud voucher ---
    clientSocket.on('admin:sessions:list', () => {
      if (!isAdmin) return;
      clientSocket.emit('admin:sessions:data', getAllUsersGlobalMonitorSnapshot(activeBotSessions));
    });

    clientSocket.on('admin:sessions:action', async (payload) => {
      if (!isAdmin) {
        clientSocket.emit('admin:sessions:action:result', {
          isSuccess: false,
          errorMessage: 'Akses ditolak: khusus admin platform.'
        });
        return;
      }
      try {
        const result = await executeAdminSessionControlAction({
          action: payload?.action,
          targetUserIds: payload?.userIds || payload?.userId,
          durationDays: payload?.durationDays
        });
        clientSocket.emit('admin:sessions:action:result', { isSuccess: true, ...result });
      } catch (err) {
        clientSocket.emit('admin:sessions:action:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    clientSocket.on('admin:vouchers:list', () => {
      if (!isAdmin) return;
      clientSocket.emit('admin:vouchers:data', listVouchers());
    });

    clientSocket.on('admin:voucher:create', (payload) => {
      if (!isAdmin) return;
      try {
        const created = createVoucher(payload || {});
        const latest = listVouchers();
        io.to('platform_admins').emit('admin:vouchers:data', latest);
        clientSocket.emit('admin:voucher:result', { isSuccess: true, action: 'created', voucher: created, vouchers: latest });
      } catch (err) {
        clientSocket.emit('admin:voucher:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    clientSocket.on('admin:voucher:toggle', (payload) => {
      if (!isAdmin) return;
      try {
        const existing = listVouchers().find((v) => v.code === String(payload?.code || '').trim().toUpperCase());
        if (!existing) throw new Error('Voucher tidak ditemukan.');
        const updated = updateVoucher(existing.code, { isActive: !existing.isActive });
        const latest = listVouchers();
        io.to('platform_admins').emit('admin:vouchers:data', latest);
        clientSocket.emit('admin:voucher:result', { isSuccess: true, action: 'toggled', voucher: updated, vouchers: latest });
      } catch (err) {
        clientSocket.emit('admin:voucher:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    clientSocket.on('admin:voucher:delete', (payload) => {
      if (!isAdmin) return;
      const deleted = deleteVoucher(payload?.code);
      if (!deleted) {
        clientSocket.emit('admin:voucher:result', { isSuccess: false, errorMessage: 'Voucher tidak ditemukan.' });
        return;
      }
      const latest = listVouchers();
      io.to('platform_admins').emit('admin:vouchers:data', latest);
      clientSocket.emit('admin:voucher:result', { isSuccess: true, action: 'deleted', vouchers: latest });
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
