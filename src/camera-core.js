// Board recognition from a fixed camera, without recognising pieces.
// The board is straightened with a homography from 4 tapped corners, then each
// square is compared with a reference picture of the last known position. The
// set of squares that changed is matched against the legal moves.
// Everything here works on raw pixel arrays and runs only in this browser.

export const S = 32; // pixels per square in the straightened board
export const N = S * 8;
const M = 7; // inner margin of a square that is ignored (piece edges, grid lines)
const FILES = 'abcdefgh';

// square index: row 0 is rank 8 (top of the straightened board), column 0 is file a
export const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
export const sqIndex = (n) => (8 - +n[1]) * 8 + FILES.indexOf(n[0]);

// ---------- geometry ----------
export function solveHomography(src, dst) {
  // maps src[i] -> dst[i] for 4 points; h33 = 1
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) return null;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}
export function project(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Put 4 tapped points in the order a1, h1, h8, a8 for a given rotation (0..3).
// With White at the bottom of the picture that order runs BL, BR, TR, TL.
export function orderCorners(pts, rot) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  let o = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = o[i];
    const b = o[(i + 1) % 4];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area > 0) o = o.reverse();
  // start from the bottom-left-most point so rotation 0 means White at the bottom
  let start = 0;
  for (let i = 1; i < 4; i++) if (o[i][1] - o[i][0] > o[start][1] - o[start][0]) start = i;
  const k = (start + rot) % 4;
  return [0, 1, 2, 3].map((i) => o[(k + i) % 4]);
}

export function boardHomography(corners) {
  return solveHomography([[0, 0], [8, 0], [8, 8], [0, 8]], corners);
}

// lookup table: straightened pixel -> source pixel offset
export function buildMap(corners, w, h) {
  const H = boardHomography(corners);
  if (!H) return null;
  const map = new Int32Array(N * N);
  for (let py = 0; py < N; py++) {
    const by = 8 - (py + 0.5) / S;
    for (let px = 0; px < N; px++) {
      const [X, Y] = project(H, (px + 0.5) / S, by);
      const xi = Math.min(w - 1, Math.max(0, Math.round(X)));
      const yi = Math.min(h - 1, Math.max(0, Math.round(Y)));
      map[py * N + px] = (yi * w + xi) * 4;
    }
  }
  return map;
}

export function warp(data, map, out) {
  out = out || new Uint8Array(N * N * 3);
  for (let k = 0, o = 0; k < map.length; k++, o += 3) {
    const s = map[k];
    out[o] = data[s];
    out[o + 1] = data[s + 1];
    out[o + 2] = data[s + 2];
  }
  return out;
}

// Each square's inner area is reduced to 3x3 blocks of averaged colour. Comparing
// block averages instead of pixels ignores a shift of a pixel or two (a slightly
// shaking stand, video noise) but still sees a piece arriving or leaving.
const B = 3;
const BS = (S - 2 * M) / B; // block size in pixels
export function blockMeans(img) {
  const out = new Float32Array(64 * B * B * 3);
  for (let i = 0; i < 64; i++) {
    const r0 = (i >> 3) * S + M;
    const c0 = (i & 7) * S + M;
    for (let by = 0; by < B; by++)
      for (let bx = 0; bx < B; bx++) {
        let r = 0, g = 0, b = 0;
        for (let y = r0 + by * BS; y < r0 + (by + 1) * BS; y++)
          for (let x = c0 + bx * BS; x < c0 + (bx + 1) * BS; x++) {
            const o = (y * N + x) * 3;
            r += img[o];
            g += img[o + 1];
            b += img[o + 2];
          }
        const k = ((i * B + by) * B + bx) * 3;
        const n = BS * BS;
        out[k] = r / n;
        out[k + 1] = g / n;
        out[k + 2] = b / n;
      }
  }
  return out;
}

// difference per square between two blockMeans() results, after removing the
// overall brightness shift between the two pictures (camera exposure changes)
export function squareDiffs(a, b) {
  const per = B * B * 3;
  const off = [0, 0, 0];
  for (let k = 0; k < a.length; k += 3) {
    off[0] += a[k] - b[k];
    off[1] += a[k + 1] - b[k + 1];
    off[2] += a[k + 2] - b[k + 2];
  }
  const cnt = a.length / 3;
  off[0] /= cnt;
  off[1] /= cnt;
  off[2] /= cnt;
  const d = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    let sum = 0;
    for (let k = i * per; k < (i + 1) * per; k += 3)
      sum += Math.abs(a[k] - b[k] - off[0]) + Math.abs(a[k + 1] - b[k + 1] - off[1]) + Math.abs(a[k + 2] - b[k + 2] - off[2]);
    d[i] = sum / per;
  }
  return d;
}

// luminance mean and spread per square (inner area)
export function squareStats(img) {
  const mean = new Float32Array(64);
  const std = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    const r0 = (i >> 3) * S;
    const c0 = (i & 7) * S;
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let y = r0 + M; y < r0 + S - M; y++)
      for (let x = c0 + M; x < c0 + S - M; x++) {
        const o = (y * N + x) * 3;
        const l = 0.299 * img[o] + 0.587 * img[o + 1] + 0.114 * img[o + 2];
        s += l;
        s2 += l * l;
        n++;
      }
    mean[i] = s / n;
    std[i] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  return { mean, std };
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// How well a straightened picture fits the expected position.
// board: chess.js board() array (row 0 = rank 8).
export function orientationScore(img, board) {
  const { mean, std } = squareStats(img);
  const occ = new Float32Array(64);
  const light = [];
  const dark = [];
  const white = [];
  const black = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i >> 3][i & 7];
    const isLight = ((i >> 3) + (i & 7)) % 2 === 0; // a8 (row 0, col 0) is a light square
    if (p) {
      occ[i] = 1;
      (p.color === 'w' ? white : black).push(mean[i]);
    } else (isLight ? light : dark).push(mean[i]);
  }
  const occCorr = pearson(std, occ);
  const parity = light.length && dark.length ? Math.tanh((avg(light) - avg(dark)) / 12) : 0;
  const colour = white.length && black.length ? Math.tanh((avg(white) - avg(black)) / 12) : 0;
  return occCorr + 0.6 * parity + 0.6 * colour;
}

// ---------- moves ----------
export function moveSquares(m) {
  const s = [m.from, m.to];
  const r = m.from[1];
  if (m.flags.includes('e')) s.push(m.to[0] + m.from[1]);
  if (m.flags.includes('k')) s.push('h' + r, 'f' + r);
  if (m.flags.includes('q')) s.push('a' + r, 'd' + r);
  return s.map(sqIndex);
}

export function threshold(d) {
  const sorted = Array.from(d).sort((a, b) => a - b);
  const noise = sorted[32];
  return Math.max(14, noise * 2.5 + 6);
}

// Rank the legal moves against the per-square differences.
export function rankMoves(d, moves) {
  const T = threshold(d);
  const seen = new Set();
  const ranked = [];
  for (const m of moves) {
    const key = m.from + m.to;
    if (seen.has(key)) continue; // promotions to other pieces share the same squares
    const sq = moveSquares(m);
    const inS = new Set(sq);
    let inside = Infinity;
    for (const i of sq) inside = Math.min(inside, d[i]);
    let outside = 0;
    for (let i = 0; i < 64; i++) if (!inS.has(i)) outside = Math.max(outside, d[i]);
    const promo = m.promotion ? moves.find((x) => x.from === m.from && x.to === m.to && x.promotion === 'q') || m : m;
    seen.add(key);
    ranked.push({ move: promo, inside, outside, score: inside - outside, ok: inside > T && outside < 0.6 * inside });
  }
  ranked.sort((a, b) => b.score - a.score);
  let changed = 0;
  for (let i = 0; i < 64; i++) if (d[i] > T) changed++;
  return { T, ranked, changed };
}

// ---------- detector ----------
// Feed it frames; it reports what it sees and when a move is certain.
export class Detector {
  constructor() {
    this.map = null;
    this.reset();
  }
  reset() {
    this.prev = null;
    this.ref = null;
    this.cur = null;
    this.stable = 0;
    this.pending = null;
    this.pendingCount = 0;
    this.stuck = 0;
    this.reanchorWanted = true;
    this.lastDiff = null;
  }
  // corners: a1,h1,h8,a8 in frame pixels; w,h: frame size
  setCalibration(corners, w, h) {
    this.corners = corners;
    this.w = w;
    this.h = h;
    this.shift = [0, 0];
    this.map = buildMap(corners, w, h);
    this.reset();
  }
  shiftedMap(dx, dy) {
    return buildMap(this.corners.map(([x, y]) => [x + dx, y + dy]), this.w, this.h);
  }
  // The camera was bumped: find the small shift that makes the picture match the
  // reference again. Returns true when the board was found again.
  realign(frame) {
    if (!this.ref || !this.corners) return false;
    const cost = (map) => {
      const d = Array.from(squareDiffs(blockMeans(warp(frame.data, map)), this.ref)).sort((a, b) => a - b);
      let s = 0;
      for (let i = 0; i < 56; i++) s += d[i]; // ignore the few squares a move may have changed
      return s;
    };
    const base = cost(this.map);
    let best = { c: base, dx: this.shift[0], dy: this.shift[1] };
    const scale = Math.max(this.w, this.h) / 640;
    const R = Math.round(8 * scale);
    const step = Math.max(1, Math.round(2 * scale));
    const tryAt = (dx, dy) => {
      const c = cost(this.shiftedMap(dx, dy));
      if (c < best.c) best = { c, dx, dy };
    };
    const [sx, sy] = this.shift;
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) tryAt(sx + dx, sy + dy);
    const cx = best.dx, cy = best.dy;
    for (let dy = -step; dy <= step; dy++) for (let dx = -step; dx <= step; dx++) tryAt(cx + dx, cy + dy);
    if (best.c < base * 0.6) {
      this.shift = [best.dx, best.dy];
      this.map = this.shiftedMap(best.dx, best.dy);
      this.prev = null;
      this.stable = 0;
      return true;
    }
    return false;
  }
  reanchor() {
    this.reanchorWanted = true;
    this.pending = null;
    this.stuck = 0;
  }
  // accept the latest stable picture as the reference (after a move was applied)
  commit() {
    if (this.cur) this.ref = this.cur.slice();
    this.pending = null;
    this.pendingCount = 0;
    this.stuck = 0;
    this.reanchorWanted = false;
  }
  // frame: { data, width, height } with RGBA data; moves: chess.js verbose legal moves
  feed(frame, moves) {
    if (!this.map) return { state: 'nocal' };
    this.buf = warp(frame.data, this.map, this.buf);
    const img = blockMeans(this.buf);
    const prev = this.prev;
    this.prev = img;
    if (!prev) return { state: 'motion' };
    const md = squareDiffs(img, prev);
    let motion = 0;
    for (let i = 0; i < 64; i++) motion = Math.max(motion, md[i]);
    if (motion > 12) {
      this.stable = 0;
      this.pendingCount = 0;
      return { state: 'motion' };
    }
    this.stable++;
    this.cur = img;
    if (this.stable < 3) return { state: 'settling' };
    if (this.reanchorWanted || !this.ref) {
      this.commit();
      return { state: 'anchored' };
    }
    const d = squareDiffs(img, this.ref);
    this.lastDiff = d;
    const { T, ranked, changed } = rankMoves(d, moves);
    const changedList = [];
    for (let i = 0; i < 64; i++) if (d[i] > T) changedList.push(i);
    if (changed === 0) {
      // nothing moved: follow slow light changes
      this.ref = img.slice();
      this.pending = null;
      this.stuck = 0;
      return { state: 'idle', changed: changedList };
    }
    const best = ranked[0];
    const second = ranked[1];
    const clear = best && best.ok && (!second || !second.ok || best.score > second.score * 1.5);
    if (clear) {
      this.stuck = 0;
      const key = best.move.from + best.move.to;
      if (this.pending === key) this.pendingCount++;
      else {
        this.pending = key;
        this.pendingCount = 1;
      }
      if (this.pendingCount >= 2) return { state: 'move', move: best.move, changed: changedList };
      return { state: 'confirming', move: best.move, changed: changedList };
    }
    this.pending = null;
    this.stuck++;
    if (changed >= 5 && this.stuck % 5 === 1 && this.realign(frame)) return { state: 'realigned' };
    const candidates = ranked.filter((r) => r.inside > T * 0.6).slice(0, 3).map((r) => r.move);
    return { state: changed > 12 ? 'shifted' : 'unclear', changed: changedList, candidates, stuck: this.stuck };
  }
}
