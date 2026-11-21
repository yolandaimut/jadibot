// --- kumpulan utilitas terpadu surya core tanpa fungsi backup lokal ---
import fs from 'fs';
import { promises as fsp } from 'fs';
import chalk from 'chalk';
import ms from 'parse-ms';
import path from 'path';
import util from 'util';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import crypto from 'crypto';
import moment from 'moment-timezone';
import performanceNow from 'performance-now';
import retry from 'async-retry';
import FormData from 'form-data';
import sharp from 'sharp';
import pkg from 'file-type';
import mapping from './mapping.js';
import { SESSIONS_VOLUME_ROOT } from '../core/config.js';

const { fromBuffer } = pkg;
const LOGS_DIR = path.join(SESSIONS_VOLUME_ROOT, 'logs');

class Function {
  readmore = String.fromCharCode(8206).repeat(4001);

  // --- pencatatan log ke berkas di dalam volume railway ---
  logFile = async (log, filename = 'bot') => {
    let logString;
    if (log === null || log === undefined) {
      logString = String(log);
    } else if (typeof log === 'object') {
      try {
        logString = JSON.stringify(log, null, 2);
      } catch (err) {
        logString = `[Unserializable: ${err.message}] ${String(log)}`;
      }
    } else {
      logString = String(log);
    }

    try {
      await fsp.mkdir(LOGS_DIR, { recursive: true });
      const logfilePath = path.join(LOGS_DIR, `${filename}.log`);
      await fsp.appendFile(logfilePath, `[${moment().format('DD/MM/YY HH:mm:ss')}] - ${logString}\n`);
    } catch (error) {
      console.error(`[LOGFILE ERROR] ${filename}.log:`, error.message);
    }
  };

  logAndWrite = (logName, content, warna = 'green') => {
    const timeLabel = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date());

    let displayContent;
    let fileContent;

    if (content === null || content === undefined) {
      displayContent = String(content);
      fileContent = displayContent;
    } else if (typeof content === 'object') {
      try {
        fileContent = JSON.stringify(content, null, 2);
        displayContent = JSON.stringify(content);
      } catch {
        displayContent = String(content);
        fileContent = displayContent;
      }
    } else {
      displayContent = String(content);
      fileContent = displayContent;
    }

    const trimmedDisplay = displayContent.trim();
    if (!trimmedDisplay) return;

    const colorMap = {
      green: chalk.greenBright,
      red: chalk.redBright,
      blue: chalk.blueBright,
      yellow: chalk.yellowBright,
      purple: chalk.magentaBright,
      cyan: chalk.cyanBright
    };
    const colorizer = colorMap[warna.toLowerCase()] || chalk.greenBright;

    console.log(`${chalk.cyan(`[${timeLabel}]`)} ${chalk.yellow(logName)}: ${colorizer(trimmedDisplay)}`);
    this.logFile(fileContent, logName).catch(() => {});
  };

  checkError = (err) => {
    const e = String(err);
    const ignoredKeywords = [
      'rate-overlimit',
      'internal-server-error',
      'this.isZero',
      'Connection Closed',
      'Timed Out',
      'Value not found',
      'service-unavailable',
      'Maximum call stack size exceeded'
    ];
    this.logFile(util.format(err), 'error').catch(() => {});
    return ignoredKeywords.some((keyword) => e.includes(keyword));
  };

  // --- pemformatan angka, ukuran file, dan waktu ---
  rupiah = (x) => {
    let str = String(x ?? 0);
    const pattern = /(-?\d+)(\d{3})/;
    while (pattern.test(str)) {
      str = str.replace(pattern, '$1.$2');
    }
    return str;
  };

  toRupiah = (angka) => this.rupiah(angka);

  formatNumber = (integer) => Number(parseInt(integer, 10) || 0).toLocaleString('id-ID');

  formatSize = (bytes, decimals = 2) => {
    const num = Number(bytes) || 0;
    if (num === 0) return '0 Bytes';
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    const i = Math.floor(Math.log(num) / Math.log(1024));
    return `${parseFloat((num / Math.pow(1024, i)).toFixed(dm))} ${sizes[i]}`;
  };

  sizeString = (bytes, des = 2) => this.formatSize(bytes, des);
  bytesToSize = (bytes, decimals = 2) => this.formatSize(bytes, decimals);
  fileSize = (bytes) => this.formatSize(bytes, 1);

  h2k = (number) => {
    const postfixes = ['', ' Ribu', ' Juta', ' Miliar', ' Triliun', ' P', ' E'];
    const tier = (Math.log10(Math.abs(number)) / 3) | 0;
    if (tier === 0) return number;
    const scaled = number / Math.pow(10, tier * 3);
    return `${scaled.toFixed(1).replace(/\.0$/, '')}${postfixes[tier]}`;
  };

  sizeLimit = (str, max) => {
    const matches = String(str).match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)/i);
    if (!matches) return { oversize: false, msg: 'Invalid size format' };

    const value = parseFloat(matches[1]);
    const unit = matches[2].toUpperCase();
    const factorMap = {
      B: 1 / (1024 * 1024),
      KB: 1 / 1024,
      MB: 1,
      GB: 1024,
      TB: 1024 * 1024
    };
    const sizeInMB = value * (factorMap[unit] || 0);

    if (sizeInMB > max) {
      return { oversize: true, msg: `Size ${str} melebihi batas ${max} MB` };
    }
    return { oversize: false };
  };

  getSize = async (str) => {
    if (!isNaN(str)) return this.formatSize(str);
    try {
      const response = await axios.head(str);
      const contentLength = response.headers['content-length'];
      return this.formatSize(contentLength ? parseInt(contentLength, 10) : 0);
    } catch {
      return 'Unknown Size';
    }
  };

  getCurrentTimeInZone = (timeZone) => {
    const validZones = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
    const resolvedZone = validZones.includes(timeZone) ? timeZone : 'Asia/Jakarta';
    const date = moment.tz(resolvedZone);
    const zoneLabel = resolvedZone === 'Asia/Makassar' ? 'WITA' : resolvedZone === 'Asia/Jayapura' ? 'WIT' : 'WIB';

    return {
      date: `${date.format('dddd')}, ${date.format('DD MMMM YYYY')}`,
      time: `${date.format('HH:mm')} ${zoneLabel}`
    };
  };

  getAgeFromDate = (userBirthday) => {
    const parts = String(userBirthday || '').split('/');
    if (parts.length < 3) return 'invalid birthday date';
    const [day, month, year] = parts.map(Number);
    const date = new Date(year, month - 1, day);
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const months = today.getMonth() - date.getMonth();
    if (months < 0 || (months === 0 && today.getDate() < date.getDate())) age -= 1;
    return age;
  };

  expiration = (duration) => {
    return duration === 7776000
      ? 7776000
      : duration === 604800
        ? 604800
        : duration === 86400
          ? 86400
          : duration === 0
            ? 0
            : 86400;
  };

  formatDuration = (duration) => {
    if (!duration) return '30 days';
    if (duration.endsWith('y')) return duration.replace(/y/gi, ' years');
    if (duration.endsWith('d')) return duration.replace(/d/gi, ' days');
    if (duration.endsWith('h')) return duration.replace(/h/gi, ' hours');
    if (duration.endsWith('m')) return duration.replace(/m/gi, ' minutes');
    if (duration.endsWith('s')) return duration.replace(/s/gi, ' seconds');
    return duration;
  };

  afkTime = (msVal) => {
    if (isNaN(msVal)) return '--';
    const d = Math.floor(msVal / 86400000);
    const h = Math.floor(msVal / 3600000) % 24;
    const m = Math.floor(msVal / 60000) % 60;
    const s = Math.floor(msVal / 1000) % 60;
    return `${d > 0 ? `${d} hari, ` : ''}${h > 0 ? `${h} jam, ` : ''}${m > 0 ? `${m} menit, ` : ''}${s > 0 ? `${s} detik` : ''}`.trim();
  };

  expireTime = (time) => {
    const cek = ms(time - Date.now());
    return `${cek.days} hari ${cek.hours} jam ${cek.minutes} menit ${cek.seconds} detik`;
  };

  toTime = (time) => {
    const cek = ms(time);
    return `${cek.days ? `${cek.days} hari, ` : ''}${cek.hours ? `${cek.hours} jam, ` : ''}${cek.minutes ? `${cek.minutes} menit, ` : ''}${cek.seconds ? `${cek.seconds} detik` : ''}`.trim();
  };

  timeReverse = (duration) => {
    const cek = ms(duration - Date.now());
    return `${cek.days}D ${cek.hours}H ${cek.minutes}M ${cek.seconds}S`;
  };

  toDate = (msVal) => {
    const days = Math.floor(msVal / 86400000);
    const hours = Math.floor((msVal % 86400000) / 3600000);
    const minutes = Math.floor((msVal % 3600000) / 60000);
    return days === 0 && hours === 0 && minutes === 0 ? 'Baru-baru ini' : `${days}D ${hours}H ${minutes}M`;
  };

  clockString = (msVal) => {
    const h = isNaN(msVal) ? '--' : Math.floor(msVal / 3600000);
    const m = isNaN(msVal) ? '--' : Math.floor(msVal / 60000) % 60;
    const s = isNaN(msVal) ? '--' : Math.floor(msVal / 1000) % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
  };

  msToTime = (msVal) => this.clockString(msVal);

  runtime = (seconds) => this.afkTime(Number(seconds) * 1000);

  countdown = (tanggal, bulan, tahun) => {
    const distance = new Date(`${bulan} ${tanggal}, ${tahun} 00:00:00`).getTime() - Date.now();
    const days = Math.floor(distance / 86400000);
    const hours = Math.floor((distance % 86400000) / 3600000);
    const minutes = Math.floor((distance % 3600000) / 60000);
    const seconds = Math.floor((distance % 60000) / 1000);
    return `${days} hari ${hours} jam ${minutes} menit ${seconds} detik`;
  };

  // --- utilitas pesan, teks, dan helper bot ---
  messageId = (length = 6) => `SURYA${crypto.randomBytes(length).toString('hex').toUpperCase()}`;
  uuid = () => crypto.randomUUID();
  delay = (msVal) => new Promise((res) => setTimeout(res, msVal));
  wa = (number) => `${String(number || '').replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  tag = (number) => `@${this.wa(number).replace(/@.+/, '')}`;
  example = (command, query) => `_Example :_ ${command} ${query}`;
  escapeRegExp = (string) => String(string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  isUrl = (url) => String(url || '').match(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%.+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%+.~#?&/=]*)/gi);
  isNumber = (number) => {
    if (!number) return false;
    const parsed = parseInt(number, 10);
    return typeof parsed === 'number' && !isNaN(parsed);
  };
  somematch = (data, id) => Array.isArray(data) && data.includes(id);
  pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
  findAdmin = (arr) => (Array.isArray(arr) ? arr.filter((v) => v.admin !== null).map((i) => i.id) : []);
  enumGetKey = (a) => a.jid;
  arrayJoin = (arr) => arr.reduce((acc, item) => acc.concat(item), []);
  removeDuplicateLetters = (array) => array.map((word) => word.replace(/(.)\1+/g, '$1'));
  ucword = (str) => String(str || '').replace(/^([a-z])|\s+([a-z])/g, (text) => text.toUpperCase());
  toFirstCase = (str) => this.ucword(str);
  filename = (ext) => `${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
  color = (text, color) => chalk.keyword(color || 'green').bold(text);
  bgcolor = (text, bgcolor) => (!bgcolor ? chalk.green(text) : chalk.bgKeyword(bgcolor)(text));
  getDevice = (id) => (id.length > 21 ? 'Android' : id.substring(0, 2) === '3A' ? 'IOS' : 'WhatsApp Web');

  ranNumb = (min, max = null) => {
    if (max !== null) {
      const low = Math.ceil(min);
      const high = Math.floor(max);
      return Math.floor(Math.random() * (high - low + 1)) + low;
    }
    return Math.floor(Math.random() * min) + 1;
  };

  randomNomor = (min, max = null) => this.ranNumb(min, max);
  hadiah = (reward) => this.ranNumb(reward?.min || 1000, reward?.max || 3000);

  makeid = (length) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i += 1) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  texted = (type, text) => {
    if (type === 'bold') return `*${text}*`;
    if (type === 'italic') return `_${text}_`;
    if (type === 'monospace') return `\`\`\`${text}\`\`\` `;
    return text;
  };

  createClue = (word = '') => {
    let clue = '';
    for (let i = 0; i < word.length; i += 1) {
      clue += i % 2 === 0 ? word[i] : '-';
    }
    return this.texted('monospace', clue);
  };

  jsonFormat = (obj) => {
    try {
      return obj && (obj.constructor?.name === 'Object' || obj.constructor?.name === 'Array')
        ? util.format(JSON.stringify(obj, null, 2))
        : util.format(obj);
    } catch {
      return util.format(obj);
    }
  };

  ping = (length = 4) => {
    const start = performanceNow();
    return (performanceNow() - start).toFixed(length);
  };

  ceklimit = (jid, limit = 1) => {
    const users = global.db?.users?.[jid];
    if (users && users.limit < limit && !users.premium) return true;
    if (users) users.limit -= limit;
    return false;
  };

  totalFeature = (plugins) => {
    let totalUsage = 0;
    for (const key in plugins) {
      const cmd = plugins[key]?.cmd;
      if (Array.isArray(cmd)) totalUsage += cmd.length;
      else if (typeof cmd === 'string') totalUsage += 1;
    }
    return totalUsage;
  };

  addcommand = (cmd) => {
    if (/bot|test/.test(cmd)) return;
    global.db = global.db || {};
    global.db.statistic = global.db.statistic || {};
    if (!global.db.statistic[cmd]) {
      global.db.statistic[cmd] = { name: cmd, hit: 1, hittoday: 1, lastused: Date.now() };
    } else {
      global.db.statistic[cmd].hittoday += 1;
      global.db.statistic[cmd].hit += 1;
      global.db.statistic[cmd].lastused = Date.now();
    }
  };

  removeEmptyObjects = (currentData, key) => {
    const filteredData = {};
    for (const obj of Object.values(currentData).filter((item) => Object.keys(item).length > 0)) {
      if (typeof obj[key] === 'undefined') continue;
      filteredData[obj[key]] = obj;
    }
    return filteredData;
  };

  removeDirSync = (dirPath) => {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  };

  copyDirSync = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const item of fs.readdirSync(source)) {
      const srcPath = path.join(source, item);
      const destPath = path.join(target, item);
      if (fs.lstatSync(srcPath).isDirectory()) this.copyDirSync(srcPath, destPath);
      else fs.copyFileSync(srcPath, destPath);
    }
  };

  formatBotName = () => {
    const raw = (mapping.cfg?.botName || 'Surya Core').split(' ').shift().replace(/bot/gi, '') || 'Surya';
    return this.ucword(raw.trim());
  };

  fstatus = (text = '') => ({
    key: { fromMe: false, remoteJid: 'status@broadcast', participant: '0@s.whatsapp.net' },
    message: { extendedTextMessage: { text } }
  });

  fverified = (name) => ({
    key: { participant: '0@s.whatsapp.net', remoteJid: '0@s.whatsapp.net' },
    message: { conversation: `${name ?? this.formatBotName()} Verified by WhatsApp` }
  });

  ftroli = (text = '', thumb) => ({
    key: { fromMe: false, remoteJid: 'status@broadcast', participant: '0@s.whatsapp.net' },
    message: {
      orderMessage: {
        itemCount: 1000000,
        status: 1,
        surface: 1,
        message: text,
        orderTitle: 'Surya Core',
        thumbnail: thumb,
        sellerJid: '0@s.whatsapp.net'
      }
    }
  });

  removeEmojis = (string) => {
    const regex = /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])/g;
    return String(string || '').replace(regex, '');
  };

  isEmoji = (emo) => {
    const regex = /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])/gi;
    return String(emo || '').match(regex);
  };

  // --- pencocokan kemiripan perintah berbasis levenshtein ---
  matcher = (string, array, options) => {
    const levenshtein = (value, other, insensitive) => {
      if (value === other) return 0;
      const length = value.length;
      const lengthOther = other.length;
      if (length === 0) return lengthOther;
      if (lengthOther === 0) return length;

      const a = insensitive ? value.toLowerCase() : value;
      const b = insensitive ? other.toLowerCase() : other;
      const cache = [];
      const codes = [];

      for (let i = 0; i < length; i += 1) {
        codes[i] = a.charCodeAt(i);
        cache[i] = i + 1;
      }

      let result = 0;
      for (let j = 0; j < lengthOther; j += 1) {
        const code = b.charCodeAt(j);
        let distance = j;
        result = j + 1;
        for (let i = 0; i < length; i += 1) {
          const distanceOther = code === codes[i] ? distance : distance + 1;
          distance = cache[i];
          cache[i] = result =
            distance > result
              ? distanceOther > result ? result + 1 : distanceOther
              : distanceOther > distance ? distance + 1 : distanceOther;
        }
      }
      return result;
    };

    const insensitive = !(options || {}).sensitive;
    const list = Array.isArray(array) ? array : [array];
    return list
      .map((v) => {
        const left = string || '';
        const right = v || '';
        const longest = Math.max(left.length, right.length);
        const accuracy = longest === 0 ? 100 : ((longest - levenshtein(left, right, insensitive)) / longest) * 100;
        return { string: v, accuracy: parseFloat(accuracy.toFixed(1)) };
      })
      .sort((a, b) => b.accuracy - a.accuracy);
  };

  // --- utilitas jaringan, media sharp, dan uploader ---
  mimeToExt = (mimeType) => {
    if (!mimeType || typeof mimeType !== 'string') return null;
    const mimeMap = {
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/csv': 'csv',
      'image/jpeg': 'jpeg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'application/json': 'json',
      'application/zip': 'zip',
      'application/octet-stream': 'bin'
    };
    return mimeMap[mimeType.toLowerCase().trim()] || mimeType.split('/')[1] || null;
  };

  getExt = async (buffer) => {
    try {
      const { ext } = (await fromBuffer(buffer)) || { ext: 'txt' };
      return ext;
    } catch {
      return 'txt';
    }
  };

  fetchText = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    return await response.text();
  };

  fetchJson = async (url, options = {}) => {
    try {
      const res = await axios({
        method: 'GET',
        url,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        ...options
      });
      return res.data;
    } catch {
      return null;
    }
  };

  fetchBuffer = async (file, options = {}) => {
    try {
      if (Buffer.isBuffer(file)) return file;
      if (ArrayBuffer.isView(file) || file instanceof ArrayBuffer) return Buffer.from(file);
      if (typeof file === 'string' && this.isUrl(file)) {
        const res = await axios.get(file, { responseType: 'arraybuffer', headers: options });
        return Buffer.from(res.data);
      }
      return await fsp.readFile(file);
    } catch {
      return null;
    }
  };

  getBuffer = async (url, options = {}) => {
    try {
      const res = await axios({
        url,
        method: 'GET',
        headers: { DNT: 1, 'Upgrade-Insecure-Request': 1 },
        ...options,
        responseType: 'arraybuffer'
      });
      return Buffer.from(res.data);
    } catch {
      return null;
    }
  };

  createThumb = async (source) => {
    try {
      const imgBuffer = await this.fetchBuffer(source);
      if (!imgBuffer) return null;
      return await sharp(imgBuffer).resize(200).toFormat('jpeg', { quality: 90 }).toBuffer();
    } catch {
      return null;
    }
  };

  reSize = async (image, width = 200, height = 200) => {
    try {
      return await sharp(image).resize(width, height).toFormat('jpeg').toBuffer();
    } catch {
      return image;
    }
  };

  getFile = async (source, filename, options = {}) => {
    try {
      let dataBuffer;
      let filePath = null;

      if (Buffer.isBuffer(source)) {
        dataBuffer = source;
      } else if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
        dataBuffer = Buffer.from(source);
      } else if (typeof source === 'string' && fs.existsSync(source)) {
        filePath = source;
        dataBuffer = await fsp.readFile(source);
      } else if (typeof source === 'string' && this.isUrl(source)) {
        const res = await axios.get(source, { responseType: 'arraybuffer', ...options });
        dataBuffer = Buffer.from(res.data);
      } else {
        return { status: false, msg: 'Invalid source type or file not found.' };
      }

      const { ext, mime } = (await fromBuffer(dataBuffer)) || { ext: 'bin', mime: 'application/octet-stream' };
      const size = Buffer.byteLength(dataBuffer);

      if (!filePath) {
        await fsp.mkdir(mapping.cfg.path.trash, { recursive: true });
        filePath = path.join(mapping.cfg.path.trash, `${this.uuid()}.${ext}`);
        await fsp.writeFile(filePath, dataBuffer);
      }

      const result = {
        status: true,
        file: filePath,
        filename: filename || path.basename(filePath),
        mime,
        extension: ext,
        size: this.formatSize(size),
        bytes: size
      };

      if (/image/.test(mime)) {
        try {
          result.thumbnail = await sharp(dataBuffer).resize(100).toFormat('jpeg').toBuffer();
        } catch {
          // --- abaikan error thumbnail jika format gambar tidak didukung sharp ---
        }
      }

      return result;
    } catch (e) {
      return { status: false, msg: e.message };
    }
  };

  catbox = async (buffer) => {
    try {
      const ext = await this.getExt(buffer);
      const bodyForm = new FormData();
      bodyForm.append('fileToUpload', buffer, `file.${ext}`);
      bodyForm.append('reqtype', 'fileupload');

      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: bodyForm });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = await res.text();
      if (!url.startsWith('https://')) throw new Error('Invalid Catbox URL');
      return { status: true, url };
    } catch (error) {
      return { status: false, message: error.message };
    }
  };

  tmpfiles = async (buffer, mimeType = null, expire = '1h') => {
    try {
      let ext = 'jpg';
      let finalMime = mimeType;
      if (!finalMime) {
        const fileType = await fromBuffer(buffer);
        if (fileType) {
          finalMime = fileType.mime;
          ext = fileType.ext;
        }
      } else {
        ext = finalMime.split('/')[1] || 'jpg';
      }

      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('time', expire);
      form.append('fileToUpload', buffer, { filename: `upload.${ext}`, contentType: finalMime });

      const { data } = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
        headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      return typeof data === 'string' && data.startsWith('http') ? data : false;
    } catch {
      return false;
    }
  };

  quax = async (buffer) => {
    try {
      const ext = await this.getExt(buffer);
      const form = new FormData();
      form.append('files[]', Buffer.from(buffer), `${Date.now()}.${ext}`);
      form.append('expiry', '-1');

      const response = await retry(
        async () => {
          const { data } = await axios.post('https://qu.ax/upload.php', form, {
            headers: { Origin: 'https://qu.ax', Referer: 'https://qu.ax/', ...form.getHeaders() }
          });
          if (!data.success) throw new Error('Upload failed');
          return data;
        },
        { retries: 3, factor: 2, minTimeout: 1000, maxTimeout: 4000 }
      );

      return { status: true, data: response.files[0] };
    } catch (e) {
      return { status: false, message: e.message };
    }
  };
}

export default new Function();