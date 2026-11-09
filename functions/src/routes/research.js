// Aggregate-only analytics. No names, emails, ids or phone numbers leave this module.
const express = require('express');
const { db } = require('../firebase');
const config = require('../config');
const { authenticate, requireRole } = require('../auth');

const router = express.Router();
router.use(authenticate, requireRole('researcher', 'admin'));
const avg = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);

async function collect() {
  const [vs, hs, as] = await Promise.all([
    db.collection('villages').get(),
    db.collection('healthcare_assessments').select('village_id', 'gap_score').get(),
    db.collection('antibiotic_assessments').select('village_id', 'risk_score', 'risk_level').get(),
  ]);
  const h = hs.docs.map(d => d.data()), a = as.docs.map(d => d.data());
  const min = config.researchMinGroup;
  const villages = vs.docs.map(d => d.data()).map(v => ({ ...v, id: undefined }));
  const rows = vs.docs.map(d => {
    const v = d.data(), hh = h.filter(x => x.village_id === d.id), aa = a.filter(x => x.village_id === d.id);
    return {
      village: v.name, district: v.district, state: v.state, healthcare_n: hh.length, antibiotic_n: aa.length,
      // Small-cell suppression: statistics for groups below the threshold are withheld.
      avg_gap_score: hh.length >= min ? avg(hh.map(x => x.gap_score)) : null,
      avg_antibiotic_risk: aa.length >= min ? avg(aa.map(x => x.risk_score)) : null,
      high_risk_n: aa.length >= min ? aa.filter(x => x.risk_level === 'High').length : null,
      suppressed: hh.length < min || aa.length < min,
    };
  }).sort((x, y) => (x.state + x.district + x.village).localeCompare(y.state + y.district + y.village));
  void villages;
  return { rows, h, a };
}

router.get('/summary', async (req, res, next) => {
  try {
    const { rows, h, a } = await collect();
    const dist = ['Low', 'Moderate', 'High'].map(level => ({ level, n: a.filter(x => x.risk_level === level).length })).filter(x => x.n);
    res.json({
      min_group_size: config.researchMinGroup,
      totals: { healthcare_assessments: h.length, avg_gap_score: avg(h.map(x => x.gap_score)), antibiotic_assessments: a.length, avg_antibiotic_risk: avg(a.map(x => x.risk_score)) },
      risk_distribution: dist, villages: rows,
    });
  } catch (e) { next(e); }
});

const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/export.csv', async (req, res, next) => {
  try {
    const { rows } = await collect();
    const cols = ['state', 'district', 'village', 'healthcare_n', 'avg_gap_score', 'antibiotic_n', 'avg_antibiotic_risk', 'high_risk_n'];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="village-statistics.csv"' });
    res.send([cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n'));
  } catch (e) { next(e); }
});

module.exports = router;
