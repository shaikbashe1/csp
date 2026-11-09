// Loads KEY=VALUE pairs from .admin.local (git-ignored) for local emulator seeding/testing. Creates it with a random password.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const f = path.join(__dirname, '..', '.admin.local');
if (!fs.existsSync(f)) fs.writeFileSync(f, `ADMIN_EMAIL=admin@healthgap.local\nADMIN_PASSWORD=Aa1!${crypto.randomBytes(12).toString('base64url')}\n`);
for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
