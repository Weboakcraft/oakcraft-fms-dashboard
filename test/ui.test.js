/* Drives the real frontend against the real server code (via the Node harness). */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createEnv } = require('./harness');
const mock = require('./mockdata');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const env = createEnv({ o2dRows: mock.o2d(), tboRows: mock.tbo() });
  env.ctx.initialSetup();
  const tmp = env.logs.find((l) => l.startsWith('Temp password')).split(':').slice(1).join(':').trim();
  let t = env.api({ action: 'login', payload: { loginId: 'admin', password: tmp } }).data.token;
  t = env.api({ action: 'changePassword', token: t, payload: { currentPassword: tmp, newPassword: 'OakCraft#2026' } }).data.token;
  env.api({ action: 'createUser', token: t, payload: { loginId: 'niti', displayName: 'Niti Kumari', role: 'salesperson', salesperson: 'NITI KUMARI', password: 'Kumari#Secure26', mustChange: false } });
  env.api({ action: 'createUser', token: t, payload: { loginId: 'amira', displayName: 'Amira Saikh', role: 'salesperson', salesperson: 'AMIRA SAIKH', mustChange: true } });
  env.api({ action: 'createUser', token: t, payload: { loginId: 'boss', displayName: 'Rohit Sharma', role: 'manager', password: 'Manag3rPass', mustChange: false } });

  const html = env.ctx.doGet().getContent();
  const file = path.join(__dirname, 'out_index.html');
  fs.writeFileSync(file, html);

  const browser = await chromium.launch();
  const errors = [];
  async function newPage(viewport, scheme) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme || 'light', deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com|drive\.google\.com/, (r) => r.abort());
    await page.exposeFunction('__api', (req) => env.ctx.api(req));
    await page.addInitScript(() => {
      function runner() {
        let ok = () => {}, fail = () => {};
        const r = {
          withSuccessHandler(f) { ok = f; return r; },
          withFailureHandler(f) { fail = f; return r; },
          api(req) { setTimeout(() => window.__api(req).then(ok, fail), 120); }
        };
        return r;
      }
      window.google = { script: { get run() { return runner(); } } };
    });
    await page.goto('file://' + file);
    return page;
  }
  async function login(page, id, pw) {
    await page.fill('#login-id', id);
    await page.fill('#login-pw', pw);
    await page.click('#login-btn');
  }
  const shot = (page, name, full) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });

  // ---- Desktop: login screen
  let page = await newPage({ width: 1440, height: 900 });
  await page.waitForSelector('#login-form');
  await shot(page, '01_login');

  // wrong password
  await login(page, 'niti', 'wrongpass1');
  await page.waitForSelector('#login-alert:not([hidden])');
  console.log('login error text:', await page.textContent('#login-alert'));

  // ---- Salesperson
  await login(page, 'niti', 'Kumari#Secure26');
  await page.waitForSelector('.kpi-value');
  await page.waitForTimeout(700);
  await shot(page, '02_sales_overview', true);
  const leak = await page.evaluate(() => document.body.innerText.match(/AMIRA|UJALA|VISHU|MAYANK/gi));
  console.log('salesperson page mentions other names:', leak);

  await page.click('a[data-route="o2d"]');
  await page.waitForSelector('table.data tbody tr');
  await shot(page, '03_sales_o2d');
  await page.fill('#t-q', 'chair');
  await page.waitForTimeout(400);
  await page.click('[data-quick="open"]');
  await page.waitForTimeout(200);
  await page.click('th[data-sort="qty"]');
  await shot(page, '04_sales_o2d_filtered');
  await page.click('table.data tbody tr');
  await page.waitForSelector('.drawer');
  await shot(page, '05_detail_drawer');
  await page.keyboard.press('Escape');

  // Tampering in the browser: try to call admin API from devtools
  const tamper = await page.evaluate(() => new Promise((res) => google.script.run.withSuccessHandler(res).api(JSON.stringify({ action: 'listUsers', token: sessionStorage.getItem('fms.session') }))));
  console.log('salesperson calling listUsers from console →', tamper);
  // Navigating to admin hash
  await page.evaluate(() => { location.hash = '#/users'; });
  await page.waitForTimeout(300);
  console.log('salesperson on #/users shows:', await page.textContent('#page-title'));

  // ---- Admin
  await page.click('#user-btn');
  await page.click('#user-menu [data-action="logout"]');
  await page.waitForSelector('#login-form');
  await login(page, 'admin', 'OakCraft#2026');
  await page.waitForSelector('.kpi-value');
  await page.waitForTimeout(800);
  await shot(page, '06_admin_overview', true);
  await page.click('a[data-route="users"]');
  await page.waitForSelector('tr[data-uid]');
  await shot(page, '07_admin_users');
  await page.click('#u-new');
  await page.waitForSelector('#u-form');
  await page.fill('#f-name', 'Vishu Mittal');
  await page.fill('#f-login', 'vishu');
  await page.selectOption('#f-sp', 'VISHU MITTAL');
  await shot(page, '08_admin_add_user');
  await page.click('#f-save');
  await page.waitForSelector('.cred-box');
  await shot(page, '09_admin_credentials');
  await page.click('.modal-foot [data-dismiss]');
  await page.click('a[data-route="activity"]');
  await page.waitForSelector('table.data');
  await shot(page, '10_admin_activity');
  await page.click('a[data-route="system"]');
  await page.waitForSelector('#s-all');
  await shot(page, '11_admin_system');
  await page.click('a[data-route="tbo"]');
  await page.waitForSelector('table.data tbody tr');
  await shot(page, '12_admin_tbo');

  // ---- Dark mode admin overview
  const dark = await newPage({ width: 1440, height: 900 }, 'dark');
  await login(dark, 'boss', 'Manag3rPass');
  await dark.waitForSelector('.kpi-value');
  await dark.waitForTimeout(700);
  await shot(dark, '13_manager_dark');

  // ---- Forced password change screen
  const fc = await newPage({ width: 1280, height: 800 });
  const amiraPw = env.api({ action: 'resetPassword', token: env.api({ action: 'login', payload: { loginId: 'admin', password: 'OakCraft#2026' } }).data.token, payload: { userId: env.api({ action: 'listUsers', token: env.api({ action: 'login', payload: { loginId: 'admin', password: 'OakCraft#2026' } }).data.token }).data.users.find((u) => u.loginId === 'amira').userId } }).data.generatedPassword;
  await login(fc, 'amira', amiraPw);
  await fc.waitForSelector('#change-form:not([hidden])', { state: 'visible' });
  await fc.fill('#cp-current', amiraPw);
  await fc.fill('#cp-new', 'Saikh#Orders26');
  await shot(fc, '14_force_change');

  // ---- Mobile
  const m = await newPage({ width: 390, height: 844 });
  await m.waitForSelector('#login-form');
  await shot(m, '15_mobile_login');
  await login(m, 'niti', 'Kumari#Secure26');
  await m.waitForSelector('.kpi-value');
  await m.waitForTimeout(600);
  await shot(m, '16_mobile_overview', true);
  await m.click('#menu-btn');
  await m.waitForTimeout(300);
  await shot(m, '17_mobile_menu');
  await m.click('a[data-route="o2d"]');
  await m.waitForSelector('.ocard');
  await m.waitForTimeout(400);
  await shot(m, '18_mobile_o2d');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile horizontal overflow:', overflow);

  // ---- Tablet
  const tab = await newPage({ width: 820, height: 1180 });
  await login(tab, 'admin', 'OakCraft#2026');
  await tab.waitForSelector('.kpi-value');
  await tab.waitForTimeout(600);
  await shot(tab, '19_tablet_admin');

  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
