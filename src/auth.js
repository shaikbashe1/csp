const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const BCRYPT_ROUNDS = 12;
// Pre-computed hash used to equalise timing when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', BCRYPT_ROUNDS);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = p => bcrypt.hash(p, BCRYPT_ROUNDS);
const verifyPassword = (p, h) => bcrypt.compare(p, h || DUMMY_HASH);

function signAccess(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: user.uuid, expiresIn: config.accessTtl, issuer: 'healthgap', algorithm: 'HS256',
  });
}
function verifyAccess(token) {
  return jwt.verify(token, config.jwtSecret, { issuer: 'healthgap', algorithms: ['HS256'] });
}

const cookieBase = { httpOnly: true, secure: config.isProd, sameSite: 'strict' };
function setAuthCookies(res, access, refresh) {
  res.cookie('access_token', access, { ...cookieBase, path: '/', maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', refresh, { ...cookieBase, path: '/api/auth', maxAge: config.refreshTtlDays * 86400 * 1000 });
}
function clearAuthCookies(res) {
  res.clearCookie('access_token', { ...cookieBase, path: '/' });
  res.clearCookie('refresh_token', { ...cookieBase, path: '/api/auth' });
}

async function issueRefresh(client, userId, req, familyId) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const r = await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1,$2,COALESCE($3, gen_random_uuid()), now() + ($4 || ' days')::interval,$5,$6) RETURNING id, family_id`,
    [userId, sha256(raw), familyId || null, String(config.refreshTtlDays), (req.get('user-agent') || '').slice(0, 300), req.ip]);
  return { raw, id: r.rows[0].id, familyId: r.rows[0].family_id };
}

async function startSession(req, res, user) {
  const refresh = await issueRefresh(db, user.id, req);
  setAuthCookies(res, signAccess(user), refresh.raw);
}

// Rotation with reuse detection: a revoked token being presented again kills its whole family.
async function rotateRefresh(req, res) {
  const raw = req.cookies?.refresh_token;
  if (!raw) return null;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [sha256(raw)]);
    const row = found.rows[0];
    if (!row) { await client.query('ROLLBACK'); return null; }
    if (row.revoked_at) {
      await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL', [row.family_id]);
      await client.query('COMMIT'); return null;
    }
    if (new Date(row.expires_at) < new Date()) { await client.query('ROLLBACK'); return null; }
    const u = (await client.query('SELECT * FROM users WHERE id=$1', [row.user_id])).rows[0];
    if (!u || u.status !== 'active') {
      await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
      await client.query('COMMIT'); return null;
    }
    const next = await issueRefresh(client, u.id, req, row.family_id);
    await client.query('UPDATE refresh_tokens SET revoked_at=now(), replaced_by=$2 WHERE id=$1', [row.id, next.id]);
    await client.query('COMMIT');
    setAuthCookies(res, signAccess(u), next.raw);
    return u;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

const revokeAllForUser = (userId, client = db) =>
  client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);

// Never expose password_hash or internal ids.
const USER_COLUMNS = `u.uuid, u.full_name, u.email, u.phone, u.state, u.district, u.role, u.status,
  u.email_verified, u.created_at, u.updated_at, u.last_login, v.name AS village, u.village_id`;
const publicUser = r => r && ({
  id: r.uuid, full_name: r.full_name, email: r.email, phone: r.phone, state: r.state, district: r.district,
  village: r.village, role: r.role, status: r.status, email_verified: r.email_verified,
  created_at: r.created_at, updated_at: r.updated_at, last_login: r.last_login,
});

async function findOrCreateVillage(client, name, district, state) {
  const r = await client.query(
    `INSERT INTO villages (name, district, state) VALUES ($1,$2,$3)
     ON CONFLICT (lower(name), lower(district), lower(state)) DO UPDATE SET name = villages.name RETURNING id`,
    [name, district, state]);
  return r.rows[0].id;
}

// ---- middleware ----
async function authenticate(req, res, next) {
  try {
    const h = req.get('authorization');
    const token = req.cookies?.access_token || (h?.startsWith('Bearer ') ? h.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let claims;
    try { claims = verifyAccess(token); }
    catch (e) { return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token', code: e.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token' }); }
    // Role and status always come from the database, never from the token or the client.
    const r = await db.query(`SELECT u.id, ${USER_COLUMNS} FROM users u LEFT JOIN villages v ON v.id=u.village_id WHERE u.uuid=$1`, [claims.sub]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'Invalid token' });
    if (u.status !== 'active') return res.status(403).json({ error: `Account is ${u.status}`, code: 'account_' + u.status });
    req.user = { ...u, publicId: u.uuid };
    next();
  } catch (e) { next(e); }
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden: insufficient role' });

module.exports = { hashPassword, verifyPassword, sha256, signAccess, setAuthCookies, clearAuthCookies, startSession,
  rotateRefresh, revokeAllForUser, publicUser, USER_COLUMNS, findOrCreateVillage, authenticate, requireRole };
