const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db, auth, FieldValue, Timestamp } = require('../firebase');
const idp = require('../idp');
const A = require('../auth');
const V = require('../validators');

const router = express.Router();
const limiter = max => rateLimit({ windowMs: 15 * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false, validate: { ip: false }, keyGenerator: req => req.ip || (req.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown', message: { error: 'Too many attempts. Please wait and try again.' } });
const loginLimiter = limiter(config.loginRateMax), registerLimiter = limiter(30), resetLimiter = limiter(Number(process.env.RESET_RATE_MAX || 10));
const fail = (res, status, error, fields) => res.status(status).json({ error, ...(fields && { fields }) });
const redirectFor = role => (role === 'admin' ? '/admin' : role === 'researcher' ? '/research' : '/dashboard');
const BAD_CREDS = ['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD'];

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.registerSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    if (data.role && data.role !== 'citizen') return fail(res, 403, 'Public registration is limited to the citizen role');
    const setting = await db.collection('settings').doc('system').get();
    if (setting.exists && setting.data().public_registration_enabled === false) return fail(res, 403, 'Registration is currently closed');

    let fbUser;
    try { fbUser = await auth.createUser({ email: data.email, password: data.password, displayName: data.full_name, emailVerified: false }); }
    catch (e) {
      if (e.code === 'auth/email-already-exists') return fail(res, 409, 'An account with this email already exists', { email: 'Email already registered' });
      throw e;
    }
    try {
      const vid = await A.findOrCreateVillage(data.village, data.district, data.state);
      const now = Timestamp.now();
      await db.collection('users').doc(fbUser.uid).set({
        full_name: data.full_name, email: data.email, phone: data.phone || null, state: data.state, district: data.district,
        village: data.village, village_id: vid, role: 'citizen', status: 'active', email_verified: false,
        failed_logins: 0, locked_until: null, assigned_village_ids: [], created_at: now, updated_at: now, last_login: now,
      });
    } catch (e) { await auth.deleteUser(fbUser.uid).catch(() => {}); throw e; }

    A.setSession(res, await idp.signIn(data.email, data.password));
    res.status(201).json({ user: A.publicUser(await A.getUserDoc(fbUser.uid)), redirect: '/dashboard' });
  } catch (e) { next(e); }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.loginSchema, req.body);
    if (errors) return fail(res, 400, 'Enter a valid email and password');
    const u = await A.getUserByEmail(data.email);
    if (u?.locked_until && u.locked_until.toDate() > new Date()) return fail(res, 429, 'Too many failed attempts. Try again later.');
    let tokens;
    try { tokens = await idp.signIn(data.email, data.password); }
    catch (e) {
      if (BAD_CREDS.includes(e.code)) {
        if (u) {
          const n = (u.failed_logins || 0) + 1;
          await db.collection('users').doc(u.id).update({
            failed_logins: FieldValue.increment(1),
            ...(n >= config.maxFailedLogins && { locked_until: Timestamp.fromMillis(Date.now() + config.lockMinutes * 60000) }),
          });
        }
        return fail(res, 401, 'Incorrect email or password');
      }
      if (e.code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return fail(res, 429, 'Too many failed attempts. Try again later.');
      if (e.code === 'USER_DISABLED') return fail(res, 403, 'This account is not active. Contact an administrator.');
      throw e;
    }
    if (!u) return fail(res, 401, 'Incorrect email or password');
    if (u.status !== 'active') return fail(res, 403, `This account is ${u.status}. Contact an administrator.`);
    await db.collection('users').doc(u.id).update({ failed_logins: 0, locked_until: null, last_login: Timestamp.now() });
    A.setSession(res, tokens);
    res.json({ user: A.publicUser(await A.getUserDoc(u.id)), redirect: redirectFor(u.role) });
  } catch (e) { next(e); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const u = await A.refreshSession(req, res);
    if (!u) { A.clearSession(res); return fail(res, 401, 'Session expired. Please sign in again.'); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Logout revokes every refresh token of the account (Firebase has per-user, not per-device, revocation).
router.post('/logout', async (req, res, next) => {
  try {
    const { r } = A.readCookie(req);
    if (r) {
      try {
        const t = await idp.refresh(r);                       // proves the cookie is genuine before we act on it
        const decoded = await auth.verifyIdToken(t.id_token);
        await auth.revokeRefreshTokens(decoded.uid);
      } catch { /* already invalid: just clear the cookie */ }
    }
    A.clearSession(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', A.authenticate, (req, res) => res.json({ user: A.publicUser(req.user) }));

router.put('/profile', A.authenticate, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.profileSchema, req.body); // strict: role/status/email are rejected
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    const vid = await A.findOrCreateVillage(data.village, data.district, data.state);
    await db.collection('users').doc(req.user.id).update({
      full_name: data.full_name, phone: data.phone || null, state: data.state, district: data.district,
      village: data.village, village_id: vid, updated_at: Timestamp.now(),
    });
    await auth.updateUser(req.user.id, { displayName: data.full_name });
    res.json({ user: A.publicUser(await A.getUserDoc(req.user.id)) });
  } catch (e) { next(e); }
});

router.post('/change-password', A.authenticate, resetLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.changePasswordSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    try { await idp.signIn(req.user.email, data.current_password); }
    catch (e) {
      if (BAD_CREDS.includes(e.code)) return fail(res, 400, 'Current password is incorrect', { current_password: 'Current password is incorrect' });
      throw e;
    }
    if (data.new_password === data.current_password) return fail(res, 400, 'Choose a password different from the current one', { new_password: 'Must differ from current password' });
    await auth.updateUser(req.user.id, { password: data.new_password });
    await auth.revokeRefreshTokens(req.user.id);                  // invalidate all existing sessions
    A.setSession(res, await idp.signIn(req.user.email, data.new_password)); // keep this device signed in
    res.json({ ok: true, message: 'Password changed. Other sessions were signed out.' });
  } catch (e) { next(e); }
});

router.post('/forgot-password', resetLimiter, async (req, res, next) => {
  try {
    const { data } = V.validate(V.z.object({ email: V.z.string().trim().toLowerCase().email() }), req.body);
    const msg = { ok: true, message: 'If that email is registered, a reset link has been issued.' };
    if (!data) return res.json(msg);
    const u = await A.getUserByEmail(data.email);
    if (!u || u.status === 'suspended') return res.json(msg);
    if (config.devResetTokens) {
      // DEVELOPMENT ONLY: return the reset code instead of relying on email delivery. Never enabled in production.
      const link = await auth.generatePasswordResetLink(data.email);
      const code = new URL(link).searchParams.get('oobCode');
      return res.json({ ...msg, dev_only_reset_token: code, dev_notice: 'DEVELOPMENT ONLY: shown because email delivery is not used in development.' });
    }
    await idp.sendResetEmail(data.email); // Firebase sends the email; the code is never returned or logged
    res.json(msg);
  } catch (e) { next(e); }
});

router.post('/reset-password', resetLimiter, async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.resetPasswordSchema, req.body);
    if (errors) return fail(res, 400, 'Please fix the highlighted fields', errors);
    let out;
    try { out = await idp.resetPassword(data.token, data.new_password); } // Firebase codes are single-use and expire
    catch (e) {
      if (['INVALID_OOB_CODE', 'EXPIRED_OOB_CODE'].includes(e.code)) return fail(res, 400, 'This reset link is invalid or has expired');
      throw e;
    }
    const fb = await auth.getUserByEmail(out.email);
    await auth.revokeRefreshTokens(fb.uid);
    const u = await A.getUserDoc(fb.uid);
    if (u) await db.collection('users').doc(u.id).update({ failed_logins: 0, locked_until: null, updated_at: Timestamp.now() });
    res.json({ ok: true, message: 'Password updated. You can now sign in.' });
  } catch (e) { next(e); }
});

module.exports = router;
