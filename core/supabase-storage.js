// --- utilitas unggah media dan stiker ke supabase storage dengan fallback volume aman ---
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SESSIONS_VOLUME_ROOT } from './config.js';

const LOCAL_UPLOADS_ROOT = path.join(SESSIONS_VOLUME_ROOT, 'uploads');

// --- peta ekstensi file berdasarkan mimetype ---
function resolveExtensionFromMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  return 'bin';
}

// --- konversi string data url base64 menjadi buffer dan mimetype ---
export function decodeBase64DataUrl(rawDataUrl, maxBytes = 5 * 1024 * 1024) {
  const trimmed = String(rawDataUrl || '').trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (!dataUrlMatch) {
    throw new Error('Format media Base64 tidak valid.');
  }

  const mimeType = String(dataUrlMatch[1] || 'application/octet-stream').trim().toLowerCase();
  const binaryBuffer = Buffer.from(dataUrlMatch[2], 'base64');

  if (!binaryBuffer.length) {
    throw new Error('File media kosong.');
  }
  if (binaryBuffer.length > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
    throw new Error(`Ukuran file melebihi batas maksimal ${maxMb} MB.`);
  }

  return { mimeType, binaryBuffer };
}

// --- unggah buffer ke supabase storage dan kembalikan public url ---
export async function uploadMediaToSupabaseStorage({
  folder = 'stickers',
  ownerId = 'guest',
  dataUrl = '',
  maxBytes = 5 * 1024 * 1024
} = {}) {
  const { mimeType, binaryBuffer } = decodeBase64DataUrl(dataUrl, maxBytes);
  const safeFolder = String(folder || 'stickers').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeOwner = String(ownerId || 'guest').replace(/[^a-zA-Z0-9_-]/g, '');
  const extension = resolveExtensionFromMime(mimeType);
  const uniqueName = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${extension}`;
  const objectPath = `${safeFolder}/${safeOwner}/${uniqueName}`;

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supabaseKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
  ).trim();
  const bucketName = String(process.env.SUPABASE_STORAGE_BUCKET || 'xucore-media').trim();

  if (supabaseUrl && supabaseKey) {
    try {
      const uploadEndpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucketName)}/${objectPath}`;
      const uploadResponse = await fetch(uploadEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          apikey: supabaseKey,
          'Content-Type': mimeType,
          'x-upsert': 'true'
        },
        body: binaryBuffer
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text().catch(() => '');
        throw new Error(`Supabase HTTP ${uploadResponse.status}: ${errorText.slice(0, 120)}`);
      }

      const publicUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucketName)}/${objectPath}`;
      return {
        storage: 'supabase',
        url: publicUrl,
        mimeType,
        sizeBytes: binaryBuffer.length
      };
    } catch (supabaseError) {
      console.error(`[SUPABASE STORAGE WARN] Fallback ke volume lokal: ${supabaseError.message}`);
    }
  }

  // --- fallback penyimpanan volume lokal jika env supabase belum dikonfigurasi ---
  const targetDir = path.join(LOCAL_UPLOADS_ROOT, safeFolder, safeOwner);
  fs.mkdirSync(targetDir, { recursive: true });
  const localFilePath = path.join(targetDir, uniqueName);
  fs.writeFileSync(localFilePath, binaryBuffer);

  return {
    storage: 'local',
    url: `/api/uploads/${safeFolder}/${safeOwner}/${uniqueName}`,
    mimeType,
    sizeBytes: binaryBuffer.length
  };
}

// --- resolusi path aman untuk melayani file fallback dari volume lokal ---
export function resolveLocalUploadFilePath(folder, ownerId, fileName) {
  const safeFolder = String(folder || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeOwner = String(ownerId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeFile = path.basename(String(fileName || '')).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeFolder || !safeOwner || !safeFile) return null;

  const fullPath = path.resolve(LOCAL_UPLOADS_ROOT, safeFolder, safeOwner, safeFile);
  if (!fullPath.startsWith(`${path.resolve(LOCAL_UPLOADS_ROOT)}${path.sep}`)) {
    return null;
  }
  return fullPath;
}
