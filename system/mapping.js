// --- cache berbasis ttl global dan state konfigurasi surya core ---
import fs from 'fs';
import os from 'os';
import path from 'path';

class SweepCache {
  static instances = [];
  static sweeperStarted = false;

  constructor(ttlMs = 60000) {
    this.cache = new Map();
    this.ttl = ttlMs;
    SweepCache.instances.push(this);

    if (!SweepCache.sweeperStarted) {
      SweepCache.sweeperStarted = true;
      setInterval(() => {
        const now = Date.now();
        for (const instance of SweepCache.instances) {
          for (const [key, time] of instance.cache.entries()) {
            if (now - time > instance.ttl) {
              instance.cache.delete(key);
            } else {
              break;
            }
          }
        }
      }, 10000).unref();
    }
  }

  add(key) {
    this.cache.set(key, Date.now());
    return this;
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  get size() {
    return this.cache.size;
  }

  clear() {
    this.cache.clear();
  }

  forEach(callbackFn, thisArg) {
    this.cache.forEach((_, key) => {
      callbackFn.call(thisArg, key, key, this);
    });
  }

  keys() {
    return this.cache.keys();
  }

  values() {
    return this.cache.keys();
  }

  entries() {
    const keys = this.cache.keys();
    function* generator() {
      for (const key of keys) {
        yield [key, key];
      }
    }
    return generator();
  }

  [Symbol.iterator]() {
    return this.values();
  }
}

// --- inisialisasi direktori sampah sementara untuk media dan stiker ---
const defaultTrashDir = path.join(os.tmpdir(), 'surya-core-trash');
fs.mkdirSync(defaultTrashDir, { recursive: true });

class Mapping {
  constructor() {
    this.retry = new Map();
    this.sessions = new Map();

    this.processedMessages = new SweepCache(300000);
    this.processedRevoke = new SweepCache(300000);
    this.statusReactionCache = new SweepCache(300000);

    // --- default konfigurasi agar serialize.js dan extra.js tidak pernah undefined ---
    const ownerNumber = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
    this.cfg = {
      botName: process.env.BOT_NAME || 'Surya Core',
      header: process.env.BOT_NAME || 'Surya Core',
      copyright: 'Surya Core Platform',
      owner: ownerNumber ? `${ownerNumber}@s.whatsapp.net` : '',
      devs: ownerNumber ? [`${ownerNumber}@s.whatsapp.net`] : [],
      prefixes: /^[.!\/#]/,
      isNoPrefix: false,
      allowedPc: true,
      useRedis: process.env.USE_REDIS === 'true',
      baileys: { button: false, online: true },
      pairing: { status: true, number: ownerNumber },
      id: {},
      path: { trash: defaultTrashDir }
    };

    this.plugins = {};
    this.detects = new Set();
    this.approvalData = new Map();
    this.timeoutApproval = null;

    this.processedAlarms = new Map();
    this.alarmLogs = new Map();
    this.sentAdzans = new Map();
    this.adzanLogs = new Map();
    this.siderLogs = new Map();

    this.anniversaryUnique = new Set();
    this.siderUnique = new Set();
    this.birthdayUnique = new Set();
    this.activeBotUsers = new Set();

    this.teleBotInstance = null;
    this.telePlugins = {};
    this.unoPacks = {};
    this.timeoutData = {};
  }
}

const mapping = new Mapping();

// --- interval simulasi harga pasar di global.db ---
export const startMarketInterval = () => {
  if (!global.db) {
    return setTimeout(startMarketInterval, 5000);
  }

  if (!global.db.market) {
    global.db.market = {
      goldPrice: 1500000,
      trend: 'up',
      history: [1500000]
    };
  }

  setInterval(() => {
    const market = global.db.market;
    const isUp = market.trend === 'up';
    const moveUp = Math.random() < (isUp ? 0.6 : 0.4);
    const percentChange = Math.random() * 1.5 + 0.5;
    const multiplier = moveUp ? 1 + percentChange / 100 : 1 - percentChange / 100;

    let newPrice = Math.floor(market.goldPrice * multiplier);
    if (newPrice < 500000) newPrice = 500000;
    if (newPrice > 3000000) newPrice = 3000000;

    market.goldPrice = newPrice;
    market.trend = moveUp ? 'up' : 'down';
    market.history.push(market.goldPrice);
    if (market.history.length > 5) market.history.shift();
  }, 5 * 60 * 1000).unref();
};

export default mapping;

export const {
  cfg,
  plugins,
  retry,
  sessions,
  processedMessages,
  processedRevoke,
  statusReactionCache,
  detects,
  approvalData,
  timeoutApproval,
  processedAlarms,
  alarmLogs,
  sentAdzans,
  adzanLogs,
  siderLogs,
  anniversaryUnique,
  siderUnique,
  birthdayUnique,
  activeBotUsers,
  teleBotInstance,
  telePlugins,
  unoPacks,
  timeoutData
} = mapping;

export { SweepCache };
