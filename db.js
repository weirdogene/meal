import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }
  });
}
