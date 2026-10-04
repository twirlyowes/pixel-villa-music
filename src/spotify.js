'use strict';

// Reads track metadata (title + artist) from public Spotify links.
// The Spotify Web API can't read other people's playlists anymore, so this
// reads the public embed page instead (no credentials needed, ~100 tracks max).

const LINK_RE = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,}\/)?(track|album|playlist)\/([A-Za-z0-9]{10,32})/i;

function parseSpotifyUrl(str) {
  const m = LINK_RE.exec(String(str || '').trim());
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

function extractNextData(html) {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('page layout changed');
  return JSON.parse(m[1]);
}

function normalizeEntity(entity) {
  const list = Array.isArray(entity?.trackList) ? entity.trackList : entity?.title && entity?.subtitle ? [entity] : [];
  const tracks = list
    .map((t) => ({
      title: String(t.title || '').trim(),
      artist: String(t.subtitle || '').replace(/\u00a0/g, ' ').trim(),
      durationMs: Number(t.duration) || null,
    }))
    .filter((t) => t.title);
  return { name: String(entity?.name || entity?.title || 'Spotify playlist'), tracks };
}

function parseEmbedHtml(html) {
  const data = extractNextData(html);
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('no data in page');
  return normalizeEntity(entity);
}

async function loadSpotify({ type, id }, fetchImpl = fetch) {
  const res = await fetchImpl(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; private-music-bot/1.0)', 'accept-language': 'en' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) throw new Error('not found, or the playlist is private');
  if (!res.ok) throw new Error(`Spotify returned ${res.status}`);
  return parseEmbedHtml(await res.text());
}

module.exports = { parseSpotifyUrl, parseEmbedHtml, loadSpotify };
