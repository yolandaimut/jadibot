// --- manajer sesi baileys, auto-connect, direct message, scheduler, dan pelacak trafik real-time ---
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
  SESSIONS_ROOT_FOLDER_PATH,
  CONFIG
} from './config.js';
import {
  buildLast7DaysTrafficSeries,
  getGlobalAnnouncement,
  getGlobalAnnouncements,
  getGlobalPlatformStatistics,
  getUserSessionFolderPath,
  incrementDailyTrafficRecord,
  isPlatformAdminById,
  isPlatformAdminUser,
  readBotDatabase,
  readMasterDatabaseFile,
  writeBotDatabaseAtomic
} from './database.js';
import {
  executeDynamicPlugins,
  getAvailablePluginsList,
  getFeatureCatalogList
} from './plugin-manager.js';
import Extra from '../system/extra.js';

const extraInstance = new Extra();

export const activeBotSessions = new Map();
export const userTerminalLogsCache = new Map();
const silentLogger = pino({ level: 'silent' });
let schedulerWorkerInterval = null;

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

// --- pancarkan pembaruan statistik user & global secara terpusat (dry) ---
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

// --- kirim pesan langsung ke grup atau chat pribadi dengan opsi mention all ---
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
  const formattedText = formatMessageTemplateVariables(payload.message, botDatabase).trim();
  if (!formattedText) {
    return { isSuccess: false, errorMessage: 'Isi pesan tidak boleh kosong.' };
  }

  const client = activeSession.socketInstance;
  const messageContent = { text: formattedText };

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
        messageContent.mentions = mentionJids;
      }
    } catch {
      // --- lanjutkan kirim pesan tanpa mention jika metadata grup gagal diambil ---
    }
  }

  try {
    await client.sendMessage(targetJid, messageContent);
    recordRealtimeActivityHit('POST', '/api/whatsapp/direct-send');
    io.emit('traffic:velocity', getRealtimeTrafficSnapshot());
    const shortTarget = targetJid.split('@')[0];
    emitLog(
      googleUserId,
      'SUCCESS',
      `Pesan langsung terkirim ke [${shortTarget}]${payload.mentionAll && targetJid.endsWith('@g.us') ? ' (Mention All)' : ''}.`
    );
    return { isSuccess: true, targetJid };
  } catch (sendError) {
    emitLog(googleUserId, 'ERROR', `Gagal mengirim pesan ke [${targetJid.split('@')[0]}]: ${sendError.message}`);
    return { isSuccess: false, errorMessage: sendError.message || 'Gagal mengirim pesan.' };
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

// --- worker latar belakang untuk mengeksekusi jadwal pesan & reminder otomatis ---
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
            mentionAll: Boolean(item.mentionAll)
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
        if (!serialized.reply) {
          serialized.reply = async (text) =>
            await client.sendMessage(serialized.chat || rawMessage.key.remoteJid, { text: String(text) }, { quoted: rawMessage });
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

    // --- pasang method helper client baileys ---
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

        activeRecordNow.reconnectTimer = setTimeout(() => {
          startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', persistedDatabase.phoneNumber || '', nextAttempt, true);
        }, reconnectDelayMs);
      }
    });

    // --- router pesan masuk menuju auto-reply, serializer, dan dispatcher plugin ---
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

          // --- jalankan custom auto-reply dengan mode exact, contains, atau starts ---
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
            if (matchedReply?.response) {
              const formattedReply = formatMessageTemplateVariables(matchedReply.response, currentDatabase);
              await m.reply(formattedReply).catch(() => {});
            }
          }

          if (!currentDatabase.settings.publicMode && !m.fromMe) continue;

          await executeDynamicPlugins({
            googleUserId,
            m,
            client,
            botDatabase: currentDatabase,
            coreModules,
            io,
            emitLog
          });
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
  }
}

// --- kirim pesan broadcast ke seluruh grup bot dengan jeda anti-spam ---
export async function broadcastToBotGroups(io, googleUserId, messageText, delaySeconds = 4) {
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

  const safeDelayMs = Math.max(2, Math.min(30, Number(delaySeconds) || 4)) * 1000;
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
      await client.sendMessage(groupItem.id, { text: cleanText });
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

// --- sinkronisasi state sesi, jadwal pesan, analitik, pengumuman, dan live traffic ke klien ---
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
    schedules: userDatabase.scheduledMessages || [],
    globalStats: getGlobalPlatformStatistics(activeBotSessions),
    trafficSeries: buildLast7DaysTrafficSeries(userDatabase.trafficHistory),
    trafficVelocity: getRealtimeTrafficSnapshot(),
    topCommands: getTopCommandsLeaderboard(5),
    announcement: getGlobalAnnouncement(),
    announcements: getGlobalAnnouncements(),
    catalog: catalogList,
    plugins: isAdmin ? getAvailablePluginsList() : [],
    logs: userTerminalLogsCache.get(googleUserId) || []
  });

  clientSocket.emit('connection:status', {
    status: resolvedStatus,
    profile: resolvedProfile,
    isAutoReconnect
  });
}