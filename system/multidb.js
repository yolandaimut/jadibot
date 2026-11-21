// --- manajer database hibrida lokal volume dan redis opsional tanpa crash ---
import axios from 'axios';
import mapping from './mapping.js';
import LocalDB from './localdb.js';

class MultiDB {
  constructor() {
    this.dbInstance = new LocalDB();
    this.isSaving = false;
  }

  initDatabase = async () => {
    global.registered = global.registered || {};
    global.abcdata = global.abcdata || {};

    this.dbInstance = new LocalDB();
    let content = await this.dbInstance.read().catch(() => null);

    global.db = {
      users: {},
      groups: {},
      statistic: {},
      sticker: {},
      stickercmd: {},
      setting: {},
      menfes: {},
      tictactoe: {},
      petakbom: {},
      werewolf: {},
      casino: {},
      metadata: {},
      premium: {},
      sewabot: {},
      owner: [],
      developer: [],
      blockcmd: [],
      error: [],
      newsletter: {},
      pcstatus: {},
      reminder: {},
      respon: {},
      stickerwarn: [],
      antihack_cache: {},
      ai_memory: {},
      redeem: {},
      deposit: {},
      verification: {},
      ignored: [],
      ...(content || {})
    };

    Object.defineProperty(global.db, 'unoMap', {
      value: global.db.unoMap || {},
      enumerable: false,
      writable: true
    });

    await this.save();
  };

  save = async () => {
    if (!global.db || this.isSaving) return;
    this.isSaving = true;
    try {
      await this.dbInstance.save(global.db);
    } catch (error) {
      console.error(`[MULTIDB ERROR] Gagal menyimpan (${this.useRedis ? 'redis' : 'local'}):`, error.message);
    } finally {
      this.isSaving = false;
    }
  };
}

export default new MultiDB();