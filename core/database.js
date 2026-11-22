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

const ALLOWED_ANNOUNCEMENT_CATEGORIES = ['INFO', 'SUCCESS', 'WARN', 'DANGER'];

// --- normalisasi kategori pengumuman ke format baku ---
function normalizeAnnouncementCategory(rawCategory) {
  const upper = String(rawCategory || 'INFO').trim().toUpperCase();
  return ALLOWED_ANNOUNCEMENT_CATEGORIES.includes(upper) ? upper : 'INFO';
}

// --- konversi item pengumuman terbaru ke format tunggal kompatibilitas lama ---
function buildLegacyAnnouncementFromList(announcementsList = []) {
  const latest = Array.isArray(announcementsList) && announcementsList.length > 0 ? announcementsList[0] : null;
  if (!latest) {
    return { text: '', level: 'info', updatedAt: Date.now() };
  }
  return {
    text: latest.text,
    level: normalizeAnnouncementCategory(latest.category).toLowerCase(),
    updatedAt: Number(latest.createdAt || Date.now())
  };
}

// --- format kunci tanggal YYYY-MM-DD zona waktu Asia/Jakarta ---
export function getJakartaDateKey(dateObj = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);
}

// --- normalisasi daftar pengumuman agar kompatibel dengan format lama dan baru ---
function normalizeAnnouncementsList(parsedContent) {
  if (Array.isArray(parsedContent?.announcements)) {
    return parsedContent.announcements
      .filter((item) => item && String(item.text || '').trim())
      .map((item) => ({
        id: String(item.id || `ann_${item.createdAt || Date.now()}`),
        title: String(item.title || 'Pengumuman / Update API').trim().slice(0, 100),
        category: normalizeAnnouncementCategory(item.category),
        text: String(item.text || '').trim().slice(0, 1200),
        createdAt: Number(item.createdAt || Date.now())
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  const legacyText = String(parsedContent?.announcement?.text || '').trim();
  if (legacyText) {
    return [{
      id: `ann_${parsedContent.announcement.updatedAt || Date.now()}`,
      title: 'Pengumuman / Update API',
      category: normalizeAnnouncementCategory(parsedContent.announcement.level),
      text: legacyText,
      createdAt: Number(parsedContent.announcement.updatedAt || Date.now())
    }];
  }

  return [];
}

// --- baca berkas master database.json secara aman ---
export function readMasterDatabaseFile() {
  const defaultMaster = {
    users: {},
    platformAdmins: [],
    announcement: { text: '', level: 'info', updatedAt: 0 },
    announcements: []
  };

  if (!fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    return defaultMaster;
  }

  try {
    const parsedContent = JSON.parse(fs.readFileSync(MAIN_DATABASE_FILE_PATH, 'utf-8'));
    if (!parsedContent || typeof parsedContent.users !== 'object') {
      return defaultMaster;
    }
    const normalizedAnnouncements = normalizeAnnouncementsList(parsedContent);
    return {
      ...defaultMaster,
      ...parsedContent,
      platformAdmins: Array.isArray(parsedContent.platformAdmins) ? parsedContent.platformAdmins : [],
      announcement: parsedContent.announcement && typeof parsedContent.announcement === 'object'
        ? parsedContent.announcement
        : defaultMaster.announcement,
      announcements: normalizedAnnouncements
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

// --- baca seluruh daftar pengumuman global terbaru ---
export function getGlobalAnnouncements() {
  return readMasterDatabaseFile().announcements || [];
}

// --- baca pengumuman terbaru tunggal untuk kompatibilitas lama ---
export function getGlobalAnnouncement() {
  const list = getGlobalAnnouncements();
  if (list.length === 0) {
    return { text: '', level: 'info', updatedAt: 0 };
  }
  return buildLegacyAnnouncementFromList(list);
}

// --- tambahkan pengumuman baru ke database.json ---
export function addGlobalAnnouncement({ title = '', category = 'INFO', text = '' } = {}) {
  const cleanText = String(text || '').trim().slice(0, 1200);
  if (!cleanText) return null;

  const masterDb = readMasterDatabaseFile();
  const normalizedCategory = normalizeAnnouncementCategory(category);
  const cleanTitle = String(title || '').trim().slice(0, 100) || 'Pengumuman / Update API';
  const nowMs = Date.now();

  const newEntry = {
    id: `ann_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
    title: cleanTitle,
    category: normalizedCategory,
    text: cleanText,
    createdAt: nowMs
  };

  masterDb.announcements = [newEntry, ...(masterDb.announcements || [])].slice(0, 50);
  masterDb.announcement = buildLegacyAnnouncementFromList(masterDb.announcements);
  writeMasterDatabaseFileAtomic(masterDb);

  return {
    item: newEntry,
    list: masterDb.announcements
  };
}

// --- hapus satu pengumuman berdasarkan id dari database.json ---
export function deleteGlobalAnnouncementById(announcementId) {
  const targetId = String(announcementId || '').trim();
  if (!targetId) return null;

  const masterDb = readMasterDatabaseFile();
  const prevLength = (masterDb.announcements || []).length;
  masterDb.announcements = (masterDb.announcements || []).filter((item) => item.id !== targetId);

  if (masterDb.announcements.length === prevLength) {
    return null;
  }

  masterDb.announcement = buildLegacyAnnouncementFromList(masterDb.announcements);
  writeMasterDatabaseFileAtomic(masterDb);
  return masterDb.announcements;
}

// --- hapus seluruh daftar pengumuman lama di database.json ---
export function clearAllGlobalAnnouncements() {
  const masterDb = readMasterDatabaseFile();
  masterDb.announcements = [];
  masterDb.announcement = buildLegacyAnnouncementFromList([]);
  writeMasterDatabaseFileAtomic(masterDb);
  return [];
}

// --- setter pengumuman kompatibilitas lama ---
export function setGlobalAnnouncement(text, level = 'info', title = 'Pengumuman / Update API') {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    clearAllGlobalAnnouncements();
    return { text: '', level: 'info', updatedAt: Date.now() };
  }
  const added = addGlobalAnnouncement({
    title,
    category: normalizeAnnouncementCategory(level),
    text: cleanText
  });
  return buildLegacyAnnouncementFromList(added ? added.list : []);
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

// --- ambil data statistik, langganan, jadwal pesan, trafik, dan pengaturan milik akun google ---
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
    scheduledMessages: [],
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
    scheduledMessages: Array.isArray(existingUserRecord.scheduledMessages)
      ? existingUserRecord.scheduledMessages
      : [],
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
