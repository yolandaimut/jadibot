// --- entry point utama xu core platform ---
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  PLUGINS_ROOT_DIR,
  SERVER_PORT,
  SESSIONS_VOLUME_ROOT,
  SYSTEM_ROOT_DIR,
  initPersistentDirectories
} from './core/config.js';
import { initializeDefaultPlugin, watchPluginsDirectory } from './core/plugin-manager.js';
import { restoreExistingSessionsOnBoot } from './core/session-manager.js';
import { registerHttpRoutes, registerSocketHandlers } from './core/socket-routes.js';
import { startAutoBackupWorker } from './core/auto-backup.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- perbesar batas body json dan urlencoded untuk unggahan media base64 ---
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// --- daftar rute halaman html dan pola user-agent klien otomatis ---
// --- daftar rute halaman html dan pola user-agent klien otomatis ---
const PROTECTED_HTML_PATHS = new Set([
  '/',
  '/login',
  '/dashboard',
  '/chat',
  '/admin',
  '/sewa-beli-paket',
  '/dokumentasi',
  '/tutorial',
  '/terms-of-service',
  '/privacy-policy'
]);

const AUTOMATED_CLIENT_UA_REGEX = /(axios|curl|wget|node-fetch|undici|got\/|python|requests|httpx|aiohttp|postman|insomnia|httpie|scrapy|okhttp|go-http-client|java\/|libwww|headless|puppeteer|playwright|phantomjs)/i;

// --- middleware anti-scraping untuk memblokir axios, curl, dan fetch pada semua rute html ---
function htmlAntiScrapingGuard(req, res, next) {
  const reqPath = String(req.path || '').toLowerCase();
  const isDirectHtmlFile = reqPath.endsWith('.html') || reqPath.endsWith('.htm');
  const isHtmlPageRoute = PROTECTED_HTML_PATHS.has(reqPath) || isDirectHtmlFile;

  if (!isHtmlPageRoute) return next();

  // --- blokir akses langsung ke file .html agar tidak bisa bypass middleware rute ---
  if (isDirectHtmlFile) {
    return res.status(403).type('text/plain').send('403 Forbidden');
  }

  const userAgent = String(req.headers['user-agent'] || '').trim();
  const acceptHeader = String(req.headers['accept'] || '').toLowerCase();
  const acceptLang = String(req.headers['accept-language'] || '').trim();
  const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
  const secFetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const requestedWith = String(req.headers['x-requested-with'] || '').trim();

  const isAutomatedUa = !userAgent || AUTOMATED_CLIENT_UA_REGEX.test(userAgent) || !userAgent.includes('Mozilla/');
  const isMissingHtmlAccept = !acceptHeader.includes('text/html');
  const isInvalidFetchHeaders = secFetchMode !== 'navigate' || secFetchDest !== 'document';
  const isAjaxRequest = Boolean(requestedWith);

  if (isAutomatedUa || isMissingHtmlAccept || !acceptLang || isInvalidFetchHeaders || isAjaxRequest) {
    return res.status(403).type('text/plain').send('403 Forbidden: Browser navigation required.');
  }

  // --- cegah browser menyimpan cache halaman html setelah logout ---
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return next();
}

app.use(htmlAntiScrapingGuard);

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// --- muat seluruh modul sistem xu core dari folder system/ ---
async function loadSystemCoreModules() {
  const loadedModules = {
    serialize: null,
    functions: {},
    extra: null,
    utils: {},
    store: null,
    socket: null,
    multidb: null,
    metadata: null,
    lid: null,
    database: null,
    mapping: null
  };

  const moduleSpecs = [
    { key: 'mapping', file: 'mapping.js' },
    { key: 'serialize', file: 'serialize.js' },
    { key: 'functions', file: 'functions.js' },
    { key: 'extra', file: 'extra.js' },
    { key: 'utils', file: 'utils.js' },
    { key: 'store', file: 'store.js' },
    { key: 'socket', file: 'socket.js' },
    { key: 'multidb', file: 'multidb.js' },
    { key: 'metadata', file: 'metadata.js' },
    { key: 'lid', file: 'lid.js' },
    { key: 'database', file: 'database.js' }
  ];

  for (const spec of moduleSpecs) {
    const targetPath = path.join(SYSTEM_ROOT_DIR, spec.file);
    if (!fs.existsSync(targetPath)) continue;

    try {
      const imported = await import(`${pathToFileURL(targetPath).href}?v=${Date.now()}`);
      const exported = imported.default || imported;
      loadedModules[spec.key] = spec.key === 'extra' && typeof exported === 'function' ? new exported() : exported;
    } catch (loadError) {
      console.error(`[SYSTEM WARN] Gagal memuat system/${spec.file}: ${loadError.message}`);
    }
  }

  if (loadedModules.extra && typeof loadedModules.extra.registerPrototype === 'function') {
    loadedModules.extra.registerPrototype();
  }

  return loadedModules;
}

// --- jalankan bootstrap xu core beserta inisialisasi multidb ---
async function bootstrap() {
  initPersistentDirectories();
  const coreModules = await loadSystemCoreModules();

  if (coreModules.multidb && typeof coreModules.multidb.initDatabase === 'function') {
    await coreModules.multidb.initDatabase();
    setInterval(() => coreModules.multidb.save(), 60000).unref();
  }

  initializeDefaultPlugin();
  watchPluginsDirectory(io);
  registerHttpRoutes(app);
  registerSocketHandlers(io, coreModules);

  httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`[XU CORE] Aktif di port ${SERVER_PORT} | Volume: ${SESSIONS_VOLUME_ROOT} | Plugins: ${PLUGINS_ROOT_DIR}`);
    restoreExistingSessionsOnBoot(io, coreModules);
    startAutoBackupWorker();
  });
}

bootstrap();