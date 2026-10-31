'use strict';

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('Database is not configured.');
    error.code = 'database_unconfigured';
    throw error;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined
    });
    pool.on('error', error => {
      console.error('Unexpected PostgreSQL pool error:', error.message);
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    const currentPool = pool;
    pool = undefined;
    await currentPool.end();
  }
}

module.exports = { closePool, getPool };
