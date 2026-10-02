'use strict';

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();
  if (/^\d+$/.test(str)) return Number(str) * 1000;
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0) || parts.length > 3) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
  }
  const m = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
  return null;
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function isUrl(str) { return /^https?:\/\/\S+$/i.test(str); }
function escapeMd(str) { return String(str ?? '').replace(/([\\*_\`~|\[\]])/g, '\\$1'); }
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
module.exports = { fmtTime, parseTime, truncate, isUrl, escapeMd, shuffleInPlace };
