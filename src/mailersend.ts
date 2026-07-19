// Minimal MailerSend transactional-email client (REST, no SDK).
// https://developers.mailersend.com/api/v1/email.html
//
// Mirrors brevo.ts's interface so index.ts can swap providers with zero
// call-site change. Two MailerSend-specific gotchas are handled here:
//   - a successful send returns 202 with NO JSON body; the id lives ONLY in
//     the `x-message-id` response header (reading res.json() would throw).
//   - `x-send-paused: true` on a 202 means the account/domain is paused and
//     nothing actually goes out — surfaced as an error so an outage screams
//     instead of looking like success (the exact failure mode that hid the
//     Brevo 403 for days).

const MAILERSEND_URL = 'https://api.mailersend.com/v1/email';

export interface MailerSendInput {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
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
    body: JSON.stringify({
      from: { email: input.fromEmail, name: input.fromName },
      to: [{ email: input.to }],
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
    }),
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
