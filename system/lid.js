// --- pemetaan lid ke phone number persisten di railway volume ---
import fs from 'fs';
import path from 'path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { SESSIONS_VOLUME_ROOT } from '../core/config.js';

const SNET = '@s.whatsapp.net';
const LID = '@lid';

class Lid {
  constructor() {
    this.lidMap = new Map();
    this.filepath = path.join(SESSIONS_VOLUME_ROOT, 'lid.json');
    this.loadData();
  }

  loadData() {
    fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
    if (fs.existsSync(this.filepath)) {
      try {
        const parsedData = JSON.parse(fs.readFileSync(this.filepath, 'utf-8'));
        if (Array.isArray(parsedData)) {
          parsedData.forEach((item) => {
            if (item.lid && item.jid) this.lidMap.set(item.lid, item.jid);
          });
          this.saveData();
        } else if (parsedData && typeof parsedData === 'object') {
          for (const [lidKey, jidVal] of Object.entries(parsedData)) {
            if (lidKey && typeof jidVal === 'string') {
              const lid = lidKey.includes(LID) ? lidKey : `${lidKey}${LID}`;
              const jid = jidVal.includes(SNET) ? jidVal : `${jidVal}${SNET}`;
              this.lidMap.set(lid, jid);
            }
          }
        }
      } catch (error) {
        console.error('[LID ERROR] Gagal memuat lid.json:', error.message);
      }
    } else {
      this.saveData();
    }
  }

  // --- tulis lid.json secara atomic ke volume ---
  saveData() {
    try {
      fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
      const compactData = {};
      for (const [lid, jid] of this.lidMap.entries()) {
        if (jid && typeof jid === 'string') {
          compactData[lid] = jid.split('@')[0];
        }
      }
      const tempPath = `${this.filepath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(compactData), 'utf-8');
      fs.renameSync(tempPath, this.filepath);
    } catch (error) {
      console.error('[LID ERROR] Gagal menyimpan lid.json:', error.message);
    }
  }

  isLidUser(jid) {
    return typeof jid === 'string' && jid.endsWith(LID);
  }

  isPnUser(jid) {
    return typeof jid === 'string' && jid.endsWith(SNET);
  }

  isGroup(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
  }

  getPhoneNumber(user) {
    const raw = user?.phoneNumber || user?.pn || user?.id;
    if (!raw || typeof raw !== 'string') return null;
    if (this.isLidUser(raw)) return null;
    return raw.includes('@') ? jidNormalizedUser(raw) : `${raw.replace(/\D/g, '')}${SNET}`;
  }

  add(jid, lid) {
    if (!this.isLidUser(lid) || !jid || typeof jid !== 'string') return false;
    const normalizedJid = jidNormalizedUser(jid);
    if (this.lidMap.get(lid) === normalizedJid) return false;

    this.lidMap.set(lid, normalizedJid);
    this.saveData();
    return true;
  }

  backgroundFetchRealJid(lid, client) {
    if (!client?.signalRepository?.lidMapping) return;
    (async () => {
      try {
        const pnEntry = await client.signalRepository.lidMapping.getPNForLID(lid);
        if (pnEntry && typeof pnEntry === 'string') {
          const jid = `${pnEntry.split(':')[0]}${SNET}`;
          this.add(jid, lid);
        }
      } catch {
        // --- abaikan kegagalan background resolve lid ---
      }
    })();
  }

  get(lid) {
    return this.lidMap.get(lid) || null;
  }

  getLid(jid) {
    for (const [lid, mappedJid] of this.lidMap.entries()) {
      if (mappedJid === jid) return lid;
    }
    return null;
  }

  delete(id) {
    let deleted = false;
    if (this.isLidUser(id)) {
      deleted = this.lidMap.delete(id);
    } else {
      const lid = this.getLid(id);
      if (lid) deleted = this.lidMap.delete(lid);
    }
    if (deleted) {
      this.saveData();
      return true;
    }
    return false;
  }

  // --- simpan seluruh pasangan lid dan nomor telepon dari metadata grup ---
  saveLidFromMetadata(metadata = {}) {
    let hasChanges = false;
    if (Array.isArray(metadata?.participants)) {
      metadata.participants.forEach((user) => {
        const pn = this.getPhoneNumber(user);
        if (this.isLidUser(user.id) && pn && !this.lidMap.has(user.id)) {
          this.lidMap.set(user.id, pn);
          hasChanges = true;
        }
      });
    }
    if (hasChanges) this.saveData();
    return true;
  }

  convertLidParticipants(metadata = {}) {
    if (Array.isArray(metadata?.participants)) {
      metadata.participants = metadata.participants.map((user) =>
        this.isLidUser(user.id)
          ? { id: this.getPhoneNumber(user) || this.get(user.id) || user.id, admin: user.admin }
          : user
      );
    }
  }

  formatGroupParticipants(groupMetadata) {
    if (!groupMetadata || !groupMetadata.participants) return [];
    this.saveLidFromMetadata(groupMetadata);
    this.convertLidParticipants(groupMetadata);
    return groupMetadata.participants;
  }

  convertLidArray(arrays) {
    if (!Array.isArray(arrays)) return arrays;
    return arrays.map((lid) => (this.isLidUser(lid) ? this.get(lid) || lid : lid));
  }

  updateParticipantsToPN(metadata) {
    for (const key in metadata) {
      if (Array.isArray(metadata[key]?.participants)) {
        metadata[key].participants.forEach((participant) => {
          const pn = this.getPhoneNumber(participant) || this.get(participant.id);
          if (this.isLidUser(participant.id) && pn) {
            participant.lid = participant.id;
            participant.id = pn;
            delete participant.pn;
            delete participant.phoneNumber;
          }
        });
      }
    }
    return metadata;
  }

  convertTextLid(text) {
    if (!text || typeof text !== 'string') return text;
    const lidArray = [...text.matchAll(/@([0-9]{5,16}|0)/g)].map((v) => v[1] + LID);
    if (lidArray.length === 0) return text;

    let newText = text;
    for (const lid of lidArray) {
      const jid = this.get(lid);
      if (jid && typeof jid === 'string') {
        newText = newText.replace(new RegExp(`@${lid.split('@')[0]}`, 'g'), `@${jid.split('@')[0]}`);
      }
    }
    return newText;
  }

  getWhatsappJid(key) {
    if (!key) return null;
    if (key.participantPn && this.isPnUser(key.participantPn)) return key.participantPn;
    if (key.senderPn && this.isPnUser(key.senderPn)) return key.senderPn;
    if (key.participant && this.isPnUser(key.participant)) return key.participant;
    if (key.remoteJid && this.isPnUser(key.remoteJid)) return key.remoteJid;

    if (key.addressingMode) {
      if (key.addressingMode === 'lid') {
        if (this.isGroup(key.remoteJid) && key.participantAlt && this.isPnUser(key.participantAlt)) return key.participantAlt;
        if (key.remoteJidAlt && this.isPnUser(key.remoteJidAlt)) return key.remoteJidAlt;
      } else if (key.addressingMode === 'pn' && key.remoteJid && this.isPnUser(key.remoteJid)) {
        return key.remoteJid;
      }
    }

    if (key.participantLid) return key.participantLid;
    if (key.senderLid) return key.senderLid;
    if (key.participant && this.isLidUser(key.participant)) return key.participant;
    if (key.remoteJid && this.isLidUser(key.remoteJid)) return key.remoteJid;

    return key.participant || key.remoteJid || null;
  }

  getSenderJid(client, key) {
    if (!key) return '';

    let rawSender = key.fromMe ? (client?.user?.jid || client?.user?.id) : this.getWhatsappJid(key);

    if (!key.fromMe) {
      const extractedLid = [
        key.participantLid,
        key.senderLid,
        key.participant,
        key.remoteJid,
        key.participantAlt,
        key.remoteJidAlt
      ].find((id) => this.isLidUser(id));

      if (this.isPnUser(rawSender) && extractedLid) {
        this.add(rawSender, extractedLid);
      }
    }

    if (this.isLidUser(rawSender)) {
      const cachedJid = this.get(rawSender);
      if (cachedJid) {
        rawSender = cachedJid;
      } else {
        this.backgroundFetchRealJid(rawSender, client);
      }
    }

    return rawSender ? jidNormalizedUser(rawSender) : '';
  }

  getUserJid(lid) {
    if (!this.isLidUser(lid)) return lid;
    return this.get(lid) || jidNormalizedUser(lid);
  }

  getQuotedSenderJid(contextInfo, key, client) {
    let jid = contextInfo?.participant || key?.remoteJid;
    if (!jid) return '';
    jid = jidNormalizedUser(jid);

    if (!this.isLidUser(jid)) return jid;
    const cacheUser = this.get(jid);
    if (cacheUser) return jidNormalizedUser(cacheUser);

    this.backgroundFetchRealJid(jid, client);
    return jid;
  }

  extractLid(key) {
    if (!key || !this.isGroup(key.remoteJid)) {
      return key?.remoteJid ? this.getLid(key.remoteJid) : null;
    }

    let targetLid = null;
    if (key.participantAlt) {
      if (this.isLidUser(key.participantAlt)) targetLid = key.participantAlt;
      else if (this.isPnUser(key.participantAlt)) targetLid = key.participant || this.getLid(key.participantAlt);
    }

    if (!targetLid && key.participant) {
      if (this.isLidUser(key.participant)) targetLid = key.participant;
      else if (this.isPnUser(key.participant)) targetLid = key.participantAlt || this.getLid(key.participant);
    }

    return targetLid;
  }

  senderLid(client, key) {
    if (!key) return null;
    let jid = this.extractLid(key);
    if (key.fromMe && client?.user) {
      jid = client.user.jid || (client.user.id ? `${client.user.id.split(':')[0]}${SNET}` : null);
    }
    return jid && this.isLidUser(jid) ? jidNormalizedUser(jid) : null;
  }

  getQuotedSenderLid(contextInfo, key) {
    if (!contextInfo && !key) return null;
    const jid = contextInfo?.participant || this.extractLid(key);
    return jid && this.isLidUser(jid) ? jidNormalizedUser(jid) : null;
  }
}

export default new Lid();
