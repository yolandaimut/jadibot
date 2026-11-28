// --- utilitas unggah media dan stiker ke supabase storage dengan fallback volume aman ---
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SESSIONS_VOLUME_ROOT } from './config.js';

const LOCAL_UPLOADS_ROOT = path.join(SESSIONS_VOLUME_ROOT, 'uploads');
const SUPABASE_URL = "https://rxcvojhhtldbkhhnehwn.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4Y3ZvamhodGxkYmtoaG5laHduIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5NTc3MzM3MSwiZXhwIjoyMTExMzQ5MzcxfQ.XqJO3As164EEOxk6sUsXFgmbnhbi9xN2keXCsuPO2GY";
const SUPABASE_STORAGE_BUCKET = "xucore-media";

const supabaseUrl = String(SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseKey = String(SUPABASE_KEY || '').trim();
const bucketName = String(SUPABASE_STORAGE_BUCKET || 'xucore-media').trim();

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

// --- unggah buffer ke supabase storage menggunakan service_role jwt ---
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

  if (supabaseUrl && supabaseKey) {
    try {
      const uploadEndpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucketName)}/${objectPath}`;
      const requestHeaders = {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': mimeType,
        'x-upsert': 'true'
      };

      const uploadResponse = await fetch(uploadEndpoint, {
        method: 'POST',
        headers: requestHeaders,
        body: binaryBuffer
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text().catch(() => '');
        throw new Error(`Supabase HTTP ${uploadResponse.status}: ${errorText.slice(0, 180)}`);
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

  // --- fallback penyimpanan volume lokal jika unggah supabase gagal ---
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

// --- ekstrak object path dari public url supabase storage ---
function extractSupabaseObjectPath(rawUrl, supabaseUrl, bucketName) {
  const cleanUrl = String(rawUrl || '').trim().split('?')[0];
  const publicPrefix = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucketName)}/`;
  if (!cleanUrl.startsWith(publicPrefix)) return '';
  try {
    return decodeURIComponent(cleanUrl.slice(publicPrefix.length));
  } catch {
    return cleanUrl.slice(publicPrefix.length);
  }
}

// --- hapus satu atau banyak file media dari supabase storage dan fallback volume lokal ---
export async function deleteMediaFromSupabaseStorage(mediaUrls = []) {
  const rawList = Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls];
  const uniqueUrls = Array.from(
    new Set(rawList.map((item) => String(item || '').trim()).filter(Boolean))
  );
  if (uniqueUrls.length === 0) {
    return { deletedSupabase: 0, deletedLocal: 0 };
  }

  const supabasePrefixes = [];
  let deletedLocal = 0;

  for (const mediaUrl of uniqueUrls) {
    if (mediaUrl.startsWith('/api/uploads/')) {
      const pathParts = mediaUrl.replace(/^\/api\/uploads\//, '').split('/');
      if (pathParts.length === 3) {
        const localPath = resolveLocalUploadFilePath(pathParts[0], pathParts[1], pathParts[2]);
        if (localPath && fs.existsSync(localPath)) {
          try {
            fs.unlinkSync(localPath);
            deletedLocal += 1;
          } catch (localDelErr) {
            console.error(`[LOCAL MEDIA DELETE WARN] ${localDelErr.message}`);
          }
        }
      }
      continue;
    }

    if (supabaseUrl && bucketName) {
      const objectPath = extractSupabaseObjectPath(mediaUrl, supabaseUrl, bucketName);
      if (objectPath) supabasePrefixes.push(objectPath);
    }
  }

  let deletedSupabase = 0;
  if (supabasePrefixes.length > 0 && supabaseUrl && supabaseKey) {
    try {
      const deleteEndpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucketName)}`;
      const deleteResponse = await fetch(deleteEndpoint, {
        method: 'DELETE',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prefixes: supabasePrefixes })
      });

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text().catch(() => '');
        throw new Error(`Supabase DELETE HTTP ${deleteResponse.status}: ${errorText.slice(0, 180)}`);
      }
      deletedSupabase = supabasePrefixes.length;
    } catch (supabaseDelErr) {
      console.error(`[SUPABASE STORAGE DELETE WARN] ${supabaseDelErr.message}`);
    }
  }

  return { deletedSupabase, deletedLocal };
}
