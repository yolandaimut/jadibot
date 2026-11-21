// --- muat seluruh modul sistem surya core dari folder system/ ---
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
    { key: 'database', file: 'database.js' },
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

// --- jalankan bootstrap surya core beserta inisialisasi multidb ---
async function bootstrapSuryaCore() {
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
    console.log(`[SURYA CORE] Aktif di port ${SERVER_PORT} | Volume: ${SESSIONS_VOLUME_ROOT} | Plugins: ${PLUGINS_ROOT_DIR}`);
    restoreExistingSessionsOnBoot(io, coreModules);
  });
}
