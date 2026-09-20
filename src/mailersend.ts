// Minimal MailerSend email client (REST, no SDK).
// https://developers.mailersend.com/api/v1/email.html
//
// Two MailerSend-specific gotchas are handled here:
//   - a successful single send returns 202 with NO JSON body; the id lives ONLY
//     in the `x-message-id` response header (reading res.json() would throw).
//     A bulk send DOES return JSON: {message, bulk_email_id}.
//   - `x-send-paused: true` on a 202 means the account/domain is paused and
//     nothing actually goes out — surfaced as an error so an outage screams
//     instead of looking like success (the exact failure mode that hid the
//     Brevo 403 for days).
//
// Bulk send classifies its failures, because the caller has to decide whether
// an issue is provably unsent or merely unknown:
//   rejected — provably nothing was sent (4xx, paused account, no API key)
//   unknown  — it may or may not have gone out (5xx, timeout, network error,
//              or an accept we cannot pin to a bulk id)
// Never guess: an id we did not read is `unknown`, not an empty string.

const MAILERSEND_URL = 'https://api.mailersend.com/v1/email';
const MAILERSEND_BULK_URL = 'https://api.mailersend.com/v1/bulk-email';
const BULK_TIMEOUT_MS = 15_000;

export interface MailerSendInput {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  // Forwarded to the provider ONLY when MAILERSEND_LIST_UNSUBSCRIBE=true.
  // MailerSend restricts list_unsubscribe to Professional/Enterprise accounts;
  // this account is Starter, so the default is off and the opt-out link lives
  // in the body instead. See README § List-Unsubscribe.
  listUnsubscribe?: string;
}

export type SendOutcome = 'rejected' | 'unknown';

export class MailerSendError extends Error {
  constructor(
    message: string,
    readonly outcome: SendOutcome,
  ) {
    super(message);
    this.name = 'MailerSendError';
  }
}

export interface BulkStatus {
  state: string;
  validationErrorsCount: number;
  suppressedCount: number;
  raw: unknown;
}

/** Overridable only so tests need not wait out the real 15 s deadline. */
function bulkTimeoutMs(): number {
  return Number(process.env.MAILERSEND_TIMEOUT_MS ?? BULK_TIMEOUT_MS);
}

function listUnsubscribeEnabled(): boolean {
  return process.env.MAILERSEND_LIST_UNSUBSCRIBE === 'true';
}

/** The provider's email object — one per recipient, fully rendered. */
function emailBody(input: MailerSendInput): Record<string, unknown> {
  return {
    from: { email: input.fromEmail, name: input.fromName },
    to: [{ email: input.to }],
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
    ...(input.listUnsubscribe && listUnsubscribeEnabled()
      ? { list_unsubscribe: input.listUnsubscribe }
      : {}),
  };
}

export async function mailersendSend(input: MailerSendInput): Promise<{ messageId: string }> {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) throw new Error('MAILERSEND_API_KEY not configured');

  const res = await fetch(MAILERSEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(emailBody(input)),
  });

  if (!res.ok) {
    // 422 = validation errors (bad recipient, unverified sender, etc.)
    const body = await res.text();
    throw new Error(`MailerSend ${res.status}: ${body.slice(0, 500)}`);
  }

  if (res.headers.get('x-send-paused') === 'true') {
    throw new Error('MailerSend: account or domain is paused (x-send-paused=true) — nothing was sent');
  }

  // Success is 202 with an empty body; the id is header-only.
  return { messageId: res.headers.get('x-message-id') ?? '' };
}

/** The response, fully read. Reading the body is part of the timed operation. */
interface BulkResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Every bulk call under one deadline — and the deadline stays armed while the
 * body is read. Clearing it at the status line would let a provider that
 * sends headers and then stalls the body hang the relay indefinitely.
 */
async function bulkFetch(url: string, init: RequestInit): Promise<BulkResponse> {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) throw new MailerSendError('MAILERSEND_API_KEY not configured', 'rejected');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bulkTimeoutMs());
  let res: Response | undefined;
  try {
    res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
    return { ok: res.ok, status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    // A 4xx status line is already proof the provider refused, even if the
    // body never arrived. Everything else — including an abort AFTER a 2xx —
    // may have been accepted, so it is unknown, never rejected.
    const outcome: SendOutcome =
      res && res.status >= 400 && res.status < 500 ? 'rejected' : 'unknown';
    throw new MailerSendError(`MailerSend request failed: ${message}`, outcome);
  } finally {
    clearTimeout(timer);
  }
}

function statusError(res: BulkResponse, what: string): MailerSendError {
  // 4xx is the provider refusing the request — provably nothing was sent.
  // 5xx could be a failure after the batch was queued.
  const outcome: SendOutcome = res.status >= 400 && res.status < 500 ? 'rejected' : 'unknown';
  return new MailerSendError(`MailerSend ${what} ${res.status}: ${res.body.slice(0, 500)}`, outcome);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function sendBulkEmail(
  inputs: MailerSendInput[],
): Promise<{ bulkEmailId: string }> {
  if (inputs.length === 0) {
    throw new MailerSendError('bulk send requires at least one recipient', 'rejected');
  }

  const res = await bulkFetch(MAILERSEND_BULK_URL, {
    method: 'POST',
    body: JSON.stringify(inputs.map(emailBody)),
  });

  if (!res.ok) throw statusError(res, 'bulk');

  if (res.headers.get('x-send-paused') === 'true') {
    throw new MailerSendError(
      'MailerSend: account or domain is paused (x-send-paused=true) — nothing was sent',
      'rejected',
    );
  }

  // 202 carries {message, bulk_email_id}. Without a usable id the batch cannot
  // be reconciled later, so it is `unknown` rather than a success with no id.
  const payload = parseJson(res.body) as { bulk_email_id?: unknown } | null;
  const bulkEmailId = payload?.bulk_email_id;
  if (typeof bulkEmailId !== 'string' || bulkEmailId === '') {
    throw new MailerSendError(
      `MailerSend accepted the batch (${res.status}) but returned no bulk_email_id`,
      'unknown',
    );
  }
  return { bulkEmailId };
}

export async function getBulkStatus(bulkEmailId: string): Promise<BulkStatus> {
  const res = await bulkFetch(`${MAILERSEND_BULK_URL}/${encodeURIComponent(bulkEmailId)}`, {
    method: 'GET',
  });

  if (!res.ok) throw statusError(res, 'bulk status');

  const raw = parseJson(res.body) as { data?: Record<string, unknown> } | null;
  if (!raw) throw new MailerSendError('MailerSend bulk status: unparseable body', 'unknown');
  const data = raw.data ?? {};
  return {
    state: typeof data.state === 'string' ? data.state : 'unknown',
    validationErrorsCount: Number(data.validation_errors_count ?? 0),
    suppressedCount: Number(data.suppressed_recipients_count ?? 0),
    raw,
  };
}
