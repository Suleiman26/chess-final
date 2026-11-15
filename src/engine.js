// Thin UCI wrapper around the Stockfish web worker.
export class Engine {
  constructor(url, onStatus) {
    this.onStatus = onStatus || (() => {});
    this.ready = false;
    this.searching = false;
    this.pending = null;
    this.current = null;
    this.failed = false;
    try {
      this.w = new Worker(url);
    } catch (e) {
      this.failed = true;
      this.onStatus('error');
      return;
    }
    this.w.onmessage = (e) => this.onLine(typeof e.data === 'string' ? e.data : String(e.data));
    this.w.onerror = () => {
      this.failed = true;
      this.onStatus('error');
    };
    this.send('uci');
  }
  send(cmd) {
    this.w.postMessage(cmd);
  }
  onLine(line) {
    if (line === 'uciok') {
      this.send('setoption name MultiPV value 3');
      this.send('isready');
    } else if (line === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        this.onStatus('ready');
      }
      this.kick();
    } else if (line.startsWith('info') && this.current) {
      const m = line.match(/\bdepth (\d+)\b.*?\bmultipv (\d+)\b.*?\bscore (cp|mate) (-?\d+)( lowerbound| upperbound)?.*?\bpv (.+)$/);
      if (!m || m[5]) return;
      const job = this.current;
      const rec = {
        depth: +m[1],
        cp: m[3] === 'cp' ? +m[4] : null,
        mate: m[3] === 'mate' ? +m[4] : null,
        pv: m[6].trim().split(/\s+/),
      };
      job.lines[+m[2]] = rec;
      if (+m[2] === 1 && !job.cancelled && job.onInfo) job.onInfo(rec, job);
    } else if (line.startsWith('bestmove')) {
      const job = this.current;
      this.current = null;
      this.searching = false;
      if (job && !job.cancelled && job.onDone) job.onDone(job.lines, job);
      this.kick();
    }
  }
  // job: { fen, movetime, onInfo(rec), onDone(lines) }  (scores are from the side to move)
  analyze(job) {
    if (this.failed) return;
    if (this.current) {
      this.current.cancelled = true;
      if (this.searching) this.send('stop');
    }
    this.pending = job;
    this.kick();
  }
  cancel() {
    this.pending = null;
    if (this.current) {
      this.current.cancelled = true;
      if (this.searching) this.send('stop');
    }
  }
  kick() {
    if (!this.ready || this.searching || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    job.lines = {};
    this.current = job;
    this.searching = true;
    this.send('position fen ' + job.fen);
    this.send('go movetime ' + (job.movetime || 3000));
  }
}
