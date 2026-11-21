// --- manajemen database.json persisten dengan metode atomic write anti-corrupt ---
import fs from 'fs';
import path from 'path';
import {
  ADMIN_EMAILS,
  ADMIN_GOOGLE_IDS,
  CONFIG,
  MAIN_DATABASE_FILE_PATH,
  SESSIONS_ROOT_FOLDER_PATH,
  SESSIONS_VOLUME_ROOT
} from './config.js';

// --- baca berkas master database.json secara aman ---
export function readMasterDatabaseFile() {
  if (!fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    return { users: {}, platformAdmins: [] };
  }

  try {
    const parsedContent = JSON.parse(fs.readFileSync(MAIN_DATABASE_FILE_PATH, 'utf-8'));
    if (!parsedContent || typeof parsedContent.users !== 'object') {
      return { users: {}, platformAdmins: [] };
    }
    if (!Array.isArray(parsedContent.platformAdmins)) {
      parsedContent.platformAdmins = [];
    }
    return parsedContent;
  } catch {
    return { users: {}, platformAdmins: [] };
  }
}

// --- tulis master database.json secara atomic melalui file sementara ---
export function writeMasterDatabaseFileAtomic(masterDatabaseObject) {
  fs.mkdirSync(SESSIONS_VOLUME_ROOT, { recursive: true });
  const tempFilePath = `${MAIN_DATABASE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(masterDatabaseObject, null, 2), 'utf-8');
  fs.renameSync(tempFilePath, MAIN_DATABASE_FILE_PATH);
}

// --- cek apakah akun google memiliki hak akses admin platform (ide & backup) ---
export function isPlatformAdminUser(sessionUser) {
  if (!sessionUser?.googleId) return false;

  const normalizedId = String(sessionUser.googleId).toLowerCase();
  const normalizedEmail = String(sessionUser.email || '').toLowerCase();

  if (ADMIN_EMAILS.length > 0 || ADMIN_GOOGLE_IDS.length > 0) {
    return (
      ADMIN_GOOGLE_IDS.includes(normalizedId) ||
      (normalizedEmail && ADMIN_EMAILS.includes(normalizedEmail))
    );
  }

  const masterDb = readMasterDatabaseFile();
  if (masterDb.platformAdmins.length === 0) {
    masterDb.platformAdmins.push(sessionUser.googleId);
    writeMasterDatabaseFileAtomic(masterDb);
    return true;
  }

  return masterDb.platformAdmins.some((id) => String(id).toLowerCase() === normalizedId);
}

// --- ambil data statistik dan mapping sesi milik akun google ---
export function readBotDatabase(googleUserId) {
  const masterDatabase = readMasterDatabaseFile();
  const existingUserRecord = masterDatabase.users[googleUserId];

  const defaultSettings = {
    autoRead: true,
    publicMode: true,
    botName: CONFIG.platformName,
    packname: CONFIG.platformName,
    author: 'Surya Core',
    isNoPrefix: true,
    allowedPc: true,
    toxic: []
  };

  const defaultUserRecord = {
    googleUserId,
    phoneNumber: null,
    sessionName: null,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    uniqueUsers: [],
    startTime: Date.now(),
    settings: defaultSettings
  };

  if (!existingUserRecord) {
    masterDatabase.users[googleUserId] = defaultUserRecord;
    writeMasterDatabaseFileAtomic(masterDatabase);
    return defaultUserRecord;
  }

  const mergedSettings = {
    ...defaultSettings,
    ...(existingUserRecord.settings || {})
  };
  mergedSettings.toxic = Array.isArray(mergedSettings.toxic) ? mergedSettings.toxic : [];

  return {
    ...defaultUserRecord,
    ...existingUserRecord,
    uniqueUsers: Array.isArray(existingUserRecord.uniqueUsers) ? existingUserRecord.uniqueUsers : [],
    settings: mergedSettings
  };
}

// --- simpan perubahan data akun google secara atomic ---
export function writeBotDatabaseAtomic(googleUserId, updatedUserDatabase) {
  const masterDatabase = readMasterDatabaseFile();
  const currentRecord = masterDatabase.users[googleUserId] || {};

  masterDatabase.users[googleUserId] = {
    ...currentRecord,
    ...updatedUserDatabase,
    googleUserId
  };

  writeMasterDatabaseFileAtomic(masterDatabase);
}

// --- resolusi path folder sesi baileys di dalam volume ---
export function getUserSessionFolderPath(googleUserId, explicitSessionName = null) {
  const userDatabase = readBotDatabase(googleUserId);
  const resolvedSessionName = explicitSessionName || userDatabase.sessionName || `qr_${googleUserId}`;
  const safeFolderName = String(resolvedSessionName).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSIONS_ROOT_FOLDER_PATH, safeFolderName);
}

// --- kalkulasi statistik trafik global lintas akun ---
export function getGlobalPlatformStatistics(activeBotSessions) {
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

// --- hitung total ukuran direktori volume secara rekursif dalam byte ---
export function calculateDirectorySizeBytes(targetDirPath) {
  if (!fs.existsSync(targetDirPath)) return 0;

  let totalBytes = 0;
  try {
    const entries = fs.readdirSync(targetDirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(targetDirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          totalBytes += calculateDirectorySizeBytes(fullPath);
        } else if (entry.isFile()) {
          totalBytes += fs.statSync(fullPath).size;
        }
      } catch {
        // --- lewati file sementara yang sudah terhapus ---
      }
    }
  } catch {
    return 0;
  }

  return totalBytes;
}
