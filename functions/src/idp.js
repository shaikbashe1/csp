// Thin client for the Firebase Auth REST API (password verification, token refresh, reset codes).
const config = require('./config');
const emu = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const idBase = emu ? `http://${emu}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
const tokBase = emu ? `http://${emu}/securetoken.googleapis.com/v1` : 'https://securetoken.googleapis.com/v1';

async function call(url, init) {
  if (!config.apiKey) throw Object.assign(new Error('FIREBASE_API_KEY is not configured'), { code: 'CONFIG' });
  const res = await fetch(`${url}?key=${encodeURIComponent(config.apiKey)}`, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(json?.error?.message || 'UNKNOWN').split(/[ :]/)[0];
    throw Object.assign(new Error(code), { code });
  }
  return json;
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

module.exports = {
  signIn: (email, password) => call(`${idBase}/accounts:signInWithPassword`, json({ email, password, returnSecureToken: true })),
  refresh: refreshToken => call(`${tokBase}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  }),
  sendResetEmail: email => call(`${idBase}/accounts:sendOobCode`, json({ requestType: 'PASSWORD_RESET', email })),
  resetPassword: (oobCode, newPassword) => call(`${idBase}/accounts:resetPassword`, json({ oobCode, newPassword })),
};
