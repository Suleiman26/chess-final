import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export async function rpc(fn, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const FIG = {
  w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' },
  b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' },
};
export function figurine(san, color) {
  return String(san).replace(/[KQRBN]/g, (c) => FIG[color === 'b' ? 'b' : 'w'][c]);
}

const PIECE_HE = { p: 'רגלי', n: 'פרש', b: 'רץ', r: 'צריח', q: 'מלכה', k: 'מלך' };
export function pieceNameHe(type) {
  return PIECE_HE[type] || '';
}
export const sideHe = (s) => (s === 'w' ? 'לבן' : 'שחור');
export const sideHeTo = (s) => (s === 'w' ? 'ללבן' : 'לשחור');

export function legalDests(chess) {
  const m = new Map();
  for (const mv of chess.moves({ verbose: true })) {
    if (!m.has(mv.from)) m.set(mv.from, []);
    m.get(mv.from).push(mv.to);
  }
  return m;
}

export function isPromotion(chess, from, to) {
  const p = chess.get(from);
  return !!p && p.type === 'p' && (to[1] === '8' || to[1] === '1');
}

// Small in-page promotion chooser. Resolves with 'q' | 'r' | 'b' | 'n'.
export function pickPromotion(host, color) {
  return new Promise((resolve) => {
    const glyph = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
    const names = { q: 'מלכה', r: 'צריח', b: 'רץ', n: 'פרש' };
    const box = document.createElement('div');
    box.className = 'promo';
    box.innerHTML = '<div class="promo-card"><div class="promo-title">למה להכתיר?</div><div class="promo-row"></div></div>';
    const row = box.querySelector('.promo-row');
    for (const k of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'promo-btn';
      b.innerHTML = `<span class="promo-glyph">${glyph[k]}</span><span>${names[k]}</span>`;
      b.addEventListener('click', () => {
        box.remove();
        resolve(k);
      });
      row.appendChild(b);
    }
    host.appendChild(box);
  });
}

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (ms < 20000) return `${m}:${pad(s)}.${Math.floor((ms % 1000) / 100)}`;
  return `${m}:${pad(s)}`;
}

// White-point-of-view evaluation -> share of the bar that is white (0..100).
export function evalToPercent(ev) {
  if (!ev) return 50;
  if (ev.mate != null) return ev.mate > 0 ? 100 : 0;
  const cp = Math.max(-1500, Math.min(1500, ev.cp || 0));
  const win = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
  return Math.max(3, Math.min(97, 50 + 50 * win));
}
export function evalLabel(ev) {
  if (!ev) return '0.0';
  if (ev.mate != null) return 'M' + Math.abs(ev.mate);
  const v = Math.abs(ev.cp || 0) / 100;
  return v.toFixed(1);
}
export function evalAdvantage(ev) {
  // 'w' | 'b' | null
  if (!ev) return null;
  if (ev.mate != null) return ev.mate > 0 ? 'w' : 'b';
  if (!ev.cp) return null;
  return ev.cp > 0 ? 'w' : 'b';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const STATE_KEY = 'cf:display-state';
export const CHANNEL = 'chess-final';
