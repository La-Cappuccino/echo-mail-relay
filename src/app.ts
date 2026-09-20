import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Project, SendLogEntry } from './db.js';
import { MailerSendError, type BulkStatus, type MailerSendInput } from './mailersend.js';
import { renderTemplate, TemplateError } from './templates/index.js';
import { RateLimiter } from './ratelimit.js';
import { positiveInt } from './env.js';
import {
  renderedSizes,
  renderRecipients,
  SubstitutionError,
  validateSubstitutions,
  type SubstitutionTemplates,
} from './substitute.js';

export interface AppDeps {
  findProjectByKeyHash(hash: string): Promise<Project | null>;
  logSend(entry: SendLogEntry): Promise<void>;
  logSends(entries: SendLogEntry[]): Promise<void>;
  sendEmail(input: MailerSendInput): Promise<{ messageId: string }>;
  sendBulkEmail(inputs: MailerSendInput[]): Promise<{ bulkEmailId: string }>;
  getBulkStatus(bulkEmailId: string): Promise<BulkStatus>;
  /** Has this project a send-log row for this bulk id? Gates the status read. */
  ownsBulkId(projectId: string, bulkEmailId: string): Promise<boolean>;
  checkHealth(): Promise<void>;
  // Overridable for tests; defaults come from env (SPEC D2).
  ipLimiter?: RateLimiter;
  keyLimiter?: RateLimiter;
  // Bulk has its OWN pre-auth buckets. Sharing /send's would let a burst of
  // bulk attempts (or status polling) rate-limit transactional and auth mail
  // from the same IP or project key.
  bulkIpLimiter?: RateLimiter;
  bulkKeyLimiter?: RateLimiter;
  bulkLimiter?: RateLimiter;
  recipientLimiter?: RateLimiter;
  // Injectable only so a test can prove that a refused path never renders.
  renderBodies?: typeof renderRecipients;
}

interface SendBody {
  tier: 'transactional' | 'marketing';
  to: string;
  subject?: string; // optional when template is set (template provides default)
  html?: string; // required unless template is set
  text?: string;
  template?: string; // relay-side rendering: `<project-id>/<name>` from the registry
  data?: Record<string, unknown>; // template data
  replyTo?: string;
  listUnsubscribe?: string; // forwarded to the provider only behind the flag (AM1)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

// /send-bulk limits (SPEC §3). The body cap is a constant, not an env var —
// it is part of the contract the app builds against.
export const MAX_BULK_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BULK_RECIPIENTS = 500;
const MAX_SUBJECT_LENGTH = 200;
// A List-Unsubscribe value becomes a mail header at the provider, so it must
// never be able to split one. 990 is the RFC 5322 line limit less CRLF.
const MAX_LIST_UNSUBSCRIBE_LENGTH = 990;
// A provider id is an opaque token; anything else must never reach a URL.
const BULK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Sane ceilings, so a fat-fingered value cannot disable what it configures.
const MAX_RATE = 1_000_000; // calls or recipients per window
const RENDERED_EMAIL_CEILING = 1024 * 1024 * 1024; // 1 GB
const RENDERED_TOTAL_CEILING = 8 * 1024 * 1024 * 1024; // 8 GB

function defaultLimiter(): RateLimiter {
  const perMin = positiveInt('RATE_LIMIT_PER_MINUTE', 60, { max: MAX_RATE });
  const burst = positiveInt('RATE_LIMIT_BURST', 20, { max: MAX_RATE });
  return new RateLimiter({ capacity: burst, refillPerSec: perMin / 60 });
}

/** Pre-auth buckets for the bulk routes — same shape as /send's, own tokens. */
function defaultBulkPreAuthLimiter(): RateLimiter {
  const perMin = positiveInt('BULK_RATE_LIMIT_PER_MINUTE', 60, { max: MAX_RATE });
  const burst = positiveInt('BULK_RATE_LIMIT_BURST', 20, { max: MAX_RATE });
  return new RateLimiter({ capacity: burst, refillPerSec: perMin / 60 });
}

function defaultBulkLimiter(): RateLimiter {
  const perMin = positiveInt('BULK_REQUESTS_PER_MINUTE', 10, { max: MAX_RATE });
  return new RateLimiter({ capacity: perMin, refillPerSec: perMin / 60 });
}

function defaultRecipientLimiter(): RateLimiter {
  const perHour = positiveInt('BULK_RECIPIENTS_PER_HOUR', 2000, { max: MAX_RATE });
  return new RateLimiter({ capacity: perHour, refillPerSec: perHour / 3600 });
}

// --- pure helpers, shared by /send and /send-bulk ---
// These exist so the bulk routes reuse /send's exact auth arithmetic. /send
// still performs its checks in its original order; only the arithmetic moved.

/** Why this listUnsubscribe value is unacceptable, or null if it is fine. */
function listUnsubscribeProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'listUnsubscribe must be a string';
  if (value.length > MAX_LIST_UNSUBSCRIBE_LENGTH) {
    return `listUnsubscribe exceeds ${MAX_LIST_UNSUBSCRIBE_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(value)) return 'listUnsubscribe contains a control character';
  return null;
}

/** The first X-Forwarded-For hop, or 'unknown' when the header is absent. */
export function firstForwardedHop(header: string | undefined): string {
  return header?.split(',')[0]?.trim() || 'unknown';
}

/** The token from an `Authorization: Bearer …` header, or '' if there is none. */
export function bearerKeyFrom(authorization: string | undefined): string {
  const auth = authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time compare, so timing cannot confirm a hash guess. */
export function keyHashMatches(storedHex: string, givenHex: string): boolean {
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(givenHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read at most `max` bytes of the request body, then stop.
 *
 * Measuring after `req.text()` would buffer the whole stream first, so a
 * caller omitting Content-Length could make the relay hold an arbitrary
 * amount of memory before being told the body is too large. This counts as
 * it reads and cancels the source the moment the cap is passed. Chunks are
 * concatenated before decoding, so a multi-byte character split across a
 * chunk boundary survives.
 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ body: string } | { tooLarge: true }> {
  if (!stream) return { body: '' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks).toString('utf8') };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // Two independent buckets: per client IP (pre-auth, blunt) and per bearer-key
  // hash (post-hash, per-project fairness + shields the DB from key brute force).
  const ipLimiter = deps.ipLimiter ?? defaultLimiter();
  const keyLimiter = deps.keyLimiter ?? defaultLimiter();
  // Bulk gets its OWN buckets, all four of them, so a newsletter can never
  // starve auth mail: its own pre-auth IP and key buckets, one for request
  // frequency, and one weighted by recipients per project.
  const bulkIpLimiter = deps.bulkIpLimiter ?? defaultBulkPreAuthLimiter();
  const bulkKeyLimiter = deps.bulkKeyLimiter ?? defaultBulkPreAuthLimiter();
  const bulkLimiter = deps.bulkLimiter ?? defaultBulkLimiter();
  const recipientLimiter = deps.recipientLimiter ?? defaultRecipientLimiter();
  const renderBodies = deps.renderBodies ?? renderRecipients;
  // A 2 MB request can still describe gigabytes of output, so the rendered
  // size is capped separately from the request size.
  const maxRenderedEmailBytes = positiveInt('BULK_MAX_RENDERED_EMAIL_BYTES', 512 * 1024, {
    max: RENDERED_EMAIL_CEILING,
  });
  const maxRenderedTotalBytes = positiveInt('BULK_MAX_RENDERED_TOTAL_BYTES', 32 * 1024 * 1024, {
    max: RENDERED_TOTAL_CEILING,
  });

  app.get('/health', async (c) => {
    try {
      await deps.checkHealth();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, db: 'unreachable' }, 503);
    }
  });

  app.post('/send', async (c) => {
    // --- rate limit: per client IP (SPEC D2) ---
    const ip = firstForwardedHop(c.req.header('x-forwarded-for'));
    if (!ipLimiter.take(`ip:${ip}`)) {
      console.warn(`[relay] rate limited ip=${ip}`);
      return c.json({ error: 'rate limited' }, 429);
    }

    // --- auth: per-project bearer key (SPEC D1) ---
    const key = bearerKeyFrom(c.req.header('authorization'));
    if (!key) return c.json({ error: 'missing bearer token' }, 401);

    const hash = hashKey(key);

    // --- rate limit: per bearer-key hash, before the DB lookup (SPEC D2) ---
    if (!keyLimiter.take(`key:${hash}`)) {
      console.warn(`[relay] rate limited key=${hash.slice(0, 8)}…`);
      return c.json({ error: 'rate limited' }, 429);
    }

    const project = await deps.findProjectByKeyHash(hash);
    if (!project) return c.json({ error: 'unknown project key' }, 401);
    // constant-time re-check to avoid trivially confirming hash equality via timing
    if (!keyHashMatches(project.api_key_hash, hash)) {
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

    // --- relay-side template rendering (SPEC assumption 4) ---
    let subject = body.subject;
    let html = body.html;
    let text = body.text;
    if (body.template) {
      // a project may only render templates in its own namespace
      if (!body.template.startsWith(`${project.id}/`)) {
        return c.json({ error: `template outside project namespace '${project.id}/'` }, 403);
      }
      try {
        const rendered = await renderTemplate(body.template, body.data ?? {});
        subject = subject ?? rendered.subject;
        html = rendered.html;
        text = rendered.text;
      } catch (err) {
        if (err instanceof TemplateError) return c.json({ error: err.message }, 400);
        throw err;
      }
    }
    if (!subject) return c.json({ error: 'missing subject' }, 400);
    if (!html) return c.json({ error: 'missing html (or template)' }, 400);
    // Optional field added for the bulk work — absent, /send behaves exactly
    // as it always has; present, it is validated before it can become a header.
    if (body.listUnsubscribe !== undefined) {
      const problem = listUnsubscribeProblem(body.listUnsubscribe);
      if (problem) return c.json({ error: problem }, 400);
    }

    // --- tiered kill-switch (SPEC D4) ---
    // hard_off blocks everything (decommissioned project).
    // marketing_enabled=false blocks ONLY marketing; transactional always flows.
    let suppressReason: string | null = null;
    if (project.hard_off) suppressReason = 'hard_off';
    else if (body.tier === 'marketing' && !project.marketing_enabled) suppressReason = 'marketing_disabled';

    if (suppressReason) {
      await deps.logSend({
        project_id: project.id,
        tier: body.tier,
        template: body.template,
        recipient: body.to,
        subject: subject,
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

    // --- send via MailerSend ---
    try {
      const { messageId } = await deps.sendEmail({
        fromEmail: project.from_email,
        fromName: project.from_name,
        to: body.to,
        subject: subject,
        html: html,
        text: text,
        replyTo: body.replyTo,
        ...(body.listUnsubscribe ? { listUnsubscribe: body.listUnsubscribe } : {}),
      });
      await deps.logSend({
        project_id: project.id,
        tier: body.tier,
        template: body.template,
        recipient: body.to,
        subject: subject,
        status: 'sent',
        provider_message_id: messageId,
      });
      return c.json({ ok: true, messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await deps.logSend({
        project_id: project.id,
        tier: body.tier,
        template: body.template,
        recipient: body.to,
        subject: subject,
        status: 'failed',
        error: message,
      });
      console.error(`[relay] send failed project=${project.id} to=${body.to}:`, message);
      return c.json({ error: 'send failed' }, 502);
    }
  });

  // --------------------------------------------------------------------
  // Bulk marketing send. Single batch, all-or-nothing, no retry anywhere:
  // the caller initiates an issue once and the relay's job is to make the
  // outcome knowable — sent, provably-not-sent, or honestly unknown.
  // --------------------------------------------------------------------

  type BulkAuth = { project: Project; hash: string } | { error: Response };

  // Note the limiters: bulkIpLimiter / bulkKeyLimiter, never /send's. A caller
  // hammering this route must not be able to rate-limit its own auth mail.
  async function authenticateBulk(c: Context): Promise<BulkAuth> {
    const ip = firstForwardedHop(c.req.header('x-forwarded-for'));
    if (!bulkIpLimiter.take(`ip:${ip}`)) {
      console.warn(`[relay] bulk rate limited ip=${ip}`);
      return { error: c.json({ error: 'rate limited' }, 429) };
    }
    const key = bearerKeyFrom(c.req.header('authorization'));
    if (!key) return { error: c.json({ error: 'missing bearer token' }, 401) };

    const hash = hashKey(key);
    if (!bulkKeyLimiter.take(`key:${hash}`)) {
      console.warn(`[relay] bulk rate limited key=${hash.slice(0, 8)}…`);
      return { error: c.json({ error: 'rate limited' }, 429) };
    }

    const project = await deps.findProjectByKeyHash(hash);
    if (!project) return { error: c.json({ error: 'unknown project key' }, 401) };
    if (!keyHashMatches(project.api_key_hash, hash)) {
      return { error: c.json({ error: 'unknown project key' }, 401) };
    }
    return { project, hash };
  }

  function bulkLogEntries(
    project: Project,
    recipients: string[],
    subject: string,
    status: SendLogEntry['status'],
    extra: Partial<SendLogEntry> = {},
  ): SendLogEntry[] {
    return recipients.map((recipient) => ({
      project_id: project.id,
      tier: 'marketing',
      recipient,
      subject,
      status,
      ...extra,
    }));
  }

  /** Logging must never change the outcome the caller is told about. */
  async function safeLogSends(entries: SendLogEntry[]): Promise<boolean> {
    try {
      await deps.logSends(entries);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[relay] bulk log failed project=${entries[0]?.project_id}:`, message);
      return false;
    }
  }

  app.post('/send-bulk', async (c) => {
    const auth = await authenticateBulk(c);
    if ('error' in auth) return auth.error;
    const { project, hash } = auth;

    // --- body size cap (SPEC §3) ---
    // Cheap rejection first when the caller declares its size, then a bounded
    // read that stops at the cap whether or not it declared one.
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_BULK_BODY_BYTES) return c.json({ error: 'body too large' }, 413);
    const read = await readBoundedBody(c.req.raw.body, MAX_BULK_BODY_BYTES);
    if ('tooLarge' in read) return c.json({ error: 'body too large' }, 413);

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body);
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const validated = validateBulkBody(parsed);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    const { subject, html, text, replyTo, listUnsubscribe, recipients } = validated.value;

    // Validate every recipient's substitutions up front — a problem anywhere
    // fails the whole call with 400 and nothing is sent (SPEC §3). This step
    // deliberately renders NOTHING: bodies are materialised only once the
    // request has survived the kill-switch, the budget and the size preflight.
    const templates: SubstitutionTemplates = {
      html,
      ...(text !== undefined ? { text } : {}),
      ...(listUnsubscribe !== undefined ? { listUnsubscribe } : {}),
    };
    let substitutions;
    try {
      substitutions = validateSubstitutions(templates, recipients);
    } catch (err) {
      if (err instanceof SubstitutionError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const to = recipients.map((r) => r.to);

    // --- tiered kill-switch (SPEC D4) — bulk is always the marketing tier ---
    const suppressReason = project.hard_off
      ? 'hard_off'
      : project.marketing_enabled
        ? null
        : 'marketing_disabled';
    if (suppressReason) {
      await safeLogSends(
        bulkLogEntries(project, to, subject, 'suppressed', { suppress_reason: suppressReason }),
      );
      if (suppressReason === 'hard_off') {
        return c.json({ error: 'project is hard-off', suppressed: true }, 403);
      }
      return c.json({ ok: true, suppressed: true, reason: suppressReason });
    }

    // --- volume protection ---
    // Both allowances are CONFIRMED here and CHARGED after the size preflight,
    // so a request the preflight refuses spends neither. Nothing awaits between
    // the confirmation and the charge, so nothing else can take them meanwhile.
    const bulkKey = `key:${hash}`;
    const budgetKey = `project:${project.id}`;
    if (!bulkLimiter.canTake(bulkKey)) {
      console.warn(`[relay] bulk rate limited key=${hash.slice(0, 8)}…`);
      return c.json({ error: 'rate limited' }, 429);
    }
    if (!recipientLimiter.canTake(budgetKey, recipients.length)) {
      console.warn(`[relay] recipient budget exhausted project=${project.id} n=${recipients.length}`);
      return c.json({ error: 'recipient budget exhausted' }, 429);
    }

    // --- rendered size preflight: arithmetic, nothing materialised ---
    // A 2 MB request can describe gigabytes of output ({{a}} a thousand times
    // over, a 2000-char value, 500 recipients). Refuse it before building it.
    const sizes = renderedSizes(templates, substitutions);

    // listUnsubscribe is capped as a template further up, but substitution can
    // expand a five-character token into a 2000-character header value, so the
    // EXPANDED length is what has to satisfy the limit.
    const overLongHeader = (sizes.listUnsubscribePerEmail ?? []).findIndex(
      (n) => n > MAX_LIST_UNSUBSCRIBE_LENGTH,
    );
    if (overLongHeader >= 0) {
      return c.json(
        {
          error: `listUnsubscribe exceeds ${MAX_LIST_UNSUBSCRIBE_LENGTH} characters after substitution (recipient ${overLongHeader + 1})`,
        },
        400,
      );
    }

    const oversized = sizes.perEmail.findIndex((n) => n > maxRenderedEmailBytes);
    if (oversized >= 0) {
      return c.json(
        {
          error: `rendered email exceeds ${maxRenderedEmailBytes} bytes (recipient ${oversized + 1})`,
        },
        413,
      );
    }
    if (sizes.total > maxRenderedTotalBytes) {
      return c.json({ error: `rendered batch exceeds ${maxRenderedTotalBytes} bytes` }, 413);
    }

    // Charge both, synchronously, immediately before rendering. Both were
    // confirmed above with no await in between, so this cannot fail — the
    // guard is here so that a future edit introducing an await gets a 429
    // rather than a silently unmetered send.
    if (!bulkLimiter.take(bulkKey) || !recipientLimiter.take(budgetKey, recipients.length)) {
      console.warn(`[relay] bulk allowance vanished between check and charge project=${project.id}`);
      return c.json({ error: 'rate limited' }, 429);
    }

    const rendered = renderBodies(templates, substitutions);
    const inputs: MailerSendInput[] = rendered.map((bodies, i) => ({
      fromEmail: project.from_email,
      fromName: project.from_name,
      to: to[i],
      subject,
      html: bodies.html,
      ...(bodies.text !== undefined ? { text: bodies.text } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(bodies.listUnsubscribe !== undefined
        ? { listUnsubscribe: bodies.listUnsubscribe }
        : {}),
    }));

    let bulkEmailId: string;
    try {
      ({ bulkEmailId } = await deps.sendBulkEmail(inputs));
    } catch (err) {
      // Anything we did not classify is `unknown` — never claim "nothing was
      // sent" unless the provider told us so.
      const outcome = err instanceof MailerSendError ? err.outcome : 'unknown';
      const message = err instanceof Error ? err.message : 'unknown error';
      await safeLogSends(
        bulkLogEntries(project, to, subject, 'failed', {
          error: outcome === 'unknown' ? `outcome=unknown: ${message}` : message,
        }),
      );
      console.error(`[relay] bulk send ${outcome} project=${project.id} n=${to.length}:`, message);
      return c.json({ error: message, outcome }, 502);
    }

    // The provider has accepted. From here the answer is 200 no matter what:
    // reporting failure now would tell the caller nothing was sent when it was.
    const logged = await safeLogSends(
      bulkLogEntries(project, to, subject, 'sent', { provider_message_id: bulkEmailId }),
    );
    return c.json({ ok: true, bulkEmailId, accepted: to.length, logged });
  });

  app.get('/send-bulk/:bulkEmailId', async (c) => {
    const auth = await authenticateBulk(c);
    if ('error' in auth) return auth.error;
    const { project } = auth;
    // A decommissioned project reads nothing either (D4: hard_off blocks all).
    // marketing_enabled is deliberately NOT checked: a batch already sent must
    // stay reconcilable after the kill-switch is flipped.
    if (project.hard_off) return c.json({ error: 'project is hard-off', suppressed: true }, 403);

    const bulkEmailId = c.req.param('bulkEmailId');
    if (!BULK_ID_RE.test(bulkEmailId)) return c.json({ error: 'invalid bulk email id' }, 400);

    // Authentication alone would let any project read any batch, provider
    // payload included. Ownership comes from our own send log, and is proved
    // before the provider is asked anything. A lookup failure fails closed.
    let owned: boolean;
    try {
      owned = await deps.ownsBulkId(project.id, bulkEmailId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[relay] bulk ownership check failed project=${project.id}:`, message);
      return c.json({ error: 'ownership check unavailable' }, 503);
    }
    if (!owned) return c.json({ error: 'not found' }, 404);

    try {
      const status = await deps.getBulkStatus(bulkEmailId);
      return c.json({
        ok: true,
        state: status.state,
        validationErrorsCount: status.validationErrorsCount,
        suppressedCount: status.suppressedCount,
        raw: status.raw,
      });
    } catch (err) {
      const outcome = err instanceof MailerSendError ? err.outcome : 'unknown';
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[relay] bulk status failed project=${project.id}:`, message);
      return c.json({ error: message, outcome }, 502);
    }
  });

  return app;
}

interface BulkRecipient {
  to: string;
  substitutions: Record<string, string>;
}

interface BulkPayload {
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  listUnsubscribe?: string;
  recipients: BulkRecipient[];
}

/**
 * Shape validation for /send-bulk. Substitution values are NOT checked here —
 * that is substitute.ts's job, and it runs over the same recipients moments
 * later. This only has to guarantee the shape the renderer assumes.
 */
function validateBulkBody(parsed: unknown): { value: BulkPayload } | { error: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'body must be a JSON object' };
  }
  const body = parsed as Record<string, unknown>;

  if (body.tier !== 'marketing') return { error: "tier must be 'marketing'" };

  const { subject, html } = body;
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > MAX_SUBJECT_LENGTH) {
    return { error: `subject must be a string of 1..${MAX_SUBJECT_LENGTH} characters` };
  }
  if (typeof html !== 'string' || html.length === 0) return { error: 'html is required' };

  if (body.text !== undefined && typeof body.text !== 'string') {
    return { error: 'text must be a string' };
  }
  if (body.replyTo !== undefined && (typeof body.replyTo !== 'string' || !EMAIL_RE.test(body.replyTo))) {
    return { error: 'replyTo must be an email address' };
  }
  if (body.listUnsubscribe !== undefined) {
    // Same rule as /send: it becomes a mail header at the provider, and a bare
    // CR/LF would split it. Substituted values are checked separately.
    const problem = listUnsubscribeProblem(body.listUnsubscribe);
    if (problem) return { error: problem };
  }

  const list = body.recipients;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BULK_RECIPIENTS) {
    return { error: `recipients must be an array of 1..${MAX_BULK_RECIPIENTS}` };
  }

  const recipients: BulkRecipient[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const position = index + 1;
    if (typeof entry !== 'object' || entry === null) {
      return { error: `recipient ${position}: must be an object` };
    }
    const { to, substitutions } = entry as Record<string, unknown>;
    if (typeof to !== 'string' || !EMAIL_RE.test(to)) {
      return { error: `recipient ${position}: invalid recipient` };
    }
    const normalised = to.trim().toLowerCase();
    if (seen.has(normalised)) return { error: `recipient ${position}: duplicate recipient` };
    seen.add(normalised);
    recipients.push({ to, substitutions: substitutions as Record<string, string> });
  }

  return {
    value: {
      subject,
      html,
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
      ...(typeof body.listUnsubscribe === 'string'
        ? { listUnsubscribe: body.listUnsubscribe }
        : {}),
      recipients,
    },
  };
}
