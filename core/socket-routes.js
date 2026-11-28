// --- registrasi route express, api gateway, otp password, voucher, qris, webhook logs, branding bot, wa inbox, public chat, dan socket.io ---
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
  addPinnedCommunityMessage,
  appendCommunityChatMessage,
  appendPublicChatMessage,
  appendUserStickerUrls,
  appendWebhookDeliveryLog,
  calculateDirectorySizeBytes,
  changeLocalAccountPassword,
  clearAllGlobalAnnouncements,
  clearPublicChatMessages,
  clearWebhookDeliveryLogs,
  createAutoWelcomeIfFirstVisit,
  createPasswordResetOtp,
  createVoucher,
  deleteCommunityMessageAuthorized,
  deleteGlobalAnnouncementById,
  deletePublicChatMessage,
  deleteUserAccountPermanently,
  deleteVoucher,
  exportUserBotConfig,
  extendUserSubscriptionAtomic,
  findAuthAccountByEmail,
  findUserByApiKey,
  formatBytesReadable,
  generateUserApiKey,
  getAllUsersGlobalMonitorSnapshot,
  getCommunityMembersList,
  getGlobalAnnouncement,
  getGlobalAnnouncements,
  getOrSyncUserProfile,
  getPinnedCommunityMessages,
  getPublicChatMessages,
  getUserStickerUrls,
  importUserBotConfig,
  isPlatformAdminUser,
  listVouchers,
  readBotDatabase,
  recordApiKeyUsage,
  redeemVoucherForUser,
  removePinnedCommunityMessage,
  removeUserStickerUrl,
  removeUserStickerByUrl,
  revokeUserApiKey,
  toggleCommunityMessageReaction,
  updateUserProfileAtomic,
  updateVoucher,
  verifyAndResetPasswordWithOtp,
  writeBotDatabaseAtomic,
  appendDmMessage,
  deleteDmMessageAuthorized,
  getDmRoomMessages,
  getUserDmRoomsList,
  markDmRoomRead,
  clearCommunityMessagesGlobal,
  getCommunityMessagesPage,
  getDmMessagesPage,
  getUserCommunityClearedAt,
  setUserCommunityClearedAt,
  getUnreferencedMediaUrls,
  popExpiredUnreferencedMediaUrls,
  enqueuePendingMediaDeletion,
  deleteDmRoomForUser,
  getUserHiddenWaChats,
  getUserPinnedHomeChats,
  hideWaChatForUser,
  toggleUserPinnedHomeChat,
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
  getLiveInboxSnapshot,
  getRealtimeTrafficSnapshot,
  isBotSubscriptionExpired,
  markLiveInboxChatRead,
  recordRealtimeActivityHit,
  resetAllUsersLimit,
  resolveTargetWhatsappJid,
  restartWhatsAppSession,
  sendDirectWhatsAppMessage,
  sendSystemOtpWhatsAppMessage,
  startMessageSchedulerWorker,
  startWhatsAppSession,
  syncBotSettingsToGlobalDb,
  syncSessionStateToSocket,
  updateBotWhatsappProfile
} from './session-manager.js';
import {
  PACKAGE_CATALOG,
  cancelQrisOrder,
  createQrisOrder,
  getQrisOrderStatus,
  listUserQrisOrders,
  markOrderPaidAndExtend
} from './qris-checkout.js';
import {
  resolveLocalUploadFilePath,
  uploadMediaToSupabaseStorage,
  deleteMediaFromSupabaseStorage
} from './supabase-storage.js';
import { runScheduledBackupNow } from './auto-backup.js';

let systemMetricsInterval = null;
let trafficVelocityInterval = null;
let activeSocketIoServer = null;
let activeCoreModules = null;
let cachedVolumeSizeBytes = 0;
let lastVolumeScanTimestamp = 0;
let lastImmediateVelocityEmitMs = 0;
const onlineCommunityUserIds = new Set();

// --- pancarkan pembaruan daftar pengumuman ke semua klien (format baru & lama) ---
function broadcastAnnouncementsUpdate(ioServer, announcementsList) {
  if (!ioServer) return;
  ioServer.emit('announcements:update', announcementsList);
  ioServer.emit('announcement:update', getGlobalAnnouncement());
}

// --- pancarkan live velocity penuh ke admin dan tanpa topEndpoints ke user biasa ---
function emitTrafficVelocityByRole(ioServer, snapshot) {
  if (!ioServer || ioServer.engine.clientsCount === 0) return;
  ioServer.to('platform_admins').emit('traffic:velocity', snapshot);
  ioServer.except('platform_admins').emit('traffic:velocity', {
    ...snapshot,
    topEndpoints: []
  });
}

// --- pancarkan snapshot live traffic dengan throttling ringan agar tidak membanjiri socket ---
function emitRealtimeVelocityThrottled(ioServer) {
  if (!ioServer || ioServer.engine.clientsCount === 0) return;
  const nowMs = Date.now();
  if (nowMs - lastImmediateVelocityEmitMs < 400) return;
  lastImmediateVelocityEmitMs = nowMs;
  emitTrafficVelocityByRole(ioServer, getRealtimeTrafficSnapshot());
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

// --- worker latar belakang penyapu antrean media yatim di supabase storage ---
let mediaGarbageCollectorInterval = null;
let isMediaGcSweepRunning = false;

function startSupabaseMediaGarbageCollector() {
  if (mediaGarbageCollectorInterval) return;

  const runSafeSweep = async () => {
    if (isMediaGcSweepRunning) return;
    isMediaGcSweepRunning = true;
    try {
      const expiredUrls = popExpiredUnreferencedMediaUrls(Date.now());
      if (expiredUrls.length > 0) {
        const sweepResult = await deleteMediaFromSupabaseStorage(expiredUrls);
        console.log(
          `[MEDIA GC] Dibersihkan -> Supabase: ${sweepResult.deletedSupabase}, Lokal: ${sweepResult.deletedLocal}`
        );
      }
    } catch (gcErr) {
      console.error(`[MEDIA GC WARN] ${gcErr.message}`);
    } finally {
      isMediaGcSweepRunning = false;
    }
  };

  mediaGarbageCollectorInterval = setInterval(runSafeSweep, 30000);
  mediaGarbageCollectorInterval.unref();
  setTimeout(runSafeSweep, 8000).unref();
}

// --- mulai broadcast utilisasi cpu, ram, volume disk, live traffic velocity, dan media gc ---
function startRealtimeSystemBroadcaster(io) {
  startSupabaseMediaGarbageCollector();

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
          emitTrafficVelocityByRole(io, snapshot);
        }
      } catch {
        // --- abaikan error pergeseran bucket velocity ---
      }
    }, 3000);

    trafficVelocityInterval.unref();
  }
}

// --- deteksi nomor lid berdasarkan akhiran @lid, globalUsers, maupun pola panjang digit lid ---
function isLikelyLidNumber(cleanDigits, rawJid = '', globalUsers = {}) {
  if (String(rawJid || '').endsWith('@lid')) return true;
  if (cleanDigits && globalUsers[`${cleanDigits}@lid`]) return true;
  if (cleanDigits && cleanDigits.length >= 14 && !cleanDigits.startsWith('62')) return true;
  return false;
}

// --- susun daftar user (deteksi lid akurat tanpa duplikasi) serta grup aktif ---
function buildManagedEntitiesPayload(googleUserId) {
  const botDb = readBotDatabase(googleUserId);
  const globalUsers = global.db?.users || {};
  const globalGroups = global.db?.groups || {};
  const globalMetadata = global.db?.metadata || {};
  const defaultLimit = botDb.settings?.limitConfig?.defaultLimit ?? 25;

  const usersByNumberMap = new Map();

  for (const [jid, dbEntry] of Object.entries(globalUsers)) {
    if (!/(@s\.whatsapp\.net|@lid)$/i.test(jid)) continue;
    const cleanNum = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!cleanNum) continue;
    const isLid = isLikelyLidNumber(cleanNum, jid, globalUsers);
    const resolvedJid = isLid ? `${cleanNum}@lid` : `${cleanNum}@s.whatsapp.net`;

    usersByNumberMap.set(cleanNum, {
      jid: resolvedJid,
      rawJid: jid,
      number: cleanNum,
      name: dbEntry?.name || cleanNum,
      limit: Number(dbEntry?.limit ?? defaultLimit),
      premium: Boolean(dbEntry?.premium),
      banned: Boolean(dbEntry?.banned),
      isLid
    });
  }

  for (const rawEntry of botDb.uniqueUsers || []) {
    const rawStr = String(rawEntry || '').trim();
    const cleanNum = rawStr.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!cleanNum || usersByNumberMap.has(cleanNum)) continue;

    const isLid = isLikelyLidNumber(cleanNum, rawStr, globalUsers);
    const resolvedJid = isLid ? `${cleanNum}@lid` : `${cleanNum}@s.whatsapp.net`;
    const dbEntry = globalUsers[resolvedJid] || globalUsers[`${cleanNum}@s.whatsapp.net`] || globalUsers[`${cleanNum}@lid`] || {};

    usersByNumberMap.set(cleanNum, {
      jid: resolvedJid,
      rawJid: resolvedJid,
      number: cleanNum,
      name: dbEntry.name || cleanNum,
      limit: Number(dbEntry.limit ?? defaultLimit),
      premium: Boolean(dbEntry.premium),
      banned: Boolean(dbEntry.banned),
      isLid
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
    users: Array.from(usersByNumberMap.values()).sort((a, b) => Number(b.premium) - Number(a.premium)),
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

// --- pasang route halaman, middleware pelacak trafik, api gateway, otp, voucher, qris, dan admin ---
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

  // --- middleware wajib login khusus untuk rute halaman html ---
  function requirePageAuth(request, response, next) {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) {
      response.setHeader('Cache-Control', 'no-store');
      return response.redirect(302, '/login');
    }
    request.sessionUser = sessionUser;
    return next();
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

  // --- daftarkan semua halaman html wajib login (kecuali /login) ---
  const protectedHtmlPages = [
    { route: '/chat', file: 'chat.html' },
    { route: '/sewa-beli-paket', file: 'sewa-beli-paket.html' },
    { route: '/dokumentasi', file: 'dokumentasi.html' },
    { route: '/tutorial', file: 'tutorial.html' },
    { route: '/terms-of-service', file: 'terms-of-service.html' },
    { route: '/privacy-policy', file: 'privacy-policy.html' }
  ];

  for (const page of protectedHtmlPages) {
    app.get(page.route, requirePageAuth, (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      return response.sendFile(path.join(PUBLIC_ROOT_DIR, page.file));
    });
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

  // --- proteksi ketat /app-core.js agar hanya bisa dimuat oleh tag script dari halaman terautentikasi ---
  app.get('/app-core.js', (request, response) => {
    const userAgent = String(request.headers['user-agent'] || '').trim();
    const secFetchDest = String(request.headers['sec-fetch-dest'] || '').toLowerCase();
    const secFetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
    const refererHeader = String(request.headers.referer || '').toLowerCase();
    const automatedUaRegex = /(axios|curl|wget|node-fetch|undici|got\/|python|requests|httpx|aiohttp|postman|insomnia|httpie|scrapy|okhttp|go-http-client|java\/|libwww|headless|puppeteer|playwright|phantomjs)/i;

    const isAutomatedClient = !userAgent || automatedUaRegex.test(userAgent) || !userAgent.includes('Mozilla/');
    const isValidScriptRequest = secFetchDest === 'script' && secFetchSite === 'same-origin';
    const isAllowedReferer = refererHeader.includes('/dashboard') || refererHeader.includes('/chat');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);

    if (isAutomatedClient || !isValidScriptRequest || !isAllowedReferer || !sessionUser) {
      return response.status(403).type('text/plain').send('403 Forbidden');
    }

    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    return response.sendFile(path.join(PUBLIC_ROOT_DIR, 'app-core.js'));
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

      // --- deteksi otomatis tipe gambar jika payload mengirim imageUrl atau imageBase64 ---
      const resolvedMediaUrl = request.body?.mediaUrl || request.body?.imageUrl || '';
      const resolvedMediaBase64 = request.body?.mediaBase64 || request.body?.imageBase64 || '';
      const resolvedMediaType = String(
        request.body?.mediaType || ((resolvedMediaUrl || resolvedMediaBase64) ? 'image' : 'text')
      ).trim().toLowerCase();

      const sendResult = await sendDirectWhatsAppMessage(activeSocketIoServer, ownerMatch.googleUserId, {
        targetJid: request.body?.targetJid || request.body?.to || request.body?.number,
        mediaType: resolvedMediaType,
        message: request.body?.message || request.body?.text,
        caption: request.body?.caption,
        mediaUrl: resolvedMediaUrl,
        mediaBase64: resolvedMediaBase64,
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

  // --- buat transaksi auto-checkout qris ---
  app.post('/api/payment/qris/create', requireAuthenticatedUserApi, async (req, res) => {
    try {
      const packageId = String(req.body?.packageId || '').trim();
      const result = await createQrisOrder(req.sessionUser.googleId, packageId);
      return res.status(result.isSuccess ? 200 : (result.statusCode || 400)).json(result);
    } catch (err) {
      return res.status(500).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  // --- cek status transaksi qris (polling dari frontend) ---
  app.get('/api/payment/qris/status/:orderId', requireAuthenticatedUserApi, (req, res) => {
    const result = getQrisOrderStatus(req.params.orderId, req.sessionUser.googleId);
    return res.status(result.isSuccess ? 200 : 404).json(result);
  });

  // --- webhook callback pembayaran lunas dari penyedia qris ---
  app.post('/api/payment/qris/webhook', (req, res) => {
    const expectedSecret = String(process.env.QRIS_WEBHOOK_SECRET || '').trim();
    const incomingSecret = String(req.headers['x-webhook-secret'] || req.body?.secret || '').trim();

    if (expectedSecret && incomingSecret !== expectedSecret) {
      return res.status(403).json({ isSuccess: false, errorMessage: 'Invalid webhook secret.' });
    }

    const orderId = String(req.body?.order_id || req.body?.orderId || '').trim();
    const status = String(req.body?.status || '').trim().toUpperCase();

    if (!orderId || !['PAID', 'SUCCESS', 'SETTLED'].includes(status)) {
      return res.status(200).json({ isSuccess: true, ignored: true });
    }

    const result = markOrderPaidAndExtend(orderId);
    return res.status(result.isSuccess ? 200 : 404).json(result);
  });

  // --- ambil riwayat transaksi qris milik user ---
  app.get('/api/payment/qris/history', requireAuthenticatedUserApi, (req, res) => {
    const result = listUserQrisOrders(req.sessionUser.googleId);
    return res.status(200).json(result);
  });

  // --- batalkan transaksi qris yang masih pending ---
  app.post('/api/payment/qris/cancel/:orderId', requireAuthenticatedUserApi, (req, res) => {
    const result = cancelQrisOrder(req.params.orderId, req.sessionUser.googleId);
    return res.status(result.isSuccess ? 200 : 400).json(result);
  });

  // --- endpoint katalog paket qris ---
  app.get('/api/payment/qris/packages', requireAuthenticatedUserApi, (_req, res) => {
    return res.status(200).json({ isSuccess: true, packages: Object.values(PACKAGE_CATALOG) });
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

  // --- picu pengiriman auto-backup zip ke whatsapp admin secara manual ---
  app.post('/api/admin/backup/run', requireExclusiveAdminApi, async (_request, response) => {
    const result = await runScheduledBackupNow();
    return response.status(result.isSuccess ? 200 : 500).json(result);
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

  // --- layani file fallback lokal jika supabase storage tidak dikonfigurasi ---
  app.get('/api/uploads/:folder/:ownerId/:fileName', (request, response) => {
    const resolvedFile = resolveLocalUploadFilePath(
      request.params.folder,
      request.params.ownerId,
      request.params.fileName
    );
    if (!resolvedFile || !fs.existsSync(resolvedFile)) {
      return response.status(404).end();
    }
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return response.sendFile(resolvedFile);
  });

  // --- ambil data profil akun saat ini beserta daftar url stiker user ---
  app.get('/api/profile/me', requireAuthenticatedUserApi, (request, response) => {
    try {
      const isAdmin = isExclusiveAdminSession(request.sessionUser);
      const profile = getOrSyncUserProfile(request.sessionUser, isAdmin);
      const stickers = getUserStickerUrls(request.sessionUser.googleId);
      return response.status(200).json({ isSuccess: true, profile, stickers, isAdmin });
    } catch (err) {
      return response.status(500).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  // --- perbarui nama akun (maks 20 karakter), handle discord/sosmed, dan avatar ke supabase ---
  app.post('/api/profile/update', requireAuthenticatedUserApi, async (request, response) => {
    try {
      const userId = request.sessionUser.googleId;
      const displayName = String(request.body?.displayName || '').trim();
      const handle = request.body?.handle;
      const avatarDataUrl = String(request.body?.avatarBase64 || '').trim();

      if (displayName && displayName.length > 20) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Nama akun maksimal 20 karakter.' });
      }

      let uploadedAvatarUrl = undefined;
      if (avatarDataUrl) {
        const uploaded = await uploadMediaToSupabaseStorage({
          folder: 'avatars',
          ownerId: userId,
          dataUrl: avatarDataUrl,
          maxBytes: 5 * 1024 * 1024
        });
        uploadedAvatarUrl = uploaded.url;
      }

      const updatedProfile = updateUserProfileAtomic(userId, {
        displayName: displayName || undefined,
        handle: typeof handle === 'string' ? handle : undefined,
        avatarUrl: uploadedAvatarUrl
      });

      // --- perbarui cookie sesi agar nama dan avatar baru langsung sinkron di seluruh halaman ---
      const refreshedToken = createSignedSessionToken({
        ...request.sessionUser,
        fullName: updatedProfile.displayName,
        givenName: updatedProfile.displayName,
        pictureUrl: updatedProfile.avatarUrl || request.sessionUser.pictureUrl
      });
      setSessionCookie(request, response, refreshedToken);

      if (activeSocketIoServer) {
        activeSocketIoServer.emit('community:members:update', getCommunityMembersList(onlineCommunityUserIds));
      }

      return response.status(200).json({ isSuccess: true, profile: updatedProfile });
    } catch (err) {
      return response.status(400).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  // --- hapus akun permanen dengan validasi dinamis persis format confirm ${sessionUser.fullName} ---
  app.post('/api/account/delete', requireAuthenticatedUserApi, async (request, response) => {
    try {
      const sessionUser = request.sessionUser;
      const isAdmin = isExclusiveAdminSession(sessionUser);
      const currentProfile = getOrSyncUserProfile(sessionUser, isAdmin);

      const expectedSessionName = String(sessionUser.fullName || sessionUser.givenName || 'User').trim();
      const expectedProfileName = String(currentProfile?.displayName || expectedSessionName).trim();
      const validExpectedPhrases = new Set([
        `confirm ${expectedSessionName}`,
        `confirm ${expectedProfileName}`
      ]);

      const providedDynamicPhrase = String(
        request.body?.verifiedDynamicPhrase || request.body?.confirmationText || ''
      ).trim();

      if (!validExpectedPhrases.has(providedDynamicPhrase)) {
        return response.status(400).json({
          isSuccess: false,
          errorMessage: `Konfirmasi tidak cocok. Ketik persis: confirm ${expectedProfileName}`
        });
      }

      const targetUserId = sessionUser.googleId;
      await destroyBotSession(activeSocketIoServer, activeCoreModules || {}, targetUserId, true, 'ACCOUNT_DELETED');
      deleteUserAccountPermanently(targetUserId);
      onlineCommunityUserIds.delete(targetUserId);
      clearSessionCookie(request, response);

      if (activeSocketIoServer) {
        activeSocketIoServer.to(`user_${targetUserId}`).emit('auth:expired', {
          errorMessage: 'Akun Anda telah dihapus secara permanen.'
        });
        activeSocketIoServer.emit('community:members:update', getCommunityMembersList(onlineCommunityUserIds));
      }

      return response.status(200).json({ isSuccess: true, deleted: true });
    } catch (err) {
      return response.status(500).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  // --- unggah multi-stiker ke supabase storage dan simpan url saja di database.json ---
  app.post('/api/stickers/upload', requireAuthenticatedUserApi, async (request, response) => {
    try {
      const items = Array.isArray(request.body?.stickers) ? request.body.stickers : [];
      if (items.length === 0) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'Pilih minimal 1 gambar stiker.' });
      }

      const userId = request.sessionUser.googleId;
      const uploadedStickers = [];

      for (const rawDataUrl of items.slice(0, 12)) {
        const uploaded = await uploadMediaToSupabaseStorage({
          folder: 'stickers',
          ownerId: userId,
          dataUrl: rawDataUrl,
          maxBytes: 4 * 1024 * 1024
        });
        uploadedStickers.push({ url: uploaded.url, createdAt: Date.now() });
      }

      const latestStickers = appendUserStickerUrls(userId, uploadedStickers);
      return response.status(200).json({
        isSuccess: true,
        addedCount: uploadedStickers.length,
        stickers: latestStickers
      });
    } catch (err) {
      return response.status(400).json({ isSuccess: false, errorMessage: err.message });
    }
  });

  // --- ambil daftar url stiker milik user untuk sinkronisasi lintas perangkat ---
  app.get('/api/stickers/list', requireAuthenticatedUserApi, (request, response) => {
    const stickers = getUserStickerUrls(request.sessionUser.googleId);
    return response.status(200).json({ isSuccess: true, stickers });
  });

  // --- hapus stiker berdasarkan id dan antrekan pembersihan supabase jika nol referensi ---
  app.delete('/api/stickers/:id', requireAuthenticatedUserApi, (request, response) => {
    const userId = request.sessionUser.googleId;
    const targetSticker = getUserStickerUrls(userId).find((item) => item?.id === request.params.id);
    const stickers = removeUserStickerUrl(userId, request.params.id);

    if (targetSticker?.url) {
      enqueuePendingMediaDeletion([targetSticker.url]);
    }

    return response.status(200).json({ isSuccess: true, stickers });
  });

  // --- simpan atau hapus stiker dari favorit dan antrekan pembersihan jika nol referensi ---
  app.post('/api/stickers/favorite', requireAuthenticatedUserApi, (request, response) => {
    try {
      const userId = request.sessionUser.googleId;
      const stickerUrl = String(request.body?.url || '').trim();
      const action = String(request.body?.action || 'add').trim().toLowerCase();

      const isValidStickerUrl =
        /^https?:\/\/.+/i.test(stickerUrl) || stickerUrl.startsWith('/api/uploads/');
      if (!isValidStickerUrl) {
        return response.status(400).json({ isSuccess: false, errorMessage: 'URL stiker tidak valid.' });
      }

      if (action === 'remove') {
        const updatedStickers = removeUserStickerByUrl(userId, stickerUrl);
        enqueuePendingMediaDeletion([stickerUrl]);
        return response.status(200).json({
          isSuccess: true,
          isFavorited: false,
          stickers: updatedStickers
        });
      }

      const updatedStickers = appendUserStickerUrls(userId, [
        { url: stickerUrl, createdAt: Date.now() }
      ]);
      return response.status(200).json({
        isSuccess: true,
        isFavorited: true,
        stickers: updatedStickers
      });
    } catch (favoriteErr) {
      return response.status(400).json({ isSuccess: false, errorMessage: favoriteErr.message });
    }
  });

  // --- unggah foto atau video lampiran room chat ke supabase storage ---
  app.post('/api/chat/media/upload', requireAuthenticatedUserApi, async (request, response) => {
    try {
      const mediaType = request.body?.mediaType === 'video' ? 'video' : 'image';
      const maxBytes = mediaType === 'video' ? 14 * 1024 * 1024 : 6 * 1024 * 1024;
      const uploaded = await uploadMediaToSupabaseStorage({
        folder: mediaType === 'video' ? 'chat-videos' : 'chat-images',
        ownerId: request.sessionUser.googleId,
        dataUrl: request.body?.dataUrl,
        maxBytes
      });
      return response.status(200).json({ isSuccess: true, mediaType, url: uploaded.url });
    } catch (err) {
      return response.status(400).json({ isSuccess: false, errorMessage: err.message });
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
  startMessageSchedulerWorker(io, coreModules);

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

    // --- sinkronisasi profil komunitas dan status online anggota ---
    try {
      getOrSyncUserProfile(sessionUser, isAdmin);
      onlineCommunityUserIds.add(authenticatedGoogleId);
      io.emit('community:members:update', getCommunityMembersList(onlineCommunityUserIds));
    } catch (communityInitErr) {
      console.error('[COMMUNITY SYNC ERROR]', communityInitErr.message);
    }

    clientSocket.on('disconnect', () => {
      try {
        const roomSockets = io.sockets.adapter.rooms.get(`user_${authenticatedGoogleId}`);
        if (!roomSockets || roomSockets.size === 0) {
          onlineCommunityUserIds.delete(authenticatedGoogleId);
          io.emit('community:members:update', getCommunityMembersList(onlineCommunityUserIds));
        }
      } catch {
        // --- abaikan error pembersihan status online ---
      }
    });

    // --- kirim payload inisialisasi beranda chat beserta pin beranda & pin pesan valid ---
    clientSocket.on('community:init', () => {
      try {
        clientSocket.join('community_room');
        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const welcomeMessage = createAutoWelcomeIfFirstVisit(latestProfile);
        const latestMembers = getCommunityMembersList(onlineCommunityUserIds);
        const userClearedAt = getUserCommunityClearedAt(authenticatedGoogleId);

        if (welcomeMessage) {
          clientSocket.broadcast.emit('community:message:new', welcomeMessage);
          io.emit('community:members:update', latestMembers);
        }

        const initialPage = getCommunityMessagesPage({
          limit: 30,
          minTimestamp: userClearedAt
        });

        clientSocket.emit('community:ready', {
          profile: latestProfile,
          isAdmin,
          messages: initialPage.messages,
          hasMoreMessages: initialPage.hasMore,
          communityClearedAt: userClearedAt,
          pinnedMessages: getPinnedCommunityMessages(userClearedAt),
          pinnedHomeChats: getUserPinnedHomeChats(authenticatedGoogleId),
          hiddenWaChats: getUserHiddenWaChats(authenticatedGoogleId),
          members: latestMembers,
          dmRooms: getUserDmRoomsList(authenticatedGoogleId, onlineCommunityUserIds),
          waInbox: getLiveInboxSnapshot(authenticatedGoogleId),
          stickers: getUserStickerUrls(authenticatedGoogleId)
        });
      } catch (initErr) {
        clientSocket.emit('community:error', { errorMessage: initErr.message || 'Gagal memuat ruang komunitas.' });
      }
    });

    // --- sematkan atau lepas sematan percakapan pada beranda chat milik user ---
    clientSocket.on('chat:home:pin:toggle', (payload) => {
      try {
        const chatKey = String(payload?.chatKey || '').trim();
        if (!chatKey) return;
        const nextPinnedHome = toggleUserPinnedHomeChat(authenticatedGoogleId, chatKey);
        io.to(`user_${authenticatedGoogleId}`).emit('chat:home:pins:update', nextPinnedHome);
      } catch (homePinErr) {
        clientSocket.emit('community:error', { errorMessage: homePinErr.message || 'Gagal menyematkan percakapan.' });
      }
    });

    // --- hapus percakapan dm atau sembunyikan chat bot wa dari beranda milik user ---
    clientSocket.on('chat:home:delete', (payload) => {
      try {
        const roomType = String(payload?.roomType || '').trim().toLowerCase();
        const targetId = String(payload?.targetId || '').trim();
        if (!targetId) return;

        if (roomType === 'dm') {
          const result = deleteDmRoomForUser(authenticatedGoogleId, targetId);
          io.to(`user_${authenticatedGoogleId}`).emit('dm:list:data', getUserDmRoomsList(authenticatedGoogleId, onlineCommunityUserIds));
          io.to(`user_${authenticatedGoogleId}`).emit('chat:home:pins:update', result.pinnedHomeChats);
          return;
        }

        if (roomType === 'wa') {
          const result = hideWaChatForUser(authenticatedGoogleId, targetId);
          io.to(`user_${authenticatedGoogleId}`).emit('chat:home:hiddenWa:update', result.hiddenWaChats);
          io.to(`user_${authenticatedGoogleId}`).emit('chat:home:pins:update', result.pinnedHomeChats);
        }
      } catch (homeDelErr) {
        clientSocket.emit('community:error', { errorMessage: homeDelErr.message || 'Gagal menghapus percakapan.' });
      }
    });

    // --- muat halaman pesan komunitas lebih lama saat user menggulir ke atas ---
    clientSocket.on('community:history:older', (payload) => {
      try {
        const userClearedAt = getUserCommunityClearedAt(authenticatedGoogleId);
        const olderPage = getCommunityMessagesPage({
          beforeId: payload?.beforeId || '',
          beforeTimestamp: payload?.beforeTimestamp || 0,
          limit: payload?.limit || 30,
          minTimestamp: userClearedAt
        });
        clientSocket.emit('community:history:older:data', {
          messages: olderPage.messages,
          hasMore: olderPage.hasMore
        });
      } catch (olderErr) {
        clientSocket.emit('community:error', { errorMessage: olderErr.message || 'Gagal memuat riwayat pesan lama.' });
      }
    });

    // --- bersihkan riwayat forum komunitas khusus di akun user ini saja ---
    clientSocket.on('community:clear:me', () => {
      try {
        const clearedAt = setUserCommunityClearedAt(authenticatedGoogleId, Date.now());
        clientSocket.emit('community:cleared:me', { clearedAt });
      } catch (clearSelfErr) {
        clientSocket.emit('community:error', { errorMessage: clearSelfErr.message || 'Gagal membersihkan riwayat chat.' });
      }
    });

    // --- hapus seluruh riwayat pesan & pin forum komunitas secara global khusus admin ---
    clientSocket.on('community:clear:global', () => {
      if (!isAdmin) {
        clientSocket.emit('community:error', {
          errorMessage: 'Akses ditolak: hanya Admin yang dapat menghapus seluruh riwayat komunitas.'
        });
        return;
      }
      try {
        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const result = clearCommunityMessagesGlobal();
        io.emit('community:cleared:global', {
          clearedBy: latestProfile?.displayName || 'Admin',
          clearedAt: result.clearedAt
        });
      } catch (clearGlobalErr) {
        clientSocket.emit('community:error', { errorMessage: clearGlobalErr.message || 'Gagal menghapus riwayat global.' });
      }
    });

    // --- ambil daftar dm sesama user xu core ---
    clientSocket.on('dm:list', () => {
      try {
        clientSocket.emit('dm:list:data', getUserDmRoomsList(authenticatedGoogleId, onlineCommunityUserIds));
      } catch {
        // --- abaikan error pembacaan daftar dm ---
      }
    });

    // --- buka ruang dm dengan 30 pesan terbaru dan status pagination ---
    clientSocket.on('dm:open', (payload) => {
      try {
        const peerUserId = String(payload?.peerUserId || '').trim();
        if (!peerUserId || peerUserId === authenticatedGoogleId) return;
        markDmRoomRead(authenticatedGoogleId, peerUserId);
        const dmPage = getDmMessagesPage(authenticatedGoogleId, peerUserId, { limit: 30 });
        clientSocket.emit('dm:messages', {
          peerUserId,
          messages: dmPage.messages,
          hasMore: dmPage.hasMore
        });
        clientSocket.emit('dm:list:data', getUserDmRoomsList(authenticatedGoogleId, onlineCommunityUserIds));
      } catch (dmOpenErr) {
        clientSocket.emit('community:error', { errorMessage: dmOpenErr.message || 'Gagal membuka DM.' });
      }
    });

    // --- muat halaman pesan dm lebih lama saat user menggulir ke atas ---
    clientSocket.on('dm:history:older', (payload) => {
      try {
        const peerUserId = String(payload?.peerUserId || '').trim();
        if (!peerUserId || peerUserId === authenticatedGoogleId) return;
        const olderDmPage = getDmMessagesPage(authenticatedGoogleId, peerUserId, {
          beforeId: payload?.beforeId || '',
          beforeTimestamp: payload?.beforeTimestamp || 0,
          limit: payload?.limit || 30
        });
        clientSocket.emit('dm:history:older:data', {
          peerUserId,
          messages: olderDmPage.messages,
          hasMore: olderDmPage.hasMore
        });
      } catch (dmOlderErr) {
        clientSocket.emit('community:error', { errorMessage: dmOlderErr.message || 'Gagal memuat riwayat DM lama.' });
      }
    });

    // --- kirim pesan dm beserta posterUrl video ke sesama user akun xu core ---
    clientSocket.on('dm:send', (payload) => {
      try {
        const peerUserId = String(payload?.peerUserId || '').trim();
        if (!peerUserId || peerUserId === authenticatedGoogleId) return;

        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const saved = appendDmMessage({
          fromUserId: authenticatedGoogleId,
          toUserId: peerUserId,
          senderProfile: latestProfile,
          isAdmin,
          type: payload?.type || 'text',
          text: payload?.text || '',
          mediaUrl: payload?.mediaUrl || '',
          posterUrl: payload?.posterUrl || '',
          replyTo: payload?.replyTo || null
        });

        if (saved?.item) {
          io.to(`user_${authenticatedGoogleId}`).emit('dm:message:new', saved.item);
          io.to(`user_${peerUserId}`).emit('dm:message:new', saved.item);
          io.to(`user_${authenticatedGoogleId}`).emit('dm:list:data', getUserDmRoomsList(authenticatedGoogleId, onlineCommunityUserIds));
          io.to(`user_${peerUserId}`).emit('dm:list:data', getUserDmRoomsList(peerUserId, onlineCommunityUserIds));
        }
      } catch (dmSendErr) {
        clientSocket.emit('community:error', { errorMessage: dmSendErr.message || 'Gagal mengirim pesan DM.' });
      }
    });

    // --- hapus pesan dm secara real-time untuk kedua peserta ---
    clientSocket.on('dm:delete', (payload) => {
      try {
        const peerUserId = String(payload?.peerUserId || '').trim();
        const result = deleteDmMessageAuthorized(
          authenticatedGoogleId,
          peerUserId,
          payload?.messageId,
          authenticatedGoogleId,
          isAdmin
        );
        if (!result.isSuccess) {
          clientSocket.emit('community:error', { errorMessage: result.errorMessage });
          return;
        }
        io.to(`user_${authenticatedGoogleId}`).emit('dm:message:deleted', {
          peerUserId,
          messageId: result.deletedId
        });
        io.to(`user_${peerUserId}`).emit('dm:message:deleted', {
          peerUserId: authenticatedGoogleId,
          messageId: result.deletedId
        });
      } catch (dmDelErr) {
        clientSocket.emit('community:error', { errorMessage: dmDelErr.message || 'Gagal menghapus pesan DM.' });
      }
    });

    // --- kirim pesan komunitas beserta sinkronisasi otomatis bila ada pin lama yang terlepas ---
    clientSocket.on('community:message:send', (payload) => {
      try {
        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const savedResult = appendCommunityChatMessage({
          userId: authenticatedGoogleId,
          name: latestProfile?.displayName || sessionUser.givenName || 'Member',
          handle: latestProfile?.handle || '',
          avatarUrl: latestProfile?.avatarUrl || sessionUser.pictureUrl || '',
          role: latestProfile?.role || (isAdmin ? 'DEVELOPER' : 'MEMBER'),
          isAdmin,
          type: payload?.type || 'text',
          text: payload?.text || '',
          mediaUrl: payload?.mediaUrl || '',
          posterUrl: payload?.posterUrl || '',
          replyTo: payload?.replyTo || null
        });

        if (savedResult?.item) {
          io.emit('community:message:new', savedResult.item);
        }
        if (savedResult?.pinsChanged) {
          io.emit('community:pins:update', savedResult.pinnedMessages);
        }
      } catch (sendError) {
        clientSocket.emit('community:error', { errorMessage: sendError.message || 'Gagal mengirim pesan.' });
      }
    });

    // --- toggle emoji reaction pada pesan komunitas secara real-time ---
    clientSocket.on('community:message:react', (payload) => {
      try {
        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const updatedMsg = toggleCommunityMessageReaction(
          String(payload?.messageId || '').trim(),
          String(payload?.emoji || '').trim(),
          latestProfile
        );
        if (updatedMsg) {
          io.emit('community:message:reacted', {
            messageId: updatedMsg.id,
            reactions: updatedMsg.reactions
          });
        }
      } catch (reactErr) {
        clientSocket.emit('community:error', { errorMessage: reactErr.message || 'Gagal memperbarui reaksi.' });
      }
    });

    // --- hapus pesan live chat real-time (member: milik sendiri, admin: full override) ---
    clientSocket.on('community:message:delete', (payload) => {
      try {
        const result = deleteCommunityMessageAuthorized(
          payload?.messageId,
          authenticatedGoogleId,
          isAdmin
        );
        if (!result.isSuccess) {
          clientSocket.emit('community:error', { errorMessage: result.errorMessage });
          return;
        }
        io.emit('community:message:deleted', {
          messageId: result.deletedId,
          pinnedMessages: result.pinnedMessages
        });
      } catch (delErr) {
        clientSocket.emit('community:error', { errorMessage: delErr.message || 'Gagal menghapus pesan.' });
      }
    });

    // --- sematkan pesan wajib berasal dari pesan chat asli lengkap dengan thumbnail media ---
    clientSocket.on('community:pin:add', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('community:error', { errorMessage: 'Akses ditolak: hanya Admin yang dapat menyematkan pesan.' });
        return;
      }
      try {
        const latestProfile = getOrSyncUserProfile(sessionUser, isAdmin);
        const targetMessageId = String(payload?.messageId || '').trim();
        if (!targetMessageId) {
          clientSocket.emit('community:error', {
            errorMessage: 'Pesan wajib dikirim ke chat terlebih dahulu sebelum disematkan.'
          });
          return;
        }

        const allMessages = getPublicChatMessages();
        const targetMessage = allMessages.find((messageItem) => messageItem?.id === targetMessageId);
        if (!targetMessage) {
          clientSocket.emit('community:error', { errorMessage: 'Pesan tidak ditemukan untuk disematkan.' });
          return;
        }

        const pinnableTypes = ['image', 'video', 'sticker', 'audio', 'document', 'announcement', 'welcome'];
        const normalizedType = String(targetMessage.type || '').trim().toLowerCase();
        const isPinnableObject =
          pinnableTypes.includes(normalizedType) ||
          Boolean(targetMessage.mediaUrl) ||
          Boolean(targetMessage.isAnnouncement) ||
          Boolean(targetMessage.isWelcome);

        if (!isPinnableObject) {
          clientSocket.emit('community:error', {
            errorMessage: 'Pesan teks biasa tidak dapat disematkan. Hanya pengumuman admin dan media lampiran.'
          });
          return;
        }

        const pinnedMessages = addPinnedCommunityMessage({
          messageId: targetMessageId,
          text: payload?.text || '',
          pinnedBy: latestProfile?.displayName || 'Admin',
          mediaType: normalizedType,
          mediaUrl: targetMessage.mediaUrl || '',
          posterUrl: targetMessage.posterUrl || ''
        });
        io.emit('community:pins:update', pinnedMessages);
      } catch (pinError) {
        clientSocket.emit('community:error', { errorMessage: pinError.message });
      }
    });

    clientSocket.on('community:pin:remove', (payload) => {
      if (!isAdmin) {
        clientSocket.emit('community:error', { errorMessage: 'Akses ditolak: hanya Admin yang dapat melepas sematan.' });
        return;
      }
      try {
        const pinnedMessages = removePinnedCommunityMessage(String(payload?.pinId || '').trim());
        io.emit('community:pins:update', pinnedMessages);
      } catch (err) {
        clientSocket.emit('community:error', { errorMessage: err.message });
      }
    });

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

    // --- perbarui konfigurasi bot lengkap termasuk pesan sistem, prefix, cooldown, menu, limit, dan auto-reply ---
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
      if (typeof payload?.webhookUrl === 'string') {
        nextSettings.webhookUrl = payload.webhookUrl.trim().slice(0, 300);
      }
      if (typeof payload?.webhookSecret === 'string') {
        nextSettings.webhookSecret = payload.webhookSecret.trim().slice(0, 120);
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
          .filter((item) => item && String(item.trigger || '').trim() && (String(item.response || '').trim() || String(item.mediaUrl || '').trim()))
          .map((item) => {
            const rawMode = String(item.matchType || 'exact').trim().toLowerCase();
            const matchType = ['exact', 'contains', 'starts'].includes(rawMode) ? rawMode : 'exact';
            const rawMedia = String(item.mediaType || 'text').trim().toLowerCase();
            const mediaType = ['text', 'image', 'sticker', 'document'].includes(rawMedia) ? rawMedia : 'text';
            return {
              trigger: String(item.trigger).trim().slice(0, 80),
              response: String(item.response || '').trim().slice(0, 500),
              matchType,
              mediaType,
              mediaUrl: String(item.mediaUrl || '').trim().slice(0, 400)
            };
          })
          .slice(0, 30);
      }

      if (payload?.customMessages && typeof payload.customMessages === 'object') {
        const allowedKeys = ['wait', 'limit', 'premium', 'owner', 'group', 'private', 'admin', 'botAdmin'];
        nextSettings.customMessages = { ...(nextSettings.customMessages || {}) };
        for (const key of allowedKeys) {
          if (typeof payload.customMessages[key] === 'string') {
            nextSettings.customMessages[key] = payload.customMessages[key].trim().slice(0, 300);
          }
        }
      }

      if (payload?.prefixConfig && typeof payload.prefixConfig === 'object') {
        const rawPrefixes = String(payload.prefixConfig.prefixes ?? nextSettings.prefixConfig?.prefixes ?? '.!/#').trim().slice(0, 20);
        nextSettings.prefixConfig = {
          prefixes: rawPrefixes || '.!/#',
          cooldownSeconds: Math.max(0, Math.min(60, Number(payload.prefixConfig.cooldownSeconds ?? 3) || 0)),
          spamLimit: Math.max(2, Math.min(30, Number(payload.prefixConfig.spamLimit ?? 5) || 5)),
          spamCooldownSeconds: Math.max(5, Math.min(300, Number(payload.prefixConfig.spamCooldownSeconds ?? 15) || 15))
        };
      }

      if (payload?.menuConfig && typeof payload.menuConfig === 'object') {
        nextSettings.menuConfig = {
          header: String(payload.menuConfig.header ?? nextSettings.menuConfig?.header ?? '').trim().slice(0, 200),
          footer: String(payload.menuConfig.footer ?? nextSettings.menuConfig?.footer ?? '').trim().slice(0, 200),
          thumbnailUrl: String(payload.menuConfig.thumbnailUrl ?? nextSettings.menuConfig?.thumbnailUrl ?? '').trim().slice(0, 400)
        };
      }

      if (payload?.limitConfig && typeof payload.limitConfig === 'object') {
        nextSettings.limitConfig = {
          ...(nextSettings.limitConfig || {}),
          defaultLimit: Math.max(1, Math.min(10000, parseInt(payload.limitConfig.defaultLimit ?? 25, 10) || 25)),
          resetHourWib: Math.max(0, Math.min(23, parseInt(payload.limitConfig.resetHourWib ?? 0, 10) || 0)),
          autoResetEnabled: Boolean(payload.limitConfig.autoResetEnabled ?? true)
        };
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

    // --- ekspor & impor konfigurasi bot milik user dalam format json ---
    clientSocket.on('config:export', () => {
      const exported = exportUserBotConfig(authenticatedGoogleId);
      clientSocket.emit('config:export:result', { isSuccess: true, data: exported });
    });

    clientSocket.on('config:import', (payload) => {
      try {
        const updatedDb = importUserBotConfig(authenticatedGoogleId, payload?.config || payload);
        const activeSession = activeBotSessions.get(authenticatedGoogleId);
        const activeBotJid = activeSession?.socketInstance?.user?.jid;
        if (activeBotJid) {
          syncBotSettingsToGlobalDb(activeBotJid, updatedDb.settings);
        }
        emitUserStatsSnapshot(io, authenticatedGoogleId, updatedDb);
        clientSocket.emit('config:import:result', { isSuccess: true, settings: updatedDb.settings });
        emitLog(authenticatedGoogleId, 'SUCCESS', 'Konfigurasi bot berhasil diimpor dari file JSON.');
      } catch (err) {
        clientSocket.emit('config:import:result', { isSuccess: false, errorMessage: err.message });
      }
    });

    // --- reset limit seluruh user 1-klik dari dashboard ---
    clientSocket.on('manage:users:resetLimit', (payload) => {
      const result = resetAllUsersLimit(io, authenticatedGoogleId, coreModules, payload?.defaultLimit);
      io.to(`user_${authenticatedGoogleId}`).emit('manage:data', buildManagedEntitiesPayload(authenticatedGoogleId));
      clientSocket.emit('manage:users:resetLimit:result', result);
    });

    // --- wa live chat inbox: muat daftar chat, tandai baca, dan balas langsung dari browser ---
    clientSocket.on('inbox:list', () => {
      clientSocket.emit('inbox:update', getLiveInboxSnapshot(authenticatedGoogleId));
    });

    clientSocket.on('inbox:read', (payload) => {
      if (payload?.chatJid) {
        markLiveInboxChatRead(io, authenticatedGoogleId, String(payload.chatJid));
      }
    });

    clientSocket.on('inbox:reply', async (payload) => {
      const targetJid = String(payload?.chatJid || '').trim();
      const text = String(payload?.message || '').trim();
      if (!targetJid || !text) {
        clientSocket.emit('inbox:reply:result', { isSuccess: false, errorMessage: 'Tujuan dan isi pesan wajib diisi.' });
        return;
      }
      const result = await sendDirectWhatsAppMessage(io, authenticatedGoogleId, {
        targetJid,
        mediaType: 'text',
        message: text,
        sourceRoute: '/api/whatsapp/live-inbox'
      });
      clientSocket.emit('inbox:reply:result', result);
    });

    // --- public live chat: ruang obrolan real-time antar seluruh user xu core ---
    clientSocket.on('public:chat:list', () => {
      clientSocket.emit('public:chat:history', getPublicChatMessages());
    });

    clientSocket.on('public:chat:send', (payload) => {
      const cleanText = String(payload?.text || '').trim();
      if (!cleanText) return;
      const added = appendPublicChatMessage({
        userId: authenticatedGoogleId,
        name: sessionUser.givenName || sessionUser.fullName || 'User',
        avatarUrl: sessionUser.pictureUrl || '',
        isAdmin,
        text: cleanText
      });
      if (added) {
        io.emit('public:chat:message', added.item);
      }
    });

    clientSocket.on('public:chat:delete', (payload) => {
      if (!isAdmin) return;
      const updated = deletePublicChatMessage(payload?.id);
      if (updated) {
        io.emit('public:chat:history', updated);
      }
    });

    clientSocket.on('public:chat:clear', () => {
      if (!isAdmin) return;
      const empty = clearPublicChatMessages();
      io.emit('public:chat:history', empty);
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

    // --- simpan pengaturan grup visual (welcome, goodbye, anti-link, anti-toxic) ---
    clientSocket.on('manage:group:config', (payload) => {
      const groupJid = String(payload?.jid || '').trim();
      if (!groupJid.endsWith('@g.us')) return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      const existingCfg = currentDatabase.settings.groupConfigs?.[groupJid] || {};

      currentDatabase.settings.groupConfigs[groupJid] = {
        welcomeEnabled: Boolean(payload?.welcomeEnabled),
        welcomeMessage: String(payload?.welcomeMessage ?? existingCfg.welcomeMessage ?? 'Selamat datang @user di grup @group!').trim().slice(0, 600),
        goodbyeEnabled: Boolean(payload?.goodbyeEnabled),
        goodbyeMessage: String(payload?.goodbyeMessage ?? existingCfg.goodbyeMessage ?? 'Sampai jumpa @user dari @group.').trim().slice(0, 600),
        antiLink: Boolean(payload?.antiLink),
        antiToxic: Boolean(payload?.antiToxic)
      };

      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);
      emitUserStatsSnapshot(io, authenticatedGoogleId, currentDatabase);
      clientSocket.emit('manage:group:config:saved', { isSuccess: true, jid: groupJid });
      emitLog(authenticatedGoogleId, 'SUCCESS', `Pengaturan visual grup [${groupJid.split('@')[0]}] diperbarui.`);
    });

    // --- uji koneksi webhook url milik user dan catat hasilnya ke webhook delivery logs ---
    clientSocket.on('gateway:webhook:test', async (payload) => {
      const targetUrl = String(payload?.webhookUrl || '').trim();
      const secret = String(payload?.webhookSecret || '').trim();
      if (!/^https?:\/\/.+/i.test(targetUrl)) {
        clientSocket.emit('gateway:webhook:test:result', { isSuccess: false, errorMessage: 'URL Webhook harus diawali http:// atau https://.' });
        return;
      }

      const startedAtMs = Date.now();
      let statusCode = 0;
      let isSuccess = false;
      let errorMessage = '';

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (secret) headers['x-webhook-secret'] = secret;
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: 'webhook.test',
            botUserId: authenticatedGoogleId,
            message: 'Koneksi Webhook Xu Core aktif.',
            timestamp: Date.now()
          })
        });
        statusCode = Number(res.status || 0);
        isSuccess = Boolean(res.ok);
        if (!res.ok) errorMessage = `Server tujuan merespons HTTP ${statusCode}.`;
      } catch (err) {
        errorMessage = err.message || 'Gagal menghubungi server tujuan.';
      }

      const updatedLogs = appendWebhookDeliveryLog(authenticatedGoogleId, {
        event: 'webhook.test',
        url: targetUrl,
        statusCode,
        isSuccess,
        durationMs: Date.now() - startedAtMs,
        errorMessage,
        timestamp: Date.now()
      });

      io.to(`user_${authenticatedGoogleId}`).emit('webhook:logs:update', updatedLogs);
      clientSocket.emit('gateway:webhook:test:result', {
        isSuccess,
        statusCode,
        errorMessage: isSuccess ? null : errorMessage
      });
    });

    // --- bersihkan seluruh riwayat kiriman webhook milik user ---
    clientSocket.on('webhook:logs:clear', () => {
      const emptyLogs = clearWebhookDeliveryLogs(authenticatedGoogleId);
      io.to(`user_${authenticatedGoogleId}`).emit('webhook:logs:update', emptyLogs);
      emitLog(authenticatedGoogleId, 'INFO', 'Riwayat Webhook Delivery Logs dibersihkan.');
    });

    // --- perbarui foto profil whatsapp bot langsung dari tab kelola ---
    clientSocket.on('bot:branding:update', async (payload) => {
      const result = await updateBotWhatsappProfile(io, authenticatedGoogleId, {
        avatarBase64: payload?.avatarBase64
      });
      clientSocket.emit('bot:branding:result', result);
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
