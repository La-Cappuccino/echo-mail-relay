import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { findProjectByKeyHash, logSend, logSends, ownsBulkId, pool } from './db.js';
import { bulkTimeoutMs, getBulkStatus, mailersendSend, sendBulkEmail } from './mailersend.js';
import { positiveInt } from './env.js';

// MailerSend is the sole email provider. Brevo was removed 2026-07-19 (its SMTP
// account was never activated — 403 for days). The Brevo client and credentials
// are archived for restore, not lost: git history holds src/brevo.ts, and the
// keys live in Vaultwarden (keychain:brevo-api-key-rnb-vault et al.). To bring
// Brevo back, restore src/brevo.ts, re-add the EMAIL_PROVIDER selector, and set
// BREVO_API_KEY. See the relay README (§ Provider).

const app = createApp({
  findProjectByKeyHash,
  logSend,
  logSends,
  sendEmail: mailersendSend,
  sendBulkEmail,
  getBulkStatus,
  ownsBulkId,
  checkHealth: async () => {
    await pool.query('SELECT 1');
  },
});

// createApp() has already resolved every other numeric setting; touch the
// provider deadline too so an invalid value is reported at boot rather than
// on the first bulk send.
bulkTimeoutMs();

const port = positiveInt('PORT', 8080, { max: 65535 });
serve({ fetch: app.fetch, port }, () => {
  console.log(`echo-mail-relay listening on :${port}`);
});
