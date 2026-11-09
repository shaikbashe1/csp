const emulated = process.env.FUNCTIONS_EMULATOR === 'true' || !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
const isProd = process.env.NODE_ENV === 'production' && !emulated;
module.exports = {
  emulated,
  isProd,
  // Public Firebase *web* API key (not a secret). Required for the password REST endpoints in production.
  apiKey: process.env.FIREBASE_API_KEY || (emulated ? 'demo-key' : ''),
  corsOrigin: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 20),
  // Dev only: return the reset code in the response. Always off in production.
  devResetTokens: !isProd && process.env.DEV_RESET_TOKENS !== 'false',
  researchMinGroup: Number(process.env.RESEARCH_MIN_GROUP || 3),
  maxFailedLogins: 5,
  lockMinutes: 15,
};
