// ───────────────────────────────────────────────────────
// HLSR Asset Tracker — PostgreSQL pool (8 Seconds pattern)
// Env: DATABASE_URL (full connection string, sslmode=require)
// ───────────────────────────────────────────────────────
const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not configured');
  _pool = new Pool({
    connectionString: url,
    // Azure requires SSL (put sslmode=require in DATABASE_URL); local dev doesn't
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

// Run fn inside a transaction with a dedicated client.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, getPool };
