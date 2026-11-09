const config = require('./config');
const app = require('./server');

// Migrations are applied explicitly via `npm run migrate`; start only verifies they are up to date.
(async () => {
  const { pool } = require('./db');
  const t = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (!t.rows[0].t) { console.error('Database is not migrated. Run: npm run migrate'); process.exit(1); }
  app.listen(config.port, () => console.log(`HealthGap listening on http://localhost:${config.port}`));
})().catch(e => { console.error(e.message); process.exit(1); });
