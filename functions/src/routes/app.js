// Citizen / field-worker / shared authenticated routes (Firestore).
const express = require('express');
const { db, Timestamp } = require('../firebase');
const { authenticate, requireRole, iso } = require('../auth');
const M = require('../assessmentModel');
const { z, validate } = require('../validators');

const router = express.Router();
router.use(authenticate);
const bad = (res, msg) => res.status(400).json({ error: msg });
const byDateDesc = (a, b) => b.created_at.toMillis() - a.created_at.toMillis();

// Always scoped by the authenticated uid. Sorted in memory (a user has few documents; avoids composite indexes).
async function mine(col, uid) {
  const s = await db.collection(col).where('user_id', '==', uid).get();
  return s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byDateDesc);
}

router.get('/assessments/questions', requireRole('citizen', 'field_worker'), (req, res) => res.json({ healthcare: M.healthcare, antibiotic: M.antibiotic }));

function resolveVillage(req) {
  const requested = req.body?.village_id;
  if (requested == null || req.user.role !== 'field_worker') return { id: req.user.village_id || null };
  return (req.user.assigned_village_ids || []).includes(requested) ? { id: requested } : { error: 'That village is not assigned to you' };
}

router.post('/assessments/healthcare', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const s = M.score(M.healthcare, req.body?.answers);
    if (s.error) return bad(res, s.error);
    const v = resolveVillage(req);
    if (v.error) return res.status(403).json({ error: v.error });
    const doc = { user_id: req.user.id, village_id: v.id, answers: s.answers, gap_score: s.pct, created_at: Timestamp.now() };
    const ref = await db.collection('healthcare_assessments').add(doc);
    res.status(201).json({ assessment: { id: ref.id, user_id: req.user.id, gap_score: doc.gap_score, created_at: iso(doc.created_at) } });
  } catch (e) { next(e); }
});

router.post('/assessments/antibiotic', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const s = M.score(M.antibiotic, req.body?.answers);
    if (s.error) return bad(res, s.error);
    const v = resolveVillage(req);
    if (v.error) return res.status(403).json({ error: v.error });
    const doc = { user_id: req.user.id, village_id: v.id, answers: s.answers, risk_score: s.pct, risk_level: M.riskLevel(s.pct), created_at: Timestamp.now() };
    const ref = await db.collection('antibiotic_assessments').add(doc);
    res.status(201).json({ assessment: { id: ref.id, user_id: req.user.id, risk_score: doc.risk_score, risk_level: doc.risk_level, created_at: iso(doc.created_at) } });
  } catch (e) { next(e); }
});

router.get('/assessments/mine', requireRole('citizen', 'field_worker'), async (req, res, next) => {
  try {
    const [h, a] = await Promise.all([mine('healthcare_assessments', req.user.id), mine('antibiotic_assessments', req.user.id)]);
    res.json({
      healthcare: h.slice(0, 100).map(x => ({ id: x.id, gap_score: x.gap_score, created_at: iso(x.created_at) })),
      antibiotic: a.slice(0, 100).map(x => ({ id: x.id, risk_score: x.risk_score, risk_level: x.risk_level, created_at: iso(x.created_at) })),
    });
  } catch (e) { next(e); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const u = req.user;
    const [h, a] = await Promise.all([mine('healthcare_assessments', u.id), mine('antibiotic_assessments', u.id)]);
    const out = {
      user: { name: u.full_name, role: u.role, village: u.village, district: u.district, state: u.state },
      healthcare: { status: h.length ? 'Completed' : 'Pending', gap_score: h[0]?.gap_score ?? null, last_taken: iso(h[0]?.created_at), total: h.length },
      antibiotic: { status: a.length ? 'Completed' : 'Pending', risk_level: a[0]?.risk_level ?? null, risk_score: a[0]?.risk_score ?? null, last_taken: iso(a[0]?.created_at), total: a.length },
    };
    if (u.role === 'field_worker') {
      const ids = u.assigned_village_ids || [];
      const docs = await Promise.all(ids.map(id => db.collection('villages').doc(id).get()));
      out.assigned_villages = docs.filter(d => d.exists).map(d => ({ id: d.id, name: d.data().name, district: d.data().district }));
    }
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/facilities', async (req, res, next) => {
  try {
    let q = db.collection('facilities');
    if (req.query.district) q = q.where('district', '==', String(req.query.district));
    const s = await q.limit(500).get();
    res.json({ facilities: s.docs.map(d => ({ id: d.id, ...d.data(), created_at: undefined })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (e) { next(e); }
});

const fw = requireRole('field_worker');
router.get('/field/villages', fw, async (req, res, next) => {
  try {
    const ids = req.user.assigned_village_ids || [];
    const out = await Promise.all(ids.map(async id => {
      const [v, h, a, s] = await Promise.all([
        db.collection('villages').doc(id).get(),
        db.collection('healthcare_assessments').where('village_id', '==', id).select('gap_score').get(),
        db.collection('antibiotic_assessments').where('village_id', '==', id).count().get(),
        db.collection('community_surveys').where('village_id', '==', id).count().get(),
      ]);
      if (!v.exists) return null;
      const scores = h.docs.map(d => d.data().gap_score);
      return { id, name: v.data().name, district: v.data().district, state: v.data().state, healthcare_assessments: scores.length,
        antibiotic_assessments: a.data().count, avg_gap_score: scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : null, surveys: s.data().count };
    }));
    res.json({ villages: out.filter(Boolean).sort((x, y) => x.name.localeCompare(y.name)) });
  } catch (e) { next(e); }
});

const surveySchema = z.object({ village_id: z.string().min(1).max(64), households: z.number().int().min(0).max(100000), notes: z.string().trim().max(2000).optional() });
router.post('/field/surveys', fw, async (req, res, next) => {
  try {
    const { data, errors } = validate(surveySchema, req.body);
    if (errors) return res.status(400).json({ error: 'Invalid survey', fields: errors });
    if (!(req.user.assigned_village_ids || []).includes(data.village_id)) return res.status(403).json({ error: 'That village is not assigned to you' });
    const doc = { village_id: data.village_id, worker_id: req.user.id, households: data.households, notes: data.notes || null, created_at: Timestamp.now() };
    const ref = await db.collection('community_surveys').add(doc);
    res.status(201).json({ survey: { id: ref.id, created_at: iso(doc.created_at) } });
  } catch (e) { next(e); }
});
router.get('/field/surveys', fw, async (req, res, next) => {
  try {
    const s = await db.collection('community_surveys').where('worker_id', '==', req.user.id).get();
    const rows = s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byDateDesc).slice(0, 100);
    const names = {};
    await Promise.all([...new Set(rows.map(r => r.village_id))].map(async id => { const v = await db.collection('villages').doc(id).get(); names[id] = v.data()?.name || '—'; }));
    res.json({ surveys: rows.map(r => ({ id: r.id, village: names[r.village_id], households: r.households, notes: r.notes, created_at: iso(r.created_at) })) });
  } catch (e) { next(e); }
});

module.exports = router;
