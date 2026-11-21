// --- manajemen database.json persisten dengan metode atomic write anti-corrupt ---
import fs from 'fs';
import path from 'path';
import {
  MAIN_DATABASE_FILE_PATH,
  SESSIONS_ROOT_FOLDER_PATH,
  SESSIONS_VOLUME_ROOT
} from './config.js';

// --- baca berkas master database.json secara aman ---
export function readMasterDatabaseFile() {
  if (!fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    return { users: {} };
  }

  try {
    const parsedContent = JSON.parse(fs.readFileSync(MAIN_DATABASE_FILE_PATH, 'utf-8'));
    if (!parsedContent || typeof parsedContent.users !== 'object') {
      return { users: {} };
    }
    return parsedContent;
  } catch {
    return { users: {} };
  }
}

// --- tulis master database.json secara atomic melalui file sementara ---
export function writeMasterDatabaseFileAtomic(masterDatabaseObject) {
  fs.mkdirSync(SESSIONS_VOLUME_ROOT, { recursive: true });
  const tempFilePath = `${MAIN_DATABASE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(masterDatabaseObject, null, 2), 'utf-8');
  fs.renameSync(tempFilePath, MAIN_DATABASE_FILE_PATH);
}

// --- ambil data statistik dan mapping sesi milik akun google ---
export function readBotDatabase(googleUserId) {
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
