// --- import modul utama nodejs dan dependensi eksternal ---
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { OAuth2Client } from 'google-auth-library';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

// --- inisialisasi utilitas path dan proses asinkron ---
const executeFileAsync = promisify(execFile);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = path.dirname(currentFilePath);

// --- konfigurasi google oauth 2.0 client id ---
const GOOGLE_CLIENT_ID = '404486479013-8tpsuq4920rao7clth8graba1vtoon72.apps.googleusercontent.com';
const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- konfigurasi server express dan socket.io untuk railway ---
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(currentDirectoryPath, 'public')));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

const SERVER_PORT = process.env.PORT || 3000;
const PLUGINS_ROOT_DIR = path.join(currentDirectoryPath, 'plugins');

// --- fungsi deteksi dan pembuatan direktori volume railway ---
function resolveRailwayVolumeRoot() {
  const preferredPaths = [
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    '/data/sessions',
    '/app/mnt/volume/sessions'
  ].filter(Boolean);

  for (const candidatePath of preferredPaths) {
    try {
      if (!fs.existsSync(candidatePath)) {
        fs.mkdirSync(candidatePath, { recursive: true });
      }
      fs.accessSync(candidatePath, fs.constants.W_OK);
      return candidatePath;
    } catch {
      // --- lanjutkan ke kandidat path berikutnya jika akses ditolak ---
    }
  }

  const fallbackLocalPath = path.join(currentDirectoryPath, 'data', 'sessions');
  if (!fs.existsSync(fallbackLocalPath)) {
    fs.mkdirSync(fallbackLocalPath, { recursive: true });
  }
  return fallbackLocalPath;
}

const SESSIONS_VOLUME_ROOT = resolveRailwayVolumeRoot();

if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
  fs.mkdirSync(PLUGINS_ROOT_DIR, { recursive: true });
}

// --- penyimpanan state sesi bot aktif di memori ---
const activeBotSessions = new Map();
const silentLogger = pino({ level: 'silent' });

// --- inisialisasi plugin default jika folder plugins kosong ---
function initializeDefaultPlugin() {
  const defaultPluginPath = path.join(PLUGINS_ROOT_DIR, 'core-commands.js');
  if (!fs.existsSync(defaultPluginPath)) {
    const defaultPluginCode = `// --- plugin bawaan untuk respon perintah dasar ---
export default async function executePlugin(context) {
  const { messageText, replyMessage, botDatabase } = context;
  const cleanCommand = messageText.trim().toLowerCase();

  if (cleanCommand === '.ping') {
    await replyMessage(
      \`Pong! Bot Aktif.\\nTotal Pesan Masuk: \${botDatabase.totalMessagesReceived}\\nTotal Pesan Terkirim: \${botDatabase.totalMessagesSent}\\nUser Unik: \${botDatabase.uniqueUsers.length}\`
    );
  }

  if (cleanCommand === '.status') {
    const uptimeSeconds = Math.floor((Date.now() - botDatabase.startTime) / 1000);
    await replyMessage(
      \`[ JADIBOT ENTERPRISE ]\\nDurasi Aktif: \${uptimeSeconds} detik\\nPublic Mode: \${botDatabase.settings.publicMode ? 'Aktif' : 'Nonaktif'}\`
    );
  }
}
`;
    fs.writeFileSync(defaultPluginPath, defaultPluginCode, 'utf-8');
  }
}

initializeDefaultPlugin();

// --- fungsi verifikasi jwt token google oauth 2.0 ---
async function verifyGoogleCredentialToken(idTokenString) {
  if (!idTokenString || typeof idTokenString !== 'string') {
    throw new Error('Token kredensial Google tidak ditemukan.');
  }

  try {
    const verificationOptions = { idToken: idTokenString };
    if (
      GOOGLE_CLIENT_ID &&
      !GOOGLE_CLIENT_ID.startsWith('MASUKKAN_') &&
      GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')
    ) {
      verificationOptions.audience = GOOGLE_CLIENT_ID;
    }

    const ticket = await googleOAuthClient.verifyIdToken(verificationOptions);
    const payload = ticket.getPayload();

    if (!payload || !payload.sub) {
      throw new Error('Payload akun Google tidak valid.');
    }

    return {
      googleId: String(payload.sub).replace(/[^a-zA-Z0-9_-]/g, ''),
      email: payload.email || '',
      fullName: payload.name || 'Google User',
      givenName: payload.given_name || payload.name?.split(' ')[0] || 'User',
      pictureUrl: payload.picture || ''
    };
  } catch (verificationError) {
    throw new Error(`Verifikasi Google OAuth gagal: ${verificationError.message}`);
  }
}

// --- fungsi logger custom yang memancarkan log ke terminal frontend ---
function emitTerminalLog(googleUserId, logLevel, logMessage) {
  const timestampText = new Date().toLocaleTimeString('id-ID', { hour12: false });
  io.to(`user_${googleUserId}`).emit('terminal:log', {
    timestamp: timestampText,
    level: logLevel,
    message: logMessage
  });
}

// --- lokasi file database.json utama dan direktori sesi di dalam volume ---
const MAIN_DATABASE_FILE_PATH = path.join(currentDirectoryPath, 'database.json');
const SESSIONS_ROOT_FOLDER_PATH = path.join(currentDirectoryPath, 'sessions');

// --- fungsi baca seluruh data dari database.json utama secara aman ---
function readMasterDatabaseFile() {
  if (!fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    return { users: {} };
  }
  try {
    const rawFileContent = fs.readFileSync(MAIN_DATABASE_FILE_PATH, 'utf-8');
    const parsedContent = JSON.parse(rawFileContent);
    if (!parsedContent || typeof parsedContent.users !== 'object') {
      return { users: {} };
    }
    return parsedContent;
  } catch {
    return { users: {} };
  }
}

// --- fungsi tulis ke database.json utama dengan metode atomic write anti-corrupt ---
function writeMasterDatabaseFileAtomic(masterDatabaseObject) {
  fs.mkdirSync(currentDirectoryPath, { recursive: true });
  const tempFilePath = `${MAIN_DATABASE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(masterDatabaseObject, null, 2), 'utf-8');
  fs.renameSync(tempFilePath, MAIN_DATABASE_FILE_PATH);
}

// --- fungsi ambil data spesifik user beserta mapping sesi dari database.json ---
function readBotDatabase(googleUserId) {
  const masterDatabase = readMasterDatabaseFile();
  const existingUserRecord = masterDatabase.users[googleUserId];

  const defaultUserRecord = {
    googleUserId,
    phoneNumber: null,
    sessionName: null,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    uniqueUsers: [],
    startTime: Date.now(),
    settings: {
      autoRead: true,
      publicMode: true
    }
  };

  if (!existingUserRecord) {
    masterDatabase.users[googleUserId] = defaultUserRecord;
    writeMasterDatabaseFileAtomic(masterDatabase);
    return defaultUserRecord;
  }

  return {
    ...defaultUserRecord,
    ...existingUserRecord,
    uniqueUsers: Array.isArray(existingUserRecord.uniqueUsers) ? existingUserRecord.uniqueUsers : [],
    settings: {
      ...defaultUserRecord.settings,
      ...(existingUserRecord.settings || {})
    }
  };
}

// --- fungsi simpan pembaruan data user ke database.json secara atomic ---
function writeBotDatabaseAtomic(googleUserId, updatedUserDatabase) {
  const masterDatabase = readMasterDatabaseFile();
  const currentRecord = masterDatabase.users[googleUserId] || {};

  masterDatabase.users[googleUserId] = {
    ...currentRecord,
    ...updatedUserDatabase,
    googleUserId
  };

  writeMasterDatabaseFileAtomic(masterDatabase);
}

// --- fungsi resolusi path folder autentikasi baileys berdasarkan nama sesi ---
function getUserSessionFolderPath(googleUserId, explicitSessionName = null) {
  const userDatabase = readBotDatabase(googleUserId);
  const resolvedSessionName = explicitSessionName || userDatabase.sessionName || `qr_${googleUserId}`;
  const safeFolderName = String(resolvedSessionName).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSIONS_ROOT_FOLDER_PATH, safeFolderName);
}

// --- fungsi kalkulasi statistik global platform dari database.json utama ---
function getGlobalPlatformStatistics() {
  const masterDatabase = readMasterDatabaseFile();
  let globalMessagesReceived = 0;
  let globalMessagesSent = 0;
  let totalActiveBots = 0;

  for (const [, sessionInfo] of activeBotSessions.entries()) {
    if (sessionInfo.status === 'CONNECTED') {
      totalActiveBots += 1;
    }
  }

  for (const userIdKey of Object.keys(masterDatabase.users)) {
    const userStats = masterDatabase.users[userIdKey];
    globalMessagesReceived += Number(userStats?.totalMessagesReceived || 0);
    globalMessagesSent += Number(userStats?.totalMessagesSent || 0);
  }

  return {
    totalActiveBots,
    globalMessagesReceived,
    globalMessagesSent
  };
}

// --- fungsi utama koneksi whatsapp baileys dengan dynamic session mapping ---
async function startWhatsAppSession(googleUserId, connectionMethod = 'qr', phoneNumberInput = '') {
  const existingSession = activeBotSessions.get(googleUserId);

  if (existingSession) {
    if (existingSession.status === 'CONNECTED' && existingSession.socketInstance) {
      io.to(`user_${googleUserId}`).emit('connection:status', {
        status: 'CONNECTED',
        profile: existingSession.profile
      });
      return;
    }

    if (existingSession.reconnectTimer) {
      clearTimeout(existingSession.reconnectTimer);
    }

    if (existingSession.socketInstance) {
      try {
        existingSession.socketInstance.ev.removeAllListeners('connection.update');
        existingSession.socketInstance.ev.removeAllListeners('creds.update');
        existingSession.socketInstance.ev.removeAllListeners('messages.upsert');
        existingSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error saat menutup instance socket lama ---
      }
    }
  }

  const botDatabase = readBotDatabase(googleUserId);
  const cleanedPhoneInput = String(phoneNumberInput || '').replace(/[^0-9]/g, '');
  let activeSessionName = botDatabase.sessionName;

  if (connectionMethod === 'pairing') {
    // --- metode pairing langsung membuat folder sesi sesuai input nomor telepon ---
    if (cleanedPhoneInput.length < 8) {
      emitTerminalLog(googleUserId, 'ERROR', 'Format nomor telepon tidak valid.');
      io.to(`user_${googleUserId}`).emit('pairing:error', 'Gunakan format nomor internasional (contoh: 628123456789).');
      return;
    }

    if (activeSessionName && activeSessionName !== cleanedPhoneInput) {
      const previousFolder = getUserSessionFolderPath(googleUserId, activeSessionName);
      if (fs.existsSync(previousFolder)) {
        fs.rmSync(previousFolder, { recursive: true, force: true });
      }
    }

    activeSessionName = cleanedPhoneInput;
    botDatabase.phoneNumber = cleanedPhoneInput;
    botDatabase.sessionName = activeSessionName;
    writeBotDatabaseAtomic(googleUserId, botDatabase);
  } else if (connectionMethod === 'reconnect') {
    // --- metode reconnect membaca mapping session lama dari database.json ---
    if (!activeSessionName) {
      activeSessionName = botDatabase.phoneNumber || `qr_${crypto.randomBytes(4).toString('hex')}`;
      botDatabase.sessionName = activeSessionName;
      writeBotDatabaseAtomic(googleUserId, botDatabase);
    }
  } else {
    // --- metode qr menggunakan id unik sementara jika belum ada sesi terdaftar ---
    const mappedFolder = activeSessionName ? getUserSessionFolderPath(googleUserId, activeSessionName) : null;
    const hasRegisteredCreds = mappedFolder && fs.existsSync(path.join(mappedFolder, 'creds.json'));

    if (!activeSessionName || !hasRegisteredCreds) {
      if (mappedFolder && fs.existsSync(mappedFolder)) {
        fs.rmSync(mappedFolder, { recursive: true, force: true });
      }
      activeSessionName = `qr_${crypto.randomBytes(4).toString('hex')}_${Date.now().toString(36)}`;
      botDatabase.sessionName = activeSessionName;
      writeBotDatabaseAtomic(googleUserId, botDatabase);
    }
  }

  const userSessionFolder = getUserSessionFolderPath(googleUserId, activeSessionName);
  fs.mkdirSync(userSessionFolder, { recursive: true });

  io.to(`user_${googleUserId}`).emit('connection:status', {
    status: 'CONNECTING',
    profile: null
  });
  emitTerminalLog(
    googleUserId,
    'INFO',
    `Menyiapkan koneksi Baileys [${connectionMethod.toUpperCase()}] menggunakan sesi: ${activeSessionName}`
  );

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(userSessionFolder);
    const { version: latestVersion } = await fetchLatestBaileysVersion();

    const whatsappSocket = makeWASocket({
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

    // --- intercept pengiriman pesan untuk menambah counter statistik secara atomic ---
    const originalSendMessage = whatsappSocket.sendMessage.bind(whatsappSocket);
    whatsappSocket.sendMessage = async (recipientJid, messageContent, messageOptions = {}) => {
      const sendResult = await originalSendMessage(recipientJid, messageContent, messageOptions);
      const latestDatabase = readBotDatabase(googleUserId);
      latestDatabase.totalMessagesSent += 1;
      writeBotDatabaseAtomic(googleUserId, latestDatabase);
      return sendResult;
    };

    activeBotSessions.set(googleUserId, {
      socketInstance: whatsappSocket,
      status: 'CONNECTING',
      profile: null,
      sessionName: activeSessionName,
      reconnectTimer: null,
      isDeletingSession: false
    });

    // --- terbitkan kode pairing jika metode pairing dipilih dan sesi belum tertaut ---
    if (connectionMethod === 'pairing' && !whatsappSocket.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const currentRecord = activeBotSessions.get(googleUserId);
          if (!currentRecord || currentRecord.isDeletingSession || whatsappSocket.authState.creds.registered) {
            return;
          }
          const rawCode = await whatsappSocket.requestPairingCode(cleanedPhoneInput);
          const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
          io.to(`user_${googleUserId}`).emit('pairing:code', formattedCode);
          emitTerminalLog(googleUserId, 'SUCCESS', `Kode Pairing diterbitkan: ${formattedCode}`);
        } catch (pairingError) {
          emitTerminalLog(googleUserId, 'ERROR', `Gagal meminta kode pairing: ${pairingError.message}`);
          io.to(`user_${googleUserId}`).emit('pairing:error', 'Gagal menerbitkan kode pairing. Periksa nomor Anda.');
        }
      }, 2500);
    }

    // --- simpan kredensial baileys ke dalam folder sesi terkait ---
    whatsappSocket.ev.on('creds.update', saveCreds);

    // --- kelola status koneksi, mapping nomor telepon saat open, dan reconnect ---
    whatsappSocket.ev.on('connection.update', async (connectionState) => {
      const currentRecord = activeBotSessions.get(googleUserId);
      if (!currentRecord || currentRecord.isDeletingSession) {
        return;
      }

      const { connection, lastDisconnect, qr } = connectionState;

      if (qr && connectionMethod === 'qr' && !whatsappSocket.authState.creds.registered) {
        try {
          const qrImageDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 280,
            color: { dark: '#090d16', light: '#ffffff' }
          });
          io.to(`user_${googleUserId}`).emit('qr:update', qrImageDataUrl);
          emitTerminalLog(googleUserId, 'INFO', `QR Code dimuat untuk sesi sementara: ${activeSessionName}`);
        } catch (qrRenderError) {
          emitTerminalLog(googleUserId, 'ERROR', `Gagal membuat QR Code: ${qrRenderError.message}`);
        }
      }

      if (connection === 'open') {
        // --- ambil nomor telepon asli bot menggunakan jidNormalizedUser dan simpan mapping ---
        const normalizedBotJid = jidNormalizedUser(whatsappSocket.user?.id || '');
        const cleanPhoneNumber = normalizedBotJid.split('@')[0];
        const whatsappName = whatsappSocket.user?.name || whatsappSocket.user?.verifiedName || 'JadiBot Active';

        const latestDatabase = readBotDatabase(googleUserId);
        latestDatabase.phoneNumber = cleanPhoneNumber;
        latestDatabase.sessionName = activeSessionName;
        writeBotDatabaseAtomic(googleUserId, latestDatabase);

        let avatarImageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(whatsappName)}&background=10b981&color=fff&size=128`;
        try {
          const fetchedAvatar = await Promise.race([
            whatsappSocket.profilePictureUrl(normalizedBotJid, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AvatarTimeout')), 3000))
          ]);
          if (fetchedAvatar) {
            avatarImageUrl = fetchedAvatar;
          }
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

        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'CONNECTED',
          profile: connectedProfile
        });
        io.to(`user_${googleUserId}`).emit('stats:update', {
          userStats: latestDatabase,
          globalStats: getGlobalPlatformStatistics()
        });
        emitTerminalLog(
          googleUserId,
          'SUCCESS',
          `Terhubung sebagai ${whatsappName} (+${cleanPhoneNumber}) [Sesi: ${activeSessionName}]`
        );
      }

      if (connection === 'close') {
        const activeRecordNow = activeBotSessions.get(googleUserId);
        if (!activeRecordNow || activeRecordNow.isDeletingSession) {
          return;
        }

        const disconnectCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const disconnectLabel = DisconnectReason[disconnectCode] || `Code ${disconnectCode || 'Unknown'}`;

        emitTerminalLog(googleUserId, 'WARN', `Koneksi terputus (${disconnectLabel}). Statistik tetap disimpan.`);

        if (disconnectCode === DisconnectReason.loggedOut || disconnectCode === DisconnectReason.badSession) {
          emitTerminalLog(googleUserId, 'ERROR', 'Sesi keluar (Logged Out). Membersihkan kredensial sesi...');
          await destroyBotSession(googleUserId, false);
          return;
        }

        // --- ambil data mapping dari database.json untuk reconnect tanpa mereset statistik ---
        const persistedDatabase = readBotDatabase(googleUserId);
        const isPostPairingRestart = disconnectCode === DisconnectReason.restartRequired || disconnectCode === 515;
        const reconnectDelayMs = isPostPairingRestart ? 800 : 3000;

        activeRecordNow.status = 'CONNECTING';
        activeRecordNow.profile = null;

        io.to(`user_${googleUserId}`).emit('connection:status', {
          status: 'CONNECTING',
          profile: null
        });

        if (activeRecordNow.reconnectTimer) {
          clearTimeout(activeRecordNow.reconnectTimer);
        }

        activeRecordNow.reconnectTimer = setTimeout(() => {
          startWhatsAppSession(googleUserId, 'reconnect', persistedDatabase.phoneNumber || '');
        }, reconnectDelayMs);
      }
    });

    // --- proses pesan masuk dan jalankan plugin tanpa mereset statistik ---
    whatsappSocket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const messageItem of messages) {
        if (!messageItem.message) continue;
        if (messageItem.key.remoteJid === 'status@broadcast') continue;

        const senderJid = messageItem.key.remoteJid;
        const participantJid = messageItem.key.participant || senderJid;
        const isFromMe = Boolean(messageItem.key.fromMe);

        const extractedText =
          messageItem.message.conversation ||
          messageItem.message.extendedTextMessage?.text ||
          messageItem.message.imageMessage?.caption ||
          messageItem.message.videoMessage?.caption ||
          '';

        const currentDatabase = readBotDatabase(googleUserId);

        if (!isFromMe) {
          currentDatabase.totalMessagesReceived += 1;
          const cleanSenderNumber = participantJid.split('@')[0];
          if (!currentDatabase.uniqueUsers.includes(cleanSenderNumber)) {
            currentDatabase.uniqueUsers.push(cleanSenderNumber);
          }
          writeBotDatabaseAtomic(googleUserId, currentDatabase);

          if (currentDatabase.settings.autoRead) {
            try {
              await whatsappSocket.readMessages([messageItem.key]);
            } catch {
              // --- abaikan error read receipt ---
            }
          }
        }

        if (extractedText) {
          emitTerminalLog(
            googleUserId,
            'MSG',
            `${isFromMe ? '[OUT]' : '[IN]'} ${participantJid.split('@')[0]}: ${extractedText.slice(0, 80)}`
          );

          if (!currentDatabase.settings.publicMode && !isFromMe) {
            continue;
          }

          const pluginContext = {
            googleUserId,
            socketInstance: whatsappSocket,
            rawMessage: messageItem,
            messageText: extractedText,
            senderJid,
            participantJid,
            isFromMe,
            botDatabase: currentDatabase,
            replyMessage: async (replyText) => {
              return await whatsappSocket.sendMessage(
                senderJid,
                { text: String(replyText) },
                { quoted: messageItem }
              );
            }
          };

          await executeDynamicPlugins(googleUserId, pluginContext);
        }
      }
    });
  } catch (sessionError) {
    emitTerminalLog(googleUserId, 'ERROR', `Kegagalan inisialisasi sesi: ${sessionError.message}`);
    io.to(`user_${googleUserId}`).emit('connection:status', {
      status: 'DISCONNECTED',
      profile: null
    });
  }
}

// --- fungsi hapus sesi kredensial baileys secara bersih dengan atomic write ---
async function destroyBotSession(googleUserId, triggerLogout = true) {
  const existingSession = activeBotSessions.get(googleUserId);
  const currentDatabase = readBotDatabase(googleUserId);
  const targetSessionName = existingSession?.sessionName || currentDatabase.sessionName;

  if (existingSession) {
    existingSession.isDeletingSession = true;

    if (existingSession.reconnectTimer) {
      clearTimeout(existingSession.reconnectTimer);
      existingSession.reconnectTimer = null;
    }

    if (existingSession.socketInstance) {
      try {
        existingSession.socketInstance.ev.removeAllListeners('connection.update');
        existingSession.socketInstance.ev.removeAllListeners('creds.update');
        existingSession.socketInstance.ev.removeAllListeners('messages.upsert');

        if (triggerLogout && existingSession.status === 'CONNECTED') {
          await Promise.race([
            existingSession.socketInstance.logout(),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ]);
        }
      } catch {
        // --- abaikan error saat proses logout socket ---
      }

      try {
        existingSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error saat mengakhiri koneksi socket ---
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
        emitTerminalLog(googleUserId, 'ERROR', `Gagal menghapus folder sesi: ${deleteError.message}`);
      }
    }
  }

  // --- bersihkan mapping sesi tanpa merusak struktur database.json ---
  currentDatabase.sessionName = null;
  currentDatabase.phoneNumber = null;
  writeBotDatabaseAtomic(googleUserId, currentDatabase);

  io.to(`user_${googleUserId}`).emit('session:reset', {
    status: 'DISCONNECTED',
    profile: null,
    database: currentDatabase,
    globalStats: getGlobalPlatformStatistics()
  });
  io.to(`user_${googleUserId}`).emit('connection:status', {
    status: 'DISCONNECTED',
    profile: null
  });
  io.to(`user_${googleUserId}`).emit('stats:update', {
    userStats: currentDatabase,
    globalStats: getGlobalPlatformStatistics()
  });
  emitTerminalLog(googleUserId, 'WARN', 'Sesi kredensial WhatsApp telah dihapus dari volume.');
}

// --- fungsi mengambil daftar seluruh file plugin di folder plugins ---
function getAvailablePluginsList() {
  if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
    return [];
  }
  return fs
    .readdirSync(PLUGINS_ROOT_DIR)
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('.temp_'))
    .map((fileName) => {
      const fullPath = path.join(PLUGINS_ROOT_DIR, fileName);
      const codeContent = fs.readFileSync(fullPath, 'utf-8');
      const fileStat = fs.statSync(fullPath);
      return {
        fileName,
        codeContent,
        updatedAt: fileStat.mtimeMs
      };
    });
}

// --- fungsi ekstraksi detail baris error untuk inspector ide ---
function extractErrorLineDetails(rawErrorOutput, referenceFilePath) {
  const outputString = String(rawErrorOutput);
  const linesList = outputString.split('\n');
  let detectedLineNumber = null;

  for (const singleLine of linesList) {
    const lineMatch = singleLine.match(/:(\d+)(?::(\d+))?/);
    if (lineMatch && (singleLine.includes(referenceFilePath) || singleLine.includes('.js'))) {
      detectedLineNumber = parseInt(lineMatch[1], 10);
      break;
    }
  }

  return {
    lineNumber: detectedLineNumber,
    cleanedErrorText: outputString.replaceAll(referenceFilePath, 'plugin-module.js').trim()
  };
}

// --- fungsi validasi sintaks dan hot-reload plugin baru ---
async function validateAndSavePlugin(googleUserId, rawFileName, pluginSourceCode) {
  const sanitizedFileName = String(rawFileName || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/\.js$/i, '');

  if (!sanitizedFileName) {
    return {
      isSuccess: false,
      errorType: 'ValidationError',
      lineNumber: 1,
      errorMessage: 'Nama file plugin tidak valid. Gunakan kombinasi huruf, angka, atau tanda hubung.'
    };
  }

  const finalFileName = `${sanitizedFileName}.js`;
  const tempValidationName = `.temp_validate_${Date.now()}_${finalFileName}`;
  const tempValidationPath = path.join(PLUGINS_ROOT_DIR, tempValidationName);
  const finalPluginPath = path.join(PLUGINS_ROOT_DIR, finalFileName);

  try {
    fs.writeFileSync(tempValidationPath, pluginSourceCode, 'utf-8');

    // --- uji sintaks javascript menggunakan node --check ---
    try {
      await executeFileAsync(process.execPath, ['--check', tempValidationPath]);
    } catch (syntaxError) {
      const errorText = syntaxError.stderr || syntaxError.message;
      const parsedDetails = extractErrorLineDetails(errorText, tempValidationPath);
      if (fs.existsSync(tempValidationPath)) {
        fs.unlinkSync(tempValidationPath);
      }
      return {
        isSuccess: false,
        errorType: 'SyntaxError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    // --- uji import modul esm dan keberadaan fungsi default ---
    try {
      const moduleCheckUrl = `${pathToFileURL(tempValidationPath).href}?check=${Date.now()}`;
      const evaluatedModule = await import(moduleCheckUrl);

      if (typeof evaluatedModule.default !== 'function') {
        if (fs.existsSync(tempValidationPath)) {
          fs.unlinkSync(tempValidationPath);
        }
        return {
          isSuccess: false,
          errorType: 'StructureError',
          lineNumber: 1,
          errorMessage: 'Plugin wajib mengekspor fungsi utama: export default async function(context) { ... }'
        };
      }
    } catch (evaluationError) {
      const stackOutput = evaluationError.stack || evaluationError.message;
      const parsedDetails = extractErrorLineDetails(stackOutput, tempValidationPath);
      if (fs.existsSync(tempValidationPath)) {
        fs.unlinkSync(tempValidationPath);
      }
      return {
        isSuccess: false,
        errorType: evaluationError.name || 'RuntimeEvaluationError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    // --- ganti file plugin secara atomic dan terapkan hot-reload ---
    fs.renameSync(tempValidationPath, finalPluginPath);
    emitTerminalLog(googleUserId, 'SUCCESS', `Plugin [${finalFileName}] lulus uji sintaks dan dimuat (Hot-Reload).`);

    return {
      isSuccess: true,
      fileName: finalFileName
    };
  } catch (systemError) {
    if (fs.existsSync(tempValidationPath)) {
      fs.unlinkSync(tempValidationPath);
    }
    return {
      isSuccess: false,
      errorType: 'FileSystemError',
      lineNumber: null,
      errorMessage: systemError.message
    };
  }
}

// --- fungsi pengeksekusi seluruh plugin secara dinamis saat ada pesan masuk ---
async function executeDynamicPlugins(googleUserId, contextPayload) {
  if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
    return;
  }

  const pluginFiles = fs
    .readdirSync(PLUGINS_ROOT_DIR)
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('.temp_'));

  for (const pluginFile of pluginFiles) {
    const fullPluginPath = path.join(PLUGINS_ROOT_DIR, pluginFile);
    try {
      const fileStat = fs.statSync(fullPluginPath);
      const hotReloadModuleUrl = `${pathToFileURL(fullPluginPath).href}?t=${fileStat.mtimeMs}`;
      const importedPlugin = await import(hotReloadModuleUrl);

      if (typeof importedPlugin.default === 'function') {
        await importedPlugin.default(contextPayload);
      }
    } catch (runtimeError) {
      const stackTrace = runtimeError.stack || runtimeError.message;
      const parsedDetails = extractErrorLineDetails(stackTrace, fullPluginPath);

      emitTerminalLog(
        googleUserId,
        'ERROR',
        `Runtime Error di [${pluginFile}]${parsedDetails.lineNumber ? ` baris ${parsedDetails.lineNumber}` : ''}: ${runtimeError.message}`
      );

      io.to(`user_${googleUserId}`).emit('plugin:error', {
        fileName: pluginFile,
        errorType: runtimeError.name || 'RuntimeError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      });
    }
  }
}

// --- pulihkan otomatis sesi yang tersimpan di volume saat server menyala ---
function restoreExistingSessionsOnBoot() {
  if (!fs.existsSync(SESSIONS_VOLUME_ROOT)) return;
  const userFolders = fs.readdirSync(SESSIONS_VOLUME_ROOT, { withFileTypes: true });

  for (const folderEntry of userFolders) {
    if (folderEntry.isDirectory() && folderEntry.name.startsWith('user_')) {
      const extractedGoogleId = folderEntry.name.replace(/^user_/, '');
      const credsFilePath = path.join(SESSIONS_VOLUME_ROOT, folderEntry.name, 'creds.json');
      if (fs.existsSync(credsFilePath)) {
        startWhatsAppSession(extractedGoogleId, 'qr', '');
      }
    }
  }
}

// --- endpoint konfigurasi publik untuk menyediakan client id ke frontend ---
app.get('/api/auth/config', (request, response) => {
  response.status(200).json({
    googleClientId: GOOGLE_CLIENT_ID,
    volumePath: SESSIONS_VOLUME_ROOT
  });
});

// --- endpoint verifikasi login google oauth 2.0 ---
app.post('/api/auth/google', async (request, response) => {
  try {
    const { credential } = request.body || {};
    const verifiedUser = await verifyGoogleCredentialToken(credential);
    response.status(200).json({
      isAuthenticated: true,
      user: verifiedUser
    });
  } catch (authError) {
    response.status(401).json({
      isAuthenticated: false,
      errorMessage: authError.message
    });
  }
});

// --- endpoint healthcheck untuk monitoring railway ---
app.get('/health', (request, response) => {
  response.status(200).json({
    status: 'ok',
    volumeRoot: SESSIONS_VOLUME_ROOT,
    uptime: process.uptime()
  });
});

// --- penanganan komunikasi socket.io terproteksi token google ---
io.on('connection', (clientSocket) => {
  let authenticatedGoogleId = null;

  // --- autentikasi sesi socket menggunakan kredensial google ---
  clientSocket.on('session:authenticate', async (payload) => {
    try {
      const verifiedUser = await verifyGoogleCredentialToken(payload?.credential);
      authenticatedGoogleId = verifiedUser.googleId;

      const userRoomName = `user_${authenticatedGoogleId}`;
      clientSocket.join(userRoomName);

      const userDatabase = readBotDatabase(authenticatedGoogleId);
      const currentBotState = activeBotSessions.get(authenticatedGoogleId);
      const pluginsList = getAvailablePluginsList();

      clientSocket.emit('session:ready', {
        user: verifiedUser,
        volumePath: getUserSessionFolderPath(authenticatedGoogleId),
        status: currentBotState ? currentBotState.status : 'DISCONNECTED',
        profile: currentBotState ? currentBotState.profile : null,
        database: userDatabase,
        globalStats: getGlobalPlatformStatistics(),
        plugins: pluginsList
      });

      emitTerminalLog(
        authenticatedGoogleId,
        'INFO',
        `OAuth Terverifikasi: ${verifiedUser.givenName} (Folder Volume: user_${authenticatedGoogleId})`
      );
    } catch (socketAuthError) {
      clientSocket.emit('auth:expired', {
        errorMessage: socketAuthError.message
      });
    }
  });

  // --- mulai koneksi baru via qr atau phone pairing ---
  clientSocket.on('session:connect', async (payload) => {
    if (!authenticatedGoogleId) return;
    const method = payload?.method === 'pairing' ? 'pairing' : 'qr';
    const phoneNumber = payload?.phoneNumber || '';

    const existingSession = activeBotSessions.get(authenticatedGoogleId);
    if (existingSession?.socketInstance) {
      try {
        existingSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error penutupan socket lama ---
      }
      activeBotSessions.delete(authenticatedGoogleId);
    }

    await startWhatsAppSession(authenticatedGoogleId, method, phoneNumber);
  });

  // --- hapus sesi dan database.json milik user ---
  clientSocket.on('session:logout', async () => {
    if (!authenticatedGoogleId) return;
    await destroyBotSession(authenticatedGoogleId, true);
  });

  // --- ubah toggle pengaturan bot di dalam database.json ---
  clientSocket.on('settings:toggle', (payload) => {
    if (!authenticatedGoogleId) return;
    const settingKey = payload?.key;
    if (settingKey !== 'autoRead' && settingKey !== 'publicMode') return;

    const currentDatabase = readBotDatabase(authenticatedGoogleId);
    currentDatabase.settings[settingKey] = !currentDatabase.settings[settingKey];
    writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

    emitTerminalLog(
      authenticatedGoogleId,
      'INFO',
      `Pengaturan [${settingKey}] diubah ke: ${currentDatabase.settings[settingKey] ? 'AKTIF' : 'NONAKTIF'}`
    );
  });

  // --- simpan dan hot-reload plugin dari developer ide ---
  clientSocket.on('plugin:save', async (payload) => {
    if (!authenticatedGoogleId) return;
    const { fileName, codeContent } = payload || {};

    emitTerminalLog(authenticatedGoogleId, 'INFO', `Menguji validitas sintaks plugin [${fileName}]...`);
    const validationResult = await validateAndSavePlugin(authenticatedGoogleId, fileName, codeContent);

    if (validationResult.isSuccess) {
      io.emit('plugin:list', getAvailablePluginsList());
      clientSocket.emit('plugin:save:result', {
        isSuccess: true,
        fileName: validationResult.fileName
      });
    } else {
      emitTerminalLog(
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

  // --- hapus file plugin dari folder plugins ---
  clientSocket.on('plugin:delete', (payload) => {
    if (!authenticatedGoogleId) return;
    const targetFileName = String(payload?.fileName || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    const fullTargetPath = path.join(PLUGINS_ROOT_DIR, targetFileName);

    if (fs.existsSync(fullTargetPath) && targetFileName.endsWith('.js')) {
      fs.unlinkSync(fullTargetPath);
      emitTerminalLog(authenticatedGoogleId, 'WARN', `Plugin [${targetFileName}] dihapus.`);
      io.emit('plugin:list', getAvailablePluginsList());
    }
  });
});

// --- jalankan server http pada host 0.0.0.0 untuk kompatibilitas railway ---
httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[SERVER] JadiBot Platform berjalan di port ${SERVER_PORT} | Volume: ${SESSIONS_VOLUME_ROOT}`);
  restoreExistingSessionsOnBoot();
});
