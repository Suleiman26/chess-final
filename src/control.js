import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import qrcode from 'qrcode-generator';
import { Engine } from './engine.js';
import { rpc, figurine, legalDests, isPromotion, pickPromotion, fmtClock, evalToPercent, evalLabel, evalAdvantage, sideHe, sideHeTo, escapeHtml, STATE_KEY, CHANNEL } from './common.js';
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
    threshold: p.threshold ?? 4,
    autoHideSec: p.autoHideSec ?? 180,
    autoTp: p.autoTp ?? true,
    sans: [],
    clock: { w: baseMin * 60000, b: baseMin * 60000, running: false, ts: 0 },
    armed: { w: true, b: true },
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
      if (g && Array.isArray(g.sans)) return Object.assign(freshGame(g), g);
    }
  } catch (e) {}
  return freshGame();
}
let G = loadGame();
let chess = new Chess();
function rebuild() {
  chess = new Chess();
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
    ev: G.ev,
    clock: G.clock,
    result: autoResult(),
    tp: tp ? { id: tp.id, url: tp.url, side: tp.side, moveNo: tp.moveNo, show: tp.show, hideAt: tp.hideAt, shownAt: tp.shownAt, stats: tp.stats } : null,
  };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {}
  if (bc) bc.postMessage(state);
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
    if (serverOk) refreshStats();
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
  let promotion;
  if (isPromotion(chess, orig, dest)) promotion = await pickPromotion($('board-box'), chess.turn());
  applyMove({ from: orig, to: dest, promotion });
}

function applyMove(m) {
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
  if (chess.isGameOver()) G.clock.running = false;
  positionChanged();
  return true;
}

function undoMove() {
  if (!G.sans.length) return;
  clockTick();
  chess.undo();
  G.sans.pop();
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
  const out = [];
  for (let i = 0; i < G.sans.length; i += 2) {
    out.push(`<span class="mvp"><i>${i / 2 + 1}.</i> ${escapeHtml(figurine(G.sans[i], 'w'))} ${G.sans[i + 1] ? escapeHtml(figurine(G.sans[i + 1], 'b')) : ''}</span>`);
  }
  $('moves').innerHTML = out.join(' ') || '<span class="muted">עדיין אין מהלכים</span>';
  $('moves').scrollTop = $('moves').scrollHeight;
  $('turn').textContent = autoResult() ? 'המשחק הסתיים' : `תור ${sideHe(chess.turn())} · מהלך ${chess.moveNumber()}`;
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
  pill.textContent = st === 'ready' ? 'המנוע פועל' : 'תקלה במנוע';
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
      G.ev = toWhite(rec, turn);
      renderEval();
      $('engine-line').textContent = `עומק ${rec.depth}: ${pvToSan(fen, rec.pv, 5)}`;
      publish();
    },
    onDone: (lines) => {
      analysis = { fen, lines, done: true };
      const l1 = lines[1];
      if (l1) {
        G.ev = toWhite(l1, turn);
        renderEval();
        $('engine-line').textContent = `עומק ${l1.depth}: ${pvToSan(fen, l1.pv, 5)}`;
      }
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
function moverAdvantage(l1) {
  if (l1.mate != null) return l1.mate > 0 ? Infinity : -Infinity;
  return l1.cp;
}
function checkTurningPoint(fen, turn, lines) {
  const l1 = lines[1];
  if (!l1) return;
  const adv = moverAdvantage(l1);
  const thr = G.threshold * 100;
  const other = turn === 'w' ? 'b' : 'w';
  if (adv < thr - 100) G.armed[turn] = true;
  if (-adv < thr - 100) G.armed[other] = true;
  if (G.autoTp && adv >= thr && G.armed[turn] && chess.moves().length > 1) {
    G.armed[turn] = false;
    createTurningPoint(fen, turn, lines, false);
  }
  save();
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
    if (!manual) G.armed[turn] = true;
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
    if (!manual) G.armed[turn] = true;
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
  $('auto-state').textContent = G.autoTp ? `זיהוי אוטומטי פעיל (סולם ${G.threshold}+)` : 'זיהוי אוטומטי כבוי';
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
  for (const [id, f] of [['f-title', 'title'], ['f-white', 'white'], ['f-black', 'black'], ['f-base', 'baseMin'], ['f-inc', 'incSec'], ['f-thr', 'threshold'], ['f-hide', 'autoHideSec']]) $(id).value = G[f];
  $('f-auto').checked = !!G.autoTp;
  $('result').value = G.result || '';
}

bindText('f-title', 'title');
bindText('f-white', 'white');
bindText('f-black', 'black');
bindNum('f-base', 'baseMin', 1, 600);
bindNum('f-inc', 'incSec', 0, 600);
bindNum('f-thr', 'threshold', 1, 20, renderTp);
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
  G.armed[tp.side] = true;
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
$('pgn-copy').addEventListener('click', () => {
  const c = new Chess();
  c.header('Event', G.title, 'White', G.white, 'Black', G.black, 'Result', autoResult().replace('½-½', '1/2-1/2') || '*');
  for (const s of G.sans) c.move(s);
  copyText($('pgn-copy'), c.pgn());
});

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
window.addEventListener('beforeunload', () => {
  clockTick();
  save();
});
