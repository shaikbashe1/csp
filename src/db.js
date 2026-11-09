const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.databaseUrl });
module.exports = { pool, query: (text, params) => pool.query(text, params) };
