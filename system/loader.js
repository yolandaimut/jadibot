// --- loader modul dinamis dengan cache-busting timestamp ---
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

class Loader {
  constructor() {
    this.modules = new Map();
    this.watchedFiles = new Set();
  }

  async load(moduleName, fileRelativePath) {
    try {
      const absolutePath = path.resolve(process.cwd(), fileRelativePath);
      const imported = await import(`${pathToFileURL(absolutePath).href}?v=${Date.now()}`);
      this.modules.set(moduleName, imported.default || imported);
      return this.modules.get(moduleName);
    } catch (error) {
      console.error(`[LOADER] Gagal memuat [${moduleName}]:`, error.message);
      return null;
    }
  }

  async watch(moduleName, fileRelativePath) {
    await this.load(moduleName, fileRelativePath);
    if (this.watchedFiles.has(fileRelativePath)) return;
    this.watchedFiles.add(fileRelativePath);

    const absolutePath = path.resolve(process.cwd(), fileRelativePath);
    fs.watchFile(absolutePath, async () => {
      await this.load(moduleName, fileRelativePath);
    });
  }

  get(moduleName) {
    return this.modules.get(moduleName) || null;
  }
}

export default new Loader();
