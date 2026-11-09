// Generates a local .env with random secrets (development convenience). Never overwrites.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const target = path.join(__dirname, '..', '.env');
if (fs.existsSync(target)) { console.log('.env already exists; leaving it alone'); process.exit(0); }
const rnd = n => crypto.randomBytes(n).toString('base64url');
let t = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
t = t.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + rnd(48))
     .replace(/^ADMIN_EMAIL=.*$/m, 'ADMIN_EMAIL=admin@healthgap.local')
     .replace(/^ADMIN_PASSWORD=.*$/m, 'ADMIN_PASSWORD=Aa1!' + rnd(15));
fs.writeFileSync(target, t);
console.log('.env created with a random JWT secret and admin password (see ADMIN_PASSWORD in .env)');
