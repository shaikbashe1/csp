// Controlled backend mechanism for creating the first admin. Credentials come from env, never from code.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { passwordPolicy } = require('../src/validators');
(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env');
  if (!passwordPolicy.safeParse(password).success) throw new Error('ADMIN_PASSWORD does not meet the password policy');
  const hash = await bcrypt.hash(password, 12);
  const r = await pool.query(
    `INSERT INTO users (full_name,email,password_hash,state,district,role,status,email_verified)
     VALUES ($1,$2,$3,'-','-','admin','active',true)
     ON CONFLICT ((lower(email))) DO NOTHING RETURNING uuid`, [process.env.ADMIN_NAME || 'System Administrator', email, hash]);
  console.log(r.rowCount ? `admin created: ${email}` : `admin already exists: ${email} (unchanged)`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
