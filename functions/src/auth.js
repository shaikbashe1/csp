const crypto = require('crypto');
const config = require('./config');
const { db, auth, Timestamp } = require('./firebase');
const idp = require('./idp');

// Firebase Hosting only forwards a cookie named "__session" to Cloud Functions, so the access token (Firebase ID
// token, 1h) and the refresh token live together in one HttpOnly cookie.
const COOKIE = '__session';
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/', maxAge: 14 * 86400 * 1000 };
const packCookie = (a, r) => Buffer.from(JSON.stringify({ a, r })).toString('base64url');
function readCookie(req) {
  try { return JSON.parse(Buffer.from(req.cookies?.[COOKIE] || '', 'base64url').toString()); } catch { return {}; }
}
const setSession = (res, tokens) => res.cookie(COOKIE, packCookie(tokens.idToken || tokens.id_token, tokens.refreshToken || tokens.refresh_token), cookieOpts);
const clearSession = res => res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });

const iso = t => (t && t.toDate ? t.toDate().toISOString() : t || null);
const publicUser = (d, id) => d && ({
  id: id || d.id, full_name: d.full_name, email: d.email, phone: d.phone || null, state: d.state, district: d.district,
  village: d.village || null, role: d.role, status: d.status, email_verified: !!d.email_verified,
  created_at: iso(d.created_at), updated_at: iso(d.updated_at), last_login: iso(d.last_login),
});

const villageId = (name, district, state) =>
  crypto.createHash('sha1').update([state, district, name].map(s => s.trim().toLowerCase()).join('|')).digest('hex').slice(0, 20);
async function findOrCreateVillage(name, district, state) {
  const id = villageId(name, district, state), ref = db.collection('villages').doc(id);
  if (!(await ref.get()).exists) await ref.set({ name, district, state, created_at: Timestamp.now() });
  return id;
}

async function getUserDoc(uid) {
  const s = await db.collection('users').doc(uid).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}
async function getUserByEmail(email) {
  const q = await db.collection('users').where('email', '==', email).limit(1).get();
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
}

async function authenticate(req, res, next) {
  try {
    const { a } = readCookie(req);
    const h = req.get('authorization');
    const token = a || (h?.startsWith('Bearer ') ? h.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let decoded;
    try { decoded = await auth.verifyIdToken(token, true); } // true = also reject revoked sessions / disabled users
    catch (e) {
      const expired = e.code === 'auth/id-token-expired';
      const revoked = e.code === 'auth/id-token-revoked' || e.code === 'auth/user-disabled';
      return res.status(401).json({ error: expired ? 'Token expired' : revoked ? 'Session revoked' : 'Invalid token', code: expired ? 'token_expired' : revoked ? 'token_revoked' : 'invalid_token' });
    }
    // Role and status always come from Firestore, never from the token or the client.
    const u = await getUserDoc(decoded.uid);
    if (!u) return res.status(401).json({ error: 'Invalid token' });
    if (u.status !== 'active') return res.status(403).json({ error: `Account is ${u.status}`, code: 'account_' + u.status });
    req.user = u;
    next();
  } catch (e) { next(e); }
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden: insufficient role' });

// Exchange the refresh token for a new access token; fails if the session was revoked or the account is not active.
async function refreshSession(req, res) {
  const { r } = readCookie(req);
  if (!r) return null;
  try {
    const t = await idp.refresh(r);
    const decoded = await auth.verifyIdToken(t.id_token, true);
    const u = await getUserDoc(decoded.uid);
    if (!u || u.status !== 'active') return null;
    setSession(res, t);
    return u;
  } catch { return null; }
}

module.exports = { COOKIE, setSession, clearSession, readCookie, iso, publicUser, villageId, findOrCreateVillage, getUserDoc, getUserByEmail, authenticate, requireRole, refreshSession };
