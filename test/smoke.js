'use strict';
// Offline smoke tests: no Discord or Lavalink connection needed.
process.env.DISCORD_TOKEN = 'x';
process.env.OWNER_ID = '111111111111111111';
process.env.DEFAULT_PREFIX = '.';

const assert = require('assert');
const EventEmitter = require('events');
const { config } = require('../src/config');
const { Store } = require('../src/store');
const { parseArgs, createHandlers } = require('../src/handlers');
const { commands, byName, buildSlashDefinitions } = require('../src/commands');
const { MusicManager, GuildMusic } = require('../src/music');
const { Constants } = require('shoukaku');
const ui = require('../src/ui');
const { parseTime, fmtTime } = require('../src/util');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };

(async () => {
  // ---- util
  assert.strictEqual(parseTime('90'), 90000);
  assert.strictEqual(parseTime('1:30'), 90000);
  assert.strictEqual(parseTime('1m30s'), 90000);
  assert.strictEqual(parseTime('1:02:03'), 3723000);
  assert.strictEqual(parseTime('abc'), null);
  assert.strictEqual(fmtTime(65000), '1:05');
  ok('time parsing/formatting');

  // ---- slash definitions
  const defs = buildSlashDefinitions();
  assert.strictEqual(defs.length, commands.length);
  const np = defs.find((d) => d.name === 'np');
  assert.deepStrictEqual(np.options.map((o) => o.name), ['add', 'remove', 'list']);
  ok(`slash definitions build (${defs.length})`);

  // ---- args
  const play = byName.get('play');
  assert.deepStrictEqual(parseArgs(play, ['never', 'gonna', 'give']).args, { query: 'never gonna give' });
  assert.ok(parseArgs(byName.get('volume'), []).error);
  assert.ok(parseArgs(byName.get('volume'), ['abc']).error);
  assert.deepStrictEqual(parseArgs(byName.get('volume'), ['50']).args, { level: 50 });
  assert.deepStrictEqual(parseArgs(byName.get('np'), ['add', '<@222222222222222222>']).args, { action: 'add', user: '222222222222222222' });
  assert.deepStrictEqual(parseArgs(byName.get('np'), ['add', '222222222222222222']).args, { action: 'add', user: '222222222222222222' });
  assert.ok(parseArgs(byName.get('np'), ['add', 'bob']).error);
  ok('argument parsing');

  // ---- store (memory mode)
  const store = new Store('.');
  assert.strictEqual(await store.getPrefix('g1'), '.');
  await store.setPrefix('g1', '!');
  assert.strictEqual(await store.getPrefix('g1'), '!');
  assert.strictEqual(await store.addNoPrefix('g1', 'u1'), true);
  assert.strictEqual(await store.addNoPrefix('g1', 'u1'), false);
  assert.strictEqual(await store.isNoPrefix('g1', 'u1'), true);
  assert.strictEqual(await store.removeNoPrefix('g1', 'u1'), true);
  assert.strictEqual(await store.isNoPrefix('g1', 'u1'), false);
  ok('store add/remove/prefix');
  await store.setPrefix('g1', '.');

  // ---- Lavalink node join failover
  const joinManager = Object.create(MusicManager.prototype);
  joinManager.sessions = new Map();
  joinManager.joining = new Map();
  joinManager.joinAttempts = new Map();
  joinManager.rank = (a, b) => a.penalties - b.penalties;
  joinManager.store = { getVoiceStatus: async () => false };
  const joinedNodes = [];
  const joinPlayer = Object.assign(new EventEmitter(), { setGlobalVolume: async () => {} });
  const nodeNames = ['Serenetia-V4', 'HeavenCloud-IN', 'HeavenCloud-US', 'Trinium'];
  joinManager.shoukaku = {
    nodes: new Map(nodeNames.map((name) => [name, { name, state: Constants.State.CONNECTED, penalties: 0 }])),
    joinVoiceChannel: async () => {
      const node = joinManager.resolveNode(joinManager.shoukaku.nodes, { guildId: 'join-test' });
      joinedNodes.push(node.name);
      if (node.name !== 'Trinium') throw new Error(`${node.name} REST unavailable`);
      return joinPlayer;
    },
  };
  const joinedSession = await joinManager.ensureSession({ id: 'join-test', shardId: 0 }, 'v1', 't1');
  assert.deepStrictEqual(joinedNodes, nodeNames);
  assert.strictEqual(joinedSession.player, joinPlayer);
  assert.strictEqual(joinManager.joinAttempts.size, 0);
  ok('voice join retries distinct nodes through fourth candidate');

  // ---- session logic with a fake Lavalink player
  const sent = [];
  const fakeManager = {
    client: { users: { cache: new Map() }, rest: { put: async () => {} }, channels: { cache: new Map([['t1', { send: async (p) => { sent.push(p); return { edit: async () => {}, delete: async () => {} }; } }]]) } },
    destroy: async () => {},
    findAlternative: async () => null,
  };
  const played = [];
  const player = Object.assign(new EventEmitter(), {
    paused: false,
    playTrack: async ({ track }) => { played.push(track.encoded); player.emit('start', {}); },
    stopTrack: async () => {},
    setPaused: async (p) => { player.paused = p; },
    setGlobalVolume: async () => {},
  });
  const mk = (n) => ({ encoded: `e${n}`, info: { title: `Song ${n}`, author: 'A', length: 180000, isStream: false, isSeekable: true, sourceName: 'youtube', uri: 'https://x.y/' + n } });
  const s = new GuildMusic(fakeManager, 'g1', player, 'v1', 't1');
  s.bindPlayer();

  s.enqueue([mk(1), mk(2), mk(3)], 'u1');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(played, ['e1']);
  assert.strictEqual(s.tracks.length, 2);

  await player.emit('end', { reason: 'finished' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(played, ['e1', 'e2']);

  s.loop = 'track';
  await player.emit('end', { reason: 'finished' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(played.at(-1), 'e2', 'loop track replays');
  await s.skip();
  assert.strictEqual(played.at(-1), 'e3', 'skip ignores loop track');

  s.loop = 'queue';
  await s.skip(); // e3 goes to the back, queue was empty -> plays e3 again
  assert.strictEqual(played.at(-1), 'e3');

  s.loop = 'off';
  s.tracks = [];
  await player.emit('end', { reason: 'replaced' });
  assert.strictEqual(s.current.encoded, 'e3', 'replaced end is ignored');
  await player.emit('end', { reason: 'finished' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(s.current, null, 'queue ends cleanly');
  s.clearTimers();
  ok('queue, loop modes, skip, end handling');

  // failure path: nothing to recover -> skips to next
  const s2 = new GuildMusic(fakeManager, 'g2', player, 'v1', 't1');
  s2.bindPlayer();
  played.length = 0;
  s2.enqueue([mk(7), mk(8)], 'u1');
  await new Promise((r) => setTimeout(r, 20));
  await player.emit('end', { reason: 'loadFailed' });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(played.at(-1), 'e8', 'failed track is skipped');
  s2.clearTimers();
  ok('failed track skipped');

  // regression: failing track + loop queue must not spin forever
  const s4 = new GuildMusic(fakeManager, 'g4', player, 'v1', 't1');
  s4.bindPlayer();
  s4.loop = 'queue';
  let attempts = 0;
  const realPlayTrack = player.playTrack;
  player.playTrack = async () => { attempts++; throw new Error('boom'); };
  s4.enqueue([mk(20)], 'u1');
  await new Promise((r) => setTimeout(r, 200));
  player.playTrack = realPlayTrack;
  assert.ok(attempts <= 3, `no infinite retry loop (got ${attempts} attempts)`);
  s4.destroyed = true; s4.clearTimers();
  ok('failing track in loop-queue does not spin');

  // regression: starting the next track keeps the alone-leave timer
  const s5 = new GuildMusic(fakeManager, 'g5', player, 'v1', 't1');
  s5.bindPlayer();
  s5.aloneTimer = setTimeout(() => {}, 60000);
  const timer = s5.aloneTimer;
  s5.enqueue([mk(21)], 'u1');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(s5.aloneTimer, timer, 'aloneTimer survives playNext');
  s5.clearTimers();
  ok('alone timer survives next track');

  // regression: voice status feature off -> no REST calls
  let puts = 0;
  fakeManager.client.rest.put = async () => { puts++; };
  const s6 = new GuildMusic(fakeManager, 'g6', player, 'v1', 't1');
  s6.current = mk(22);
  await s6.updateVoiceStatus();
  assert.strictEqual(puts, 0, 'no voice-status call when disabled');
  s6.voiceStatusEnabled = true;
  await s6.updateVoiceStatus();
  assert.strictEqual(puts, 1, 'voice-status call when enabled');
  ok('voice status only when enabled');

  // ---- UI payloads serialize
  const s3 = new GuildMusic(fakeManager, 'g3', player, 'v1', 't1');
  s3.current = { ...mk(9), requesterId: 'u1' };
  s3.tracks = [{ ...mk(10), requesterId: 'u1' }];
  for (const p of [ui.nowPlaying(s3), ui.queuePage(s3), ui.notice('hi', 'ok'), ui.help('.', commands, true)]) {
    JSON.stringify(p.components.map((c) => c.toJSON()));
  }
  for (const p of [ui.queuePage(s3), ui.nowPlaying(s3), ui.help('.', commands, true)]) {
    const raw = JSON.stringify(p.components.map((c) => c.toJSON()));
    assert.ok(!raw.includes('\\\\n'), 'no literal backslash-n in UI text');
  }
  ok('UI payloads serialize');

  // ---- router
  const replies = [];
  const ran = [];
  const client = { user: { id: '999999999999999999' }, users: { fetch: async (id) => ({ id, bot: false }) } };
  const manager = { get: () => null, sessions: new Map() };
  const spy = commands.find((c) => c.name === 'skip');
  const origRun = spy.run; spy.run = async (ctx) => { ran.push('skip'); };
  const spyPlay = byName.get('play'); const origPlay = spyPlay.run; spyPlay.run = async (ctx, a) => { ran.push('play:' + a.query); };
  const { onMessage } = createHandlers({ client, manager, store });

  const msg = (content, userId, { voice = true, channelId = 'c1' } = {}) => ({
    content, author: { id: userId, bot: false }, guild: { id: 'g1' }, channel: { id: channelId, send: async (p) => { replies.push(p); } },
    member: { voice: { channelId: voice ? 'v1' : null }, permissions: { has: () => false } },
    reply: async (p) => { replies.push(p); return { edit: async () => {} }; },
  });
  const OWNER = config.ownerId, GUEST = '333333333333333333', FRIEND = '444444444444444444';

  await onMessage(msg('.skip', GUEST)); assert.deepStrictEqual(ran, ['skip'], 'prefix works for anyone');
  ran.length = 0;
  await onMessage(msg('skip', GUEST)); assert.deepStrictEqual(ran, [], 'no prefix ignored for normal users');
  await onMessage(msg('play some song', OWNER)); assert.deepStrictEqual(ran, ['play:some song'], 'owner has no-prefix');
  ran.length = 0;
  await onMessage(msg('play x', OWNER, { voice: false })); assert.deepStrictEqual(ran, [], 'no-prefix needs voice (no channel list)');
  await onMessage(msg('hello everyone', OWNER)); assert.deepStrictEqual(ran, [], 'chat is ignored');
  await onMessage(msg('skip this song is great', OWNER)); assert.deepStrictEqual(ran, [], 'chat starting with a command word is ignored');
  await onMessage(msg('s', OWNER)); assert.deepStrictEqual(ran, [], 'single-letter alias needs prefix');
  await onMessage(msg('skip', OWNER)); assert.deepStrictEqual(ran, ['skip'], 'bare command still works');
  ran.length = 0;

  // owner grants FRIEND via ".np add"
  await onMessage(msg(`.np add <@${FRIEND}>`, OWNER));
  assert.strictEqual(await store.isNoPrefix('g1', FRIEND), true, '.np add works');
  await onMessage(msg('play hey', FRIEND)); assert.deepStrictEqual(ran, ['play:hey'], 'friend now has no-prefix');
  ran.length = 0;
  await onMessage(msg('np add 555555555555555555', FRIEND)); assert.strictEqual(await store.isNoPrefix('g1', '555555555555555555'), false, 'np is prefix-only');
  const before = replies.length;
  await onMessage(msg(`.np add <@${GUEST}>`, FRIEND));
  assert.strictEqual(await store.isNoPrefix('g1', GUEST), false, 'non-owner cannot use np');
  assert.ok(replies.length > before, 'non-owner gets a denial reply');
  await onMessage(msg(`.np remove <@${FRIEND}>`, OWNER));
  await onMessage(msg('play hey', FRIEND)); assert.deepStrictEqual(ran, [], 'access removed');

  // channel restriction
  config.musicChannels.add('music-only');
  await onMessage(msg('play a', OWNER, { channelId: 'c1' })); assert.deepStrictEqual(ran, [], 'blocked outside music channel');
  await onMessage(msg('play a', OWNER, { channelId: 'music-only' })); assert.deepStrictEqual(ran, ['play:a'], 'allowed in music channel');
  ok('router: prefix, no-prefix, owner-only np, channel rules');

  spy.run = origRun; spyPlay.run = origPlay;
  console.log(`\nAll ${passed} test groups passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
