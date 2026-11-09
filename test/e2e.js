// End-to-end test against the Firebase emulators (Auth + Firestore + Functions + Hosting).
//   npm run emulators          (terminal 1)
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed   then   same env: npm test
const path = require('path');
require(path.join(__dirname, '..', 'scripts', 'load-local-env.js'));
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ||= 'demo-healthgap';
const { db, auth } = require(path.join(__dirname, '..', 'functions', 'src', 'firebase.js'));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';
let pass = 0, failed = 0;
const ok = (cond, name, extra) => { cond ? pass++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); };

class Session {
  constructor() { this.jar = {}; }
  async req(method, p, body, headers = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + p, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, setCookies: res.headers.getSetCookie() };
  }
}

(async () => {
  const stamp = Date.now();
  const email = `citizen${stamp}@example.com`, password = 'Str0ng!Passw0rd';
  const citizen = new Session(), admin = new Session(), anon = new Session();
  const adminEmail = process.env.ADMIN_EMAIL, adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (same values used with `npm run seed`)');

  let r = await anon.req('GET', '/register'); ok(r.status === 200 && /<html/i.test(r.json), 'GET /register serves the app (Hosting rewrite)');

  r = await anon.req('POST', '/api/auth/register', { full_name: 'T', email: 'bad', password: 'x', confirm_password: 'y', state: '', district: '', village: '' });
  ok(r.status === 400 && r.json.fields?.email && r.json.fields?.password, 'registration rejects invalid input', r.json);
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Weak', email: `w${stamp}@example.com`, password: 'password', confirm_password: 'password', state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 400 && r.json.fields?.password, 'weak password rejected');
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Mismatch', email: `m${stamp}@example.com`, password, confirm_password: password + 'x', state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 400 && r.json.fields?.confirm_password, 'password confirmation mismatch rejected');
  r = await anon.req('POST', '/api/auth/register', { full_name: 'Sneaky', email: `s${stamp}@example.com`, password, confirm_password: password, state: 'AP', district: 'Guntur', village: 'Xyz', role: 'admin' });
  ok(r.status === 403, 'public registration cannot choose admin role', r.json);

  // 1-5 register -> persisted -> auto-authenticated -> dashboard
  r = await citizen.req('POST', '/api/auth/register', { full_name: 'Bashe Test', email, password, confirm_password: password, phone: '9876543210', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village' });
  ok(r.status === 201 && r.json.user?.role === 'citizen' && r.json.redirect === '/dashboard', 'register creates citizen + redirect to dashboard', r.json);
  ok(!JSON.stringify(r.json).toLowerCase().includes('password'), 'register response has no password data');
  const uid = r.json.user?.id;
  ok(r.setCookies.some(c => /__session=.*HttpOnly/i.test(c)) && r.setCookies.some(c => /SameSite=Strict/i.test(c)), 'session cookie is HttpOnly + SameSite=Strict');
  const doc = (await db.collection('users').doc(uid).get()).data();
  ok(doc && doc.email === email && doc.role === 'citizen' && doc.status === 'active' && doc.created_at, 'user profile persisted in Firestore');
  ok(!('password' in doc) && !('password_hash' in doc), 'no password material in Firestore profile');
  const fb = await auth.getUser(uid); ok(fb.email === email && !!fb.passwordHash, 'credentials stored (hashed) by Firebase Auth');

  r = await anon.req('POST', '/api/auth/register', { full_name: 'Dup', email: email.toUpperCase(), password, confirm_password: password, state: 'AP', district: 'Guntur', village: 'Xyz' });
  ok(r.status === 409, 'duplicate email (case-insensitive) rejected', r.json);

  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200 && r.json.user.id === uid && !('password_hash' in r.json.user), 'new user is authenticated via /api/auth/me');
  r = await citizen.req('GET', '/api/dashboard');
  ok(r.status === 200 && r.json.healthcare.status === 'Pending' && r.json.antibiotic.status === 'Pending' && r.json.user.village === 'Xyz Village', 'dashboard personalised from Firestore (Pending)', r.json);

  // 6-8 logout, login again
  r = await citizen.req('POST', '/api/auth/logout'); ok(r.status === 200, 'logout');
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 401, 'after logout /me is 401');
  r = await citizen.req('POST', '/api/auth/login', { email, password: 'Wrong!Pass1' }); ok(r.status === 401, 'wrong password rejected');
  r = await citizen.req('POST', '/api/auth/login', { email, password });
  ok(r.status === 200 && r.json.user.id === uid && r.json.redirect === '/dashboard', 'login with stored credentials works', r.json);
  ok(!!(await db.collection('users').doc(uid).get()).data().last_login, 'last_login updated');
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200 && r.json.user.email === email, 'GET /api/auth/me');

  // 9-10 assessments tied to the user
  const qs = (await citizen.req('GET', '/api/assessments/questions')).json;
  const answers = Object.fromEntries(qs.healthcare.map(q => [q.id, 2]));
  r = await citizen.req('POST', '/api/assessments/healthcare', { answers: { distance: 1 } }); ok(r.status === 400, 'incomplete assessment rejected');
  r = await citizen.req('POST', '/api/assessments/healthcare', { answers, user_id: 'attacker' });
  ok(r.status === 201 && r.json.assessment.user_id === uid && r.json.assessment.gap_score === 67, 'healthcare assessment saved, server-side score', r.json);
  const ad = (await db.collection('healthcare_assessments').doc(r.json.assessment.id).get()).data();
  ok(ad?.user_id === uid, 'assessment document is linked to the logged-in user id in Firestore');
  r = await citizen.req('POST', '/api/assessments/antibiotic', { answers: Object.fromEntries(qs.antibiotic.map((q, i) => [q.id, i < 3 ? 2 : 1])) });
  ok(r.status === 201 && r.json.assessment.risk_level === 'Moderate', 'antibiotic assessment saved', r.json);
  r = await citizen.req('GET', '/api/dashboard');
  ok(r.json.healthcare.status === 'Completed' && r.json.healthcare.gap_score === 67 && r.json.antibiotic.risk_level === 'Moderate', 'dashboard reflects saved assessments', r.json);

  // RBAC for citizen
  for (const p of ['/api/admin/users', '/api/admin/stats', '/api/research/summary']) { r = await citizen.req('GET', p); ok(r.status === 403, `citizen forbidden: ${p}`, r.status); }
  r = await citizen.req('PUT', '/api/auth/profile', { full_name: 'Bashe', state: 'AP', district: 'Guntur', village: 'Xyz Village', role: 'admin' }); ok(r.status === 400, 'profile update refuses role field');
  r = await citizen.req('PATCH', `/api/admin/users/${uid}`, { role: 'admin' }); ok(r.status === 403, 'citizen cannot escalate own role');
  r = await citizen.req('PUT', '/api/auth/profile', { full_name: 'Bashe Updated', phone: '9123456780', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village' });
  ok(r.status === 200 && r.json.user.full_name === 'Bashe Updated' && r.json.user.role === 'citizen', 'profile update works');

  // CSRF header + forged tokens
  r = await citizen.req('POST', '/api/auth/logout', undefined, { 'X-Requested-With': '' }); ok(r.status === 403, 'state-changing request without CSRF header refused');
  const forged = new Session(); forged.jar.__session = Buffer.from(JSON.stringify({ a: 'abc.def.ghi', r: 'x' })).toString('base64url');
  r = await forged.req('GET', '/api/auth/me'); ok(r.status === 401, 'forged token rejected');
  r = await forged.req('POST', '/api/auth/refresh'); ok(r.status === 401, 'forged refresh token rejected');

  // refresh
  const rf = new Session(); await rf.req('POST', '/api/auth/login', { email, password });
  r = await rf.req('POST', '/api/auth/refresh'); ok(r.status === 200, 'refresh issues a new access token');
  r = await rf.req('GET', '/api/auth/me'); ok(r.status === 200, 'refreshed session works');

  // change password
  const other = new Session(); await other.req('POST', '/api/auth/login', { email, password }); await new Promise(r => setTimeout(r, 1500)); // Firebase revocation has 1s resolution
  r = await citizen.req('POST', '/api/auth/change-password', { current_password: 'nope', new_password: 'N3w!Passw0rdX', confirm_new_password: 'N3w!Passw0rdX' }); ok(r.status === 400, 'change-password verifies current password');
  const newPw = 'N3w!Passw0rdX';
  r = await citizen.req('POST', '/api/auth/change-password', { current_password: password, new_password: newPw, confirm_new_password: newPw }); ok(r.status === 200, 'password changed');
  r = await other.req('GET', '/api/auth/me'); ok(r.status === 401 && r.json.code === 'token_revoked', 'other sessions invalidated after password change', r);
  // NOTE: production Firebase also refuses to refresh a revoked refresh token; the Auth emulator does not, so that is not asserted here.
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 200, 'current device stays signed in');
  r = await anon.req('POST', '/api/auth/login', { email, password }); ok(r.status === 401, 'old password no longer works');

  // forgot / reset
  r = await anon.req('POST', '/api/auth/forgot-password', { email: `nobody${stamp}@example.com` }); ok(r.status === 200 && !r.json.dev_only_reset_token, 'forgot-password does not reveal unknown emails');
  r = await anon.req('POST', '/api/auth/forgot-password', { email });
  const tok = r.json.dev_only_reset_token; ok(r.status === 200 && tok && /DEVELOPMENT ONLY/.test(r.json.dev_notice), 'dev reset code issued and labelled DEVELOPMENT ONLY');
  const resetPw = 'R3set!Passw0rdY'; await new Promise(r => setTimeout(r, 1500));
  r = await anon.req('POST', '/api/auth/reset-password', { token: 'bogus'.repeat(8), new_password: resetPw, confirm_new_password: resetPw }); ok(r.status === 400, 'invalid reset code rejected');
  r = await anon.req('POST', '/api/auth/reset-password', { token: tok, new_password: resetPw, confirm_new_password: resetPw }); ok(r.status === 200, 'reset password with code');
  r = await anon.req('POST', '/api/auth/reset-password', { token: tok, new_password: 'An0ther!Passw0rd', confirm_new_password: 'An0ther!Passw0rd' }); ok(r.status === 400, 'reset code is one-time use');
  r = await citizen.req('GET', '/api/auth/me'); ok(r.status === 401, 'reset invalidated existing sessions');

  // 11-13
  const c2 = new Session(); r = await c2.req('POST', '/api/auth/login', { email, password: resetPw }); ok(r.status === 200, 'login with reset password');
  r = await c2.req('POST', '/api/auth/logout'); ok(r.status === 200, 'logout again');
  r = await c2.req('GET', '/api/dashboard'); ok(r.status === 401, 'unauthenticated /api/dashboard => 401 (UI redirects to /login)');

  // 14-16 admin
  r = await admin.req('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  ok(r.status === 200 && r.json.user.role === 'admin' && r.json.redirect === '/admin', 'admin login (credentials from env, stored in Firebase Auth)', r.json.error);
  r = await admin.req('GET', '/api/admin/stats'); const s0 = r.json.totals;
  ok(r.status === 200 && s0.total_users >= 2 && s0.citizens >= 1 && s0.healthcare_assessments >= 1, 'admin stats computed from Firestore', s0);
  const dbUsers = (await db.collection('users').count().get()).data().count; ok(s0.total_users === dbUsers, 'admin total_users equals Firestore document count');
  r = await admin.req('GET', `/api/admin/users?q=${encodeURIComponent(email)}`);
  ok(r.status === 200 && r.json.users.some(u => u.id === uid && u.role === 'citizen') && !/password/i.test(JSON.stringify(r.json)), 'new user appears in admin user management; no hashes exposed');
  r = await admin.req('GET', '/api/admin/users?role=citizen&status=active'); ok(r.json.users.length > 0 && r.json.users.every(u => u.role === 'citizen' && u.status === 'active'), 'role/status filters');

  const c3 = new Session(); await c3.req('POST', '/api/auth/login', { email, password: resetPw });
  await c3.req('POST', '/api/assessments/healthcare', { answers });
  r = await admin.req('GET', '/api/admin/stats'); ok(r.json.totals.healthcare_assessments === s0.healthcare_assessments + 1, 'stats update after a new submission');

  r = await admin.req('PATCH', `/api/admin/users/${uid}`, { status: 'suspended' }); ok(r.status === 200 && r.json.user.status === 'suspended', 'admin suspends user');
  r = await c3.req('GET', '/api/auth/me'); ok([401, 403].includes(r.status), 'suspended user blocked immediately on existing session', r.status);
  r = await anon.req('POST', '/api/auth/login', { email, password: resetPw }); ok(r.status === 403, 'suspended user cannot log in', r.status);
  r = await admin.req('PATCH', `/api/admin/users/${uid}`, { status: 'active', role: 'researcher' }); ok(r.status === 200 && r.json.user.role === 'researcher', 'admin reactivates + changes role');
  r = await c3.req('GET', '/api/research/summary'); ok(r.status === 401, 'role change signs out the old session');
  const res2 = new Session(); await res2.req('POST', '/api/auth/login', { email, password: resetPw });
  r = await res2.req('GET', '/api/research/summary');
  ok(r.status === 200 && !/@|full_name|phone|"id"/.test(JSON.stringify(r.json)), 'researcher gets aggregates without PII', r.status);
  r = await res2.req('GET', '/api/research/export.csv'); ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && !/@/.test(r.json), 'CSV export has no PII');
  r = await res2.req('GET', '/api/admin/users'); ok(r.status === 403, 'researcher cannot reach admin API');
  r = await res2.req('POST', '/api/assessments/healthcare', { answers }); ok(r.status === 403, 'researcher cannot submit citizen assessments');
  await admin.req('PATCH', `/api/admin/users/${uid}`, { role: 'citizen' });
  const adminSelf = (await admin.req('GET', '/api/auth/me')).json.user.id;
  r = await admin.req('PATCH', `/api/admin/users/${adminSelf}`, { role: 'citizen' }); ok(r.status === 400, 'admin cannot demote self');

  // field worker created by admin
  const fwEmail = `fw${stamp}@example.com`;
  r = await admin.req('POST', '/api/admin/users', { full_name: 'Kiran Worker', email: fwEmail, password: 'W0rker!Passw0rd', state: 'Andhra Pradesh', district: 'Guntur', village: 'Xyz Village', role: 'field_worker' });
  ok(r.status === 201, 'admin creates field worker', r.json); const fwId = r.json.id;
  const villages = (await admin.req('GET', '/api/admin/villages')).json.villages; const vid = villages.find(v => v.name === 'Xyz Village').id;
  r = await admin.req('PUT', `/api/admin/users/${fwId}/villages`, { village_ids: [vid] }); ok(r.status === 200, 'admin assigns village to worker');
  const fw = new Session(); await fw.req('POST', '/api/auth/login', { email: fwEmail, password: 'W0rker!Passw0rd' });
  r = await fw.req('GET', '/api/field/villages'); ok(r.status === 200 && r.json.villages.length === 1, 'field worker sees assigned villages');
  r = await fw.req('POST', '/api/field/surveys', { village_id: 'f'.repeat(20), households: 4 }); ok(r.status === 403, 'field worker blocked from unassigned village');
  r = await fw.req('POST', '/api/field/surveys', { village_id: vid, households: 12, notes: 'ok' }); ok(r.status === 201, 'field worker submits survey');
  r = await fw.req('POST', '/api/assessments/healthcare', { answers, village_id: vid }); ok(r.status === 201, 'field worker files assessment for assigned village');
  r = await fw.req('GET', '/api/admin/users'); ok(r.status === 403, 'field worker cannot reach admin API');

  // 17
  const c4 = new Session(); await c4.req('POST', '/api/auth/login', { email, password: resetPw });
  r = await c4.req('GET', '/api/admin/users'); ok(r.status === 403, 'citizen cannot access admin API', r.status);
  r = await c4.req('GET', '/api/admin/stats'); ok(r.status === 403, 'citizen cannot access admin stats');

  // brute force
  const bf = `bf${stamp}@example.com`;
  await anon.req('POST', '/api/auth/register', { full_name: 'Brute Target', email: bf, password, confirm_password: password, state: 'AP', district: 'G', village: 'V' });
  for (let i = 0; i < 5; i++) await anon.req('POST', '/api/auth/login', { email: bf, password: 'Bad!Guess1' + i });
  r = await anon.req('POST', '/api/auth/login', { email: bf, password }); ok(r.status === 429, 'account locks after repeated failures (even with the correct password)', r.status);

  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
