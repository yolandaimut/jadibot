// --- penyimpanan pesan ringan di memori dan kontak persisten di volume ---
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { proto } from '@whiskeysockets/baileys';
import { CONTACTS_FILE_PATH } from '../core/config.js';
import loader from './loader.js';

class Store {
  constructor() {
    this.storeMap = new Map();
    this.contacts = {};
    this.presences = {};
    this.CONTACT_FILE = CONTACTS_FILE_PATH;
    this.maxMessages = 3000;
    this.saveContactTimer = null;
    this.loadContact();
  }

  set(id, storeData) {
    this.storeMap.set(id, storeData);
    if (this.storeMap.size > this.maxMessages) {
      const firstKey = this.storeMap.keys().next().value;
      this.storeMap.delete(firstKey);
    }
  }

  get(id) {
    return this.storeMap.get(id) || null;
  }

  delete(id) {
    this.storeMap.delete(id);
  }

  cek(id) {
    return this.storeMap.has(id);
  }

  size() {
    return this.storeMap.size;
  }

  clear() {
    this.storeMap.clear();
  }

  getAllStores() {
    return Array.from(this.storeMap.values());
  }

  saveMessage(messages, botId = null) {
    if (!messages?.key?.id || this.cek(messages.key.id)) return;

    const cleanMessage = {
      key: messages.key,
      message: messages.message,
      messageTimestamp: messages.messageTimestamp,
      pushName: messages.pushName
    };

    if (['STARFALL', 'KURTU-COBEN'].includes(messages.key.id) && botId) {
      cleanMessage.botId = botId;
    }

    this.set(messages.key.id, cleanMessage);
  }

  loadMessage(messageID) {
    return this.get(messageID);
  }

  async loadMessageSerialized(client, messageID) {
    const rawMsg = this.get(messageID);
    if (!client || !rawMsg) return null;

    try {
      const buffer = proto.WebMessageInfo.encode(rawMsg).finish();
      const clonedMsg = proto.WebMessageInfo.decode(buffer);
      const serialize = loader.get('serialize');
      if (serialize) serialize(client, clonedMsg, this);
      return clonedMsg;
    } catch {
      return null;
    }
  }

  loadContact() {
    fs.mkdirSync(path.dirname(this.CONTACT_FILE), { recursive: true });
    if (fs.existsSync(this.CONTACT_FILE)) {
      try {
        this.contacts = JSON.parse(fs.readFileSync(this.CONTACT_FILE, 'utf-8'));
      } catch {
        this.contacts = {};
        this.saveContact();
      }
    } else {
      this.saveContact();
    }
  }

  // --- tulis contacts.json secara debounced dan atomic ---
  saveContact() {
    if (this.saveContactTimer) clearTimeout(this.saveContactTimer);

    this.saveContactTimer = setTimeout(async () => {
      try {
        await fsp.mkdir(path.dirname(this.CONTACT_FILE), { recursive: true });
        const tempPath = `${this.CONTACT_FILE}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tempPath, JSON.stringify(this.contacts, null, 2), 'utf-8');
        await fsp.rename(tempPath, this.CONTACT_FILE);
      } catch (error) {
        console.error('[STORE ERROR] Gagal menyimpan contacts.json:', error.message);
      } finally {
        this.saveContactTimer = null;
      }
    }, 2000);
  }

  addContact(id, obj) {
    if (!id || !/^\d.*@s\.whatsapp\.net$/.test(id)) return;
    if (obj && obj.name === '-') delete obj.name;

    if (this.contacts[id]) {
      let currentName = this.contacts[id].name;
      if (currentName === '-') currentName = undefined;
      if (obj?.name && (!currentName || currentName !== obj.name)) {
        this.contacts[id].name = obj.name;
        this.saveContact();
      }
    } else {
      this.contacts[id] = obj;
      this.saveContact();
    }
  }

  addContactArray(contactArray) {
    if (Array.isArray(contactArray)) {
      contactArray.forEach((contact) => {
        if (contact?.id) this.addContact(contact.id, contact);
      });
    }
  }

  getContact(id) {
    return this.contacts[id] || null;
  }

  getAllContacts() {
    return this.contacts;
  }

  addPresence(id, presences) {
    if (!id) return;
    if (!this.dtFormat) {
      this.dtFormat = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    this.presences[id] = this.presences[id] || {};
    Object.assign(this.presences[id], {
      last: this.dtFormat.format(new Date()),
      ...presences
    });
  }

  getPresence(id) {
    return this.presences[id] || null;
  }

  getAllPresences() {
    return this.presences;
  }
}

export default new Store();
