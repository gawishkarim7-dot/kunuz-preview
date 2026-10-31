'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { closePool, getPool } = require('./db');

async function migrate() {
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('Database schema is up to date.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch(error => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
