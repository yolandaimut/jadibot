// --- konfigurasi platform xu core dan path volume railway ---
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from '../package.json' with { type: 'json' };

const currentFilePath = fileURLToPath(import.meta.url);
const coreDirPath = path.dirname(currentFilePath);
const currentYear = new Date().getFullYear().toString();

function sanitize(id) {
  return String(id || '').replace(/\D/g, '') + '@s.whatsapp.net';
}

function parseEnvList(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const CURRENT_DIR = path.resolve(coreDirPath, '..');
export const PUBLIC_ROOT_DIR = path.join(CURRENT_DIR, 'public');
export const SYSTEM_ROOT_DIR = path.join(CURRENT_DIR, 'system');

export const SERVER_PORT = process.env.PORT || 3000;
export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '404486479013-8tpsuq4920rao7clth8graba1vtoon72.apps.googleusercontent.com';

export const ADMIN_EMAILS = parseEnvList(process.env.ADMIN_EMAILS || 'suryadev2105@gmail.com');
export const ADMIN_GOOGLE_IDS = parseEnvList(process.env.ADMIN_GOOGLE_IDS || '113793372874509761088');
export const ADMIN_WA_NUMBER = String(process.env.ADMIN_WA_NUMBER || '62895415497664').replace(/\D/g, '');
export const DEFAULT_TRIAL_DAYS = Math.max(1, parseInt(process.env.DEFAULT_TRIAL_DAYS || '30', 10) || 30);

export const SESSION_COOKIE_NAME = 'jadibot_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const AUTO_CONNECT_TIMEOUT_MS = 20000;
export const AUTO_CONNECT_MAX_RETRIES = 3;

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
export const DISABLED_PLUGINS_FILE_PATH = path.join(SESSIONS_VOLUME_ROOT, 'disabled-plugins.json');
export const CONTACTS_FILE_PATH = path.join(SESSIONS_VOLUME_ROOT, 'contacts.json');
export const SESSION_SECRET_PATH = path.join(SESSIONS_VOLUME_ROOT, '.session_secret');
export const TRASH_ROOT_DIR = path.join(SESSIONS_VOLUME_ROOT, 'sampah');

// --- konfigurasi global level platform (bukan per-bot) ---
export const CONFIG = {
  platformName: 'XU CORE',
  version: pkg.version,
  copyright: `Copyright © ${currentYear} Xu Core`,
  header: `© xu-core v${pkg.version}`,
  footer: 'ꜱɪᴍᴘʟᴇ ᴡʜᴀᴛꜱᴀᴘᴘ ʙᴏᴛ ᴍᴀᴅᴇ ʙʏ ꜱᴜʀʏᴀ',

  // --- daftar developer platform (superadmin lintas semua bot) ---
  devs: [
    '62895415497664',
    '6285700408187',
    '6289504842184',
    '6285602467071',
    '6285702691440',
    '6285126904781'
  ].map(sanitize),

  blocks: ['91', '92', '212'],
  prefixes: /^[°•π÷×¶∆£¢€¥®™+✓_=|/~!?@#%^&.,©^]/i,
  useRedis: false,

  cooldown: {
    antispam: 10,
    command: 5000
  },

  spam: {
    limit: 3,
    cooldown: 10,
    warning: 3,
    action: 'BOTH'
  },

  path: {
    system: SYSTEM_ROOT_DIR,
    logs: path.join(SESSIONS_VOLUME_ROOT, 'logs'),
    trash: TRASH_ROOT_DIR
  },

  emoticon: [
    '🙂‍↔', '💫', '✨', '💥', '🌹', '🤍',
    '😹', '🥰', '🤗', '😊', '🥳', '😍',
    '💌', '💐', '🦋', '🖤', '💗', '😻',
    '🫶🏻', '👏🏻', '💋', '🫰🏻', '😎', '🙂‍↕',
    '🤩', '😀', '😇', '🌚', '💖', '🌝',
    '🥀', '🗿', '🔥', '❤️', '👀', '😌',
    '🌟', '🥳', '🤡'
  ],

  mess: {
    wait: '✦ bentar ya sayang, lagi diproses...',
    ok: '✓ udah beres ya sayang.',
    limit: '✗ limit harianmu habis sayang (reset jam 12 malam). ketik .buylimit atau .buyprem biar puas tanpa batas.',
    premium: '✗ ini khusus member premium sayang. ketik .buyprem yuk!',
    jadibot: '✗ maaf sayang, ini khusus buat yang jadi bot aja ya.',
    owner: '✗ ih, ini cuma buat owner sayang, jangan nakal ya.',
    devs: '✗ maaf sayang, ini khusus developer bot aja.',
    group: '✗ ini cuma bisa dipakai di grup ya sayang.',
    private: '✗ ini khusus di chat pribadi (dm) aku ya sayang.',
    admin: '✗ ini khusus admin grup aja sayang.',
    botAdmin: '✗ aku jadiin admin dulu dong sayang biar bisa kerja.',
    game: '✗ main game di dm khusus premium sayang, ketik .buyprem dulu yuk.',
    error: {
      url: '✗ duh, url-nya nggak valid sayang.',
      api: '✗ maaf sayang, server aku lagi error nih.'
    },
    block: {
      owner: '✗ fitur ini lagi dimatiin owner sayang.',
      system: '✗ fitur ini lagi diblokir sistem karena error sayang.'
    },
    query: '✗ masukin teks yang mau dicari ya sayang.',
    search: '✦ lagi dicariin nih sayang, tunggu ya...',
    empty: '✗ duh sayang, datanya lagi kosong nih.',
    wrong: (error) => `✗ ada masalah nih sayang: ${error}`,
    antispam: '✗ jangan spam sayang, tunggu @cooldown detik ya. ini peringatan ke-@warning dari @maxwarning.',
    antispam2: '✗ maaf @sender, kamu aku blokir otomatis karena spam. chat owner buat buka blokirnya ya.',
    verify: '✗ nomormu belum verifikasi sayang, kirim @command dulu ya.',
    notverified: '✗ nomormu belum terdaftar sayang, ketik @command buat daftar ya.',
    restrict: '✗ hmm, kamu pakai kata terlarang sayang. dihukum nggak bisa pakai bot @menit menit ya.',
    banned2: '✗ yah sayang, akunmu lagi dibanned. sabar ya sampai: *@expire*.',
    cooldown: '✗ lagi cooldown sayang, tunggu @detik detik lagi ya.'
  }
};

// --- pastikan seluruh direktori persisten dan struktur global.db siap saat boot ---
export function initPersistentDirectories() {
  fs.mkdirSync(SESSIONS_VOLUME_ROOT, { recursive: true });
  fs.mkdirSync(SESSIONS_ROOT_FOLDER_PATH, { recursive: true });
  fs.mkdirSync(PLUGINS_ROOT_DIR, { recursive: true });
  fs.mkdirSync(TRASH_ROOT_DIR, { recursive: true });

  global.db = global.db || {};
  global.db.users = global.db.users || {};
  global.db.groups = global.db.groups || {};
  global.db.setting = global.db.setting || {};
  global.db.metadata = global.db.metadata || {};
  global.db.statistic = global.db.statistic || {};
}

export default CONFIG;
