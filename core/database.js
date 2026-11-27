// --- manajemen database.json persisten dengan metode atomic write anti-corrupt ---
import crypto from 'crypto';
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
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const MAX_PUBLIC_CHAT_HISTORY = 120;
const MAX_STICKERS_PER_USER = 60;
const MAX_PINNED_MESSAGES = 10;

// --- format ukuran byte ke satuan mudah dibaca ---
export function formatBytesReadable(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

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

// --- buat hash kata sandi/otp aman menggunakan scrypt dan random salt ---
function createScryptHashRecord(plainSecret) {
  const saltHex = crypto.randomBytes(16).toString('hex');
  const hashHex = crypto.scryptSync(String(plainSecret), saltHex, 64).toString('hex');
  return { saltHex, hashHex };
}

// --- verifikasi kata sandi/otp terhadap hash tersimpan dengan timing-safe comparison ---
function verifyScryptHashRecord(plainSecret, storedSaltHex, storedHashHex) {
  if (!storedSaltHex || !storedHashHex) return false;
  const computedBuffer = crypto.scryptSync(String(plainSecret), storedSaltHex, 64);
  const storedBuffer = Buffer.from(storedHashHex, 'hex');
  if (computedBuffer.length !== storedBuffer.length) return false;
  return crypto.timingSafeEqual(computedBuffer, storedBuffer);
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
    authAccounts: {},
    platformAdmins: [],
    vouchers: {},
    passwordOtps: {},
    publicChatMessages: [],
    pinnedMessages: [],
    userProfiles: {},
    communityWelcomedIds: [],
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
      authAccounts: parsedContent.authAccounts && typeof parsedContent.authAccounts === 'object'
        ? parsedContent.authAccounts
        : {},
      platformAdmins: Array.isArray(parsedContent.platformAdmins) ? parsedContent.platformAdmins : [],
      vouchers: parsedContent.vouchers && typeof parsedContent.vouchers === 'object'
        ? parsedContent.vouchers
        : {},
      passwordOtps: parsedContent.passwordOtps && typeof parsedContent.passwordOtps === 'object'
        ? parsedContent.passwordOtps
        : {},
      publicChatMessages: Array.isArray(parsedContent.publicChatMessages)
        ? parsedContent.publicChatMessages.slice(-MAX_PUBLIC_CHAT_HISTORY)
        : [],
      pinnedMessages: Array.isArray(parsedContent.pinnedMessages)
        ? parsedContent.pinnedMessages.slice(0, MAX_PINNED_MESSAGES)
        : [],
      userProfiles: parsedContent.userProfiles && typeof parsedContent.userProfiles === 'object'
        ? parsedContent.userProfiles
        : {},
      communityWelcomedIds: Array.isArray(parsedContent.communityWelcomedIds)
        ? parsedContent.communityWelcomedIds
        : [],
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

// --- manajemen ruang public live chat & komunitas xu core ---
export function getPublicChatMessages() {
  const masterDb = readMasterDatabaseFile();
  return Array.isArray(masterDb.publicChatMessages)
    ? masterDb.publicChatMessages.slice(-MAX_PUBLIC_CHAT_HISTORY)
    : [];
}

export function appendPublicChatMessage({
  userId = '',
  name = 'User',
  avatarUrl = '',
  isAdmin = false,
  text = ''
} = {}) {
  const cleanText = String(text || '').trim().slice(0, 600);
  if (!cleanText || !userId) return null;

  const masterDb = readMasterDatabaseFile();
  const list = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];

  const chatEntry = {
    id: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: String(userId).trim(),
    name: String(name || 'User').trim().slice(0, 48),
    handle: '',
    avatarUrl: String(avatarUrl || '').trim().slice(0, 400),
    role: isAdmin ? 'DEVELOPER' : 'MEMBER',
    isAdmin: Boolean(isAdmin),
    type: 'text',
    text: cleanText,
    mediaUrl: '',
    replyTo: null,
    reactions: [],
    timestamp: Date.now()
  };

  masterDb.publicChatMessages = [...list, chatEntry].slice(-MAX_PUBLIC_CHAT_HISTORY);
  writeMasterDatabaseFileAtomic(masterDb);
  return { item: chatEntry, list: masterDb.publicChatMessages };
}

export function deletePublicChatMessage(messageId) {
  const targetId = String(messageId || '').trim();
  if (!targetId) return null;

  const masterDb = readMasterDatabaseFile();
  const list = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];
  const nextList = list.filter((item) => item.id !== targetId);
  if (nextList.length === list.length) return null;

  masterDb.publicChatMessages = nextList;
  writeMasterDatabaseFileAtomic(masterDb);
  return nextList;
}

export function clearPublicChatMessages() {
  const masterDb = readMasterDatabaseFile();
  masterDb.publicChatMessages = [];
  writeMasterDatabaseFileAtomic(masterDb);
  return [];
}

// --- sinkronisasi & manajemen profil akun user untuk settings profile dan komunitas ---
export function getOrSyncUserProfile(sessionUser, isAdmin = false) {
  const userId = String(sessionUser?.googleId || '').trim();
  if (!userId) return null;

  const masterDb = readMasterDatabaseFile();
  masterDb.userProfiles = masterDb.userProfiles && typeof masterDb.userProfiles === 'object'
    ? masterDb.userProfiles
    : {};

  const existingProfile = masterDb.userProfiles[userId];
  const resolvedRole = isAdmin ? 'DEVELOPER' : 'MEMBER';
  const sessionEmail = String(sessionUser?.email || '').trim().toLowerCase();
  const sessionFullName = String(sessionUser?.fullName || sessionUser?.givenName || 'Member').trim().slice(0, 60);
  const defaultDisplayName = String(sessionUser?.givenName || sessionFullName || 'Member').trim().slice(0, 20);
  const sessionAvatar = String(sessionUser?.pictureUrl || '').trim().slice(0, 400);

  if (!existingProfile) {
    const newProfile = {
      userId,
      email: sessionEmail,
      fullName: sessionFullName,
      displayName: defaultDisplayName,
      handle: '',
      avatarUrl: sessionAvatar,
      role: resolvedRole,
      isAdmin: Boolean(isAdmin),
      stickers: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    masterDb.userProfiles[userId] = newProfile;
    writeMasterDatabaseFileAtomic(masterDb);
    return newProfile;
  }

  let hasProfileChanges = false;
  const nextProfile = {
    ...existingProfile,
    userId,
    stickers: Array.isArray(existingProfile.stickers) ? existingProfile.stickers : []
  };

  if (nextProfile.isAdmin !== Boolean(isAdmin) || nextProfile.role !== resolvedRole) {
    nextProfile.isAdmin = Boolean(isAdmin);
    nextProfile.role = resolvedRole;
    hasProfileChanges = true;
  }
  if (!nextProfile.email && sessionEmail) {
    nextProfile.email = sessionEmail;
    hasProfileChanges = true;
  }
  if (!nextProfile.fullName && sessionFullName) {
    nextProfile.fullName = sessionFullName;
    hasProfileChanges = true;
  }
  if (!nextProfile.displayName) {
    nextProfile.displayName = defaultDisplayName;
    hasProfileChanges = true;
  }
  if (!nextProfile.avatarUrl && sessionAvatar) {
    nextProfile.avatarUrl = sessionAvatar;
    hasProfileChanges = true;
  }

  if (hasProfileChanges) {
    nextProfile.updatedAt = Date.now();
    masterDb.userProfiles[userId] = nextProfile;
    writeMasterDatabaseFileAtomic(masterDb);
  }

  return nextProfile;
}

// --- perbarui nama akun (maks 20 karakter), handle discord/sosmed, dan url avatar secara atomic ---
export function updateUserProfileAtomic(userId, { displayName, handle, avatarUrl } = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) {
    throw new Error('User ID tidak valid.');
  }

  const masterDb = readMasterDatabaseFile();
  masterDb.userProfiles = masterDb.userProfiles && typeof masterDb.userProfiles === 'object'
    ? masterDb.userProfiles
    : {};

  const existingProfile = masterDb.userProfiles[cleanUserId] || {
    userId: cleanUserId,
    email: '',
    fullName: 'Member',
    displayName: 'Member',
    handle: '',
    avatarUrl: '',
    role: isPlatformAdminById(cleanUserId) ? 'DEVELOPER' : 'MEMBER',
    isAdmin: isPlatformAdminById(cleanUserId),
    stickers: [],
    createdAt: Date.now()
  };

  const nextProfile = {
    ...existingProfile,
    stickers: Array.isArray(existingProfile.stickers) ? existingProfile.stickers : []
  };

  if (typeof displayName === 'string' && displayName.trim()) {
    const cleanDisplayName = displayName.trim();
    if (cleanDisplayName.length > 20) {
      throw new Error('Nama akun maksimal 20 karakter.');
    }
    nextProfile.displayName = cleanDisplayName;
    nextProfile.fullName = cleanDisplayName;
  }

  if (typeof handle === 'string') {
    const sanitizedHandle = handle.trim().replace(/\s+/g, '').slice(0, 32);
    nextProfile.handle = sanitizedHandle;
  }

  if (typeof avatarUrl === 'string' && avatarUrl.trim()) {
    nextProfile.avatarUrl = avatarUrl.trim().slice(0, 450);
  }

  nextProfile.updatedAt = Date.now();
  masterDb.userProfiles[cleanUserId] = nextProfile;

  // --- sinkronkan juga nama terbaru ke akun lokal jika terdaftar di authAccounts ---
  if (nextProfile.email && masterDb.authAccounts?.[nextProfile.email]) {
    masterDb.authAccounts[nextProfile.email] = {
      ...masterDb.authAccounts[nextProfile.email],
      fullName: nextProfile.displayName,
      givenName: nextProfile.displayName
    };
  }

  writeMasterDatabaseFileAtomic(masterDb);
  return nextProfile;
}

// --- hapus seluruh data akun user secara permanen dari database.json ---
export function deleteUserAccountPermanently(userId) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return false;

  const masterDb = readMasterDatabaseFile();

  if (masterDb.users && masterDb.users[cleanUserId]) {
    delete masterDb.users[cleanUserId];
  }
  if (masterDb.userProfiles && masterDb.userProfiles[cleanUserId]) {
    delete masterDb.userProfiles[cleanUserId];
  }

  if (masterDb.authAccounts && typeof masterDb.authAccounts === 'object') {
    for (const [emailKey, accountObj] of Object.entries(masterDb.authAccounts)) {
      if (accountObj?.userId === cleanUserId) {
        delete masterDb.authAccounts[emailKey];
      }
    }
  }

  if (masterDb.passwordOtps && typeof masterDb.passwordOtps === 'object') {
    for (const [emailKey, otpObj] of Object.entries(masterDb.passwordOtps)) {
      if (otpObj?.userId === cleanUserId) {
        delete masterDb.passwordOtps[emailKey];
      }
    }
  }

  if (Array.isArray(masterDb.platformAdmins)) {
    masterDb.platformAdmins = masterDb.platformAdmins.filter((id) => id !== cleanUserId);
  }
  if (Array.isArray(masterDb.communityWelcomedIds)) {
    masterDb.communityWelcomedIds = masterDb.communityWelcomedIds.filter((id) => id !== cleanUserId);
  }

  if (Array.isArray(masterDb.publicChatMessages)) {
    masterDb.publicChatMessages = masterDb.publicChatMessages.map((msg) => {
      if (!Array.isArray(msg?.reactions)) return msg;
      return {
        ...msg,
        reactions: msg.reactions.filter((reaction) => reaction.userId !== cleanUserId)
      };
    });
  }

  writeMasterDatabaseFileAtomic(masterDb);
  return true;
}

// --- manajemen koleksi url stiker hibrida per user (hanya simpan string url supabase) ---
export function getUserStickerUrls(userId) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return [];
  const masterDb = readMasterDatabaseFile();
  const stickers = masterDb.userProfiles?.[cleanUserId]?.stickers;
  return Array.isArray(stickers) ? stickers : [];
}

export function appendUserStickerUrls(userId, newStickersList = []) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return [];

  const masterDb = readMasterDatabaseFile();
  masterDb.userProfiles = masterDb.userProfiles && typeof masterDb.userProfiles === 'object'
    ? masterDb.userProfiles
    : {};

  const existingProfile = masterDb.userProfiles[cleanUserId] || {
    userId: cleanUserId,
    displayName: 'Member',
    fullName: 'Member',
    role: isPlatformAdminById(cleanUserId) ? 'DEVELOPER' : 'MEMBER',
    isAdmin: isPlatformAdminById(cleanUserId),
    stickers: []
  };

  const currentStickers = Array.isArray(existingProfile.stickers) ? existingProfile.stickers : [];
  const existingUrlsSet = new Set(currentStickers.map((entry) => entry.url));

  const validIncoming = (Array.isArray(newStickersList) ? newStickersList : [])
    .filter((item) => item && typeof item.url === 'string' && item.url.trim() && !existingUrlsSet.has(item.url.trim()))
    .map((item) => ({
      id: String(item.id || `stk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
      url: item.url.trim().slice(0, 500),
      createdAt: Number(item.createdAt || Date.now())
    }));

  const mergedStickers = [...validIncoming, ...currentStickers].slice(0, MAX_STICKERS_PER_USER);
  masterDb.userProfiles[cleanUserId] = {
    ...existingProfile,
    stickers: mergedStickers,
    updatedAt: Date.now()
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return mergedStickers;
}

export function removeUserStickerUrl(userId, stickerId) {
  const cleanUserId = String(userId || '').trim();
  const targetStickerId = String(stickerId || '').trim();
  if (!cleanUserId) return [];

  const masterDb = readMasterDatabaseFile();
  const existingProfile = masterDb.userProfiles?.[cleanUserId];
  if (!existingProfile || !Array.isArray(existingProfile.stickers)) return [];

  const nextStickers = existingProfile.stickers.filter((item) => item.id !== targetStickerId);
  masterDb.userProfiles[cleanUserId] = {
    ...existingProfile,
    stickers: nextStickers,
    updatedAt: Date.now()
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return nextStickers;
}

// --- hapus stiker dari koleksi favorit user berdasarkan url ---
export function removeUserStickerByUrl(userId, stickerUrl) {
  const cleanUserId = String(userId || '').trim();
  const cleanUrl = String(stickerUrl || '').trim();
  if (!cleanUserId || !cleanUrl) return [];

  const masterDb = readMasterDatabaseFile();
  const existingProfile = masterDb.userProfiles?.[cleanUserId];
  if (!existingProfile || !Array.isArray(existingProfile.stickers)) return [];

  const nextStickers = existingProfile.stickers.filter((item) => item?.url !== cleanUrl);
  masterDb.userProfiles[cleanUserId] = {
    ...existingProfile,
    stickers: nextStickers,
    updatedAt: Date.now()
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return nextStickers;
}

// --- susun daftar anggota komunitas lengkap dengan status online dan peran ---
export function getCommunityMembersList(onlineUserIdsSet = new Set()) {
  const masterDb = readMasterDatabaseFile();
  const profilesMap = masterDb.userProfiles && typeof masterDb.userProfiles === 'object'
    ? masterDb.userProfiles
    : {};

  const members = Object.values(profilesMap)
    .filter((profile) => profile && profile.userId)
    .map((profile) => ({
      userId: profile.userId,
      displayName: profile.displayName || profile.fullName || 'Member',
      handle: profile.handle || '',
      avatarUrl: profile.avatarUrl || '',
      role: profile.isAdmin || String(profile.role || '').toUpperCase() === 'DEVELOPER' ? 'DEVELOPER' : 'MEMBER',
      isAdmin: Boolean(profile.isAdmin || String(profile.role || '').toUpperCase() === 'DEVELOPER'),
      isOnline: onlineUserIdsSet instanceof Set ? onlineUserIdsSet.has(profile.userId) : false
    }));

  members.sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return String(a.displayName).localeCompare(String(b.displayName));
  });

  return members;
}

// --- buat kartu ucapan selamat datang otomatis saat anggota pertama kali mengunjungi komunitas ---
export function createAutoWelcomeIfFirstVisit(userProfile) {
  const userId = String(userProfile?.userId || '').trim();
  if (!userId) return null;

  const masterDb = readMasterDatabaseFile();
  const welcomedList = Array.isArray(masterDb.communityWelcomedIds) ? masterDb.communityWelcomedIds : [];
  if (welcomedList.includes(userId)) {
    return null;
  }

  const totalMembers = Math.max(1, Object.keys(masterDb.userProfiles || {}).length);
  const targetName = String(userProfile.displayName || userProfile.fullName || 'Anggota Baru').trim().slice(0, 48);
  const nowMs = Date.now();

  const welcomeEntry = {
    id: `wlc_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
    userId: 'system_xucore_bot',
    name: 'Xu Core Bot',
    handle: '@xucore',
    avatarUrl: '',
    role: 'BOT',
    isAdmin: true,
    type: 'welcome',
    isWelcome: true,
    welcomeTargetUserId: userId,
    welcomeTargetName: targetName,
    welcomeTargetAvatar: String(userProfile.avatarUrl || '').trim().slice(0, 450),
    text: `Halo ${targetName}, selamat bergabung di Xu Core Community! Sekarang kita ${totalMembers} anggota.`,
    mediaUrl: '',
    replyTo: null,
    reactions: [],
    timestamp: nowMs
  };

  masterDb.communityWelcomedIds = [...welcomedList, userId];
  const currentMessages = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];
  masterDb.publicChatMessages = [...currentMessages, welcomeEntry].slice(-MAX_PUBLIC_CHAT_HISTORY);
  writeMasterDatabaseFileAtomic(masterDb);

  return welcomeEntry;
}

// --- tambahkan pesan teks, foto, video, atau stiker ke ruang xu core community ---
export function appendCommunityChatMessage({
  userId = '',
  name = 'Member',
  handle = '',
  avatarUrl = '',
  role = 'MEMBER',
  isAdmin = false,
  type = 'text',
  text = '',
  mediaUrl = '',
  replyTo = null
} = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return null;

  const allowedTypes = ['text', 'image', 'video', 'sticker'];
  const normalizedType = allowedTypes.includes(String(type || 'text').toLowerCase())
    ? String(type).toLowerCase()
    : 'text';

  const cleanText = String(text || '').trim().slice(0, 600);
  const cleanMediaUrl = String(mediaUrl || '').trim().slice(0, 500);

  if (normalizedType === 'text' && !cleanText) return null;
  if (normalizedType !== 'text' && !cleanMediaUrl) return null;

  const cleanReplyTo = replyTo && typeof replyTo === 'object' && String(replyTo.id || '').trim()
    ? {
        id: String(replyTo.id).trim().slice(0, 80),
        userId: String(replyTo.userId || '').trim().slice(0, 80),
        name: String(replyTo.name || 'Member').trim().slice(0, 48),
        text: String(replyTo.text || '[Pesan]').trim().slice(0, 140) || '[Pesan]'
      }
    : null;

  const masterDb = readMasterDatabaseFile();
  const currentList = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];

  const chatEntry = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: cleanUserId,
    name: String(name || 'Member').trim().slice(0, 48),
    handle: String(handle || '').trim().slice(0, 32),
    avatarUrl: String(avatarUrl || '').trim().slice(0, 450),
    role: isAdmin || String(role || '').toUpperCase() === 'DEVELOPER' ? 'DEVELOPER' : 'MEMBER',
    isAdmin: Boolean(isAdmin),
    type: normalizedType,
    text: cleanText,
    mediaUrl: cleanMediaUrl,
    replyTo: cleanReplyTo,
    reactions: [],
    timestamp: Date.now()
  };

  masterDb.publicChatMessages = [...currentList, chatEntry].slice(-MAX_PUBLIC_CHAT_HISTORY);
  writeMasterDatabaseFileAtomic(masterDb);
  return { item: chatEntry, list: masterDb.publicChatMessages };
}

// --- toggle emoji reaction pada pesan komunitas (klik emoji sama untuk menghapus) ---
export function toggleCommunityMessageReaction(messageId, emojiChar, actorProfile) {
  const targetMessageId = String(messageId || '').trim();
  const cleanEmoji = String(emojiChar || '').trim().slice(0, 16);
  const actorUserId = String(actorProfile?.userId || '').trim();

  if (!targetMessageId || !cleanEmoji || !actorUserId) return null;

  const masterDb = readMasterDatabaseFile();
  const messagesList = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];
  const targetIndex = messagesList.findIndex((msg) => msg?.id === targetMessageId);
  if (targetIndex === -1) return null;

  const targetMsg = messagesList[targetIndex];
  const existingReactions = Array.isArray(targetMsg.reactions) ? [...targetMsg.reactions] : [];
  const existingUserIndex = existingReactions.findIndex((r) => r.userId === actorUserId);

  if (existingUserIndex !== -1 && existingReactions[existingUserIndex].emoji === cleanEmoji) {
    existingReactions.splice(existingUserIndex, 1);
  } else {
    const newReaction = {
      userId: actorUserId,
      name: String(actorProfile.displayName || actorProfile.fullName || 'Member').trim().slice(0, 48),
      avatarUrl: String(actorProfile.avatarUrl || '').trim().slice(0, 450),
      emoji: cleanEmoji,
      reactedAt: Date.now()
    };

    if (existingUserIndex !== -1) {
      existingReactions[existingUserIndex] = newReaction;
    } else {
      existingReactions.push(newReaction);
    }
  }

  const updatedMsg = {
    ...targetMsg,
    reactions: existingReactions
  };
  messagesList[targetIndex] = updatedMsg;
  masterDb.publicChatMessages = messagesList;
  writeMasterDatabaseFileAtomic(masterDb);

  return updatedMsg;
}

// --- hapus pesan live chat berbasis peran (member: milik sendiri, admin: full override) ---
export function deleteCommunityMessageAuthorized(messageId, actorUserId, isAdmin = false) {
  const targetId = String(messageId || '').trim();
  const cleanActorId = String(actorUserId || '').trim();
  if (!targetId || !cleanActorId) {
    return { isSuccess: false, errorMessage: 'ID pesan tidak valid.' };
  }

  const masterDb = readMasterDatabaseFile();
  const messagesList = Array.isArray(masterDb.publicChatMessages) ? masterDb.publicChatMessages : [];
  const targetMsg = messagesList.find((msg) => msg?.id === targetId);

  if (!targetMsg) {
    return { isSuccess: false, errorMessage: 'Pesan tidak ditemukan atau sudah dihapus.' };
  }

  const isOwnerOfMessage = targetMsg.userId === cleanActorId;
  if (!isAdmin && !isOwnerOfMessage) {
    return { isSuccess: false, errorMessage: 'Akses ditolak: Anda hanya dapat menghapus pesan Anda sendiri.' };
  }

  masterDb.publicChatMessages = messagesList.filter((msg) => msg?.id !== targetId);
  masterDb.pinnedMessages = (Array.isArray(masterDb.pinnedMessages) ? masterDb.pinnedMessages : []).filter(
    (pin) => pin?.messageId !== targetId
  );

  writeMasterDatabaseFileAtomic(masterDb);
  return {
    isSuccess: true,
    deletedId: targetId,
    pinnedMessages: masterDb.pinnedMessages
  };
}

// --- manajemen daftar pesan disematkan komunitas (modifikasi khusus admin) ---
export function getPinnedCommunityMessages() {
  const masterDb = readMasterDatabaseFile();
  return Array.isArray(masterDb.pinnedMessages)
    ? masterDb.pinnedMessages.slice(0, MAX_PINNED_MESSAGES)
    : [];
}

export function addPinnedCommunityMessage({ messageId = '', text = '', pinnedBy = 'Admin' } = {}) {
  const cleanText = String(text || '').trim().slice(0, 400);
  if (!cleanText) {
    throw new Error('Isi pesan yang disematkan tidak boleh kosong.');
  }

  const cleanMessageId = String(messageId || '').trim().slice(0, 80);
  const masterDb = readMasterDatabaseFile();
  const currentPins = Array.isArray(masterDb.pinnedMessages) ? masterDb.pinnedMessages : [];

  const filteredPins = cleanMessageId
    ? currentPins.filter((pin) => pin?.messageId !== cleanMessageId)
    : currentPins;

  const newPinItem = {
    id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    messageId: cleanMessageId,
    text: cleanText,
    pinnedBy: String(pinnedBy || 'Admin').trim().slice(0, 48),
    pinnedAt: Date.now()
  };

  masterDb.pinnedMessages = [newPinItem, ...filteredPins].slice(0, MAX_PINNED_MESSAGES);
  writeMasterDatabaseFileAtomic(masterDb);
  return masterDb.pinnedMessages;
}

export function removePinnedCommunityMessage(pinId) {
  const targetPinId = String(pinId || '').trim();
  const masterDb = readMasterDatabaseFile();
  const currentPins = Array.isArray(masterDb.pinnedMessages) ? masterDb.pinnedMessages : [];
  const nextPins = currentPins.filter((pin) => pin?.id !== targetPinId);

  masterDb.pinnedMessages = nextPins;
  writeMasterDatabaseFileAtomic(masterDb);
  return nextPins;
}

// --- cari akun login lokal berdasarkan alamat email ---
export function findAuthAccountByEmail(rawEmail) {
  const normalizedEmail = String(rawEmail || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const masterDb = readMasterDatabaseFile();
  return masterDb.authAccounts?.[normalizedEmail] || null;
}

// --- cari akun login lokal berdasarkan userId ---
export function findAuthAccountByUserId(userId) {
  const cleanId = String(userId || '').trim();
  if (!cleanId) return null;
  const masterDb = readMasterDatabaseFile();
  for (const account of Object.values(masterDb.authAccounts || {})) {
    if (account && account.userId === cleanId) {
      return account;
    }
  }
  return null;
}

// --- simpan akun login lokal baru ke database.json secara atomic ---
export function saveAuthAccountAtomic(accountRecord) {
  const normalizedEmail = String(accountRecord?.email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const masterDb = readMasterDatabaseFile();
  masterDb.authAccounts = masterDb.authAccounts && typeof masterDb.authAccounts === 'object'
    ? masterDb.authAccounts
    : {};

  masterDb.authAccounts[normalizedEmail] = {
    ...accountRecord,
    email: normalizedEmail
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return masterDb.authAccounts[normalizedEmail];
}

// --- ubah kata sandi akun lokal untuk user yang sedang login ---
export function changeLocalAccountPassword({ userId = '', email = '', currentPassword = '', newPassword = '' } = {}) {
  const cleanCurrent = String(currentPassword || '');
  const cleanNew = String(newPassword || '');

  if (!cleanCurrent || cleanNew.length < 6) {
    throw new Error('Kata sandi lama wajib diisi dan kata sandi baru minimal 6 karakter.');
  }

  const masterDb = readMasterDatabaseFile();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  let targetAccount = normalizedEmail ? masterDb.authAccounts?.[normalizedEmail] : null;

  if (!targetAccount && userId) {
    targetAccount = Object.values(masterDb.authAccounts || {}).find((acc) => acc?.userId === userId) || null;
  }

  if (!targetAccount) {
    throw new Error('Akun ini login melalui Google OAuth dan tidak memiliki kata sandi lokal.');
  }

  const isMatched = verifyScryptHashRecord(cleanCurrent, targetAccount.passwordSalt, targetAccount.passwordHash);
  if (!isMatched) {
    throw new Error('Kata sandi lama tidak sesuai.');
  }

  const { saltHex, hashHex } = createScryptHashRecord(cleanNew);
  masterDb.authAccounts[targetAccount.email] = {
    ...targetAccount,
    passwordSalt: saltHex,
    passwordHash: hashHex,
    passwordUpdatedAt: Date.now()
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return { email: targetAccount.email, userId: targetAccount.userId };
}

// --- buat dan simpan kode otp reset password ke database.json ---
export function createPasswordResetOtp({ email = '', userId = '', targetPhone = '' } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = String(targetPhone || '').replace(/\D/g, '');

  if (!normalizedEmail || !userId) {
    throw new Error('Data akun untuk pembuatan OTP tidak lengkap.');
  }
  if (cleanPhone.length < 8) {
    throw new Error('Nomor WhatsApp owner terdaftar tidak ditemukan untuk akun ini.');
  }

  const otpCode = String(crypto.randomInt(100000, 1000000));
  const { saltHex, hashHex } = createScryptHashRecord(otpCode);
  const nowMs = Date.now();
  const expiresAt = nowMs + OTP_TTL_MS;

  const masterDb = readMasterDatabaseFile();
  masterDb.passwordOtps = masterDb.passwordOtps && typeof masterDb.passwordOtps === 'object'
    ? masterDb.passwordOtps
    : {};

  // --- bersihkan otp kadaluarsa agar database.json tetap ramping ---
  for (const [key, entry] of Object.entries(masterDb.passwordOtps)) {
    if (!entry || Number(entry.expiresAt || 0) <= nowMs) {
      delete masterDb.passwordOtps[key];
    }
  }

  masterDb.passwordOtps[normalizedEmail] = {
    email: normalizedEmail,
    userId,
    targetPhone: cleanPhone,
    otpSalt: saltHex,
    otpHash: hashHex,
    attempts: 0,
    createdAt: nowMs,
    expiresAt
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return { otpCode, targetPhone: cleanPhone, expiresAt };
}

// --- verifikasi kode otp dan perbarui kata sandi akun lokal secara atomic ---
export function verifyAndResetPasswordWithOtp({ email = '', otpCode = '', newPassword = '' } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const cleanOtp = String(otpCode || '').trim();
  const cleanNewPassword = String(newPassword || '');

  if (!normalizedEmail || !/^\d{6}$/.test(cleanOtp)) {
    throw new Error('Email dan kode OTP 6 digit wajib diisi dengan benar.');
  }
  if (cleanNewPassword.length < 6) {
    throw new Error('Kata sandi baru minimal terdiri dari 6 karakter.');
  }

  const masterDb = readMasterDatabaseFile();
  const otpRecord = masterDb.passwordOtps?.[normalizedEmail];
  const accountRecord = masterDb.authAccounts?.[normalizedEmail];

  if (!accountRecord) {
    throw new Error('Akun email lokal tidak ditemukan.');
  }
  if (!otpRecord) {
    throw new Error('Kode OTP tidak ditemukan atau sudah digunakan. Silakan minta kode baru.');
  }
  if (Date.now() > Number(otpRecord.expiresAt || 0)) {
    delete masterDb.passwordOtps[normalizedEmail];
    writeMasterDatabaseFileAtomic(masterDb);
    throw new Error('Kode OTP telah kedaluwarsa. Silakan minta kode OTP baru.');
  }
  if (Number(otpRecord.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    delete masterDb.passwordOtps[normalizedEmail];
    writeMasterDatabaseFileAtomic(masterDb);
    throw new Error('Terlalu banyak percobaan gagal. Silakan minta kode OTP baru.');
  }

  const isOtpValid = verifyScryptHashRecord(cleanOtp, otpRecord.otpSalt, otpRecord.otpHash);
  if (!isOtpValid) {
    masterDb.passwordOtps[normalizedEmail] = {
      ...otpRecord,
      attempts: Number(otpRecord.attempts || 0) + 1
    };
    writeMasterDatabaseFileAtomic(masterDb);
    throw new Error('Kode OTP tidak cocok.');
  }

  const { saltHex, hashHex } = createScryptHashRecord(cleanNewPassword);
  masterDb.authAccounts[normalizedEmail] = {
    ...accountRecord,
    passwordSalt: saltHex,
    passwordHash: hashHex,
    passwordUpdatedAt: Date.now()
  };
  delete masterDb.passwordOtps[normalizedEmail];

  writeMasterDatabaseFileAtomic(masterDb);
  return { email: normalizedEmail, userId: accountRecord.userId };
}

// --- crud sistem voucher & redeem trial di dalam database.json ---
export function listVouchers() {
  const masterDb = readMasterDatabaseFile();
  return Object.values(masterDb.vouchers || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function createVoucher({
  code = '',
  durationDays = 7,
  planName = '',
  maxUses = 10,
  expiresAt = 0
} = {}) {
  const normalizedCode = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);

  if (!normalizedCode || normalizedCode.length < 3) {
    throw new Error('Kode voucher minimal 3 karakter (huruf, angka, - atau _).');
  }

  const parsedDays = Math.max(1, Math.min(365, parseInt(durationDays, 10) || 7));
  const parsedMaxUses = Math.max(1, Math.min(100000, parseInt(maxUses, 10) || 1));
  const parsedExpiresAt = Number(expiresAt || 0);

  const masterDb = readMasterDatabaseFile();
  masterDb.vouchers = masterDb.vouchers && typeof masterDb.vouchers === 'object' ? masterDb.vouchers : {};

  if (masterDb.vouchers[normalizedCode]) {
    throw new Error(`Kode voucher [${normalizedCode}] sudah ada.`);
  }

  const newVoucher = {
    code: normalizedCode,
    durationDays: parsedDays,
    planName: String(planName || '').trim().slice(0, 50) || `Voucher ${parsedDays} Hari`,
    maxUses: parsedMaxUses,
    usedCount: 0,
    usedBy: [],
    isActive: true,
    expiresAt: parsedExpiresAt > 0 ? parsedExpiresAt : 0,
    createdAt: Date.now()
  };

  masterDb.vouchers[normalizedCode] = newVoucher;
  writeMasterDatabaseFileAtomic(masterDb);
  return newVoucher;
}

export function updateVoucher(rawCode, updates = {}) {
  const normalizedCode = String(rawCode || '').trim().toUpperCase();
  const masterDb = readMasterDatabaseFile();
  const existing = masterDb.vouchers?.[normalizedCode];

  if (!existing) {
    throw new Error(`Voucher [${normalizedCode}] tidak ditemukan.`);
  }

  const nextVoucher = { ...existing };
  if (typeof updates.isActive === 'boolean') nextVoucher.isActive = updates.isActive;
  if (updates.durationDays !== undefined) {
    nextVoucher.durationDays = Math.max(1, Math.min(365, parseInt(updates.durationDays, 10) || existing.durationDays));
  }
  if (updates.maxUses !== undefined) {
    nextVoucher.maxUses = Math.max(1, Math.min(100000, parseInt(updates.maxUses, 10) || existing.maxUses));
  }
  if (typeof updates.planName === 'string' && updates.planName.trim()) {
    nextVoucher.planName = updates.planName.trim().slice(0, 50);
  }
  if (updates.expiresAt !== undefined) {
    nextVoucher.expiresAt = Math.max(0, Number(updates.expiresAt) || 0);
  }

  masterDb.vouchers[normalizedCode] = nextVoucher;
  writeMasterDatabaseFileAtomic(masterDb);
  return nextVoucher;
}

export function deleteVoucher(rawCode) {
  const normalizedCode = String(rawCode || '').trim().toUpperCase();
  const masterDb = readMasterDatabaseFile();
  if (!masterDb.vouchers?.[normalizedCode]) {
    return false;
  }
  delete masterDb.vouchers[normalizedCode];
  writeMasterDatabaseFileAtomic(masterDb);
  return true;
}

export function redeemVoucherForUser(googleUserId, rawCode) {
  const cleanUserId = String(googleUserId || '').trim();
  const normalizedCode = String(rawCode || '').trim().toUpperCase();

  if (!cleanUserId) throw new Error('User ID tidak valid.');
  if (!normalizedCode) throw new Error('Masukkan kode voucher terlebih dahulu.');

  const masterDb = readMasterDatabaseFile();
  const voucher = masterDb.vouchers?.[normalizedCode];

  if (!voucher) {
    throw new Error('Kode voucher tidak ditemukan.');
  }
  if (!voucher.isActive) {
    throw new Error('Kode voucher sedang dinonaktifkan.');
  }
  if (voucher.expiresAt > 0 && Date.now() > Number(voucher.expiresAt)) {
    throw new Error('Masa berlaku kode voucher ini sudah habis.');
  }

  const usedByList = Array.isArray(voucher.usedBy) ? voucher.usedBy : [];
  if (usedByList.includes(cleanUserId)) {
    throw new Error('Anda sudah pernah mengklaim kode voucher ini.');
  }
  if (Number(voucher.usedCount || 0) >= Number(voucher.maxUses || 1)) {
    throw new Error('Kuota klaim kode voucher ini sudah habis.');
  }

  const userRecord = readBotDatabase(cleanUserId);
  const baseTimestamp = Math.max(Date.now(), Number(userRecord.subscription?.expiresAt || 0));
  const durationDays = Math.max(1, Number(voucher.durationDays || 1));
  const nextExpiresAt = baseTimestamp + durationDays * 24 * 60 * 60 * 1000;

  userRecord.subscription = {
    ...(userRecord.subscription || {}),
    plan: voucher.planName || `Voucher ${durationDays} Hari`,
    expiresAt: nextExpiresAt,
    notifiedH3: false,
    notifiedH1: false,
    lastNotifiedExpiresAt: 0
  };

  masterDb.users[cleanUserId] = userRecord;
  masterDb.vouchers[normalizedCode] = {
    ...voucher,
    usedCount: Number(voucher.usedCount || 0) + 1,
    usedBy: [...usedByList, cleanUserId],
    lastRedeemedAt: Date.now()
  };

  writeMasterDatabaseFileAtomic(masterDb);
  return {
    voucher: masterDb.vouchers[normalizedCode],
    userDatabase: userRecord,
    addedDays: durationDays,
    expiresAt: nextExpiresAt
  };
}

// --- perpanjang masa aktif langganan user secara atomic dan reset flag pengingat ---
export function extendUserSubscriptionAtomic(googleUserId, durationDays, customPlanName = '') {
  const cleanUserId = String(googleUserId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const parsedDays = Math.max(1, parseInt(durationDays, 10) || 0);
  if (!cleanUserId || parsedDays <= 0) {
    throw new Error('User ID atau durasi perpanjangan tidak valid.');
  }

  const targetDatabase = readBotDatabase(cleanUserId);
  const baseTimestamp = Math.max(Date.now(), Number(targetDatabase.subscription?.expiresAt || 0));
  const nextExpiresAt = baseTimestamp + parsedDays * 24 * 60 * 60 * 1000;

  const resolvedPlan = customPlanName
    ? String(customPlanName).trim().slice(0, 50)
    : (parsedDays >= 90 ? 'Pro 90 Hari' : (parsedDays >= 30 ? 'Pro 30 Hari' : `Starter ${parsedDays} Hari`));

  targetDatabase.subscription = {
    ...(targetDatabase.subscription || {}),
    plan: resolvedPlan,
    expiresAt: nextExpiresAt,
    notifiedH3: false,
    notifiedH1: false,
    lastNotifiedExpiresAt: 0
  };

  writeBotDatabaseAtomic(cleanUserId, targetDatabase);
  return targetDatabase;
}

// --- manajemen api key whatsapp gateway per user di database.json ---
export function generateUserApiKey(googleUserId) {
  const userDatabase = readBotDatabase(googleUserId);
  const generatedKey = `xuc_${crypto.randomBytes(24).toString('hex')}`;
  userDatabase.apiKey = generatedKey;
  userDatabase.apiKeyStats = {
    createdAt: Date.now(),
    lastUsedAt: 0,
    totalCalls: 0
  };
  writeBotDatabaseAtomic(googleUserId, userDatabase);
  return {
    apiKey: generatedKey,
    apiKeyStats: userDatabase.apiKeyStats
  };
}

export function revokeUserApiKey(googleUserId) {
  const userDatabase = readBotDatabase(googleUserId);
  userDatabase.apiKey = null;
  userDatabase.apiKeyStats = {
    createdAt: 0,
    lastUsedAt: 0,
    totalCalls: 0
  };
  writeBotDatabaseAtomic(googleUserId, userDatabase);
  return true;
}

export function findUserByApiKey(rawApiKey) {
  const cleanKey = String(rawApiKey || '').trim();
  if (!cleanKey || !cleanKey.startsWith('xuc_')) return null;

  const masterDb = readMasterDatabaseFile();
  const incomingBuffer = Buffer.from(cleanKey, 'utf-8');

  for (const [googleUserId, userRecord] of Object.entries(masterDb.users || {})) {
    const storedKey = String(userRecord?.apiKey || '');
    if (!storedKey) continue;
    const storedBuffer = Buffer.from(storedKey, 'utf-8');
    if (
      storedBuffer.length === incomingBuffer.length &&
      crypto.timingSafeEqual(storedBuffer, incomingBuffer)
    ) {
      return {
        googleUserId,
        userDatabase: readBotDatabase(googleUserId)
      };
    }
  }
  return null;
}

export function recordApiKeyUsage(googleUserId) {
  const userDatabase = readBotDatabase(googleUserId);
  userDatabase.apiKeyStats = {
    createdAt: Number(userDatabase.apiKeyStats?.createdAt || Date.now()),
    lastUsedAt: Date.now(),
    totalCalls: Number(userDatabase.apiKeyStats?.totalCalls || 0) + 1
  };
  writeBotDatabaseAtomic(googleUserId, userDatabase);
  return userDatabase.apiKeyStats;
}

// --- simpan riwayat pengiriman webhook terbaru per user maksimal 15 entri ---
export function appendWebhookDeliveryLog(googleUserId, entry = {}) {
  const userDb = readBotDatabase(googleUserId);
  const existingLogs = Array.isArray(userDb.webhookLogs) ? userDb.webhookLogs : [];

  const deliveryItem = {
    id: `whl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event: String(entry.event || 'message.received').slice(0, 40),
    url: String(entry.url || '').slice(0, 220),
    statusCode: Number(entry.statusCode || 0),
    isSuccess: Boolean(entry.isSuccess),
    durationMs: Math.max(0, Math.round(Number(entry.durationMs || 0))),
    errorMessage: entry.errorMessage ? String(entry.errorMessage).slice(0, 180) : '',
    timestamp: Number(entry.timestamp || Date.now())
  };

  userDb.webhookLogs = [deliveryItem, ...existingLogs].slice(0, 15);
  writeBotDatabaseAtomic(googleUserId, userDb);
  return userDb.webhookLogs;
}

// --- bersihkan seluruh riwayat pengiriman webhook milik user ---
export function clearWebhookDeliveryLogs(googleUserId) {
  const userDb = readBotDatabase(googleUserId);
  userDb.webhookLogs = [];
  writeBotDatabaseAtomic(googleUserId, userDb);
  return [];
}

// --- ekspor konfigurasi bot milik user ke objek json portabel ---
export function exportUserBotConfig(googleUserId) {
  const userDb = readBotDatabase(googleUserId);
  return {
    schemaVersion: 'xu-core-config-v2',
    exportedAt: new Date().toISOString(),
    settings: userDb.settings
  };
}

// --- impor dan sanitasi konfigurasi bot dari file json milik user ---
export function importUserBotConfig(googleUserId, rawConfigObj) {
  if (!rawConfigObj || typeof rawConfigObj !== 'object') {
    throw new Error('Format file JSON konfigurasi tidak valid.');
  }

  const sourceSettings = rawConfigObj.settings && typeof rawConfigObj.settings === 'object'
    ? rawConfigObj.settings
    : rawConfigObj;

  const currentDb = readBotDatabase(googleUserId);
  const merged = { ...currentDb.settings };

  if (typeof sourceSettings.botName === 'string' && sourceSettings.botName.trim()) {
    merged.botName = sourceSettings.botName.trim().slice(0, 60);
  }
  if (typeof sourceSettings.packname === 'string') merged.packname = sourceSettings.packname.trim().slice(0, 60);
  if (typeof sourceSettings.author === 'string') merged.author = sourceSettings.author.trim().slice(0, 60);
  if (typeof sourceSettings.autoRead === 'boolean') merged.autoRead = sourceSettings.autoRead;
  if (typeof sourceSettings.publicMode === 'boolean') merged.publicMode = sourceSettings.publicMode;
  if (typeof sourceSettings.isNoPrefix === 'boolean') merged.isNoPrefix = sourceSettings.isNoPrefix;
  if (typeof sourceSettings.allowedPc === 'boolean') merged.allowedPc = sourceSettings.allowedPc;
  if (typeof sourceSettings.isAiEnabled === 'boolean') merged.isAiEnabled = sourceSettings.isAiEnabled;
  if (typeof sourceSettings.aiGroupAutoReply === 'boolean') merged.aiGroupAutoReply = sourceSettings.aiGroupAutoReply;
  if (typeof sourceSettings.aiSystemPrompt === 'string') {
    merged.aiSystemPrompt = sourceSettings.aiSystemPrompt.trim().slice(0, 2000);
  }
  if (typeof sourceSettings.webhookUrl === 'string') merged.webhookUrl = sourceSettings.webhookUrl.trim().slice(0, 300);
  if (typeof sourceSettings.webhookSecret === 'string') merged.webhookSecret = sourceSettings.webhookSecret.trim().slice(0, 120);

  if (Array.isArray(sourceSettings.owners)) {
    merged.owners = Array.from(
      new Set(
        sourceSettings.owners
          .map((n) => String(n).replace(/\D/g, ''))
          .filter((n) => n.length >= 6 && n.length <= 18)
      )
    ).slice(0, 20);
  }
  if (Array.isArray(sourceSettings.toxic)) {
    merged.toxic = sourceSettings.toxic.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 100);
  }
  if (Array.isArray(sourceSettings.disabledCategories)) {
    merged.disabledCategories = Array.from(
      new Set(sourceSettings.disabledCategories.map((c) => String(c).trim().toLowerCase()).filter(Boolean))
    );
  }
  if (Array.isArray(sourceSettings.autoReplies)) {
    merged.autoReplies = sourceSettings.autoReplies
      .filter((item) => item && String(item.trigger || '').trim())
      .map((item) => ({
        trigger: String(item.trigger).trim().slice(0, 80),
        response: String(item.response || '').trim().slice(0, 500),
        matchType: ['exact', 'contains', 'starts'].includes(String(item.matchType || 'exact').toLowerCase())
          ? String(item.matchType).toLowerCase()
          : 'exact',
        mediaType: ['text', 'image', 'sticker', 'document'].includes(String(item.mediaType || 'text').toLowerCase())
          ? String(item.mediaType).toLowerCase()
          : 'text',
        mediaUrl: String(item.mediaUrl || '').trim().slice(0, 400)
      }))
      .slice(0, 30);
  }

  if (sourceSettings.customMessages && typeof sourceSettings.customMessages === 'object') {
    const allowedMsgKeys = ['wait', 'limit', 'premium', 'owner', 'group', 'private', 'admin', 'botAdmin'];
    merged.customMessages = { ...(merged.customMessages || {}) };
    for (const key of allowedMsgKeys) {
      if (typeof sourceSettings.customMessages[key] === 'string') {
        merged.customMessages[key] = sourceSettings.customMessages[key].trim().slice(0, 300);
      }
    }
  }

  if (sourceSettings.prefixConfig && typeof sourceSettings.prefixConfig === 'object') {
    const rawPrefixes = String(sourceSettings.prefixConfig.prefixes ?? merged.prefixConfig.prefixes ?? '.!/#').trim().slice(0, 20);
    merged.prefixConfig = {
      prefixes: rawPrefixes || '.!/#',
      cooldownSeconds: Math.max(0, Math.min(60, Number(sourceSettings.prefixConfig.cooldownSeconds ?? 3) || 0)),
      spamLimit: Math.max(2, Math.min(30, Number(sourceSettings.prefixConfig.spamLimit ?? 5) || 5)),
      spamCooldownSeconds: Math.max(5, Math.min(300, Number(sourceSettings.prefixConfig.spamCooldownSeconds ?? 15) || 15))
    };
  }

  if (sourceSettings.menuConfig && typeof sourceSettings.menuConfig === 'object') {
    merged.menuConfig = {
      header: String(sourceSettings.menuConfig.header || '').trim().slice(0, 200),
      footer: String(sourceSettings.menuConfig.footer || '').trim().slice(0, 200),
      thumbnailUrl: String(sourceSettings.menuConfig.thumbnailUrl || '').trim().slice(0, 400)
    };
  }

  if (sourceSettings.limitConfig && typeof sourceSettings.limitConfig === 'object') {
    merged.limitConfig = {
      ...(merged.limitConfig || {}),
      defaultLimit: Math.max(1, Math.min(10000, parseInt(sourceSettings.limitConfig.defaultLimit ?? 25, 10) || 25)),
      resetHourWib: Math.max(0, Math.min(23, parseInt(sourceSettings.limitConfig.resetHourWib ?? 0, 10) || 0)),
      autoResetEnabled: Boolean(sourceSettings.limitConfig.autoResetEnabled ?? true)
    };
  }

  if (sourceSettings.groupConfigs && typeof sourceSettings.groupConfigs === 'object') {
    merged.groupConfigs = sourceSettings.groupConfigs;
  }

  currentDb.settings = merged;
  writeBotDatabaseAtomic(googleUserId, currentDb);
  return currentDb;
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

// --- ambil data statistik, langganan, jadwal pesan, trafik, webhook logs, api key, dan pengaturan lengkap akun ---
export function readBotDatabase(googleUserId) {
  const masterDatabase = readMasterDatabaseFile();
  const existingUserRecord = masterDatabase.users[googleUserId];

  const defaultCustomMessages = {
    wait: CONFIG.mess.wait,
    limit: CONFIG.mess.limit,
    premium: CONFIG.mess.premium,
    owner: CONFIG.mess.owner,
    group: CONFIG.mess.group,
    private: CONFIG.mess.private,
    admin: CONFIG.mess.admin,
    botAdmin: CONFIG.mess.botAdmin
  };

  const defaultPrefixConfig = {
    prefixes: '.!/#',
    cooldownSeconds: 3,
    spamLimit: 5,
    spamCooldownSeconds: 15
  };

  const defaultMenuConfig = {
    header: CONFIG.header,
    footer: CONFIG.footer,
    thumbnailUrl: ''
  };

  const defaultLimitConfig = {
    defaultLimit: 25,
    resetHourWib: 0,
    autoResetEnabled: true,
    lastResetDate: ''
  };

  // --- pengaturan default per akun bot ---
  const defaultSettings = {
    autoRead: true,
    publicMode: true,
    botName: CONFIG.platformName,
    packname: CONFIG.platformName,
    author: 'Surya Core',
    isNoPrefix: true,
    allowedPc: true,
    isAiEnabled: false,
    aiGroupAutoReply: false,
    aiSystemPrompt: 'Kamu adalah asisten WhatsApp profesional yang ramah, informatif, dan menjawab singkat dalam Bahasa Indonesia.',
    webhookUrl: '',
    webhookSecret: '',
    groupConfigs: {},
    customMessages: defaultCustomMessages,
    prefixConfig: defaultPrefixConfig,
    menuConfig: defaultMenuConfig,
    limitConfig: defaultLimitConfig,
    toxic: [],
    owners: [],
    disabledCategories: [],
    autoReplies: []
  };

  const defaultSubscription = {
    plan: 'Starter Trial',
    expiresAt: Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000,
    isReseller: false,
    maxSlots: 1,
    notifiedH3: false,
    notifiedH1: false,
    lastNotifiedExpiresAt: 0
  };

  const defaultApiKeyStats = {
    createdAt: 0,
    lastUsedAt: 0,
    totalCalls: 0
  };

  const defaultUserRecord = {
    googleUserId,
    phoneNumber: null,
    sessionName: null,
    apiKey: null,
    apiKeyStats: defaultApiKeyStats,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
    uniqueUsers: [],
    trafficHistory: {},
    scheduledMessages: [],
    webhookLogs: [],
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
  mergedSettings.isAiEnabled = Boolean(mergedSettings.isAiEnabled);
  mergedSettings.aiGroupAutoReply = Boolean(mergedSettings.aiGroupAutoReply);
  mergedSettings.aiSystemPrompt = String(mergedSettings.aiSystemPrompt || defaultSettings.aiSystemPrompt).slice(0, 2000);
  mergedSettings.webhookUrl = String(mergedSettings.webhookUrl || '').trim().slice(0, 300);
  mergedSettings.webhookSecret = String(mergedSettings.webhookSecret || '').trim().slice(0, 120);
  mergedSettings.groupConfigs =
    mergedSettings.groupConfigs && typeof mergedSettings.groupConfigs === 'object'
      ? mergedSettings.groupConfigs
      : {};
  mergedSettings.customMessages = {
    ...defaultCustomMessages,
    ...(mergedSettings.customMessages && typeof mergedSettings.customMessages === 'object' ? mergedSettings.customMessages : {})
  };
  mergedSettings.prefixConfig = {
    ...defaultPrefixConfig,
    ...(mergedSettings.prefixConfig && typeof mergedSettings.prefixConfig === 'object' ? mergedSettings.prefixConfig : {})
  };
  mergedSettings.menuConfig = {
    ...defaultMenuConfig,
    ...(mergedSettings.menuConfig && typeof mergedSettings.menuConfig === 'object' ? mergedSettings.menuConfig : {})
  };
  mergedSettings.limitConfig = {
    ...defaultLimitConfig,
    ...(mergedSettings.limitConfig && typeof mergedSettings.limitConfig === 'object' ? mergedSettings.limitConfig : {})
  };

  const mergedSubscription = {
    ...defaultSubscription,
    ...(existingUserRecord.subscription || {})
  };

  const mergedApiKeyStats = {
    ...defaultApiKeyStats,
    ...(existingUserRecord.apiKeyStats || {})
  };

  return {
    ...defaultUserRecord,
    ...existingUserRecord,
    apiKey: existingUserRecord.apiKey || null,
    apiKeyStats: mergedApiKeyStats,
    uniqueUsers: Array.isArray(existingUserRecord.uniqueUsers) ? existingUserRecord.uniqueUsers : [],
    trafficHistory: existingUserRecord.trafficHistory && typeof existingUserRecord.trafficHistory === 'object'
      ? existingUserRecord.trafficHistory
      : {},
    scheduledMessages: Array.isArray(existingUserRecord.scheduledMessages)
      ? existingUserRecord.scheduledMessages
      : [],
    webhookLogs: Array.isArray(existingUserRecord.webhookLogs)
      ? existingUserRecord.webhookLogs.slice(0, 15)
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

// --- catat trafik pesan harian (masuk atau keluar) dan simpan 14 hari terakhir ---
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

// --- query monitor global seluruh user dan sesi aktif untuk panel /admin ---
export function getAllUsersGlobalMonitorSnapshot(activeBotSessions) {
  const masterDb = readMasterDatabaseFile();
  const nowMs = Date.now();

  const localAccountByUserId = new Map();
  for (const acc of Object.values(masterDb.authAccounts || {})) {
    if (acc?.userId) {
      localAccountByUserId.set(acc.userId, acc);
    }
  }

  const allUserIds = new Set([
    ...Object.keys(masterDb.users || {}),
    ...Array.from(activeBotSessions ? activeBotSessions.keys() : [])
  ]);

  const rows = [];
  let onlineCount = 0;
  let connectingCount = 0;
  let offlineCount = 0;
  let totalSessionsBytes = 0;

  for (const userId of allUserIds) {
    const userDb = readBotDatabase(userId);
    const liveSession = activeBotSessions ? activeBotSessions.get(userId) : null;
    const localAccount = localAccountByUserId.get(userId) || null;

    let connectionStatus = 'OFFLINE';
    if (liveSession?.status === 'CONNECTED') {
      connectionStatus = 'ONLINE';
      onlineCount += 1;
    } else if (liveSession?.status === 'CONNECTING') {
      connectionStatus = 'CONNECTING';
      connectingCount += 1;
    } else {
      offlineCount += 1;
    }

    const sessionFolder = userDb.sessionName
      ? getUserSessionFolderPath(userId, userDb.sessionName)
      : getUserSessionFolderPath(userId, `qr_${userId}`);
    const sessionSizeBytes = fs.existsSync(sessionFolder) ? calculateDirectorySizeBytes(sessionFolder) : 0;
    totalSessionsBytes += sessionSizeBytes;

    const expiresAt = Number(userDb.subscription?.expiresAt || 0);
    const remainingMs = expiresAt > 0 ? Math.max(0, expiresAt - nowMs) : 0;
    const remainingDays = expiresAt > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
    const isExpired = !isPlatformAdminById(userId) && expiresAt > 0 && nowMs > expiresAt;

    rows.push({
      googleUserId: userId,
      accountType: userId.startsWith('local_') ? 'LOCAL' : 'GOOGLE',
      email: localAccount?.email || null,
      displayName: liveSession?.profile?.name || localAccount?.fullName || userDb.settings?.botName || userId,
      phoneNumber: liveSession?.profile?.number || userDb.phoneNumber || null,
      ownerNumbers: Array.isArray(userDb.settings?.owners) ? userDb.settings.owners : [],
      sessionName: userDb.sessionName || null,
      status: connectionStatus,
      sessionSizeBytes,
      sessionSizeLabel: formatBytesReadable(sessionSizeBytes),
      subscription: {
        plan: userDb.subscription?.plan || 'Starter Trial',
        expiresAt,
        remainingMs,
        remainingDays,
        isExpired,
        notifiedH3: Boolean(userDb.subscription?.notifiedH3),
        notifiedH1: Boolean(userDb.subscription?.notifiedH1)
      },
      totalMessagesReceived: Number(userDb.totalMessagesReceived || 0),
      totalMessagesSent: Number(userDb.totalMessagesSent || 0),
      uniqueUsersCount: Array.isArray(userDb.uniqueUsers) ? userDb.uniqueUsers.length : 0,
      isAiEnabled: Boolean(userDb.settings?.isAiEnabled),
      hasApiKey: Boolean(userDb.apiKey),
      apiKeyCalls: Number(userDb.apiKeyStats?.totalCalls || 0)
    });
  }

  const statusPriority = { ONLINE: 0, CONNECTING: 1, OFFLINE: 2 };
  rows.sort((a, b) => {
    const diff = (statusPriority[a.status] ?? 3) - (statusPriority[b.status] ?? 3);
    if (diff !== 0) return diff;
    return Number(b.totalMessagesReceived || 0) - Number(a.totalMessagesReceived || 0);
  });

  return {
    summary: {
      totalUsers: rows.length,
      onlineCount,
      connectingCount,
      offlineCount,
      totalSessionsBytes,
      totalSessionsSizeLabel: formatBytesReadable(totalSessionsBytes),
      timestamp: nowMs
    },
    sessions: rows
  };
}
