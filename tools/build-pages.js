/**
 * Builds the GitHub Pages front-end (docs/index.html) from the same src/ files
 * used by Apps Script. The page talks to the Apps Script web app's doPost()
 * endpoint, so login, salesperson filtering and all security stay on the server.
 *
 *   node tools/build-pages.js            (uses API_URL below)
 *   API_URL=https://script.google.com/macros/s/XXX/exec node tools/build-pages.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'docs');
const API_URL = process.env.API_URL ||
  'https://script.google.com/macros/s/AKfycbwMUYDOZnUplByh93P412QAtfWTsuEP3p2_TXi-CUtaGobL5A_1iSpDr5xv_pb2h_2HpA/exec';

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
let html = read('Index.html');
const vars = { appName: 'OakCraft FMS', appSubtitle: 'Fulfilment Dashboard' };

// google.script.run replacement: same call shape, sent over fetch to doPost().
const shim = `<script>
(function () {
  var API_URL = ${JSON.stringify(API_URL)};
  function runner() {
    var ok = function () {}, fail = function () {};
    var r = {
      withSuccessHandler: function (f) { ok = f; return r; },
      withFailureHandler: function (f) { fail = f; return r; },
      api: function (req) {
        fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: req, redirect: 'follow', credentials: 'omit', cache: 'no-store' })
          .then(function (res) { if (!res.ok) throw new Error('Server responded ' + res.status); return res.text(); })
          .then(function (t) { ok(t); }, function (e) { fail(e); });
      }
    };
    return r;
  }
  window.google = { script: { get run() { return runner(); } } };
})();
</script>`;

const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src https://script.google.com https://script.googleusercontent.com; " +
  "base-uri 'none'; form-action 'none'; object-src 'none'";

html = html
  .replace(/<\?!=\s*include_\('Styles'\);?\s*\?>/, () => read('Styles.html'))
  .replace(/<\?!=\s*include_\('App'\);?\s*\?>/, () => shim + '\n' + read('App.html'))
  .replace(/<\?=\s*(appName|appSubtitle)\s*\?>/g, (m, k) => vars[k])
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + csp + '">\n  <meta name="referrer" content="no-referrer">');

if (/<\?/.test(html)) throw new Error('Unresolved template tag left in output');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('Wrote docs/index.html (' + html.length + ' bytes) → API ' + API_URL);
