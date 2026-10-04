'use strict';

const { Shoukaku, Connectors, LoadType, Constants } = require('shoukaku');
const { Routes } = require('discord.js');
const { config } = require('./config');
const { isUrl, shuffleInPlace, truncate } = require('./util');
const ui = require('./ui');
const { parseSpotifyUrl, loadSpotify } = require('./spotify');

const CONNECTED = Constants.State.CONNECTED;
const SEARCH_PREFIXES = ['ytsearch:', 'scsearch:'];

/** One instance per server the bot is playing in. */
class GuildMusic {
  constructor(manager, guildId, player, voiceChannelId, textChannelId) {
    this.manager = manager;
    this.guildId = guildId;
    this.player = player;
    this.voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId;

    this.current = null; // { encoded, info, requesterId, retries }
    this.tracks = []; // upcoming
    this.loop = 'off'; // off | track | queue
    this.volume = config.defaultVolume;

    this.card = null; // the now-playing message
    this.cardEncoded = null; // which track the card belongs to
    this.idleTimer = null;
    this.aloneTimer = null;
    this.destroyed = false;
    this.recovering = false;
    this.voiceStatusEnabled = false;
  }

  // ---------- helpers ----------
  get textChannel() {
    return this.manager.client.channels.cache.get(this.textChannelId) || null;
  }

  async say(payload) {
    try {
      await this.textChannel?.send(payload);
    } catch {
      /* missing permissions or deleted channel: nothing useful to do */
    }
  }

  clearTimers() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.aloneTimer);
    this.idleTimer = null;
    this.aloneTimer = null;
  }

  startIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.manager.destroy(this.guildId), config.idleLeaveMs);
  }

  // ---------- voice channel status ----------
  async setVoiceStatus(status) {
    try {
      await this.manager.client.rest.put(Routes.channelVoiceStatus(this.voiceChannelId), {
        body: { status: status ? String(status).slice(0, 500) : null },
      });
      return true;
    } catch (err) {
      console.warn(`[music:${this.guildId}] voice status update failed: ${err.message}`);
      return false;
    }
  }

  async updateVoiceStatus() {
    if (!this.voiceStatusEnabled) return false; // feature off: never touch the channel status
    if (!this.current) return this.setVoiceStatus(null);

    const title = String(this.current.info?.title || 'Unknown song').trim();
    const status = `🎵 ${title}`;
    return this.setVoiceStatus(status);
  }

  // ---------- card ----------
  async sendCard() {
    await this.deleteCard();
    try {
      this.card = (await this.textChannel?.send(ui.nowPlaying(this))) || null;
      this.cardEncoded = this.current?.encoded || null;
    } catch (err) {
      console.warn(`[music:${this.guildId}] could not send now-playing card: ${err.message}`);
      this.card = null;
    }
  }

  async updateCard() {
    if (!this.card) return;
    try {
      await this.card.edit(ui.nowPlaying(this));
    } catch {
      this.card = null;
    }
  }

  async deleteCard() {
    const card = this.card;
    this.card = null;
    this.cardEncoded = null;
    if (card) await card.delete().catch(() => {});
  }

  // ---------- queue ----------
  /** Add tracks; starts playback if idle. Returns { started, position } */
  enqueue(tracks, requesterId, { next = false } = {}) {
    const entries = tracks.map((t) => ({ encoded: t.encoded, info: t.info, requesterId, retries: 0 }));
    const started = !this.current;
    if (next) this.tracks.unshift(...entries);
    else this.tracks.push(...entries);
    const position = next ? 1 : this.tracks.length - entries.length + 1;
    if (started) void this.playNext();
    return { started, position, added: entries.length };
  }

  /** Advance to the next track. `skipped` means a user skip (ignores loop-track). */
  async playNext({ skipped = false, failed = false } = {}) {
    if (this.destroyed) return false;
    clearTimeout(this.idleTimer); // keep aloneTimer running
    this.idleTimer = null;
    this.recovering = false;

    let next;
    if (this.current && !skipped && this.loop === 'track') {
      next = { ...this.current, retries: 0 };
    } else {
      if (this.current && this.loop === 'queue' && !failed) this.tracks.push({ ...this.current, retries: 0 });
      next = this.tracks.shift();
    }

    if (!next) {
      this.current = null;
      try {
        await this.player.stopTrack();
      } catch {
        /* nothing was playing */
      }
      await this.deleteCard();
      if (this.voiceStatusEnabled) await this.setVoiceStatus(null);
      await this.say(ui.notice('Queue finished. I will leave shortly if nothing else is added.'));
      this.startIdleTimer();
      return false;
    }

    this.current = next;
    try {
      await this.player.playTrack({ track: { encoded: next.encoded } });
      if (this.player.paused) await this.player.setPaused(false);
    } catch (err) {
      console.error(`[music:${this.guildId}] playTrack failed:`, err.message);
      await this.handleFailure(err.message);
    }
    return true;
  }

  skip() {
    return this.playNext({ skipped: true });
  }

  async setPaused(paused) {
    await this.player.setPaused(paused);
    await this.updateCard();
  }

  async setVolume(v) {
    this.volume = v;
    await this.player.setGlobalVolume(v);
    await this.updateCard();
  }

  cycleLoop(mode) {
    const order = ['off', 'track', 'queue'];
    this.loop = mode && order.includes(mode) ? mode : order[(order.indexOf(this.loop) + 1) % order.length];
    return this.loop;
  }

  shuffle() {
    shuffleInPlace(this.tracks);
  }

  // ---------- failure handling ----------
  /**
   * A track failed to load or got stuck. Try once to find the same song on a
   * different source (YouTube <-> SoundCloud); otherwise skip it.
   */
  async handleFailure(reason) {
    if (this.destroyed || this.recovering || !this.current) return;
    this.recovering = true;
    const failed = this.current;

    if (failed.retries < 1) {
      const alt = await this.manager.findAlternative(failed);
      if (alt && !this.destroyed) {
        this.current = { ...failed, encoded: alt.encoded, info: { ...failed.info, ...alt.info, title: failed.info.title }, retries: failed.retries + 1 };
        try {
          this.recovering = false;
          await this.player.playTrack({ track: { encoded: alt.encoded } });
          return;
        } catch (err) {
          console.error(`[music:${this.guildId}] alternative failed:`, err.message);
          this.recovering = true;
        }
      }
    }

    await this.say(ui.notice(`Skipped **${truncate(failed.info.title, 80)}**: it could not be played${reason ? ` (${truncate(reason, 120)})` : ''}.`, 'warn'));
    this.recovering = false;
    await this.playNext({ skipped: true, failed: true });
  }

  // ---------- player events ----------
  bindPlayer() {
    const p = this.player;

    p.on('start', async () => {
      if (this.destroyed || !this.current) return;
      this.lastError = null;
      // Looping the same track: keep the existing card instead of reposting it.
      if (this.card && this.cardEncoded === this.current.encoded) await this.updateCard();
      else await this.sendCard();
      await this.updateVoiceStatus();
    });

    p.on('end', async (ev) => {
      if (this.destroyed) return;
      if (ev.reason === 'finished') await this.playNext();
      else if (ev.reason === 'loadFailed') await this.handleFailure(this.lastError);
      // 'stopped' | 'replaced' | 'cleanup' are caused by us; nothing to do.
    });

    p.on('exception', (ev) => {
      this.lastError = ev?.exception?.message || 'unknown error';
      console.warn(`[music:${this.guildId}] track exception: ${this.lastError}`);
    });

    p.on('stuck', async () => {
      console.warn(`[music:${this.guildId}] track stuck`);
      await this.handleFailure('track got stuck');
    });

    p.on('closed', async (ev) => {
      // 4014 = we were disconnected/kicked from the voice channel.
      if (ev?.code === 4014) {
        setTimeout(() => {
          const me = this.manager.client.guilds?.cache.get(this.guildId)?.members.me;
          if (!this.destroyed && !me?.voice?.channelId) this.manager.destroy(this.guildId);
        }, 5000);
      }
    });
  }
}

class MusicManager {
  constructor(client, store) {
    this.client = client;
    this.store = store;
    this.sessions = new Map();
    this.joining = new Map();
    this.joinAttempts = new Map();

    // Nodes marked preferred:true (config) are used first while connected;
    // everything else is a fallback, ordered by load.
    this.preferred = new Set(config.nodes.filter((n) => n.preferred).map((n) => n.name));
    const rank = (a, b) => Number(this.preferred.has(b.name)) - Number(this.preferred.has(a.name)) || a.penalties - b.penalties;

    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(client),
      config.nodes.map(({ name, url, auth, secure }) => ({ name, url, auth, secure })),
      {
        moveOnDisconnect: true, // if a node dies, move active players to another node
        resume: true, // brief network blips: Lavalink keeps players alive for resumeTimeout
        resumeTimeout: 60,
        reconnectTries: Infinity, // never give up on a node (a dead one just retries quietly)
        reconnectInterval: 15,
        restTimeout: 30,
        voiceConnectionTimeout: 15,
        userAgent: 'private-music-bot/1.0',
        nodeResolver: (nodes, connection) => this.resolveNode(nodes, connection, rank),
      },
    );
    this.rank = rank;
    this.errorCounts = new Map();

    // Without an 'error' listener EventEmitter would crash the process.
    // Log the first failure of a node, then only every 20th, so a dead node cannot flood the logs.
    this.shoukaku.on('error', (name, err) => {
      const n = (this.errorCounts.get(name) || 0) + 1;
      this.errorCounts.set(name, n);
      if (n === 1 || n % 20 === 0) console.error(`[lavalink:${name}] error (x${n}): ${err.message}`);
    });
    this.shoukaku.on('ready', (name, resumed) => {
      this.errorCounts.delete(name);
      console.log(`[lavalink:${name}] connected${resumed ? ' (session resumed)' : ''}`);
    });
    this.shoukaku.on('close', (name, code, reason) => console.warn(`[lavalink:${name}] closed (${code}) ${reason || ''}`));
    this.shoukaku.on('disconnect', (name) => console.warn(`[lavalink:${name}] disconnected`));
  }

  get(guildId) {
    return this.sessions.get(guildId) || null;
  }

  async setVoiceStatusEnabled(guildId, enabled) {
    const value = Boolean(enabled);
    await this.store.setVoiceStatus(guildId, value);
    const session = this.sessions.get(guildId);
    if (session) {
      session.voiceStatusEnabled = value;
      if (value) await session.updateVoiceStatus();
      else await session.setVoiceStatus(null); // clear it once when turned off
    }
    return value;
  }

  connectedNodes() {
    return [...this.shoukaku.nodes.values()].filter((n) => n.state === CONNECTED).sort(this.rank);
  }

  resolveNode(nodes, connection, rank = this.rank) {
    const connected = [...nodes.values()].filter((node) => node.state === CONNECTED);
    const attempt = connection && this.joinAttempts.get(connection.guildId);
    const candidates = attempt ? connected.filter((node) => !attempt.failed.has(node.name)) : connected;
    const selected = candidates.sort(rank).shift();
    if (attempt) attempt.selected = selected?.name || null;
    return selected;
  }

  /** Join (or reuse) the voice session for a guild. */
  async ensureSession(guild, voiceChannelId, textChannelId) {
    const existing = this.sessions.get(guild.id);
    if (existing) return existing;
    if (this.joining.has(guild.id)) return this.joining.get(guild.id);

    const promise = (async () => {
      const attempt = { failed: new Set(), selected: null };
      this.joinAttempts.set(guild.id, attempt);
      try {
        let player;
        let lastError;
        const maxAttempts = this.connectedNodes().length;

        for (let index = 0; index < maxAttempts; index++) {
          attempt.selected = null;
          try {
            player = await this.shoukaku.joinVoiceChannel({
              guildId: guild.id,
              channelId: voiceChannelId,
              shardId: guild.shardId,
              deaf: true,
            });
            break;
          } catch (err) {
            lastError = err;
            if (!attempt.selected) break;
            attempt.failed.add(attempt.selected);
            console.warn(`[music:${guild.id}] voice join failed on ${attempt.selected}; trying another node: ${err.message}`);
          }
        }

        if (!player) throw lastError || new Error('No connected Lavalink nodes are available.');

        const session = new GuildMusic(this, guild.id, player, voiceChannelId, textChannelId);
        session.bindPlayer();
        this.sessions.set(guild.id, session);
        session.voiceStatusEnabled = await this.store.getVoiceStatus(guild.id);
        try {
          await player.setGlobalVolume(session.volume);
        } catch {
          /* volume is applied on the next track anyway */
        }
        return session;
      } finally {
        this.joinAttempts.delete(guild.id);
      }
    })();

    this.joining.set(guild.id, promise);
    try {
      return await promise;
    } finally {
      this.joining.delete(guild.id);
    }
  }

  async destroy(guildId) {
    const session = this.sessions.get(guildId);
    if (!session || session.destroyed) return;
    session.destroyed = true;
    session.clearTimers();
    this.sessions.delete(guildId);
    await session.deleteCard();
    if (session.voiceStatusEnabled) await session.setVoiceStatus(null);
    try {
      await this.shoukaku.leaveVoiceChannel(guildId);
    } catch (err) {
      console.warn(`[music:${guildId}] leave failed: ${err.message}`);
    }
  }

  // ---------- resolving ----------
  /**
   * Resolve a URL or search text. Tries several nodes and both YouTube and
   * SoundCloud so one blocked node/source does not break /play.
   */
  async resolve(query) {
    const nodes = this.connectedNodes();
    if (!nodes.length) return { type: 'nodes_down' };

    const spotify = parseSpotifyUrl(query);
    if (spotify) return this.resolveSpotify(spotify, nodes);

    const identifiers = isUrl(query) ? [query] : SEARCH_PREFIXES.map((p) => p + query);
    let lastError = null;

    for (const id of identifiers) {
      for (const node of nodes) {
        try {
          const res = await node.rest.resolve(id);
          if (!res) continue;
          if (res.loadType === LoadType.TRACK) return { type: 'track', tracks: [res.data] };
          if (res.loadType === LoadType.PLAYLIST) return { type: 'playlist', name: res.data.info.name, tracks: res.data.tracks };
          if (res.loadType === LoadType.SEARCH && res.data.length) return { type: 'search', tracks: res.data };
          if (res.loadType === LoadType.ERROR) lastError = res.data?.message || 'load error';
        } catch (err) {
          lastError = err.message;
        }
      }
    }
    return { type: lastError ? 'error' : 'empty', error: lastError };
  }

  /**
   * Spotify gives us metadata only, not audio. Read title + artist from the
   * link, then find each song on YouTube (SoundCloud as fallback).
   */
  async resolveSpotify(link, nodes) {
    let meta;
    try {
      meta = await loadSpotify(link);
    } catch (err) {
      console.warn(`[spotify] ${link.type}/${link.id} failed: ${err.message}`);
      return { type: 'error', error: `I couldn't read that Spotify link (${err.message}). Try a song name or a YouTube link.` };
    }
    if (!meta.tracks.length) return { type: 'empty' };

    const wanted = meta.tracks.slice(0, config.maxPlaylistImport);
    const matched = new Array(wanted.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < wanted.length) {
        const i = cursor++;
        matched[i] = await this.matchSpotifyTrack(wanted[i], nodes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));

    const tracks = matched.filter(Boolean);
    if (!tracks.length) return { type: 'empty' };
    if (link.type === 'track') return { type: 'track', tracks };
    return { type: 'playlist', name: meta.name, tracks };
  }

  async matchSpotifyTrack(t, nodes) {
    const query = `${t.title} ${t.artist}`.trim();
    for (const prefix of SEARCH_PREFIXES) {
      for (const node of nodes) {
        try {
          const res = await node.rest.resolve(prefix + query);
          if (res?.loadType !== LoadType.SEARCH || !res.data.length) continue;
          if (!t.durationMs) return res.data[0];
          const close = res.data.find((x) => Math.abs(x.info.length - t.durationMs) <= Math.max(15000, t.durationMs * 0.2));
          return close || res.data[0];
        } catch {
          /* try the next node */
        }
      }
    }
    return null;
  }

  /** Find the same song on the "other" source for failover. */
  async findAlternative(entry) {
    const source = String(entry.info.sourceName || '').toLowerCase();
    const prefix = source === 'youtube' ? 'scsearch:' : 'ytsearch:';
    const title = entry.info.title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
    const author = String(entry.info.author || '').replace(/ - topic$/i, '');
    const query = `${prefix}${title} ${author}`.trim();

    for (const node of this.connectedNodes()) {
      try {
        const res = await node.rest.resolve(query);
        if (res?.loadType !== LoadType.SEARCH || !res.data.length) continue;
        const len = entry.info.length;
        const close = res.data.find((t) => entry.info.isStream || Math.abs(t.info.length - len) <= Math.max(15000, len * 0.2));
        return close || null;
      } catch {
        /* try next node */
      }
    }
    return null;
  }

  // ---------- voice events ----------
  onVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    const session = this.sessions.get(guildId);
    if (!session) return;
    const botId = this.client.user.id;

    if (newState.id === botId) {
      if (!newState.channelId) return void this.destroy(guildId);
      session.voiceChannelId = newState.channelId; // moved by a moderator
    }

    const channel = newState.guild.channels.cache.get(session.voiceChannelId);
    if (!channel) return;
    const humans = channel.members.filter((m) => !m.user.bot).size;

    if (humans === 0) {
      if (!session.aloneTimer) {
        session.aloneTimer = setTimeout(() => this.destroy(guildId), config.aloneLeaveMs);
      }
    } else if (session.aloneTimer) {
      clearTimeout(session.aloneTimer);
      session.aloneTimer = null;
    }
  }

  status() {
    return [...this.shoukaku.nodes.values()].map((n) => ({
      name: n.name,
      connected: n.state === CONNECTED,
      players: n.stats?.players ?? 0,
      playing: n.stats?.playingPlayers ?? 0,
      cpu: n.stats?.cpu?.lavalinkLoad ?? null,
      penalties: n.penalties,
    }));
  }
}

module.exports = { MusicManager, GuildMusic };
