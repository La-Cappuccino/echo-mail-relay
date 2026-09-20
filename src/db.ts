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

/**
 * Does this project have a send-log row for this provider id? The bulk status
 * read uses it to prove ownership before asking MailerSend about a batch —
 * authentication alone would let any valid project key read any other
 * project's batch, provider payload included.
 */
export async function ownsBulkId(projectId: string, bulkEmailId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM sends WHERE project_id = $1 AND brevo_message_id = $2 LIMIT 1',
    [projectId, bulkEmailId],
  );
  return rows.length > 0;
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

const SEND_COLUMNS =
  'project_id, tier, template, recipient, subject, status, suppress_reason, brevo_message_id, error';

function sendValues(entry: SendLogEntry): unknown[] {
  return [
    entry.project_id,
    entry.tier,
    entry.template ?? null,
    entry.recipient,
    entry.subject,
    entry.status,
    entry.suppress_reason ?? null,
    entry.provider_message_id ?? null,
    entry.error ?? null,
  ];
}

export async function logSend(entry: SendLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO sends (${SEND_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    sendValues(entry),
  );
}

/**
 * One multi-row insert for a whole bulk batch — a per-recipient ledger written
 * in a single statement, so the batch is either all recorded or none of it is.
 * 500 recipients × 9 columns is well inside Postgres' parameter limit.
 */
export async function logSends(entries: SendLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const values = entries.flatMap(sendValues);
  const columnCount = SEND_COLUMNS.split(',').length;
  const tuples = entries.map((_, row) => {
    const placeholders = Array.from({ length: columnCount }, (_, col) => `$${row * columnCount + col + 1}`);
    return `(${placeholders.join(',')})`;
  });
  await pool.query(`INSERT INTO sends (${SEND_COLUMNS}) VALUES ${tuples.join(',')}`, values);
}
