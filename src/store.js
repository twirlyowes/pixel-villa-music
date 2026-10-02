'use strict';

// Per-server settings (custom prefix + no-prefix user list), persisted in Firestore.
// Render's filesystem is wiped on every restart, so a local JSON file would lose data.
// Reads are cached in memory; writes only happen when something actually changes.
// Without FIREBASE_KEY the bot still runs, but settings live in memory only.

const COLLECTION = 'musicBotGuilds';

class Store {
  constructor(defaultPrefix) {
    this.defaultPrefix = defaultPrefix;
    this.cache = new Map(); // guildId -> { prefix, noPrefix:Set }
    this.db = null;
    this.FieldValue = null;
  }

  init() {
    const raw = process.env.FIREBASE_KEY;
    if (!raw) {
      console.warn('[store] FIREBASE_KEY not set: settings will NOT survive restarts.');
      return;
    }
    try {
      const admin = require('firebase-admin');
      let creds;
      try {
        creds = JSON.parse(raw);
      } catch {
        creds = JSON.parse(raw.replace(/\n/g, '\\n'));
      }
      if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
      if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
      this.db = admin.firestore();
      this.FieldValue = admin.firestore.FieldValue;
      console.log('[store] Firestore connected.');
    } catch (err) {
      console.warn(`[store] Firebase init failed (${err.message}); using in-memory settings.`);
      this.db = null;
    }
  }

  docRef(guildId) { return this.db.collection(COLLECTION).doc(String(guildId)); }

  async getGuild(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);
    let data = {};
    if (this.db) {
      try {
        const snap = await this.docRef(guildId).get();
        if (snap.exists) data = snap.data() || {};
      } catch (err) { console.error('[store] read failed:', err.message); }
    }
    const entry = {
      prefix: typeof data.prefix === 'string' && data.prefix ? data.prefix : null,
      noPrefix: new Set(Array.isArray(data.noPrefix) ? data.noPrefix : []),
      voiceStatus: data.voiceStatus === true,
    };
    this.cache.set(guildId, entry);
    return entry;
  }

  async getPrefix(guildId) {
    const g = await this.getGuild(guildId);
    return g.prefix || this.defaultPrefix;
  }

  async isNoPrefix(guildId, userId) {
    const g = await this.getGuild(guildId);
    return g.noPrefix.has(userId);
  }

  async setPrefix(guildId, prefix) {
    const g = await this.getGuild(guildId);
    g.prefix = prefix;
    await this.write(guildId, { prefix });
  }

  async addNoPrefix(guildId, userId) {
    const g = await this.getGuild(guildId);
    if (g.noPrefix.has(userId)) return false;
    g.noPrefix.add(userId);
    await this.write(guildId, { noPrefix: this.FieldValue ? this.FieldValue.arrayUnion(userId) : null });
    return true;
  }

  async removeNoPrefix(guildId, userId) {
    const g = await this.getGuild(guildId);
    if (!g.noPrefix.has(userId)) return false;
    g.noPrefix.delete(userId);
    await this.write(guildId, { noPrefix: this.FieldValue ? this.FieldValue.arrayRemove(userId) : null });
    return true;
  }

  async listNoPrefix(guildId) {
    const g = await this.getGuild(guildId);
    return [...g.noPrefix];
  }

  async getVoiceStatus(guildId) {
    const g = await this.getGuild(guildId);
    return g.voiceStatus === true;
  }

  async setVoiceStatus(guildId, enabled) {
    const g = await this.getGuild(guildId);
    g.voiceStatus = Boolean(enabled);
    await this.write(guildId, { voiceStatus: g.voiceStatus });
  }

  async write(guildId, fields) {
    if (!this.db) return;
    const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    try { await this.docRef(guildId).set(payload, { merge: true }); }
    catch (err) { console.error('[store] write failed:', err.message); }
  }
}

module.exports = { Store };
