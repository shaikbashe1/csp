// End-to-end API workflow test against a running server + PostgreSQL.
// Usage: npm test   (server must be running; admin credentials are read from .env)
require('dotenv').config();
const { Client } = require('pg');
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
let pass = 0, failed = 0;
const ok = (cond, name, extra) => { cond ? pass++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? '  -> ' + JSON.stringify(extra) : ''}`); };

class Session {
  constructor() { this.jar = {}; }
  async req(method, path, body, headers = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) delete this.jar[k]; else this.jar[k] = v;
    }
    let json = null; const text = await res.text();
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, setCookies: res.headers.getSetCookie() };
  }
}

(async () => {
  const stamp = Date.now();
  const email = `citizen${stamp}@example.com`;
  const password = 'Str0ng!Passw0rd';
  const citizen = new Session(), admin = new Session(), anon = new Session();

  // Public pages exist
  let r = await anon.req('GET', '/register'); ok(r.status === 200 && /<html/i.test(r.json), 'GET /register serves the app');

  // 1-2 register a citizen; validation checks
  r = await anon.req('POST', '/api/auth/register', { full_name: 'T', email: 'bad', password: 'x', confirm_password: 'y', state: '', district: '', village: '' });
  ok(r.status === 400 && r.json.fields?.email && r.json.fields?.password, 'registration rejects invalid input', r.json);
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Weak', email: `w${stamp}@example.com`, password: 'password', confirm_password: 'password', state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 400 && r.json.fields?.password, 'weak password rejected');
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Mismatch', email: `m${stamp}@example.com`, password, confirm_password: password + 'x', state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 400 && r.json.fields?.confirm_password, 'password confirmation mismatch rejected');
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Sneaky', email: `s${stamp}@example.com`, password, confirm_password: password, state: 'AP', district: 'Guntur', village: 'Xyz', role: 'admin' });
  ok(r.status === 403, 'public registration cannot choose admin role', r.json);

  r = await citizen.req('POST', '/api/auth/register', { full_name: 'Bashe Test', email, password, confirm_password: password, phone: '9876543210', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village' });
  ok(r.status === 201 && r.json.user?.role === 'citizen' && r.json.redirect === '/dashboard', 'register creates citizen + redirect to dashboard', r.json);
  ok(!JSON.stringify(r.json).includes('password'), 'register response has no password data');
  const uuid = r.json.user?.id;
  ok(r.setCookies.some(c => /access_token=.*HttpOnly/i.test(c)) && r.setCookies.some(c => /refresh_token=.*HttpOnly/i.test(c)), 'auth cookies are HttpOnly');

  // 3 saved in PostgreSQL with hashed password
  const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
  const row = (await pg.query('SELECT * FROM users WHERE uuid=$1', [uuid])).rows[0];
  ok(row && row.email === email && row.role === 'citizen' && row.status === 'active', 'user row persisted in PostgreSQL');
  ok(row && /^\$2[aby]\$/.test(row.password_hash) && row.password_hash !== password, 'password stored as bcrypt hash');

  // duplicate email
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Dup', email: email.toUpperCase(), password, confirm_password: password, state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 409, 'duplicate email (case-insensitive) rejected', r.json);

  // 4-5 automatically authenticated
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200 && r.json.user.id === uuid && !('password_hash' in r.json.user), 'new user is authenticated; /me hides hash');
  r = await citizen.req('GET', '/api/dashboard');
  ok(r.status === 200 && r.json.healthcare.status === 'Pending' && r.json.antibiotic.status === 'Pending' && r.json.user.village === 'Xyz Village', 'dashboard is personalised from DB (Pending state)', r.json);

  // 6 logout
  r = await citizen.req('POST', '/api/auth/logout'); ok(r.status === 200, 'logout');
  const oldRefresh = null; void oldRefresh;
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 401, 'after logout /me is 401');

  // 7 login again
  r = await citizen.req('POST', '/api/auth/login', { email, password: 'Wrong!Pass1' }); ok(r.status === 401, 'wrong password rejected');
  r = await citizen.req('POST', '/api/auth/login', { email, password });
  ok(r.status === 200 && r.json.user.id === uuid && r.json.redirect === '/dashboard', 'login with stored credentials works', r.json);
  const lastLogin = (await pg.query('SELECT last_login FROM users WHERE uuid=$1', [uuid])).rows[0].last_login; ok(!!lastLogin, 'last_login updated');

  // 8 /me
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200 && r.json.user.email === email, 'GET /api/auth/me');

  // 9-10 healthcare assessment tied to user's UUID
  r = await citizen.req('GET', '/api/assessments/questions'); const qs = r.json;
  const answers = Object.fromEntries(qs.healthcare.map(q => [q.id, 2]));
  r = await citizen.req('POST', '/api/assessments/healthcare', { answers: { distance: 1 } }); ok(r.status === 400, 'incomplete assessment rejected');
  r = await citizen.req('POST', '/api/assessments/healthcare', { answers, user_id: 'attacker' });
  ok(r.status === 201 && r.json.assessment.user_id === uuid && r.json.assessment.gap_score === 67, 'healthcare assessment saved with server-side score', r.json);
  const arow = (await pg.query(`SELECT u.uuid FROM healthcare_assessments h JOIN users u ON u.id=h.user_id WHERE h.uuid=$1`, [r.json.assessment.id])).rows[0];
  ok(arow?.uuid === uuid, 'assessment row is linked to the logged-in user UUID in the database');
  r = await citizen.req('POST', '/api/assessments/antibiotic', { answers: Object.fromEntries(qs.antibiotic.map((q, i) => [q.id, i < 3 ? 2 : 1])) });
  ok(r.status === 201 && r.json.assessment.risk_level === 'Moderate', 'antibiotic assessment saved', r.json);
  r = await citizen.req('GET', '/api/dashboard');
  ok(r.json.healthcare.status === 'Completed' && r.json.healthcare.gap_score === 67 && r.json.antibiotic.risk_level === 'Moderate', 'dashboard now reflects saved assessments', r.json);

  // RBAC for citizen
  for (const p of ['/api/admin/users', '/api/admin/stats', '/api/research/summary']) {
    r = await citizen.req('GET', p); ok(r.status === 403, `citizen forbidden: ${p}`, r.status);
  }
  r = await citizen.req('PUT', '/api/auth/profile', { full_name: 'Bashe', state: 'AP', district: 'Guntur', village: 'Xyz Village', role: 'admin' });
  ok(r.status === 400, 'profile update refuses role field');
  r = await citizen.req('PATCH', `/api/admin/users/${uuid}`, { role: 'admin' }); ok(r.status === 403, 'citizen cannot escalate own role');
  r = await citizen.req('PUT', '/api/auth/profile', { full_name: 'Bashe Updated', phone: '9123456780', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village' });
  ok(r.status === 200 && r.json.user.full_name === 'Bashe Updated' && r.json.user.role === 'citizen', 'profile update works');

  // CSRF header requirement + forged token
  r = await citizen.req('POST', '/api/auth/logout', undefined, { 'X-Requested-With': '' }); ok(r.status === 403, 'state-changing request without CSRF header refused');
  const forged = new Session(); forged.jar.access_token = 'abc.def.ghi';
  r = await forged.req('GET', '/api/auth/me'); ok(r.status === 401, 'forged token rejected');

  // refresh rotation + reuse detection
  const rf = new Session(); r = await rf.req('POST', '/api/auth/login', { email, password });
  const stale = rf.jar.refresh_token;
  r = await rf.req('POST', '/api/auth/refresh'); ok(r.status === 200 && rf.jar.refresh_token !== stale, 'refresh rotates the refresh token');
  r = await rf.req('GET', '/api/auth/me'); ok(r.status === 200, 'new access token works');
  const replay = new Session(); replay.jar.refresh_token = stale;
  r = await replay.req('POST', '/api/auth/refresh'); ok(r.status === 401, 'reused (rotated-out) refresh token rejected');
  r = await rf.req('POST', '/api/auth/refresh'); ok(r.status === 401, 'reuse detection revoked the whole token family');

  // expired access token
  const jwt = require('jsonwebtoken');
  const expired = new Session(); expired.jar.access_token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { subject: uuid, issuer: 'healthgap', expiresIn: -10 });
  r = await expired.req('GET', '/api/auth/me'); ok(r.status === 401 && r.json.code === 'token_expired', 'expired token rejected');
  const claimAdmin = new Session(); claimAdmin.jar.access_token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { subject: uuid, issuer: 'healthgap', expiresIn: 60 });
  r = await claimAdmin.req('GET', '/api/admin/users'); ok(r.status === 403, 'role claim in token is ignored; DB role wins');

  // change password
  const other = new Session(); await other.req('POST', '/api/auth/login', { email, password });
  r = await citizen.req('POST', '/api/auth/change-password', { current_password: 'nope', new_password: 'N3w!Passw0rdX', confirm_new_password: 'N3w!Passw0rdX' }); ok(r.status === 400, 'change-password verifies current password');
  const newPw = 'N3w!Passw0rdX';
  r = await citizen.req('POST', '/api/auth/change-password', { current_password: password, new_password: newPw, confirm_new_password: newPw }); ok(r.status === 200, 'password changed');
  r = await other.req('POST', '/api/auth/refresh'); ok(r.status === 401, 'other sessions invalidated after password change');
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200, 'current device stays signed in');
  r = await anon.req('POST', '/api/auth/login', { email, password }); ok(r.status === 401, 'old password no longer works');

  // forgot / reset password
  r = await anon.req('POST', '/api/auth/forgot-password', { email: `nobody${stamp}@example.com` }); ok(r.status === 200 && !r.json.dev_only_reset_token, 'forgot-password does not reveal unknown emails');
  r = await anon.req('POST', '/api/auth/forgot-password', { email });
  const tok = r.json.dev_only_reset_token; ok(r.status === 200 && tok && r.json.dev_notice, 'dev reset token issued and labelled DEVELOPMENT ONLY');
  const th = (await pg.query('SELECT token_hash FROM password_reset_tokens ORDER BY id DESC LIMIT 1')).rows[0].token_hash; ok(th !== tok && th.length === 64, 'reset token stored hashed');
  const resetPw = 'R3set!Passw0rdY';
  r = await anon.req('POST', '/api/auth/reset-password', { token: tok, new_password: resetPw, confirm_new_password: resetPw }); ok(r.status === 200, 'reset password with token');
  r = await anon.req('POST', '/api/auth/reset-password', { token: tok, new_password: 'An0ther!Passw0rd', confirm_new_password: 'An0ther!Passw0rd' }); ok(r.status === 400, 'reset token is one-time use');
  r = await citizen.req('POST', '/api/auth/refresh'); ok(r.status === 401, 'reset invalidated existing sessions');

  // 11-13 logout, /dashboard needs auth
  const c2 = new Session(); r = await c2.req('POST', '/api/auth/login', { email, password: resetPw }); ok(r.status === 200, 'login with reset password');
  r = await c2.req('POST', '/api/auth/logout'); ok(r.status === 200, 'logout again');
  r = await c2.req('GET', '/api/dashboard'); ok(r.status === 401, 'unauthenticated /api/dashboard => 401 (UI redirects to /login)');

  // 14-16 admin
  r = await admin.req('POST', '/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  ok(r.status === 200 && r.json.user.role === 'admin' && r.json.redirect === '/admin', 'admin login (credentials from .env/DB)', r.json.error);
  r = await admin.req('GET', '/api/admin/stats'); const s0 = r.json.totals;
  ok(r.status === 200 && s0.total_users >= 2 && s0.citizens >= 1 && s0.healthcare_assessments >= 1, 'admin stats computed from DB', s0);
  const dbUsers = (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n; ok(s0.total_users === dbUsers, 'admin total_users equals SELECT count(*)');
  r = await admin.req('GET', `/api/admin/users?q=${encodeURIComponent(email)}`);
  ok(r.status === 200 && r.json.users.some(u => u.id === uuid && u.role === 'citizen') && !JSON.stringify(r.json).includes('password'), 'new user appears in admin user management; no hashes exposed');
  r = await admin.req('GET', '/api/admin/users?role=citizen&status=active'); ok(r.json.users.every(u => u.role === 'citizen' && u.status === 'active'), 'role/status filters');

  // charts update when new data arrives
  const c3 = new Session(); await c3.req('POST', '/api/auth/login', { email, password: resetPw });
  await c3.req('POST', '/api/assessments/healthcare', { answers });
  r = await admin.req('GET', '/api/admin/stats'); ok(r.json.totals.healthcare_assessments === s0.healthcare_assessments + 1, 'stats update after new submission');

  // suspend / activate / role change
  r = await admin.req('PATCH', `/api/admin/users/${uuid}`, { status: 'suspended' }); ok(r.status === 200 && r.json.user.status === 'suspended', 'admin suspends user');
  r = await c3.req('GET', '/api/auth/me'); ok(r.status === 403, 'suspended user blocked immediately on existing session');
  r = await anon.req('POST', '/api/auth/login', { email, password: resetPw }); ok(r.status === 403, 'suspended user cannot log in');
  r = await admin.req('PATCH', `/api/admin/users/${uuid}`, { status: 'active', role: 'researcher' }); ok(r.status === 200 && r.json.user.role === 'researcher', 'admin reactivates + changes role');
  const res2 = new Session(); await res2.req('POST', '/api/auth/login', { email, password: resetPw });
  r = await res2.req('GET', '/api/research/summary');
  ok(r.status === 200 && !/@|full_name|"id"|phone/.test(JSON.stringify(r.json)), 'researcher gets aggregates without PII', r.status);
  r = await res2.req('GET', '/api/research/export.csv'); ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && !/@/.test(r.json), 'CSV export has no PII');
  r = await res2.req('GET', '/api/admin/users'); ok(r.status === 403, 'researcher cannot reach admin API');
  r = await res2.req('POST', '/api/assessments/healthcare', { answers }); ok(r.status === 403, 'researcher cannot submit citizen assessments');
  r = await admin.req('PATCH', `/api/admin/users/${uuid}`, { role: 'citizen' });
  const adminSelf = (await admin.req('GET', '/api/auth/me')).json.user.id;
  r = await admin.req('PATCH', `/api/admin/users/${adminSelf}`, { role: 'citizen' }); ok(r.status === 400, 'admin cannot demote self');

  // admin-created field worker
  const fwEmail = `fw${stamp}@example.com`;
  r = await admin.req('POST', '/api/admin/users', { full_name: 'Kiran Worker', email: fwEmail, password: 'W0rker!Passw0rd', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village', role: 'field_worker' });
  ok(r.status === 201, 'admin creates field worker', r.json);
  const fwId = r.json.id; const vid = (await pg.query(`SELECT id FROM villages WHERE lower(name)='xyz village'`)).rows[0].id;
  r = await admin.req('PUT', `/api/admin/users/${fwId}/villages`, { village_ids: [vid] }); ok(r.status === 200, 'admin assigns village to worker');
  const fw = new Session(); await fw.req('POST', '/api/auth/login', { email: fwEmail, password: 'W0rker!Passw0rd' });
  r = await fw.req('GET', '/api/field/villages'); ok(r.status === 200 && r.json.villages.length === 1, 'field worker sees assigned villages');
  r = await fw.req('POST', '/api/field/surveys', { village_id: vid + 999, households: 4 }); ok(r.status === 403, 'field worker blocked from unassigned village');
  r = await fw.req('POST', '/api/field/surveys', { village_id: vid, households: 12, notes: 'ok' }); ok(r.status === 201, 'field worker submits survey');
  r = await fw.req('GET', '/api/admin/users'); ok(r.status === 403, 'field worker cannot reach admin API');

  // 17 citizen cannot access admin
  const c4 = new Session(); await c4.req('POST', '/api/auth/login', { email, password: resetPw });
  r = await c4.req('GET', '/api/admin/users'); ok(r.status === 403, 'citizen role cannot access admin API (after role restored)', r.status);

  // brute force lockout
  const bf = `bf${stamp}@example.com`;
  await anon.req('POST', '/api/auth/register', { full_name: 'Brute Target', email: bf, password, confirm_password: password, state: 'AP', district: 'G', village: 'V' });
  for (let i = 0; i < 5; i++) await anon.req('POST', '/api/auth/login', { email: bf, password: 'Bad!Guess1' + i });
  r = await anon.req('POST', '/api/auth/login', { email: bf, password }); ok(r.status === 429, 'account locks after repeated failures (even with correct password)', r.status);

  await pg.end();
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
