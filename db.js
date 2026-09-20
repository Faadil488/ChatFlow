require('dotenv').config();
const { Pool } = require('pg');

// Initialize the PostgreSQL connection pool using DATABASE_URL
// SSL is enabled with rejectUnauthorized: false for hosted databases (e.g. Render, Supabase, Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('[PostgreSQL] Unexpected error on idle client:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
