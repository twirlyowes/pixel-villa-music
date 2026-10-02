'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} = require('discord.js');
const { config } = require('./config');
const { fmtTime, truncate, escapeMd } = require('./util');

const V2 = MessageFlags.IsComponentsV2;
const text = (content) => new TextDisplayBuilder().setContent(truncate(content, 3800));
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
function payload(container) { return { components: [container], flags: V2 }; }
function ephemeral(p) { return { ...p, flags: (p.flags || 0) | MessageFlags.Ephemeral }; }

function notice(message, kind = 'info') {
  const color = { info: config.colors.main, ok: config.colors.ok, warn: config.colors.warn, error: config.colors.error }[kind];
  return payload(new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(message)));
}
function trackLine(track) {
  const { title, uri, author, length, isStream } = track.info;
  const name = uri ? `[${escapeMd(truncate(title, 90))}](${uri})` : escapeMd(truncate(title, 90));
  return `**${name}**\n${escapeMd(truncate(author, 60))} • ${isStream ? 'LIVE' : fmtTime(length)}`;
}
const LOOP_LABEL = { off: 'Loop: off', track: 'Loop: track', queue: 'Loop: queue' };

const EMOJIS = {
  play: { name: 'play', id: '1555131702349795348' },
  pause: { name: 'Pause', id: '1555132575847153664' },
  skip: { name: 'skip', id: '1555131659530014753' },
  stop: { name: 'Stop', id: '1555133330314502244' },
  loop: { name: 'loop', id: '1555133181672558605' },
  shuffle: { name: 'shuffle', id: '1555133531003293747' },
  voldown: { name: 'voldown', id: '1555133843185606707' },
  volup: { name: 'volup', id: '1555133978229604392' },
  queue: { name: 'queue1', id: '1555136616983433216' },
};
const emoji = (key) => EMOJIS[key];

function nowPlaying(session) {
  const cur = session.current;
  const container = new ContainerBuilder().setAccentColor(config.colors.main);
  if (!cur) {
    container.addTextDisplayComponents(text('### Nothing playing'));
    return payload(container);
  }
  const status = session.player.paused ? 'Paused' : 'Now playing';
  const requester = cur.requesterId ? session.manager.client.users.cache.get(cur.requesterId) : null;
  const requesterName = requester?.globalName || requester?.username || 'Unknown user';
  const body = [
    `### ${status}`, trackLine(cur), `Requested by @${requesterName}`,
    `Volume ${session.volume}% • ${session.tracks.length} in queue • ${cur.info.sourceName}`,
  ].join('\n');
  const art = cur.info.artworkUrl;
  if (art && /^https?:\/\//i.test(art)) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(body)).setThumbnailAccessory(new ThumbnailBuilder().setURL(art)));
  } else container.addTextDisplayComponents(text(body));
  container.addSeparatorComponents(divider());
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mb:pause').setLabel(session.player.paused ? 'Resume' : 'Pause').setEmoji(emoji(session.player.paused ? 'play' : 'pause')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:skip').setLabel('Skip').setEmoji(emoji('skip')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:stop').setLabel('Stop').setEmoji(emoji('stop')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mb:loop').setLabel(LOOP_LABEL[session.loop]).setEmoji(emoji('loop')).setStyle(session.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mb:shuffle').setLabel('Shuffle').setEmoji(emoji('shuffle')).setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mb:voldown').setLabel('Vol -').setEmoji(emoji('voldown')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:volup').setLabel('Vol +').setEmoji(emoji('volup')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mb:queue').setLabel('Queue').setEmoji(emoji('queue')).setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row1, row2);
  return payload(container);
}

const PAGE_SIZE = 10;
function queuePage(session, page = 1) {
  const pages = Math.max(1, Math.ceil(session.tracks.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const lines = [];
  if (session.current) lines.push(`**Now:** ${escapeMd(truncate(session.current.info.title, 80))} (${fmtTime(session.current.info.length)})`);
  else lines.push('**Now:** nothing');
  if (!session.tracks.length) lines.push('', 'The queue is empty.');
  else {
    lines.push('');
    const start = (p - 1) * PAGE_SIZE;
    session.tracks.slice(start, start + PAGE_SIZE).forEach((t, i) => lines.push(`${start + i + 1}. ${escapeMd(truncate(t.info.title, 70))} • ${t.info.isStream ? 'LIVE' : fmtTime(t.info.length)}`));
    const total = session.tracks.reduce((sum, t) => sum + (t.info.isStream ? 0 : t.info.length), 0);
    lines.push('', `Page ${p}/${pages} • ${session.tracks.length} tracks • ${fmtTime(total)} total • Loop: ${session.loop}`);
  }
  return payload(new ContainerBuilder().setAccentColor(config.colors.main).addTextDisplayComponents(text(`### Queue\n${lines.join('\n')}`)));
}
function help(prefix, commands, isOwner) {
  const lines = commands.filter((c) => !c.ownerOnly || isOwner).map((c) => {
    const usage = (c.args || []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
    const alias = c.aliases?.length ? ` (${c.aliases.join(', ')})` : '';
    return `${prefix}${c.name}${usage ? ` ${usage}` : ''}${alias} - ${c.description}`;
  });
  return payload(new ContainerBuilder().setAccentColor(config.colors.main).addTextDisplayComponents(text([
    '### Music commands', `Prefix: ${prefix} • every command also works as a slash command.`, '', ...lines,
  ].join('\n'))));
}
module.exports = { notice, nowPlaying, queuePage, help, ephemeral, trackLine, V2 };
