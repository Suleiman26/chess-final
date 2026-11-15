import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

await build({
  entryPoints: ['src/student.js', 'src/control.js', 'src/display.js'].filter((f) => {
    try { readFileSync(f); return true; } catch { return false; }
  }),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  outdir: 'site/assets',
  logLevel: 'info',
});
const cgDir = 'node_modules/@lichess-org/chessground/assets/';
writeFileSync('site/assets/board.css', ['chessground.base.css', 'chessground.brown.css', 'chessground.cburnett.css'].map((f) => readFileSync(cgDir + f, 'utf8')).join('\n'));
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) copyFileSync('node_modules/stockfish/bin/' + f, 'site/engine/' + f);
writeFileSync('site/.nojekyll', '');
console.log('built');
