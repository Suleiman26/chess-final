# גמר השחמט - נקודת תפנית

אתר קטן לליווי משחק גמר בשחמט מול קהל.

- `control.html` - דף הבקרה של המארגן: הזנת מהלכים, שעונים, מנוע, נתוני השתתפות.
- `display.html` - מסך התצוגה לקהל: לוח, שמות, שעונים, סולם, והודעת "נקודת תפנית במשחק" עם ברקוד.
- `index.html` - הדף שהתלמידים פותחים מהברקוד: מוצאים את המהלך הכי טוב בשני ניסיונות.

קוד המקור נמצא בתיקייה `src/` ונבנה עם `node build.mjs`.

## Credits and licences

- Board UI: [chessground](https://github.com/lichess-org/chessground) (GPL-3.0), piece set by Colin M.L. Burnett.
- Engine: [Stockfish](https://stockfishchess.org/) compiled to WebAssembly by [stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0). Engine source: https://github.com/official-stockfish/Stockfish
- Rules: [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause). QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).

This project is distributed under the GPL-3.0 licence.
