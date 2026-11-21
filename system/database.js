// system/database.js
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import lid from './lid.js';
import models from './models.js';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';

const __filename = fileURLToPath(import.meta.url);
const processedDbCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

export default (client, chat) => {
    if (!chat || !chat.key) return;
    
    const msgId = chat.key.id;
    if (processedDbCache.has(msgId)) return;
    processedDbCache.set(msgId, true);

    if (chat.key.remoteJid === 'status@broadcast') return;

    const chatId = chat.key.remoteJid;
    const botId = jidNormalizedUser(client.user?.id || client.user?.jid || ''); 
    const userId = lid.getSenderJid(client, chat.key) || '';
    const pushname = chat.pushName || '-';

    if (!global.db) global.db = {};
    if (!global.db.users) global.db.users = {};
    if (!global.db.groups) global.db.groups = {};
    if (!global.db.setting) global.db.setting = {};
    if (!global.db.metadata) global.db.metadata = {};

    if (/^\d.*(@s\.whatsapp\.net)$/.test(userId)) {
        let user = global.db.users[userId];
        if (user) {
            execute(user, models.users);
        } else {
            const calender = new Date().toLocaleDateString('id', {
                timeZone: 'Asia/Jakarta',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
            global.db.users[userId] = {
                ...(JSON.parse(JSON.stringify(models?.users || {}))),
                jid: userId,
                name: pushname,
                date: calender
            };
        }
    }

    if (chatId?.endsWith('@g.us')) {
        let group = global.db.groups[chatId];
        if (group) {
            execute(group, models.groups);
        } else {
            let metadata = global.db.metadata[chatId] || {};
            let subject = metadata?.subject || '';
            let owner = metadata?.owner || '';
            global.db.groups[chatId] = {
                jid: chatId,
                name: subject,
                owner,
                sewa: {
                    status: false,
                    notice: false,
                    vip: false,
                    expired: 0
                },
                ...(JSON.parse(JSON.stringify(models?.groups || {})))
            };
        }
    }

    if (botId) {
        let setting = global.db.setting[botId];
        if (setting) {
            execute(setting, models.settings);
        } else {
            global.db.setting[botId] = {
                ...(JSON.parse(JSON.stringify(models?.settings || {})))
            };
        }
    }
}

function isType(val, type) {
    const typeCheckers = {
        // Bypass khusus untuk kata PERMANENT agar tidak di-reset kembali ke 0
        number: val => (typeof val === 'number' && !isNaN(val)) || val === 'PERMANENT',
        string: val => typeof val === 'string',
        object: val => val !== null && typeof val === 'object' && !Array.isArray(val),
        boolean: val => typeof val === 'boolean',
        array: val => Array.isArray(val),
    };
    return typeCheckers[type] ? typeCheckers[type](val) : false;
}

function execute(prefix, template, custom = {}) {
    if (!template || typeof template !== 'object') return;

    Object.keys(template).forEach(key => {
        const defaultValue = template[key];
        const type = Array.isArray(defaultValue) ? 'array' : typeof defaultValue;

        if (!(key in prefix) || !isType(prefix[key], type)) {
            prefix[key] = (typeof defaultValue === 'object' && defaultValue !== null) 
                ? JSON.parse(JSON.stringify(defaultValue)) 
                : defaultValue;
        } 
        else if (type === 'object' && defaultValue !== null) {
            execute(prefix[key], defaultValue);
        }
    });

    if (custom && typeof custom === 'object') {
        Object.keys(custom).forEach(key => {
            if (!(key in prefix)) {
                prefix[key] = (typeof custom[key] === 'object' && custom[key] !== null)
                    ? JSON.parse(JSON.stringify(custom[key]))
                    : custom[key];
            }
        });
    }
}
