// --- serializer pesan baileys dengan kloning spread aman untuk Uint8Array ---
import { proto, areJidsSameUser } from '@whiskeysockets/baileys';
import Lid from './lid.js';
import Func from './functions.js';
import mapping from './mapping.js';

const S_WHATSAPP_NET = '@s.whatsapp.net';

function getDevice(id) {
  if (!id) return id;
  return id.length > 21 ? 'Android' : id.substring(0, 2) === '3A' ? 'IOS' : 'WhatsApp Web';
}

const resolveJid = (jid) => (Lid.isLidUser(jid) && Lid.get(jid)) || jid;

const resolveLidInText = (text, mentions) => {
  if (!text || !mentions?.length) return text;
  let index = 0;
  return text.replace(/@([0-9]{10,30})/g, (match) => {
    if (index < mentions.length) {
      return '@' + mentions[index++].split('@')[0];
    }
    return match;
  });
};

const extractMediaInfo = (targetObj, mediaSource) => {
  if (!mediaSource) return;
  targetObj.mime = mediaSource.mimetype;
  targetObj.size = mediaSource.fileLength;
  targetObj.height = mediaSource.height || '';
  targetObj.width = mediaSource.width || '';
  if (/webp/i.test(targetObj.mime)) targetObj.isAnimated = mediaSource.isAnimated || false;
  if (/audio|video/i.test(targetObj.mime)) targetObj.seconds = mediaSource.seconds;
};

// --- pastikan pola prefix selalu valid baik berupa regex maupun array ---
function getPrefixRegex() {
  const configured = mapping.cfg?.prefixes;
  if (configured instanceof RegExp) return configured;
  if (Array.isArray(configured) && configured.length > 0) {
    const escaped = configured.map((p) => String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^[${escaped}]`);
  }
  return /^[.!\/#]/;
}

const checkBlockedKeyId = (id, jid, m) => {
  if (!id || !jid) return false;
  global.db = global.db || {};
  global.db.ignored = global.db.ignored || [];
  if (global.db.ignored.includes(jid)) return false;

  const botType = ['templateMessage', 'interactiveMessage', 'buttonsMessage'];
  return (
    ['LULLI', 'MECHA', 'HSK', 'BAE', 'B1E', '3EB0', 'B24E', 'WA'].some(
      (a) => id.startsWith(a) && [12, 16, 20, 22, 40].includes(id.length)
    ) ||
    /(.)\1{5,}|[^a-zA-Z0-9]|[^0-9A-F]/.test(id) ||
    (m?.message && Object.keys(m.message).some((key) => botType.includes(key))) ||
    false
  );
};

const mention = (text = '') =>
  [...String(text).matchAll(/@([0-9]{5,16}|0)/g)].map((match) => match[1] + S_WHATSAPP_NET);

const serialize = (client, m, store) => {
  if (!m) return m;

  Object.defineProperties(m, {
    id: {
      get() { return m.key?.id; },
      enumerable: true
    },
    chat: {
      get() {
        return Lid.resolveChatJid(client, m.key);
      },
      enumerable: true
    },
    isGc: {
      get() { return m.chat?.endsWith('@g.us') || false; },
      enumerable: true
    },
    isGroup: {
      get() { return m.isGc; },
      enumerable: true
    },
    isPc: {
      get() { return m.chat?.endsWith(S_WHATSAPP_NET) || false; },
      enumerable: true
    },
    sender: {
      get() {
        return m.isGc && m.key?.participant?.endsWith(S_WHATSAPP_NET)
          ? m.key.participant
          : Lid.getSenderJid(client, m.key);
      },
      enumerable: true
    },
    _mtype: {
      get() {
        const keys = Object.keys(m.message || {});
        if (!keys.length) return null;
        if (keys[0] === 'senderKeyDistributionMessage' && keys.length > 1) {
          return keys[1] === 'messageContextInfo' && keys.length > 2 ? keys[2] : keys[1];
        }
        return keys[0] === 'messageContextInfo' && keys.length > 1 ? keys[1] : keys[0];
      }
    },
    mtype: {
      get() {
        const type = m._mtype;
        if (!type) return '';
        const msg = m.message?.[type];
        if (m.message?.viewOnceMessage) return Object.keys(m.message.viewOnceMessage.message)[0];
        if (m.message?.viewOnceMessageV2) return Object.keys(m.message.viewOnceMessageV2.message)[0];
        if (/^(ephemeralMessage|documentWithCaptionMessage)$/.test(type) && msg?.message) {
          return Object.keys(msg.message)[0];
        }
        return type;
      },
      enumerable: true
    },
    msg: {
      get() {
        const type = m._mtype;
        if (!type) return null;
        let msg = m.message?.[type];
        if (m.message?.viewOnceMessage) msg = m.message.viewOnceMessage.message[m.mtype];
        else if (m.message?.viewOnceMessageV2) msg = m.message.viewOnceMessageV2.message[m.mtype];
        else if (/^(ephemeralMessage|documentWithCaptionMessage)$/.test(type) && msg?.message) {
          msg = msg.message[m.mtype];
        }
        return msg;
      },
      enumerable: true
    },
    isPolling: {
      get() { return m.id?.startsWith('POLL') || /pollCreationMessage|pollUpdateMessage/.test(m._mtype || ''); },
      enumerable: true
    },
    fromMe: {
      get() { return (!m.isPolling && m.key?.fromMe) || false; },
      enumerable: true
    },
    isBot: {
      get() {
        if (m.isPolling || !m.id || !m.sender) return false;
        return checkBlockedKeyId(m.id, m.sender, m);
      },
      enumerable: true
    },
    pushname: {
      get() { return m.pushName || ''; },
      enumerable: true
    },
    bot: {
      get() {
        if (client?.user?.jid) return client.user.jid;
        const id = client?.user?.id;
        return id ? `${id.split(':')[0]}${S_WHATSAPP_NET}` : '';
      },
      enumerable: true
    },
    user: {
      get() { return { id: m.sender, device: getDevice(m.id) }; },
      enumerable: true
    },
    metadata: {
      get() { return m.isGc ? (global.db?.metadata?.[m.chat] || {}) : {}; },
      enumerable: true
    },
    groupName: {
      get() { return m.metadata?.subject || ''; },
      enumerable: true
    },
    members: {
      get() { return (m.metadata?.participants || []).map((u) => ({ id: resolveJid(u.id), admin: u.admin })); },
      enumerable: true
    },
    admins: {
      get() { return m.members?.filter((u) => u.admin) || []; },
      enumerable: true
    },
    isAdmin: {
      get() { return !!m.admins?.find((u) => u.id === m.sender); },
      enumerable: true
    },
    isBotAdmin: {
      get() { return !!m.admins?.find((u) => u.id === m.bot); },
      enumerable: true
    },
    budy: {
      get() {
        const mtype = m.mtype;
        const msg = m.msg;
        const rawBody =
          (mtype === 'interactiveResponseMessage' ? JSON.parse(msg?.nativeFlowResponseMessage?.paramsJson || '{}').id : '') ||
          (mtype === 'stickerMessage' && global.db?.stickercmd?.[msg?.fileSha256?.toString()?.replace(/,/g, '')]?.text) ||
          (mtype === 'protocolMessage' && msg?.type === 14 ? msg?.editedMessage?.extendedTextMessage?.text : '') ||
          (mtype === 'listResponseMessage' ? m.message?.listResponseMessage?.singleSelectReply?.selectedRowId : '') ||
          (mtype === 'buttonsResponseMessage' ? m.message?.buttonsResponseMessage?.selectedButtonId : '') ||
          (mtype === 'templateButtonReplyMessage' ? m.message?.templateButtonReplyMessage?.selectedId : '') ||
          msg?.text ||
          msg?.caption ||
          (typeof msg === 'string' ? msg : '');
        return typeof rawBody === 'string' ? rawBody : '';
      },
      enumerable: true
    },
    body: {
      get() { return m.budy; },
      enumerable: true
    },
    setting: {
      get() { return global.db?.setting?.[m.bot] || {}; },
      enumerable: true
    },
    arg: {
      get() { return m.budy?.trim().split(/ +/).filter((a) => a) || []; },
      enumerable: true
    },
    prefix: {
      get() {
        const content = m.arg.length > 0 ? m.arg[0] : '';
        const usedPrefixMatch = content.match(getPrefixRegex());
        const usedPrefix = usedPrefixMatch ? usedPrefixMatch[0] : '';
        const allowMulti = m.setting?.multiprefix ?? true;
        return allowMulti && usedPrefix ? usedPrefix : (m.setting?.prefix || '.');
      },
      enumerable: true
    },
    isDevs: {
      get() {
        const cfgDevList = Array.isArray(mapping.cfg?.devs) ? mapping.cfg.devs : [];
        return cfgDevList.includes(m.sender);
      },
      enumerable: true
    },
    isOwner: {
      get() {
        const botOwners = Array.isArray(m.setting?.owners) ? m.setting.owners : [];
        const globalOwners = Array.isArray(global.db?.owner) ? global.db.owner : [];
        return [m.bot, ...botOwners, ...globalOwners].includes(m.sender) || m.isDevs;
      },
      enumerable: true
    },
    isVIP: {
      get() { return m.isGc ? (global.db?.groups?.[m.chat]?.sewa?.vip || global.db?.groups?.[m.chat]?.vip || false) : false; },
      enumerable: true
    },
    isPrem: {
      get() { return global.db?.users?.[m.sender]?.premium || false; },
      enumerable: true
    },
    isPrefix: {
      get() { return m.budy?.startsWith(m.prefix); },
      enumerable: true
    },
    command: {
      get() {
        const isNoPrefixEnabled = m.setting?.isNoPrefix ?? true;
        const hasNoPrefixAccess = (m.isDevs || m.isOwner || m.fromMe) && isNoPrefixEnabled;
        if (hasNoPrefixAccess || m.isPrefix) {
          return (m.isPrefix ? m.budy.slice(m.prefix.length) : m.budy).trim().split(/ +/).shift().toLowerCase();
        }
        return '';
      },
      enumerable: true
    },
    cmd: {
      get() { return m.prefix + m.command; },
      enumerable: true
    },
    allcommand: {
      get() {
        const content = m.arg.length > 0 ? m.arg[0] : '';
        const usedPrefixMatch = content.match(getPrefixRegex());
        const usedPrefix = usedPrefixMatch ? usedPrefixMatch[0] : '';
        return usedPrefix ? content.replace(usedPrefix, '').toLowerCase() : '';
      },
      enumerable: true
    },
    args: {
      get() {
        const content = m.arg.length > 0 ? m.arg[0] : '';
        const usedPrefixMatch = content.match(getPrefixRegex());
        const usedPrefix = usedPrefixMatch ? usedPrefixMatch[0] : '';
        const bodyStr = usedPrefix ? m.budy.slice(usedPrefix.length) : m.budy;
        const bodyWords = bodyStr.trim().split(/ +/).filter((a) => a);
        return m.command || m.allcommand ? bodyWords.slice(1) : bodyWords;
      },
      enumerable: true
    },
    mentionedJid: {
      get() { return m.msg?.contextInfo?.mentionedJid?.map(resolveJid) || []; },
      enumerable: true
    },
    expiration: {
      get() { return m.msg?.contextInfo?.expiration || 0; },
      enumerable: true
    },
    text: {
      get() { return resolveLidInText(m.args?.join(' '), m.mentionedJid); },
      enumerable: true
    },
    isMedia: {
      get() { return !!m.msg?.mimetype; },
      enumerable: true
    },
    mime: {
      get() { return m.msg?.mimetype; },
      enumerable: true
    },
    size: {
      get() { return m.msg?.fileLength; },
      enumerable: true
    },
    height: {
      get() { return m.msg?.height || ''; },
      enumerable: true
    },
    width: {
      get() { return m.msg?.width || ''; },
      enumerable: true
    },
    isAnimated: {
      get() { return /webp/i.test(m.mime || '') ? (m.msg?.isAnimated || false) : false; },
      enumerable: true
    },
    seconds: {
      get() { return /audio|video/i.test(m.mime || '') ? m.msg?.seconds : undefined; },
      enumerable: true
    },
    _quotedObj: {
      value: null,
      writable: true
    },
    quoted: {
      get() {
        if (m._quotedObj !== null) return m._quotedObj;
        const msg = m.msg;
        const contextInfo = msg?.contextInfo;
        const quotedMessage = contextInfo?.quotedMessage;
        if (!msg || !contextInfo || !quotedMessage) return null;

        let type = Object.keys(quotedMessage)[0];
        let q = quotedMessage[type];

        if (/productMessage|documentWithCaptionMessage/i.test(type)) {
          type = Object.keys(q)[0];
          q = q[type];
        }

        // --- kloning spread operator agar Uint8Array mediaKey tidak corrupt ---
        const qObj = typeof q === 'string' ? { text: q } : { ...q };

        qObj.id = contextInfo.stanzaId;
        qObj.chat = contextInfo.remoteJid || m.chat;
        qObj.isBot = !!qObj.id && checkBlockedKeyId(qObj.id, m.sender, m);
        qObj.sender = Lid.getQuotedSenderJid(contextInfo, m.key, client);
        qObj.senderLid = Lid.getQuotedSenderLid(contextInfo, m.key) || '';
        qObj.fromMe = areJidsSameUser(qObj.sender, client?.user?.id);
        qObj.mentionedJid = contextInfo?.mentionedJid?.map(resolveJid) || [];
        qObj.device = getDevice(qObj.id);

        qObj.getQuotedObj = () => {
          if (!qObj.id) return false;
          const msgObj = store?.loadMessage(qObj.id);
          return msgObj ? serialize(client, msgObj, store) : false;
        };

        const fakeObj = (qObj.fakeObj = proto.WebMessageInfo.create({
          key: {
            remoteJid: qObj.chat,
            fromMe: qObj.fromMe,
            id: qObj.id
          },
          message: quotedMessage,
          ...(m.isGc ? { participant: qObj.sender } : {})
        }));

        qObj.copyNForward = (jid, forceForward = false, options = {}) =>
          client.copyNForward(jid, fakeObj, forceForward, options);
        qObj.mtype = Object.keys(fakeObj.message)[0];

        const rawQuotedText =
          qObj?.text ||
          qObj?.caption ||
          (qObj.mtype === 'interactiveMessage' ? qObj?.body?.text : '') ||
          (/viewOnceMessage/.test(qObj.mtype) ? qObj.message?.[Object.keys(qObj.message)[0]]?.caption : '') ||
          (qObj.mtype === 'buttonsMessage' ? qObj.contentText : '') ||
          (qObj.mtype === 'templateMessage' ? qObj?.hydratedFourRowTemplate?.hydratedContentText : '') ||
          '';

        qObj.text = resolveLidInText(rawQuotedText, qObj.mentionedJid);
        qObj.isMedia = !!(qObj.message ? qObj.message[Object.keys(qObj.message)[0]]?.mimetype : qObj.mimetype);
        qObj.download = async () => (qObj.isMedia ? await client.downloadMediaMessage(qObj) : null);

        if (qObj.isMedia) {
          extractMediaInfo(qObj, qObj.message ? qObj.message[Object.keys(qObj.message)[0]] : qObj);
        }

        m._quotedObj = qObj;
        return qObj;
      },
      enumerable: true
    },
    reply: {
      value(text, options = {}) {
        return client.sendMessage(
          m.chat,
          {
            text: String(text),
            mentions: mention(text),
            ...options
          },
          {
            quoted: m,
            ephemeralExpiration: Func.expiration(m.expiration)
          }
        );
      }
    },
    copyNForward: {
      value(jid = m.chat, message, forceForward = false, options = {}) {
        return client.copyNForward(jid, message, forceForward, options);
      }
    },
    download: {
      value() {
        return m.isMedia ? client.downloadMediaMessage(m) : null;
      }
    }
  });

  return m;
};

export default serialize;
