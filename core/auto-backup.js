// --- worker auto-backup terjadwal (database.json & plugins) ke whatsapp admin ---
import fs from 'fs';
import path from 'path';
import {
  ADMIN_WA_NUMBER,
  MAIN_DATABASE_FILE_PATH,
  PLUGINS_ROOT_DIR,
  SESSIONS_VOLUME_ROOT
} from './config.js';
import { scanPluginFilesRecursive } from './plugin-manager.js';
import { activeBotSessions } from './session-manager.js';

const DEFAULT_BACKUP_INTERVAL_HOURS = Math.max(1, Number(process.env.AUTO_BACKUP_INTERVAL_HOURS || 24));
const CHECK_TICK_INTERVAL_MS = 30 * 60 * 1000;
const BACKUP_TMP_DIR = path.join(SESSIONS_VOLUME_ROOT, '_auto_backups');
const LAST_RUN_FILE_PATH = path.join(BACKUP_TMP_DIR, '.last_backup_at');

let autoBackupTimerRef = null;
let isBackupRunning = false;

// --- baca timestamp backup terakhir agar jadwal tidak ter-reset saat server restart ---
function readLastBackupTimestamp() {
  try {
    if (!fs.existsSync(LAST_RUN_FILE_PATH)) return 0;
    return Number(fs.readFileSync(LAST_RUN_FILE_PATH, 'utf-8').trim()) || 0;
  } catch {
    return 0;
  }
}

// --- simpan timestamp backup terakhir secara persisten ---
function writeLastBackupTimestamp(timestampMs) {
  fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
  fs.writeFileSync(LAST_RUN_FILE_PATH, String(timestampMs), 'utf-8');
}

// --- bersihkan arsip backup lama agar hanya menyimpan 3 file terbaru ---
function pruneOldBackupFiles() {
  try {
    if (!fs.existsSync(BACKUP_TMP_DIR)) return;
    const files = fs
      .readdirSync(BACKUP_TMP_DIR)
      .filter((file) => file.endsWith('.zip'))
      .map((file) => {
        const fullPath = path.join(BACKUP_TMP_DIR, file);
        return { name: file, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(3)) {
      fs.unlinkSync(stale.fullPath);
    }
  } catch {
    // --- abaikan error pembersihan file lama ---
  }
}

// --- buat arsip zip berisi database.json dan seluruh plugins menggunakan fflate ---
async function buildPlatformBackupArchiveBuffer() {
  const { zipSync } = await import('fflate');
  const zipEntries = {};

  if (fs.existsSync(MAIN_DATABASE_FILE_PATH)) {
    zipEntries['database.json'] = new Uint8Array(fs.readFileSync(MAIN_DATABASE_FILE_PATH));
  }

  const pluginFiles = scanPluginFilesRecursive(PLUGINS_ROOT_DIR);
  for (const relativePath of pluginFiles) {
    const fullPluginPath = path.join(PLUGINS_ROOT_DIR, relativePath);
    if (fs.existsSync(fullPluginPath)) {
      zipEntries[`plugins/${relativePath}`] = new Uint8Array(fs.readFileSync(fullPluginPath));
    }
  }

  const archiveBuffer = Buffer.from(zipSync(zipEntries, { level: 6 }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `xu-core-autobackup-${stamp}.zip`;

  fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_TMP_DIR, fileName), archiveBuffer);

  return { fileName, archiveBuffer, pluginCount: pluginFiles.length };
}

// --- jalankan satu siklus backup dan kirim dokumen zip ke whatsapp admin ---
export async function runScheduledBackupNow() {
  if (isBackupRunning) {
    return { isSuccess: false, errorMessage: 'Proses backup sedang berjalan.' };
  }

  isBackupRunning = true;
  try {
    const { fileName, archiveBuffer, pluginCount } = await buildPlatformBackupArchiveBuffer();
    const sizeKb = (archiveBuffer.length / 1024).toFixed(1);
    const adminNumber = String(process.env.ADMIN_WA_NUMBER || ADMIN_WA_NUMBER || '').replace(/\D/g, '');

    let senderClient = null;
    for (const session of activeBotSessions.values()) {
      if (session?.status === 'CONNECTED' && session?.socketInstance) {
        senderClient = session.socketInstance;
        break;
      }
    }

    if (!senderClient) {
      console.log(`[AUTO-BACKUP] Arsip ${fileName} (${sizeKb} KB) tersimpan lokal (belum ada sesi WA online).`);
      pruneOldBackupFiles();
      return { isSuccess: true, sentToWhatsapp: false, fileName, sizeKb };
    }

    if (!adminNumber) {
      return { isSuccess: false, errorMessage: 'Nomor WhatsApp admin belum dikonfigurasi.' };
    }

    const targetJid = `${adminNumber}@s.whatsapp.net`;
    await senderClient.sendMessage(targetJid, {
      document: archiveBuffer,
      fileName,
      mimetype: 'application/zip',
      caption: `Auto-Backup Xu Core berhasil.\nFile: ${fileName}\nPlugin: ${pluginCount} file\nUkuran: ${sizeKb} KB`
    });

    writeLastBackupTimestamp(Date.now());
    pruneOldBackupFiles();
    console.log(`[AUTO-BACKUP] Arsip ${fileName} (${sizeKb} KB) terkirim ke WA Admin (${adminNumber}).`);

    return { isSuccess: true, sentToWhatsapp: true, fileName, sizeKb };
  } catch (err) {
    console.error(`[AUTO-BACKUP ERROR] ${err.message}`);
    return { isSuccess: false, errorMessage: err.message };
  } finally {
    isBackupRunning = false;
  }
}

// --- cek apakah sudah waktunya menjalankan auto-backup terjadwal ---
async function checkAndRunBackupIfDue() {
  const intervalMs = DEFAULT_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  const lastRunAt = readLastBackupTimestamp();
  if (Date.now() - lastRunAt < intervalMs) return;
  await runScheduledBackupNow();
}

// --- mulai interval worker auto-backup yang tahan terhadap restart server ---
export function startAutoBackupWorker() {
  if (autoBackupTimerRef) return;

  // --- cek pertama 60 detik setelah boot agar sesi whatsapp sempat terkoneksi dulu ---
  setTimeout(() => {
    checkAndRunBackupIfDue().catch(() => {});
  }, 60 * 1000).unref();

  autoBackupTimerRef = setInterval(() => {
    checkAndRunBackupIfDue().catch(() => {});
  }, CHECK_TICK_INTERVAL_MS);

  if (typeof autoBackupTimerRef.unref === 'function') {
    autoBackupTimerRef.unref();
  }

  console.log(`[AUTO-BACKUP] Worker aktif (interval ${DEFAULT_BACKUP_INTERVAL_HOURS} jam, cek tiap 30 menit).`);
}
