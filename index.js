'use strict';

// Private Discord music bot: discord.js v14 + Shoukaku (Lavalink v4 client).
// Commands work with a prefix (default "."), as slash commands, and WITHOUT a
// prefix for users the owner allows via "/np add @user".

const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { config, assertConfig } = require('./src/config');
const { Store } = require('./src/store');
const { MusicManager } = require('./src/music');
const { createHandlers } = require('./src/handlers');
const { buildSlashDefinitions } = require('./src/commands');

assertConfig();

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1); // let Render restart us in a clean state
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
  ],
  partials: [Partials.Channel],
});

const store = new Store(config.defaultPrefix);
store.init();

// Must be created before login so it can hook the client's ready event.
const manager = new MusicManager(client, store);
const { onMessage, onSlash, onButton } = createHandlers({ client, manager, store });

client.once('clientReady', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  try {
    const defs = buildSlashDefinitions();
    if (config.guildId) await client.application.commands.set(defs, config.guildId);
    else await client.application.commands.set(defs);
    console.log(`[bot] registered ${defs.length} slash commands ${config.guildId ? `(guild ${config.guildId})` : '(global)'}`);
  } catch (err) {
    console.error('[bot] slash registration failed:', err.message);
  }
});

client.on('messageCreate', (m) => onMessage(m).catch((e) => console.error('[messageCreate]', e)));
client.on('interactionCreate', (i) => {
  const p = i.isButton() ? onButton(i) : onSlash(i);
  p.catch((e) => console.error('[interactionCreate]', e));
});
client.on('voiceStateUpdate', (o, n) => manager.onVoiceStateUpdate(o, n));
client.on('error', (e) => console.error('[client]', e));

// Render web services must listen on a port. Ping GET /health from an external
// uptime monitor every ~5 min so the free instance is not put to sleep.
const app = express();
app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) =>
  res.json({ ok: true, ready: client.isReady(), sessions: manager.sessions.size, nodes: manager.status() }),
);
app.listen(config.port, () => console.log(`[http] listening on ${config.port}`));

async function shutdown() {
  console.log('[bot] shutting down');
  await Promise.allSettled([...manager.sessions.keys()].map((id) => manager.destroy(id)));
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

client.login(config.token);
