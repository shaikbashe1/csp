// Controlled backend mechanism for creating the first admin (Admin SDK). Credentials come from env, never from code.
require('./load-local-env');
// Emulator:  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-healthgap node scripts/seed-admin.js
// Production: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> GCLOUD_PROJECT=<id> node scripts/seed-admin.js
const path = require('path');
const fnDir = path.join(__dirname, '..', 'functions');
const req = m => require(require.resolve(m, { paths: [fnDir] }));
require.main.paths.unshift(path.join(fnDir, 'node_modules'));
const { db, auth, Timestamp } = require(path.join(fnDir, 'src', 'firebase.js'));
const { passwordPolicy } = require(path.join(fnDir, 'src', 'validators.js'));
void req;
(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
  if (!passwordPolicy.safeParse(password).success) throw new Error('ADMIN_PASSWORD does not meet the password policy');
  let uid; let created = false;
  try { uid = (await auth.getUserByEmail(email)).uid; }
  catch { uid = (await auth.createUser({ email, password, displayName: 'System Administrator', emailVerified: true })).uid; created = true; }
  const ref = db.collection('users').doc(uid);
  if (!(await ref.get()).exists) {
    const now = Timestamp.now();
    await ref.set({ full_name: process.env.ADMIN_NAME || 'System Administrator', email, phone: null, state: '-', district: '-', village: null, village_id: null,
      role: 'admin', status: 'active', email_verified: true, failed_logins: 0, locked_until: null, assigned_village_ids: [], created_at: now, updated_at: now, last_login: null });
  }
  console.log(created ? `admin created: ${email}` : `admin already exists: ${email} (unchanged)`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
