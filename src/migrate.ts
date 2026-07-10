// Apply migrations/*.sql in filename order. Idempotent (all DDL is IF NOT EXISTS).
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const sql = await readFile(join(dir, f), 'utf8');
  console.log(`applying ${f}...`);
  await pool.query(sql);
}
console.log('migrations done');
await pool.end();
