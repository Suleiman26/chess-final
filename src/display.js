import { Chessground } from '@lichess-org/chessground';
import qrcode from 'qrcode-generator';
import { rpc, moveRows, figurine, fmtClock, evalToPercent, evalLabel, evalAdvantage, sideHeTo, escapeHtml, STATE_KEY, CHANNEL } from './common.js';

const $ = (id) => document.getElementById(id);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let S = null;
let lastQrId = null;
let lastIntroKey = null;
let lastFen = null;

const cg = Chessground($('board'), {
  fen: START,
  viewOnly: true,
  coordinates: true,
  animation: { enabled: true, duration: 300 },
  highlight: { lastMove: true, check: true },
  drawable: { enabled: false, visible: false },
});

function renderMoves(sans, startFen) {
  const el = $('moves');
  const tail = moveRows(sans, startFen).slice(-9);
  el.innerHTML = tail
    .map(
      (r, idx) =>
        `<div class="mv-row${idx === tail.length - 1 ? ' last' : ''}"><span class="mv-n">${r.n}.</span><span class="mv">${r.w ? escapeHtml(figurine(r.w, 'w')) : '…'}</span><span class="mv">${r.b ? escapeHtml(figurine(r.b, 'b')) : ''}</span></div>`,
    )
    .join('');
  $('moves-empty').hidden = sans.length > 0 || !!startFen;
}

function renderEval(ev) {
  const pct = evalToPercent(ev);
  $('eval-fill').style.height = pct + '%';
  const adv = evalAdvantage(ev);
  const lab = $('eval-label');
  lab.textContent = ev ? evalLabel(ev) : '';
  lab.className = 'eval-label ' + (adv === 'b' ? 'top' : 'bottom');
}

function tpVisible() {
  const tp = S && S.tp;
  if (!tp || !tp.show) return false;
  if (tp.hideAt && Date.now() > tp.hideAt) return false;
  return true;
}

function renderTp() {
  const tp = S && S.tp;
  const vis = tpVisible();
  $('tp').hidden = !vis;
  $('moves-box').hidden = vis;
  if (!vis) return;
  if (lastQrId !== tp.id) {
    lastQrId = tp.id;
    const qr = qrcode(0, 'M');
    qr.addData(tp.url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  $('tp-side').textContent = sideHeTo(tp.side);
  $('tp-chip').className = 'chip ' + (tp.side === 'w' ? 'white' : 'black');
  const st = tp.stats || {};
  $('tp-stats').innerHTML = `<span><b>${st.participants || 0}</b> משתתפים</span><span><b>${st.solved || 0}</b> הצליחו</span>`;
  const introKey = tp.id + ':' + (tp.shownKey || tp.shownAt || 0);
  if (introKey !== lastIntroKey) {
    lastIntroKey = introKey;
    if (Date.now() - (tp.shownAt || 0) < 8000) {
      const intro = $('intro');
      intro.classList.remove('play');
      void intro.offsetWidth;
      intro.classList.add('play');
    }
  }
}

function render() {
  if (!S) return;
  $('waiting').hidden = true;
  $('title').textContent = S.title || '';
  $('name-w').textContent = S.white || 'לבן';
  $('name-b').textContent = S.black || 'שחור';
  if (S.fen !== lastFen) {
    lastFen = S.fen;
    cg.set({
      fen: S.fen,
      lastMove: S.lastMove || undefined,
      check: !!S.check,
      turnColor: S.turn === 'w' ? 'white' : 'black',
    });
  }
  renderEval(S.ev);
  renderMoves(S.sans || [], S.startFen || null);
  const res = $('result');
  res.hidden = !S.result;
  if (S.result) res.textContent = S.result === '1-0' ? `ניצחון ל${S.white || 'לבן'}` : S.result === '0-1' ? `ניצחון ל${S.black || 'שחור'}` : 'תיקו';
  renderTp();
  tick();
}

function tick() {
  if (!S) return;
  const c = S.clock || { w: 0, b: 0, running: false, ts: 0 };
  const over = !!S.result;
  for (const side of ['w', 'b']) {
    let ms = c[side];
    if (c.running && !over && S.turn === side) ms -= Date.now() - c.ts;
    $('clock-' + side).textContent = fmtClock(ms);
    const card = $('card-' + side);
    card.classList.toggle('active', !over && S.turn === side);
    card.classList.toggle('low', ms < 30000);
  }
  const vis = tpVisible();
  if ($('tp').hidden === vis) renderTp();
}

let source = null; // 'local' | 'remote'
let lastLocalAt = 0;
let lastRemoteRev = 0;

function applyLocal(state) {
  if (!state || !state.fen) return;
  if (S && source === 'local' && state.rev && S.rev && state.rev < S.rev) return;
  lastLocalAt = Date.now();
  source = 'local';
  S = state;
  render();
}

// State that arrived through the server from a control page on another device:
// re-anchor every timestamp to this device's clock.
function applyRemote(state, ageMs) {
  if (!state || !state.fen) return;
  if (Date.now() - lastLocalAt < 3000) return;
  lastRemoteRev = state.rev;
  if (S && state.rev === S.rev) return;
  if (S && source === 'local' && state.rev < S.rev) return;
  const sent = state.sentAt || state.rev;
  const delta = Date.now() - (sent + (ageMs || 0));
  if (state.clock && state.clock.ts) state.clock.ts += delta;
  if (state.tp) {
    state.tp.shownKey = state.tp.shownAt;
    if (state.tp.shownAt) state.tp.shownAt += delta;
    if (state.tp.hideAt) state.tp.hideAt += delta;
  }
  source = 'remote';
  S = state;
  render();
}

let lastNetOk = Date.now();
async function poll() {
  try {
    const r = await rpc('get_live', { p_rev: lastRemoteRev });
    lastNetOk = Date.now();
    if (r && r.state) applyRemote(r.state, Number(r.age_ms) || 0);
  } catch (e) {}
  $('net').hidden = Date.now() - lastNetOk < 6000 || Date.now() - lastLocalAt < 6000;
  setTimeout(poll, 700);
}

try {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) {
    const st = JSON.parse(raw);
    if (st && st.rev && Date.now() - st.rev < 30000) applyLocal(st);
  }
} catch (e) {}
window.addEventListener('storage', (e) => {
  if (e.key === STATE_KEY && e.newValue) {
    try {
      applyLocal(JSON.parse(e.newValue));
    } catch (err) {}
  }
});
try {
  const bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e) => applyLocal(e.data);
  bc.postMessage({ hello: true });
} catch (e) {}
poll();
setInterval(tick, 200);

$('fs').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
});
