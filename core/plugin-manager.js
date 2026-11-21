// --- manajer plugin rekursif multi-kategori, validator sintaks, dan hot-reload ---
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PLUGINS_ROOT_DIR, CONFIG } from './config.js';

const executeFileAsync = promisify(execFile);
const pluginModuleCache = new Map();

// --- deep-scan rekursif seluruh sub-folder kategori plugin di dalam volume ---
export function scanPluginFilesRecursive(baseDir = PLUGINS_ROOT_DIR, currentDir = baseDir) {
  if (!fs.existsSync(currentDir)) return [];

  const collectedFiles = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullEntryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectedFiles.push(...scanPluginFilesRecursive(baseDir, fullEntryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('.temp_')) {
      const relativePosixPath = path.relative(baseDir, fullEntryPath).split(path.sep).join('/');
      collectedFiles.push(relativePosixPath);
    }
  }

  return collectedFiles.sort((a, b) => a.localeCompare(b));
}

// --- validasi path relatif plugin multi-kategori dan cegah path traversal ---
export function resolveSafePluginPath(rawFileName) {
  const normalizedInput = String(rawFileName || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');

  if (!normalizedInput) return null;

  const rawSegments = normalizedInput.split('/').filter(Boolean);
  if (rawSegments.length === 0) return null;

  const cleanSegments = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const isLastSegment = index === rawSegments.length - 1;
    let segment = rawSegments[index].trim();

    if (segment === '.' || segment === '..') return null;

    if (isLastSegment) {
      segment = segment.replace(/\.js$/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!segment) return null;
      cleanSegments.push(`${segment}.js`);
    } else {
      segment = segment.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!segment) return null;
      cleanSegments.push(segment);
    }
  }

  const relativePath = cleanSegments.join('/');
  const resolvedRoot = path.resolve(PLUGINS_ROOT_DIR);
  const fullPath = path.resolve(resolvedRoot, ...cleanSegments);

  if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return {
    relativePath,
    fullPath,
    dirPath: path.dirname(fullPath),
    baseFileName: cleanSegments[cleanSegments.length - 1]
  };
}

// --- ambil daftar lengkap plugin beserta path relatif kategori untuk dashboard ide ---
export function getAvailablePluginsList() {
  const relativeFiles = scanPluginFilesRecursive(PLUGINS_ROOT_DIR);
  return relativeFiles.map((relativeFilePath) => {
    const fullPath = path.join(PLUGINS_ROOT_DIR, relativeFilePath);
    const codeContent = fs.readFileSync(fullPath, 'utf-8');
    const fileStat = fs.statSync(fullPath);
    const pathParts = relativeFilePath.split('/');

    return {
      fileName: relativeFilePath,
      category: pathParts.length > 1 ? pathParts[0] : 'root',
      codeContent,
      updatedAt: fileStat.mtimeMs
    };
  });
}

// --- buat plugin bawaan format objek di kategori info jika folder plugins kosong ---
export function initializeDefaultPlugin() {
  if (scanPluginFilesRecursive(PLUGINS_ROOT_DIR).length > 0) return;

  const infoCategoryDir = path.join(PLUGINS_ROOT_DIR, 'info');
  const defaultPluginPath = path.join(infoCategoryDir, 'core-commands.js');
  fs.mkdirSync(infoCategoryDir, { recursive: true });

  const defaultPluginCode = `// --- plugin default ---
export default {
  cmd: ['ping', 'status'],
  type: 'info',
  run: async (m, client, { botDatabase, cfg }) => {
    if (m.command === 'ping') {
      await m.reply(
        \`Pong! \${cfg.botName} Aktif.\\nPesan Masuk: \${botDatabase.totalMessagesReceived}\\nPesan Terkirim: \${botDatabase.totalMessagesSent}\\nUser Unik: \${botDatabase.uniqueUsers.length}\`
      );
      return;
    }

    if (m.command === 'status') {
      const uptimeSeconds = Math.floor((Date.now() - botDatabase.startTime) / 1000);
      await m.reply(
        \`[ \${cfg.botName.toUpperCase()} ]\\nDurasi Aktif: \${uptimeSeconds} detik\\nPublic Mode: \${botDatabase.settings.publicMode ? 'Aktif' : 'Nonaktif'}\`
      );
    }
  }
};
`;

  fs.writeFileSync(defaultPluginPath, defaultPluginCode, 'utf-8');
}

// --- ekstraksi nomor baris error untuk inspector live ide ---
function extractErrorLineDetails(rawErrorOutput, referenceFilePath) {
  const outputString = String(rawErrorOutput);
  let detectedLineNumber = null;

  for (const singleLine of outputString.split('\n')) {
    const lineMatch = singleLine.match(/:(\d+)(?::(\d+))?/);
    if (lineMatch && (singleLine.includes(referenceFilePath) || singleLine.includes('.js'))) {
      detectedLineNumber = parseInt(lineMatch[1], 10);
      break;
    }
  }

  return {
    lineNumber: detectedLineNumber,
    cleanedErrorText: outputString.replaceAll(referenceFilePath, 'plugin-module.js').trim()
  };
}

// --- muat modul plugin dengan cache-busting timestamp saat file berubah ---
export async function loadPluginModuleWithHotReload(relativePath, forceReload = false) {
  const fullPath = path.join(PLUGINS_ROOT_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    pluginModuleCache.delete(relativePath);
    return null;
  }

  const fileStat = fs.statSync(fullPath);
  const cachedEntry = pluginModuleCache.get(relativePath);

  if (!forceReload && cachedEntry && cachedEntry.mtimeMs === fileStat.mtimeMs) {
    return cachedEntry.module;
  }

  const freshModuleUrl = `${pathToFileURL(fullPath).href}?v=${Date.now()}`;
  const importedModule = await import(freshModuleUrl);

  pluginModuleCache.set(relativePath, {
    mtimeMs: fileStat.mtimeMs,
    module: importedModule
  });

  return importedModule;
}

// --- validasi sintaks dan struktur ekspor objek sebelum menulis ke volume ---
export async function validateAndSavePlugin(googleUserId, rawFileName, pluginSourceCode, emitLog) {
  const resolvedTarget = resolveSafePluginPath(rawFileName);
  if (!resolvedTarget) {
    return {
      isSuccess: false,
      errorType: 'ValidationError',
      lineNumber: 1,
      errorMessage: 'Nama file atau jalur kategori tidak valid. Contoh: maker/brat.js'
    };
  }

  fs.mkdirSync(resolvedTarget.dirPath, { recursive: true });
  const tempValidationName = `.temp_validate_${Date.now()}_${resolvedTarget.baseFileName}`;
  const tempValidationPath = path.join(resolvedTarget.dirPath, tempValidationName);

  try {
    fs.writeFileSync(tempValidationPath, pluginSourceCode, 'utf-8');

    try {
      await executeFileAsync(process.execPath, ['--check', tempValidationPath]);
    } catch (syntaxError) {
      const parsedDetails = extractErrorLineDetails(syntaxError.stderr || syntaxError.message, tempValidationPath);
      if (fs.existsSync(tempValidationPath)) fs.unlinkSync(tempValidationPath);
      return {
        isSuccess: false,
        errorType: 'SyntaxError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    try {
      const evaluatedModule = await import(`${pathToFileURL(tempValidationPath).href}?v=${Date.now()}`);
      const exportedPlugin = evaluatedModule.default;

      const isObjectPluginValid =
        exportedPlugin &&
        typeof exportedPlugin === 'object' &&
        typeof exportedPlugin.run === 'function' &&
        (
          (Array.isArray(exportedPlugin.cmd) && exportedPlugin.cmd.length > 0) ||
          (typeof exportedPlugin.cmd === 'string' && exportedPlugin.cmd.trim().length > 0) ||
          typeof exportedPlugin.before === 'function'
        );

      if (!isObjectPluginValid) {
        if (fs.existsSync(tempValidationPath)) fs.unlinkSync(tempValidationPath);
        return {
          isSuccess: false,
          errorType: 'StructureError',
          lineNumber: 1,
          errorMessage: 'Plugin wajib mengekspor objek valid: export default { cmd: ["perintah"], type: "kategori", run: async (m, client, ctx) => { ... } }'
        };
      }
    } catch (evaluationError) {
      const parsedDetails = extractErrorLineDetails(evaluationError.stack || evaluationError.message, tempValidationPath);
      if (fs.existsSync(tempValidationPath)) fs.unlinkSync(tempValidationPath);
      return {
        isSuccess: false,
        errorType: evaluationError.name || 'RuntimeEvaluationError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      };
    }

    fs.renameSync(tempValidationPath, resolvedTarget.fullPath);
    await loadPluginModuleWithHotReload(resolvedTarget.relativePath, true);
    emitLog(googleUserId, 'SUCCESS', `Plugin [${resolvedTarget.relativePath}] lulus uji & aktif (Hot-Reload).`);

    return {
      isSuccess: true,
      fileName: resolvedTarget.relativePath
    };
  } catch (systemError) {
    if (fs.existsSync(tempValidationPath)) fs.unlinkSync(tempValidationPath);
    return {
      isSuccess: false,
      errorType: 'FileSystemError',
      lineNumber: null,
      errorMessage: systemError.message
    };
  }
}

// --- bersihkan direktori kategori kosong setelah penghapusan plugin ---
function cleanupEmptyPluginParentDirs(startDirPath) {
  let currentDir = path.resolve(startDirPath);
  const rootDir = path.resolve(PLUGINS_ROOT_DIR);

  while (currentDir !== rootDir && currentDir.startsWith(`${rootDir}${path.sep}`)) {
    try {
      if (fs.readdirSync(currentDir).length === 0) {
        fs.rmdirSync(currentDir);
        currentDir = path.dirname(currentDir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

// --- hapus file plugin dari volume dan bersihkan cache memorinya ---
export function deletePluginFile(googleUserId, rawFileName, emitLog) {
  const resolvedTarget = resolveSafePluginPath(rawFileName);
  if (!resolvedTarget || !fs.existsSync(resolvedTarget.fullPath)) {
    return false;
  }

  fs.unlinkSync(resolvedTarget.fullPath);
  pluginModuleCache.delete(resolvedTarget.relativePath);
  cleanupEmptyPluginParentDirs(resolvedTarget.dirPath);
  emitLog(googleUserId, 'WARN', `Plugin [${resolvedTarget.relativePath}] dihapus.`);
  return true;
}

// --- dispatcher eksekusi plugin dengan pencocokan cmd, alias, limit, dan restrict ---
export async function executeDynamicPlugins({
  googleUserId,
  m,
  client,
  botDatabase,
  coreModules,
  io,
  emitLog
}) {
  const relativePluginFiles = scanPluginFilesRecursive(PLUGINS_ROOT_DIR);
  const incomingCommand = String(m.command || '').toLowerCase();

  const users = global.db?.users?.[m.sender] || null;
  const groups = m.isGc ? global.db?.groups?.[m.chat] || null : null;
  const setting = m.setting || {};
  const { date, time } =
    typeof coreModules.functions?.getCurrentTimeInZone === 'function'
      ? coreModules.functions.getCurrentTimeInZone('Asia/Jakarta')
      : { date: '', time: '' };

  const senderName = users?.name || m.pushname || 'User';
  const botName = setting.botName || CONFIG.platformName;
  const packname = (setting.packname || botName)
    .replaceAll('+date', date)
    .replaceAll('+time', time)
    .replaceAll('+name', senderName);
  const author = (setting.author || 'Surya Core')
    .replaceAll('+date', date)
    .replaceAll('+time', time)
    .replaceAll('+name', senderName);

  const executionContext = {
    cfg: {
      ...(coreModules.mapping?.cfg || CONFIG),
      botName,
      header: setting.header || CONFIG.header,
      footer: setting.footer || CONFIG.footer,
      isNoPrefix: setting.isNoPrefix ?? true,
      allowedPc: setting.allowedPc ?? true
    },
    func: coreModules.functions,
    extra: coreModules.extra,
    utils: coreModules.utils,
    store: coreModules.store,
    socket: coreModules.socket,
    multidb: coreModules.multidb,
    packname,
    author,
    users,
    groups,
    setting,
    date,
    time,
    quoted: m.quoted || m,
    botDatabase,
    googleUserId,
    isFromMe: m.fromMe,
    replyMessage: m.reply
  };

  for (const relativeFilePath of relativePluginFiles) {
    try {
      const plugin = await loadPluginModuleWithHotReload(relativeFilePath, false);
      const pluginObj = plugin?.default;
      if (!pluginObj || typeof pluginObj !== 'object') continue;

      if (typeof pluginObj.before === 'function') {
        const shouldStop = await pluginObj.before(m, client, executionContext);
        if (shouldStop === true) break;
      }

      if (pluginObj.cmd && incomingCommand) {
        const commandsArray = (Array.isArray(pluginObj.cmd) ? pluginObj.cmd : [pluginObj.cmd])
          .map((item) => String(item).toLowerCase());
        const aliasArray = Array.isArray(pluginObj.alias)
          ? pluginObj.alias.map((item) => String(item).toLowerCase())
          : [];

        if (!commandsArray.includes(incomingCommand) && !aliasArray.includes(incomingCommand)) {
          continue;
        }

        // --- filter kata terlarang jika plugin mengaktifkan restrict ---
        if (
          pluginObj.restrict &&
          m.text &&
          Array.isArray(setting.toxic) &&
          setting.toxic.length > 0 &&
          !m.isOwner &&
          !m.isPrem &&
          !m.fromMe
        ) {
          const toxicPattern = new RegExp(
            `\\b(${setting.toxic.map((w) => coreModules.functions.escapeRegExp(w)).join('|')})\\b`,
            'i'
          );
          if (toxicPattern.test(m.text)) {
            await m.reply('✗ Teks mengandung kata yang dilarang.');
            continue;
          }
        }

        // --- validasi dan pengurangan limit untuk user non-premium ---
        if (pluginObj.limit && users && !m.isOwner && !m.isDevs && !m.isPrem && !m.isVIP && !m.fromMe) {
          const limitCost = typeof pluginObj.limit === 'number' ? pluginObj.limit : 1;
          if ((users.limit || 0) < limitCost) {
            await m.reply('✗ Limit kamu habis! Tunggu reset harian atau upgrade premium.');
            continue;
          }
          users.limit -= limitCost;
        }

        if (typeof coreModules.functions?.addcommand === 'function') {
          coreModules.functions.addcommand(incomingCommand);
        }

        await pluginObj.run(m, client, executionContext);
      }
    } catch (runtimeError) {
      const fullPluginPath = path.join(PLUGINS_ROOT_DIR, relativeFilePath);
      const parsedDetails = extractErrorLineDetails(runtimeError.stack || runtimeError.message, fullPluginPath);

      emitLog(
        googleUserId,
        'ERROR',
        `Runtime Error di [${relativeFilePath}]${parsedDetails.lineNumber ? ` baris ${parsedDetails.lineNumber}` : ''}: ${runtimeError.message}`
      );

      io.to(`user_${googleUserId}`).emit('plugin:error', {
        fileName: relativeFilePath,
        errorType: runtimeError.name || 'RuntimeError',
        lineNumber: parsedDetails.lineNumber,
        errorMessage: parsedDetails.cleanedErrorText
      });
    }
  }
}

// --- pantau perubahan file plugin secara rekursif untuk hot-reload otomatis ---
export function watchPluginsDirectory(io) {
  let debounceTimer = null;
  try {
    fs.watch(PLUGINS_ROOT_DIR, { recursive: true }, (_eventType, changedFile) => {
      if (!changedFile || String(changedFile).includes('.temp_')) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const normalizedRelPath = String(changedFile).replaceAll('\\', '/');
        pluginModuleCache.delete(normalizedRelPath);
        io.emit('plugin:list', getAvailablePluginsList());
      }, 300);
    });
  } catch {
    // --- abaikan jika filesystem kontainer tidak mendukung recursive fs.watch ---
  }
}
