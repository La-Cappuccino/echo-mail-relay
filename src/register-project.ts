// Register (or update) a project and mint its API key.
// Usage: DATABASE_URL=... tsx src/register-project.ts <id> <display_name> <from_email> <from_name> <domain>
// Prints the plaintext key ONCE — store it in Vaultwarden; only the sha256 hash is persisted.
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './db.js';

const [id, displayName, fromEmail, fromName, domain] = process.argv.slice(2);
if (!id || !displayName || !fromEmail || !fromName || !domain) {
  console.error('usage: register-project <id> <display_name> <from_email> <from_name> <domain>');
  process.exit(1);
}

const key = `emr_${id}_${randomBytes(24).toString('hex')}`;
const hash = createHash('sha256').update(key).digest('hex');

await pool.query(
  `INSERT INTO projects (id, display_name, from_email, from_name, domain, api_key_hash)
   VALUES ($1,$2,$3,$4,$5,$6)
   ON CONFLICT (id) DO UPDATE SET
     display_name = EXCLUDED.display_name,
     from_email   = EXCLUDED.from_email,
     from_name    = EXCLUDED.from_name,
     domain       = EXCLUDED.domain,
     api_key_hash = EXCLUDED.api_key_hash,
     updated_at   = now()`,
  [id, displayName, fromEmail, fromName, domain, hash],
);

console.log(`project '${id}' registered.`);
console.log(`API key (store in Vaultwarden as 'emr-key-${id}', shown ONCE):`);
console.log(key);
await pool.end();
