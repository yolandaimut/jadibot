// --- storage database lokal persisten di railway volume dengan atomic write ---
import fs from 'fs/promises';
import path from 'path';
import { SESSIONS_VOLUME_ROOT } from '../core/config.js';

export default class LocalDB {
  constructor() {
    this.file = path.join(SESSIONS_VOLUME_ROOT, 'surya-db.json');
    this.backupFile = path.join(SESSIONS_VOLUME_ROOT, 'surya-db.bak');
    this.tmpFile = path.join(SESSIONS_VOLUME_ROOT, 'surya-db.tmp');
    this._queue = Promise.resolve();
  }

  read = async () => {
    let database = {};
    try {
      const fileContent = await fs.readFile(this.file, 'utf-8');
      database = JSON.parse(fileContent);
    } catch {
      try {
        const backupContent = await fs.readFile(this.backupFile, 'utf-8');
        database = JSON.parse(backupContent);
        await fs.writeFile(this.file, JSON.stringify(database), 'utf-8');
      } catch {
        database = {};
        await this.save(database);
      }
    }
    return database;
  };

  save = (data) => {
    this._queue = this._queue.then(() => this._executeSave(data)).catch((err) => {
      console.error('[LOCALDB ERROR]', err.message);
    });
    return this._queue;
  };

  _executeSave = async (data) => {
    const dbData = data || global.db || {};
    const dirname = path.dirname(this.file);

    try {
      await fs.mkdir(dirname, { recursive: true });
      const jsonString = JSON.stringify(dbData);

      await fs.writeFile(this.tmpFile, jsonString, 'utf-8');
      await fs.rename(this.tmpFile, this.file);
      await fs.writeFile(this.backupFile, jsonString, 'utf-8');
    } catch (error) {
      console.error('[LOCALDB ERROR] Gagal menyimpan database:', error.message);
    }
    return this.file;
  };
}
