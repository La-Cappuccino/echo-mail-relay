import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

export interface Project {
  id: string;
  display_name: string;
  from_email: string;
  from_name: string;
  domain: string;
  api_key_hash: string;
  marketing_enabled: boolean;
  hard_off: boolean;
}

export async function findProjectByKeyHash(hash: string): Promise<Project | null> {
  const { rows } = await pool.query<Project>(
    'SELECT * FROM projects WHERE api_key_hash = $1',
    [hash],
  );
  return rows[0] ?? null;
}

export interface SendLogEntry {
  project_id: string;
  tier: string;
  template?: string | null;
  recipient: string;
  subject: string;
  status: 'sent' | 'suppressed' | 'failed';
  suppress_reason?: string | null;
  // Provider message id. Stored in the legacy `brevo_message_id` column
  // (schema v0 predates the MailerSend cutover); the column is NOT renamed —
  // this relay is its sole reader/writer, so a rename or compat view would
  // add migration risk for zero benefit. See README § Send log.
  provider_message_id?: string | null;
  error?: string | null;
}

export async function logSend(entry: SendLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO sends (project_id, tier, template, recipient, subject, status, suppress_reason, brevo_message_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.project_id,
      entry.tier,
      entry.template ?? null,
      entry.recipient,
      entry.subject,
      entry.status,
      entry.suppress_reason ?? null,
      entry.provider_message_id ?? null,
      entry.error ?? null,
    ],
  );
}
