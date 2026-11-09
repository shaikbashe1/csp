const express = require('express');
const db = require('../db');
const A = require('../auth');
const V = require('../validators');

const router = express.Router();
router.use(A.authenticate, A.requireRole('admin'));

const bad = (res, error, fields) => res.status(400).json({ error, ...(fields && { fields }) });

router.get('/stats', async (req, res, next) => {
  try {
    const q = sql => db.query(sql).then(r => r.rows[0].n);
    const [total, active, citizens, workers, researchers, admins, villages, hc, ab, days, riskDist] = await Promise.all([
      q('SELECT count(*)::int n FROM users'),
      q(`SELECT count(*)::int n FROM users WHERE status='active'`),
      q(`SELECT count(*)::int n FROM users WHERE role='citizen'`),
      q(`SELECT count(*)::int n FROM users WHERE role='field_worker'`),
      q(`SELECT count(*)::int n FROM users WHERE role='researcher'`),
      q(`SELECT count(*)::int n FROM users WHERE role='admin'`),
      q(`SELECT count(DISTINCT village_id)::int n FROM (SELECT village_id FROM healthcare_assessments UNION ALL SELECT village_id FROM antibiotic_assessments UNION ALL SELECT village_id FROM community_surveys) x WHERE village_id IS NOT NULL`),
      q('SELECT count(*)::int n FROM healthcare_assessments'),
      q('SELECT count(*)::int n FROM antibiotic_assessments'),
      db.query(`SELECT to_char(d::date,'YYYY-MM-DD') AS day,
          (SELECT count(*)::int FROM healthcare_assessments h WHERE h.created_at::date=d::date) AS healthcare,
          (SELECT count(*)::int FROM antibiotic_assessments a WHERE a.created_at::date=d::date) AS antibiotic
        FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY d`),
      db.query(`SELECT risk_level AS level, count(*)::int n FROM antibiotic_assessments GROUP BY 1`),
    ]);
    res.json({
      totals: { total_users: total, active_users: active, citizens, field_workers: workers, researchers, admins,
        villages_surveyed: villages, healthcare_assessments: hc, antibiotic_assessments: ab },
      assessments_by_day: days.rows, risk_distribution: riskDist.rows,
    });
  } catch (e) { next(e); }
});

// ---- users ----
const userSelect = `SELECT ${A.USER_COLUMNS}, u.locked_until FROM users u LEFT JOIN villages v ON v.id=u.village_id`;
router.get('/users', async (req, res, next) => {
  try {
    const where = [], p = [];
    if (req.query.q) { p.push('%' + String(req.query.q).replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(u.full_name ILIKE $${p.length} OR u.email ILIKE $${p.length})`); }
    if (req.query.role) { if (!V.ROLES.includes(req.query.role)) return bad(res, 'Unknown role filter'); p.push(req.query.role); where.push(`u.role=$${p.length}`); }
    if (req.query.status) { if (!V.STATUSES.includes(req.query.status)) return bad(res, 'Unknown status filter'); p.push(req.query.status); where.push(`u.status=$${p.length}`); }
    const page = Math.max(1, parseInt(req.query.page) || 1), size = 25;
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows, count] = await Promise.all([
      db.query(`${userSelect} ${w} ORDER BY u.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, p),
      db.query(`SELECT count(*)::int n FROM users u ${w}`, p),
    ]);
    res.json({ users: rows.rows.map(r => ({ ...A.publicUser(r), locked: !!(r.locked_until && new Date(r.locked_until) > new Date()) })), total: count.rows[0].n, page, page_size: size });
  } catch (e) { next(e); }
});

const uuidOk = s => /^[0-9a-f-]{36}$/i.test(s);
router.get('/users/:id', async (req, res, next) => {
  try {
    if (!uuidOk(req.params.id)) return res.status(404).json({ error: 'User not found' });
    const r = await db.query(`${userSelect} WHERE u.uuid=$1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
    const villages = await db.query(`SELECT v.id, v.name FROM worker_villages w JOIN villages v ON v.id=w.village_id WHERE w.user_id=(SELECT id FROM users WHERE uuid=$1)`, [req.params.id]);
    res.json({ user: A.publicUser(r.rows[0]), assigned_villages: villages.rows });
  } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.adminCreateUserSchema, req.body);
    if (errors) return bad(res, 'Please fix the highlighted fields', errors);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const vid = await A.findOrCreateVillage(client, data.village, data.district, data.state);
      const r = await client.query(
        `INSERT INTO users (full_name,email,password_hash,phone,state,district,village_id,role,status,email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',true) RETURNING uuid`,
        [data.full_name, data.email, await A.hashPassword(data.password), data.phone || null, data.state, data.district, vid, data.role]);
      await client.query('COMMIT');
      res.status(201).json({ id: r.rows[0].uuid });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
      throw e;
    } finally { client.release(); }
  } catch (e) { next(e); }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    if (!uuidOk(req.params.id)) return res.status(404).json({ error: 'User not found' });
    const { data, errors } = V.validate(V.adminPatchUserSchema, req.body);
    if (errors || (!data.role && !data.status)) return bad(res, 'Provide a valid role and/or status');
    const t = (await db.query('SELECT id, role, status FROM users WHERE uuid=$1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'User not found' });
    const self = t.id === req.user.id;
    if (self && ((data.role && data.role !== 'admin') || (data.status && data.status !== 'active')))
      return bad(res, 'You cannot demote, deactivate or suspend your own account');
    const losesAdmin = t.role === 'admin' && ((data.role && data.role !== 'admin') || (data.status && data.status !== 'active'));
    if (losesAdmin) {
      const others = await db.query(`SELECT count(*)::int n FROM users WHERE role='admin' AND status='active' AND id<>$1`, [t.id]);
      if (others.rows[0].n === 0) return bad(res, 'At least one active admin must remain');
    }
    await db.query(`UPDATE users SET role=COALESCE($2,role), status=COALESCE($3,status),
      failed_logins = CASE WHEN $3 = 'active' THEN 0 ELSE failed_logins END,
      locked_until = CASE WHEN $3 = 'active' THEN NULL ELSE locked_until END, updated_at=now() WHERE id=$1`,
      [t.id, data.role || null, data.status || null]);
    // Role/status changes take effect immediately: drop refresh sessions (access checks hit the DB each request).
    if ((data.role && data.role !== t.role) || (data.status && data.status !== 'active')) await A.revokeAllForUser(t.id);
    const r = await db.query(`${userSelect} WHERE u.id=$1`, [t.id]);
    res.json({ user: A.publicUser(r.rows[0]) });
  } catch (e) { next(e); }
});

router.get('/roles', async (req, res, next) => {
  try { res.json({ roles: (await db.query('SELECT name, description FROM roles ORDER BY name')).rows }); } catch (e) { next(e); }
});

router.put('/users/:id/villages', async (req, res, next) => {
  try {
    const ids = req.body?.village_ids;
    if (!uuidOk(req.params.id) || !Array.isArray(ids) || !ids.every(Number.isInteger)) return bad(res, 'village_ids must be an array of integers');
    const t = (await db.query('SELECT id, role FROM users WHERE uuid=$1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'User not found' });
    if (t.role !== 'field_worker') return bad(res, 'Only field workers can be assigned villages');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM worker_villages WHERE user_id=$1', [t.id]);
      if (ids.length) await client.query('INSERT INTO worker_villages (user_id, village_id) SELECT $1, id FROM villages WHERE id = ANY($2::int[])', [t.id, ids]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- villages ----
router.get('/villages', async (req, res, next) => {
  try {
    const r = await db.query(`SELECT v.id, v.name, v.district, v.state,
      (SELECT count(*)::int FROM users u WHERE u.village_id=v.id) AS residents,
      (SELECT count(*)::int FROM healthcare_assessments h WHERE h.village_id=v.id) AS healthcare_assessments
      FROM villages v ORDER BY v.state, v.district, v.name`);
    res.json({ villages: r.rows });
  } catch (e) { next(e); }
});
const villageSchema = V.z.object({ name: V.z.string().trim().min(1).max(100), district: V.z.string().trim().min(1).max(100), state: V.z.string().trim().min(1).max(100) });
router.post('/villages', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(villageSchema, req.body);
    if (errors) return bad(res, 'Invalid village', errors);
    const id = await A.findOrCreateVillage(db, data.name, data.district, data.state);
    res.status(201).json({ id });
  } catch (e) { next(e); }
});
router.delete('/villages/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 'Invalid id');
    await db.query('DELETE FROM villages WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- facilities ----
const facilitySchema = V.z.object({
  name: V.z.string().trim().min(1).max(150),
  type: V.z.enum(['phc', 'chc', 'hospital', 'sub_centre', 'pharmacy', 'clinic']),
  district: V.z.string().trim().min(1).max(100), state: V.z.string().trim().min(1).max(100),
  village_id: V.z.number().int().positive().optional(),
  latitude: V.z.number().min(-90).max(90).optional(), longitude: V.z.number().min(-180).max(180).optional(),
  phone: V.z.string().trim().max(20).optional(),
});
router.post('/facilities', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(facilitySchema, req.body);
    if (errors) return bad(res, 'Invalid facility', errors);
    const r = await db.query(`INSERT INTO facilities (name,type,district,state,village_id,latitude,longitude,phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING uuid`,
      [data.name, data.type, data.district, data.state, data.village_id || null, data.latitude ?? null, data.longitude ?? null, data.phone || null]);
    res.status(201).json({ id: r.rows[0].uuid });
  } catch (e) { next(e); }
});
router.delete('/facilities/:id', async (req, res, next) => {
  try {
    if (!uuidOk(req.params.id)) return bad(res, 'Invalid id');
    await db.query('DELETE FROM facilities WHERE uuid=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- surveys ----
router.get('/surveys', async (req, res, next) => {
  try {
    const r = await db.query(`SELECT s.uuid AS id, v.name AS village, u.full_name AS worker, s.households, s.notes, s.created_at
      FROM community_surveys s JOIN villages v ON v.id=s.village_id JOIN users u ON u.id=s.worker_id ORDER BY s.created_at DESC LIMIT 200`);
    res.json({ surveys: r.rows });
  } catch (e) { next(e); }
});
router.delete('/surveys/:id', async (req, res, next) => {
  try {
    if (!uuidOk(req.params.id)) return bad(res, 'Invalid id');
    await db.query('DELETE FROM community_surveys WHERE uuid=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- system settings ----
router.get('/settings', async (req, res, next) => {
  try { res.json({ settings: Object.fromEntries((await db.query('SELECT key, value FROM system_settings')).rows.map(r => [r.key, r.value])) }); } catch (e) { next(e); }
});
router.put('/settings', async (req, res, next) => {
  try {
    const v = req.body?.public_registration_enabled;
    if (typeof v !== 'boolean') return bad(res, 'public_registration_enabled must be true or false');
    await db.query(`INSERT INTO system_settings (key,value) VALUES ('public_registration_enabled',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(v)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
