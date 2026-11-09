const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config');

const app = express();
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  hsts: config.isProd,
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.isProd ? [] : null } },
}));
app.use(cors({ origin: (o, cb) => cb(null, !o || config.corsOrigin.includes(o)), credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

// CSRF defence in depth (cookies are SameSite=Strict): state-changing API calls must carry a custom header,
// which browsers will not send cross-origin without a CORS preflight that we deny.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'Missing X-Requested-With header' });
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/research', require('./routes/research'));
app.use('/api', require('./routes/app'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { index: false }));
// SPA fallback: the client router performs guards, the API enforces them for real.
app.get('/{*splat}', (req, res) => res.sendFile(path.join(pub, 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  console.error(err.message); // never log request bodies or tokens
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
