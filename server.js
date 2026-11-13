// --- import modul bawaan nodejs dan dependensi eksternal ---
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

// --- inisialisasi utilitas path dan eksekusi proses ---
const executeFileAsync = promisify(execFile);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = path.dirname(currentFilePath);

// --- konfigurasi server express dan socket.io untuk railway ---
const app = express();
app.set('trust proxy', 1);

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
const SESSIONS_ROOT_DIR = path.join(currentDirectoryPath, 'sessions');
const PLUGINS_ROOT_DIR = path.join(currentDirectoryPath, 'plugins');

// --- pastikan direktori utama tersedia ---
if (!fs.existsSync(SESSIONS_ROOT_DIR)) {
  fs.mkdirSync(SESSIONS_ROOT_DIR, { recursive: true });
}
if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
  fs.mkdirSync(PLUGINS_ROOT_DIR, { recursive: true });
}

// --- konfigurasi middleware express ---
app.use(express.json());
app.use(express.static(path.join(currentDirectoryPath, 'public')));

// --- penyimpanan state sesi bot aktif di memori ---
const activeBotSessions = new Map();
const silentLogger = pino({ level: 'silent' });

// --- buat plugin bawaan jika folder plugins masih kosong ---
function initializeDefaultPlugin() {
  const defaultPluginPath = path.join(PLUGINS_ROOT_DIR, 'core-commands.js');
  if (!fs.existsSync(defaultPluginPath)) {
    const defaultPluginCode = `// --- plugin bawaan untuk respon perintah dasar ---
export default async function executePlugin(context) {
  const { socketInstance, messageText, senderJid, replyMessage, botDatabase } = context;
  const cleanCommand = messageText.trim().toLowerCase();

  if (cleanCommand === '.ping') {
    const startTimestamp = Date.now();
    await replyMessage(\`Pong! Status Bot Aktif.\\nTotal Pesan Diterima: \${botDatabase.totalMessagesReceived}\\nTotal User Unik: \${botDatabase.uniqueUsers.length}\`);
  }

  if (cleanCommand === '.info') {
    const uptimeSeconds = Math.floor((Date.now() - botDatabase.startTime) / 1000);
    await replyMessage(\`[ JADIBOT ENTERPRISE ]\\nUptime: \${uptimeSeconds} detik\\nMode Public: \${botDatabase.settings.publicMode ? 'Aktif' : 'Nonaktif'}\`);
  }
}
`;
    fs.writeFileSync(defaultPluginPath, defaultPluginCode, 'utf-8');
  }
}

initializeDefaultPlugin();

// --- fungsi logger custom yang mengirim log ke terminal frontend ---
function emitTerminalLog(sessionId, logLevel, logMessage) {
  const timestampText = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const logPayload = {
    timestamp: timestampText,
    level: logLevel,
    message: logMessage
  };
  io.to(sessionId).emit('terminal:log', logPayload);
}

// --- fungsi untuk mendapatkan path folder sesi spesifik ---
function getSessionFolderPath(sessionId) {
  const sanitizedId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSIONS_ROOT_DIR, `session_${sanitizedId}`);
}

// --- fungsi untuk mendapatkan path database json per sesi ---
function getDatabaseFilePath(sessionId) {
  return path.join(getSessionFolderPath(sessionId), 'database.json');
}

// --- fungsi inisialisasi atau baca database json terisolasi ---
function readBotDatabase(sessionId) {
  const sessionFolder = getSessionFolderPath(sessionId);
  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  const databasePath = getDatabaseFilePath(sessionId);
  const defaultDatabaseStructure = {
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    uniqueUsers: [],
    startTime: Date.now(),
    settings: {
      autoRead: true,
      publicMode: true
    }
  };

  if (!fs.existsSync(databasePath)) {
    writeBotDatabaseAtomic(sessionId, defaultDatabaseStructure);
    return defaultDatabaseStructure;
  }

  try {
    const rawContent = fs.readFileSync(databasePath, 'utf-8');
    const parsedData = JSON.parse(rawContent);
    return {
      totalMessagesReceived: Number(parsedData.totalMessagesReceived) || 0,
      totalMessagesSent: Number(parsedData.totalMessagesSent) || 0,
      uniqueUsers: Array.isArray(parsedData.uniqueUsers) ? parsedData.uniqueUsers : [],
      startTime: Number(parsedData.startTime) || Date.now(),
      settings: {
        autoRead: parsedData.settings?.autoRead ?? true,
        publicMode: parsedData.settings?.publicMode ?? true
      }
    };
  } catch (readError) {
    emitTerminalLog(sessionId, 'WARN', 'Database korup terdeteksi, memulihkan struktur default...');
    writeBotDatabaseAtomic(sessionId, defaultDatabaseStructure);
    return defaultDatabaseStructure;
  }
}

// --- fungsi atomic write untuk mencegah korupsi file database json ---
function writeBotDatabaseAtomic(sessionId, databaseObject) {
  try {
    const sessionFolder = getSessionFolderPath(sessionId);
    if (!fs.existsSync(sessionFolder)) {
      fs.mkdirSync(sessionFolder, { recursive: true });
    }

    const targetDatabasePath = getDatabaseFilePath(sessionId);
    const temporaryDatabasePath = `${targetDatabasePath}.${Date.now()}.tmp`;

    const serializedData = JSON.stringify(databaseObject, null, 2);
    fs.writeFileSync(temporaryDatabasePath, serializedData, 'utf-8');
    fs.renameSync(temporaryDatabasePath, targetDatabasePath);

    io.to(sessionId).emit('stats:update', databaseObject);
  } catch (writeError) {
    emitTerminalLog(sessionId, 'ERROR', `Gagal melakukan atomic write database: ${writeError.message}`);
  }
}

// --- fungsi membaca daftar semua plugin di folder plugins ---
function getAvailablePluginsList() {
  if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
    return [];
  }
  const allFiles = fs.readdirSync(PLUGINS_ROOT_DIR);
  return allFiles
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

// --- fungsi ekstraksi nomor baris dari pesan atau stack error ---
function extractErrorLineDetails(errorOutput, referenceFilePath) {
  const outputString = String(errorOutput);
  const lines = outputString.split('\n');
  let detectedLineNumber = null;

  for (const singleLine of lines) {
    const lineMatch = singleLine.match(/:(\d+)(?::(\d+))?/);
    if (lineMatch && (singleLine.includes(referenceFilePath) || singleLine.includes('.js'))) {
      detectedLineNumber = parseInt(lineMatch[1], 10);
      break;
    }
  }

  return {
    lineNumber: detectedLineNumber,
    cleanedErrorText: outputString.replaceAll(referenceFilePath, 'plugin-validation.js').trim()
  };
}

// --- fungsi validasi sintaks dan runtime plugin sebelum disimpan permanen ---
async function validateAndSavePlugin(sessionId, rawFileName, pluginSourceCode) {
  const sanitizedName = String(rawFileName)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/\.js$/i, '');

  if (!sanitizedName) {
    return {
      isSuccess: false,
      errorType: 'ValidationError',
      lineNumber: 1,
      errorMessage: 'Nama file plugin tidak valid. Gunakan huruf, angka, atau tanda hubung.'
    };
  }

  const finalFileName = `${sanitizedName}.js`;
  const temporaryFileName = `.temp_validate_${Date.now()}_${finalFileName}`;
  const temporaryFilePath = path.join(PLUGINS_ROOT_DIR, temporaryFileName);
  const finalFilePath = path.join(PLUGINS_ROOT_DIR, finalFileName);

  try {
    fs.writeFileSync(temporaryFilePath, pluginSourceCode, 'utf-8');

    // --- tahap 1 uji sintaks menggunakan node --check ---
    try {
      await executeFileAsync(process.execPath, ['--check', temporaryFilePath]);
    } catch (syntaxCheckError) {
      const stderrOutput = syntaxCheckError.stderr || syntaxCheckError.message;
      const parsedDetails = extractErrorLineDetails(stderrOutput, temporaryFilePath);
      if (fs.existsSync(temporaryFilePath)) {
        fs.unlinkSync(temporaryFilePath);
      }
      return {
        isSuccess: false,
        errorType: 'SyntaxError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    // --- tahap 2 uji evaluasi modul dan struktur export ---
    try {
      const moduleUrl = `${pathToFileURL(temporaryFilePath).href}?validate=${Date.now()}`;
      const importedModule = await import(moduleUrl);

      if (typeof importedModule.default !== 'function') {
        if (fs.existsSync(temporaryFilePath)) {
          fs.unlinkSync(temporaryFilePath);
        }
        return {
          isSuccess: false,
          errorType: 'StructureError',
          lineNumber: 1,
          errorMessage: 'Plugin wajib memiliki "export default async function(context) { ... }" sebagai handler utama.'
        };
      }
    } catch (evaluationError) {
      const stackOutput = evaluationError.stack || evaluationError.message;
      const parsedDetails = extractErrorLineDetails(stackOutput, temporaryFilePath);
      if (fs.existsSync(temporaryFilePath)) {
        fs.unlinkSync(temporaryFilePath);
      }
      return {
        isSuccess: false,
        errorType: evaluationError.name || 'RuntimeEvaluationError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    // --- tahap 3 simpan secara atomic ke file plugin tujuan ---
    fs.renameSync(temporaryFilePath, finalFilePath);
    emitTerminalLog(sessionId, 'SUCCESS', `Plugin [${finalFileName}] berhasil divalidasi dan dimuat secara hot-reload.`);

    return {
      isSuccess: true,
      fileName: finalFileName
    };
  } catch (unexpectedError) {
    if (fs.existsSync(temporaryFilePath)) {
      fs.unlinkSync(temporaryFilePath);
    }
    return {
      isSuccess: false,
      errorType: 'FileSystemError',
      lineNumber: null,
      errorMessage: unexpectedError.message
    };
  }
}

// --- fungsi eksekutor dinamis seluruh plugin saat pesan masuk ---
async function executeDynamicPlugins(sessionId, contextPayload) {
  if (!fs.existsSync(PLUGINS_ROOT_DIR)) {
    return;
  }

  const pluginFiles = fs
    .readdirSync(PLUGINS_ROOT_DIR)
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('.temp_'));

  for (const pluginFile of pluginFiles) {
    const fullPluginPath = path.join(PLUGINS_ROOT_DIR, pluginFile);
    try {
      const fileStatistics = fs.statSync(fullPluginPath);
      const hotReloadUrl = `${pathToFileURL(fullPluginPath).href}?version=${fileStatistics.mtimeMs}`;
      const pluginModule = await import(hotReloadUrl);

      if (typeof pluginModule.default === 'function') {
        await pluginModule.default(contextPayload);
      }
    } catch (runtimeError) {
      const stackTrace = runtimeError.stack || runtimeError.message;
      const parsedDetails = extractErrorLineDetails(stackTrace, fullPluginPath);

      emitTerminalLog(
        sessionId,
        'ERROR',
        `Runtime Error pada plugin [${pluginFile}]${parsedDetails.lineNumber ? ` baris ${parsedDetails.lineNumber}` : ''}: ${runtimeError.message}`
      );

      io.to(sessionId).emit('plugin:error', {
        fileName: pluginFile,
        errorType: runtimeError.name || 'RuntimeError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText,
        timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false })
      });
    }
  }
}

// --- fungsi utama inisialisasi koneksi baileys per sesi ---
async function startWhatsAppSession(sessionId, connectionMethod = 'qr', phoneNumberInput = '') {
  const existingSession = activeBotSessions.get(sessionId);
  if (existingSession?.socketInstance && existingSession.status === 'CONNECTED') {
    emitTerminalLog(sessionId, 'INFO', 'Sesi sudah terhubung dan aktif.');
    return;
  }

  const sessionFolder = getSessionFolderPath(sessionId);
  const botDatabase = readBotDatabase(sessionId);

  io.to(sessionId).emit('connection:status', {
    status: 'CONNECTING',
    profile: null
  });
  emitTerminalLog(sessionId, 'INFO', `Menginisialisasi sesi Baileys (${connectionMethod.toUpperCase()})...`);

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version: baileysVersion } = await fetchLatestBaileysVersion();

    const whatsappSocket = makeWASocket({
      version: baileysVersion,
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

    // --- intercept fungsi sendMessage untuk mencatat statistik pesan terkirim ---
    const originalSendMessage = whatsappSocket.sendMessage.bind(whatsappSocket);
    whatsappSocket.sendMessage = async (recipientJid, messageContent, messageOptions = {}) => {
      const sendResult = await originalSendMessage(recipientJid, messageContent, messageOptions);
      const currentDb = readBotDatabase(sessionId);
      currentDb.totalMessagesSent += 1;
      writeBotDatabaseAtomic(sessionId, currentDb);
      return sendResult;
    };

    activeBotSessions.set(sessionId, {
      socketInstance: whatsappSocket,
      status: 'CONNECTING',
      profile: null,
      reconnectTimer: null
    });

    // --- permintaan pairing code jika menggunakan metode nomor telepon ---
    if (connectionMethod === 'pairing' && !whatsappSocket.authState.creds.registered) {
      const cleanedPhoneNumber = String(phoneNumberInput).replace(/[^0-9]/g, '');
      if (cleanedPhoneNumber.length < 8) {
        emitTerminalLog(sessionId, 'ERROR', 'Nomor telepon tidak valid untuk Pairing Code.');
        io.to(sessionId).emit('pairing:error', 'Format nomor telepon tidak valid. Gunakan awalan kode negara (contoh: 62812xxx).');
      } else {
        setTimeout(async () => {
          try {
            const rawPairingCode = await whatsappSocket.requestPairingCode(cleanedPhoneNumber);
            const formattedPairingCode = rawPairingCode?.match(/.{1,4}/g)?.join('-') || rawPairingCode;
            io.to(sessionId).emit('pairing:code', formattedPairingCode);
            emitTerminalLog(sessionId, 'SUCCESS', `Kode Pairing berhasil dibuat: ${formattedPairingCode}`);
          } catch (pairingException) {
            emitTerminalLog(sessionId, 'ERROR', `Gagal meminta kode pairing: ${pairingException.message}`);
            io.to(sessionId).emit('pairing:error', 'Gagal mengambil kode pairing. Pastikan nomor aktif dan coba lagi.');
          }
        }, 3000);
      }
    }

    // --- simpan kredensial saat diperbarui ---
    whatsappSocket.ev.on('creds.update', saveCreds);

    // --- tangani perubahan siklus koneksi baileys ---
    whatsappSocket.ev.on('connection.update', async (updateState) => {
      const { connection, lastDisconnect, qr } = updateState;

      if (qr && connectionMethod === 'qr') {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 280,
            color: { dark: '#0f172a', light: '#ffffff' }
          });
          io.to(sessionId).emit('qr:update', qrDataUrl);
          emitTerminalLog(sessionId, 'INFO', 'QR Code baru diterbitkan. Silakan pindai melalui WhatsApp Anda.');
        } catch (qrError) {
          emitTerminalLog(sessionId, 'ERROR', `Gagal merender QR Code: ${qrError.message}`);
        }
      }

      if (connection === 'open') {
        const rawUserId = whatsappSocket.user?.id || '';
        const cleanBotNumber = rawUserId.split(':')[0].split('@')[0];
        const botDisplayName = whatsappSocket.user?.name || whatsappSocket.user?.verifiedName || 'JadiBot Active User';

        let profilePictureUrl = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(botDisplayName) + '&background=10b981&color=fff&size=128';
        try {
          const fetchedPpUrl = await whatsappSocket.profilePictureUrl(`${cleanBotNumber}@s.whatsapp.net`, 'image');
          if (fetchedPpUrl) {
            profilePictureUrl = fetchedPpUrl;
          }
        } catch {
          // --- gunakan avatar fallback jika foto profil diprivasi ---
        }

        const profileData = {
          name: botDisplayName,
          number: cleanBotNumber,
          avatarUrl: profilePictureUrl
        };

        const sessionState = activeBotSessions.get(sessionId);
        if (sessionState) {
          sessionState.status = 'CONNECTED';
          sessionState.profile = profileData;
        }

        io.to(sessionId).emit('connection:status', {
          status: 'CONNECTED',
          profile: profileData
        });
        io.to(sessionId).emit('stats:update', botDatabase);
        emitTerminalLog(sessionId, 'SUCCESS', `Terhubung sebagai ${botDisplayName} (${cleanBotNumber}).`);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const disconnectReasonText = DisconnectReason[statusCode] || `Code ${statusCode || 'Unknown'}`;

        emitTerminalLog(sessionId, 'WARN', `Koneksi terputus (${disconnectReasonText}).`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
          emitTerminalLog(sessionId, 'ERROR', 'Sesi keluar (Logged Out / Bad Session). Menghapus sesi dan menghentikan auto-reconnect...');
          await destroyBotSession(sessionId, false);
        } else {
          const shouldReconnect = [
            DisconnectReason.connectionClosed,
            DisconnectReason.connectionLost,
            DisconnectReason.connectionReplaced,
            DisconnectReason.restartRequired,
            DisconnectReason.timedOut,
            DisconnectReason.unavailableService
          ].includes(statusCode) || !statusCode;

          if (shouldReconnect) {
            io.to(sessionId).emit('connection:status', {
              status: 'CONNECTING',
              profile: null
            });
            emitTerminalLog(sessionId, 'INFO', 'Menjadwalkan auto-reconnect dalam 4 detik...');

            const currentSessionObj = activeBotSessions.get(sessionId);
            if (currentSessionObj?.reconnectTimer) {
              clearTimeout(currentSessionObj.reconnectTimer);
            }

            const timerId = setTimeout(() => {
              startWhatsAppSession(sessionId, 'qr', '');
            }, 4000);

            if (currentSessionObj) {
              currentSessionObj.reconnectTimer = timerId;
            }
          }
        }
      }
    });

    // --- tangani pesan masuk dan jalankan auto-loader plugins ---
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

        const currentDatabase = readBotDatabase(sessionId);

        if (!isFromMe) {
          currentDatabase.totalMessagesReceived += 1;
          const normalizedUserNumber = participantJid.split('@')[0];
          if (!currentDatabase.uniqueUsers.includes(normalizedUserNumber)) {
            currentDatabase.uniqueUsers.push(normalizedUserNumber);
          }
          writeBotDatabaseAtomic(sessionId, currentDatabase);

          if (currentDatabase.settings.autoRead) {
            try {
              await whatsappSocket.readMessages([messageItem.key]);
            } catch {
              // --- abaikan jika gagal menandai telah dibaca ---
            }
          }
        }

        if (extractedText) {
          emitTerminalLog(
            sessionId,
            'MSG',
            `${isFromMe ? '[OUT]' : '[IN]'} ${participantJid.split('@')[0]}: ${extractedText.slice(0, 80)}`
          );

          if (!currentDatabase.settings.publicMode && !isFromMe) {
            continue;
          }

          const pluginContext = {
            sessionId,
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

          await executeDynamicPlugins(sessionId, pluginContext);
        }
      }
    });
  } catch (initializationError) {
    emitTerminalLog(sessionId, 'ERROR', `Kesalahan inisialisasi Baileys: ${initializationError.message}`);
    io.to(sessionId).emit('connection:status', {
      status: 'DISCONNECTED',
      profile: null
    });
  }
}

// --- fungsi untuk memutus koneksi dan menghapus direktori sesi secara permanen ---
async function destroyBotSession(sessionId, initiateLogout = true) {
  const existingSession = activeBotSessions.get(sessionId);

  if (existingSession) {
    if (existingSession.reconnectTimer) {
      clearTimeout(existingSession.reconnectTimer);
    }
    if (existingSession.socketInstance) {
      try {
        if (initiateLogout && existingSession.status === 'CONNECTED') {
          await existingSession.socketInstance.logout();
        } else {
          existingSession.socketInstance.end(undefined);
        }
      } catch {
        // --- abaikan error saat penutupan paksa socket ---
      }
    }
    activeBotSessions.delete(sessionId);
  }

  const sessionFolder = getSessionFolderPath(sessionId);
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (removeError) {
      emitTerminalLog(sessionId, 'ERROR', `Gagal menghapus direktori sesi: ${removeError.message}`);
    }
  }

  const freshDatabase = readBotDatabase(sessionId);
  io.to(sessionId).emit('connection:status', {
    status: 'DISCONNECTED',
    profile: null
  });
  io.to(sessionId).emit('stats:update', freshDatabase);
  emitTerminalLog(sessionId, 'WARN', 'Sesi dan database.json telah direset sepenuhnya.');
}

// --- pemulihan otomatis sesi yang sudah memiliki kredensial tersimpan saat server menyala ---
function restoreExistingSessionsOnBoot() {
  if (!fs.existsSync(SESSIONS_ROOT_DIR)) return;
  const directories = fs.readdirSync(SESSIONS_ROOT_DIR, { withFileTypes: true });

  for (const dirEntry of directories) {
    if (dirEntry.isDirectory() && dirEntry.name.startsWith('session_')) {
      const extractedSessionId = dirEntry.name.replace(/^session_/, '');
      const credsFilePath = path.join(SESSIONS_ROOT_DIR, dirEntry.name, 'creds.json');
      if (fs.existsSync(credsFilePath)) {
        startWhatsAppSession(extractedSessionId, 'qr', '');
      }
    }
  }
}

// --- konfigurasi komunikasi real-time socket.io ---
io.on('connection', (clientSocket) => {
  let boundSessionId = null;

  // --- registrasi room sesi klien ---
  clientSocket.on('session:init', (payload) => {
    const requestedSessionId = String(payload?.sessionId || clientSocket.id).replace(/[^a-zA-Z0-9_-]/g, '');
    boundSessionId = requestedSessionId;
    clientSocket.join(boundSessionId);

    const currentDatabase = readBotDatabase(boundSessionId);
    const activeSessionState = activeBotSessions.get(boundSessionId);
    const pluginsList = getAvailablePluginsList();

    clientSocket.emit('session:ready', {
      sessionId: boundSessionId,
      status: activeSessionState ? activeSessionState.status : 'DISCONNECTED',
      profile: activeSessionState ? activeSessionState.profile : null,
      database: currentDatabase,
      plugins: pluginsList
    });

    emitTerminalLog(boundSessionId, 'INFO', `Panel terhubung ke ruang kerja sesi [${boundSessionId}].`);
  });

  // --- mulai koneksi via qr atau pairing code ---
  clientSocket.on('session:connect', async (payload) => {
    if (!boundSessionId) return;
    const method = payload?.method === 'pairing' ? 'pairing' : 'qr';
    const phoneNumber = payload?.phoneNumber || '';

    const currentSession = activeBotSessions.get(boundSessionId);
    if (currentSession?.socketInstance) {
      try {
        currentSession.socketInstance.end(undefined);
      } catch {
        // --- abaikan error penutupan socket lama ---
      }
      activeBotSessions.delete(boundSessionId);
    }

    await startWhatsAppSession(boundSessionId, method, phoneNumber);
  });

  // --- hapus sesi dan logout ---
  clientSocket.on('session:logout', async () => {
    if (!boundSessionId) return;
    await destroyBotSession(boundSessionId, true);
  });

  // --- perbarui pengaturan bot di database.json ---
  clientSocket.on('settings:toggle', (payload) => {
    if (!boundSessionId) return;
    const settingKey = payload?.key;
    if (settingKey !== 'autoRead' && settingKey !== 'publicMode') return;

    const currentDatabase = readBotDatabase(boundSessionId);
    currentDatabase.settings[settingKey] = !currentDatabase.settings[settingKey];
    writeBotDatabaseAtomic(boundSessionId, currentDatabase);

    emitTerminalLog(
      boundSessionId,
      'INFO',
      `Pengaturan [${settingKey}] diubah menjadi: ${currentDatabase.settings[settingKey] ? 'AKTIF' : 'NONAKTIF'}`
    );
  });

  // --- simpan dan hot-reload plugin dari developer ide ---
  clientSocket.on('plugin:save', async (payload) => {
    if (!boundSessionId) return;
    const { fileName, codeContent } = payload || {};

    emitTerminalLog(boundSessionId, 'INFO', `Menguji sintaks dan memuat plugin [${fileName}]...`);
    const validationResult = await validateAndSavePlugin(boundSessionId, fileName, codeContent);

    if (validationResult.isSuccess) {
      const updatedPlugins = getAvailablePluginsList();
      io.emit('plugin:list', updatedPlugins);
      clientSocket.emit('plugin:save:result', {
        isSuccess: true,
        fileName: validationResult.fileName
      });
    } else {
      emitTerminalLog(
        boundSessionId,
        'ERROR',
        `Gagal memuat plugin [${fileName}]: ${validationResult.errorType} ${validationResult.lineNumber ? `(Baris ${validationResult.lineNumber})` : ''}`
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
    if (!boundSessionId) return;
    const targetFileName = String(payload?.fileName || '').replace(/[^a-zA-Z0-9_.-]/g, '');
    const fullTargetPath = path.join(PLUGINS_ROOT_DIR, targetFileName);

    if (fs.existsSync(fullTargetPath) && targetFileName.endsWith('.js')) {
      fs.unlinkSync(fullTargetPath);
      emitTerminalLog(boundSessionId, 'WARN', `Plugin [${targetFileName}] telah dihapus.`);
      io.emit('plugin:list', getAvailablePluginsList());
    }
  });
});

// --- endpoint healthcheck untuk monitoring railway ---
app.get('/health', (request, response) => {
  response.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// --- jalankan server http pada host 0.0.0.0 agar dapat diakses railway ---
httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[SERVER] WhatsApp JadiBot Platform aktif di port ${SERVER_PORT}`);
  restoreExistingSessionsOnBoot();
});