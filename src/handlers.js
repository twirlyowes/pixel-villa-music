'use strict';

const { MessageFlags } = require('discord.js');
const { config } = require('./config');
const { byName } = require('./commands');
const ui = require('./ui');

const USER_RE = /^<@!?(\d{15,25})>$|^(\d{15,25})$/;

// ---------- argument parsing (prefix / no-prefix) ----------

/** Turn raw tokens into { name: value } for a command, or return { error }. */
function parseArgs(cmd, tokens) {
  const out = {};
  const specs = cmd.args || [];
  let i = 0;
  for (const spec of specs) {
    let raw;
    if (spec.rest) {
      raw = tokens.slice(i).join(' ') || undefined;
      i = tokens.length;
    } else {
      raw = tokens[i++];
    }

    if (raw === undefined || raw === '') {
      if (spec.required) return { error: usage(cmd) };
      continue;
    }

    if (spec.type === 'integer') {
      if (!/^-?\d+$/.test(raw)) return { error: `\`${spec.name}\` must be a whole number. ${usage(cmd)}` };
      out[spec.name] = parseInt(raw, 10);
    } else if (spec.type === 'user') {
      const m = raw.match(USER_RE);
      if (!m) return { error: `\`${spec.name}\` must be a mention or a user ID. ${usage(cmd)}` };
      out[spec.name] = m[1] || m[2];
    } else {
      out[spec.name] = raw;
    }
  }
  return { args: out };
}

function usage(cmd) {
  const parts = (cmd.args || []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`));
  return `Usage: \`${cmd.name}${parts.length ? ` ${parts.join(' ')}` : ''}\``;
}

// ---------- context builders ----------

function prefixContext(message, base) {
  return {
    ...base,
    isSlash: false,
    guild: message.guild,
    member: message.member,
    user: message.author,
    channel: message.channel,
    async reply(payload) {
      let sent;
      try {
        sent = await message.reply({ ...payload, allowedMentions: { repliedUser: false } });
      } catch {
        sent = await message.channel.send(payload); // original message deleted, etc.
      }
      return { edit: (p) => sent.edit(p) };
    },
  };
}

function slashContext(interaction, base) {
  let replied = false;
  return {
    ...base,
    isSlash: true,
    guild: interaction.guild,
    member: interaction.member,
    user: interaction.user,
    channel: interaction.channel,
    async reply(payload, { ephemeral = false } = {}) {
      const p = ephemeral ? ui.ephemeral(payload) : payload;
      if (!replied) {
        replied = true;
        await interaction.reply(p);
        return { edit: (e) => interaction.editReply(e) };
      }
      const m = await interaction.followUp(p);
      return { edit: (e) => interaction.webhook.editMessage(m.id, e) };
    },
  };
}

function extractSlashArgs(cmd, interaction) {
  const out = {};
  const sub = interaction.options.getSubcommand(false);
  if (sub) out.action = sub;
  for (const spec of cmd.args || []) {
    if (spec.name === 'action' && sub) continue;
    let v = null;
    if (spec.type === 'integer') v = interaction.options.getInteger(spec.name);
    else if (spec.type === 'user') v = interaction.options.getUser(spec.name)?.id ?? null;
    else v = interaction.options.getString(spec.name);
    if (v !== null && v !== undefined) out[spec.name] = v;
  }
  return out;
}

// ---------- the router ----------

function createHandlers({ client, manager, store }) {
  const isOwnerId = (id) => id === config.ownerId;

  async function baseContext(guild, userId) {
    return {
      client,
      manager,
      store,
      prefix: await store.getPrefix(guild.id),
      isOwner: isOwnerId(userId),
    };
  }

  /** Does this message qualify for no-prefix handling? */
  async function noPrefixAllowed(message) {
    const allowedUser = isOwnerId(message.author.id) || (await store.isNoPrefix(message.guild.id, message.author.id));
    if (!allowedUser) return false;
    if (config.musicChannels.size) return config.musicChannels.has(message.channel.id);
    // No channel list configured: only react to people who are in a voice channel,
    // so normal chat from everyone else can never trigger a command.
    return Boolean(message.member?.voice?.channelId);
  }

  async function onMessage(message) {
    if (message.author.bot || !message.guild || !message.content) return;

    const prefix = await store.getPrefix(message.guild.id);
    let body = null;
    let viaPrefix = false;

    if (message.content.startsWith(prefix)) {
      body = message.content.slice(prefix.length);
      viaPrefix = true;
    } else if (new RegExp(`^<@!?${client.user.id}>\\s*$`).test(message.content)) {
      const ctx = prefixContext(message, await baseContext(message.guild, message.author.id));
      return void ctx.reply(ui.notice(`My prefix here is \`${prefix}\`. Try \`${prefix}help\`.`)).catch(() => {});
    } else if (await noPrefixAllowed(message)) {
      body = message.content;
    } else {
      return;
    }

    const tokens = body.trim().split(/\s+/);
    const name = (tokens.shift() || '').toLowerCase();
    const cmd = byName.get(name);
    if (!cmd) return;
    // Admin-style commands need the real prefix, so chatting never triggers them.
    if (!viaPrefix && cmd.prefixOnly) return;
    if (!viaPrefix && name.length < 2) return; // single-letter aliases need the prefix
    // Without a prefix, only react to message shaped like a command (extra words = normal chat).
    if (!viaPrefix && cmd.name !== 'play' && tokens.length > (cmd.args || []).length) return;

    const ctx = prefixContext(message, await baseContext(message.guild, message.author.id));

    if (cmd.ownerOnly && !ctx.isOwner) {
      return void ctx.reply(ui.notice('Only the bot owner can use this command.', 'error')).catch(() => {});
    }

    const parsed = parseArgs(cmd, tokens);
    if (parsed.error) return void ctx.reply(ui.notice(parsed.error, 'warn')).catch(() => {});

    await run(cmd, ctx, parsed.args);
  }

  async function onSlash(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) {
      return void interaction.reply({ content: 'Use me inside a server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const cmd = byName.get(interaction.commandName);
    if (!cmd) return;

    const ctx = slashContext(interaction, await baseContext(interaction.guild, interaction.user.id));
    if (cmd.ownerOnly && !ctx.isOwner) {
      return void ctx.reply(ui.notice('Only the bot owner can use this command.', 'error'), { ephemeral: true }).catch(() => {});
    }
    await run(cmd, ctx, extractSlashArgs(cmd, interaction));
  }

  async function run(cmd, ctx, args) {
    try {
      await cmd.run(ctx, args);
    } catch (error) {
      console.error(`[command:${cmd.name}]`, error);
      try {
        await ctx.reply(ui.notice('Something went wrong running that command.', 'error'), { ephemeral: true });
      } catch {
        /* nothing else we can do */
      }
    }
  }

  async function onButton(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('mb:')) return;
    const action = interaction.customId.slice(3);
    const session = manager.get(interaction.guildId);
    const deny = (msg) => interaction.reply(ui.ephemeral(ui.notice(msg, 'error'))).catch(() => {});

    if (!session) return deny('Nothing is playing right now.');
    if (interaction.member?.voice?.channelId !== session.voiceChannelId) {
      return deny(`Join <#${session.voiceChannelId}> to use these buttons.`);
    }

    try {
      switch (action) {
        case 'pause':
          await session.player.setPaused(!session.player.paused);
          return void (await interaction.update(ui.nowPlaying(session)));
        case 'skip':
          await interaction.deferUpdate();
          return void (await session.skip());
        case 'stop':
          await interaction.deferUpdate();
          return void (await manager.destroy(interaction.guildId));
        case 'loop':
          session.cycleLoop();
          return void (await interaction.update(ui.nowPlaying(session)));
        case 'shuffle':
          session.shuffle();
          return void (await interaction.reply(ui.ephemeral(ui.notice(`Shuffled **${session.tracks.length}** tracks.`, 'ok'))));
        case 'voldown':
        case 'volup': {
          const step = action === 'volup' ? 10 : -10;
          session.volume = Math.min(config.maxVolume, Math.max(0, session.volume + step));
          await session.player.setGlobalVolume(session.volume);
          return void (await interaction.update(ui.nowPlaying(session)));
        }
        case 'queue':
          return void (await interaction.reply(ui.ephemeral(ui.queuePage(session, 1))));
        default:
      }
    } catch (error) {
      console.error('[button]', error);
      if (!interaction.replied && !interaction.deferred) deny('That did not work. Try again.');
    }
  }

  return { onMessage, onSlash, onButton, parseArgs };
}

module.exports = { createHandlers, parseArgs };
