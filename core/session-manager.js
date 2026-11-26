// --- manajer sesi baileys, auto-connect, multi-media, webhook, grup visual, ai persona, spintax, clear pre-keys, dan auto-backup ---
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import {
  ADMIN_WA_NUMBER,
  AUTO_CONNECT_MAX_RETRIES,
  AUTO_CONNECT_TIMEOUT_MS,
  MAIN_DATABASE_FILE_PATH,
  PLUGINS_ROOT_DIR,
  SESSIONS_ROOT_FOLDER_PATH,
  CONFIG
} from './config.js';
import {
  buildLast7DaysTrafficSeries,
  formatBytesReadable,
  getAllUsersGlobalMonitorSnapshot,
  getGlobalAnnouncement,
  getGlobalAnnouncements,
  getGlobalPlatformStatistics,
  getUserSessionFolderPath,
  incrementDailyTrafficRecord,
  isPlatformAdminById,
  isPlatformAdminUser,
  listVouchers,
  readBotDatabase,
  readMasterDatabaseFile,
  writeBotDatabaseAtomic,
  writeMasterDatabaseFileAtomic
} from './database.js';
import {
  executeDynamicPlugins,
  getAvailablePluginsList,
  getFeatureCatalogList,
  scanPluginFilesRecursive
} from './plugin-manager.js';
import Extra from '../system/extra.js';

const extraInstance = new Extra();

export const activeBotSessions = new Map();
export const userTerminalLogsCache = new Map();
const silentLogger = pino({ level: 'silent' });
let schedulerWorkerInterval = null;
let lastExpiryReminderCheckMs = 0;
let lastAutoBackupCheckMs = 0;

// --- cooldown ai persona per bot & chat agar tidak memicu spam beruntun ---
const aiReplyCooldownMap = new Map();
const AI_REPLY_COOLDOWN_MS = 3500;
const EXPIRY_REMINDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_BACKUP_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// --- pelacak velocity request real-time & top active endpoints tanpa data palsu ---
const VELOCITY_BUCKET_SECONDS = 3;
const VELOCITY_HISTORY_PAST_SLOTS = 6;
const velocityHistoryBuckets = Array(VELOCITY_HISTORY_PAST_SLOTS).fill(0);
let currentVelocityBucketCount = 0;
const endpointActivityCounters = new Map();

// --- catat hit asli dari http endpoint maupun pesan/perintah whatsapp ---
export function recordRealtimeActivityHit(methodLabel = 'GET', routePath = '/api/unknown') {
  currentVelocityBucketCount += 1;
  const cleanMethod = String(methodLabel || 'GET').toUpperCase().slice(0, 8);
  const cleanPath = String(routePath || '/').trim().slice(0, 80);
  const counterKey = `${cleanMethod} ${cleanPath}`;
  const existing = endpointActivityCounters.get(counterKey) || {
    method: cleanMethod,
    path: cleanPath,
    hits: 0,
    lastHitAt: 0
  };
  existing.hits += 1;
  existing.lastHitAt = Date.now();
  endpointActivityCounters.set(counterKey, existing);
}

// --- geser jendela bucket velocity setiap 3 detik tanpa duplikasi slot ---
export function advanceTrafficVelocityBucket() {
  velocityHistoryBuckets.shift();
  velocityHistoryBuckets.push(currentVelocityBucketCount);
  currentVelocityBucketCount = 0;
  return getRealtimeTrafficSnapshot();
}

// --- bangun snapshot data live traffic velocity & top active endpoints ---
export function getRealtimeTrafficSnapshot() {
  const series = [...velocityHistoryBuckets, currentVelocityBucketCount];
  const windowTotal = series.reduce((sum, val) => sum + Number(val || 0), 0);
  const totalWindowSec = series.length * VELOCITY_BUCKET_SECONDS;
  const reqPerSec = Math.round((windowTotal / totalWindowSec) * 10) / 10;

  const topEndpoints = Array.from(endpointActivityCounters.values())
    .sort((a, b) => b.hits - a.hits || b.lastHitAt - a.lastHitAt)
    .slice(0, 5);

  return {
    labels: ['-18s', '-15s', '-12s', '-9s', '-6s', '-3s', 'Now'],
    series,
    reqPerSec,
    currentHits: currentVelocityBucketCount,
    topEndpoints,
    timestamp: Date.now()
  };
}

// --- pancarkan pembaruan statistik user & global secara terpusat ---
export function emitUserStatsSnapshot(io, googleUserId, userDatabase) {
  if (!io || !googleUserId || !userDatabase) return;
  io.to(`user_${googleUserId}`).emit('stats:update', {
    userStats: {
      ...userDatabase,
      expiresAt: userDatabase.subscription?.expiresAt || 0
    },
    globalStats: getGlobalPlatformStatistics(activeBotSessions),
    trafficSeries: buildLast7DaysTrafficSeries(userDatabase.trafficHistory),
    topCommands: getTopCommandsLeaderboard(5)
  });
}

// --- pancarkan pembaruan monitor sesi global ke seluruh admin yang terhubung ---
export function emitAdminGlobalSessionsSnapshot(io) {
  if (!io) return;
  try {
    const snapshot = getAllUsersGlobalMonitorSnapshot(activeBotSessions);
    io.to('platform_admins').emit('admin:sessions:data', snapshot);
  } catch {
    // --- abaikan error sementara pemancaran snapshot admin ---
  }
}

// --- pancarkan log terminal ke klien dan simpan riwayat ringkas ---
export function emitTerminalLog(io, googleUserId, logLevel, logMessage) {
  const timestampText = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const logEntry = {
    timestamp: timestampText,
    level: logLevel,
    message: logMessage
  };

  if (!userTerminalLogsCache.has(googleUserId)) {
    userTerminalLogsCache.set(googleUserId, []);
  }
  const userLogs = userTerminalLogsCache.get(googleUserId);
  userLogs.push(logEntry);
  if (userLogs.length > 100) userLogs.shift();

  io.to(`user_${googleUserId}`).emit('terminal:log', logEntry);
}

// --- normalisasi target jid grup maupun nomor whatsapp pribadi ---
export function resolveTargetWhatsappJid(rawTarget) {
  const clean = String(rawTarget || '').trim();
  if (!clean) return null;
  if (/^[\d-]+@g\.us$/i.test(clean)) return clean;
  if (/^\d+@(s\.whatsapp\.net|lid)$/i.test(clean)) return jidNormalizedUser(clean);

  const digits = clean.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 20) return null;
  return `${digits}@s.whatsapp.net`;
}

// --- proses variabel dinamis pada template pesan langsung maupun terjadwal ---
export function formatMessageTemplateVariables(rawMessage, botDatabase) {
  const nowJakarta = new Date();
  const dateLabel = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'full'
  }).format(nowJakarta);
  const timeLabel = `${new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(nowJakarta)} WIB`;

  const botName = botDatabase?.settings?.botName || CONFIG.platformName;
  return String(rawMessage || '')
    .replaceAll('{botName}', botName)
    .replaceAll('{date}', dateLabel)
    .replaceAll('{time}', timeLabel);
}

// --- proses pola spintax {opsi1|opsi2|opsi3} untuk variasi pesan anti-ban ---
export function parseSpintaxText(rawText) {
  let output = String(rawText || '');
  const spintaxRegex = /\{([^{}]+)\}/g;
  let guardCount = 0;

  while (spintaxRegex.test(output) && guardCount < 10) {
    guardCount += 1;
    output = output.replace(spintaxRegex, (_match, groupContent) => {
      const options = String(groupContent).split('|').map((s) => s.trim()).filter(Boolean);
      if (options.length === 0) return '';
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return output;
}

// --- teruskan event pesan masuk ke webhook url milik user secara non-blocking ---
export async function forwardIncomingToUserWebhook(userDatabase, payload) {
  const targetUrl = String(userDatabase?.settings?.webhookUrl || '').trim();
  if (!/^https?:\/\/.+/i.test(targetUrl)) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const headers = { 'Content-Type': 'application/json' };
    if (userDatabase?.settings?.webhookSecret) {
      headers['x-webhook-secret'] = userDatabase.settings.webhookSecret;
    }

    await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch {
    // --- abaikan kegagalan webhook agar tidak memblokir antrean pesan bot ---
  }
}

// --- konversi data url base64 menjadi buffer dan deteksi mimetype ---
function parseBase64MediaInput(rawBase64) {
  const clean = String(rawBase64 || '').trim();
  if (!clean) return null;
  const match = clean.match(/^data:([^;]+);base64,(.+)$/i);
  if (match) {
    return {
      mimetype: match[1],
      buffer: Buffer.from(match[2], 'base64')
    };
  }
  return {
    mimetype: 'application/octet-stream',
    buffer: Buffer.from(clean, 'base64')
  };
}

// --- generator jawaban ai persona yang modular dan dapat dihubungkan ke llm api ---
export async function generateAiPersonaReply({
  systemPrompt = '',
  userMessage = '',
  senderName = 'Pengguna',
  botName = CONFIG.platformName
} = {}) {
  const cleanPrompt = String(systemPrompt || '').trim() ||
    `Kamu adalah asisten WhatsApp ${botName} yang ramah, ringkas, dan membantu dalam Bahasa Indonesia.`;
  const cleanUserMsg = String(userMessage || '').trim().slice(0, 1000);
  if (!cleanUserMsg) return null;

  const customApiUrl = String(process.env.AI_API_URL || '').trim();
  const customApiKey = String(process.env.AI_API_KEY || '').trim();
  const customModel = String(process.env.AI_MODEL || 'gpt-4o-mini').trim();

  if (customApiUrl && customApiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(customApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customApiKey}`
        },
        body: JSON.stringify({
          model: customModel,
          messages: [
            { role: 'system', content: cleanPrompt },
            { role: 'user', content: `[Pengirim: ${senderName}] ${cleanUserMsg}` }
          ],
          temperature: 0.7,
          max_tokens: 400
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.ok) {
        const json = await response.json();
        const text = String(json?.choices?.[0]?.message?.content || '').trim();
        if (text) return text;
      }
    } catch {
      // --- lanjutkan ke fallback penyedia gratis jika api kustom gagal ---
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://text.pollinations.ai/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: `${cleanPrompt}\nJawab singkat dan natural untuk chat WhatsApp.` },
          { role: 'user', content: cleanUserMsg }
        ],
        model: 'openai',
        private: true
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.ok) {
      const replyText = String(await response.text()).trim();
      if (replyText && !replyText.toLowerCase().startsWith('<!doctype html')) {
        return replyText.slice(0, 1500);
      }
    }
  } catch {
    // --- lanjutkan ke fallback respons lokal jika jaringan eksternal tidak terjangkau ---
  }

  const lower = cleanUserMsg.toLowerCase();
  if (/^(halo|hai|hi|assalamualaikum|p|permisi|selamat)/i.test(lower)) {
    return `Halo ${senderName}! Saya asisten otomatis *${botName}*. Ada yang bisa saya bantu hari ini?`;
  }
  if (/(harga|price|beli|sewa|order|daftar)/i.test(lower)) {
    return `Terima kasih sudah menghubungi *${botName}*, ${senderName}. Pesan Anda terkait informasi layanan/order telah kami terima. Silakan sebutkan detail kebutuhan Anda agar segera dibantu.`;
  }
  return `Halo ${senderName}, pesan Anda sudah diterima oleh asisten AI *${botName}*. Saat ini saya membantu berdasarkan panduan sistem kami—silakan jelaskan pertanyaan Anda secara singkat.`;
}

// --- kirim pesan teks atau multi-media asli baileys ke grup atau chat pribadi ---
export async function sendDirectWhatsAppMessage(io, googleUserId, payload = {}) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);
  const activeSession = activeBotSessions.get(googleUserId);

  if (!activeSession || activeSession.status !== 'CONNECTED' || !activeSession.socketInstance) {
    return { isSuccess: false, errorMessage: 'Bot harus dalam status Connected untuk mengirim pesan.' };
  }

  const targetJid = resolveTargetWhatsappJid(payload.targetJid);
  if (!targetJid) {
    return { isSuccess: false, errorMessage: 'Nomor tujuan atau ID Grup (@g.us) tidak valid.' };
  }

  const botDatabase = readBotDatabase(googleUserId);
  const client = activeSession.socketInstance;
  const mediaType = String(payload.mediaType || 'text').trim().toLowerCase();
  const formattedCaption = formatMessageTemplateVariables(payload.caption ?? payload.message ?? '', botDatabase).trim();

  let mentionsList = undefined;
  if (payload.mentionAll && targetJid.endsWith('@g.us')) {
    try {
      let participants = global.db?.metadata?.[targetJid]?.participants || [];
      if (participants.length === 0) {
        const meta = await client.groupMetadata(targetJid).catch(() => null);
        participants = meta?.participants || [];
      }
      const mentionJids = participants
        .map((p) => p?.id)
        .filter((id) => typeof id === 'string' && /(@s\.whatsapp\.net|@lid)$/i.test(id));
      if (mentionJids.length > 0) {
        mentionsList = mentionJids;
      }
    } catch {
      // --- lanjutkan kirim tanpa mentions jika metadata grup gagal diambil ---
    }
  }

  let messageContent = null;

  if (mediaType === 'text') {
    if (!formattedCaption) {
      return { isSuccess: false, errorMessage: 'Isi pesan teks tidak boleh kosong.' };
    }
    messageContent = { text: formattedCaption };
  } else if (['image', 'video', 'audio', 'sticker', 'document'].includes(mediaType)) {
    const parsedBase64 = parseBase64MediaInput(payload.mediaBase64);
    const mediaUrl = String(payload.mediaUrl || '').trim();
    const mediaSource = parsedBase64 ? parsedBase64.buffer : (mediaUrl ? { url: mediaUrl } : null);

    if (!mediaSource) {
      return { isSuccess: false, errorMessage: 'URL media atau file lokal wajib diisi.' };
    }

    if (mediaType === 'image') {
      messageContent = {
        image: mediaSource,
        caption: formattedCaption || undefined,
        mimetype: parsedBase64?.mimetype || payload.mimetype || 'image/jpeg'
      };
    } else if (mediaType === 'video') {
      messageContent = {
        video: mediaSource,
        caption: formattedCaption || undefined,
        mimetype: parsedBase64?.mimetype || payload.mimetype || 'video/mp4'
      };
    } else if (mediaType === 'audio') {
      const isPtt = Boolean(payload.ptt);
      messageContent = {
        audio: mediaSource,
        mimetype: isPtt ? 'audio/ogg; codecs=opus' : (parsedBase64?.mimetype || 'audio/mpeg'),
        ptt: isPtt
      };
    } else if (mediaType === 'sticker') {
      if (typeof client.sendSticker === 'function') {
        try {
          let stickerInput = parsedBase64 ? parsedBase64.buffer : null;
          if (!stickerInput && mediaUrl) {
            const fetched = await fetch(mediaUrl);
            if (!fetched.ok) throw new Error(`Gagal mengunduh URL stiker (HTTP ${fetched.status}).`);
            stickerInput = Buffer.from(await fetched.arrayBuffer());
          }
          if (stickerInput) {
            await client.sendSticker(targetJid, stickerInput, null, {
              packname: botDatabase?.settings?.packname || CONFIG.platformName,
              author: botDatabase?.settings?.author || 'Xu Core'
            });
            recordRealtimeActivityHit('POST', payload.sourceRoute || '/api/whatsapp/direct-send');
            if (io && io.engine.clientsCount > 0) io.emit('traffic:velocity', getRealtimeTrafficSnapshot());
            emitLog(googleUserId, 'SUCCESS', `Pesan [STICKER] terkirim ke [${targetJid.split('@')[0]}].`);
            return { isSuccess: true, targetJid, messageId: null };
          }
        } catch (stickerErr) {
          emitLog(googleUserId, 'WARN', `Fallback sendMessage sticker: ${stickerErr.message}`);
        }
      }
      messageContent = { sticker: mediaSource };
    } else if (mediaType === 'document') {
      messageContent = {
        document: mediaSource,
        fileName: String(payload.fileName || 'document').trim(),
        mimetype: String(payload.mimetype || parsedBase64?.mimetype || 'application/octet-stream').trim(),
        caption: formattedCaption || undefined
      };
    }
  } else if (mediaType === 'location') {
    const loc = payload.location || {};
    messageContent = {
      location: {
        degreesLatitude: Number(loc.degreesLatitude || 0),
        degreesLongitude: Number(loc.degreesLongitude || 0),
        name: String(loc.name || '').trim() || undefined,
        address: String(loc.address || '').trim() || undefined
      }
    };
  } else if (mediaType === 'contact') {
    const contact = payload.contact || {};
    const cleanPhone = String(contact.phoneNumber || '').replace(/\D/g, '');
    const displayName = String(contact.fullName || 'Kontak').trim();
    if (!cleanPhone) {
      return { isSuccess: false, errorMessage: 'Nomor kontak WhatsApp tidak valid.' };
    }
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${displayName}`,
      `TEL;type=CELL;type=VOICE;waid=${cleanPhone}:+${cleanPhone}`,
      'END:VCARD'
    ].join('\n');
    messageContent = {
      contacts: {
        displayName,
        contacts: [{ vcard }]
      }
    };
  } else {
    return { isSuccess: false, errorMessage: `Tipe media [${mediaType}] tidak didukung.` };
  }

  if (mentionsList) {
    messageContent.mentions = mentionsList;
  }

  try {
    const sentMsg = await client.sendMessage(targetJid, messageContent);
    recordRealtimeActivityHit('POST', payload.sourceRoute || '/api/whatsapp/direct-send');
    if (io && io.engine.clientsCount > 0) {
      io.emit('traffic:velocity', getRealtimeTrafficSnapshot());
    }
    const shortTarget = targetJid.split('@')[0];
    emitLog(
      googleUserId,
      'SUCCESS',
      `Pesan [${mediaType.toUpperCase()}] terkirim ke [${shortTarget}]${mentionsList ? ' (Mention All)' : ''}.`
    );
    return { isSuccess: true, targetJid, messageId: sentMsg?.key?.id || null };
  } catch (sendError) {
    emitLog(googleUserId, 'ERROR', `Gagal mengirim pesan [${mediaType.toUpperCase()}] ke [${targetJid.split('@')[0]}]: ${sendError.message}`);
    return { isSuccess: false, errorMessage: sendError.message || 'Gagal mengirim pesan.' };
  }
}

// --- cari socket whatsapp aktif (prioritas milik user, lalu admin, lalu sesi connected mana saja) ---
function findAvailableDeliverySocket(preferredGoogleUserId = null) {
  if (preferredGoogleUserId) {
    const ownSession = activeBotSessions.get(preferredGoogleUserId);
    if (ownSession?.status === 'CONNECTED' && ownSession.socketInstance) {
      return { senderUserId: preferredGoogleUserId, socketInstance: ownSession.socketInstance };
    }
  }

  for (const [uid, sess] of activeBotSessions.entries()) {
    if (sess?.status === 'CONNECTED' && sess.socketInstance && isPlatformAdminById(uid)) {
      return { senderUserId: uid, socketInstance: sess.socketInstance };
    }
  }

  for (const [uid, sess] of activeBotSessions.entries()) {
    if (sess?.status === 'CONNECTED' && sess.socketInstance) {
      return { senderUserId: uid, socketInstance: sess.socketInstance };
    }
  }

  return null;
}

// --- kirim kode otp reset password ke nomor whatsapp owner terdaftar ---
export async function sendSystemOtpWhatsAppMessage(io, { preferredUserId = null, targetPhone = '', email = '', otpCode = '' } = {}) {
  const targetJid = resolveTargetWhatsappJid(targetPhone);
  if (!targetJid) {
    return { isSuccess: false, errorMessage: 'Nomor WhatsApp tujuan tidak valid.' };
  }

  const delivery = findAvailableDeliverySocket(preferredUserId);
  if (!delivery) {
    return {
      isSuccess: false,
      errorMessage: 'Tidak ada sesi bot WhatsApp aktif di server untuk mengirim OTP. Hubungi admin.'
    };
  }

  const otpText =
    `*[XU CORE — KEAMANAN AKUN]*\n\n` +
    `Permintaan reset kata sandi untuk akun:\n` +
    `• Email: ${email}\n` +
    `• Kode OTP: *${otpCode}*\n\n` +
    `Kode berlaku selama *10 menit*. Jangan bagikan kode ini kepada siapa pun.`;

  try {
    await delivery.socketInstance.sendMessage(targetJid, { text: otpText });
    if (io) {
      emitTerminalLog(io, delivery.senderUserId, 'INFO', `OTP reset password untuk [${email}] terkirim ke +${targetPhone}.`);
    }
    return { isSuccess: true, sentViaUserId: delivery.senderUserId };
  } catch (err) {
    return { isSuccess: false, errorMessage: `Gagal mengirim OTP ke WhatsApp: ${err.message}` };
  }
}

// --- bersihkan file cache sesi baileys (pre-key, sender-key, session) tanpa menghapus creds.json ---
export function clearUserSessionPreKeys(io, googleUserId) {
  const discovered = findValidUserSession(googleUserId);
  const userDb = readBotDatabase(googleUserId);
  const folderPath = discovered?.folderPath || getUserSessionFolderPath(googleUserId, userDb.sessionName);

  if (!folderPath || !fs.existsSync(folderPath)) {
    return {
      isSuccess: false,
      deletedCount: 0,
      freedBytes: 0,
      freedLabel: '0 B',
      errorMessage: 'Folder sesi WhatsApp belum ditemukan di volume.'
    };
  }

  const targetCachePattern = /^(pre-key|sender-key|session)-.*\.json$/i;
  let deletedCount = 0;
  let freedBytes = 0;

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      if (lowerName === 'creds.json' || lowerName === '.owner.json') continue;
      if (!targetCachePattern.test(entry.name)) continue;

      const fullFilePath = path.join(folderPath, entry.name);
      try {
        const size = fs.statSync(fullFilePath).size;
        fs.unlinkSync(fullFilePath);
        deletedCount += 1;
        freedBytes += size;
      } catch {
        // --- abaikan file yang sedang terkunci ---
      }
    }

    const freedLabel = formatBytesReadable(freedBytes);
    if (io) {
      emitTerminalLog(
        io,
        googleUserId,
        'SUCCESS',
        `Cache sesi dibersihkan: ${deletedCount} file (${freedLabel}) dihapus. creds.json tetap aman.`
      );
      emitAdminGlobalSessionsSnapshot(io);
    }

    return {
      isSuccess: true,
      deletedCount,
      freedBytes,
      freedLabel,
      sessionFolder: folderPath
    };
  } catch (err) {
    return {
      isSuccess: false,
      deletedCount: 0,
      freedBytes: 0,
      freedLabel: '0 B',
      errorMessage: `Gagal membersihkan cache sesi: ${err.message}`
    };
  }
}

// --- buat arsip zip database.json dan plugins lalu kirim otomatis ke whatsapp admin ---
export async function runScheduledAutoBackupToAdmin(io, forceNow = false) {
  const masterDb = readMasterDatabaseFile();
  const backupCfg = masterDb.autoBackup || { enabled: false, intervalHours: 24, lastRunAt: 0 };

  if (!forceNow) {
    if (!backupCfg.enabled) return { isSuccess: false, skipped: true };
    const intervalMs = Math.max(1, Number(backupCfg.intervalHours || 24)) * 60 * 60 * 1000;
    if (Date.now() - Number(backupCfg.lastRunAt || 0) < intervalMs) {
      return { isSuccess: false, skipped: true };
    }
  }

  const delivery = findAvailableDeliverySocket(null);
  const adminJid = resolveTargetWhatsappJid(backupCfg.targetWaNumber || ADMIN_WA_NUMBER);
  if (!delivery || !adminJid) {
    return { isSuccess: false, errorMessage: 'Tidak ada sesi bot aktif atau nomor WA admin tidak valid.' };
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
    const fileName = `xu-core-autobackup-${stamp}.zip`;

    await delivery.socketInstance.sendMessage(adminJid, {
      document: archiveBuffer,
      fileName,
      mimetype: 'application/zip',
      caption: `*[XU CORE — AUTO BACKUP]*\nArsip database.json & ${pluginFiles.length} plugin (${formatBytesReadable(archiveBuffer.length)}).`
    });

    const latestMaster = readMasterDatabaseFile();
    latestMaster.autoBackup = {
      ...(latestMaster.autoBackup || {}),
      enabled: Boolean(backupCfg.enabled),
      intervalHours: Number(backupCfg.intervalHours || 24),
      targetWaNumber: String(backupCfg.targetWaNumber || ADMIN_WA_NUMBER),
      lastRunAt: Date.now(),
      lastFileName: fileName,
      lastSizeLabel: formatBytesReadable(archiveBuffer.length)
    };
    writeMasterDatabaseFileAtomic(latestMaster);

    if (io) {
      emitTerminalLog(io, delivery.senderUserId, 'SUCCESS', `Auto-Backup ZIP [${fileName}] terkirim ke WA Admin.`);
    }
    return { isSuccess: true, fileName, sizeLabel: formatBytesReadable(archiveBuffer.length) };
  } catch (err) {
    return { isSuccess: false, errorMessage: err.message };
  }
}

// --- hitung waktu eksekusi berikutnya untuk jadwal harian berbasis zona Asia/Jakarta ---
export function computeNextJakartaDailyTimestamp(timeHHMM, fromMs = Date.now()) {
  const [rawHour, rawMinute] = String(timeHHMM || '08:00').split(':').map((n) => parseInt(n, 10));
  const hour = Number.isFinite(rawHour) ? Math.max(0, Math.min(23, rawHour)) : 8;
  const minute = Number.isFinite(rawMinute) ? Math.max(0, Math.min(59, rawMinute)) : 0;

  const jakartaDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(fromMs));

  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  let candidateMs = Date.parse(`${jakartaDateStr}T${hh}:${mm}:00+07:00`);

  if (Number.isNaN(candidateMs) || candidateMs <= fromMs + 5000) {
    candidateMs = (Number.isNaN(candidateMs) ? fromMs : candidateMs) + 24 * 60 * 60 * 1000;
  }
  return candidateMs;
}

// --- cek dan kirim pengingat masa aktif otomatis h-3 dan h-1 ke nomor owner terdaftar ---
async function processSubscriptionExpiryReminders(io, nowMs) {
  if (nowMs - lastExpiryReminderCheckMs < EXPIRY_REMINDER_CHECK_INTERVAL_MS) {
    return;
  }
  lastExpiryReminderCheckMs = nowMs;

  const masterDb = readMasterDatabaseFile();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const THREE_DAYS_MS = 3 * ONE_DAY_MS;

  for (const googleUserId of Object.keys(masterDb.users || {})) {
    if (isPlatformAdminById(googleUserId)) continue;

    const userDb = readBotDatabase(googleUserId);
    const sub = userDb.subscription || {};
    const expiresAt = Number(sub.expiresAt || 0);
    if (expiresAt <= nowMs) continue;

    const remainingMs = expiresAt - nowMs;
    const isWithinH3 = remainingMs <= THREE_DAYS_MS && remainingMs > ONE_DAY_MS;
    const isWithinH1 = remainingMs <= ONE_DAY_MS;

    let reminderStage = null;
    if (isWithinH1 && !sub.notifiedH1) {
      reminderStage = 'H-1';
    } else if (isWithinH3 && !sub.notifiedH3) {
      reminderStage = 'H-3';
    }

    if (!reminderStage) continue;

    const ownerCandidates = [
      ...(Array.isArray(userDb.settings?.owners) ? userDb.settings.owners : []),
      userDb.phoneNumber
    ]
      .map((n) => String(n || '').replace(/\D/g, ''))
      .filter((n) => n.length >= 8);

    const targetOwnerNumber = ownerCandidates[0];
    if (!targetOwnerNumber) continue;

    const delivery = findAvailableDeliverySocket(googleUserId);
    if (!delivery) continue;

    const targetJid = resolveTargetWhatsappJid(targetOwnerNumber);
    if (!targetJid) continue;

    const expiryLabel = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'full',
      timeStyle: 'short'
    }).format(new Date(expiresAt));

    const reminderText =
      `*[XU CORE — PENGINGAT MASA AKTIF ${reminderStage}]*\n\n` +
      `Halo Owner *${userDb.settings?.botName || CONFIG.platformName}*,\n` +
      `Masa aktif langganan bot Anda (*${sub.plan || 'Starter'}*) akan berakhir pada:\n` +
      `• *${expiryLabel} WIB*\n\n` +
      `Segera lakukan perpanjangan melalui Dashboard Xu Core atau klaim kode voucher Anda agar koneksi bot tidak terputus otomatis.\n` +
      `• Admin WA: https://wa.me/${ADMIN_WA_NUMBER}`;

    try {
      await delivery.socketInstance.sendMessage(targetJid, { text: reminderText });
      userDb.subscription = {
        ...sub,
        notifiedH3: reminderStage === 'H-3' ? true : Boolean(sub.notifiedH3),
        notifiedH1: reminderStage === 'H-1' ? true : Boolean(sub.notifiedH1),
        lastNotifiedExpiresAt: expiresAt
      };
      writeBotDatabaseAtomic(googleUserId, userDb);
      emitTerminalLog(
        io,
        googleUserId,
        'WARN',
        `Pengingat masa aktif [${reminderStage}] otomatis terkirim ke +${targetOwnerNumber}.`
      );
      emitUserStatsSnapshot(io, googleUserId, userDb);
    } catch {
      // --- coba lagi pada siklus pengecekan berikutnya jika pengiriman gagal ---
    }
  }
}

// --- worker latar belakang untuk jadwal pesan, notifikasi h-3/h-1, dan auto-backup zip ---
export function startMessageSchedulerWorker(io) {
  if (schedulerWorkerInterval) return;

  schedulerWorkerInterval = setInterval(async () => {
    try {
      const nowMs = Date.now();
      const masterDb = readMasterDatabaseFile();

      for (const googleUserId of Object.keys(masterDb.users || {})) {
        const activeSession = activeBotSessions.get(googleUserId);
        if (!activeSession || activeSession.status !== 'CONNECTED' || !activeSession.socketInstance) {
          continue;
        }

        const userDatabase = readBotDatabase(googleUserId);
        if (isBotSubscriptionExpired(googleUserId, userDatabase)) continue;

        const schedules = Array.isArray(userDatabase.scheduledMessages) ? userDatabase.scheduledMessages : [];
        if (schedules.length === 0) continue;

        let hasChanges = false;
        const updatedSchedules = [];

        for (const item of schedules) {
          if (!item || !item.isActive || Number(item.nextRunAt || 0) > nowMs) {
            updatedSchedules.push(item);
            continue;
          }

          const sendResult = await sendDirectWhatsAppMessage(io, googleUserId, {
            targetJid: item.targetJid,
            message: item.message,
            mentionAll: Boolean(item.mentionAll),
            sourceRoute: '/api/whatsapp/scheduler'
          });

          hasChanges = true;
          const nextItem = {
            ...item,
            lastRunAt: nowMs,
            runCount: Number(item.runCount || 0) + 1,
            lastStatus: sendResult.isSuccess ? 'SENT' : 'FAILED'
          };

          if (item.repeatType === 'daily') {
            nextItem.nextRunAt = computeNextJakartaDailyTimestamp(item.dailyTime || '08:00', nowMs);
          } else if (item.repeatType === 'interval') {
            const intervalMinutes = Math.max(1, Number(item.intervalMinutes || 60));
            nextItem.nextRunAt = nowMs + intervalMinutes * 60 * 1000;
          } else {
            nextItem.isActive = false;
            nextItem.lastStatus = sendResult.isSuccess ? 'COMPLETED' : 'FAILED';
          }

          updatedSchedules.push(nextItem);
        }

        if (hasChanges) {
          userDatabase.scheduledMessages = updatedSchedules;
          writeBotDatabaseAtomic(googleUserId, userDatabase);
          io.to(`user_${googleUserId}`).emit('schedule:list', updatedSchedules);
        }
      }

      await processSubscriptionExpiryReminders(io, nowMs);

      if (nowMs - lastAutoBackupCheckMs >= AUTO_BACKUP_CHECK_INTERVAL_MS) {
        lastAutoBackupCheckMs = nowMs;
        await runScheduledAutoBackupToAdmin(io, false);
      }
    } catch {
      // --- jaga worker scheduler tetap berjalan meski ada gangguan iterasi ---
    }
  }, 15000);

  schedulerWorkerInterval.unref();
}

// --- ambil 5 perintah paling populer dari global.db.statistic ---
export function getTopCommandsLeaderboard(limitCount = 5) {
  const statsMap = global.db?.statistic || {};
  return Object.entries(statsMap)
    .map(([cmdKey, info]) => ({
      name: info?.name || cmdKey,
      hit: Number(info?.hit || 0),
      hittoday: Number(info?.hittoday || 0),
      lastused: Number(info?.lastused || 0)
    }))
    .filter((item) => item.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, limitCount);
}

// --- cek apakah masa aktif langganan bot sudah habis (admin bebas batas) ---
export function isBotSubscriptionExpired(googleUserId, botDatabase) {
  if (isPlatformAdminById(googleUserId)) return false;
  const expiresAt = Number(botDatabase?.subscription?.expiresAt || 0);
  if (expiresAt <= 0) return false;
  return Date.now() > expiresAt;
}

// --- sinkronkan pengaturan dashboard dan daftar owner ke global.db.setting ---
export function syncBotSettingsToGlobalDb(botJid, settingsObject) {
  if (!botJid || !settingsObject) return;
  global.db = global.db || {};
  global.db.setting = global.db.setting || {};

  const formattedOwners = (Array.isArray(settingsObject.owners) ? settingsObject.owners : [])
    .map((num) => String(num).replace(/\D/g, ''))
    .filter((num) => num.length >= 6)
    .map((num) => `${num}@s.whatsapp.net`);

  global.db.setting[botJid] = {
    ...(global.db.setting[botJid] || {}),
    botName: settingsObject.botName || CONFIG.platformName,
    packname: settingsObject.packname || CONFIG.platformName,
    author: settingsObject.author || 'Surya Core',
    isNoPrefix: settingsObject.isNoPrefix ?? true,
    allowedPc: settingsObject.allowedPc ?? true,
    isAiEnabled: Boolean(settingsObject.isAiEnabled),
    aiSystemPrompt: String(settingsObject.aiSystemPrompt || ''),
    owners: formattedOwners,
    toxic: Array.isArray(settingsObject.toxic) ? settingsObject.toxic : []
  };
}

// --- validasi folder sesi terdaftar dan simpan metadata pemilik ---
function isValidRegisteredSession(sessionFolderPath) {
  const credsPath = path.join(sessionFolderPath, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const parsedCreds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return Boolean(parsedCreds && (parsedCreds.registered === true || parsedCreds.me?.id));
  } catch {
    return false;
  }
}

function writeSessionOwnerMetadata(sessionFolderPath, googleUserId, sessionName, phoneNumber = null) {
  try {
    fs.mkdirSync(sessionFolderPath, { recursive: true });
    const ownerFilePath = path.join(sessionFolderPath, '.owner.json');
    const tempOwnerPath = `${ownerFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tempOwnerPath,
      JSON.stringify({ googleUserId, sessionName, phoneNumber: phoneNumber || null, updatedAt: Date.now() }, null, 2),
      'utf-8'
    );
    fs.renameSync(tempOwnerPath, ownerFilePath);
  } catch {
    // --- abaikan error penulisan metadata pemilik ---
  }
}

function readSessionOwnerMetadata(sessionFolderPath) {
  const ownerFilePath = path.join(sessionFolderPath, '.owner.json');
  if (!fs.existsSync(ownerFilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ownerFilePath, 'utf-8'));
  } catch {
    return null;
  }
}

// --- tutup listener dan akhiri socket lama secara bersih ---
function cleanupSocketListenersAndEnd(socketInstance) {
  if (!socketInstance) return;
  try {
    socketInstance.ev.removeAllListeners('connection.update');
    socketInstance.ev.removeAllListeners('creds.update');
    socketInstance.ev.removeAllListeners('messages.upsert');
    socketInstance.ev.removeAllListeners('groups.upsert');
    socketInstance.ev.removeAllListeners('groups.update');
    socketInstance.ev.removeAllListeners('group-participants.update');
    socketInstance.end(undefined);
  } catch {
    // --- abaikan error penutupan socket ---
  }
}

// --- cari folder sesi terdaftar milik akun google ---
export function findValidUserSession(googleUserId) {
  const userDatabase = readBotDatabase(googleUserId);
  const candidateNames = [userDatabase.sessionName, userDatabase.phoneNumber, `qr_${googleUserId}`].filter(Boolean);

  for (const candidateName of candidateNames) {
    const candidateFolder = getUserSessionFolderPath(googleUserId, candidateName);
    if (isValidRegisteredSession(candidateFolder)) {
      if (userDatabase.sessionName !== candidateName) {
        userDatabase.sessionName = candidateName;
        writeBotDatabaseAtomic(googleUserId, userDatabase);
      }
      writeSessionOwnerMetadata(candidateFolder, googleUserId, candidateName, userDatabase.phoneNumber);
      return { sessionName: candidateName, folderPath: candidateFolder };
    }
  }

  if (!fs.existsSync(SESSIONS_ROOT_FOLDER_PATH)) return null;

  for (const entry of fs.readdirSync(SESSIONS_ROOT_FOLDER_PATH, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    const folderPath = path.join(SESSIONS_ROOT_FOLDER_PATH, folderName);
    if (!isValidRegisteredSession(folderPath)) continue;

    const ownerMeta = readSessionOwnerMetadata(folderPath);
    let isMatchedByPhone = false;
    if (userDatabase.phoneNumber) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(folderPath, 'creds.json'), 'utf-8'));
        const credsPhone = String(creds?.me?.id || '').split(':')[0].split('@')[0];
        isMatchedByPhone = credsPhone === userDatabase.phoneNumber;
      } catch {
        isMatchedByPhone = false;
      }
    }

    if (ownerMeta?.googleUserId === googleUserId || folderName.includes(googleUserId) || isMatchedByPhone) {
      userDatabase.sessionName = folderName;
      writeBotDatabaseAtomic(googleUserId, userDatabase);
      writeSessionOwnerMetadata(folderPath, googleUserId, folderName, userDatabase.phoneNumber);
      return { sessionName: folderName, folderPath };
    }
  }

  return null;
}

function clearSessionTimers(sessionRecord) {
  if (!sessionRecord) return;
  if (sessionRecord.reconnectTimer) {
    clearTimeout(sessionRecord.reconnectTimer);
    sessionRecord.reconnectTimer = null;
  }
  if (sessionRecord.connectTimeoutTimer) {
    clearTimeout(sessionRecord.connectTimeoutTimer);
    sessionRecord.connectTimeoutTimer = null;
  }
}

// --- kloning objek aman berbasis spread untuk menjaga Uint8Array dan mediaKey ---
function cloneSafeObject(sourceObject) {
  if (!sourceObject || typeof sourceObject !== 'object') return sourceObject;
  if (sourceObject instanceof Uint8Array || Buffer.isBuffer(sourceObject)) return sourceObject;
  return { ...sourceObject };
}

// --- serialisasi pesan menggunakan system/serialize.js atau serializer bawaan aman ---
async function serializeIncomingMessage(coreModules, client, rawMessage) {
  if (typeof coreModules.serialize === 'function') {
    try {
      const serialized = await coreModules.serialize(client, rawMessage, coreModules.store);
      if (serialized && typeof serialized === 'object') {
        if (!serialized.command && serialized.cmd) serialized.command = serialized.cmd;
        if (typeof serialized.reply !== 'function') {
          Object.defineProperty(serialized, 'reply', {
            value: async (text) =>
              await client.sendMessage(serialized.chat || rawMessage.key.remoteJid, { text: String(text) }, { quoted: rawMessage }),
            configurable: true
          });
        }
        return serialized;
      }
    } catch {
      // --- gunakan fallback serializer jika serializer eksternal bermasalah ---
    }
  }

  const chat = rawMessage.key.remoteJid;
  const fromMe = Boolean(rawMessage.key.fromMe);
  const sender = jidNormalizedUser(rawMessage.key.participant || chat);
  const messageContent = rawMessage.message || {};
  const messageType =
    Object.keys(messageContent).find((key) => key !== 'messageContextInfo' && key !== 'senderKeyDistributionMessage') || '';

  const body =
    messageContent.conversation ||
    messageContent.extendedTextMessage?.text ||
    messageContent.imageMessage?.caption ||
    messageContent.videoMessage?.caption ||
    messageContent.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    '';

  const trimmedBody = body.trim();
  let matchedPrefix = '';
  if (CONFIG.prefixes instanceof RegExp) {
    const regexMatch = trimmedBody.match(CONFIG.prefixes);
    matchedPrefix = regexMatch ? regexMatch[0] : '';
  } else if (Array.isArray(CONFIG.prefixes)) {
    matchedPrefix = CONFIG.prefixes.find((prefix) => trimmedBody.startsWith(prefix)) || '';
  }

  const withoutPrefix = matchedPrefix ? trimmedBody.slice(matchedPrefix.length).trim() : trimmedBody;
  const parts = withoutPrefix ? withoutPrefix.split(/\s+/) : [];
  const command = matchedPrefix && parts.length > 0 ? parts[0].toLowerCase() : '';
  const args = matchedPrefix ? parts.slice(1) : [];
  const text = args.join(' ');

  const contextInfo = messageContent[messageType]?.contextInfo || null;
  let quoted = null;
  if (contextInfo?.quotedMessage) {
    const rawQuoted = cloneSafeObject(contextInfo.quotedMessage);
    const quotedType = Object.keys(rawQuoted)[0] || '';
    const quotedMedia = rawQuoted[quotedType] ? cloneSafeObject(rawQuoted[quotedType]) : null;
    quoted = {
      id: contextInfo.stanzaId || '',
      chat,
      sender: jidNormalizedUser(contextInfo.participant || chat),
      mtype: quotedType,
      msg: quotedMedia,
      message: rawQuoted,
      text: rawQuoted.conversation || quotedMedia?.text || quotedMedia?.caption || ''
    };
  }

  return {
    key: rawMessage.key,
    id: rawMessage.key.id,
    chat,
    sender,
    fromMe,
    isGroup: chat.endsWith('@g.us'),
    mtype: messageType,
    msg: cloneSafeObject(messageContent[messageType]),
    body,
    prefix: matchedPrefix,
    command,
    cmd: command,
    args,
    text,
    quoted,
    mentionedJid: Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [],
    pushname: rawMessage.pushName || 'Pengguna',
    raw: rawMessage,
    reply: async (replyText) =>
      await client.sendMessage(chat, { text: String(replyText) }, { quoted: rawMessage })
  };
}

// --- mulai koneksi whatsapp baileys dengan cek masa aktif, auto-connect, dan fallback ---
export async function startWhatsAppSession(
  io,
  coreModules,
  googleUserId,
  connectionMethod = 'qr',
  phoneNumberInput = '',
  attemptCount = 1,
  forceRestart = false
) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);
  const botDatabase = readBotDatabase(googleUserId);

  if (isBotSubscriptionExpired(googleUserId, botDatabase)) {
    emitLog(googleUserId, 'ERROR', 'Masa aktif langganan bot Anda telah habis. Silakan perpanjang paket untuk menyalakan bot.');
    io.to(`user_${googleUserId}`).emit('connection:status', {
      status: 'DISCONNECTED',
      profile: null,
      isAutoReconnect: false,
      reason: 'SUBSCRIPTION_EXPIRED'
    });
    return;
  }

  const existingSession = activeBotSessions.get(googleUserId);
  const isAutoReconnect = connectionMethod === 'reconnect';

  if (existingSession) {
    if (!forceRestart && existingSession.status === 'CONNECTED' && existingSession.socketInstance) {
      io.to(`user_${googleUserId}`).emit('connection:status', {
        status: 'CONNECTED',
        profile: existingSession.profile,
        isAutoReconnect: false
      });
      return;
    }

    if (isAutoReconnect && !forceRestart && existingSession.status === 'CONNECTING') {
      io.to(`user_${googleUserId}`).emit('connection:status', {
        status: 'CONNECTING',
        profile: null,
        isAutoReconnect: Boolean(existingSession.isAutoReconnect)
      });
      return;
    }

    clearSessionTimers(existingSession);
    cleanupSocketListenersAndEnd(existingSession.socketInstance);
  }

  const cleanedPhoneInput = String(phoneNumberInput || '').replace(/[^0-9]/g, '');
  let activeSessionName = botDatabase.sessionName;

  if (connectionMethod === 'pairing' && cleanedPhoneInput) {
    const targetFolder = getUserSessionFolderPath(googleUserId, cleanedPhoneInput);
    const hasExistingCreds = isValidRegisteredSession(targetFolder);

    if (!hasExistingCreds && activeSessionName && activeSessionName !== cleanedPhoneInput) {
      const previousFolder = getUserSessionFolderPath(googleUserId, activeSessionName);
      if (fs.existsSync(previousFolder)) {
        fs.rmSync(previousFolder, { recursive: true, force: true });
      }
    }

    activeSessionName = cleanedPhoneInput;
    botDatabase.phoneNumber = cleanedPhoneInput;
    botDatabase.sessionName = activeSessionName;
    writeBotDatabaseAtomic(googleUserId, botDatabase);
  } else if (isAutoReconnect) {
    const discoveredSession = findValidUserSession(googleUserId);
    if (!discoveredSession) {
      activeBotSessions.delete(googleUserId);
      io.to(`user_${googleUserId}`).emit('connection:status', {
        status: 'DISCONNECTED',
        profile: null,
        isAutoReconnect: false
      });
      return;
    }
    activeSessionName = discoveredSession.sessionName;
  } else if (!activeSessionName) {
    activeSessionName = botDatabase.phoneNumber || `qr_${googleUserId}`;
    botDatabase.sessionName = activeSessionName;
    writeBotDatabaseAtomic(googleUserId, botDatabase);
  }

  const userSessionFolder = getUserSessionFolderPath(googleUserId, activeSessionName);
  fs.mkdirSync(userSessionFolder, { recursive: true });
  writeSessionOwnerMetadata(userSessionFolder, googleUserId, activeSessionName, botDatabase.phoneNumber);

  const sessionRecord = {
    socketInstance: null,
    status: 'CONNECTING',
    profile: null,
    sessionName: activeSessionName,
    isAutoReconnect,
    wasPreviouslyConnected: Boolean(existingSession?.wasPreviouslyConnected),
    attemptCount,
    reconnectTimer: null,
    connectTimeoutTimer: null,
    isDeletingSession: false
  };
  activeBotSessions.set(googleUserId, sessionRecord);

  io.to(`user_${googleUserId}`).emit('connection:status', {
    status: 'CONNECTING',
    profile: null,
    isAutoReconnect
  });
  emitAdminGlobalSessionsSnapshot(io);
  emitLog(googleUserId, 'INFO', `Menyiapkan koneksi Baileys [${connectionMethod.toUpperCase()}] sesi: ${activeSessionName}`);

  if (isAutoReconnect) {
    sessionRecord.connectTimeoutTimer = setTimeout(() => {
      const latestRecord = activeBotSessions.get(googleUserId);
      if (!latestRecord || latestRecord !== sessionRecord || latestRecord.status === 'CONNECTED' || latestRecord.isDeletingSession) {
        return;
      }

      clearSessionTimers(latestRecord);
      cleanupSocketListenersAndEnd(latestRecord.socketInstance);
      activeBotSessions.delete(googleUserId);
      emitLog(googleUserId, 'WARN', 'Auto-connect melebihi batas waktu. Kembali ke mode Disconnected.');
      io.to(`user_${googleUserId}`).emit('connection:status', {
        status: 'DISCONNECTED',
        profile: null,
        isAutoReconnect: false
      });
      emitAdminGlobalSessionsSnapshot(io);
    }, AUTO_CONNECT_TIMEOUT_MS);
  }

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionFolder);
    const { version: latestVersion } = await fetchLatestBaileysVersion();

    if (activeBotSessions.get(googleUserId) !== sessionRecord || sessionRecord.isDeletingSession) {
      return;
    }

    const client = makeWASocket({
      version: latestVersion,
      logger: silentLogger,
      printQRInTerminal: false,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, silentLogger)
      },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    extraInstance.registerComponents(client);

    // --- intercept pengiriman pesan untuk menghitung statistik, trafik, dan live velocity ---
    const originalSendMessage = client.sendMessage.bind(client);
    client.sendMessage = async (recipientJid, messageContent, messageOptions = {}) => {
      const sendResult = await originalSendMessage(recipientJid, messageContent, messageOptions);
      recordRealtimeActivityHit('POST', '/api/whatsapp/send');
      if (io.engine.clientsCount > 0) {
        io.emit('traffic:velocity', getRealtimeTrafficSnapshot());
      }
      const latestDatabase = readBotDatabase(googleUserId);
      latestDatabase.totalMessagesSent += 1;
      incrementDailyTrafficRecord(latestDatabase, 'out');
      writeBotDatabaseAtomic(googleUserId, latestDatabase);
      emitUserStatsSnapshot(io, googleUserId, latestDatabase);
      return sendResult;
    };

    sessionRecord.socketInstance = client;

    if (connectionMethod === 'pairing' && cleanedPhoneInput && !client.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const currentRecord = activeBotSessions.get(googleUserId);
          if (!currentRecord || currentRecord !== sessionRecord || currentRecord.isDeletingSession || client.authState.creds.registered) {
            return;
          }
          const rawCode = await client.requestPairingCode(cleanedPhoneInput);
          const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
          io.to(`user_${googleUserId}`).emit('pairing:code', formattedCode);
          emitLog(googleUserId, 'SUCCESS', `Kode Pairing diterbitkan: ${formattedCode}`);
        } catch (pairingError) {
          emitLog(googleUserId, 'ERROR', `Gagal meminta kode pairing: ${pairingError.message}`);
          io.to(`user_${googleUserId}`).emit('pairing:error', 'Gagal menerbitkan kode pairing. Periksa nomor Anda.');
        }
      }, 2500);
    }

    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', async (connectionState) => {
      const currentRecord = activeBotSessions.get(googleUserId);
      if (!currentRecord || currentRecord !== sessionRecord || currentRecord.isDeletingSession) {
        return;
      }

      const { connection, lastDisconnect, qr } = connectionState;

      if (qr && isAutoReconnect) {
        clearSessionTimers(currentRecord);
        cleanupSocketListenersAndEnd(client);
        activeBotSessions.delete(googleUserId);
        emitLog(googleUserId, 'WARN', 'Sesi tersimpan membutuhkan tautan ulang. Kembali ke mode Disconnected.');
        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'DISCONNECTED',
          profile: null,
          isAutoReconnect: false,
          reason: 'RELINK_REQUIRED'
        });
        emitAdminGlobalSessionsSnapshot(io);
        return;
      }

      if (qr && connectionMethod === 'qr' && !client.authState.creds.registered) {
        try {
          const qrImageDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 280,
            color: { dark: '#090d16', light: '#ffffff' }
          });
          io.to(`user_${googleUserId}`).emit('qr:update', qrImageDataUrl);
          emitLog(googleUserId, 'INFO', `QR Code dimuat untuk sesi: ${activeSessionName}`);
        } catch (qrRenderError) {
          emitLog(googleUserId, 'ERROR', `Gagal membuat QR Code: ${qrRenderError.message}`);
        }
      }

      if (connection === 'open') {
        clearSessionTimers(currentRecord);

        const normalizedBotJid = jidNormalizedUser(client.user?.id || '');
        const cleanPhoneNumber = normalizedBotJid.split('@')[0];
        const whatsappName = client.user?.name || client.user?.verifiedName || CONFIG.platformName;

        if (client.user) {
          client.user.jid = normalizedBotJid;
        }

        if (coreModules.socket && typeof coreModules.socket.set === 'function') {
          coreModules.socket.set(normalizedBotJid, client);
        }

        const latestDatabase = readBotDatabase(googleUserId);
        latestDatabase.phoneNumber = cleanPhoneNumber;
        latestDatabase.sessionName = activeSessionName;
        writeBotDatabaseAtomic(googleUserId, latestDatabase);
        writeSessionOwnerMetadata(userSessionFolder, googleUserId, activeSessionName, cleanPhoneNumber);
        syncBotSettingsToGlobalDb(normalizedBotJid, latestDatabase.settings);

        let avatarImageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(whatsappName)}&background=10b981&color=fff&size=128`;
        try {
          const fetchedAvatar = await Promise.race([
            client.profilePictureUrl(normalizedBotJid, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AvatarTimeout')), 3000))
          ]);
          if (fetchedAvatar) avatarImageUrl = fetchedAvatar;
        } catch {
          // --- gunakan avatar fallback jika gagal memuat foto profil ---
        }

        const connectedProfile = {
          name: whatsappName,
          number: cleanPhoneNumber,
          avatarUrl: avatarImageUrl
        };

        currentRecord.status = 'CONNECTED';
        currentRecord.profile = connectedProfile;
        currentRecord.isAutoReconnect = false;
        currentRecord.wasPreviouslyConnected = true;
        currentRecord.attemptCount = 1;

        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'CONNECTED',
          profile: connectedProfile,
          isAutoReconnect: false
        });
        emitUserStatsSnapshot(io, googleUserId, latestDatabase);
        emitAdminGlobalSessionsSnapshot(io);
        emitLog(googleUserId, 'SUCCESS', `Connected as ${whatsappName} (+${cleanPhoneNumber})`);
      }

      if (connection === 'close') {
        const activeRecordNow = activeBotSessions.get(googleUserId);
        if (!activeRecordNow || activeRecordNow !== sessionRecord || activeRecordNow.isDeletingSession) {
          return;
        }

        clearSessionTimers(activeRecordNow);
        const disconnectCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const disconnectLabel = DisconnectReason[disconnectCode] || `Code ${disconnectCode || 'Unknown'}`;

        emitLog(googleUserId, 'WARN', `Koneksi terputus (${disconnectLabel}). Statistik tetap disimpan.`);

        if (disconnectCode === DisconnectReason.loggedOut || disconnectCode === DisconnectReason.badSession) {
          emitLog(googleUserId, 'ERROR', 'Sesi keluar (Logged Out). Membersihkan kredensial sesi...');
          await destroyBotSession(io, coreModules, googleUserId, false, disconnectLabel);
          return;
        }

        const isPostPairingRestart = disconnectCode === DisconnectReason.restartRequired || disconnectCode === 515;
        const hasExceededAutoRetries =
          isAutoReconnect &&
          !activeRecordNow.wasPreviouslyConnected &&
          !isPostPairingRestart &&
          activeRecordNow.attemptCount >= AUTO_CONNECT_MAX_RETRIES;

        if (hasExceededAutoRetries) {
          activeBotSessions.delete(googleUserId);
          emitLog(googleUserId, 'ERROR', 'Gagal auto-connect setelah beberapa percobaan. Kembali ke Disconnected.');
          io.to(`user_${googleUserId}`).emit('connection:status', {
            status: 'DISCONNECTED',
            profile: null,
            isAutoReconnect: false,
            reason: disconnectLabel
          });
          emitAdminGlobalSessionsSnapshot(io);
          return;
        }

        const persistedDatabase = readBotDatabase(googleUserId);
        const reconnectDelayMs = isPostPairingRestart ? 800 : 3000;
        const nextAttempt = activeRecordNow.wasPreviouslyConnected ? 1 : activeRecordNow.attemptCount + 1;

        activeRecordNow.status = 'CONNECTING';
        activeRecordNow.profile = null;
        activeRecordNow.isAutoReconnect = true;

        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'CONNECTING',
          profile: null,
          isAutoReconnect: true
        });
        emitAdminGlobalSessionsSnapshot(io);

        activeRecordNow.reconnectTimer = setTimeout(() => {
          startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', persistedDatabase.phoneNumber || '', nextAttempt, true);
        }, reconnectDelayMs);
      }
    });

    // --- router pesan masuk menuju webhook, moderasi grup, auto-reply media, plugin, dan ai persona ---
    client.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const messageItem of messages) {
        if (!messageItem.message || messageItem.key.remoteJid === 'status@broadcast') continue;

        const currentDatabase = readBotDatabase(googleUserId);
        if (isBotSubscriptionExpired(googleUserId, currentDatabase)) {
          emitLog(googleUserId, 'WARN', 'Masa aktif bot berakhir. Memutus koneksi otomatis...');
          cleanupSocketListenersAndEnd(client);
          activeBotSessions.delete(googleUserId);
          io.to(`user_${googleUserId}`).emit('connection:status', {
            status: 'DISCONNECTED',
            profile: null,
            isAutoReconnect: false,
            reason: 'SUBSCRIPTION_EXPIRED'
          });
          emitAdminGlobalSessionsSnapshot(io);
          return;
        }

        if (coreModules.store && typeof coreModules.store.saveMessage === 'function') {
          coreModules.store.saveMessage(messageItem, client.user?.id);
        }

        if (typeof coreModules.database === 'function') {
          coreModules.database(client, messageItem);
        }

        const remoteJid = messageItem.key.remoteJid;
        if (remoteJid?.endsWith('@g.us') && typeof coreModules.metadata === 'function') {
          if (!global.db?.metadata?.[remoteJid]) {
            await coreModules.metadata(client, remoteJid, false).catch(() => {});
          } else {
            coreModules.metadata(client, remoteJid, false).catch(() => {});
          }
        }

        const m = await serializeIncomingMessage(coreModules, client, messageItem);

        if (!m.fromMe) {
          recordRealtimeActivityHit(m.command ? 'CMD' : 'MSG', m.command ? `/cmd/${m.command}` : '/api/whatsapp/incoming');
          if (io.engine.clientsCount > 0) {
            io.emit('traffic:velocity', getRealtimeTrafficSnapshot());
          }
          currentDatabase.totalMessagesReceived += 1;
          incrementDailyTrafficRecord(currentDatabase, 'in');
          const cleanSenderNumber = m.sender.split('@')[0];
          if (!currentDatabase.uniqueUsers.includes(cleanSenderNumber)) {
            currentDatabase.uniqueUsers.push(cleanSenderNumber);
          }
          writeBotDatabaseAtomic(googleUserId, currentDatabase);
          emitUserStatsSnapshot(io, googleUserId, currentDatabase);

          if (currentDatabase.settings.autoRead) {
            try {
              await client.readMessages([messageItem.key]);
            } catch {
              // --- abaikan error read receipt ---
            }
          }
        }

        if (m.body) {
          emitLog(googleUserId, 'MSG', `${m.fromMe ? '[OUT]' : '[IN]'} ${m.sender.split('@')[0]}: ${m.body.slice(0, 80)}`);

          // --- teruskan pesan masuk ke webhook url user jika dikonfigurasi ---
          if (!m.fromMe && currentDatabase.settings.webhookUrl) {
            forwardIncomingToUserWebhook(currentDatabase, {
              event: 'message.received',
              botUserId: googleUserId,
              chat: m.chat,
              sender: m.sender,
              pushName: m.pushname || '',
              isGroup: Boolean(m.isGc || m.isGroup || remoteJid?.endsWith('@g.us')),
              messageType: m.mtype || 'text',
              text: m.body,
              timestamp: Date.now()
            }).catch(() => {});
          }

          // --- moderasi grup visual (anti-link & anti-toxic per grup) ---
          const isGroupChat = Boolean(m.isGc || m.isGroup || remoteJid?.endsWith('@g.us'));
          const groupCfg = isGroupChat ? currentDatabase.settings.groupConfigs?.[remoteJid] : null;
          if (!m.fromMe && groupCfg) {
            const hasWhatsappLink = /(https?:\/\/)?(chat\.whatsapp\.com|wa\.me|t\.me|bit\.ly)\/[^\s]+/i.test(m.body);
            if (groupCfg.antiLink && hasWhatsappLink) {
              await client.sendMessage(remoteJid, { delete: messageItem.key }).catch(() => {});
              await m.reply('Link tidak diizinkan di grup ini.').catch(() => {});
              continue;
            }
            if (groupCfg.antiToxic && Array.isArray(currentDatabase.settings.toxic) && currentDatabase.settings.toxic.length > 0) {
              const lowerBody = m.body.toLowerCase();
              const hitToxic = currentDatabase.settings.toxic.some((w) => w && lowerBody.includes(String(w).toLowerCase()));
              if (hitToxic) {
                await client.sendMessage(remoteJid, { delete: messageItem.key }).catch(() => {});
                await m.reply('Mohon jaga bahasa di grup ini.').catch(() => {});
                continue;
              }
            }
          }

          let wasHandledByAutoReply = false;

          // --- jalankan custom auto-reply teks maupun media (image, sticker, document) ---
          if (!m.fromMe && Array.isArray(currentDatabase.settings.autoReplies) && currentDatabase.settings.autoReplies.length > 0) {
            const rawBodyLower = m.body.trim().toLowerCase();
            const matchedReply = currentDatabase.settings.autoReplies.find((item) => {
              const triggerText = String(item?.trigger || '').trim().toLowerCase();
              if (!triggerText) return false;
              const matchMode = String(item?.matchType || 'exact').trim().toLowerCase();
              if (matchMode === 'contains') return rawBodyLower.includes(triggerText);
              if (matchMode === 'starts') return rawBodyLower.startsWith(triggerText);
              return rawBodyLower === triggerText;
            });

            if (matchedReply) {
              wasHandledByAutoReply = true;
              const replyType = String(matchedReply.mediaType || 'text').toLowerCase();
              const formattedReply = formatMessageTemplateVariables(matchedReply.response || '', currentDatabase);

              if (replyType !== 'text' && matchedReply.mediaUrl) {
                await sendDirectWhatsAppMessage(io, googleUserId, {
                  targetJid: m.chat,
                  mediaType: replyType,
                  mediaUrl: matchedReply.mediaUrl,
                  caption: formattedReply,
                  fileName: matchedReply.fileName || 'file',
                  sourceRoute: '/api/whatsapp/auto-reply'
                }).catch(() => {});
              } else if (formattedReply) {
                await m.reply(formattedReply).catch(() => {});
              }
            }
          }

          if (!currentDatabase.settings.publicMode && !m.fromMe) continue;

          // --- deteksi balasan plugin melalui selisih totalMessagesSent tanpa menimpa read-only m.reply ---
          const sentCountBeforePlugins = Number(readBotDatabase(googleUserId).totalMessagesSent || 0);

          await executeDynamicPlugins({
            googleUserId,
            m,
            client,
            botDatabase: currentDatabase,
            coreModules,
            io,
            emitLog
          });

          const sentCountAfterPlugins = Number(readBotDatabase(googleUserId).totalMessagesSent || 0);
          const wasPluginTriggered = sentCountAfterPlugins > sentCountBeforePlugins;

          // --- interseptor auto-reply ai persona jika aktif dan tidak memicu plugin/auto-reply ---
          const normalizedBotJid = jidNormalizedUser(client.user?.id || '');
          const isBotMentionedOrQuoted =
            (Array.isArray(m.mentionedJid) && m.mentionedJid.some((jid) => jidNormalizedUser(jid) === normalizedBotJid)) ||
            (m.quoted?.sender && jidNormalizedUser(m.quoted.sender) === normalizedBotJid);

          const shouldRunAiInChat = !isGroupChat || Boolean(currentDatabase.settings.aiGroupAutoReply) || isBotMentionedOrQuoted;
          const looksLikePrefixCommand = Boolean(m.prefix && m.command);

          if (
            !m.fromMe &&
            !wasHandledByAutoReply &&
            !wasPluginTriggered &&
            !looksLikePrefixCommand &&
            Boolean(currentDatabase.settings.isAiEnabled) &&
            shouldRunAiInChat
          ) {
            const cooldownKey = `${googleUserId}:${remoteJid}`;
            const lastAiAt = aiReplyCooldownMap.get(cooldownKey) || 0;
            const nowMs = Date.now();

            if (nowMs - lastAiAt >= AI_REPLY_COOLDOWN_MS) {
              aiReplyCooldownMap.set(cooldownKey, nowMs);
              try {
                const aiAnswer = await generateAiPersonaReply({
                  systemPrompt: currentDatabase.settings.aiSystemPrompt,
                  userMessage: m.body,
                  senderName: m.pushname || m.sender.split('@')[0],
                  botName: currentDatabase.settings.botName || CONFIG.platformName
                });
                if (aiAnswer) {
                  await client.sendMessage(m.chat, { text: aiAnswer }, { quoted: messageItem });
                  recordRealtimeActivityHit('AI', '/api/whatsapp/ai-persona');
                  emitLog(googleUserId, 'INFO', `[AI PERSONA] Menjawab ${m.sender.split('@')[0]} secara otomatis.`);
                }
              } catch (aiErr) {
                emitLog(googleUserId, 'WARN', `[AI PERSONA] Gagal memproses jawaban AI: ${aiErr.message}`);
              }
            }
          }
        }
      }
    });

    // --- perbarui cache metadata saat bot masuk grup atau info grup berubah ---
    client.ev.on('groups.upsert', (newGroups) => {
      if (!Array.isArray(newGroups)) return;
      global.db = global.db || {};
      global.db.metadata = global.db.metadata || {};
      for (const group of newGroups) {
        if (!group?.id) continue;
        global.db.metadata[group.id] = {
          ...group,
          participants: coreModules.lid?.formatGroupParticipants
            ? coreModules.lid.formatGroupParticipants(group)
            : group.participants || []
        };
      }
    });

    client.ev.on('groups.update', (updates) => {
      if (!Array.isArray(updates)) return;
      global.db = global.db || {};
      global.db.metadata = global.db.metadata || {};
      for (const update of updates) {
        if (!update?.id) continue;
        if (global.db.metadata[update.id]) {
          Object.assign(global.db.metadata[update.id], update);
        } else if (typeof coreModules.metadata === 'function') {
          coreModules.metadata(client, update.id, true).catch(() => {});
        }
      }
    });

    // --- kirim pesan welcome / goodbye otomatis sesuai pengaturan grup visual ---
    client.ev.on('group-participants.update', async (event) => {
      try {
        const groupId = event?.id;
        if (!groupId || !Array.isArray(event.participants) || event.participants.length === 0) return;

        const latestDb = readBotDatabase(googleUserId);
        const groupCfg = latestDb.settings?.groupConfigs?.[groupId];
        if (!groupCfg) return;

        const isAdd = event.action === 'add';
        const isRemove = event.action === 'remove';
        if (!isAdd && !isRemove) return;

        const templateText = isAdd
          ? (groupCfg.welcomeEnabled ? String(groupCfg.welcomeMessage || '').trim() : '')
          : (groupCfg.goodbyeEnabled ? String(groupCfg.goodbyeMessage || '').trim() : '');
        if (!templateText) return;

        const groupMeta = global.db?.metadata?.[groupId] || await client.groupMetadata(groupId).catch(() => null);
        const groupName = groupMeta?.subject || groupId.split('@')[0];

        for (const participantJid of event.participants) {
          const cleanNumber = String(participantJid).split('@')[0];
          const renderedText = formatMessageTemplateVariables(templateText, latestDb)
            .replaceAll('@user', `@${cleanNumber}`)
            .replaceAll('@group', groupName);

          await client.sendMessage(groupId, {
            text: renderedText,
            mentions: [participantJid]
          }).catch(() => {});
        }
      } catch {
        // --- abaikan error welcome/goodbye agar sesi tetap stabil ---
      }
    });
  } catch (sessionError) {
    clearSessionTimers(sessionRecord);
    if (activeBotSessions.get(googleUserId) === sessionRecord) {
      activeBotSessions.delete(googleUserId);
    }
    emitLog(googleUserId, 'ERROR', `Kegagalan inisialisasi sesi: ${sessionError.message}`);
    io.to(`user_${googleUserId}`).emit('connection:status', {
      status: 'DISCONNECTED',
      profile: null,
      isAutoReconnect: false,
      reason: sessionError.message
    });
    emitAdminGlobalSessionsSnapshot(io);
  }
}

// --- kirim pesan broadcast ke seluruh grup bot dengan spintax & jeda anti-ban ---
export async function broadcastToBotGroups(io, googleUserId, messageText, delaySeconds = 5) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);
  const activeSession = activeBotSessions.get(googleUserId);

  if (!activeSession || activeSession.status !== 'CONNECTED' || !activeSession.socketInstance) {
    return { isSuccess: false, errorMessage: 'Bot harus dalam status Connected untuk melakukan broadcast grup.' };
  }

  const botDatabase = readBotDatabase(googleUserId);
  const cleanText = formatMessageTemplateVariables(messageText, botDatabase).trim();
  if (!cleanText) {
    return { isSuccess: false, errorMessage: 'Isi pesan broadcast tidak boleh kosong.' };
  }

  const safeDelayMs = Math.max(2, Math.min(30, Number(delaySeconds) || 5)) * 1000;
  const client = activeSession.socketInstance;

  let targetGroups = [];
  try {
    const participating = await client.groupFetchAllParticipating();
    targetGroups = Object.values(participating || {}).filter(
      (grp) => grp?.id && !global.db?.groups?.[grp.id]?.banned
    );
  } catch {
    targetGroups = Object.values(global.db?.metadata || {}).filter(
      (grp) => grp?.id?.endsWith('@g.us') && !global.db?.groups?.[grp.id]?.banned
    );
  }

  if (targetGroups.length === 0) {
    return { isSuccess: false, errorMessage: 'Tidak ada grup aktif yang ditemukan untuk broadcast.' };
  }

  emitLog(googleUserId, 'INFO', `Memulai broadcast ke ${targetGroups.length} grup (jeda ${safeDelayMs / 1000} detik/grup)...`);

  let successCount = 0;
  let failedCount = 0;

  for (let idx = 0; idx < targetGroups.length; idx += 1) {
    const groupItem = targetGroups[idx];
    try {
      const variedText = parseSpintaxText(cleanText);
      await client.sendMessage(groupItem.id, { text: variedText });
      successCount += 1;
    } catch {
      failedCount += 1;
    }

    io.to(`user_${googleUserId}`).emit('broadcast:progress', {
      current: idx + 1,
      total: targetGroups.length,
      successCount,
      failedCount
    });

    if (idx < targetGroups.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, safeDelayMs));
    }
  }

  emitLog(googleUserId, 'SUCCESS', `Broadcast selesai. Berhasil: ${successCount}, Gagal: ${failedCount}.`);
  return { isSuccess: true, total: targetGroups.length, successCount, failedCount };
}

// --- soft restart koneksi whatsapp tanpa menghapus kredensial sesi ---
export async function restartWhatsAppSession(io, coreModules, googleUserId) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);
  const discoveredSession = findValidUserSession(googleUserId);

  if (!discoveredSession) {
    emitLog(googleUserId, 'WARN', 'Tidak ada sesi tersimpan untuk di-restart. Silakan tautkan QR atau Pairing terlebih dahulu.');
    io.to(`user_${googleUserId}`).emit('connection:status', {
      status: 'DISCONNECTED',
      profile: null,
      isAutoReconnect: false
    });
    emitAdminGlobalSessionsSnapshot(io);
    return false;
  }

  emitLog(googleUserId, 'INFO', `Memulai soft restart koneksi sesi [${discoveredSession.sessionName}]...`);
  const userDatabase = readBotDatabase(googleUserId);
  await startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', userDatabase.phoneNumber || '', 1, true);
  return true;
}

// --- hapus sesi kredensial baileys secara bersih tanpa merusak statistik ---
export async function destroyBotSession(io, coreModules, googleUserId, triggerLogout = true, reasonLabel = 'LOGGED_OUT') {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);
  const existingSession = activeBotSessions.get(googleUserId);
  const currentDatabase = readBotDatabase(googleUserId);
  const targetSessionName = existingSession?.sessionName || currentDatabase.sessionName;

  if (existingSession) {
    existingSession.isDeletingSession = true;
    clearSessionTimers(existingSession);

    if (existingSession.profile?.number && coreModules.socket && typeof coreModules.socket.delete === 'function') {
      coreModules.socket.delete(existingSession.profile.number);
    }

    if (existingSession.socketInstance) {
      try {
        if (triggerLogout && existingSession.status === 'CONNECTED') {
          await Promise.race([
            existingSession.socketInstance.logout(),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ]);
        }
      } catch {
        // --- abaikan error proses logout ---
      }
      cleanupSocketListenersAndEnd(existingSession.socketInstance);
    }

    activeBotSessions.delete(googleUserId);
  }

  if (targetSessionName) {
    const userSessionFolder = getUserSessionFolderPath(googleUserId, targetSessionName);
    if (fs.existsSync(userSessionFolder)) {
      try {
        fs.rmSync(userSessionFolder, { recursive: true, force: true });
      } catch (deleteError) {
        emitLog(googleUserId, 'ERROR', `Gagal menghapus folder sesi: ${deleteError.message}`);
      }
    }
  }

  currentDatabase.sessionName = null;
  currentDatabase.phoneNumber = null;
  writeBotDatabaseAtomic(googleUserId, currentDatabase);

  const globalStats = getGlobalPlatformStatistics(activeBotSessions);
  io.to(`user_${googleUserId}`).emit('session:reset', {
    status: 'DISCONNECTED',
    profile: null,
    isAutoReconnect: false,
    reason: reasonLabel,
    database: currentDatabase,
    globalStats
  });
  io.to(`user_${googleUserId}`).emit('connection:status', {
    status: 'DISCONNECTED',
    profile: null,
    isAutoReconnect: false,
    reason: reasonLabel
  });
  emitUserStatsSnapshot(io, googleUserId, currentDatabase);
  emitAdminGlobalSessionsSnapshot(io);
  emitLog(googleUserId, 'WARN', 'Sesi kredensial WhatsApp telah dihapus dari volume.');
}

// --- pulihkan otomatis seluruh sesi akun valid saat server menyala ---
export function restoreExistingSessionsOnBoot(io, coreModules) {
  if (!fs.existsSync(SESSIONS_ROOT_FOLDER_PATH)) {
    fs.mkdirSync(SESSIONS_ROOT_FOLDER_PATH, { recursive: true });
    return;
  }

  try {
    const masterDb = readMasterDatabaseFile();
    const accountsToRestore = new Map();

    for (const userIdKey of Object.keys(masterDb.users)) {
      const foundSession = findValidUserSession(userIdKey);
      if (foundSession) {
        accountsToRestore.set(userIdKey, {
          sessionName: foundSession.sessionName,
          phoneNumber: masterDb.users[userIdKey]?.phoneNumber || ''
        });
      }
    }

    for (const entry of fs.readdirSync(SESSIONS_ROOT_FOLDER_PATH, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const folderPath = path.join(SESSIONS_ROOT_FOLDER_PATH, folderName);
      if (!isValidRegisteredSession(folderPath)) continue;

      const ownerMeta = readSessionOwnerMetadata(folderPath);
      let matchedGoogleId = ownerMeta?.googleUserId || null;

      if (!matchedGoogleId) {
        for (const userIdKey of Object.keys(masterDb.users)) {
          const userRecord = masterDb.users[userIdKey];
          if (userRecord.sessionName === folderName || userRecord.phoneNumber === folderName || folderName.includes(userIdKey)) {
            matchedGoogleId = userIdKey;
            break;
          }
        }
      }

      if (matchedGoogleId && !accountsToRestore.has(matchedGoogleId)) {
        accountsToRestore.set(matchedGoogleId, {
          sessionName: folderName,
          phoneNumber: ownerMeta?.phoneNumber || masterDb.users[matchedGoogleId]?.phoneNumber || ''
        });
      }
    }

    let delayIndex = 0;
    for (const [googleUserId, sessionMeta] of accountsToRestore.entries()) {
      const staggerDelayMs = delayIndex * 400;
      delayIndex += 1;

      setTimeout(() => {
        console.log(`[BOOT AUTO-START] Memulihkan sesi User ID: ${googleUserId} (${sessionMeta.sessionName})`);
        startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', sessionMeta.phoneNumber, 1, false);
      }, staggerDelayMs);
    }
  } catch (bootScanError) {
    console.error('[BOOT ERROR] Gagal memindai sesi tersimpan:', bootScanError.message);
  }
}

// --- sinkronisasi state sesi, jadwal pesan, analitik, pengumuman, ai, gateway, dan live traffic ---
export async function syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser) {
  const googleUserId = sessionUser.googleId;
  const isAdmin = isPlatformAdminUser(sessionUser);
  const userDatabase = readBotDatabase(googleUserId);
  let currentBotState = activeBotSessions.get(googleUserId);
  const discoveredSession = findValidUserSession(googleUserId);

  if (!currentBotState && discoveredSession && !isBotSubscriptionExpired(googleUserId, userDatabase)) {
    startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', userDatabase.phoneNumber || '', 1, false);
    currentBotState = activeBotSessions.get(googleUserId);
  }

  const resolvedStatus = currentBotState ? currentBotState.status : 'DISCONNECTED';
  const resolvedProfile = currentBotState ? currentBotState.profile : null;
  const isAutoReconnect = Boolean(currentBotState?.isAutoReconnect);
  const catalogList = await getFeatureCatalogList();

  clientSocket.emit('session:ready', {
    user: sessionUser,
    isAdmin,
    adminWaNumber: ADMIN_WA_NUMBER,
    volumePath: discoveredSession?.folderPath || getUserSessionFolderPath(googleUserId),
    status: resolvedStatus,
    profile: resolvedProfile,
    isAutoReconnect,
    database: userDatabase,
    apiKey: userDatabase.apiKey || null,
    apiKeyStats: userDatabase.apiKeyStats || { createdAt: 0, lastUsedAt: 0, totalCalls: 0 },
    schedules: userDatabase.scheduledMessages || [],
    globalStats: getGlobalPlatformStatistics(activeBotSessions),
    trafficSeries: buildLast7DaysTrafficSeries(userDatabase.trafficHistory),
    trafficVelocity: getRealtimeTrafficSnapshot(),
    topCommands: getTopCommandsLeaderboard(5),
    announcement: getGlobalAnnouncement(),
    announcements: getGlobalAnnouncements(),
    catalog: catalogList,
    plugins: isAdmin ? getAvailablePluginsList() : [],
    vouchers: isAdmin ? listVouchers() : [],
    adminGlobalMonitor: isAdmin ? getAllUsersGlobalMonitorSnapshot(activeBotSessions) : null,
    logs: userTerminalLogsCache.get(googleUserId) || []
  });

  clientSocket.emit('connection:status', {
    status: resolvedStatus,
    profile: resolvedProfile,
    isAutoReconnect
  });
}
