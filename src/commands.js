'use strict';

const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { config } = require('./config');
const { parseTime, fmtTime, truncate, escapeMd } = require('./util');
const ui = require('./ui');

// Each command: { name, aliases, description, args, ownerOnly, prefixOnly, run(ctx, a) }
//  - args: [{ name, description, type: string|integer|user, required, rest, choices }]
//  - prefixOnly: never triggered by no-prefix chat (only via prefix or slash)
// ctx: { client, manager, store, guild, member, user, channel, prefix, isOwner, reply(payload, {ephemeral}) }

const err = (ctx, msg) => ctx.reply(ui.notice(msg, 'error'), { ephemeral: true });

/** The caller must be in a voice channel; returns it (or replies and returns null). */
async function needVoice(ctx) {
  const vc = ctx.member?.voice?.channel;
  if (!vc) {
    await err(ctx, 'Join a voice channel first.');
    return null;
  }
  return vc;
}

/** Caller must be in the same voice channel as an active session. */
async function needSession(ctx) {
  const session = ctx.manager.get(ctx.guild.id);
  if (!session) {
    await err(ctx, 'Nothing is playing right now.');
    return null;
  }
  const vc = ctx.member?.voice?.channelId;
  if (vc !== session.voiceChannelId) {
    await err(ctx, `Join <#${session.voiceChannelId}> to control the music.`);
    return null;
  }
  return session;
}

const commands = [
  {
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or add it to the queue (link or search)',
    args: [{ name: 'query', description: 'Song name or link', type: 'string', rest: true }],
    async run(ctx, a) {
      const vc = await needVoice(ctx);
      if (!vc) return;

      const existing = ctx.manager.get(ctx.guild.id);
      if (existing && existing.voiceChannelId !== vc.id) {
        return err(ctx, `I'm already playing in <#${existing.voiceChannelId}>.`);
      }

      if (!a.query) {
        // "play" with no argument resumes a paused player.
        if (existing?.player.paused) {
          await existing.setPaused(false);
          return ctx.reply(ui.notice('Resumed.', 'ok'));
        }
        return err(ctx, 'Tell me what to play: a song name or a link.');
      }

      const me = ctx.guild.members.me;
      const perms = vc.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        return err(ctx, `I need View, Connect and Speak permissions in <#${vc.id}>.`);
      }

      const msg = await ctx.reply(ui.notice(`Searching for **${escapeMd(truncate(a.query, 80))}**...`));
      const result = await ctx.manager.resolve(a.query);

      if (result.type === 'nodes_down') {
        return msg.edit(ui.notice('No music servers are connected right now. Try again in a moment.', 'error'));
      }
      if (result.type === 'error') {
        return msg.edit(ui.notice(`Couldn't load that: ${truncate(result.error, 150)}`, 'error'));
      }
      if (result.type === 'empty') {
        return msg.edit(ui.notice('No results found.', 'warn'));
      }

      let session;
      try {
        session = await ctx.manager.ensureSession(ctx.guild, vc.id, ctx.channel.id);
      } catch (error) {
        console.warn(`[command:play] voice connection failed: ${error.message}`);
        return msg.edit(ui.notice("I found the track, but couldn't connect to voice right now. Please try again shortly.", 'error'));
      }
      const room = config.maxQueue - session.tracks.length;
      if (room <= 0) return msg.edit(ui.notice('The queue is full.', 'warn'));

      let tracks;
      if (result.type === 'playlist') tracks = result.tracks.slice(0, Math.min(config.maxPlaylistImport, room));
      else tracks = [result.tracks[0]];

      const { started, position } = session.enqueue(tracks, ctx.user.id);

      if (result.type === 'playlist') {
        return msg.edit(ui.notice(`Added **${tracks.length}** tracks from **${escapeMd(truncate(result.name, 80))}**.`, 'ok'));
      }
      const t = tracks[0].info;
      return msg.edit(ui.notice(started ? `Playing **${escapeMd(truncate(t.title, 90))}**` : `Queued **${escapeMd(truncate(t.title, 90))}** at #${position}`, 'ok'));
    },
  },
  {
    name: 'pause',
    description: 'Pause playback',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      await s.setPaused(true);
      return ctx.reply(ui.notice('Paused.', 'ok'));
    },
  },
  {
    name: 'resume',
    aliases: ['r'],
    description: 'Resume playback',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      await s.setPaused(false);
      return ctx.reply(ui.notice('Resumed.', 'ok'));
    },
  },
  {
    name: 'skip',
    aliases: ['s', 'next'],
    description: 'Skip the current track',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      if (!s.current) return err(ctx, 'Nothing is playing right now.');
      const title = s.current.info.title;
      await s.skip();
      return ctx.reply(ui.notice(`Skipped **${escapeMd(truncate(title, 80))}**.`, 'ok'));
    },
  },
  {
    name: 'skipto',
    description: 'Jump to a position in the queue',
    args: [{ name: 'position', description: 'Queue position', type: 'integer', required: true }],
    async run(ctx, a) {
      const s = await needSession(ctx);
      if (!s) return;
      if (a.position < 1 || a.position > s.tracks.length) return err(ctx, `Pick a position from 1 to ${s.tracks.length}.`);
      const skipped = s.tracks.splice(0, a.position - 1);
      if (s.loop === 'queue') s.tracks.push(...skipped);
      await s.skip();
      return ctx.reply(ui.notice(`Jumped to #${a.position}.`, 'ok'));
    },
  },
  {
    name: 'stop',
    aliases: ['leave', 'dc', 'disconnect'],
    description: 'Stop playback, clear the queue and leave',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      await ctx.manager.destroy(ctx.guild.id);
      return ctx.reply(ui.notice('Stopped and left the voice channel.', 'ok'));
    },
  },
  {
    name: 'queue',
    aliases: ['q'],
    description: 'Show the queue',
    args: [{ name: 'page', description: 'Page number', type: 'integer' }],
    async run(ctx, a) {
      const s = ctx.manager.get(ctx.guild.id);
      if (!s) return err(ctx, 'Nothing is playing right now.');
      return ctx.reply(ui.queuePage(s, a.page || 1));
    },
  },
  {
    name: 'nowplaying',
    aliases: ['now', 'current'],
    description: 'Show the current track',
    async run(ctx) {
      const s = ctx.manager.get(ctx.guild.id);
      if (!s || !s.current) return err(ctx, 'Nothing is playing right now.');
      return ctx.reply(ui.nowPlaying(s));
    },
  },
  {
    name: 'loop',
    aliases: ['l'],
    description: 'Set loop mode: off, track or queue (no value cycles)',
    args: [{ name: 'mode', description: 'off, track or queue', type: 'string', choices: ['off', 'track', 'queue'] }],
    async run(ctx, a) {
      const s = await needSession(ctx);
      if (!s) return;
      const mode = a.mode?.toLowerCase();
      if (mode && !['off', 'track', 'queue'].includes(mode)) return err(ctx, 'Loop mode must be off, track or queue.');
      const now = s.cycleLoop(mode);
      await s.updateCard();
      return ctx.reply(ui.notice(`Loop: **${now}**`, 'ok'));
    },
  },
  {
    name: 'shuffle',
    description: 'Shuffle the queue',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      if (s.tracks.length < 2) return err(ctx, 'Need at least 2 queued tracks to shuffle.');
      s.shuffle();
      return ctx.reply(ui.notice(`Shuffled **${s.tracks.length}** tracks.`, 'ok'));
    },
  },
  {
    name: 'volume',
    aliases: ['vol', 'v'],
    description: `Set the volume (0-${config.maxVolume})`,
    args: [{ name: 'level', description: `0-${config.maxVolume}`, type: 'integer', required: true }],
    async run(ctx, a) {
      const s = await needSession(ctx);
      if (!s) return;
      if (a.level < 0 || a.level > config.maxVolume) return err(ctx, `Volume must be between 0 and ${config.maxVolume}.`);
      await s.setVolume(a.level);
      return ctx.reply(ui.notice(`Volume: **${a.level}%**`, 'ok'));
    },
  },
  {
    name: 'seek',
    description: 'Seek in the current track (e.g. 90, 1:30, 1m30s)',
    args: [{ name: 'time', description: 'e.g. 1:30', type: 'string', required: true }],
    async run(ctx, a) {
      const s = await needSession(ctx);
      if (!s) return;
      if (!s.current) return err(ctx, 'Nothing is playing right now.');
      if (!s.current.info.isSeekable) return err(ctx, "This track can't be seeked.");
      const ms = parseTime(a.time);
      if (ms === null) return err(ctx, 'Use a time like `90`, `1:30` or `1m30s`.');
      if (ms >= s.current.info.length) return err(ctx, `That's past the end (${fmtTime(s.current.info.length)}).`);
      await s.player.seekTo(ms);
      return ctx.reply(ui.notice(`Seeked to **${fmtTime(ms)}**.`, 'ok'));
    },
  },
  {
    name: 'remove',
    description: 'Remove a track from the queue',
    args: [{ name: 'position', description: 'Queue position', type: 'integer', required: true }],
    async run(ctx, a) {
      const s = await needSession(ctx);
      if (!s) return;
      if (a.position < 1 || a.position > s.tracks.length) return err(ctx, `Pick a position from 1 to ${s.tracks.length}.`);
      const [gone] = s.tracks.splice(a.position - 1, 1);
      return ctx.reply(ui.notice(`Removed **${escapeMd(truncate(gone.info.title, 80))}**.`, 'ok'));
    },
  },
  {
    name: 'clear',
    description: 'Clear the queue (keeps the current track)',
    async run(ctx) {
      const s = await needSession(ctx);
      if (!s) return;
      const n = s.tracks.length;
      s.tracks = [];
      return ctx.reply(ui.notice(`Cleared **${n}** tracks.`, 'ok'));
    },
  },
  {
    name: 'vcstatus',
    aliases: ['voice-status'],
    description: 'Turn the current-song voice channel status on or off',
    args: [{ name: 'mode', description: 'on or off', type: 'string', required: true, choices: ['on', 'off'] }],
    async run(ctx, a) {
      const allowed = ctx.isOwner || ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
      if (!allowed) return err(ctx, 'You need the Manage Server permission to change this.');
      const mode = a.mode?.toLowerCase();
      if (!['on', 'off'].includes(mode)) return err(ctx, 'Use `vcstatus on` or `vcstatus off`.');
      const enabled = mode === 'on';
      await ctx.manager.setVoiceStatusEnabled(ctx.guild.id, enabled);
      return ctx.reply(ui.notice(enabled
        ? 'Voice channel song status is now **ON**.'
        : 'Voice channel song status is now **OFF** and the current status was cleared.', 'ok'));
    },
  },
  {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show this list',
    async run(ctx) {
      return ctx.reply(ui.help(ctx.prefix, commands, ctx.isOwner), { ephemeral: true });
    },
  },
  {
    name: 'prefix',
    description: 'Show or change the prefix for this server',
    prefixOnly: true,
    args: [{ name: 'new', description: 'New prefix (1-3 characters)', type: 'string' }],
    async run(ctx, a) {
      if (!a.new) return ctx.reply(ui.notice(`The prefix here is \`${ctx.prefix}\``));
      const allowed = ctx.isOwner || ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
      if (!allowed) return err(ctx, 'You need the Manage Server permission to change the prefix.');
      if (a.new.length > 3 || /\s/.test(a.new)) return err(ctx, 'The prefix must be 1-3 characters with no spaces.');
      await ctx.store.setPrefix(ctx.guild.id, a.new);
      return ctx.reply(ui.notice(`Prefix changed to \`${a.new}\``, 'ok'));
    },
  },
  {
    // Owner-only: manage who can use commands WITHOUT the prefix.
    name: 'np',
    description: 'Owner only: manage no-prefix users (add / remove / list)',
    ownerOnly: true,
    prefixOnly: true,
    args: [
      { name: 'action', description: 'add, remove or list', type: 'string', required: true, choices: ['add', 'remove', 'list'] },
      { name: 'user', description: 'The user', type: 'user' },
    ],
    buildSlash(builder) {
      return builder
        .addSubcommand((s) => s.setName('add').setDescription('Let a user run commands without the prefix').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a user\'s no-prefix access').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('List users with no-prefix access'));
    },
    async run(ctx, a) {
      if (!ctx.isOwner) return err(ctx, 'Only the bot owner can use this command.');
      const action = a.action?.toLowerCase();

      if (action === 'list') {
        const ids = await ctx.store.listNoPrefix(ctx.guild.id);
        const body = ids.length ? ids.map((id) => `<@${id}>`).join('\n') : 'Nobody yet. (You always have no-prefix access.)';
        return ctx.reply(ui.notice(`### No-prefix users\n${body}`), { ephemeral: true });
      }
      if (action !== 'add' && action !== 'remove') return err(ctx, `Usage: \`${ctx.prefix}np add @user\`, \`${ctx.prefix}np remove @user\` or \`${ctx.prefix}np list\``);
      if (!a.user) return err(ctx, 'Mention a user (or paste their ID).');
      if (a.user === config.ownerId) return err(ctx, 'You already have no-prefix access as the owner.');

      const target = await ctx.client.users.fetch(a.user).catch(() => null);
      if (!target || target.bot) return err(ctx, "I couldn't find that user, or it's a bot.");

      if (action === 'add') {
        const added = await ctx.store.addNoPrefix(ctx.guild.id, target.id);
        return ctx.reply(ui.notice(added ? `<@${target.id}> can now use commands without the prefix.` : `<@${target.id}> already has no-prefix access.`, added ? 'ok' : 'warn'), { ephemeral: true });
      }
      const removed = await ctx.store.removeNoPrefix(ctx.guild.id, target.id);
      return ctx.reply(ui.notice(removed ? `<@${target.id}> now needs the prefix again.` : `<@${target.id}> didn't have no-prefix access.`, removed ? 'ok' : 'warn'), { ephemeral: true });
    },
  },
  {
    name: 'nodes',
    description: 'Owner only: show Lavalink node status',
    ownerOnly: true,
    prefixOnly: true,
    async run(ctx) {
      if (!ctx.isOwner) return err(ctx, 'Only the bot owner can use this command.');
      const rows = ctx.manager.status().map((n) => `${n.connected ? 'ONLINE ' : 'OFFLINE'} **${n.name}** • ${n.playing}/${n.players} playing${n.cpu !== null ? ` • cpu ${(n.cpu * 100).toFixed(0)}%` : ''}`);
      return ctx.reply(ui.notice(`### Lavalink nodes\n${rows.join('\n')}`), { ephemeral: true });
    },
  },
];

const byName = new Map();
for (const c of commands) {
  byName.set(c.name, c);
  for (const al of c.aliases || []) byName.set(al, c);
}

/** Build slash command definitions from the same specs. */
function buildSlashDefinitions() {
  return commands.map((c) => {
    const b = new SlashCommandBuilder().setName(c.name).setDescription(truncate(c.description, 100));
    if (c.buildSlash) return c.buildSlash(b).toJSON();
    for (const arg of c.args || []) {
      const add = (o) => {
        o.setName(arg.name).setDescription(truncate(arg.description || arg.name, 100)).setRequired(Boolean(arg.required));
        if (arg.choices && arg.type === 'string') o.addChoices(...arg.choices.map((v) => ({ name: v, value: v })));
        return o;
      };
      if (arg.type === 'integer') b.addIntegerOption(add);
      else if (arg.type === 'user') b.addUserOption(add);
      else b.addStringOption(add);
    }
    return b.toJSON();
  });
}

module.exports = { commands, byName, buildSlashDefinitions };
