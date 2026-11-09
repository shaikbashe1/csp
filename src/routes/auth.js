const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const A = require('../auth');
const V = require('../validators');

const router = express.Router();
const MAX_FAILED = 5, LOCK_MINUTES = 15;

const limiter = (max, windowMs = 15 * 60 * 1000) => rateLimit({
  windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' },
});
const loginLimiter = limiter(config.loginRateMax);
const registerLimiter = limiter(30);
const resetLimiter = limiter(10);

const fail = (res, status, error, fields) => res.status(status).json({ error, ...(fields && { fields }) });

async function loadUser(where, param) {
  const r = await db.query(`SELECT u.id, u.password_hash, u.failed_logins, u.locked_until, ${A.USER_COLUMNS}
    FROM users u LEFT JOIN villages v ON v.id=u.village_id WHERE ${where}`, [param]);
  return r.rows[0];
}

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.registerSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    // Public registration can only ever create citizens.
    if (data.role && data.role !== 'citizen') return fail(res, 403, 'Public registration is limited to the citizen role');
    const setting = await db.query(`SELECT value FROM system_settings WHERE key='public_registration_enabled'`);
    if (setting.rows[0]?.value === false) return fail(res, 403, 'Registration is currently closed');

    const client = await db.pool.connect();
    let uuid;
    try {
      await client.query('BEGIN');
      const villageId = await A.findOrCreateVillage(client, data.village, data.district, data.state);
      const hash = await A.hashPassword(data.password);
      const ins = await client.query(
        `INSERT INTO users (full_name,email,password_hash,phone,state,district,village_id,role,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'citizen','active') RETURNING uuid`,
        [data.full_name, data.email, hash, data.phone || null, data.state, data.district, villageId]);
      uuid = ins.rows[0].uuid;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return fail(res, 409, 'An account with this email already exists', { email: 'Email already registered' });
      throw e;
    } finally { client.release(); }

    const user = await loadUser('u.uuid=$1', uuid);
    await A.startSession(req, res, user);
    res.status(201).json({ user: A.publicUser(user), redirect: '/dashboard' });
  } catch (e) { next(e); }
});

const redirectFor = role => (role === 'admin' ? '/admin' : role === 'researcher' ? '/research' : '/dashboard');

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.loginSchema, req.body);
    if (errors) return fail(res, 400, 'Enter a valid email and password');
    const u = await loadUser('lower(u.email)=$1', data.email);
    const generic = () => fail(res, 401, 'Incorrect email or password');

    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      await A.verifyPassword(data.password, u.password_hash); // keep timing uniform
      return fail(res, 429, 'Too many failed attempts. Try again later.');
    }
    const ok = await A.verifyPassword(data.password, u?.password_hash);
    if (!u || !ok) {
      if (u) {
        await db.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END,
             updated_at = now() WHERE id=$1`, [u.id, MAX_FAILED, String(LOCK_MINUTES)]);
      }
      return generic();
    }
    if (u.status !== 'active') return fail(res, 403, `This account is ${u.status}. Contact an administrator.`);

    await db.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login=now() WHERE id=$1', [u.id]);
    await A.startSession(req, res, u);
    const fresh = await loadUser('u.id=$1', u.id);
    res.json({ user: A.publicUser(fresh), redirect: redirectFor(u.role) });
  } catch (e) { next(e); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const u = await A.rotateRefresh(req, res);
    if (!u) { A.clearAuthCookies(res); return fail(res, 401, 'Session expired. Please sign in again.'); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh_token;
    if (raw) {
      await db.query(
        `UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=(SELECT family_id FROM refresh_tokens WHERE token_hash=$1) AND revoked_at IS NULL`,
        [A.sha256(raw)]);
    }
    A.clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', A.authenticate, (req, res) => res.json({ user: A.publicUser(req.user) }));

router.put('/profile', A.authenticate, async (req, res, next) => {
  try {
    // .strict() rejects role/status/email etc. — users cannot change their own role.
    const { data, errors } = V.validate(V.profileSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const vid = await A.findOrCreateVillage(client, data.village, data.district, data.state);
      await client.query(
        `UPDATE users SET full_name=$2, phone=$3, state=$4, district=$5, village_id=$6, updated_at=now() WHERE id=$1`,
        [req.user.id, data.full_name, data.phone || null, data.state, data.district, vid]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ user: A.publicUser(await loadUser('u.id=$1', req.user.id)) });
  } catch (e) { next(e); }
});

router.post('/change-password', A.authenticate, resetLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.changePasswordSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    const u = await loadUser('u.id=$1', req.user.id);
    if (!(await A.verifyPassword(data.current_password, u.password_hash)))
      return fail(res, 400, 'Current password is incorrect', { current_password: 'Current password is incorrect' });
    if (data.new_password === data.current_password)
      return fail(res, 400, 'Choose a password different from the current one', { new_password: 'Must differ from current password' });
    await db.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [u.id, await A.hashPassword(data.new_password)]);
    await A.revokeAllForUser(u.id);              // invalidate every existing refresh session
    await A.startSession(req, res, u);           // keep this device signed in with a fresh session
    res.json({ ok: true, message: 'Password changed. Other sessions were signed out.' });
  } catch (e) { next(e); }
});

router.post('/forgot-password', resetLimiter, async (req, res, next) => {
  try {
    const { data } = V.validate(V.z.object({ email: V.z.string().trim().toLowerCase().email() }), req.body);
    const msg = { ok: true, message: 'If that email is registered, a reset link has been issued.' };
    if (!data) return res.json(msg);
    const u = await loadUser('lower(u.email)=$1', data.email);
    if (!u || u.status === 'suspended') return res.json(msg);
    const raw = crypto.randomBytes(32).toString('base64url');
    await db.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [u.id]);
    await db.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`,
      [u.id, A.sha256(raw)]);
    // No email service is configured. In development ONLY the token is returned in the response so the flow
    // can be exercised. It is never logged, and is never returned when NODE_ENV=production.
    if (config.devResetTokens) return res.json({ ...msg, dev_only_reset_token: raw, dev_notice: 'DEVELOPMENT ONLY: shown because no email service is configured.' });
    res.json(msg);
  } catch (e) { next(e); }
});

router.post('/reset-password', resetLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.resetPasswordSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // One-time use: claim the token atomically.
      const t = await client.query(
        `UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`,
        [A.sha256(data.token)]);
      if (!t.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'This reset link is invalid or has expired'); }
      const uid = t.rows[0].user_id;
      await client.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1',
        [uid, await A.hashPassword(data.new_password)]);
      await A.revokeAllForUser(uid, client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true, message: 'Password updated. You can now sign in.' });
  } catch (e) { next(e); }
});

module.exports = router;
