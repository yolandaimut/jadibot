// --- manajemen autentikasi google oauth 2.0 dan cookie sesi httponly 30 hari ---
import crypto from 'crypto';
import fs from 'fs';
import { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CLIENT_ID,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_SECRET_PATH
} from './config.js';

const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- muat atau buat secret penanda sesi persisten di dalam volume ---
function resolvePersistentSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }

  try {
    if (fs.existsSync(SESSION_SECRET_PATH)) {
      const existingSecret = fs.readFileSync(SESSION_SECRET_PATH, 'utf-8').trim();
      if (existingSecret.length >= 32) {
        return existingSecret;
      }
    }
    const generatedSecret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SESSION_SECRET_PATH, generatedSecret, 'utf-8');
    return generatedSecret;
  } catch {
    return crypto.createHash('sha256').update(`${GOOGLE_CLIENT_ID}_surya_core`).digest('hex');
  }
}

const SESSION_SIGNING_SECRET = resolvePersistentSessionSecret();

// --- parsing header cookie mentah menjadi objek ---
export function parseCookieHeader(rawCookieHeader) {
  const cookiesMap = {};
  if (!rawCookieHeader || typeof rawCookieHeader !== 'string') {
    return cookiesMap;
  }

  for (const pair of rawCookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!key) continue;
    try {
      cookiesMap[key] = decodeURIComponent(rawValue);
    } catch {
      cookiesMap[key] = rawValue;
    }
  }

  return cookiesMap;
}

// --- buat token sesi bertanda tangan hmac-sha256 ---
export function createSignedSessionToken(userPayload) {
  const sessionData = {
    googleId: userPayload.googleId,
    email: userPayload.email,
    fullName: userPayload.fullName,
    givenName: userPayload.givenName,
    pictureUrl: userPayload.pictureUrl,
    iat: Date.now(),
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  };

  const encodedPayload = Buffer.from(JSON.stringify(sessionData), 'utf-8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

// --- verifikasi integritas dan masa berlaku token sesi ---
export function verifySignedSessionToken(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return null;

  const tokenParts = sessionToken.split('.');
  if (tokenParts.length !== 2) return null;

  const [encodedPayload, providedSignature] = tokenParts;
  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(encodedPayload)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decodedJson = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8'));
    if (!decodedJson?.googleId || !decodedJson?.exp || Date.now() >= decodedJson.exp) {
      return null;
    }
    return decodedJson;
  } catch {
    return null;
  }
}

export function getSessionUserFromCookieHeader(rawCookieHeader) {
  const cookiesMap = parseCookieHeader(rawCookieHeader);
  return verifySignedSessionToken(cookiesMap[SESSION_COOKIE_NAME]);
}

export function setSessionCookie(request, response, sessionToken) {
  const isHttps = request.secure || request.headers['x-forwarded-proto'] === 'https';
  const cookieDirectives = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];
  if (isHttps) cookieDirectives.push('Secure');
  response.setHeader('Set-Cookie', cookieDirectives.join('; '));
}

export function clearSessionCookie(request, response) {
  const isHttps = request.secure || request.headers['x-forwarded-proto'] === 'https';
  const cookieDirectives = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isHttps) cookieDirectives.push('Secure');
  response.setHeader('Set-Cookie', cookieDirectives.join('; '));
}

// --- verifikasi jwt id token dari google identity services ---
export async function verifyGoogleCredentialToken(idTokenString) {
  if (!idTokenString || typeof idTokenString !== 'string') {
    throw new Error('Token kredensial Google tidak ditemukan.');
  }

  try {
    const verificationOptions = { idToken: idTokenString };
    if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
      verificationOptions.audience = GOOGLE_CLIENT_ID;
    }

    const ticket = await googleOAuthClient.verifyIdToken(verificationOptions);
    const payload = ticket.getPayload();

    if (!payload?.sub) {
      throw new Error('Payload akun Google tidak valid.');
    }

    return {
      googleId: String(payload.sub).replace(/[^a-zA-Z0-9_-]/g, ''),
      email: payload.email || '',
      fullName: payload.name || 'Google User',
      givenName: payload.given_name || payload.name?.split(' ')[0] || 'User',
      pictureUrl: payload.picture || ''
    };
  } catch (verificationError) {
    throw new Error(`Verifikasi Google OAuth gagal: ${verificationError.message}`);
  }
}
