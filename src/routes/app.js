// Citizen / field-worker / shared authenticated routes.
const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../auth');
const M = require('../assessmentModel');
const { z, validate } = require('../validators');

const router = express.Router();
router.use(authenticate);

const bad = (res, msg) => res.status(400).json({ error: msg });

router.get('/assessments/questions', requireRole('citizen', 'field_worker'), (req, res) =>
  res.json({ healthcare: M.healthcare, antibiotic: M.antibiotic }));

// Field workers may file for an assigned village; citizens always use their own village.
async function resolveVillage(req) {
  const requested = req.body?.village_id;
  if (requested == null || req.user.role !== 'field_worker') return { id: req.user.village_id };
  const r = await db.query('SELECT 1 FROM worker_villages WHERE user_id=$1 AND village_id=$2', [req.user.id, requested]);
  return r.rowCount ? { id: requested } : { error: 'That village is not assigned to you' };
}

router.post('/assessments/healthcare', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const s = M.score(M.healthcare, req.body?.answers);
    if (s.error) return bad(res, s.error);
    const v = await resolveVillage(req);
    if (v.error) return res.status(403).json({ error: v.error });
    const r = await db.query(
      `INSERT INTO healthcare_assessments (user_id, village_id, answers, gap_score) VALUES ($1,$2,$3,$4)
       RETURNING uuid, gap_score, created_at`, [req.user.id, v.id, s.answers, s.pct]);
    res.status(201).json({ assessment: { id: r.rows[0].uuid, user_id: req.user.uuid, gap_score: r.rows[0].gap_score, created_at: r.rows[0].created_at } });
  } catch (e) { next(e); }
});

router.post('/assessments/antibiotic', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const s = M.score(M.antibiotic, req.body?.answers);
    if (s.error) return bad(res, s.error);
    const v = await resolveVillage(req);
    if (v.error) return res.status(403).json({ error: v.error });
    const level = M.riskLevel(s.pct);
    const r = await db.query(
      `INSERT INTO antibiotic_assessments (user_id, village_id, answers, risk_score, risk_level) VALUES ($1,$2,$3,$4,$5)
       RETURNING uuid, risk_score, risk_level, created_at`, [req.user.id, v.id, s.answers, s.pct, level]);
    const a = r.rows[0];
    res.status(201).json({ assessment: { id: a.uuid, user_id: req.user.uuid, risk_score: a.risk_score, risk_level: a.risk_level, created_at: a.created_at } });
  } catch (e) { next(e); }
});

// Own history only — scoped by the authenticated user's id, never by a client-supplied id.
router.get('/assessments/mine', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const [h, a] = await Promise.all([
      db.query('SELECT uuid AS id, gap_score, created_at FROM healthcare_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]),
      db.query('SELECT uuid AS id, risk_score, risk_level, created_at FROM antibiotic_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]),
    ]);
    res.json({ healthcare: h.rows, antibiotic: a.rows });
  } catch (e) { next(e); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const u = req.user;
    const [h, a, hc, ac] = await Promise.all([
      db.query('SELECT gap_score, created_at FROM healthcare_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [u.id]),
      db.query('SELECT risk_score, risk_level, created_at FROM antibiotic_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [u.id]),
      db.query('SELECT count(*)::int n FROM healthcare_assessments WHERE user_id=$1', [u.id]),
      db.query('SELECT count(*)::int n FROM antibiotic_assessments WHERE user_id=$1', [u.id]),
    ]);
    const out = {
      user: { name: u.full_name, role: u.role, village: u.village, district: u.district, state: u.state },
      healthcare: { status: h.rowCount ? 'Completed' : 'Pending', gap_score: h.rows[0]?.gap_score ?? null, last_taken: h.rows[0]?.created_at ?? null, total: hc.rows[0].n },
      antibiotic: { status: a.rowCount ? 'Completed' : 'Pending', risk_level: a.rows[0]?.risk_level ?? null, risk_score: a.rows[0]?.risk_score ?? null, last_taken: a.rows[0]?.created_at ?? null, total: ac.rows[0].n },
    };
    if (u.role === 'field_worker') {
      const v = await db.query(`SELECT v.id, v.name, v.district FROM worker_villages w JOIN villages v ON v.id=w.village_id WHERE w.user_id=$1 ORDER BY v.name`, [u.id]);
      out.assigned_villages = v.rows;
    }
    res.json(out);
  } catch (e) { next(e); }
});

// ---- facilities (any authenticated user) ----
router.get('/facilities', async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.district) { params.push(String(req.query.district)); where = 'WHERE lower(f.district)=lower($1)'; }
    const r = await db.query(
      `SELECT f.uuid AS id, f.name, f.type, f.district, f.state, f.latitude, f.longitude, f.phone, v.name AS village
       FROM facilities f LEFT JOIN villages v ON v.id=f.village_id ${where} ORDER BY f.name LIMIT 500`, params);
    res.json({ facilities: r.rows });
  } catch (e) { next(e); }
});

// ---- field worker ----
const fw = requireRole('field_worker');

router.get('/field/villages', fw, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT v.id, v.name, v.district, v.state,
         (SELECT count(*)::int FROM healthcare_assessments h WHERE h.village_id=v.id) AS healthcare_assessments,
         (SELECT count(*)::int FROM antibiotic_assessments a WHERE a.village_id=v.id) AS antibiotic_assessments,
         (SELECT round(avg(gap_score))::int FROM healthcare_assessments h WHERE h.village_id=v.id) AS avg_gap_score,
         (SELECT count(*)::int FROM community_surveys s WHERE s.village_id=v.id) AS surveys
       FROM worker_villages w JOIN villages v ON v.id=w.village_id WHERE w.user_id=$1 ORDER BY v.name`, [req.user.id]);
    res.json({ villages: r.rows });
  } catch (e) { next(e); }
});

const surveySchema = z.object({
  village_id: z.number().int().positive(),
  households: z.number().int().min(0).max(100000),
  notes: z.string().trim().max(2000).optional(),
});
router.post('/field/surveys', fw, async (req, res, next) => {
  try {
    const { data, errors } = validate(surveySchema, req.body);
    if (errors) return res.status(400).json({ error: 'Invalid survey', fields: errors });
    const ok = await db.query('SELECT 1 FROM worker_villages WHERE user_id=$1 AND village_id=$2', [req.user.id, data.village_id]);
    if (!ok.rowCount) return res.status(403).json({ error: 'That village is not assigned to you' });
    const r = await db.query('INSERT INTO community_surveys (village_id, worker_id, households, notes) VALUES ($1,$2,$3,$4) RETURNING uuid, created_at',
      [data.village_id, req.user.id, data.households, data.notes || null]);
    res.status(201).json({ survey: { id: r.rows[0].uuid, created_at: r.rows[0].created_at } });
  } catch (e) { next(e); }
});
router.get('/field/surveys', fw, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT s.uuid AS id, v.name AS village, s.households, s.notes, s.created_at FROM community_surveys s
       JOIN villages v ON v.id=s.village_id WHERE s.worker_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ surveys: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
