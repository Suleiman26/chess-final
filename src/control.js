import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import qrcode from 'qrcode-generator';
import { Engine } from './engine.js';
import { rpc, moveRows, figurine, legalDests, isPromotion, pickPromotion, fmtClock, evalToPercent, evalLabel, evalAdvantage, sideHe, sideHeTo, escapeHtml, STATE_KEY, CHANNEL } from './common.js';
import { PUBLIC_BASE } from './config.js';

const GAME_KEY = 'cf:game';
const ADMIN_KEY = 'cf:admin';
const $ = (id) => document.getElementById(id);

// ---------- state ----------
function freshGame(prev) {
  const p = prev || {};
  const baseMin = p.baseMin ?? 15;
  return {
    gameId: 'g' + Date.now().toString(36),
    title: p.title ?? 'גמר טורניר השחמט',
    white: p.white ?? 'לבן',
    black: p.black ?? 'שחור',
    baseMin,
    incSec: p.incSec ?? 10,
    threshold: p.detect === 'swing' ? p.threshold ?? 2 : 2,
    uniqGap: p.uniqGap ?? 1.5,
    detect: 'swing',
    tpFens: [],
    autoHideSec: p.autoHideSec ?? 180,
    autoTp: p.autoTp ?? true,
    sans: [],
    startFen: null,
    clock: { w: baseMin * 60000, b: baseMin * 60000, running: false, ts: 0 },
    tp: null,
    ev: null,
    result: '',
  };
}
function loadGame() {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (raw) {
      const g = JSON.parse(raw);
      if (g && Array.isArray(g.sans)) {
        const out = Object.assign(freshGame(g), g);
        if (g.detect !== 'swing') {
          out.detect = 'swing';
          out.threshold = 2;
        }
        if (!Array.isArray(out.tpFens)) out.tpFens = [];
        return out;
      }
    }
  } catch (e) {}
  return freshGame();
}
let G = loadGame();
let chess = new Chess();
function rebuild() {
  try {
    chess = G.startFen ? new Chess(G.startFen) : new Chess();
  } catch (e) {
    G.startFen = null;
    chess = new Chess();
  }
  const ok = [];
  for (const s of G.sans) {
    try {
      chess.move(s);
      ok.push(s);
    } catch (e) {
      break;
    }
  }
  G.sans = ok;
}
rebuild();

function save() {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(G));
  } catch (e) {}
}

let bc = null;
try {
  bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e) => {
    if (e.data && e.data.hello) publish();
  };
} catch (e) {}

function autoResult() {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0';
  if (chess.isGameOver()) return '½-½';
  return G.result || '';
}

function publish() {
  const h = chess.history({ verbose: true });
  const last = h[h.length - 1];
  const tp = G.tp;
  const state = {
    rev: Date.now(),
    title: G.title,
    white: G.white,
    black: G.black,
    fen: chess.fen(),
    lastMove: last ? [last.from, last.to] : null,
    check: chess.inCheck(),
    turn: chess.turn(),
    sans: G.sans,
    startFen: G.startFen || null,
    ev: G.ev,
    clock: G.clock,
    result: autoResult(),
    tp: tp ? { id: tp.id, url: tp.url, side: tp.side, moveNo: tp.moveNo, show: tp.show, hideAt: tp.hideAt, shownAt: tp.shownAt, stats: tp.stats } : null,
  };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {}
  if (bc) bc.postMessage(state);
  queueRemote(state);
}

// ---------- remote sync (display on another device) ----------
let remoteBusy = false;
let remotePending = null;
let remoteNextAt = 0;
let remoteTimer = null;
function setSync(ok) {
  const pill = $('pill-sync');
  pill.className = 'pill ' + (ok ? 'ok' : 'bad');
  pill.textContent = ok ? 'המסך מסונכרן' : 'אין סנכרון למסך';
}
function queueRemote(state) {
  remotePending = state;
  pumpRemote();
}
async function pumpRemote() {
  if (remoteBusy || !remotePending || !serverOk) return;
  const wait = remoteNextAt - Date.now();
  if (wait > 0) {
    if (!remoteTimer)
      remoteTimer = setTimeout(() => {
        remoteTimer = null;
        pumpRemote();
      }, wait);
    return;
  }
  const st = remotePending;
  remotePending = null;
  remoteBusy = true;
  let ok = false;
  try {
    st.sentAt = Date.now();
    const r = await rpc('admin_set_live', { p_key: adminKey(), p_state: st });
    ok = !!(r && r.ok);
  } catch (e) {}
  setSync(ok);
  remoteBusy = false;
  if (ok) {
    remoteNextAt = Date.now() + 300;
  } else {
    remoteNextAt = Date.now() + 1500;
    if (!remotePending) remotePending = st;
  }
  if (remotePending) pumpRemote();
}

// ---------- admin key / server ----------
function adminKey() {
  try {
    return localStorage.getItem(ADMIN_KEY) || '';
  } catch (e) {
    return '';
  }
}
let serverOk = false;
async function checkKey() {
  const key = adminKey();
  const pill = $('pill-server');
  $('key-card').hidden = !!key;
  if (!key) {
    serverOk = false;
    pill.className = 'pill bad';
    pill.textContent = 'חסר קוד מנהל';
    return;
  }
  pill.className = 'pill';
  pill.textContent = 'מתחבר…';
  try {
    const ok = await rpc('admin_check', { p_key: key });
    serverOk = ok === true;
    pill.className = 'pill ' + (serverOk ? 'ok' : 'bad');
    pill.textContent = serverOk ? 'מחובר לשרת' : 'קוד מנהל שגוי';
    $('key-card').hidden = serverOk;
    if (serverOk) {
      refreshStats();
      publish();
    }
  } catch (e) {
    serverOk = false;
    pill.className = 'pill bad';
    pill.textContent = 'אין חיבור לשרת';
  }
}
(function initKey() {
  const m = location.hash.match(/key=([a-z0-9]+)/i);
  if (m) {
    try {
      localStorage.setItem(ADMIN_KEY, m[1]);
    } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
})();

// ---------- board ----------
const cg = Chessground($('board'), {
  coordinates: true,
  movable: { free: false, color: 'white', showDests: true, events: { after: onBoardMove } },
  events: { select: (key) => onSelectSquare(key) },
  premovable: { enabled: false },
  draggable: { enabled: true, showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { enabled: true, duration: 180 },
  drawable: { enabled: false, visible: true },
});

function syncBoard() {
  const h = chess.history({ verbose: true });
  const last = h[h.length - 1];
  const over = !!autoResult();
  const color = chess.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: chess.fen(),
    turnColor: color,
    lastMove: last ? [last.from, last.to] : undefined,
    check: chess.inCheck(),
    movable: { color: over ? undefined : color, dests: over ? new Map() : legalDests(chess) },
  });
}

async function onBoardMove(orig, dest) {
  if (setupMode) return;
  let promotion;
  if (isPromotion(chess, orig, dest)) promotion = await pickPromotion($('board-box'), chess.turn());
  applyMove({ from: orig, to: dest, promotion });
}

function applyMove(m) {
  if (setupMode) return false;
  if (autoResult()) {
    syncBoard();
    return false;
  }
  const mover = chess.turn();
  clockTick();
  let mv;
  try {
    mv = chess.move(m);
  } catch (e) {
    syncBoard();
    return false;
  }
  if (G.clock.running) G.clock[mover] += G.incSec * 1000;
  G.sans.push(mv.san);
  lastAction = 'move';
  if (chess.isGameOver()) G.clock.running = false;
  positionChanged();
  return true;
}

function undoMove() {
  if (setupMode || !G.sans.length) return;
  clockTick();
  chess.undo();
  G.sans.pop();
  lastAction = 'undo';
  G.result = '';
  $('result').value = '';
  positionChanged();
}

function positionChanged() {
  save();
  syncBoard();
  renderMoves();
  renderClockInputs();
  analyze();
  publish();
}

function renderMoves() {
  const out = moveRows(G.sans, G.startFen).map(
    (r) => `<span class="mvp"><i>${r.n}.</i> ${r.w ? escapeHtml(figurine(r.w, 'w')) : '…'} ${r.b ? escapeHtml(figurine(r.b, 'b')) : ''}</span>`,
  );
  $('moves').innerHTML = out.join(' ') || `<span class="muted">${G.startFen ? 'ממשיכים מהפוזיציה שסודרה' : 'עדיין אין מהלכים'}</span>`;
  $('moves').scrollTop = $('moves').scrollHeight;
  $('turn').textContent = autoResult() ? 'המשחק הסתיים' : `תור ${sideHe(chess.turn())} · מהלך ${chess.moveNumber()}`;
}

// ---------- position setup (jump straight to the position on the real board) ----------
let setupMode = false;
function setupNote(text) {
  $('setup-note').textContent = text || '';
}
let palettePick = null; // { role, color } | 'erase' | null
function buildPalette() {
  const host = $('palette');
  if (host.childElementCount) return;
  const items = [
    ['♔', 'king', 'white'], ['♕', 'queen', 'white'], ['♖', 'rook', 'white'], ['♗', 'bishop', 'white'], ['♘', 'knight', 'white'], ['♙', 'pawn', 'white'],
    ['♚', 'king', 'black'], ['♛', 'queen', 'black'], ['♜', 'rook', 'black'], ['♝', 'bishop', 'black'], ['♞', 'knight', 'black'], ['♟︎', 'pawn', 'black'],
  ];
  const mk = (label, pick, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pal ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', () => {
      const same = palettePick === pick;
      palettePick = same ? null : pick;
      for (const x of host.children) x.classList.remove('on');
      if (!same) b.classList.add('on');
    });
    host.appendChild(b);
  };
  for (const [g, role, color] of items) mk(g, { role, color }, color);
  mk('מחק', 'erase', 'erase');
}
function onSelectSquare(key) {
  if (!setupMode || !palettePick) return;
  const m = new Map();
  m.set(key, palettePick === 'erase' ? undefined : { role: palettePick.role, color: palettePick.color });
  cg.setPieces(m);
  cg.cancelMove();
}
function setupReset(kind) {
  cg.set({ fen: kind === 'empty' ? '8/8/8/8/8/8/8/8' : 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', lastMove: undefined });
}
function enterSetup() {
  if (setupMode) return;
  buildPalette();
  palettePick = null;
  for (const x of $('palette').children) x.classList.remove('on');
  setupMode = true;
  engine.cancel();
  clockTick();
  G.clock.running = false;
  save();
  publish();
  $('setup-bar').hidden = false;
  $('setup-start').hidden = true;
  $('setup-no').value = chess.moveNumber();
  setupNote('');
  cg.set({
    autoCastle: false,
    lastMove: undefined,
    check: false,
    movable: { free: true, color: 'both', showDests: false },
    draggable: { deleteOnDropOff: true },
  });
  cg.setAutoShapes([]);
}
function exitSetup() {
  setupMode = false;
  $('setup-bar').hidden = true;
  $('setup-start').hidden = false;
  cg.set({ autoCastle: true, movable: { free: false, showDests: true }, draggable: { deleteOnDropOff: false } });
}
function finishSetup(turn) {
  const placement = cg.getFen();
  const no = Math.max(1, Math.min(300, parseInt($('setup-no').value, 10) || 1));
  let c;
  try {
    c = new Chess(`${placement} ${turn} - - 0 ${no}`);
  } catch (e) {
    setupNote('הפוזיציה לא חוקית: צריך מלך אחד בדיוק לכל צד, ואין רגלים בשורה הראשונה או האחרונה.');
    return;
  }
  try {
    const opp = new Chess(`${placement} ${turn === 'w' ? 'b' : 'w'} - - 0 ${no}`);
    if (opp.inCheck()) {
      setupNote(`הפוזיציה לא אפשרית: המלך של ${turn === 'w' ? 'השחור' : 'הלבן'} בשח בזמן שהתור של הצד השני. בדקו את הכלים או את התור.`);
      return;
    }
  } catch (e) {}
  for (const color of ['w', 'b']) {
    const n = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    for (const row of c.board()) for (const pc of row) if (pc && pc.color === color) n[pc.type]++;
    const total = n.p + n.n + n.b + n.r + n.q + n.k;
    const extra = Math.max(0, n.q - 1) + Math.max(0, n.r - 2) + Math.max(0, n.b - 2) + Math.max(0, n.n - 2);
    if (total > 16 || n.p > 8 || extra > 8 - n.p) {
      setupNote(`יש יותר מדי כלים ל${color === 'w' ? 'לבן' : 'שחור'} (${total} כלים, ${n.p} רגלים). בדקו שלא נשאר כלי שכבר נלקח.`);
      return;
    }
  }
  const is = (sq, type, color) => {
    const p = c.get(sq);
    return !!p && p.type === type && p.color === color;
  };
  let rights = '';
  if (is('e1', 'k', 'w') && is('h1', 'r', 'w')) rights += 'K';
  if (is('e1', 'k', 'w') && is('a1', 'r', 'w')) rights += 'Q';
  if (is('e8', 'k', 'b') && is('h8', 'r', 'b')) rights += 'k';
  if (is('e8', 'k', 'b') && is('a8', 'r', 'b')) rights += 'q';
  const fen = `${placement} ${turn} ${rights || '-'} - 0 ${no}`;
  try {
    new Chess(fen);
  } catch (e) {
    setupNote('הפוזיציה לא חוקית.');
    return;
  }
  G.startFen = fen;
  G.sans = [];
  G.result = '';
  G.ev = null;
  lastAction = 'setup';
  $('result').value = '';
  exitSetup();
  rebuild();
  positionChanged();
}
function cancelSetup() {
  exitSetup();
  syncBoard();
  analyze();
}

// ---------- clocks ----------
function clockTick() {
  const c = G.clock;
  if (!c.running) return;
  const now = Date.now();
  const t = chess.turn();
  c[t] = Math.max(0, c[t] - (now - c.ts));
  c.ts = now;
}
function clockNow(side) {
  const c = G.clock;
  let ms = c[side];
  if (c.running && chess.turn() === side) ms -= Date.now() - c.ts;
  return Math.max(0, ms);
}
function renderClocks() {
  $('clk-w').textContent = fmtClock(clockNow('w'));
  $('clk-b').textContent = fmtClock(clockNow('b'));
  $('clk-w').classList.toggle('on', G.clock.running && chess.turn() === 'w');
  $('clk-b').classList.toggle('on', G.clock.running && chess.turn() === 'b');
  $('clock-toggle').textContent = G.clock.running ? 'השהה שעון' : 'הפעל שעון';
  $('clock-toggle').classList.toggle('primary', !G.clock.running);
}
function toMmSs(ms) {
  const t = Math.round(ms / 1000);
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
function parseMmSs(s) {
  const m = String(s).trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!m) return null;
  return (parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0)) * 1000;
}
function renderClockInputs() {
  if (document.activeElement !== $('set-w')) $('set-w').value = toMmSs(clockNow('w'));
  if (document.activeElement !== $('set-b')) $('set-b').value = toMmSs(clockNow('b'));
}

// ---------- engine ----------
let analysis = { fen: null, lines: null, done: false };
let waitingManual = false;
const engine = new Engine('engine/stockfish-19-lite-single.js', (st) => {
  const pill = $('pill-engine');
  pill.className = 'pill ' + (st === 'ready' ? 'ok' : 'bad');
  pill.textContent = st === 'ready' ? 'המנוע פועל' : st === 'restart' ? 'המנוע מופעל מחדש…' : 'תקלה במנוע';
});

function toWhite(rec, turn) {
  const sign = turn === 'w' ? 1 : -1;
  return rec.mate != null ? { mate: rec.mate * sign } : { cp: rec.cp * sign };
}
function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined }).san;
  } catch (e) {
    return uci;
  }
}
function pvToSan(fen, pv, max) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      const color = c.turn();
      out.push(figurine(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }).san, color));
    } catch (e) {
      break;
    }
  }
  return out.join(' ');
}

function renderEval() {
  const ev = G.ev;
  $('eval-fill').style.height = evalToPercent(ev) + '%';
  const adv = evalAdvantage(ev);
  const lab = $('eval-label');
  lab.textContent = ev ? evalLabel(ev) : '';
  lab.className = 'eval-label ' + (adv === 'b' ? 'top' : 'bottom');
  $('eval-text').textContent = ev ? (adv === 'w' ? 'יתרון ללבן ' : adv === 'b' ? 'יתרון לשחור ' : 'שוויון ') + (ev.mate != null ? `(מט ב־${Math.abs(ev.mate)})` : `(${evalLabel(ev)})`) : 'מחשב…';
}

function analyze() {
  if (postRunning) return;
  const fen = chess.fen();
  const turn = chess.turn();
  analysis = { fen, lines: null, done: false };
  $('engine-line').textContent = '';
  if (chess.isGameOver()) {
    engine.cancel();
    if (chess.isCheckmate()) G.ev = { mate: turn === 'w' ? -1 : 1 };
    else G.ev = { cp: 0 };
    renderEval();
    $('eval-text').textContent = chess.isCheckmate() ? 'מט' : 'תיקו';
    return;
  }
  engine.analyze({
    fen,
    movetime: 3000,
    onInfo: (rec) => {
      if (rec.depth < 10) return;
      if (rec.depth >= 12) rememberEval(fen, turn, rec);
      G.ev = toWhite(rec, turn);
      renderEval();
      $('engine-line').textContent = `עומק ${rec.depth}: ${pvToSan(fen, rec.pv, 5)}`;
      publish();
    },
    onFail: () => {
      $('eval-text').textContent = 'המנוע לא הצליח לנתח את הפוזיציה';
    },
    onDone: (lines) => {
      analysis = { fen, lines, done: true };
      if (lines[1]) rememberEval(fen, turn, lines[1]);
      const l1 = lines[1];
      if (l1) {
        G.ev = toWhite(l1, turn);
        renderEval();
        $('engine-line').textContent = `עומק ${l1.depth}: ${pvToSan(fen, l1.pv, 5)}`;
      }
      if (!l1) $('eval-text').textContent = 'המנוע לא הצליח לנתח את הפוזיציה';
      save();
      publish();
      if (waitingManual) {
        waitingManual = false;
        if (l1) createTurningPoint(fen, turn, lines, true);
      } else {
        checkTurningPoint(fen, turn, lines);
      }
    },
  });
}

// ---------- turning points ----------
// A turning point = the move just played swung the evaluation by at least
// G.threshold pawns in favour of the side to move (wherever it started, also when
// the advantage flips sides), and the side to move now has one clearly best move.
let lastAction = 'load'; // 'move' | 'undo' | 'setup' | 'load'
const evalCache = new Map(); // fen -> { w: pawns from White's view, clamped to ±10; depth }
function pawnsMover(rec) {
  // swing scale: a mate counts as a full 10 pawns, so "winning -> still winning" is no swing
  if (rec.mate != null) return rec.mate > 0 ? 10 : -10;
  return Math.max(-10, Math.min(10, rec.cp / 100));
}
function uniqScore(rec) {
  // uniqueness scale: a mate beats any non-mating move clearly
  if (rec.mate != null) return rec.mate > 0 ? 15 : -15;
  return Math.max(-10, Math.min(10, rec.cp / 100));
}
function rememberEval(fen, turn, rec) {
  const old = evalCache.get(fen);
  if (old && old.depth > rec.depth) return;
  const m = pawnsMover(rec);
  evalCache.set(fen, { w: turn === 'w' ? m : -m, depth: rec.depth });
  if (evalCache.size > 400) evalCache.delete(evalCache.keys().next().value);
}
function fmtPawns(x) {
  return (x > 0 ? '+' : '') + x.toFixed(1);
}
function checkTurningPoint(fen, turn, lines) {
  const best = lines[1];
  const second = lines[2];
  const el = $('tp-last');
  if (!best || lastAction !== 'move') return;
  const h = chess.history({ verbose: true });
  const last = h[h.length - 1];
  if (!last) return;
  const prev = evalCache.get(last.before);
  if (!prev) {
    el.textContent = 'בדיקה אחרונה: הפוזיציה הקודמת לא נותחה (מהלכים הוזנו מהר מדי)';
    return;
  }
  const before = turn === 'w' ? prev.w : -prev.w;
  const now = pawnsMover(best);
  const swing = now - before;
  const gap = second ? uniqScore(best) - uniqScore(second) : 0;
  const ok = swing >= G.threshold && !!second && gap >= G.uniqGap;
  el.textContent = `בדיקה אחרונה (${sideHe(turn)} בתור): קפיצה ${fmtPawns(swing)} · פער מהמהלך השני ${second ? gap.toFixed(1) : '-'}${ok ? ' ✓' : ''}`;
  if (!G.autoTp || !ok) return;
  if (G.tpFens.includes(fen)) return;
  G.tpFens.push(fen);
  if (G.tpFens.length > 200) G.tpFens.shift();
  save();
  createTurningPoint(fen, turn, lines, false);
}
function computeAccepted(lines) {
  const best = lines[1];
  const acc = [best.pv[0]];
  for (const k of [2, 3]) {
    const l = lines[k];
    if (!l || !l.pv || !l.pv[0] || acc.includes(l.pv[0])) continue;
    if (l.depth < best.depth - 1) continue;
    if (best.mate != null) {
      if (best.mate > 0 && l.mate != null && l.mate > 0 && l.mate <= best.mate) acc.push(l.pv[0]);
    } else if (l.cp != null && l.cp >= best.cp - 40) {
      acc.push(l.pv[0]);
    }
  }
  return acc;
}
function publicBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') return new URL('./', location.href).href;
  return PUBLIC_BASE;
}
function tpNote(kind, text) {
  const el = $('tp-note');
  el.className = 'note ' + (kind || '');
  el.textContent = text || '';
}
let lastTpArgs = null;
async function createTurningPoint(fen, turn, lines, manual) {
  const key = adminKey();
  lastTpArgs = [fen, turn, lines, manual];
  if (!key) {
    if (!manual) G.tpFens = G.tpFens.filter((f) => f !== fen);
    tpNote('bad', 'לא ניתן ליצור נקודת תפנית בלי קוד מנהל.');
    return;
  }
  tpNote('', 'יוצר נקודת תפנית…');
  const best = lines[1];
  const bestUci = best.pv[0];
  const bestSan = uciToSan(fen, bestUci);
  const accepted = computeAccepted(lines);
  const moveNo = parseInt(fen.split(' ')[5], 10) || 0;
  try {
    const r = await rpc('admin_create_puzzle', {
      p_key: key,
      p_game: G.gameId,
      p_white: G.white,
      p_black: G.black,
      p_fen: fen,
      p_side: turn,
      p_move_no: moveNo,
      p_best_uci: bestUci,
      p_best_san: bestSan,
      p_accepted: accepted,
      p_eval_cp: best.cp,
      p_mate: best.mate,
    });
    if (!r || !r.id) throw new Error((r && r.error) || 'server');
    const now = Date.now();
    G.tp = {
      id: r.id,
      url: publicBase() + '?p=' + r.id,
      side: turn,
      moveNo,
      bestSan,
      bestUci,
      accepted,
      fen,
      show: true,
      shownAt: now,
      hideAt: G.autoHideSec > 0 ? now + G.autoHideSec * 1000 : 0,
      stats: { opened: 0, participants: 0, solved: 0 },
    };
    lastTpArgs = null;
    tpNote('ok', manual ? 'נקודת תפנית נוצרה ידנית.' : 'נקודת תפנית זוהתה והוצגה על המסך.');
    save();
    publish();
    renderTp();
    refreshStats();
  } catch (e) {
    if (!manual) G.tpFens = G.tpFens.filter((f) => f !== fen);
    save();
    tpNote('bad', 'יצירת נקודת התפנית נכשלה (בעיית חיבור?).');
    $('tp-retry').hidden = false;
  }
}

function tpIsVisible() {
  const tp = G.tp;
  return !!tp && tp.show && (!tp.hideAt || Date.now() < tp.hideAt);
}
let lastTpQr = null;
function renderTp() {
  const tp = G.tp;
  $('tp-empty').hidden = !!tp;
  $('tp-current').hidden = !tp;
  $('tp-retry').hidden = !lastTpArgs;
  $('auto-state').textContent = G.autoTp ? `זיהוי אוטומטי פעיל (קפיצה ${G.threshold}+)` : 'זיהוי אוטומטי כבוי';
  if (!tp) return;
  if (lastTpQr !== tp.id) {
    lastTpQr = tp.id;
    const qr = qrcode(0, 'M');
    qr.addData(tp.url);
    qr.make();
    $('tp-qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  }
  $('tp-info').innerHTML = `מהלך ${tp.moveNo} · תור <b>${sideHe(tp.side)}</b><br>המהלך הכי טוב: <b dir="ltr">${escapeHtml(figurine(tp.bestSan, tp.side))}</b>${tp.accepted && tp.accepted.length > 1 ? ` <span class="muted">(מתקבלים גם: <span dir="ltr">${tp.accepted.slice(1).map((u) => escapeHtml(figurine(uciToSan(tp.fen, u), tp.side))).join(', ')}</span>)</span>` : ''}`;
  $('tp-link').textContent = tp.url;
  $('tp-link').href = tp.url;
  const vis = tpIsVisible();
  $('tp-vis').textContent = vis ? 'מוצג כעת על המסך' : 'מוסתר מהמסך';
  $('tp-vis').className = 'pill ' + (vis ? 'ok' : '');
  $('tp-toggle').textContent = vis ? 'הסתר מהמסך' : 'הצג שוב על המסך';
}

// ---------- stats ----------
let statsRows = [];
let statsBusy = false;
async function refreshStats() {
  if (!serverOk || statsBusy) return;
  statsBusy = true;
  try {
    const r = await rpc('admin_stats', { p_key: adminKey() });
    if (r && Array.isArray(r.puzzles)) {
      statsRows = r.puzzles;
      renderStats();
      if (G.tp) {
        const row = statsRows.find((x) => x.id === G.tp.id);
        if (row) {
          const s = G.tp.stats || {};
          if (s.opened !== row.opened || s.participants !== row.participants || s.solved !== row.solved) {
            G.tp.stats = { opened: row.opened, participants: row.participants, solved: row.solved };
            save();
            publish();
          }
        }
      }
      $('stats-time').textContent = 'עודכן ' + new Date().toLocaleTimeString('he-IL');
    }
  } catch (e) {
    $('stats-time').textContent = 'אין חיבור - מנסה שוב';
  }
  statsBusy = false;
}
function statsFiltered() {
  return $('stats-all').checked ? statsRows : statsRows.filter((r) => r.game_id === G.gameId);
}
function renderStats() {
  const rows = statsFiltered();
  const body = $('stats-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">עדיין אין נקודות תפנית במשחק הזה</td></tr>';
    $('stats-total').textContent = '';
    return;
  }
  let tp = 0;
  let ts = 0;
  body.innerHTML = rows
    .map((r, i) => {
      tp += r.participants;
      ts += r.solved;
      const pct = r.participants ? Math.round((100 * r.solved) / r.participants) + '%' : '-';
      return `<tr><td>${i + 1}</td><td>${r.move_no} · ${sideHe(r.side)}</td><td dir="ltr">${escapeHtml(figurine(r.best_san, r.side))}</td><td>${r.opened}</td><td><b>${r.participants}</b></td><td><b>${r.solved}</b></td><td>${pct}</td></tr>`;
    })
    .join('');
  $('stats-total').textContent = `סה״כ: ${tp} השתתפויות, ${ts} הצלחות`;
}
function statsText() {
  const rows = statsFiltered();
  const lines = [`${G.title} - ${G.white} נגד ${G.black}`, 'נקודת תפנית | מהלך | תור | המהלך הכי טוב | סרקו | השתתפו | הצליחו'];
  rows.forEach((r, i) => lines.push(`${i + 1} | ${r.move_no} | ${sideHe(r.side)} | ${r.best_san} | ${r.opened} | ${r.participants} | ${r.solved}`));
  return lines.join('\n');
}

// ---------- wiring ----------
function bindText(id, field, after) {
  const el = $(id);
  el.value = G[field];
  el.addEventListener('input', () => {
    G[field] = el.value;
    save();
    publish();
    if (after) after();
  });
}
function bindNum(id, field, min, max, after) {
  const el = $(id);
  el.value = G[field];
  el.addEventListener('change', () => {
    let v = parseFloat(el.value);
    if (!isFinite(v)) v = G[field];
    v = Math.max(min, Math.min(max, v));
    el.value = v;
    G[field] = v;
    save();
    if (after) after();
  });
}
function fillSettings() {
  for (const [id, f] of [['f-title', 'title'], ['f-white', 'white'], ['f-black', 'black'], ['f-base', 'baseMin'], ['f-inc', 'incSec'], ['f-thr', 'threshold'], ['f-gap', 'uniqGap'], ['f-hide', 'autoHideSec']]) $(id).value = G[f];
  $('f-auto').checked = !!G.autoTp;
  $('result').value = G.result || '';
}

bindText('f-title', 'title');
bindText('f-white', 'white');
bindText('f-black', 'black');
bindNum('f-base', 'baseMin', 1, 600);
bindNum('f-inc', 'incSec', 0, 600);
bindNum('f-thr', 'threshold', 0.5, 20, renderTp);
bindNum('f-gap', 'uniqGap', 0, 20);
bindNum('f-hide', 'autoHideSec', 0, 3600);
$('f-auto').checked = !!G.autoTp;
$('f-auto').addEventListener('change', () => {
  G.autoTp = $('f-auto').checked;
  save();
  renderTp();
});

$('san-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('san');
  const txt = inp.value.trim();
  if (!txt) return;
  let ok = false;
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(txt)) {
    const t = txt.toLowerCase();
    ok = applyMove({ from: t.slice(0, 2), to: t.slice(2, 4), promotion: t[4] || undefined });
  }
  if (!ok) ok = applyMove(txt);
  inp.classList.toggle('err', !ok);
  if (ok) inp.value = '';
});
$('undo').addEventListener('click', undoMove);
$('setup-start').addEventListener('click', enterSetup);
$('setup-white').addEventListener('click', () => finishSetup('w'));
$('setup-black').addEventListener('click', () => finishSetup('b'));
$('setup-cancel').addEventListener('click', cancelSetup);
$('setup-startpos').addEventListener('click', () => setupReset('start'));
$('setup-empty').addEventListener('click', () => setupReset('empty'));

$('clock-toggle').addEventListener('click', () => {
  if (G.clock.running) {
    clockTick();
    G.clock.running = false;
  } else {
    G.clock.ts = Date.now();
    G.clock.running = true;
  }
  save();
  publish();
  renderClocks();
});
$('clock-set').addEventListener('click', () => {
  const w = parseMmSs($('set-w').value);
  const b = parseMmSs($('set-b').value);
  if (w == null || b == null) {
    $('clock-note').textContent = 'כתבו זמן בצורה דקות:שניות, למשל 12:30';
    return;
  }
  $('clock-note').textContent = '';
  G.clock.w = w;
  G.clock.b = b;
  G.clock.ts = Date.now();
  save();
  publish();
  renderClocks();
});

$('result').addEventListener('change', () => {
  G.result = $('result').value;
  if (G.result) {
    clockTick();
    G.clock.running = false;
  }
  save();
  syncBoard();
  renderMoves();
  publish();
});

let newArmed = 0;
$('new-game').addEventListener('click', () => {
  const btn = $('new-game');
  if (Date.now() - newArmed > 4000) {
    newArmed = Date.now();
    btn.textContent = 'לחצו שוב לאישור - המשחק הנוכחי יימחק';
    btn.classList.add('danger');
    setTimeout(() => {
      btn.textContent = 'משחק חדש';
      btn.classList.remove('danger');
    }, 4000);
    return;
  }
  newArmed = 0;
  btn.textContent = 'משחק חדש';
  btn.classList.remove('danger');
  engine.cancel();
  G = freshGame(G);
  postResult = null;
  renderPost();
  postNote('', '');
  $('post-save').hidden = true;
  rebuild();
  lastTpArgs = null;
  tpNote('', '');
  fillSettings();
  positionChanged();
  renderTp();
  renderStats();
});

$('open-display').addEventListener('click', () => {
  window.open('display.html', 'cf-display', 'popup,width=1280,height=720');
  publish();
});

$('tp-manual').addEventListener('click', () => {
  if (chess.isGameOver()) {
    tpNote('bad', 'המשחק הסתיים.');
    return;
  }
  const fen = chess.fen();
  if (analysis.done && analysis.fen === fen && analysis.lines && analysis.lines[1]) {
    createTurningPoint(fen, chess.turn(), analysis.lines, true);
  } else {
    waitingManual = true;
    tpNote('', 'ממתין לסיום חישוב המנוע…');
  }
});
$('tp-retry').addEventListener('click', () => {
  if (lastTpArgs) {
    $('tp-retry').hidden = true;
    createTurningPoint(...lastTpArgs);
  }
});
$('tp-toggle').addEventListener('click', () => {
  if (!G.tp) return;
  if (tpIsVisible()) {
    G.tp.show = false;
  } else {
    const now = Date.now();
    G.tp.show = true;
    G.tp.shownAt = now;
    G.tp.hideAt = G.autoHideSec > 0 ? now + G.autoHideSec * 1000 : 0;
  }
  save();
  publish();
  renderTp();
});
let delArmed = 0;
$('tp-delete').addEventListener('click', async () => {
  if (!G.tp) return;
  const btn = $('tp-delete');
  if (Date.now() - delArmed > 4000) {
    delArmed = Date.now();
    btn.textContent = 'לחצו שוב למחיקה';
    setTimeout(() => (btn.textContent = 'מחק נקודת תפנית (נוצרה בטעות)'), 4000);
    return;
  }
  delArmed = 0;
  btn.textContent = 'מחק נקודת תפנית (נוצרה בטעות)';
  const tp = G.tp;
  try {
    await rpc('admin_delete_puzzle', { p_key: adminKey(), p_id: tp.id });
  } catch (e) {
    tpNote('bad', 'המחיקה נכשלה - בדקו חיבור.');
    return;
  }
  G.tp = null;
  lastTpQr = null;
  tpNote('', 'נקודת התפנית נמחקה.');
  save();
  publish();
  renderTp();
  refreshStats();
});

$('stats-refresh').addEventListener('click', refreshStats);
$('stats-all').addEventListener('change', renderStats);
function copyText(btn, text) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'הועתק ✓';
    setTimeout(() => (btn.textContent = old), 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
}
$('stats-copy').addEventListener('click', () => copyText($('stats-copy'), statsText()));
function pgnResult() {
  return autoResult().replace('½-½', '1/2-1/2') || '*';
}
function gameDate() {
  const d = new Date(parseInt(String(G.gameId).slice(1), 36) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return { iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, pgn: `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}` };
}
function gamePgn() {
  const c = G.startFen ? new Chess(G.startFen) : new Chess();
  c.header('Event', G.title, 'Site', 'חמד״ע', 'Date', gameDate().pgn, 'White', G.white, 'Black', G.black, 'Result', pgnResult());
  if (G.startFen) c.header('SetUp', '1', 'FEN', G.startFen);
  for (const s of G.sans) c.move(s);
  return c.pgn();
}
$('pgn-copy').addEventListener('click', () => copyText($('pgn-copy'), gamePgn()));

// ---------- post-game: interesting positions ----------
let postRunning = false;
let postStop = false;
let postResult = null; // { gameId, positions: [...] }
function analyzeOnce(fen, ms) {
  return new Promise((resolve) => {
    engine.analyze({ fen, movetime: ms, onDone: (lines) => resolve(lines), onFail: () => resolve(null) });
  });
}
function postNote(kind, text) {
  const el = $('post-note');
  el.className = 'note ' + (kind || '');
  el.textContent = text || '';
}
async function runPostAnalysis() {
  if (postRunning) {
    postStop = true;
    return;
  }
  if (!G.sans.length) {
    postNote('bad', 'אין מהלכים לנתח.');
    return;
  }
  if (engine.failed) {
    postNote('bad', 'המנוע לא פועל.');
    return;
  }
  postRunning = true;
  postStop = false;
  engine.cancel();
  $('post-run').textContent = 'עצור ניתוח';
  $('post-list').innerHTML = '';
  $('post-save').hidden = true;
  const c = G.startFen ? new Chess(G.startFen) : new Chess();
  const pos = [{ fen: c.fen(), turn: c.turn() }];
  for (const s of G.sans) {
    c.move(s);
    pos.push({ fen: c.fen(), turn: c.turn(), over: c.isGameOver() });
  }
  const ms = 1500;
  for (let i = 0; i < pos.length; i++) {
    if (postStop) break;
    const left = Math.ceil(((pos.length - i) * ms) / 1000);
    postNote('', `מנתח פוזיציה ${i + 1} מתוך ${pos.length} (עוד כ־${left} שניות)…`);
    $('post-bar').style.width = Math.round((100 * i) / pos.length) + '%';
    if (pos[i].over) continue;
    const cached = analysis.done && analysis.fen === pos[i].fen ? analysis.lines : null;
    pos[i].lines = cached || (await analyzeOnce(pos[i].fen, ms));
  }
  $('post-bar').style.width = '100%';
  const stopped = postStop;
  postRunning = false;
  $('post-run').textContent = 'נתח את המשחק';
  analyze();
  if (stopped) {
    postNote('', 'הניתוח נעצר.');
    $('post-bar').style.width = '0';
    return;
  }
  const cands = [];
  for (let i = 1; i < pos.length; i++) {
    const L = pos[i].lines;
    const P = pos[i - 1].lines;
    if (!L || !L[1] || !P || !P[1] || !L[2]) continue;
    const swing = pawnsMover(L[1]) + pawnsMover(P[1]);
    const gap = uniqScore(L[1]) - uniqScore(L[2]);
    cands.push({ ply: i, swing, gap });
  }
  let pick = cands.filter((x) => x.swing >= G.threshold && x.gap >= G.uniqGap);
  let relaxed = false;
  if (pick.length < 4) {
    const more = cands.filter((x) => !pick.includes(x) && x.swing >= 1 && x.gap >= 1);
    more.sort((a, b) => b.swing + b.gap - (a.swing + a.gap));
    if (more.length) relaxed = true;
    pick = pick.concat(more.slice(0, 4 - pick.length));
  }
  pick.sort((a, b) => b.swing - a.swing);
  pick = pick.slice(0, 10).sort((a, b) => a.ply - b.ply);
  const positions = pick.map((x) => {
    const p = pos[x.ply];
    const best = p.lines[1];
    const bestUci = best.pv[0];
    const played = G.sans[x.ply] || null;
    const bestSan = uciToSan(p.fen, bestUci);
    return {
      ply: x.ply,
      fen: p.fen,
      side: p.turn,
      moveNo: parseInt(p.fen.split(' ')[5], 10) || 0,
      bestUci,
      bestSan,
      line: pvToSan(p.fen, best.pv, 6),
      accepted: computeAccepted(p.lines),
      evalCp: best.cp,
      mate: best.mate,
      swing: Math.round(x.swing * 10) / 10,
      gap: Math.round(x.gap * 10) / 10,
      played,
      playedBest: played === bestSan,
      strong: x.swing >= G.threshold && x.gap >= G.uniqGap,
      puzzleId: null,
    };
  });
  postResult = { gameId: G.gameId, positions };
  renderPost();
  if (!positions.length) {
    postNote('', 'לא נמצאו פוזיציות מעניינות במשחק הזה.');
  } else {
    postNote('ok', `נמצאו ${positions.length} פוזיציות${relaxed ? ' (חלקן פחות חדות - מסומנות)' : ''}. המשחק נשמר בשרת.`);
  }
  $('post-save').hidden = false;
  saveGameToServer();
}
const miniBoards = [];
function renderPost() {
  const host = $('post-list');
  for (const b of miniBoards.splice(0)) b.destroy();
  host.innerHTML = '';
  if (!postResult) return;
  postResult.positions.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'post-item';
    const label = `${p.moveNo}${p.side === 'b' ? '...' : '.'}`;
    item.innerHTML = `
      <div class="post-board board-ltr"><div class="mini"></div></div>
      <div class="post-text">
        <div><b>${idx + 1}.</b> מהלך ${p.moveNo} · תור <b>${sideHe(p.side)}</b>${p.strong ? '' : ' <span class="pill">פחות חדה</span>'}</div>
        <div>המהלך הכי טוב: <b dir="ltr">${escapeHtml(label + ' ' + figurine(p.bestSan, p.side))}</b></div>
        <div class="muted" dir="ltr" style="text-align:right">${escapeHtml(p.line)}</div>
        <div>שוחק בפועל: <b dir="ltr">${p.played ? escapeHtml(figurine(p.played, p.side)) : '-'}</b> ${p.played ? (p.playedBest ? '✓' : '✗') : ''}</div>
        <div class="muted">קפיצה ${p.swing > 0 ? '+' : ''}${p.swing} · פער ${p.gap}</div>
        <div class="row" style="margin-top:6px">
          <button class="btn small" type="button" data-act="puzzle">${p.puzzleId ? 'חידה נוצרה' : 'צור חידה'}</button>
          <button class="btn small" type="button" data-act="fen">העתק FEN</button>
        </div>
        <div class="post-puzzle"></div>
      </div>`;
    host.appendChild(item);
    miniBoards.push(
      Chessground(item.querySelector('.mini'), {
        fen: p.fen,
        orientation: p.side === 'w' ? 'white' : 'black',
        viewOnly: true,
        coordinates: false,
        lastMove: undefined,
        drawable: { enabled: false, visible: true, autoShapes: [{ orig: p.bestUci.slice(0, 2), dest: p.bestUci.slice(2, 4), brush: 'green' }] },
      }),
    );
    const btnP = item.querySelector('[data-act="puzzle"]');
    const showLink = () => {
      if (!p.puzzleId) return;
      const url = publicBase() + '?p=' + p.puzzleId;
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      item.querySelector('.post-puzzle').innerHTML = `<div class="post-qr">${qr.createSvgTag({ cellSize: 2, margin: 1, scalable: true })}</div><a href="${escapeHtml(url)}" target="_blank" rel="noopener" dir="ltr">${escapeHtml(url)}</a>`;
      btnP.textContent = 'חידה נוצרה';
      btnP.disabled = true;
    };
    showLink();
    btnP.addEventListener('click', async () => {
      if (p.puzzleId) return;
      btnP.disabled = true;
      btnP.textContent = 'יוצר…';
      try {
        const r = await rpc('admin_create_puzzle', {
          p_key: adminKey(),
          p_game: G.gameId,
          p_white: G.white,
          p_black: G.black,
          p_fen: p.fen,
          p_side: p.side,
          p_move_no: p.moveNo,
          p_best_uci: p.bestUci,
          p_best_san: p.bestSan,
          p_accepted: p.accepted,
          p_eval_cp: p.evalCp,
          p_mate: p.mate,
        });
        if (!r || !r.id) throw new Error((r && r.error) || 'server');
        p.puzzleId = r.id;
        showLink();
        refreshStats();
        saveGameToServer();
      } catch (e) {
        btnP.disabled = false;
        btnP.textContent = 'צור חידה (נסו שוב)';
      }
    });
    item.querySelector('[data-act="fen"]').addEventListener('click', (e) => copyText(e.currentTarget, p.fen));
  });
}

function positionsMarkdown() {
  const lines = [`# ${G.title}`, '', `**${G.white}** (לבן) נגד **${G.black}** (שחור) · ${gameDate().iso} · תוצאה: ${pgnResult()}`, '', '## פוזיציות מעניינות לחידות', ''];
  const pos = (postResult && postResult.positions) || [];
  if (!pos.length) lines.push('לא נותחו פוזיציות.');
  pos.forEach((p, i) => {
    const url = 'https://lichess.org/analysis/' + p.fen.replace(/ /g, '_');
    lines.push(`### ${i + 1}. מהלך ${p.moveNo}, תור ${sideHe(p.side)}`);
    lines.push('');
    lines.push(`- FEN: \`${p.fen}\``);
    lines.push(`- המהלך הכי טוב: **${p.bestSan}** (המשך: ${p.line})`);
    lines.push(`- שוחק בפועל: ${p.played || '-'}${p.played ? (p.playedBest ? ' ✓' : ' ✗') : ''}`);
    lines.push(`- קפיצה בסולם: ${p.swing}, פער מהמהלך השני: ${p.gap}`);
    if (p.puzzleId) lines.push(`- חידה לתלמידים: ${publicBase()}?p=${p.puzzleId}`);
    lines.push(`- [לוח ניתוח ב-Lichess](${url})`);
    lines.push('');
  });
  lines.push('## PGN', '', '```', gamePgn(), '```', '');
  return lines.join('\n');
}

async function saveGameToServer() {
  if (!serverOk) return false;
  try {
    const r = await rpc('admin_save_game', {
      p_key: adminKey(),
      p_id: G.gameId,
      p_title: G.title,
      p_white: G.white,
      p_black: G.black,
      p_result: pgnResult(),
      p_pgn: gamePgn(),
      p_positions: (postResult && postResult.gameId === G.gameId && postResult.positions) || [],
    });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

// ---------- GitHub ----------
const GH_KEY = 'cf:gh';
function ghConf() {
  try {
    return JSON.parse(localStorage.getItem(GH_KEY) || 'null') || {};
  } catch (e) {
    return {};
  }
}
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function gh(path, opts) {
  const conf = ghConf();
  const res = await fetch('https://api.github.com' + path, {
    method: (opts && opts.method) || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + conf.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  return { status: res.status, data };
}
function ghNote(kind, text) {
  const el = $('gh-note');
  el.className = 'note ' + (kind || '');
  el.textContent = text || '';
}
function renderGh() {
  const conf = ghConf();
  $('gh-repo').value = conf.repo || 'Suleiman26/chess-final';
  $('gh-token').value = '';
  $('gh-token').placeholder = conf.token ? 'מפתח שמור (הדביקו חדש כדי להחליף)' : 'github_pat_…';
  $('gh-state').textContent = conf.token ? `מחובר ל־${conf.repo}` : 'לא הוגדר';
  $('gh-state').className = 'pill ' + (conf.token ? 'ok' : '');
}
async function ghSaveSettings() {
  const conf = ghConf();
  const token = $('gh-token').value.trim() || conf.token;
  const repo = $('gh-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    ghNote('bad', 'חסר מפתח או שם מאגר בצורה משתמש/מאגר.');
    return;
  }
  try {
    localStorage.setItem(GH_KEY, JSON.stringify({ token, repo }));
  } catch (e) {}
  ghNote('', 'בודק…');
  try {
    const r = await gh('/repos/' + repo);
    if (r.status === 200 && r.data && r.data.permissions && r.data.permissions.push) {
      ghNote('ok', 'החיבור תקין: אפשר לשמור משחקים במאגר.');
    } else if (r.status === 200) {
      ghNote('bad', 'המפתח לא מאפשר כתיבה במאגר. צריך הרשאת Contents: Read and write.');
    } else {
      ghNote('bad', 'המאגר לא נמצא או שהמפתח שגוי (קוד ' + r.status + ').');
    }
  } catch (e) {
    ghNote('bad', 'אין חיבור ל-GitHub.');
  }
  renderGh();
}
function slug(s) {
  return String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|#%]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 30);
}
async function ghPut(repo, path, content, message) {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  const cur = await gh(`/repos/${repo}/contents/${enc}`);
  const body = { message, content: b64utf8(content) };
  if (cur.status === 200 && cur.data && cur.data.sha) body.sha = cur.data.sha;
  const r = await gh(`/repos/${repo}/contents/${enc}`, { method: 'PUT', body });
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub ' + r.status + (r.data && r.data.message ? ': ' + r.data.message : ''));
}
async function saveToGithub() {
  const conf = ghConf();
  if (!conf.token) {
    $('gh-card').open = true;
    ghNote('bad', 'קודם צריך להגדיר מפתח GitHub (למטה).');
    return;
  }
  const btn = $('post-save');
  btn.disabled = true;
  btn.textContent = 'שומר…';
  await saveGameToServer();
  const base = `games/${gameDate().iso}_${slug(G.white)}-נגד-${slug(G.black)}_${G.gameId}`;
  try {
    await ghPut(conf.repo, base + '.pgn', gamePgn(), `שמירת משחק: ${G.white} נגד ${G.black}`);
    await ghPut(conf.repo, base + '.md', positionsMarkdown(), `פוזיציות לחידות: ${G.white} נגד ${G.black}`);
    postNote('ok', `נשמר ב-GitHub: ${conf.repo}/${base}.pgn (+ .md)`);
    btn.textContent = 'נשמר ב-GitHub ✓';
    setTimeout(() => {
      btn.textContent = 'שמור ב-GitHub';
      btn.disabled = false;
    }, 4000);
  } catch (e) {
    postNote('bad', 'השמירה ב-GitHub נכשלה: ' + e.message + '. המשחק כן נשמר בשרת.');
    btn.textContent = 'שמור ב-GitHub';
    btn.disabled = false;
  }
}
$('post-run').addEventListener('click', runPostAnalysis);
$('post-save').addEventListener('click', saveToGithub);
$('gh-save').addEventListener('click', ghSaveSettings);
renderGh();

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('key-input').value.trim();
  if (!v) return;
  try {
    localStorage.setItem(ADMIN_KEY, v);
  } catch (err) {}
  checkKey();
});

// ---------- start ----------
fillSettings();
syncBoard();
renderMoves();
renderClocks();
renderClockInputs();
renderEval();
renderTp();
renderStats();
analyze();
publish();
checkKey();
setInterval(() => {
  renderClocks();
  renderTp();
}, 250);
setInterval(() => {
  if (!document.hidden) refreshStats();
}, 5000);
setInterval(() => {
  if (G.clock.running) {
    clockTick();
    save();
  }
  renderClockInputs();
}, 5000);
// keep the phone screen awake while operating
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    keepAwake();
    publish();
  }
});
document.addEventListener('pointerdown', keepAwake, { once: true });
keepAwake();

window.addEventListener('beforeunload', () => {
  clockTick();
  save();
});
