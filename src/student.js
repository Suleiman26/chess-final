import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import { rpc, figurine, pieceNameHe, sideHeTo, sideHe, legalDests, isPromotion, pickPromotion, escapeHtml } from './common.js';

const $ = (id) => document.getElementById(id);

function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem('cf:device');
  } catch (e) {}
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try {
      localStorage.setItem('cf:device', id);
    } catch (e) {}
  }
  return id;
}

const pid = (new URLSearchParams(location.search).get('p') || location.hash.replace(/^#/, '') || '').trim().toLowerCase();
const device = deviceId();

let puzzle = null; // server data
let cg = null;
let busy = false;

function show(view) {
  for (const v of ['v-loading', 'v-none', 'v-error', 'v-puzzle']) $(v).hidden = v !== view;
}

function setPips(tries, solved) {
  const pips = $('pips').children;
  for (let i = 0; i < 2; i++) {
    const used = i < tries;
    const isWin = solved && i === tries - 1;
    pips[i].className = 'pip' + (isWin ? ' win' : used ? ' used' : '');
  }
  const left = 2 - tries;
  $('pips-label').textContent = solved ? '' : left === 2 ? 'שני ניסיונות' : left === 1 ? 'נשאר ניסיון אחד' : 'נגמרו הניסיונות';
}

function setMessage(kind, html) {
  const el = $('msg');
  el.className = 'msg ' + (kind || '');
  el.innerHTML = html || '';
}

function boardFor(fen, movable) {
  const chess = new Chess(fen);
  const color = puzzle.side === 'w' ? 'white' : 'black';
  cg.set({
    fen,
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    check: chess.inCheck(),
    lastMove: undefined,
    movable: { color: movable ? color : undefined, dests: movable ? legalDests(chess) : new Map() },
  });
  cg.setAutoShapes([]);
}

function describeMove(fen, uci, san) {
  const chess = new Chess(fen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const p = chess.get(from);
  const fig = figurine(san, puzzle.side);
  return `<span class="san" dir="ltr">${escapeHtml(fig)}</span><span class="san-he">${pieceNameHe(p && p.type)} מ־<b dir="ltr">${from}</b> ל־<b dir="ltr">${to}</b></span>`;
}

function playOnBoard(uci, brush) {
  const chess = new Chess(puzzle.fen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  boardFor(puzzle.fen, false);
  setTimeout(() => {
    cg.move(from, to);
    let after = null;
    try {
      chess.move({ from, to, promotion: uci[4] || undefined });
      after = chess;
    } catch (e) {}
    setTimeout(() => {
      if (after) cg.set({ fen: after.fen(), lastMove: [from, to], check: after.inCheck(), turnColor: after.turn() === 'w' ? 'white' : 'black' });
      cg.setAutoShapes([{ orig: from, dest: to, brush: brush || 'green' }]);
    }, 320);
  }, 350);
}

function confetti() {
  const host = $('confetti');
  host.innerHTML = '';
  const colors = ['#e3b341', '#f4d98b', '#3fb96b', '#ffffff', '#7cc4ff'];
  for (let i = 0; i < 46; i++) {
    const s = document.createElement('i');
    s.style.left = Math.random() * 100 + '%';
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = Math.random() * 0.5 + 's';
    s.style.animationDuration = 1.6 + Math.random() * 1.4 + 's';
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    host.appendChild(s);
  }
  setTimeout(() => (host.innerHTML = ''), 3600);
}

function renderSolved(first) {
  setPips(puzzle.tries, true);
  $('prompt').classList.add('done');
  let extra = '';
  const mine = puzzle.moves && puzzle.moves[puzzle.moves.length - 1];
  if (puzzle.best_uci) {
    if (mine && mine !== puzzle.best_uci) {
      extra = `<div class="msg-sub">גם המהלך שלך מנצח! הבחירה הראשונה של המחשב:</div><div class="best">${describeMove(puzzle.fen, puzzle.best_uci, puzzle.best_san)}</div>`;
    } else {
      extra = `<div class="best">${describeMove(puzzle.fen, puzzle.best_uci, puzzle.best_san)}</div>`;
    }
  }
  setMessage('ok', `<div class="msg-title">כל הכבוד - הצלחת!</div>${extra}`);
  const shown = mine || puzzle.best_uci;
  if (shown) {
    if (first) {
      cg.setAutoShapes([{ orig: shown.slice(0, 2), dest: shown.slice(2, 4), brush: 'green' }]);
    } else {
      playOnBoard(shown, 'green');
    }
  }
  $('actions').innerHTML = '';
  if (first) confetti();
}

function renderFailed() {
  setPips(2, false);
  $('prompt').classList.add('done');
  if (puzzle.revealed && puzzle.best_uci) {
    setMessage('info', `<div class="msg-title">המהלך הכי טוב</div><div class="best">${describeMove(puzzle.fen, puzzle.best_uci, puzzle.best_san)}</div>`);
    $('actions').innerHTML = '';
    playOnBoard(puzzle.best_uci, 'green');
    return;
  }
  boardFor(puzzle.fen, false);
  setMessage('bad', `<div class="msg-title">לא הצלחת הפעם</div><div class="msg-sub">רוצה לראות מה היה המהלך הכי טוב?</div>`);
  $('actions').innerHTML = '<button id="reveal" class="btn" type="button">הצג את המהלך הכי טוב</button>';
  $('reveal').addEventListener('click', reveal);
}

async function reveal() {
  const btn = $('reveal');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'טוען…';
  }
  try {
    const r = await rpc('reveal_best', { p_id: pid, p_device: device });
    if (r && r.best_uci) {
      puzzle.revealed = true;
      puzzle.best_uci = r.best_uci;
      puzzle.best_san = r.best_san;
      renderFailed();
      return;
    }
    throw new Error('reveal');
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'נסו שוב - הצג את המהלך הכי טוב';
    }
  }
}

function renderPlaying() {
  setPips(puzzle.tries, false);
  boardFor(puzzle.fen, true);
  if (puzzle.tries === 1) {
    setMessage('warn', `<div class="msg-title">לא זה המהלך</div><div class="msg-sub">נשאר לך ניסיון אחד. חשבו טוב!</div>`);
  } else {
    setMessage('', `<div class="msg-hint">גררו כלי, או געו בכלי ואז במשבצת היעד</div>`);
  }
  $('actions').innerHTML = '';
}

async function onUserMove(orig, dest) {
  if (busy) return;
  busy = true;
  const chess = new Chess(puzzle.fen);
  let promo;
  if (isPromotion(chess, orig, dest)) {
    promo = await pickPromotion($('board-box'), puzzle.side);
  }
  const uci = orig + dest + (promo || '');
  try {
    chess.move({ from: orig, to: dest, promotion: promo });
  } catch (e) {
    busy = false;
    renderPlaying();
    return;
  }
  cg.set({
    fen: chess.fen(),
    lastMove: [orig, dest],
    check: chess.inCheck(),
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    movable: { color: undefined, dests: new Map() },
  });
  setMessage('', '<div class="msg-hint">בודק…</div>');
  let r;
  try {
    r = await rpc('try_move', { p_id: pid, p_device: device, p_uci: uci });
    if (!r || r.error) throw new Error((r && r.error) || 'server');
  } catch (e) {
    busy = false;
    await load(true);
    if (puzzle && !puzzle.solved && puzzle.tries < 2) {
      setMessage('warn', '<div class="msg-title">בעיית חיבור</div><div class="msg-sub">בדקו את האינטרנט ונסו שוב את המהלך.</div>');
    }
    return;
  }
  puzzle.tries = r.tries;
  puzzle.solved = !!r.solved;
  puzzle.moves = (puzzle.moves || []).concat(r.locked ? [] : [uci]);
  if (r.solved) {
    puzzle.best_uci = r.best_uci || puzzle.best_uci;
    puzzle.best_san = r.best_san || puzzle.best_san;
    renderSolved(true);
  } else {
    const box = $('board-box');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    setPips(puzzle.tries, false);
    if (puzzle.tries >= 2) {
      setMessage('bad', '<div class="msg-title">לא זה המהלך</div>');
      setTimeout(renderFailed, 900);
    } else {
      setMessage('warn', '<div class="msg-title">לא זה המהלך</div>');
      setTimeout(renderPlaying, 900);
    }
  }
  busy = false;
}

async function load(silent) {
  if (!pid) {
    show('v-none');
    return;
  }
  if (!silent) show('v-loading');
  let r;
  try {
    r = await rpc('open_puzzle', { p_id: pid, p_device: device });
  } catch (e) {
    show('v-error');
    return;
  }
  if (!r || !r.found) {
    show('v-none');
    return;
  }
  puzzle = r;
  show('v-puzzle');
  const side = puzzle.side;
  $('kicker').textContent = puzzle.move_no ? `מהלך ${puzzle.move_no}` : '';
  $('prompt-text').innerHTML = `מצא את המהלך הכי טוב <b>${sideHeTo(side)}</b>`;
  $('chip').className = 'chip ' + (side === 'w' ? 'white' : 'black');
  const names = [];
  if (puzzle.white) names.push(`<span><i class="dot white"></i>${escapeHtml(puzzle.white)}</span>`);
  if (puzzle.black) names.push(`<span><i class="dot black"></i>${escapeHtml(puzzle.black)}</span>`);
  $('players').innerHTML = names.join('');
  if (!cg) {
    cg = Chessground($('board'), {
      fen: puzzle.fen,
      orientation: side === 'w' ? 'white' : 'black',
      coordinates: true,
      movable: { free: false, color: undefined, showDests: true, events: { after: onUserMove } },
      premovable: { enabled: false },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
      highlight: { lastMove: true, check: true },
      animation: { enabled: true, duration: 260 },
      drawable: { enabled: false, visible: true },
      blockTouchScroll: true,
    });
  }
  if (puzzle.solved) renderSolved(false);
  else if (puzzle.tries >= 2) renderFailed();
  else renderPlaying();
}

$('retry').addEventListener('click', () => load(false));
load(false);
