// --- utilitas grup, validasi bot, normalisasi jid, dan format error ---
import chalk from 'chalk';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import ms from 'parse-ms';
import axios from 'axios';
import mapping from './mapping.js';
import groupfetch from './groupfetch.js';
import func from './functions.js';
import socket from './socket.js';
import lid from './lid.js';
import { ppCache } from './caching.js';

const ppDefault = 'https://files.catbox.moe/39hmb8.jpg';

class Utils {
  constructor() {
    this.botIds = null;
  }

  async groupFetchAllParticipating(client) {
    const jid = jidNormalizedUser(client.user.id);
    return await groupfetch.cacheFunction(jid, async () => {
      try {
        return (await client.groupFetchAllParticipating()) || null;
      } catch {
        return null;
      }
    });
  }

  async checkInGroup(client, jid) {
    const groupData = await this.groupFetchAllParticipating(client);
    return Boolean(groupData && groupData[jid]);
  }

  async closeGroup(sock, groupId) {
    await sock.groupSettingUpdate(groupId, 'announcement');
    console.log(chalk.green(`Grup ${groupId} ditutup oleh ${sock.user?.name || 'Bot'}.`));
  }

  async openGroup(sock, groupId) {
    if (groupId === mapping.cfg.id?.group && global.db?.autodonation?.state === 'AWAITING_PAYMENT') return;
    await sock.groupSettingUpdate(groupId, 'not_announcement');
    console.log(chalk.green(`Grup ${groupId} dibuka oleh ${sock.user?.name || 'Bot'}.`));
  }

  getParticipantIdForComparison(member) {
    if (!member?.id) return null;
    if (lid.isLidUser(member.id) && member.phoneNumber) {
      return member.phoneNumber.includes('@') ? member.phoneNumber : `${member.phoneNumber}@s.whatsapp.net`;
    }
    return member.id;
  }

  transformParticipants(participants) {
    if (!Array.isArray(participants)) return [];
    return participants.map((p) => ({
      admin: p.admin,
      id: this.getParticipantIdForComparison(p) || p.id
    }));
  }

  checkBotAdmin(client, participants = []) {
    if (!Array.isArray(participants)) return false;
    const botJid = jidNormalizedUser(client.user.id);
    return participants.some(
      (p) => (p.id === botJid || (p.phoneNumber && botJid.includes(p.phoneNumber))) && (p.admin === 'admin' || p.admin === 'superadmin')
    );
  }

  filteredGroupData(client, metadata) {
    const isBotAdmin = this.checkBotAdmin(client, metadata.participants);
    return isBotAdmin || (!isBotAdmin && !metadata.announce);
  }

  async checkUsersInAllGroups(client, userId) {
    const result = [];
    const botJid = jidNormalizedUser(client.user.id);

    for (const [, meta] of Object.entries(global.db?.metadata || {})) {
      if (!meta?.participants) continue;
      const isUserExist = meta.participants.some((p) => p.id === userId || (p.phoneNumber && userId.includes(p.phoneNumber)));
      if (!isUserExist) continue;

      const botParticipant = meta.participants.find((p) => p.id === botJid || (p.phoneNumber && botJid.includes(p.phoneNumber)));
      if (!botParticipant) continue;

      const isBotAdmin = botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin';
      if (isBotAdmin || !meta.announce) {
        result.push({ id: meta.id, subject: meta.subject, expiration: meta.ephemeralDuration || 0 });
      }
    }
    return result;
  }

  createDelay(msVal) {
    return new Promise((resolve) => setTimeout(resolve, msVal));
  }

  isAnyBot(jid) {
    if (!jid) return false;
    const targetJid = jidNormalizedUser(jid);
    const allSockets = socket.getAllSockets();

    const activeBotJids = allSockets.filter((x) => x?.user?.id).map((x) => jidNormalizedUser(x.user.id));
    const activeBotLids = allSockets.filter((x) => x?.user?.lid).map((x) => jidNormalizedUser(x.user.lid));

    return activeBotJids.includes(targetJid) || activeBotLids.includes(targetJid);
  }

  getSafeSocket(playerJid, defaultSocket) {
    const expiredTime = 86400000;
    const now = Date.now();

    for (const bot of socket.getAllSockets()) {
      if (!bot?.user) continue;
      const botJid = bot.user.jid || (bot.user.id ? `${bot.user.id.split(':')[0]}@s.whatsapp.net` : '');
      if (!botJid) continue;
      const lastPc = global.db?.pcstatus?.[botJid]?.[playerJid];
      if (lastPc && now - lastPc <= expiredTime) return bot;
    }
    return defaultSocket;
  }

  normalizeJid(text = '') {
    if (!text) return false;
    const match = String(text).match(/(\d+)(:\d+)?@(s\.whatsapp\.net|lid)/);
    if (match) {
      const rawJid = `${match[1]}@${match[3]}`;
      return rawJid.endsWith('@lid') ? lid.get(rawJid) || rawJid : rawJid;
    }

    const cleanedText = String(text).replace(/\D/g, '');
    if (cleanedText.length > 4) {
      const senderFromLid = lid.get(`${cleanedText}@lid`);
      return senderFromLid || `${cleanedText}@s.whatsapp.net`;
    }
    return false;
  }

  resolveQuoted(quotedSender) {
    if (!quotedSender) return false;
    const normJid = quotedSender.includes(':')
      ? `${quotedSender.split(':')[0]}@${quotedSender.split('@')[1]}`
      : quotedSender;
    return normJid.endsWith('@lid') ? lid.get(normJid) || normJid : normJid;
  }

  timeReverse(duration) {
    const time = ms(Date.now() - duration);
    if (time.days === 0 && time.hours === 0 && time.minutes === 0 && time.seconds === 0) return 'Baru Saja';
    return `${time.days}D ${time.hours}H ${time.minutes}M ${time.seconds}S`;
  }

  countdown(tanggal, bulan, tahun) {
    const now = new Date();
    const birthDate = new Date(`${bulan} ${tanggal}, ${tahun} 00:00:00`);
    if (birthDate.getTime() < now.getTime()) birthDate.setFullYear(birthDate.getFullYear() + 1);
    const distance = birthDate.getTime() - now.getTime();
    if (distance <= 0) return 'Hari ini';
    const days = Math.floor(distance / 86400000);
    const hours = Math.floor((distance % 86400000) / 3600000);
    const minutes = Math.floor((distance % 3600000) / 60000);
    const seconds = Math.floor((distance % 60000) / 1000);
    return `${days}D ${hours}H ${minutes}M ${seconds}S`;
  }

  formatTimezone(dateInput, timezone = 'Asia/Jakarta') {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
      .format(new Date(dateInput))
      .replace(/\./g, ':');
  }

  formatCompact(num) {
    if (typeof num !== 'number') return num;
    return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 }).format(num);
  }

  async getCachedPP(client, jid, timeoutMs = 3000) {
    const url = await ppCache.cacheFunction(`pp_${jid}`, () =>
      Promise.race([
        client.profilePictureUrl(jid, 'image'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
      ]).catch(() => null)
    );
    return url || ppDefault;
  }

  getErrorText(error, includeBot = false, context = {}, eventName = '') {
    const { command = '', prefix = '', bot = '', sender = '', chat = '', isGc = false } = context;
    const triggerInfo = command && !eventName ? `*Command:* ${prefix + command}` : `*Event:* ${eventName}`;
    const errorLog = error?.stack ? error.stack : typeof error === 'object' ? func.jsonFormat(error) : String(error);
    const safeError = errorLog.replace(/file:\/\/\//g, 'local://');

    return (
      `*SYSTEM ERROR REPORT*\n\n` +
      `- ${triggerInfo}\n` +
      (includeBot && bot ? `- *Bot:* @${bot.split('@')[0]}\n` : '') +
      `- *Sender:* @${sender.split('@')[0]}\n` +
      `- *Chat:* ${isGc ? global.db?.metadata?.[chat]?.subject || chat : 'Private Chat'}\n\n` +
      `*Log Error:*\n\`\`\`\n${safeError}\n\`\`\``
    );
  }

  async sendMessage(text, isDaget = false) {
    const botToken = isDaget ? process.env.TG_TOKEN_DAGET : process.env.TG_TOKEN_LOG;
    const targetChatId = isDaget ? process.env.TG_CHAT_DAGET : process.env.TG_CHAT_LOG;
    if (!text || !botToken || !targetChatId) return null;

    const finalParseMode = isDaget ? 'Markdown' : 'HTML';
    const finalText = isDaget
      ? text
      : text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\*(.*?)\*/g, '<b>$1</b>')
          .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');

    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: targetChatId,
        text: finalText,
        parse_mode: finalParseMode
      });
    } catch {
      // --- abaikan error pengiriman notifikasi telegram ---
    }
  }
}

export default new Utils();