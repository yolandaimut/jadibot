// --- utilitas manajemen kredensial sesi persisten di railway volume ---
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { SESSIONS_VOLUME_ROOT } from '../core/config.js';
import func from './functions.js';

const BACKUP_CREDS_DIR = path.join(SESSIONS_VOLUME_ROOT, 'creds-backup');

async function getOptionalRedisClient() {
  try {
    const mod = await import('./redis-auth.js');
    return mod.redisClient || null;
  } catch {
    return null;
  }
}

export const getSafeId = (clientOrId) => {
  if (typeof clientOrId === 'string') {
    return clientOrId.replace(/\D/g, '');
  }
  if (clientOrId?.user?.id) {
    return jidNormalizedUser(clientOrId.user.id).replace(/@.+/, '');
  }
  throw new Error('Client.user belum tersedia atau format ID tidak valid.');
};

export const formatRedisId = (sessionFile) => {
  if (!sessionFile) return '';
  return sessionFile.replace('jadibot/', '');
};

export const backup = async (client, sessionFolderPath, useRedis = false) => {
  if (useRedis) return true;
  try {
    const userId = getSafeId(client);
    const backupPath = path.join(BACKUP_CREDS_DIR, `${userId}-creds.json`);
    const sessionPath = path.join(sessionFolderPath, 'creds.json');

    await func.delay(1500);
    await fsp.mkdir(BACKUP_CREDS_DIR, { recursive: true });
    const credentialsData = await fsp.readFile(sessionPath, 'utf-8');
    await fsp.writeFile(backupPath, credentialsData, 'utf-8');
    return true;
  } catch {
    return false;
  }
};

export const restore = async (clientOrId, sessionFolderPath, useRedis = false) => {
  if (useRedis) return true;
  try {
    const userId = getSafeId(clientOrId);
    const backupPath = path.join(BACKUP_CREDS_DIR, `${userId}-creds.json`);
    const sessionPath = path.join(sessionFolderPath, 'creds.json');

    if (fs.existsSync(backupPath)) {
      await fsp.mkdir(sessionFolderPath, { recursive: true });
      const credentialsData = await fsp.readFile(backupPath, 'utf-8');
      await fsp.writeFile(sessionPath, credentialsData, 'utf-8');
    }
  } catch (error) {
    console.error('[SESSION ERROR] Gagal restore kredensial:', error.message);
  }
};

export const isBackupExist = async (clientOrId, useRedis = false) => {
  if (useRedis) return false;
  try {
    const userId = getSafeId(clientOrId);
    return fs.existsSync(path.join(BACKUP_CREDS_DIR, `${userId}-creds.json`));
  } catch {
    return false;
  }
};

export const clearSession = async (sessionFolderPath, useRedis = false) => {
  if (useRedis) {
    const redisClient = await getOptionalRedisClient();
    if (!redisClient) return;
    const redisId = formatRedisId(sessionFolderPath);
    const pattern = `wabot_${redisId}:*`;
    try {
      let cursor = '0';
      do {
        const result = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        const keys = Array.isArray(result) ? result[1] : result?.keys || [];
        cursor = String(Array.isArray(result) ? result[0] : result?.cursor || '0');
        if (keys.length > 0) await redisClient.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      console.error('[SESSION ERROR] Gagal clearSession Redis:', error.message);
    }
    return;
  }

  try {
    if (fs.existsSync(sessionFolderPath)) {
      await fsp.rm(sessionFolderPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('[SESSION ERROR] Gagal menghapus folder sesi:', error.message);
  }
};

export const deleteCreds = async (sessionFolderPath, useRedis = false) => {
  if (useRedis) {
    const redisClient = await getOptionalRedisClient();
    if (!redisClient) return;
    await redisClient.del(`wabot_${formatRedisId(sessionFolderPath)}:creds`).catch(() => {});
    return;
  }

  const credsFilePath = path.join(sessionFolderPath, 'creds.json');
  if (fs.existsSync(credsFilePath)) {
    await fsp.unlink(credsFilePath).catch(() => {});
  }
};

export const deleteBackup = async (clientOrId, useRedis = false) => {
  if (useRedis) return true;
  try {
    const userId = getSafeId(clientOrId);
    const backupPath = path.join(BACKUP_CREDS_DIR, `${userId}-creds.json`);
    if (fs.existsSync(backupPath)) await fsp.unlink(backupPath);
  } catch {
    // --- abaikan jika file backup tidak ditemukan ---
  }
};

export default {
  getSafeId,
  formatRedisId,
  backup,
  restore,
  isBackupExist,
  clearSession,
  deleteCreds,
  deleteBackup
};
