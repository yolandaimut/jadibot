// --- manajer sesi baileys, dynamic session mapping, auto-connect, dan serializer pesan ---
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
  AUTO_CONNECT_MAX_RETRIES,
  AUTO_CONNECT_TIMEOUT_MS,
  SESSIONS_ROOT_FOLDER_PATH,
  CONFIG
} from './config.js';
import {
  getGlobalPlatformStatistics,
  getUserSessionFolderPath,
  readBotDatabase,
  readMasterDatabaseFile,
  writeBotDatabaseAtomic
} from './database.js';
import { executeDynamicPlugins, getAvailablePluginsList } from './plugin-manager.js';
import Extra from '../system/extra.js';

const extraInstance = new Extra();

export const activeBotSessions = new Map();
export const userTerminalLogsCache = new Map();
const silentLogger = pino({ level: 'silent' });

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
  if (userLogs.length > 60) userLogs.shift();

  io.to(`user_${googleUserId}`).emit('terminal:log', logEntry);
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
  const matchedPrefix = CONFIG.prefixes.find((prefix) => trimmedBody.startsWith(prefix)) || '';
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

// --- mulai koneksi whatsapp baileys dengan auto-connect dan fallback disconnected ---
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
  const existingSession = activeBotSessions.get(googleUserId);
  const isAutoReconnect = connectionMethod === 'reconnect';

  if (existingSession) {
    if (existingSession.status === 'CONNECTED' && existingSession.socketInstance) {
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
    if (existingSession.socketInstance) {
      try {
        existingSession.socketInstance.ev.removeAllListeners('connection.update');
        existingSession.socketInstance.ev.removeAllListeners('creds.update');
        existingSession.socketInstance.ev.removeAllListeners('messages.upsert');
        existingSession.socketInstance.ev.removeAllListeners('groups.upsert');
        existingSession.socketInstance.ev.removeAllListeners('groups.update');
        existingSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error saat menutup socket lama ---
      }
    }
  }

  const botDatabase = readBotDatabase(googleUserId);
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
      if (latestRecord.socketInstance) {
        try {
          latestRecord.socketInstance.ev.removeAllListeners('connection.update');
          latestRecord.socketInstance.ev.removeAllListeners('creds.update');
          latestRecord.socketInstance.ev.removeAllListeners('messages.upsert');
          latestRecord.socketInstance.ev.removeAllListeners('groups.upsert');
          latestRecord.socketInstance.ev.removeAllListeners('groups.update');
          latestRecord.socketInstance.end(undefined);
        } catch {
          // --- abaikan error pemutusan socket timeout ---
        }
      }

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

    // --- pasang method client.reply, client.sendReact, client.sendStickerFromUrl, dll ---
    extraInstance.registerComponents(client);

    // --- intercept pengiriman pesan untuk menghitung statistik secara atomic ---
    const originalSendMessage = client.sendMessage.bind(client);
    client.sendMessage = async (recipientJid, messageContent, messageOptions = {}) => {
      const sendResult = await originalSendMessage(recipientJid, messageContent, messageOptions);
      const latestDatabase = readBotDatabase(googleUserId);
      latestDatabase.totalMessagesSent += 1;
      writeBotDatabaseAtomic(googleUserId, latestDatabase);
      io.to(`user_${googleUserId}`).emit('stats:update', {
        userStats: latestDatabase,
        globalStats: getGlobalPlatformStatistics(activeBotSessions)
      });
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
        try {
          client.ev.removeAllListeners('connection.update');
          client.end(undefined);
        } catch {
          // --- abaikan error penutupan socket ---
        }
        activeBotSessions.delete(googleUserId);
        emitLog(googleUserId, 'WARN', 'Sesi tersimpan membutuhkan tautan ulang. Kembali ke mode Disconnected.');
        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'DISCONNECTED',
          profile: null,
          isAutoReconnect: false
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
        io.to(`user_${googleUserId}`).emit('stats:update', {
          userStats: latestDatabase,
          globalStats: getGlobalPlatformStatistics(activeBotSessions)
        });
        emitLog(googleUserId, 'SUCCESS', `Connected as ${whatsappName} (+${cleanPhoneNumber})`); // [${activeSessionName}]`);
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
          await destroyBotSession(io, coreModules, googleUserId, false);
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
            isAutoReconnect: false
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

    // --- router pesan masuk menuju serializer dan dispatcher plugin objek ---
    client.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const messageItem of messages) {
        if (!messageItem.message || messageItem.key.remoteJid === 'status@broadcast') continue;

        if (coreModules.store && typeof coreModules.store.saveMessage === 'function') {
          coreModules.store.saveMessage(messageItem, client.user?.id);
        }

        if (typeof coreModules.database === 'function') {
          coreModules.database(client, messageItem);
        }

        // --- sinkronkan metadata grup agar m.isAdmin dan m.isBotAdmin akurat ---
        const remoteJid = messageItem.key.remoteJid;
        if (remoteJid?.endsWith('@g.us') && typeof coreModules.metadata === 'function') {
          if (!global.db?.metadata?.[remoteJid]) {
            await coreModules.metadata(client, remoteJid, false).catch(() => {});
          } else {
            coreModules.metadata(client, remoteJid, false).catch(() => {});
          }
        }

        const m = await serializeIncomingMessage(coreModules, client, messageItem);
        const currentDatabase = readBotDatabase(googleUserId);

        if (!m.fromMe) {
          currentDatabase.totalMessagesReceived += 1;
          const cleanSenderNumber = m.sender.split('@')[0];
          if (!currentDatabase.uniqueUsers.includes(cleanSenderNumber)) {
            currentDatabase.uniqueUsers.push(cleanSenderNumber);
          }
          writeBotDatabaseAtomic(googleUserId, currentDatabase);
          io.to(`user_${googleUserId}`).emit('stats:update', {
            userStats: currentDatabase,
            globalStats: getGlobalPlatformStatistics(activeBotSessions)
          });

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
      isAutoReconnect: false
    });
  }
}

// --- hapus sesi kredensial baileys secara bersih tanpa merusak statistik ---
export async function destroyBotSession(io, coreModules, googleUserId, triggerLogout = true) {
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
        existingSession.socketInstance.ev.removeAllListeners('connection.update');
        existingSession.socketInstance.ev.removeAllListeners('creds.update');
        existingSession.socketInstance.ev.removeAllListeners('messages.upsert');
        existingSession.socketInstance.ev.removeAllListeners('groups.upsert');
        existingSession.socketInstance.ev.removeAllListeners('groups.update');

        if (triggerLogout && existingSession.status === 'CONNECTED') {
          await Promise.race([
            existingSession.socketInstance.logout(),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ]);
        }
      } catch {
        // --- abaikan error proses logout ---
      }

      try {
        existingSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error penutupan socket ---
      }
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
    database: currentDatabase,
    globalStats
  });
  io.to(`user_${googleUserId}`).emit('connection:status', {
    status: 'DISCONNECTED',
    profile: null,
    isAutoReconnect: false
  });
  io.to(`user_${googleUserId}`).emit('stats:update', {
    userStats: currentDatabase,
    globalStats
  });
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

// --- sinkronisasi state sesi dan daftar plugin ke klien dashboard ---
export function syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser) {
  const googleUserId = sessionUser.googleId;
  const userDatabase = readBotDatabase(googleUserId);
  let currentBotState = activeBotSessions.get(googleUserId);
  const discoveredSession = findValidUserSession(googleUserId);

  if (!currentBotState && discoveredSession) {
    startWhatsAppSession(io, coreModules, googleUserId, 'reconnect', userDatabase.phoneNumber || '', 1, false);
    currentBotState = activeBotSessions.get(googleUserId);
  }

  const resolvedStatus = currentBotState ? currentBotState.status : 'DISCONNECTED';
  const resolvedProfile = currentBotState ? currentBotState.profile : null;
  const isAutoReconnect = Boolean(currentBotState?.isAutoReconnect);

  clientSocket.emit('session:ready', {
    user: sessionUser,
    volumePath: discoveredSession?.folderPath || getUserSessionFolderPath(googleUserId),
    status: resolvedStatus,
    profile: resolvedProfile,
    isAutoReconnect,
    database: userDatabase,
    globalStats: getGlobalPlatformStatistics(activeBotSessions),
    plugins: getAvailablePluginsList(),
    logs: userTerminalLogsCache.get(googleUserId) || []
  });

  clientSocket.emit('connection:status', {
    status: resolvedStatus,
    profile: resolvedProfile,
    isAutoReconnect
  });
}
