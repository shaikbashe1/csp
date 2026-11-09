// Aggregate-only analytics. No names, emails, UUIDs or phone numbers ever leave this module.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { authenticate, requireRole } = require('../auth');

const router = express.Router();
router.use(authenticate, requireRole('researcher', 'admin'));

async function villageRows() {
  const r = await db.query(
    `SELECT v.name AS village, v.district, v.state,
       (SELECT count(*)::int FROM healthcare_assessments h WHERE h.village_id=v.id) AS healthcare_n,
       (SELECT round(avg(gap_score),1)::float FROM healthcare_assessments h WHERE h.village_id=v.id) AS avg_gap_score,
       (SELECT count(*)::int FROM antibiotic_assessments a WHERE a.village_id=v.id) AS antibiotic_n,
       (SELECT round(avg(risk_score),1)::float FROM antibiotic_assessments a WHERE a.village_id=v.id) AS avg_antibiotic_risk,
       (SELECT count(*)::int FROM antibiotic_assessments a WHERE a.village_id=v.id AND risk_level='High') AS high_risk_n
     FROM villages v ORDER BY v.state, v.district, v.name`);
  const min = config.researchMinGroup;
  // Small-cell suppression: averages for groups smaller than the threshold are withheld (re-identification risk).
  return r.rows.map(x => ({
    ...x,
    avg_gap_score: x.healthcare_n >= min ? x.avg_gap_score : null,
    avg_antibiotic_risk: x.antibiotic_n >= min ? x.avg_antibiotic_risk : null,
    high_risk_n: x.antibiotic_n >= min ? x.high_risk_n : null,
    suppressed: x.healthcare_n < min || x.antibiotic_n < min,
  }));
}

router.get('/summary', async (req, res, next) => {
  try {
    const [h, a, byRisk] = await Promise.all([
      db.query('SELECT count(*)::int n, round(avg(gap_score),1)::float avg FROM healthcare_assessments'),
      db.query('SELECT count(*)::int n, round(avg(risk_score),1)::float avg FROM antibiotic_assessments'),
      db.query(`SELECT risk_level AS level, count(*)::int n FROM antibiotic_assessments GROUP BY 1`),
    ]);
    res.json({
      min_group_size: config.researchMinGroup,
      totals: { healthcare_assessments: h.rows[0].n, avg_gap_score: h.rows[0].avg, antibiotic_assessments: a.rows[0].n, avg_antibiotic_risk: a.rows[0].avg },
      risk_distribution: byRisk.rows,
      villages: await villageRows(),
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
    const rows = await villageRows();
    const cols = ['state', 'district', 'village', 'healthcare_n', 'avg_gap_score', 'antibiotic_n', 'avg_antibiotic_risk', 'high_risk_n'];
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="village-statistics.csv"' });
    res.send(csv);
  } catch (e) { next(e); }
});

module.exports = router;
