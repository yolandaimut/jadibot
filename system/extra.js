// --- perluasan method helper client baileys untuk media, stiker, dan interaksi ---
import {
  downloadContentFromMessage,
  getContentType,
  generateWAMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  getBinaryNodeChild,
  areJidsSameUser,
  generateMessageIDV2,
  proto,
  jidDecode,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { promises as fsp } from 'fs';
import fs from 'fs';
import fetch from 'node-fetch';
import axios from 'axios';
import phoneNumber from 'awesome-phonenumber';
import sharp from 'sharp';
import path from 'path';
import pkg from 'file-type';
import crypto from 'crypto';
import os from 'os';
import mapping from './mapping.js';
import store from './store.js';
import Func from './functions.js';
import serialize from './serialize.js';
import utils from './utils.js';
import { groupCache } from './caching.js';

const { fromBuffer } = pkg;
const cache = new Map();
const delayBetweenRequests = 1500;

// --- muat modul writeExif opsional dengan fallback konversi webp via sharp ---
let cachedWriteExif = undefined;
async function convertToStickerBuffer(mediaObj, metadata, shape) {
  if (cachedWriteExif === undefined) {
    try {
      const stickerMod = await import('./sticker.js');
      cachedWriteExif = typeof stickerMod.writeExif === 'function' ? stickerMod.writeExif : null;
    } catch {
      cachedWriteExif = null;
    }
  }

  if (cachedWriteExif) {
    return await cachedWriteExif(mediaObj, metadata, shape);
  }

  // --- fallback konversi gambar ke stiker webp 512x512 jika lib/sticker.js tidak tersedia ---
  const rawBuffer = Buffer.isBuffer(mediaObj.data) ? mediaObj.data : Buffer.from(mediaObj.data);
  if (/webp/i.test(mediaObj.mimetype || '')) {
    return rawBuffer;
  }

  return await sharp(rawBuffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

// --- konversi berbagai sumber media (buffer, arraybuffer, url, base64, path) menjadi buffer ---
async function resolveInputBuffer(input) {
  if (Buffer.isBuffer(input)) return { data: input, res: null, filename: null };
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    return { data: Buffer.from(input), res: null, filename: null };
  }
  if (typeof input === 'string') {
    if (/^data:.*?\/.*?;base64,/i.test(input)) {
      return { data: Buffer.from(input.split(',')[1], 'base64'), res: null, filename: null };
    }
    if (/^https?:\/\//.test(input)) {
      const res = await fetch(input);
      return { data: await res.buffer(), res, filename: null };
    }
    if (fs.existsSync(input)) {
      return { data: await fsp.readFile(input), res: null, filename: input };
    }
    return { data: Buffer.from(input), res: null, filename: null };
  }
  return { data: Buffer.alloc(0), res: null, filename: null };
}

export default class Extra {
  constructor() {
    this.lastMessageTime = 0;
    this.cooldowns = 1000 * 60 * 3;
    this.lidStore = null;
    this.cachedGroups = null;
    this.pendingAllGroupsReq = null;
    this.pendingMetadataReqs = new Map();
  }

  isSpam(currentTime) {
    if (currentTime - this.lastMessageTime < this.cooldowns) return true;
    this.lastMessageTime = currentTime;
    return false;
  }

  mention(text = '') {
    return String(text).includes('@')
      ? [...String(text).matchAll(/@([0-9]{5,16}|0)/g)].map((v) => `${v[1]}@s.whatsapp.net`)
      : [];
  }

  generateMessageId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return 'SURYA' + Array.from({ length: 11 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
  }

  detectLanguage(text) {
    const englishWords = ['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i'];
    const indonesianWords = ['dan', 'di', 'yang', 'ke', 'dari', 'ini', 'itu', 'dengan', 'untuk', 'sebagai'];
    let englishCount = 0;
    let indonesianCount = 0;
    for (const word of String(text || '').toLowerCase().split(/\s+/)) {
      if (englishWords.includes(word)) englishCount += 1;
      if (indonesianWords.includes(word)) indonesianCount += 1;
    }
    return englishCount > indonesianCount ? 'en_us_001' : 'id_001';
  }

  async tiktokTts(text) {
    try {
      const modelVoice = this.detectLanguage(text);
      const inputClean = String(text || '').replace(/[^a-zA-Z0-9.,!?'" ]/g, '').trim();
      if (!inputClean) throw new Error('Teks kosong setelah dibersihkan untuk TTS.');

      const { status, data } = await axios('https://tiktok-tts.weilnet.workers.dev/api/generation', {
        method: 'POST',
        data: { text: inputClean, voice: modelVoice },
        headers: { 'content-type': 'application/json' }
      });
      if (status !== 200 || !data?.success) throw new Error(data?.message || 'Gagal mengkonversi teks ke suara.');
      return { success: true, base64: Buffer.from(data.data, 'base64') };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // --- daftarkan seluruh helper method ke instance socket baileys ---
  registerComponents = (client) => {
    client.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {};
        return decode.user && decode.server ? `${decode.user}@${decode.server}` : jid;
      }
      return jid;
    };

    if (client.user?.id) client.user.jid = client.decodeJid(client.user.id);

    client.ments = this.mention;
    client.makeid = (count) => crypto.randomBytes(count).toString('hex');

    const { sendMessage, relayMessage, waUploadToServer } = client;
    const VALID_JID_REGEX = /^(\d.*@(s\.whatsapp\.net|g\.us|newsletter)|status@broadcast)$/;

    const isAllowedInPc = (jid) => {
      if (mapping.cfg?.allowedPc !== false) return true;
      if (mapping.cfg?.devs?.includes(jid) || global.db?.users?.[jid]?.premium) return true;
      if (utils.isAnyBot(jid)) return true;

      const wwRooms = Object.values(global.db?.werewolf || {});
      if (wwRooms.some((room) => Array.isArray(room.player) && room.player.some((p) => p.id === jid && !p.id.startsWith('ai')))) {
        return true;
      }
      const unoRooms = Object.values(global.db?.uno || {});
      return unoRooms.some((room) => Array.isArray(room.players) && room.players.includes(jid));
    };

    const validateAndFilterChatId = (jid) => {
      if (!jid) return false;
      const chatId = VALID_JID_REGEX.test(jid) ? jid : `${String(jid).replace(/\D/g, '')}@s.whatsapp.net`;
      if (!VALID_JID_REGEX.test(chatId)) return false;

      if (chatId.endsWith('@s.whatsapp.net') && !isAllowedInPc(chatId)) return false;
      if (chatId.endsWith('@g.us') && global.db?.groups?.[chatId]?.banned) return false;
      return chatId;
    };

    client.relayMessage = async (jid, config, options) => {
      const chatId = validateAndFilterChatId(jid);
      if (!chatId) return false;
      return await relayMessage(chatId, config, options);
    };

    client.sendMessage = async (jid, config, options = {}) => {
      const chatId = validateAndFilterChatId(jid);
      if (!chatId) return false;

      if (config?.media && Array.isArray(config.media)) {
        const cards = await Promise.all(
          config.media.map(async (item, index) => {
            const { imageMessage } = await generateWAMessageContent(
              { image: typeof item.image === 'string' ? { url: item.image } : item.image },
              { upload: waUploadToServer }
            );
            return {
              body: proto.Message.InteractiveMessage.Body.fromObject({ text: item.caption || `Image ${index + 1}` }),
              footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: item.footer || 'Surya Core' }),
              header: proto.Message.InteractiveMessage.Header.fromObject({ hasMediaAttachment: true, imageMessage }),
              nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: item.buttons || [] })
            };
          })
        );

        const msg = generateWAMessageFromContent(
          chatId,
          {
            viewOnceMessage: {
              message: {
                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                  body: proto.Message.InteractiveMessage.Body.create({ text: config.text || '' }),
                  footer: proto.Message.InteractiveMessage.Footer.create({ text: config.footer || '' }),
                  carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards })
                })
              }
            }
          },
          { quoted: options?.quoted }
        );

        return await client.relayMessage(chatId, msg.message, { messageId: this.generateMessageId() });
      }

      if (config?.stickers && Array.isArray(config.stickers)) {
        return await client.sendStickerPack(chatId, config.stickers, options?.quoted, { ...config, ...options });
      }

      const msgOptions = { messageId: this.generateMessageId(), ...options };
      const botJid = client.user?.jid || (client.user?.id ? jidNormalizedUser(client.user.id) : '');

      if (global.db?.setting?.[botJid]?.antispam) {
        const lastPromise = cache.get(chatId) || Promise.resolve();
        let resolveDone;
        const donePromise = new Promise((res) => { resolveDone = res; });

        cache.set(
          chatId,
          lastPromise.then(async () => {
            await new Promise((resolve) => setTimeout(resolve, delayBetweenRequests));
            return donePromise;
          })
        );

        await lastPromise;
        try {
          return await sendMessage(chatId, config, msgOptions);
        } finally {
          resolveDone();
        }
      }

      return await sendMessage(chatId, config, msgOptions);
    };

    client.sendAlbumMessage = async (jid, albumMessage, quoted = null) => {
      const array = albumMessage || [];
      if (array.length === 0) throw new Error('Album kosong');

      const expectedImageCount = array.filter((a) => Object.prototype.hasOwnProperty.call(a, 'image')).length;
      const expectedVideoCount = array.filter((a) => Object.prototype.hasOwnProperty.call(a, 'video')).length;
      const userJid = `${generateMessageIDV2().split('@')[0]}@s.whatsapp.net`;

      const album = await generateWAMessageFromContent(
        jid,
        { albumMessage: { expectedImageCount, expectedVideoCount } },
        { userJid, quoted, upload: client.waUploadToServer }
      );
      await client.relayMessage(jid, album.message, { messageId: album.key.id });

      for (const item of array) {
        const child = await generateWAMessage(jid, item, { upload: client.waUploadToServer });
        child.message.messageContextInfo = {
          messageSecret: crypto.randomBytes(32),
          messageAssociation: { associationType: 1, parentMessageKey: album.key }
        };
        await client.relayMessage(jid, child.message, {
          messageId: child.key.id,
          quoted: {
            key: { remoteJid: album.key.remoteJid, id: album.key.id, fromMe: true, participant: userJid },
            message: album.message
          }
        });
      }
      return album;
    };

    // --- kirim paket stiker native whatsapp dengan lazy import fflate ---
    client.sendStickerPack = async (jid, stickersArray, quoted, options = {}) => {
      const { zip } = await import('fflate');
      const packId = client.makeid(16);
      const zipEntries = {};
      const processedStickers = [];

      const getHkdf = (key, length, info) => {
        const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(key).digest();
        let prev = Buffer.alloc(0);
        const buffers = [];
        let i = 1;
        while (Buffer.concat(buffers).length < length) {
          prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])])).digest();
          buffers.push(prev);
          i += 1;
        }
        return Buffer.concat(buffers).slice(0, length);
      };

      const encryptPayload = (buffer, infoStr) => {
        const mediaKey = crypto.randomBytes(32);
        const derivedKey = getHkdf(mediaKey, 112, infoStr);
        const iv = derivedKey.slice(0, 16);
        const cipherKey = derivedKey.slice(16, 48);
        const macKey = derivedKey.slice(48, 80);

        const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
        const encBuffer = Buffer.concat([cipher.update(buffer), cipher.final()]);
        const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, encBuffer])).digest().slice(0, 10);
        const finalEncBuffer = Buffer.concat([encBuffer, mac]);

        return {
          finalEncBuffer,
          mediaKey,
          fileSha256: crypto.createHash('sha256').update(buffer).digest(),
          fileEncSha256: crypto.createHash('sha256').update(finalEncBuffer).digest(),
          fileLength: buffer.length
        };
      };

      let coverBufferRaw = null;
      for (let i = 0; i < (stickersArray?.length || 0); i += 1) {
        try {
          const { data: buffer } = await resolveInputBuffer(stickersArray[i]);
          if (!buffer.length) continue;
          if (!coverBufferRaw) coverBufferRaw = buffer;

          const type = (await fromBuffer(buffer)) || { mime: 'image/jpeg' };
          const stickerWebpBuffer = await convertToStickerBuffer(
            { mimetype: type.mime, data: buffer },
            {
              packname: options.packname || 'Surya Core',
              author: options.author || '',
              categories: options.categories || [],
              avatar: options.avatar,
              prem: options.prem,
              ai: options.ai
            },
            options.shape || 'square'
          );

          const stickerHash = crypto.createHash('sha256').update(stickerWebpBuffer).digest('base64').replace(/\//g, '-');
          const fileName = `${stickerHash}.webp`;
          zipEntries[fileName] = [new Uint8Array(stickerWebpBuffer), { level: 0 }];

          processedStickers.push({
            fileName,
            mimetype: 'image/webp',
            isAnimated: false,
            emojis: ['✨'],
            accessibilityLabel: `Sticker ${i + 1}`
          });
        } catch {
          // --- lewati item stiker yang rusak ---
        }
      }

      if (processedStickers.length === 0) throw new Error('Sticker array kosong atau tidak valid');

      const finalCoverRaw = options.cover ? (await resolveInputBuffer(options.cover)).data : coverBufferRaw;
      const coverPngBuffer = await sharp(finalCoverRaw).resize(512, 512, { fit: 'cover' }).png({ quality: 50 }).toBuffer();
      const trayFileName = `${packId}.png`;
      zipEntries[trayFileName] = [new Uint8Array(coverPngBuffer), { level: 0 }];

      const zipBuffer = await new Promise((resolve, reject) => {
        zip(zipEntries, (err, data) => (err ? reject(err) : resolve(Buffer.from(data))));
      });

      const packEnc = encryptPayload(zipBuffer, 'WhatsApp Sticker Pack Keys');
      const thumbJpegBuffer = await sharp(coverPngBuffer).resize(252, 252).jpeg({ quality: 80 }).toBuffer();
      const thumbEnc = encryptPayload(thumbJpegBuffer, 'WhatsApp Sticker Pack Thumbnail Keys');

      const tempZipPath = path.join(os.tmpdir(), `${packId}_pack.enc`);
      const tempThumbPath = path.join(os.tmpdir(), `${packId}_thumb.enc`);
      await fsp.writeFile(tempZipPath, packEnc.finalEncBuffer);
      await fsp.writeFile(tempThumbPath, thumbEnc.finalEncBuffer);

      let uploadedPack;
      let uploadedThumb;
      try {
        uploadedPack = await waUploadToServer(tempZipPath, {
          fileEncSha256B64: packEnc.fileEncSha256.toString('base64'),
          mediaType: 'document',
          timeoutMs: 60000
        });
        uploadedThumb = await waUploadToServer(tempThumbPath, {
          fileEncSha256B64: thumbEnc.fileEncSha256.toString('base64'),
          mediaType: 'image',
          timeoutMs: 60000
        });
      } finally {
        await fsp.unlink(tempZipPath).catch(() => {});
        await fsp.unlink(tempThumbPath).catch(() => {});
      }

      const waMessage = generateWAMessageFromContent(
        jid,
        {
          stickerPackMessage: {
            name: options.name || 'Sticker Pack',
            publisher: options.publisher || 'Surya Core',
            stickerPackId: packId,
            packDescription: options.description || 'Sticker Pack by Surya Core',
            stickerPackOrigin: 1,
            stickerPackSize: zipBuffer.length,
            stickers: processedStickers,
            fileSha256: packEnc.fileSha256,
            fileEncSha256: packEnc.fileEncSha256,
            mediaKey: packEnc.mediaKey,
            directPath: uploadedPack.directPath,
            fileLength: packEnc.fileLength,
            mediaKeyTimestamp: Math.floor(Date.now() / 1000),
            trayIconFileName: trayFileName,
            thumbnailDirectPath: uploadedThumb.directPath,
            thumbnailSha256: thumbEnc.fileSha256,
            thumbnailEncSha256: thumbEnc.fileEncSha256,
            thumbnailHeight: 252,
            thumbnailWidth: 252,
            imageDataHash: crypto.createHash('sha256').update(thumbJpegBuffer).digest('base64')
          }
        },
        {
          userJid: client.user?.jid,
          quoted,
          ephemeralExpiration: Func.expiration(options.expiration)
        }
      );

      await client.relayMessage(jid, waMessage.message, {
        messageId: waMessage.key.id,
        useCachedGroupMetadata: true,
        additionalAttributes: { type: 'media' }
      });
      return waMessage;
    };

    try {
      this.lidStore = client.signalRepository?.lidMapping || null;
    } catch {
      this.lidStore = null;
    }

    client.lidToJid = async (lid) => {
      if (!this.lidStore || !lid || typeof lid !== 'string') return null;
      try {
        const target = lid.endsWith('@lid') ? lid : `${lid}@lid`;
        const jid = await this.lidStore.getPNForLID(target);
        return jid ? `${jid.split(':')[0]}@s.whatsapp.net` : null;
      } catch {
        return null;
      }
    };

    client.getName = (jid) => {
      const id = client.decodeJid(jid);
      if (id?.endsWith('@g.us')) {
        return new Promise(async (resolve) => {
          let v = store?.contacts[id] || {};
          if (!(v?.name || v?.subject)) v = (await client.groupMetadata?.(id).catch(() => ({}))) || {};
          resolve(v?.name || v?.subject || v?.pushName || phoneNumber(`+${id.replace('@g.us', '')}`).getNumber('international'));
        });
      }
      const v =
        id === '0@s.whatsapp.net'
          ? { id, name: 'WhatsApp' }
          : id === client.decodeJid(client?.user?.id)
            ? client.user
            : store?.contacts[id] || {};
      return v?.name || v?.subject || v?.pushName || v?.verifiedName || phoneNumber(`+${id.replace('@s.whatsapp.net', '')}`).getNumber('international');
    };

    client.getNameV2 = (id) => {
      const normalized = jidNormalizedUser(id);
      const contact = Object.values(store.contacts).find((item) => item.id === normalized);
      return contact?.name || null;
    };

    client.getBusinessProfile = async (jid) => {
      try {
        const results = await client.query({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', xmlns: 'w:biz', type: 'get' },
          content: [{ tag: 'business_profile', attrs: { v: '244' }, content: [{ tag: 'profile', attrs: { jid } }] }]
        });
        const profiles = getBinaryNodeChild(getBinaryNodeChild(results, 'business_profile'), 'profile');
        if (!profiles) return {};
        return {
          jid: profiles.attrs?.jid,
          address: getBinaryNodeChild(profiles, 'address')?.content?.toString(),
          description: getBinaryNodeChild(profiles, 'description')?.content?.toString(),
          website: getBinaryNodeChild(profiles, 'website')?.content?.toString(),
          email: getBinaryNodeChild(profiles, 'email')?.content?.toString(),
          category: getBinaryNodeChild(getBinaryNodeChild(profiles, 'categories'), 'category')?.content?.toString()
        };
      } catch {
        return {};
      }
    };

    client.sendMessageModify = (jid, text = '', quoted = '', opts = {}) => {
      const mentions = Array.from(new Set([...this.mention(text), ...(opts?.mentions ?? [])]));
      return client.sendMessage(
        jid,
        {
          text,
          mentions,
          contextInfo: {
            mentionedJid: mentions,
            forwardingScore: 256,
            isForwarded: true,
            ...(opts.newsletter && mapping.cfg.id?.newsletter
              ? {
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: mapping.cfg.id.newsletter,
                    newsletterName: mapping.cfg.header || 'Surya Core',
                    serverMessageId: -1
                  }
                }
              : {}),
            externalAdReply: {
              showAdAttribution: opts.ads,
              title: opts.title || mapping.cfg.header,
              body: opts.body || mapping.cfg.copyright,
              mediaType: 1,
              previewType: 'PHOTO',
              thumbnailUrl: opts.thumbUrl,
              thumbnail: opts.thumbnail,
              sourceUrl: opts.url,
              renderLargerThumbnail: opts.largeThumb
            }
          }
        },
        { quoted, ephemeralExpiration: Func.expiration(opts.expiration), ...opts }
      );
    };

    client.sendVoiceMessage = async (jid, text, message, messageId) => {
      const ephemeralExpiration = Func.expiration(message?.expiration);
      const result = await this.tiktokTts(text);
      if (!result.success) {
        return await client.sendMessage(jid, { text, mentions: this.mention(text) }, { quoted: message, ephemeralExpiration, messageId });
      }
      return await client.sendMessage(jid, { audio: result.base64, mimetype: 'audio/mpeg', ptt: false }, { quoted: message, ephemeralExpiration, messageId });
    };

    client.reply = async (jid, text, quoted, options = {}) => {
      await client.sendPresenceUpdate('composing', jid).catch(() => {});
      const mentions = Array.from(new Set([...this.mention(text), ...(options?.mentions ?? [])]));
      return client.sendMessage(jid, { text: String(text), mentions, ...options }, { quoted, ephemeralExpiration: Func.expiration(options.expiration) });
    };

    client.sendReact = async (jid, emoticon, keys = {}) => {
      return await client.sendMessage(jid, { react: { text: emoticon, key: keys } });
    };

    client.sendPoll = (jid, name = '', values = [], selectableCount = 1) => {
      return client.sendMessage(jid, { poll: { name, values, selectableCount } });
    };

    client.sendbut = async (chatId, text = '', footer = '', button = [], quoted, options = {}) => {
      if (!Array.isArray(button) || button.length === 0) return;
      const mentions = [...(options.mentions || []), ...this.mention(text)];
      let mediaData = null;
      let mimeType = '';
      if (options.media) {
        const fileRes = await client.getFile(options.media, false);
        mimeType = fileRes.mime;
        mediaData = fileRes.data;
      }

      if (mapping.cfg?.baileys?.button) {
        const buttons = button.map(([displayText, buttonId]) => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: displayText, id: buttonId })
        }));
        const interactiveMessage = proto.Message.InteractiveMessage.create({
          contextInfo: { mentionedJid: mentions },
          body: proto.Message.InteractiveMessage.Body.create({ text }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
          header: proto.Message.InteractiveMessage.Header.create({
            title: '',
            subtitle: '',
            hasMediaAttachment: !!mediaData,
            ...(mediaData ? await prepareWAMessageMedia({ [mimeType.split('/')[0]]: mediaData }, { upload: client.waUploadToServer }) : {})
          }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
        });
        const msg = generateWAMessageFromContent(
          chatId,
          proto.Message.create({ viewOnceMessage: { message: { interactiveMessage } } }),
          { userJid: client.user?.jid, quoted }
        );
        await client.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
        return msg;
      }

      const finalText = options.caption ? `${text}${options.caption}` : text;
      return await client.sendMessage(
        chatId,
        { ...(mediaData ? { [mimeType.split('/')[0]]: mediaData, caption: finalText } : { text: finalText }), mentions },
        { quoted, ephemeralExpiration: Func.expiration(options.expiration) }
      );
    };

    client.sendButton = async (chatId, title = '', text = '', footer = '', button = [], quoted, options = {}) => {
      if (!Array.isArray(button) || button.length === 0) return;
      const mentions = [...(options.mentions || []), ...this.mention(title + text)];
      let mediaData = null;
      let mimeType = '';
      if (options.media) {
        const fileRes = await client.getFile(options.media, false);
        mimeType = fileRes.mime;
        mediaData = fileRes.data;
      }

      const buttonBuilders = {
        list: (display_text, id) => ({ name: 'single_select', buttonParamsJson: JSON.stringify({ title: display_text, sections: id }) }),
        button: (display_text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text, id }) }),
        url: (display_text, id) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text, url: id, merchant_url: id }) }),
        call: (display_text, id) => ({ name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text, id }) }),
        copy: (display_text, id) => ({ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text, id, copy_code: id }) }),
        reminder: (display_text, id) => ({ name: 'cta_reminder', buttonParamsJson: JSON.stringify({ display_text, id }) }),
        address: (display_text, id) => ({ name: 'address_message', buttonParamsJson: JSON.stringify({ display_text, id }) }),
        location: (display_text, id) => ({ name: 'send_location', buttonParamsJson: JSON.stringify({ display_text, id }) })
      };

      const buttons = button
        .map(([name, displayText, id]) => (buttonBuilders[name] ? buttonBuilders[name](displayText, id) : null))
        .filter(Boolean);

      const interactiveMessage = proto.Message.InteractiveMessage.create({
        contextInfo: { mentionedJid: mentions },
        body: proto.Message.InteractiveMessage.Body.create({ text }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
        header: proto.Message.InteractiveMessage.Header.create({
          title,
          subtitle: '',
          hasMediaAttachment: !!mediaData,
          ...(mediaData ? await prepareWAMessageMedia({ [mimeType.split('/')[0]]: mediaData }, { upload: client.waUploadToServer }) : {})
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
      });

      const msg = generateWAMessageFromContent(
        chatId,
        proto.Message.create({ viewOnceMessage: { message: { interactiveMessage } } }),
        { userJid: client.user?.jid, quoted }
      );
      await client.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
      return msg;
    };

    client.setStatus = async (status) => {
      return await client.query({
        tag: 'iq',
        attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'status' },
        content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf-8') }]
      });
    };

    client.resize = async (image, width = 400, height = 400) => {
      const { data: buffer } = await resolveInputBuffer(image);
      if (!buffer.length) throw new TypeError('Buffer gambar kosong atau tidak valid');
      return await sharp(buffer).resize(width, height, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    };

    client.createprofile = async (jid, buff) => {
      const img = await sharp(buff).resize(720, 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
      return client.query({
        tag: 'iq',
        attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'w:profile:picture' },
        content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }]
      });
    };

    client.downloadM = async (message, type, saveToFile) => {
      if (!message || !(message.url || message.directPath)) return Buffer.alloc(0);
      const stream = await downloadContentFromMessage(message, type);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      if (saveToFile) {
        const { filename } = await client.getFile(buffer, true);
        return filename && fs.existsSync(filename) ? filename : buffer;
      }
      return buffer;
    };

    client.getFile = async (inputPath, returnAsFilename) => {
      const { data, res, filename: existingFilename } = await resolveInputBuffer(inputPath);
      if (!Buffer.isBuffer(data) || data.length === 0) {
        throw new TypeError('Result is not a valid buffer or is empty');
      }

      const type = (await fromBuffer(data)) || { mime: 'application/octet-stream', ext: 'bin' };
      let filename = existingFilename;

      if (data && returnAsFilename && !filename) {
        await fsp.mkdir(mapping.cfg.path.trash, { recursive: true });
        filename = path.join(mapping.cfg.path.trash, Func.filename(type.ext));
        await fsp.writeFile(filename, data);
      }
      return { res, filename, ...type, data };
    };

    client.getAllGroupData = async () => {
      if (this.pendingAllGroupsReq) return await this.pendingAllGroupsReq;
      if (this.isSpam(Date.now()) && this.cachedGroups) return this.cachedGroups;

      this.pendingAllGroupsReq = (async () => {
        try {
          const getGroups = await client.groupFetchAllParticipating().catch(() => null);
          if (getGroups) this.cachedGroups = Object.values(getGroups);
          return this.cachedGroups || [];
        } finally {
          this.pendingAllGroupsReq = null;
        }
      })();
      return await this.pendingAllGroupsReq;
    };

    client.getGroupMetadata = async (jid) => {
      const cached = groupCache.getCache(jid);
      if (cached !== null) return cached;
      if (this.pendingMetadataReqs.has(jid)) return await this.pendingMetadataReqs.get(jid);

      const fetchTask = (async () => {
        try {
          const metadata = await client.groupMetadata(jid);
          if (metadata) groupCache.setCache(jid, metadata, groupCache.cacheTtl || 180000);
          return metadata || null;
        } catch {
          return null;
        } finally {
          this.pendingMetadataReqs.delete(jid);
        }
      })();

      this.pendingMetadataReqs.set(jid, fetchTask);
      return await fetchTask;
    };

    client.getGroupMetadataV2 = async (jid) => {
      try {
        const groupData = await client.getAllGroupData();
        const metadata = groupData.find((group) => group.id === jid);
        if (metadata) return metadata;
        return (await client.getGroupMetadata(jid)) || global.db?.metadata?.[jid] || {};
      } catch {
        return global.db?.metadata?.[jid] || {};
      }
    };

    client.checkInGroup = (jid) => utils.checkInGroup(client, jid);

    client.sendMedia = async (jid, mediaPath, quoted, options = {}) => {
      const { mime, data } = await client.getFile(mediaPath);
      const messageType = mime.split('/')[0];
      const type = messageType.replace('application', 'document') || messageType;
      return await client.sendMessage(jid, { [type]: data, mimetype: mime, ...options }, { quoted, ephemeralExpiration: Func.expiration(options.expiration) });
    };

    client.sendFile = async (jid, filePath, caption = '', quoted, ptt = false, options = {}) => {
      const typeInfo = await client.getFile(filePath, true);
      const { data: fileBuffer, filename: pathFile } = typeInfo;

      let mtype = 'document';
      let mimetype = typeInfo.mime;
      if (/webp/.test(mimetype) || (/image/.test(mimetype) && options.asSticker)) mtype = 'sticker';
      else if (/image/.test(mimetype) || (/webp/.test(mimetype) && options.asImage)) mtype = 'image';
      else if (/video/.test(mimetype)) mtype = 'video';
      else if (/audio/.test(mimetype)) {
        mtype = 'audio';
        mimetype = 'audio/ogg; codecs=opus';
      }
      if (options.asDocument) mtype = 'document';

      const messageConfig = {
        ...options,
        caption,
        ptt,
        [mtype]: pathFile ? { url: pathFile } : fileBuffer,
        mimetype
      };

      try {
        return await client.sendMessage(jid, messageConfig, { quoted, ephemeralExpiration: Func.expiration(options.expiration) });
      } catch {
        messageConfig[mtype] = fileBuffer;
        return await client.sendMessage(jid, messageConfig, { quoted, ephemeralExpiration: Func.expiration(options.expiration) });
      }
    };

    // --- pengirim stiker terpadu yang mendukung buffer, arraybuffer, url, maupun path ---
    client.sendSticker = async (jid, inputPath, quoted, options = {}) => {
      const { data: buffer } = await resolveInputBuffer(inputPath);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new TypeError('Buffer atau path stiker tidak valid');
      }

      const { mime } = (await fromBuffer(buffer)) || { mime: 'image/png' };
      const stickerBuffer = await convertToStickerBuffer(
        { mimetype: mime, data: buffer },
        {
          packname: options.packname || mapping.cfg?.botName || 'Surya Core',
          author: options.author || '',
          categories: options.categories || [],
          avatar: options.avatar,
          prem: options.prem,
          ai: options.ai
        },
        options.shape || 'full'
      );

      return await client.sendMessage(
        jid,
        { sticker: stickerBuffer },
        { quoted, ephemeralExpiration: Func.expiration(options.expiration), ...options }
      );
    };

    client.sendStickerFromUrl = async (from, inputPath, quoted, options = {}) => {
      return await client.sendSticker(from, inputPath, quoted, { shape: 'square', ...options });
    };

    client.sendContact = async (jid, contactList, quoted, info = {}, opts = {}) => {
      const list = contactList.map((v) => ({
        displayName: v.name,
        vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${v.name}\nORG:${info.org || 'Surya Core'}\nTEL;type=CELL;type=VOICE;waid=${v.number}:${phoneNumber(`+${v.number}`).getNumber('international')}\nEND:VCARD`
      }));
      return client.sendMessage(jid, { contacts: { displayName: `${list.length} Contact`, contacts: list }, ...opts }, { quoted, ephemeralExpiration: Func.expiration(opts.expiration) });
    };

    client.sendkontak = (jid, numbers, name, quoted, options = {}) => {
      const number = String(numbers || '').replace(/\D/g, '');
      return client.sendContact(jid, [{ name, number }], quoted, {}, options);
    };

    client.copyNForward = async (jid, message, forceForward = false, options = {}) => {
      if (options.readViewOnce) {
        message.message = message.message?.ephemeralMessage?.message || message.message;
        const vtype = Object.keys(message.message?.viewOnceMessage?.message || {})[0];
        if (vtype) delete message.message.viewOnceMessage.message[vtype].viewOnce;
        message.message = { ...message.message?.viewOnceMessage?.message };
      }

      const mtype = Object.keys(message.message)[0];
      const content = await generateForwardMessageContent(message, forceForward);
      const ctype = Object.keys(content)[0];
      const context = mtype !== 'conversation' ? message.message[mtype]?.contextInfo || {} : {};
      content[ctype].contextInfo = { ...context, ...content[ctype].contextInfo };

      const waMessage = await generateWAMessageFromContent(jid, content, {
        ...content[ctype],
        ...options,
        ...(options.contextInfo ? { contextInfo: { ...content[ctype].contextInfo, ...options.contextInfo } } : {})
      });
      await client.relayMessage(jid, waMessage.message, { quoted: options.quoted, ephemeralExpiration: 86400, messageId: waMessage.key.id });
      return waMessage;
    };

    client.cMod = async (jid, copy, text = '', sender = client.user?.id, options = {}) => {
      const mtype = getContentType(copy.message);
      const isEphemeral = mtype === 'ephemeralMessage';
      const content = isEphemeral ? copy.message.ephemeralMessage.message[Object.keys(copy.message.ephemeralMessage.message)[0]] : copy.message;

      if (typeof content === 'string') copy.message = text || content;
      else if (text || content.caption) content.caption = text || content.caption;
      else if (content.text) content.text = text || content.text;

      if (typeof content !== 'string') copy.message = { ...content, ...options };
      if (copy.key.participant) sender = sender || copy.key.participant;
      else if (copy.key.remoteJid?.includes('@s.whatsapp.net') || copy.key.remoteJid?.includes('@broadcast')) {
        sender = sender || copy.key.remoteJid;
      }

      copy.key.remoteJid = jid;
      copy.key.fromMe = areJidsSameUser(sender, client.user?.id);
      return proto.WebMessageInfo.create(copy);
    };

    client.downloadMediaMessage = async (message) => {
      const msg = message?.quoted || message?.msg || message?.message || message;
      const mime = msg?.mimetype || '';
      const messageType = message?.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
      const stream = await downloadContentFromMessage(msg, messageType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      return buffer;
    };

    client.downloadAndSaveMediaMessage = async (message, filename) => {
      const buffer = await client.downloadMediaMessage(message);
      const type = await fromBuffer(buffer);
      const msg = message?.msg || message?.message || message;
      const ext = type?.ext || Func.mimeToExt(msg?.mimetype || '') || 'bin';
      await fsp.mkdir(mapping.cfg.path.trash, { recursive: true });
      const trueFileName = path.join(mapping.cfg.path.trash, filename || Func.filename(ext));
      await fsp.writeFile(trueFileName, buffer);
      return trueFileName;
    };

    client.serializeM = (m, customStore = store) => serialize(client, m, customStore);

    return client;
  };

  registerPrototype = () => {
    if (!Number.prototype.rupiah) {
      Number.prototype.rupiah = function () { return this.toLocaleString('id-ID'); };
    }
    if (!Array.prototype.random) {
      Array.prototype.random = function () { return this[Math.floor(Math.random() * this.length)]; };
    }
    if (!Number.prototype.datestring) {
      Number.prototype.datestring = function () {
        const d = new Date(this);
        return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()} ${d.getHours()}:${d.getMinutes()}`;
      };
    }
    if (!Number.prototype.timers) {
      Number.prototype.timers = function () {
        const seconds = Math.floor((this / 1000) % 60);
        const minutes = Math.floor((this / 60000) % 60);
        const hours = Math.floor((this / 3600000) % 24);
        const days = Math.floor(this / 86400000);
        return `${days ? `${days} hari ` : ''}${hours ? `${hours} jam ` : ''}${minutes ? `${minutes} menit ` : ''}${seconds ? `${seconds} detik` : ''}`.trim();
      };
    }
    if (!Number.prototype.sizeString) {
      Number.prototype.sizeString = function (des = 2) { return Func.formatSize(this, des); };
    }
    if (!Number.prototype.toTimeString) {
      Number.prototype.toTimeString = function () {
        const seconds = Math.floor((this / 1000) % 60);
        const minutes = Math.floor((this / 60000) % 60);
        const hours = Math.floor((this / 3600000) % 24);
        const days = Math.floor(this / 86400000);
        return `${days ? `${days} day ` : ''}${hours ? `${hours} hour ` : ''}${minutes ? `${minutes} minute ` : ''}${seconds ? `${seconds} second` : ''}`.trim();
      };
    }
  };
}