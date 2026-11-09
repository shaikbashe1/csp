const express = require('express');
const { db, auth, Timestamp } = require('../firebase');
const A = require('../auth');
const V = require('../validators');

const router = express.Router();
router.use(A.authenticate, A.requireRole('admin'));
const bad = (res, error, fields) => res.status(400).json({ error, ...(fields && { fields }) });
const count = q => q.count().get().then(s => s.data().count);

router.get('/stats', async (req, res, next) => {
  try {
    const users = db.collection('users'), hc = db.collection('healthcare_assessments'), ab = db.collection('antibiotic_assessments');
    const since = Timestamp.fromMillis(Date.now() - 14 * 86400000);
    const [total, active, citizens, workers, researchers, admins, nHc, nAb, vH, vA, vS, hDays, aDays, low, mod, high] = await Promise.all([
      count(users), count(users.where('status', '==', 'active')),
      count(users.where('role', '==', 'citizen')), count(users.where('role', '==', 'field_worker')),
      count(users.where('role', '==', 'researcher')), count(users.where('role', '==', 'admin')),
      count(hc), count(ab),
      hc.select('village_id').get(), ab.select('village_id').get(), db.collection('community_surveys').select('village_id').get(),
      hc.where('created_at', '>=', since).select('created_at').get(), ab.where('created_at', '>=', since).select('created_at').get(),
      count(ab.where('risk_level', '==', 'Low')), count(ab.where('risk_level', '==', 'Moderate')), count(ab.where('risk_level', '==', 'High')),
    ]);
    const surveyed = new Set([...vH.docs, ...vA.docs, ...vS.docs].map(d => d.data().village_id).filter(Boolean));
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const bucket = snap => { const m = {}; snap.docs.forEach(d => { const k = d.data().created_at.toDate().toISOString().slice(0, 10); m[k] = (m[k] || 0) + 1; }); return m; };
    const hb = bucket(hDays), ab2 = bucket(aDays);
    res.json({
      totals: { total_users: total, active_users: active, citizens, field_workers: workers, researchers, admins, villages_surveyed: surveyed.size, healthcare_assessments: nHc, antibiotic_assessments: nAb },
      assessments_by_day: days.map(day => ({ day, healthcare: hb[day] || 0, antibiotic: ab2[day] || 0 })),
      risk_distribution: [{ level: 'Low', n: low }, { level: 'Moderate', n: mod }, { level: 'High', n: high }],
    });
  } catch (e) { next(e); }
});

// ---- users ---- (filtered in memory; adequate for community-scale deployments)
router.get('/users', async (req, res, next) => {
  try {
    if (req.query.role && !V.ROLES.includes(req.query.role)) return bad(res, 'Unknown role filter');
    if (req.query.status && !V.STATUSES.includes(req.query.status)) return bad(res, 'Unknown status filter');
    const snap = await db.collection('users').get();
    const q = String(req.query.q || '').toLowerCase();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (q) rows = rows.filter(u => u.full_name.toLowerCase().includes(q) || u.email.includes(q));
    if (req.query.role) rows = rows.filter(u => u.role === req.query.role);
    if (req.query.status) rows = rows.filter(u => u.status === req.query.status);
    rows.sort((a, b) => b.created_at.toMillis() - a.created_at.toMillis());
    const page = Math.max(1, parseInt(req.query.page) || 1), size = 25;
    res.json({ users: rows.slice((page - 1) * size, page * size).map(u => ({ ...A.publicUser(u), locked: !!(u.locked_until && u.locked_until.toDate() > new Date()) })), total: rows.length, page, page_size: size });
  } catch (e) { next(e); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const u = await A.getUserDoc(req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const vs = await Promise.all((u.assigned_village_ids || []).map(id => db.collection('villages').doc(id).get()));
    res.json({ user: A.publicUser(u), assigned_villages: vs.filter(v => v.exists).map(v => ({ id: v.id, name: v.data().name })) });
  } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.adminCreateUserSchema, req.body);
    if (errors) return bad(res, 'Please fix the highlighted fields', errors);
    let fb;
    try { fb = await auth.createUser({ email: data.email, password: data.password, displayName: data.full_name, emailVerified: true }); }
    catch (e) { if (e.code === 'auth/email-already-exists') return res.status(409).json({ error: 'An account with this email already exists' }); throw e; }
    try {
      const vid = await A.findOrCreateVillage(data.village, data.district, data.state), now = Timestamp.now();
      await db.collection('users').doc(fb.uid).set({
        full_name: data.full_name, email: data.email, phone: data.phone || null, state: data.state, district: data.district, village: data.village,
        village_id: vid, role: data.role, status: 'active', email_verified: true, failed_logins: 0, locked_until: null, assigned_village_ids: [], created_at: now, updated_at: now, last_login: null,
      });
    } catch (e) { await auth.deleteUser(fb.uid).catch(() => {}); throw e; }
    res.status(201).json({ id: fb.uid });
  } catch (e) { next(e); }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(V.adminPatchUserSchema, req.body);
    if (errors || (!data.role && !data.status)) return bad(res, 'Provide a valid role and/or status');
    const t = await A.getUserDoc(req.params.id);
    if (!t) return res.status(404).json({ error: 'User not found' });
    const self = t.id === req.user.id;
    if (self && ((data.role && data.role !== 'admin') || (data.status && data.status !== 'active'))) return bad(res, 'You cannot demote, deactivate or suspend your own account');
    const losesAdmin = t.role === 'admin' && ((data.role && data.role !== 'admin') || (data.status && data.status !== 'active'));
    if (losesAdmin) {
      const admins = await db.collection('users').where('role', '==', 'admin').get();
      if (!admins.docs.some(d => d.id !== t.id && d.data().status === 'active')) return bad(res, 'At least one active admin must remain');
    }
    const patch = { updated_at: Timestamp.now() };
    if (data.role) patch.role = data.role;
    if (data.status) { patch.status = data.status; if (data.status === 'active') { patch.failed_logins = 0; patch.locked_until = null; } }
    await db.collection('users').doc(t.id).update(patch);
    if (data.status) await auth.updateUser(t.id, { disabled: data.status !== 'active' });
    // Role/status changes sign the user out everywhere; authorisation is re-read from Firestore on every request anyway.
    if ((data.role && data.role !== t.role) || (data.status && data.status !== 'active')) await auth.revokeRefreshTokens(t.id);
    res.json({ user: A.publicUser(await A.getUserDoc(t.id)) });
  } catch (e) { next(e); }
});

router.get('/roles', (req, res) => res.json({ roles: [
  { name: 'admin', description: 'Administrator: full system management' },
  { name: 'citizen', description: 'Community member: own assessments and profile' },
  { name: 'field_worker', description: 'Field worker: assigned villages, surveys, assessments' },
  { name: 'researcher', description: 'Researcher: aggregate analytics and exports' },
] }));

router.put('/users/:id/villages', async (req, res, next) => {
  try {
    const ids = req.body?.village_ids;
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string' && i.length < 64)) return bad(res, 'village_ids must be an array of strings');
    const t = await A.getUserDoc(req.params.id);
    if (!t) return res.status(404).json({ error: 'User not found' });
    if (t.role !== 'field_worker') return bad(res, 'Only field workers can be assigned villages');
    const exist = (await Promise.all(ids.map(id => db.collection('villages').doc(id).get()))).filter(d => d.exists).map(d => d.id);
    await db.collection('users').doc(t.id).update({ assigned_village_ids: exist, updated_at: Timestamp.now() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- villages ----
router.get('/villages', async (req, res, next) => {
  try {
    const [vs, us, hs] = await Promise.all([db.collection('villages').get(), db.collection('users').select('village_id').get(), db.collection('healthcare_assessments').select('village_id').get()]);
    const tally = snap => snap.docs.reduce((m, d) => { const k = d.data().village_id; m[k] = (m[k] || 0) + 1; return m; }, {});
    const r = tally(us), h = tally(hs);
    res.json({ villages: vs.docs.map(d => ({ id: d.id, ...d.data(), created_at: undefined, residents: r[d.id] || 0, healthcare_assessments: h[d.id] || 0 })).sort((a, b) => (a.state + a.district + a.name).localeCompare(b.state + b.district + b.name)) });
  } catch (e) { next(e); }
});
const villageSchema = V.z.object({ name: V.z.string().trim().min(1).max(100), district: V.z.string().trim().min(1).max(100), state: V.z.string().trim().min(1).max(100) });
router.post('/villages', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(villageSchema, req.body);
    if (errors) return bad(res, 'Invalid village', errors);
    res.status(201).json({ id: await A.findOrCreateVillage(data.name, data.district, data.state) });
  } catch (e) { next(e); }
});
router.delete('/villages/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[0-9a-f]{20}$/.test(id)) return bad(res, 'Invalid id');
    const surveys = await db.collection('community_surveys').where('village_id', '==', id).get();
    const batch = db.batch();
    surveys.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('villages').doc(id));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- facilities ----
const facilitySchema = V.z.object({
  name: V.z.string().trim().min(1).max(150), type: V.z.enum(['phc', 'chc', 'hospital', 'sub_centre', 'pharmacy', 'clinic']),
  district: V.z.string().trim().min(1).max(100), state: V.z.string().trim().min(1).max(100),
  village_id: V.z.string().max(64).optional(), latitude: V.z.number().min(-90).max(90).optional(), longitude: V.z.number().min(-180).max(180).optional(),
  phone: V.z.string().trim().max(20).optional(),
});
router.post('/facilities', async (req, res, next) => {
  try {
    const { data, errors } = V.validate(facilitySchema, req.body);
    if (errors) return bad(res, 'Invalid facility', errors);
    const ref = await db.collection('facilities').add({ ...data, created_at: Timestamp.now() });
    res.status(201).json({ id: ref.id });
  } catch (e) { next(e); }
});
router.delete('/facilities/:id', async (req, res, next) => {
  try { await db.collection('facilities').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- surveys ----
router.get('/surveys', async (req, res, next) => {
  try {
    const s = await db.collection('community_surveys').get();
    const rows = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.created_at.toMillis() - a.created_at.toMillis()).slice(0, 200);
    const vname = {}, wname = {};
    await Promise.all([
      ...[...new Set(rows.map(r => r.village_id))].map(async id => { vname[id] = (await db.collection('villages').doc(id).get()).data()?.name || '—'; }),
      ...[...new Set(rows.map(r => r.worker_id))].map(async id => { wname[id] = (await A.getUserDoc(id))?.full_name || '—'; }),
    ]);
    res.json({ surveys: rows.map(r => ({ id: r.id, village: vname[r.village_id], worker: wname[r.worker_id], households: r.households, notes: r.notes, created_at: A.iso(r.created_at) })) });
  } catch (e) { next(e); }
});
router.delete('/surveys/:id', async (req, res, next) => {
  try { await db.collection('community_surveys').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---- settings ----
router.get('/settings', async (req, res, next) => {
  try { const s = await db.collection('settings').doc('system').get(); res.json({ settings: { public_registration_enabled: s.exists ? s.data().public_registration_enabled !== false : true } }); } catch (e) { next(e); }
});
router.put('/settings', async (req, res, next) => {
  try {
    const v = req.body?.public_registration_enabled;
    if (typeof v !== 'boolean') return bad(res, 'public_registration_enabled must be true or false');
    await db.collection('settings').doc('system').set({ public_registration_enabled: v, updated_at: Timestamp.now() }, { merge: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
