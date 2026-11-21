// --- registrasi route express anti-flicker, monitor cpu real-time, dan handler socket.io ---
import express from 'express';
import os from 'os';
import path from 'path';
import {
  GOOGLE_CLIENT_ID,
  PLUGINS_ROOT_DIR,
  PUBLIC_ROOT_DIR,
  SESSIONS_VOLUME_ROOT
} from './config.js';
import {
  clearSessionCookie,
  createSignedSessionToken,
  getSessionUserFromCookieHeader,
  setSessionCookie,
  verifyGoogleCredentialToken
} from './auth.js';
import {
  getGlobalPlatformStatistics,
  readBotDatabase,
  writeBotDatabaseAtomic
} from './database.js';
import {
  deletePluginFile,
  getAvailablePluginsList,
  validateAndSavePlugin
} from './plugin-manager.js';
import {
  activeBotSessions,
  destroyBotSession,
  emitTerminalLog,
  startWhatsAppSession,
  syncSessionStateToSocket
} from './session-manager.js';

let cpuMonitorInterval = null;

// --- ambil snapshot total dan idle tick cpu dari os ---
function getCpuTimesSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }

  return { idle, total };
}

// --- mulai broadcast utilisasi cpu asli setiap 1 detik ke dashboard ---
function startRealtimeCpuBroadcaster(io) {
  if (cpuMonitorInterval) return;

  let previousSnapshot = getCpuTimesSnapshot();

  cpuMonitorInterval = setInterval(() => {
    const currentSnapshot = getCpuTimesSnapshot();
    const idleDiff = currentSnapshot.idle - previousSnapshot.idle;
    const totalDiff = currentSnapshot.total - previousSnapshot.total;
    previousSnapshot = currentSnapshot;

    if (io.engine.clientsCount === 0) return;

    const rawUsage = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
    const usage = Math.max(0, Math.min(100, Math.round(rawUsage * 10) / 10));

    io.emit('cpu-update', {
      usage,
      cores: os.cpus().length,
      timestamp: Date.now()
    });
  }, 1000);

  cpuMonitorInterval.unref();
}

// --- pasang route halaman dan api autentikasi express ---
export function registerHttpRoutes(app) {
  app.get('/', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    return response.redirect(302, sessionUser ? '/dashboard' : '/login');
  });

  app.get(['/login', '/login.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (getSessionUserFromCookieHeader(request.headers.cookie)) {
      return response.redirect(302, '/dashboard');
    }
    return response.sendFile(path.join(PUBLIC_ROOT_DIR, 'login.html'));
  });

  app.get(['/dashboard', '/dashboard.html'], (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!getSessionUserFromCookieHeader(request.headers.cookie)) {
      return response.redirect(302, '/login');
    }
    return response.sendFile(path.join(PUBLIC_ROOT_DIR, 'dashboard.html'));
  });

  app.use(express.static(PUBLIC_ROOT_DIR, { index: false }));

  app.get('/api/auth/config', (request, response) => {
    response.status(200).json({
      googleClientId: GOOGLE_CLIENT_ID,
      volumePath: SESSIONS_VOLUME_ROOT,
      pluginsPath: PLUGINS_ROOT_DIR
    });
  });

  app.post('/api/auth/google', async (request, response) => {
    try {
      const verifiedUser = await verifyGoogleCredentialToken(request.body?.credential);
      setSessionCookie(request, response, createSignedSessionToken(verifiedUser));
      response.status(200).json({ isAuthenticated: true, user: verifiedUser });
    } catch (authError) {
      response.status(401).json({ isAuthenticated: false, errorMessage: authError.message });
    }
  });

  app.get('/api/auth/me', (request, response) => {
    const sessionUser = getSessionUserFromCookieHeader(request.headers.cookie);
    if (!sessionUser) return response.status(401).json({ isAuthenticated: false });
    return response.status(200).json({ isAuthenticated: true, user: sessionUser });
  });

  app.post('/api/auth/logout', (request, response) => {
    clearSessionCookie(request, response);
    response.status(200).json({ isLoggedOut: true });
  });

  app.get('/health', (request, response) => {
    response.status(200).json({
      status: 'ok',
      volumeRoot: SESSIONS_VOLUME_ROOT,
      pluginsRoot: PLUGINS_ROOT_DIR,
      uptime: process.uptime()
    });
  });
}

// --- pasang event listener socket.io terproteksi cookie sesi ---
export function registerSocketHandlers(io, coreModules) {
  const emitLog = (uid, level, msg) => emitTerminalLog(io, uid, level, msg);

  startRealtimeCpuBroadcaster(io);

  io.on('connection', (clientSocket) => {
    const sessionUser = getSessionUserFromCookieHeader(clientSocket.handshake.headers.cookie);

    if (!sessionUser) {
      clientSocket.emit('auth:expired', { errorMessage: 'Sesi login telah berakhir, silakan masuk kembali.' });
      clientSocket.disconnect(true);
      return;
    }

    const authenticatedGoogleId = sessionUser.googleId;
    clientSocket.join(`user_${authenticatedGoogleId}`);
    syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser);

    clientSocket.on('session:sync', () => {
      syncSessionStateToSocket(io, coreModules, clientSocket, sessionUser);
    });

    clientSocket.on('session:connect', async (payload) => {
      const method = payload?.method === 'pairing' ? 'pairing' : 'qr';
      const phoneNumber = payload?.phoneNumber || '';
      await startWhatsAppSession(io, coreModules, authenticatedGoogleId, method, phoneNumber, 1, true);
    });

    clientSocket.on('session:logout', async () => {
      await destroyBotSession(io, coreModules, authenticatedGoogleId, true);
    });

    clientSocket.on('settings:toggle', (payload) => {
      const settingKey = payload?.key;
      if (settingKey !== 'autoRead' && settingKey !== 'publicMode') return;

      const currentDatabase = readBotDatabase(authenticatedGoogleId);
      currentDatabase.settings[settingKey] = !currentDatabase.settings[settingKey];
      writeBotDatabaseAtomic(authenticatedGoogleId, currentDatabase);

      io.to(`user_${authenticatedGoogleId}`).emit('stats:update', {
        userStats: currentDatabase,
        globalStats: getGlobalPlatformStatistics(activeBotSessions)
      });
      emitLog(
        authenticatedGoogleId,
        'INFO',
        `Pengaturan [${settingKey}] diubah ke: ${currentDatabase.settings[settingKey] ? 'AKTIF' : 'NONAKTIF'}`
      );
    });

    clientSocket.on('plugin:save', async (payload) => {
      const { fileName, codeContent } = payload || {};
      emitLog(authenticatedGoogleId, 'INFO', `Menguji validitas sintaks plugin [${fileName}]...`);
      const validationResult = await validateAndSavePlugin(authenticatedGoogleId, fileName, codeContent, emitLog);

      if (validationResult.isSuccess) {
        io.emit('plugin:list', getAvailablePluginsList());
        clientSocket.emit('plugin:save:result', {
          isSuccess: true,
          fileName: validationResult.fileName
        });
      } else {
        emitLog(
          authenticatedGoogleId,
          'ERROR',
          `Validasi Gagal [${fileName}]: ${validationResult.errorType}${validationResult.lineNumber ? ` (Baris ${validationResult.lineNumber})` : ''}`
        );
        clientSocket.emit('plugin:save:result', {
          isSuccess: false,
          errorType: validationResult.errorType,
          lineNumber: validationResult.lineNumber,
          errorMessage: validationResult.errorMessage
        });
      }
    });

    clientSocket.on('plugin:delete', (payload) => {
      const deleted = deletePluginFile(authenticatedGoogleId, payload?.fileName, emitLog);
      if (deleted) {
        io.emit('plugin:list', getAvailablePluginsList());
      }
    });
  });
}
