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
// The detector knows the position (what stands on every square) and uses it:
// - every square has its own reference picture and its own "still" counter, so a
//   hand or a shadow over one part of the board does not block a move elsewhere;
// - shadows are removed by comparing each square with the light change of its
//   neighbours (a shadow darkens a whole area, a piece changes one square);
// - a move is accepted only when exactly its squares changed and stayed still,
//   and the square the piece left now looks like an empty square of its colour.
const PER = 27; // floats per square in blockMeans (3x3 blocks x RGB)
const STILL = 8; // per-square motion between frames that still counts as "still"

function sqMeans(img) {
  const m = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i++)
    for (let k = i * PER; k < (i + 1) * PER; k += 3) {
      m[i * 3] += img[k] / 9;
      m[i * 3 + 1] += img[k + 1] / 9;
      m[i * 3 + 2] += img[k + 2] / 9;
    }
  return m;
}
const NEIGH = Array.from({ length: 64 }, (_, i) => {
  const r = i >> 3, c = i & 7, out = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) out.push(rr * 8 + cc);
    }
  return out;
});
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// change per square, with shadows and exposure removed. The light change is
// estimated per block (a third of a square) from the blocks of the neighbouring
// squares around it, so the soft edge of a shadow is followed too. A piece that
// arrives or leaves changes only its own square, so it is not "explained away".
const BG = 24; // blocks per board side
const WIN = 3; // neighbourhood radius in blocks
export function changeMap(cur, ref) {
  const lum = (img, k) => img[k] + img[k + 1] + img[k + 2];
  const ratio = new Float32Array(BG * BG);
  const owner = new Int8Array(BG * BG);
  for (let i = 0; i < 64; i++)
    for (let b = 0; b < 9; b++) {
      const gy = (i >> 3) * 3 + Math.floor(b / 3);
      const gx = (i & 7) * 3 + (b % 3);
      const k = i * PER + b * 3;
      ratio[gy * BG + gx] = (lum(cur, k) + 12) / (lum(ref, k) + 12);
      owner[gy * BG + gx] = i;
    }
  const glob = median(Array.from(ratio));
  const d = new Float32Array(64);
  const vals = [];
  for (let i = 0; i < 64; i++) {
    let a = 0, g = 0;
    for (let b = 0; b < 9; b++) {
      const gy = (i >> 3) * 3 + Math.floor(b / 3);
      const gx = (i & 7) * 3 + (b % 3);
      vals.length = 0;
      for (let y = Math.max(0, gy - WIN); y <= Math.min(BG - 1, gy + WIN); y++)
        for (let x = Math.max(0, gx - WIN); x <= Math.min(BG - 1, gx + WIN); x++) if (owner[y * BG + x] !== i) vals.push(ratio[y * BG + x]);
      const loc = median(vals);
      const k = i * PER + b * 3;
      for (let c = 0; c < 3; c++) {
        a += Math.abs(cur[k + c] - ref[k + c] * loc);
        g += Math.abs(cur[k + c] - ref[k + c] * glob);
      }
    }
    d[i] = Math.min(a, g) / PER;
  }
  return d;
}

// How different a square is once a smooth change of light across it is removed
// (a plane fitted to the brightness ratio of its 3x3 blocks). A shadow, even its
// soft edge, leaves almost nothing; a piece arriving or leaving changes the
// pattern or the colour inside the square and leaves a lot.
export function shadowResidual(cur, ref, i) {
  const r = [];
  for (let b = 0; b < 9; b++) {
    const k = i * PER + b * 3;
    r.push((cur[k] + cur[k + 1] + cur[k + 2] + 12) / (ref[k] + ref[k + 1] + ref[k + 2] + 12));
  }
  // least squares plane over x,y in {-1,0,1}
  let a = 0, bx = 0, by = 0;
  for (let b = 0; b < 9; b++) {
    const x = (b % 3) - 1, y = Math.floor(b / 3) - 1;
    a += r[b] / 9;
    bx += (r[b] * x) / 6;
    by += (r[b] * y) / 6;
  }
  let sum = 0;
  for (let b = 0; b < 9; b++) {
    const x = (b % 3) - 1, y = Math.floor(b / 3) - 1;
    const f = a + bx * x + by * y;
    const k = i * PER + b * 3;
    for (let c = 0; c < 3; c++) sum += Math.abs(cur[k + c] - ref[k + c] * f);
  }
  return sum / PER;
}

// colour and texture of a square, which do not depend much on light: texture is
// what remains of the brightness pattern after removing a smooth slope across the
// square, so the soft edge of a shadow does not look like a piece
function feature(img, i) {
  let R = 0, G = 0, Bl = 0;
  const L = [];
  for (let k = i * PER; k < (i + 1) * PER; k += 3) {
    R += img[k];
    G += img[k + 1];
    Bl += img[k + 2];
    L.push(img[k] + img[k + 1] + img[k + 2]);
  }
  const I = R + G + Bl + 1;
  let a = 0, bx = 0, by = 0;
  for (let b = 0; b < 9; b++) {
    a += L[b] / 9;
    bx += (L[b] * ((b % 3) - 1)) / 6;
    by += (L[b] * (Math.floor(b / 3) - 1)) / 6;
  }
  let res = 0;
  for (let b = 0; b < 9; b++) res += (L[b] - (a + bx * ((b % 3) - 1) + by * (Math.floor(b / 3) - 1))) ** 2;
  return [R / I, G / I, Math.sqrt(res / 9) / (a + 1)];
}
function emptyDistance(img, i, empties) {
  const f = feature(img, i);
  const r = i >> 3, c = i & 7;
  const same = empties
    .filter((j) => j !== i && (((j >> 3) + (j & 7)) & 1) === ((r + c) & 1))
    .sort((a, b) => Math.hypot((a >> 3) - r, (a & 7) - c) - Math.hypot((b >> 3) - r, (b & 7) - c))
    .slice(0, 4);
  if (!same.length) return null;
  let best = Infinity;
  for (const j of same) {
    const g = feature(img, j);
    best = Math.min(best, Math.abs(f[0] - g[0]) * 100 + Math.abs(f[1] - g[1]) * 100 + Math.abs(f[2] - g[2]) * 20);
  }
  return best;
}

// When the phone films at an angle, a tall piece covers part of the squares
// behind it (on the far side of the board, which looks smaller in the picture).
// How far it reaches depends on the camera angle (how much smaller the far side
// looks) and on the piece's height: a king reaches about twice as far as a pawn.
const HEIGHT = { p: 0.5, n: 0.65, b: 0.75, r: 0.58, q: 0.88, k: 1 };
export function viewGeometry(corners) {
  const Hb = boardHomography(corners);
  const area = (f, r) => {
    const q = [project(Hb, f, r), project(Hb, f + 1, r), project(Hb, f + 1, r + 1), project(Hb, f, r + 1)];
    let a = 0;
    for (let k = 0; k < 4; k++) a += q[k][0] * q[(k + 1) % 4][1] - q[(k + 1) % 4][0] * q[k][1];
    return Math.abs(a) / 2;
  };
  let gx = 0, gy = 0;
  for (let k = 0; k < 8; k++) {
    gx += (area(7, k) - area(0, k)) / 8;
    gy += (area(k, 7) - area(k, 0)) / 8;
  }
  const len = Math.hypot(gx, gy) || 1;
  const ax = -gx / len, ay = -gy / len; // towards the far side, in files / ranks
  // near / far size of the board along that direction
  const near = ay < 0 ? area(3, 7) + area(4, 7) : area(3, 0) + area(4, 0);
  const far = ay < 0 ? area(3, 0) + area(4, 0) : area(3, 7) + area(4, 7);
  const ratio = Math.abs(ay) >= Math.abs(ax) ? near / (far || 1) : (ax > 0 ? area(0, 3) + area(0, 4) : area(7, 3) + area(7, 4)) / ((ax > 0 ? area(7, 3) + area(7, 4) : area(0, 3) + area(0, 4)) || 1);
  const kingReach = Math.max(0, Math.min(2.5, (ratio - 1) * 0.32)); // in squares
  // zones[type][i]: squares that a piece of this type on square i covers
  const zones = {};
  for (const t of Object.keys(HEIGHT)) {
    const reach = kingReach * HEIGHT[t];
    zones[t] = Array.from({ length: 64 }, (_, i) => {
      const f = i & 7, r = 7 - (i >> 3);
      const out = new Set();
      for (let k = 1; k <= 2; k++) {
        if (reach < k - 0.45) break; // must cover at least the front half of that square
        const bf = Math.round(f + ax * k), br = Math.round(r + ay * k);
        const lat = k === 1 && reach >= 0.9 ? [-1, 0, 1] : [0];
        for (const l of lat) {
          const ff = bf + (Math.abs(ax) < Math.abs(ay) ? l : 0);
          const rr = br + (Math.abs(ax) < Math.abs(ay) ? 0 : l);
          if (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && (ff !== f || rr !== r)) out.add((7 - rr) * 8 + ff);
        }
      }
      return out;
    });
  }
  return { kingReach, zones };
}

export class Detector {
  constructor() {
    this.map = null;
    this.reset();
  }
  reset() {
    this.prev = null;
    this.ref = null;
    this.cur = null;
    this.still = new Int16Array(64);
    this.age = new Int16Array(64);
    this.pending = null;
    this.pendingCount = 0;
    this.stuck = 0;
    this.reanchorWanted = true;
  }
  // corners: a1,h1,h8,a8 in frame pixels; w,h: frame size
  setCalibration(corners, w, h) {
    this.corners = corners;
    this.w = w;
    this.h = h;
    this.shift = [0, 0];
    this.map = buildMap(corners, w, h);
    this.view = viewGeometry(corners);
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
      for (let i = 0; i < 56; i++) s += d[i];
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
      this.still.fill(0);
      return true;
    }
    return false;
  }
  reanchor() {
    this.reanchorWanted = true;
    this.pending = null;
    this.stuck = 0;
  }
  // A move was entered: the squares it touched get their new reference picture.
  // Without a move, the whole board is taken as the reference.
  commit(move) {
    if (this.cur && this.ref && move) {
      // the move's squares, and the still squares next to them (a tall piece that
      // moved also changes how its neighbours look)
      const upd = new Set(moveSquares(move));
      for (const i of [...upd]) for (const j of [...NEIGH[i], ...this.view.zones.k[i]]) if (this.still[j] >= 3) upd.add(j);
      for (const i of upd) this.ref.set(this.cur.subarray(i * PER, (i + 1) * PER), i * PER);
    } else if (this.cur) this.ref = this.cur.slice();
    this.pending = null;
    this.pendingCount = 0;
    this.stuck = 0;
    this.reanchorWanted = false;
  }
  // frame: { data, width, height } with RGBA data; moves: chess.js verbose legal moves
  // board: chess.js board() of the position before the move (optional; improves checks)
  feed(frame, moves, board) {
    if (!this.map) return { state: 'nocal' };
    this.buf = warp(frame.data, this.map, this.buf);
    const img = blockMeans(this.buf);
    const prev = this.prev;
    this.prev = img;
    if (!prev) return { state: 'motion' };
    const md = squareDiffs(img, prev);
    let moving = 0;
    for (let i = 0; i < 64; i++) {
      this.still[i] = md[i] < STILL ? Math.min(this.still[i] + 1, 999) : 0;
      if (this.still[i] < 3) moving++;
    }
    this.cur = img;
    if (this.reanchorWanted || !this.ref) {
      if (moving) return { state: 'motion' };
      this.commit();
      return { state: 'anchored' };
    }
    const d = changeMap(img, this.ref);
    const T = threshold(d);
    const settled = (i) => this.still[i] >= 3;
    const changedList = [];
    for (let i = 0; i < 64; i++) {
      if (d[i] > T) changedList.push(i);
      else if (settled(i) && d[i] < T * 0.5) {
        // follow slow light changes on quiet squares
        for (let k = i * PER; k < (i + 1) * PER; k++) this.ref[k] = this.ref[k] * 0.8 + img[k] * 0.2;
      }
    }
    let maxD = 0;
    for (let i = 0; i < 64; i++) maxD = Math.max(maxD, d[i]);
    if (maxD <= T * 0.6) {
      this.pending = null;
      this.pendingCount = 0;
      this.stuck = 0;
      const out = { state: moving > 3 ? 'motion' : 'idle', changed: changedList };
      if (this.debug) out.debug = { T, max: Array.from(d).map((v, i) => [sqName(i), v]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => n + ':' + v.toFixed(0)) };
      return out;
    }

    // empty squares we can see right now, for the "does it look empty" check
    const emptyNow = [];
    if (board) for (let i = 0; i < 64; i++) if (!board[i >> 3][i & 7] && settled(i) && d[i] < T) emptyNow.push(i);

    // what we know stood on each square, and whether it still looks that way:
    // flip > 0 means "had a piece, now looks empty" or "was empty, now has a piece"
    const flip = new Float32Array(64);
    if (board && emptyNow.length >= 4)
      for (let i = 0; i < 64; i++) {
        if (d[i] <= T * 0.3) continue;
        const now = emptyDistance(img, i, emptyNow);
        const before = emptyDistance(this.ref, i, emptyNow);
        if (now == null || before == null) continue;
        const e = (before - now) / (before + now + 1); // > 0: looks emptier than before
        flip[i] = board[i >> 3][i & 7] ? e : -e;
      }
    const vacated = new Uint8Array(64);
    for (let i = 0; i < 64; i++) if (board && board[i >> 3][i & 7] && flip[i] > 0.35) vacated[i] = 1;
    // changed squares that only got darker or lighter (shadow, light), and whose
    // occupancy did not change
    const shadowy = new Uint8Array(64);
    for (const i of changedList) if (flip[i] < 0.35 && shadowResidual(img, this.ref, i) < T * 0.5) shadowy[i] = 1;

    const seen = new Set();
    const ranked = [];
    for (const m of moves) {
      const key = m.from + m.to;
      if (seen.has(key)) continue;
      seen.add(key);
      const sq = moveSquares(m);
      const inS = new Set(sq);
      // squares a piece stands in front of after this move (known from the position):
      // seen at an angle they are partly hidden, so they cannot be judged by looks
      const zones = this.view.zones;
      const after = new Map(); // square -> piece type, after this move
      for (let i = 0; i < 64; i++) if (board && board[i >> 3][i & 7]) after.set(i, board[i >> 3][i & 7].type);
      const leftSq = [m.from];
      if (m.flags.includes('e')) leftSq.push(m.to[0] + m.from[1]);
      if (m.flags.includes('k')) leftSq.push('h' + m.from[1]);
      if (m.flags.includes('q')) leftSq.push('a' + m.from[1]);
      for (const x of leftSq) after.delete(sqIndex(x));
      after.set(sqIndex(m.to), m.promotion || m.piece);
      if (m.flags.includes('k')) after.set(sqIndex('f' + m.from[1]), 'r');
      if (m.flags.includes('q')) after.set(sqIndex('d' + m.from[1]), 'r');
      const hidden = (i) => {
        for (const [j, t] of after) if (j !== i && zones[t][j].has(i)) return true;
        return false;
      };
      // the pieces that move or disappear, and which squares they may cover
      const movers = [[sqIndex(m.from), m.piece], [sqIndex(m.to), m.promotion || m.piece]];
      if (m.captured) movers.push([sqIndex(m.flags.includes('e') ? m.to[0] + m.from[1] : m.to), m.captured]);
      for (const x of leftSq.slice(1)) movers.push([sqIndex(x), m.flags.includes('e') ? 'p' : 'r']);
      if (m.flags.includes('k')) movers.push([sqIndex('f' + m.from[1]), 'r']);
      if (m.flags.includes('q')) movers.push([sqIndex('d' + m.from[1]), 'r']);
      const coversIt = (i) => movers.some(([j, t]) => j !== i && zones[t][j].has(i));
      // judge the move by its squares that the camera can see; a square hidden
      // behind a piece may not change at all
      let shade = false;
      let peak = 0;
      let inside = Infinity;
      let still = true;
      let visible = 0;
      let skipped = 0; // hidden squares that did not change: no support for the move
      let support = 0; // every square of the move that changed counts; one that did not, costs
      let behindAPiece = 0; // squares of the move that another piece stands in front of
      for (const i of sq) {
        peak = Math.max(peak, d[i]);
        if (!settled(i)) still = false;
        if (hidden(i)) behindAPiece++;
        if (hidden(i) && d[i] <= T) {
          skipped++;
          continue;
        }
        visible++;
        inside = Math.min(inside, d[i]);
        support += d[i] >= T ? Math.min(d[i], 2 * T) : 2 * (d[i] - T);
        // a square covered by a moving piece is not "only shadow"
        if (shadowy[i] && !coversIt(i) && !hidden(i)) shade = true;
      }
      if (!visible || inside <= T * 0.3 || peak <= T) continue;
      // changes the move does not explain (a tall piece may spill onto a neighbour)
      let far = 0;
      let nearSum = 0;
      let blocking = 0;
      for (const i of changedList) {
        if (inS.has(i) || !settled(i) || shadowy[i]) continue;
        // a square whose piece is gone is never "spill": some move took that piece away
        const covered = !vacated[i] && coversIt(i); // a tall piece of the move covers it
        const near = !vacated[i] && (covered || NEIGH[i].some((j) => inS.has(j)));
        if (covered) nearSum += d[i] * 0.3;
        else if (near) nearSum += d[i] * 0.6;
        else far += d[i] + (vacated[i] ? T : 0);
        if (!(covered || (near && d[i] < 0.85 * inside)) && d[i] > 0.45 * inside) blocking++;
      }
      // what we know stood on the squares: every square the move empties must now
      // look empty, and the square it goes to must look occupied
      // (squares hidden behind another piece are skipped; if all are hidden,
      // the evidence is unknown and the move is judged by the change pattern alone)
      let evidence = 0;
      let judged = false;
      if (board && emptyNow.length >= 4) {
        const ev = leftSq.map(sqIndex).filter((i) => !hidden(i)).map((i) => flip[i]);
        const ti = sqIndex(m.to);
        if (!m.captured && !hidden(ti)) ev.push(flip[ti]);
        if (ev.length) {
          evidence = Math.min(...ev);
          judged = true;
        }
      }
      // a weaker change is enough when the position confirms the move
      const ready = still && !shade && (inside > T || (inside > T * 0.6 && evidence > 0.3) || evidence > 0.6);
      if (!judged) evidence = null;
      const promo = m.promotion ? moves.find((x) => x.from === m.from && x.to === m.to && x.promotion === 'q') || m : m;
      const unexplained = far + nearSum;
      ranked.push({ move: promo, inside, ready, still, shade, visible, behindAPiece, spill: unexplained, blocking, evidence, score: support + 0.4 * T * (evidence || 0) - 0.8 * unexplained - 0.5 * T * skipped });
    }
    ranked.sort((a, b) => b.score - a.score);
    const ready = ranked.filter((r) => r.ready);
    // A square that has looked changed for a while, but whose occupancy still
    // matches the known position (the piece is still there, or it is still empty),
    // only changed in looks (spill of a tall piece, light): take it as reference.
    // A square whose piece really left is never absorbed.
    if (board && emptyNow.length >= 4) {
      const inMove = new Set();
      for (const r of ready) for (const i of moveSquares(r.move)) inMove.add(i);
      for (let i = 0; i < 64; i++) {
        if (d[i] > T && settled(i) && flip[i] < 0.2 && !inMove.has(i)) {
          if (++this.age[i] >= 15) {
            this.ref.set(img.subarray(i * PER, (i + 1) * PER), i * PER);
            this.age[i] = 0;
          }
        } else this.age[i] = 0;
      }
    }
    const best = ready[0];
    const rival = ranked.find((r) => r !== best && (!r.shade || !r.still || (r.evidence != null && r.evidence > 0.3)));
    let accept = false;
    const known = board && emptyNow.length >= 4;
    // another move that fits almost as well, or that is still being made, or that
    // the position confirms while this one cannot be checked: ask, do not guess
    const unsure = best && rival && ((rival.score >= best.score) || (!rival.still && rival.score > best.score - T) ||
      (rival.score > best.score - T && rival.evidence != null && (best.evidence == null || rival.evidence > best.evidence + 0.3)) || (best && best.evidence == null && rival.evidence != null && rival.evidence > 0.3));
    const steep = this.view.kingReach > 0.9;
    // at a steep angle much of the board is hidden: approve only a move that is seen
    // whole and that the position confirms; otherwise ask
    const fullySeen = best && !best.behindAPiece && best.inside > T && best.evidence != null && best.evidence > 0.3;
    if (best && !unsure && (!steep || fullySeen)) {
      const margin = rival ? best.score - rival.score : Infinity;
      if (best.evidence == null) {
        // the squares are hidden behind other pieces (camera at an angle): accept a
        // move whose change pattern is clearly the best, with nothing else changed
        if (!best.blocking && best.inside > T && best.visible >= 2 && margin > 0.5 * T) accept = true;
      } else if (best.evidence > (known ? 0.3 : -1) && margin > 0.25 * T) {
        if (!best.blocking) accept = true;
        // someone keeps a hand or arm still over another part of the board:
        // after a while, accept a move that is clear and that the position confirms
        else if (this.stuck >= 5 && best.evidence > 0.3) accept = true;
      }
      // What the organiser did by hand: the board has been still for a while and the
      // first suggestion is clearly ahead of the second, every square of it that the
      // camera sees has changed, and the position does not contradict it. Approve it.
      if (!accept && this.stuck >= 8 && best === ranked[0] && best.visible >= 2 && best.inside > T && margin > 0.5 * T && (best.evidence == null || best.evidence > 0)) accept = true;
    }
    if (accept) {
      const key = best.move.from + best.move.to;
      // a different move than the one being confirmed starts the count again;
      // a frame or two of doubt in between does not
      if (this.pending === key) this.pendingCount++;
      else {
        this.pending = key;
        this.pendingCount = 1;
      }
      if (this.pendingCount >= 2) {
        const out = { state: 'move', move: best.move, changed: changedList };
        if (this.debug) out.debug = { T, d: changedList.map((i) => sqName(i) + ':' + d[i].toFixed(0) + (settled(i) ? '' : '~') + (shadowy[i] ? 's' : '') + (vacated[i] ? 'v' : '')), flip: changedList.map((i) => sqName(i) + ':' + flip[i].toFixed(2)), top: ranked.slice(0, 4).map((r) => `${r.move.san} in=${r.inside.toFixed(0)} rdy=${r.ready} sh=${r.shade} sp=${r.spill.toFixed(0)} bl=${r.blocking} ev=${r.evidence == null ? 'hid' : r.evidence.toFixed(2)} sc=${r.score.toFixed(0)}`), stuck: this.stuck };
        return out;
      }
      return { state: 'confirming', move: best.move, changed: changedList };
    }
    let settledChanged = 0;
    for (const i of changedList) if (settled(i) && !shadowy[i]) settledChanged++;
    if (!settledChanged) return { state: 'motion', changed: changedList };
    this.stuck++;
    if (settledChanged >= 10 && this.stuck % 5 === 1 && this.realign(frame)) return { state: 'realigned' };
    const candidates = ranked.slice(0, 3).map((r) => r.move);
    // is there a move the position supports (a piece's square now looks empty)?
    const plausible = !known || ranked.some((r) => !r.shade && (r.evidence == null || r.evidence > 0.3));
    const out = { state: settledChanged >= 12 ? 'shifted' : 'unclear', changed: changedList, candidates, stuck: this.stuck, plausible };
    if (this.debug) out.debug = { T, d: changedList.map((i) => sqName(i) + ':' + d[i].toFixed(0) + (settled(i) ? '' : '~')), top: ranked.slice(0, 3).map((r) => `${r.move.san} in=${r.inside.toFixed(0)} rdy=${r.ready} st=${r.still} sh=${r.shade} sp=${r.spill.toFixed(0)} bl=${r.blocking} ev=${r.evidence == null ? 'hid' : r.evidence.toFixed(2)} sc=${r.score.toFixed(0)}`) };
    return out;
  }
}
