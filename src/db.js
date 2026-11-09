const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.databaseUrl, max: process.env.VERCEL ? 3 : 10 });
module.exports = { pool, query: (text, params) => pool.query(text, params) };
