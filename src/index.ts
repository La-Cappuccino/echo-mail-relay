import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { findProjectByKeyHash, logSend, pool } from './db.js';
import { brevoSend } from './brevo.js';

const app = new Hono();

app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, db: 'unreachable' }, 503);
  }
});

interface SendBody {
  tier: 'transactional' | 'marketing';
  to: string;
  subject: string;
  html: string;
  text?: string;
  template?: string; // reserved: slice-2 relay-side rendering
  replyTo?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/send', async (c) => {
  // --- auth: per-project bearer key (SPEC D1) ---
  const auth = c.req.header('authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!key) return c.json({ error: 'missing bearer token' }, 401);

  const hash = createHash('sha256').update(key).digest('hex');
  const project = await findProjectByKeyHash(hash);
  if (!project) return c.json({ error: 'unknown project key' }, 401);
  // constant-time re-check to avoid trivially confirming hash equality via timing
  const a = Buffer.from(project.api_key_hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'unknown project key' }, 401);
  }

  // --- payload validation ---
  let body: SendBody;
  try {
    body = await c.req.json<SendBody>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (body.tier !== 'transactional' && body.tier !== 'marketing') {
    return c.json({ error: "tier must be 'transactional' or 'marketing'" }, 400);
  }
  if (!body.to || !EMAIL_RE.test(body.to)) return c.json({ error: 'invalid recipient' }, 400);
  if (!body.subject) return c.json({ error: 'missing subject' }, 400);
  if (!body.html) return c.json({ error: 'missing html' }, 400);

  // --- tiered kill-switch (SPEC D4) ---
  // hard_off blocks everything (decommissioned project).
  // marketing_enabled=false blocks ONLY marketing; transactional always flows.
  let suppressReason: string | null = null;
  if (project.hard_off) suppressReason = 'hard_off';
  else if (body.tier === 'marketing' && !project.marketing_enabled) suppressReason = 'marketing_disabled';

  if (suppressReason) {
    await logSend({
      project_id: project.id,
      tier: body.tier,
      template: body.template,
      recipient: body.to,
      subject: body.subject,
      status: 'suppressed',
      suppress_reason: suppressReason,
    });
    // Marketing suppression is a silent success-shape (app flows continue).
    // hard_off returns 403 so a decommissioned project screams (SPEC D4).
    if (suppressReason === 'hard_off') {
      return c.json({ error: 'project is hard-off', suppressed: true }, 403);
    }
    return c.json({ ok: true, suppressed: true, reason: suppressReason });
  }

  // --- send via Brevo ---
  try {
    const { messageId } = await brevoSend({
      fromEmail: project.from_email,
      fromName: project.from_name,
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      replyTo: body.replyTo,
    });
    await logSend({
      project_id: project.id,
      tier: body.tier,
      template: body.template,
      recipient: body.to,
      subject: body.subject,
      status: 'sent',
      brevo_message_id: messageId,
    });
    return c.json({ ok: true, messageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await logSend({
      project_id: project.id,
      tier: body.tier,
      template: body.template,
      recipient: body.to,
      subject: body.subject,
      status: 'failed',
      error: message,
    });
    console.error(`[relay] send failed project=${project.id} to=${body.to}:`, message);
    return c.json({ error: 'send failed' }, 502);
  }
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => {
  console.log(`echo-mail-relay listening on :${port}`);
});
