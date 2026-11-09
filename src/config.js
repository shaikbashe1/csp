require('dotenv').config();
const isProd = process.env.NODE_ENV === 'production';
function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Run "npm run init-env" or see .env.example`);
  return v;
}
module.exports = {
  isProd,
  port: Number(process.env.PORT || 3000),
  databaseUrl: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7),
  corsOrigin: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 20),
  devResetTokens: !isProd && process.env.DEV_RESET_TOKENS === 'true',
  researchMinGroup: Number(process.env.RESEARCH_MIN_GROUP || 3),
};
