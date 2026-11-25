// Camera mode for the control page: a phone on a stand films the real board and
// the moves are entered automatically. The video never leaves this browser:
// frames are compared in memory and dropped; only the recognised move is used.
import { Detector, buildMap, orderCorners, orientationScore, warp, boardHomography, project, sqName } from './camera-core.js';
import { figurine, sideHe, escapeHtml } from './common.js';

const CAL_KEY = 'cf:cam';
const TICK_MS = 200;
const $ = (id) => document.getElementById(id);

export function initCamera({ getChess, applyMove, canDetect }) {
  const els = {
    idle: $('cam-idle'),
    live: $('cam-live'),
    view: $('cam-view'),
    video: $('cam-video'),
    overlay: $('cam-overlay'),
    status: $('cam-status'),
    cands: $('cam-cands'),
    calActions: $('cam-cal-actions'),
    runActions: $('cam-run-actions'),
    note: $('cam-note'),
    zoom: $('cam-zoom'),
    zoomRow: $('cam-zoom-row'),
    zoomVal: $('cam-zoom-val'),
    zoomKind: $('cam-zoom-kind'),
  };
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });
  const det = new Detector();

  let stream = null;
  let timer = null;
  let phase = 'off'; // off | tap | confirm | run
  let taps = []; // normalised [x, y] (0..1) of the 4 corners, any order
  let rot = 0;
  let fromCamera = false;
  let highlight = { squares: [], kind: '', until: 0 };
  let lastMoveText = '';
  let lastMoveAt = 0;
  // zoom: the camera's own zoom when the phone offers it, otherwise a digital zoom
  // (the centre of the picture is cropped, for the preview and for recognition alike)
  let zoom = 1;
  let hwZoom = null; // { min, max, step } when the camera supports zoom

  function loadCal() {
    try {
      const c = JSON.parse(localStorage.getItem(CAL_KEY) || 'null');
      if (c && Array.isArray(c.taps) && c.taps.length === 4) return c;
    } catch (e) {}
    return null;
  }
  function saveCal() {
    try {
      localStorage.setItem(CAL_KEY, JSON.stringify({ taps, rot, zoom }));
    } catch (e) {}
  }

  function note(kind, text) {
    els.note.className = 'note' + (kind ? ' ' + kind : '');
    els.note.textContent = text || '';
  }
  function status(html, kind) {
    els.status.className = 'cam-status' + (kind ? ' ' + kind : '');
    els.status.innerHTML = html;
  }

  // ---------- camera ----------
  async function start() {
    note('', '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      note('bad', 'הדפדפן הזה לא מאפשר גישה למצלמה. פתחו את דף הבקרה בכרום או בספארי, מהכתובת שמתחילה ב-https.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      stream = null;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      note('bad', denied ? 'לא ניתנה הרשאה למצלמה. כדי לאפשר: לחצו על סמל המנעול ליד כתובת האתר ← מצלמה ← אפשר, ואז נסו שוב.' : 'לא הצלחתי להפעיל את המצלמה. ודאו שאף אפליקציה אחרת לא משתמשת בה ונסו שוב.');
      return;
    }
    els.video.srcObject = stream;
    try {
      await els.video.play();
    } catch (e) {}
    await new Promise((r) => (els.video.videoWidth ? r() : els.video.addEventListener('loadedmetadata', r, { once: true })));
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    els.view.style.aspectRatio = `${vw} / ${vh}`;
    els.view.style.maxWidth = `calc(62vh * ${vw / vh})`;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    proc.width = Math.round(vw * scale);
    proc.height = Math.round(vh * scale);
    els.idle.hidden = true;
    els.live.hidden = false;
    setupZoom();
    const saved = loadCal();
    await applyZoom(saved && saved.zoom ? saved.zoom : 1);
    if (saved) {
      taps = saved.taps;
      rot = saved.rot || 0;
      enterConfirm(false);
      note('', 'נטען הכיול הקודם. אם הטלפון או הלוח זזו מאז, לחצו "כייל מחדש".');
    } else enterTap();
    clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    sizeOverlay();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    els.video.srcObject = null;
    phase = 'off';
    els.live.hidden = true;
    els.idle.hidden = false;
    els.cands.innerHTML = '';
    note('', 'המצלמה כבויה.');
  }

  // ---------- zoom ----------
  function setupZoom() {
    hwZoom = null;
    const track = stream && stream.getVideoTracks()[0];
    try {
      const caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) hwZoom = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
    } catch (e) {}
    const z = els.zoom;
    if (hwZoom) {
      z.min = hwZoom.min;
      z.max = Math.min(hwZoom.max, hwZoom.min * 8);
      z.step = hwZoom.step;
    } else {
      z.min = 1;
      z.max = 3;
      z.step = 0.1;
    }
    els.zoomKind.textContent = hwZoom ? '' : ' (דיגיטלי)';
  }

  async function applyZoom(v) {
    const z = els.zoom;
    v = Math.min(+z.max, Math.max(+z.min, +v || 1));
    zoom = v;
    z.value = v;
    els.zoomVal.textContent = (hwZoom ? v / hwZoom.min : v).toFixed(1) + '×';
    if (hwZoom) {
      els.video.style.transform = '';
      try {
        await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: v }] });
      } catch (e) {}
    } else els.video.style.transform = v > 1 ? `scale(${v})` : '';
  }

  // the zoom changes where the board is in the picture, so the corners are marked again
  async function changeZoom(v) {
    if (phase === 'run') return;
    await applyZoom(v);
    if (taps.length) {
      enterTap();
      note('', 'הזום השתנה, לכן צריך לסמן שוב את 4 הפינות.');
    }
    saveCal();
    draw();
  }

  function grab() {
    if (!stream || els.video.readyState < 2) return null;
    if (!hwZoom && zoom > 1) {
      const vw = els.video.videoWidth;
      const vh = els.video.videoHeight;
      const sw = vw / zoom;
      const sh = vh / zoom;
      pctx.drawImage(els.video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, proc.width, proc.height);
    } else pctx.drawImage(els.video, 0, 0, proc.width, proc.height);
    return pctx.getImageData(0, 0, proc.width, proc.height);
  }

  // ---------- calibration ----------
  function enterTap() {
    phase = 'tap';
    els.zoomRow.hidden = false;
    taps = [];
    els.calActions.hidden = true;
    els.runActions.hidden = true;
    els.cands.innerHTML = '';
    status('לחצו על <b>4 הפינות של אזור המשבצות</b> (בלי המסגרת של הלוח), בכל סדר.', 'info');
  }

  function cornersPx(w, h, r = rot) {
    return orderCorners(taps.map(([x, y]) => [x * w, y * h]), r);
  }

  function autoOrient() {
    const frame = grab();
    if (!frame) return;
    const board = getChess().board();
    const scores = [0, 1, 2, 3].map((r) => {
      const map = buildMap(cornersPx(frame.width, frame.height, r), frame.width, frame.height);
      return map ? orientationScore(warp(frame.data, map), board) : -9;
    });
    const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    rot = order[0][1];
    return order[0][0] - order[1][0];
  }

  function enterConfirm(orient) {
    phase = 'confirm';
    els.zoomRow.hidden = false;
    let margin = 1;
    if (orient) margin = autoOrient();
    saveCal();
    els.calActions.hidden = false;
    els.runActions.hidden = true;
    els.cands.innerHTML = '';
    status('בדקו שהרשת יושבת על המשבצות ושהתוויות <b>a1</b> ו-<b>h8</b> בפינות הנכונות. אם לא, לחצו "סובב". לחיצה ליד פינה מזיזה אותה.', 'info');
    if (orient && margin < 0.3) note('bad', 'לא הייתי בטוח באיזה צד הלבן. בדקו את התוויות ולחצו "סובב" עד שהן נכונות.');
    else if (orient) note('', '');
  }

  function onTap(ev) {
    if (phase !== 'tap' && phase !== 'confirm') return;
    const r = els.overlay.getBoundingClientRect();
    const p = [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height];
    if (phase === 'tap') {
      taps.push(p);
      if (taps.length === 4) enterConfirm(true);
    } else {
      let k = 0;
      let best = Infinity;
      taps.forEach((t, i) => {
        const d = Math.hypot((t[0] - p[0]) * r.width, (t[1] - p[1]) * r.height);
        if (d < best) {
          best = d;
          k = i;
        }
      });
      taps[k] = p;
      saveCal();
    }
    draw();
  }

  function startDetecting() {
    if (!canDetect()) {
      note('bad', 'אי אפשר להתחיל לזהות כרגע (המשחק הסתיים או שסידור הפוזיציה פתוח).');
      return;
    }
    det.setCalibration(cornersPx(proc.width, proc.height), proc.width, proc.height);
    phase = 'run';
    els.zoomRow.hidden = true;
    els.calActions.hidden = true;
    els.runActions.hidden = false;
    note('', 'מרגע זה כל מהלך על הלוח נרשם לבד. אם משהו נרשם לא נכון: "בטל מהלך אחרון" והזינו ידנית.');
    status('מצלם את מצב הלוח…', 'info');
  }

  // ---------- detection ----------
  function moveLabel(m) {
    return escapeHtml(figurine(m.san, m.color));
  }

  function takeMove(m) {
    const promo = m.promotion;
    fromCamera = true;
    const ok = applyMove({ from: m.from, to: m.to, promotion: promo });
    fromCamera = false;
    if (!ok) return false;
    det.commit(m);
    els.cands.innerHTML = '';
    highlight = { squares: [m.from, m.to], kind: 'move', until: Date.now() + 2500 };
    lastMoveText = moveLabel(m);
    lastMoveAt = Date.now();
    if (promo) note('', 'זוהתה הכתרה ונרשמה כמלכה. אם הרגלי הפך לכלי אחר: "בטל מהלך אחרון" והזינו ידנית, למשל e8=N.');
    return true;
  }

  function showCandidates(list) {
    const key = list.map((m) => m.san).join(',');
    if (els.cands.dataset.key === key) return;
    els.cands.dataset.key = key;
    els.cands.innerHTML = '';
    for (const m of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small primary';
      b.innerHTML = `נרשם: ${moveLabel(m)}`;
      b.onclick = () => takeMove(m);
      els.cands.appendChild(b);
    }
    const sync = document.createElement('button');
    sync.type = 'button';
    sync.className = 'btn small';
    sync.textContent = 'הלוח תואם למסך, סנכרן';
    sync.onclick = () => resync();
    els.cands.appendChild(sync);
  }
  function clearCandidates() {
    if (!els.cands.dataset.key) return;
    els.cands.dataset.key = '';
    els.cands.innerHTML = '';
  }

  function resync() {
    det.reanchor();
    clearCandidates();
    note('', 'המצלמה מסתנכרנת מחדש עם מצב הלוח הנוכחי.');
  }

  function tick() {
    if (stream && stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      note('bad', 'המצלמה נותקה (אולי המסך כבה). לחצו "הפעל מצלמה" שוב.');
      stop();
      return;
    }
    if (phase === 'run') runStep();
    draw();
  }

  function runStep() {
    const chess = getChess();
    if (!canDetect()) {
      status('הזיהוי מושהה: המשחק הסתיים או שסידור הפוזיציה פתוח.', 'info');
      return;
    }
    const frame = grab();
    if (!frame) return;
    const res = det.feed(frame, chess.moves({ verbose: true }), chess.board());
    const side = sideHe(chess.turn());
    const recent = lastMoveText && Date.now() - lastMoveAt < 3000 ? `<span class="cam-last">✓ ${lastMoveText}</span> ` : '';
    switch (res.state) {
      case 'move':
        if (takeMove(res.move)) status(`<span class="cam-last">✓ ${lastMoveText}</span> נרשם`, 'ok');
        break;
      case 'motion':
      case 'settling':
        status(recent + 'יש תנועה מעל הלוח…', 'info');
        break;
      case 'confirming':
        status(`בודק: ${moveLabel(res.move)}…`, 'info');
        break;
      case 'anchored':
      case 'idle':
        clearCandidates();
        status(recent + `מחכה למהלך של ה${side}`, recent ? 'ok' : '');
        break;
      case 'realigned':
        note('', 'הטלפון זז מעט, והלוח אותר מחדש.');
        break;
      case 'unclear':
      case 'shifted': {
        highlight = { squares: res.changed.map(sqName), kind: 'changed', until: Date.now() + TICK_MS * 2 };
        if (res.state === 'shifted' && res.stuck > 6) {
          status('הרבה משבצות השתנו בבת אחת: אולי הטלפון זז או שהתאורה השתנתה. אם הרשת לא יושבת על הלוח, לחצו "כייל מחדש".', 'bad');
          if (res.stuck > 6) showCandidates(res.candidates || []);
        } else if (!res.plausible && res.stuck < 40) {
          // a hand, an arm or an object over part of the board, and no piece is missing
          clearCandidates();
          status(recent + 'יש יד או חפץ מעל חלק מהלוח. מחכה שיתפנה…', 'info');
        } else if (res.stuck > 6) {
          status('משהו השתנה על הלוח אבל לא זיהיתי מהלך ברור. בחרו את המהלך שנעשה, או הזינו אותו ידנית.', 'bad');
          showCandidates(res.candidates || []);
        } else status('בודק את השינוי על הלוח…', 'info');
        break;
      }
    }
  }

  // ---------- overlay ----------
  function sizeOverlay() {
    const r = els.view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    els.overlay.width = Math.max(1, Math.round(r.width * dpr));
    els.overlay.height = Math.max(1, Math.round(r.height * dpr));
    draw();
  }

  function draw() {
    const c = els.overlay;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (phase === 'off') return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width;
    const H = c.height;
    if (phase === 'tap' || taps.length < 4) {
      g.fillStyle = '#e3b341';
      g.strokeStyle = '#000';
      g.lineWidth = 2 * dpr;
      for (const [x, y] of taps) {
        g.beginPath();
        g.arc(x * W, y * H, 7 * dpr, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      return;
    }
    const Hb = boardHomography(cornersPx(W, H));
    if (!Hb) return;
    const P = (x, y) => project(Hb, x, y);
    const quad = (f, r) => [P(f, r), P(f + 1, r), P(f + 1, r + 1), P(f, r + 1)];
    if (highlight.squares.length && Date.now() < highlight.until) {
      g.fillStyle = highlight.kind === 'move' ? 'rgba(63,185,107,.45)' : 'rgba(229,83,75,.4)';
      for (const s of highlight.squares) {
        const q = quad(s.charCodeAt(0) - 97, +s[1] - 1);
        g.beginPath();
        q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fill();
      }
    }
    g.strokeStyle = phase === 'run' ? 'rgba(227,179,65,.55)' : 'rgba(227,179,65,.95)';
    g.lineWidth = (phase === 'run' ? 1 : 1.5) * dpr;
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      let [x, y] = P(i, 0);
      g.moveTo(x, y);
      [x, y] = P(i, 8);
      g.lineTo(x, y);
      [x, y] = P(0, i);
      g.moveTo(x, y);
      [x, y] = P(8, i);
      g.lineTo(x, y);
    }
    g.stroke();
    g.font = `800 ${13 * dpr}px Heebo, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [lbl, f, r] of [['a1', 0, 0], ['h1', 7, 0], ['a8', 0, 7], ['h8', 7, 7]]) {
      const [x, y] = P(f + 0.5, r + 0.5);
      g.fillStyle = 'rgba(14,18,25,.8)';
      g.fillRect(x - 15 * dpr, y - 10 * dpr, 30 * dpr, 20 * dpr);
      g.fillStyle = lbl[0] === 'a' && lbl[1] === '1' ? '#7fe0a3' : '#f4d98b';
      g.fillText(lbl, x, y);
    }
    if (phase === 'confirm') {
      g.fillStyle = '#e3b341';
      for (const [x, y] of taps) {
        g.beginPath();
        g.arc(x * W, y * H, 6 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // ---------- wiring ----------
  $('cam-start').onclick = start;
  $('cam-stop').onclick = stop;
  $('cam-rotate').onclick = () => {
    rot = (rot + 1) % 4;
    saveCal();
    note('', '');
    draw();
  };
  $('cam-recal').onclick = () => {
    clearCandidates();
    enterTap();
    note('', '');
    draw();
  };
  $('cam-recal2').onclick = $('cam-recal').onclick;
  $('cam-go').onclick = startDetecting;
  els.zoom.addEventListener('input', () => changeZoom(els.zoom.value));
  const nudge = (dir) => changeZoom(+els.zoom.value + dir * Math.max(+els.zoom.step, (+els.zoom.max - +els.zoom.min) / 20));
  $('cam-zoom-in').onclick = () => nudge(1);
  $('cam-zoom-out').onclick = () => nudge(-1);
  $('cam-sync').onclick = resync;
  els.overlay.addEventListener('pointerdown', onTap);
  window.addEventListener('resize', sizeOverlay);
  if ('ResizeObserver' in window) new ResizeObserver(sizeOverlay).observe(els.view);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && phase !== 'off') note('', 'חזרתם לדף. אם הלוח השתנה בזמן שהמסך היה כבוי, בדקו שהמהלכים נרשמו.');
  });

  return {
    // called by the control page whenever the position changed
    positionChanged() {
      if (phase === 'run' && !fromCamera) {
        det.reanchor();
        clearCandidates();
        note('', 'הלוח עודכן ידנית, והמצלמה מסתנכרנת מחדש. ודאו שהלוח האמיתי כבר תואם למסך.');
      }
    },
  };
}
