'use strict';

// Public community Lavalink v4 nodes.
// These are third-party services, so the bot keeps several independent
// endpoints and automatically fails over when one is unavailable.
//
// The previous Serenetia hostname was a combined/v3 endpoint. This bot uses
// Shoukaku + Lavalink v4, so use the dedicated v4 endpoint instead.
// Override the list with LAVALINK_NODES when using your own nodes.

const DEFAULT_NODES = [
  {
    name: 'Serenetia-V4',
    url: 'lavalinkv4.serenetia.com:443',
    auth: 'https://dsc.gg/ajidevserver',
    secure: true,
    preferred: true,
  },
  {
    name: 'HeavenCloud-IN',
    url: 'lavalink.heavencloud.in:443',
    auth: 'heavencloud',
    secure: true,
  },
  {
    name: 'HeavenCloud-US',
    url: 'us.lavalink.heavencloud.in:443',
    auth: 'heavencloud',
    secure: true,
  },
  {
    name: 'Trinium',
    url: 'lavalink.triniumhost.com:4333',
    auth: 'free',
    secure: false,
  },
];

function parseNodes() {
  const raw = process.env.LAVALINK_NODES;
  if (!raw) return DEFAULT_NODES;

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('must be a non-empty array');
    }

    for (const n of parsed) {
      if (!n.name || !n.url || typeof n.auth !== 'string') {
        throw new Error('each node needs name, url, auth');
      }
    }

    return parsed;
  } catch (err) {
    console.warn(
      `[config] LAVALINK_NODES is invalid (${err.message}); using built-in v4 nodes.`,
    );
    return DEFAULT_NODES;
  }
}

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  token: process.env.DISCORD_TOKEN,
  ownerId: process.env.OWNER_ID,
  defaultPrefix: process.env.DEFAULT_PREFIX || '.',
  guildId: process.env.GUILD_ID || null,
  musicChannels: new Set(list(process.env.MUSIC_CHANNEL_IDS)),
  nodes: parseNodes(),
  port: Number(process.env.PORT) || 3000,

  defaultVolume: 80,
  maxVolume: 150,
  maxQueue: 500,
  maxPlaylistImport: 200,
  idleLeaveMs: 3 * 60 * 1000,
  aloneLeaveMs: 2 * 60 * 1000,

  colors: {
    main: 0x5b8def,
    ok: 0x3ba55d,
    warn: 0xfaa61a,
    error: 0xed4245,
  },
};

function assertConfig() {
  const missing = [];

  if (!config.token) missing.push('DISCORD_TOKEN');
  if (!config.ownerId) missing.push('OWNER_ID');

  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}`,
    );
  }
}

module.exports = { config, assertConfig };
