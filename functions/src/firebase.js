const admin = require('firebase-admin');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
module.exports = { admin, db, auth: admin.auth(), FieldValue, Timestamp };
