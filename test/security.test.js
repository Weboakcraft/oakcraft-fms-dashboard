/* End-to-end server tests: auth, isolation, authorization, revocation. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createEnv } = require('./harness');
const mock = require('./mockdata');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

const o2dRows = mock.o2d(), tboRows = mock.tbo();
const env = createEnv({ o2dRows, tboRows });
const api = env.api;

console.log('\nPublic surface');
ok('only intended functions are public (no trailing underscore)', () => {
  const src = fs.readdirSync(path.join(__dirname, '../src')).filter((f) => f.endsWith('.gs'))
    .map((f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
  const pub = [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith('_'));
  assert.deepStrictEqual(pub.sort(), ['api', 'doGet', 'emergencyResetAdmin', 'initialSetup']);
});
ok('api before setup returns NOT_SETUP / no crash', () => {
  const r = api({ action: 'login', payload: { loginId: 'admin', password: 'x' } });
  assert.strictEqual(r.ok, false);
});
ok('doGet renders shell without any data', () => {
  const html = env.ctx.doGet().getContent();
  assert(html.includes('id="login-form"'));
  assert(!html.includes('NITI KUMARI'));
  fs.writeFileSync(path.join(__dirname, 'out_index.html'), html);
});

console.log('\nSetup');
let adminPw;
ok('initialSetup creates auth DB + admin, logs temp password', () => {
  env.ctx.initialSetup();
  const line = env.logs.find((l) => l.startsWith('Temp password'));
  assert(line, 'password logged');
  adminPw = line.split(':').slice(1).join(':').trim();
  assert(adminPw.length >= 10);
});
ok('initialSetup refuses to run twice (returns nothing)', () => {
  const before = env.logs.length;
  const ret = env.ctx.initialSetup();
  assert.strictEqual(ret, undefined);
  assert(env.logs.slice(before).some((l) => /already completed/.test(l)));
});
ok('emergencyResetAdmin disabled by default', () => {
  const before = env.logs.length;
  env.ctx.emergencyResetAdmin();
  assert(env.logs.slice(before).some((l) => /Recovery is disabled/.test(l)));
});
ok('password hash is salted+peppered (not plaintext) in Auth DB', () => {
  const db = Object.values(env.spreadsheets).find((s) => s.id.startsWith('AUTHDB'));
  const users = db.getSheetByName('Users');
  const row = users.rows[1];
  const hash = row[6];
  assert(/^v1\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(hash), hash);
  assert(!JSON.stringify(users.rows).includes(adminPw));
});

console.log('\nLogin & lockout');
ok('wrong password → generic error', () => {
  const r = api({ action: 'login', payload: { loginId: 'admin', password: 'nope12345' } });
  assert.strictEqual(r.code, 'INVALID_LOGIN');
});
ok('unknown user → same generic error', () => {
  const r = api({ action: 'login', payload: { loginId: 'ghost', password: 'nope12345' } });
  assert.strictEqual(r.code, 'INVALID_LOGIN');
  assert.strictEqual(r.error, 'Invalid login ID or password.');
});
ok('lockout after 5 failures, even with correct password', () => {
  for (let i = 0; i < 4; i++) api({ action: 'login', payload: { loginId: 'admin', password: 'bad' + i + 'xxxxx' } });
  const r = api({ action: 'login', payload: { loginId: 'admin', password: adminPw } });
  assert.strictEqual(r.code, 'LOCKED');
});
// simulate lockout expiry
env.cache.removeAll(['lock:admin', 'fail:admin']);

let adminTok;
ok('admin login works; mustChange enforced server-side', () => {
  const r = api({ action: 'login', payload: { loginId: 'ADMIN', password: adminPw } });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.user.mustChange, true);
  assert(!('passwordHash' in r.data.user));
  adminTok = r.data.token;
  const d = api({ action: 'getData', token: adminTok });
  assert.strictEqual(d.code, 'PASSWORD_CHANGE_REQUIRED');
});
ok('change password rotates token and kills old one', () => {
  const r = api({ action: 'changePassword', token: adminTok, payload: { currentPassword: adminPw, newPassword: 'Str0ngOakPass!' } });
  assert(r.ok, JSON.stringify(r));
  const old = api({ action: 'me', token: adminTok });
  assert.strictEqual(old.code, 'AUTH_REQUIRED');
  adminTok = r.data.token;
});
ok('admin sees all rows of both sheets', () => {
  const d = api({ action: 'getData', token: adminTok });
  assert(d.ok, JSON.stringify(d));
  assert.strictEqual(d.data.sources.o2d.rows.length, o2dRows.length);
  assert.strictEqual(d.data.sources.tbo.rows.length, tboRows.length);
  assert.strictEqual(d.data.scope.type, 'all');
  assert.strictEqual(d.data.salespersons.length, 5);
  assert.strictEqual(d.data.sources.o2d.headers[11], 'Empolyee Name');
  assert.strictEqual(d.data.sources.o2d.headers[15], 'FINAL STATUS');
});

console.log('\nUser management');
let nitiPw, nitiId, nitiTok;
ok('admin creates salesperson with generated password', () => {
  const r = api({ action: 'createUser', token: adminTok, payload: { loginId: 'niti', displayName: 'Niti Kumari', role: 'salesperson', salesperson: 'niti  kumari' } });
  assert(r.ok, JSON.stringify(r));
  nitiPw = r.data.generatedPassword; nitiId = r.data.user.userId;
  assert(nitiPw && r.data.user.salesperson === 'NITI KUMARI');
  assert.strictEqual(r.data.warning, null);
});
ok('duplicate login ID rejected', () => {
  const r = api({ action: 'createUser', token: adminTok, payload: { loginId: 'NITI', displayName: 'X', role: 'salesperson', salesperson: 'AMIRA SAIKH' } });
  assert.strictEqual(r.code, 'VALIDATION');
});
ok('input validation: bad login ID, weak password, bad role, missing salesperson', () => {
  assert.strictEqual(api({ action: 'createUser', token: adminTok, payload: { loginId: 'a b', displayName: 'Xy', role: 'salesperson', salesperson: 'AMIRA SAIKH' } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'createUser', token: adminTok, payload: { loginId: 'amira', displayName: 'Xy', role: 'salesperson', salesperson: 'AMIRA SAIKH', password: 'short' } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'createUser', token: adminTok, payload: { loginId: 'amira', displayName: 'Xy', role: 'root', salesperson: 'AMIRA SAIKH' } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'createUser', token: adminTok, payload: { loginId: 'amira', displayName: 'Xy', role: 'salesperson' } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'createUser', token: adminTok, payload: { loginId: 'amira', displayName: 'Xy', role: 'salesperson', salesperson: '=HYPERLINK("x")' } }).code, 'VALIDATION');
});
ok('formula injection neutralised in display name', () => {
  const r = api({ action: 'createUser', token: adminTok, payload: { loginId: 'evil', displayName: '=IMPORTXML(1)', role: 'manager', password: 'Passw0rd123' } });
  assert(r.ok);
  const db = Object.values(env.spreadsheets).find((s) => s.id.startsWith('AUTHDB'));
  const cell = db.getSheetByName('Users').rows.find((x) => x[1] === 'evil')[2];
  assert(cell.startsWith("'="), cell);
  api({ action: 'deleteUser', token: adminTok, payload: { userId: r.data.user.userId } });
});
ok('unknown salesperson triggers a warning', () => {
  const r = api({ action: 'createUser', token: adminTok, payload: { loginId: 'newbie', displayName: 'New Person', role: 'salesperson', salesperson: 'RAHUL VERMA', password: 'Passw0rd123', mustChange: false } });
  assert(r.ok && /No rows/.test(r.data.warning));
});

console.log('\nSalesperson isolation');
ok('salesperson login + forced password change', () => {
  let r = api({ action: 'login', payload: { loginId: 'niti', password: nitiPw } });
  assert(r.ok);
  r = api({ action: 'changePassword', token: r.data.token, payload: { currentPassword: nitiPw, newPassword: 'Kumari#Secure26' } });
  assert(r.ok, JSON.stringify(r));
  nitiTok = r.data.token;
});
ok('getData returns ONLY NITI KUMARI rows', () => {
  const d = api({ action: 'getData', token: nitiTok });
  assert(d.ok);
  const expO = o2dRows.filter((r) => r[11] === 'NITI KUMARI').length;
  const expT = tboRows.filter((r) => r[11] === 'NITI KUMARI').length;
  assert.strictEqual(d.data.sources.o2d.rows.length, expO);
  assert.strictEqual(d.data.sources.tbo.rows.length, expT);
  assert(expO > 0);
  const json = JSON.stringify(d);
  mock.SP.filter((n) => n !== 'NITI KUMARI').forEach((n) => assert(!json.includes(n), 'leaked ' + n));
  assert(!('salespersons' in d.data));
  assert.strictEqual(d.data.scope.type, 'own');
});
ok('client-supplied filters cannot widen scope', () => {
  const d = api({ action: 'getData', token: nitiTok, payload: { salesperson: 'AMIRA SAIKH', scope: 'all', role: 'admin' } });
  assert(!JSON.stringify(d).includes('AMIRA SAIKH'));
});
ok('salesperson cannot call admin endpoints (logged as ACCESS_DENIED)', () => {
  ['listUsers', 'createUser', 'resetPassword', 'getActivity', 'logoutAll', 'getSystem', 'clearCache', 'deleteUser'].forEach((a) => {
    const r = api({ action: a, token: nitiTok, payload: { userId: nitiId } });
    assert.strictEqual(r.code, 'FORBIDDEN', a);
  });
  const act = api({ action: 'getActivity', token: adminTok, payload: { event: 'ACCESS_DENIED' } });
  assert(act.data.items.length >= 8);
});
ok('forged / malformed tokens rejected', () => {
  assert.strictEqual(api({ action: 'getData', token: 'a'.repeat(64) }).code, 'AUTH_REQUIRED');
  assert.strictEqual(api({ action: 'getData', token: '../../etc' }).code, 'AUTH_REQUIRED');
  assert.strictEqual(api({ action: 'getData' }).code, 'AUTH_REQUIRED');
  assert.strictEqual(api({ action: '__proto__', token: nitiTok }).code, 'BAD_REQUEST');
  assert.strictEqual(api({ action: 'constructor', token: nitiTok }).code, 'BAD_REQUEST');
  assert.strictEqual(JSON.parse(env.ctx.api('not json')).ok, false);
  assert.strictEqual(JSON.parse(env.ctx.api('x'.repeat(30000))).code, 'BAD_REQUEST');
});
ok('session tokens are not stored in clear in cache', () => {
  const keys = [...env.cacheStore().keys()];
  assert(!keys.some((k) => k.includes(nitiTok)));
});

console.log('\nRevocation & permissions');
ok('tab permission removes sheet server-side', () => {
  let r = api({ action: 'updateUser', token: adminTok, payload: { userId: nitiId, permissions: { o2d: true, tbo: false, export: false } } });
  assert(r.ok);
  // scope change revoked session
  assert.strictEqual(api({ action: 'getData', token: nitiTok }).code, 'AUTH_REQUIRED');
  r = api({ action: 'login', payload: { loginId: 'niti', password: 'Kumari#Secure26' } });
  nitiTok = r.data.token;
  const d = api({ action: 'getData', token: nitiTok });
  assert(d.data.sources.o2d && !d.data.sources.tbo);
  assert.strictEqual(api({ action: 'logEvent', token: nitiTok, payload: { type: 'EXPORT' } }).code, 'FORBIDDEN');
});
ok('reassigning salesperson changes data immediately', () => {
  api({ action: 'updateUser', token: adminTok, payload: { userId: nitiId, salesperson: 'UJALA RAJPUT', permissions: { o2d: true, tbo: true, export: true } } });
  const r = api({ action: 'login', payload: { loginId: 'niti', password: 'Kumari#Secure26' } });
  const d = api({ action: 'getData', token: r.data.token });
  assert(d.data.sources.o2d.rows.every((x) => x.salesperson === 'UJALA RAJPUT'));
  api({ action: 'updateUser', token: adminTok, payload: { userId: nitiId, salesperson: 'NITI KUMARI' } });
  nitiTok = api({ action: 'login', payload: { loginId: 'niti', password: 'Kumari#Secure26' } }).data.token;
});
ok('deactivation kills live session and blocks login', () => {
  assert(api({ action: 'setUserStatus', token: adminTok, payload: { userId: nitiId, status: 'inactive' } }).ok);
  assert.strictEqual(api({ action: 'getData', token: nitiTok }).code, 'AUTH_REQUIRED');
  assert.strictEqual(api({ action: 'login', payload: { loginId: 'niti', password: 'Kumari#Secure26' } }).code, 'INACTIVE');
  api({ action: 'setUserStatus', token: adminTok, payload: { userId: nitiId, status: 'active' } });
});
ok('password reset kills session; force logout works', () => {
  nitiTok = api({ action: 'login', payload: { loginId: 'niti', password: 'Kumari#Secure26' } }).data.token;
  const r = api({ action: 'resetPassword', token: adminTok, payload: { userId: nitiId } });
  assert(r.ok && r.data.generatedPassword);
  assert.strictEqual(api({ action: 'me', token: nitiTok }).code, 'AUTH_REQUIRED');
  const t = api({ action: 'login', payload: { loginId: 'niti', password: r.data.generatedPassword } }).data.token;
  api({ action: 'forceLogout', token: adminTok, payload: { userId: nitiId } });
  assert.strictEqual(api({ action: 'me', token: t }).code, 'AUTH_REQUIRED');
});
ok('admin safety rails (self-deactivate, last admin)', () => {
  const me = api({ action: 'me', token: adminTok }).data.user;
  assert.strictEqual(api({ action: 'setUserStatus', token: adminTok, payload: { userId: me.userId, status: 'inactive' } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'deleteUser', token: adminTok, payload: { userId: me.userId } }).code, 'VALIDATION');
  assert.strictEqual(api({ action: 'updateUser', token: adminTok, payload: { userId: me.userId, role: 'manager' } }).code, 'VALIDATION');
});
ok('manager sees all data but cannot manage users', () => {
  api({ action: 'createUser', token: adminTok, payload: { loginId: 'boss', displayName: 'Sales Head', role: 'manager', password: 'Manag3rPass', mustChange: false } });
  const t = api({ action: 'login', payload: { loginId: 'boss', password: 'Manag3rPass' } }).data.token;
  const d = api({ action: 'getData', token: t });
  assert.strictEqual(d.data.sources.o2d.rows.length, o2dRows.length);
  assert.strictEqual(api({ action: 'listUsers', token: t }).code, 'FORBIDDEN');
});
ok('since=version short-circuits unchanged data', () => {
  const d = api({ action: 'getData', token: adminTok });
  const d2 = api({ action: 'getData', token: adminTok, payload: { since: d.data.version } });
  assert.strictEqual(d2.data.unchanged, true);
});
ok('logout all bumps epoch', () => {
  const t = api({ action: 'login', payload: { loginId: 'boss', password: 'Manag3rPass' } }).data.token;
  api({ action: 'logoutAll', token: adminTok });
  assert.strictEqual(api({ action: 'me', token: t }).code, 'AUTH_REQUIRED');
  assert.strictEqual(api({ action: 'me', token: adminTok }).code, 'AUTH_REQUIRED');
  adminTok = api({ action: 'login', payload: { loginId: 'admin', password: 'Str0ngOakPass!' } }).data.token;
});

console.log('\nData parsing');
ok('dates parsed, overdue computed, statuses normalised', () => {
  const d = api({ action: 'getData', token: adminTok }).data;
  const r = d.sources.o2d.rows[0];
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r.timestampIso), r.timestampIso);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(r.promiseDateIso));
  const blank = d.sources.o2d.rows.find((x) => !x.finalStatus);
  assert.strictEqual(blank.status, 'Not Updated');
  const late = d.sources.o2d.rows.filter((x) => x.isOverdue);
  assert(late.every((x) => !x.isDone && !x.isCancelled && x.promiseDateIso < d.today && x.daysLate > 0));
  assert(d.sources.o2d.rows.every((x) => x.imageUrl === '' || x.imageUrl.startsWith('https://')));
});
ok('activity log records key events', () => {
  const items = api({ action: 'getActivity', token: adminTok, payload: { limit: 1000 } }).data.items;
  const ev = new Set(items.map((i) => i.event));
  ['SYSTEM_SETUP', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGIN_SUCCESS', 'PASSWORD_CHANGED', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'PASSWORD_RESET', 'FORCE_LOGOUT', 'ACCESS_DENIED', 'DATA_VIEW', 'LOGOUT_ALL'].forEach((e) => assert(ev.has(e), 'missing ' + e));
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' — FAILURES above' : ''));
module.exports = { env };
