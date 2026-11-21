// --- konfigurasi path volume railway dan konstanta global surya core ---
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const currentFilePath = fileURLToPath(import.meta.url);
const coreDirPath = path.dirname(currentFilePath);

export const CURRENT_DIR = path.resolve(coreDirPath, '..');
export const PUBLIC_ROOT_DIR = path.join(CURRENT_DIR, 'public');
export const SYSTEM_ROOT_DIR = path.join(CURRENT_DIR, 'system');

export const SERVER_PORT = process.env.PORT || 3000;
export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '404486479013-8tpsuq4920rao7clth8graba1vtoon72.apps.googleusercontent.com';

export const SESSION_COOKIE_NAME = 'jadibot_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const AUTO_CONNECT_TIMEOUT_MS = 20000;
export const AUTO_CONNECT_MAX_RETRIES = 3;

export const CONFIG = {
  botName: process.env.BOT_NAME || 'Surya Core',
  packname: process.env.STICKER_PACKNAME || 'Surya Core',
  author: process.env.STICKER_AUTHOR || 'JadiBot Enterprise',
  prefixes: ['.', '!', '/', '#']
};

// --- deteksi direktori persistent volume railway secara berurutan ---
function resolveRailwayVolumeRoot() {
  const preferredPaths = [
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    '/data/sessions',
    '/app/mnt/volume/sessions'
  ].filter(Boolean);

  for (const candidatePath of preferredPaths) {
    try {
      fs.mkdirSync(candidatePath, { recursive: true });
      fs.accessSync(candidatePath, fs.constants.W_OK);
      return candidatePath;
    } catch {
      // --- lanjutkan ke kandidat berikutnya jika izin tulis ditolak ---
    }
  }

  const fallbackLocalPath = path.join(CURRENT_DIR, 'data', 'sessions');
  fs.mkdirSync(fallbackLocalPath, { recursive: true });
  return fallbackLocalPath;
}

export const SESSIONS_VOLUME_ROOT = resolveRailwayVolumeRoot();
export const MAIN_DATABASE_FILE_PATH = path.join(SESSIONS_VOLUME_ROOT, 'database.json');
export const SESSIONS_ROOT_FOLDER_PATH = path.join(SESSIONS_VOLUME_ROOT, 'sessions');
export const PLUGINS_ROOT_DIR = path.join(SESSIONS_VOLUME_ROOT, 'plugins');
export const CONTACTS_FILE_PATH = path.join(SESSIONS_VOLUME_ROOT, 'contacts.json');
export const SESSION_SECRET_PATH = path.join(SESSIONS_VOLUME_ROOT, '.session_secret');

// --- pastikan seluruh direktori persisten dan struktur global.db siap saat boot ---
export function initPersistentDirectories() {
  fs.mkdirSync(SESSIONS_VOLUME_ROOT, { recursive: true });
  fs.mkdirSync(SESSIONS_ROOT_FOLDER_PATH, { recursive: true });
  fs.mkdirSync(PLUGINS_ROOT_DIR, { recursive: true });

  global.db = global.db || {};
  global.db.users = global.db.users || {};
  global.db.groups = global.db.groups || {};
  global.db.setting = global.db.setting || {};
  global.db.metadata = global.db.metadata || {};
}
