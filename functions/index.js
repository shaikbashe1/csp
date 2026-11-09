const { onRequest } = require('firebase-functions/v2/https');
// All /api/** traffic is rewritten to this function by Firebase Hosting (see firebase.json).
exports.api = onRequest({ region: 'us-central1', invoker: 'public', maxInstances: 10 }, require('./src/server'));
