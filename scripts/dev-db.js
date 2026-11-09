// Development-only PostgreSQL (embedded binaries) so no system install is needed.
const path = require('path'), fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;
(async () => {
  const dataDir = path.join(__dirname, '..', '.pgdata');
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 54329, persistent: true });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('healthgap');
  console.log('dev postgres ready on 54329');
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch(e => { console.error(e); process.exit(1); });
