// --- manajemen database.json persisten dengan metode atomic write anti-corrupt ---
import fs from 'fs';
import path from 'path';
import {
  ADMIN_EMAILS,
  ADMIN_GOOGLE_IDS,
  CONFIG,
  DEFAULT_TRIAL_DAYS,
  MAIN_DATABASE_FILE_PATH,
  SESSIONS_ROOT_FOLDER_PATH,
  SESSIONS_VOLUME_ROOT
} from './config.js';

// --- format kunci tanggal YYYY-MM-DD zona waktu Asia/Jakarta ---
export function getJakartaDateKey(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);
}

// --- baca berkas master database.json secara aman ---
export function readMasterDatabaseFile() {
  const defaultMaster = {
    users: {},
    platformAdmins: [],
    announcement: { text: '', level: 'info', updatedAt: 0 }
  };

  if (!fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    return defaultMaster;
  }

  try {
    const parsedContent = JSON.parse(fs.readFileSync(MAIN_DATABASE_FILE_PATH, 'utf-8'));
    if (!parsedContent || typeof parsedContent.users !== 'object') {
      return defaultMaster;
    }
    return {
      ...defaultMaster,
      ...parsedContent,
      platformAdmins: Array.isArray(parsedContent.platformAdmins) ? parsedContent.platformAdmins : [],
      announcement: parsedContent.announcement && typeof parsedContent.announcement === 'object'
        ? parsedContent.announcement
        : defaultMaster.announcement
    };
  } catch {
    return defaultMaster;
  }
}

// --- tulis master database.json secara atomic melalui file sementara ---
export function writeMasterDatabaseFileAtomic(masterDatabaseObject) {
  fs.mkdirSync(SESSIONS_VOLUME_ROOT, { recursive: true });
  const tempFilePath = `${MAIN_DATABASE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(masterDatabaseObject, null, 2), 'utf-8');
  fs.renameSync(tempFilePath, MAIN_DATABASE_FILE_PATH);
}

// --- baca dan perbarui pengumuman global platform ---
export function getGlobalAnnouncement() {
  return readMasterDatabaseFile().announcement;
}

export function setGlobalAnnouncement(text, level = 'info') {
  const masterDb = readMasterDatabaseFile();
  const cleanLevel = ['info', 'warn', 'success', 'danger'].includes(level) ? level : 'info';
  masterDb.announcement = {
    text: String(text || '').trim().slice(0, 300),
    level: cleanLevel,
    updatedAt: Date.now()
  };
  writeMasterDatabaseFileAtomic(masterDb);
  return masterDb.announcement;
}

// --- cek apakah akun google memiliki hak akses admin platform ---
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

// --- cek hak admin berdasarkan googleUserId saja untuk proses latar belakang ---
export function isPlatformAdminById(googleUserId) {
  if (!googleUserId) return false;
  const normalizedId = String(googleUserId).toLowerCase();
  if (ADMIN_GOOGLE_IDS.includes(normalizedId)) return true;
  const masterDb = readMasterDatabaseFile();
  return masterDb.platformAdmins.some((id) => String(id).toLowerCase() === normalizedId);
}

// --- ambil data statistik, langganan, trafik, dan pengaturan milik akun google ---
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
    toxic: [],
    owners: [],
    disabledCategories: [],
    autoReplies: []
  };

  const defaultSubscription = {
    plan: 'Starter Trial',
    expiresAt: Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000,
    isReseller: false,
    maxSlots: 1
  };

  const defaultUserRecord = {
    googleUserId,
    phoneNumber: null,
    sessionName: null,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    uniqueUsers: [],
    trafficHistory: {},
    startTime: Date.now(),
    subscription: defaultSubscription,
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
  mergedSettings.owners = Array.isArray(mergedSettings.owners) ? mergedSettings.owners : [];
  mergedSettings.disabledCategories = Array.isArray(mergedSettings.disabledCategories)
    ? mergedSettings.disabledCategories
    : [];
  mergedSettings.autoReplies = Array.isArray(mergedSettings.autoReplies)
    ? mergedSettings.autoReplies
    : [];

  const mergedSubscription = {
    ...defaultSubscription,
    ...(existingUserRecord.subscription || {})
  };

  return {
    ...defaultUserRecord,
    ...existingUserRecord,
    uniqueUsers: Array.isArray(existingUserRecord.uniqueUsers) ? existingUserRecord.uniqueUsers : [],
    trafficHistory: existingUserRecord.trafficHistory && typeof existingUserRecord.trafficHistory === 'object'
      ? existingUserRecord.trafficHistory
      : {},
    subscription: mergedSubscription,
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

// --- catat trafik pesan harian (masuk atau keluar) dan simpan 7 hari terakhir ---
export function incrementDailyTrafficRecord(userDatabase, direction = 'in') {
  const todayKey = getJakartaDateKey(new Date());
  const history = userDatabase.trafficHistory && typeof userDatabase.trafficHistory === 'object'
    ? { ...userDatabase.trafficHistory }
    : {};

  if (!history[todayKey]) {
    history[todayKey] = { in: 0, out: 0 };
  }

  if (direction === 'out') {
    history[todayKey].out += 1;
  } else {
    history[todayKey].in += 1;
  }

  const sortedKeys = Object.keys(history).sort();
  while (sortedKeys.length > 14) {
    const oldestKey = sortedKeys.shift();
    delete history[oldestKey];
  }

  userDatabase.trafficHistory = history;
  return userDatabase;
}

// --- bangun deret data grafik trafik 7 hari terakhir ---
export function buildLast7DaysTrafficSeries(trafficHistory = {}) {
  const result = [];
  const now = new Date();

  for (let offset = 6; offset >= 0; offset -= 1) {
    const targetDate = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const dateKey = getJakartaDateKey(targetDate);
    const dayLabel = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short'
    }).format(targetDate);

    const record = trafficHistory?.[dateKey] || { in: 0, out: 0 };
    result.push({
      date: dateKey,
      label: dayLabel,
      in: Number(record.in || 0),
      out: Number(record.out || 0)
    });
  }

  return result;
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
