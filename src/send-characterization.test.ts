// Characterization tests for POST /send — written BEFORE any /send refactor.
// More than one product's transactional and auth mail goes through this route,
// so its behaviour is pinned here rather than merely described. These assert
// the CURRENT behaviour, including the exact ORDER of checks: a later slice may
// extract pure helpers, but a helper must be called from the same position or
// one of these fails.
//
// Anything asserted here is load-bearing for a live caller. Do not "fix" a
// surprise found here — change it deliberately, in its own commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp, type AppDeps } from './app.js';
import type { Project, SendLogEntry } from './db.js';
import type { MailerSendInput } from './mailersend.js';
import { RateLimiter } from './ratelimit.js';

const KEYS = {
  normal: 'c-normal-project',
  marketingOff: 'c-marketing-off',
  hardOff: 'c-hard-off',
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function project(id: string, key: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    display_name: id,
    from_email: `noreply@${id}.example.com`,
    from_name: `${id} display`,
    domain: `${id}.example.com`,
    api_key_hash: sha256(key),
    marketing_enabled: true,
    hard_off: false,
    ...overrides,
  };
}

const PROJECTS: Project[] = [
  project('rnb-vault', KEYS.normal),
  project('marketing-off', KEYS.marketingOff, { marketing_enabled: false }),
  project('decommissioned', KEYS.hardOff, { hard_off: true }),
];

interface Harness {
  app: ReturnType<typeof createApp>;
  logged: SendLogEntry[];
  delivered: MailerSendInput[]; // full input, so forwarded fields are pinned
}

function makeHarness(overrides: Partial<AppDeps> = {}): Harness {
  const logged: SendLogEntry[] = [];
  const delivered: MailerSendInput[] = [];
  const app = createApp({
    findProjectByKeyHash: async (hash) => PROJECTS.find((p) => p.api_key_hash === hash) ?? null,
    logSend: async (entry) => {
      logged.push(entry);
    },
    sendEmail: async (input) => {
      delivered.push(input);
      return { messageId: 'char-message-id' };
    },
    checkHealth: async () => {},
    ipLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    keyLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    ...overrides,
  });
  return { app, logged, delivered };
}

function send(app: Harness['app'], key: string | null, body: unknown, ip?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (ip) headers['x-forwarded-for'] = ip;
  return app.request('/send', { method: 'POST', headers, body: JSON.stringify(body) });
}

const BASE = { tier: 'transactional', to: 'user@example.com', subject: 'Hi', html: '<p>hi</p>' };

// --- check ORDER (the part a refactor is most likely to break) ---

test('order: IP rate limit fires before auth — no bearer token still gets 429', async () => {
  const { app } = makeHarness({ ipLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }) });
  const res = await send(app, null, BASE, '203.0.113.9');
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'rate limited' });
});

test('order: key rate limit fires before the project lookup — unknown key gets 429, not 401', async () => {
  let lookups = 0;
  const { app } = makeHarness({
    keyLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }),
    findProjectByKeyHash: async () => {
      lookups += 1;
      return null;
    },
  });
  const res = await send(app, 'not-a-real-key', BASE);
  assert.equal(res.status, 429);
  assert.equal(lookups, 0);
});

test('order: auth beats payload validation — bad key + invalid recipient → 401', async () => {
  const { app } = makeHarness();
  const res = await send(app, 'not-a-real-key', { ...BASE, to: 'nonsense' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unknown project key' });
});

test('order: tier validation beats recipient validation', async () => {
  const { app } = makeHarness();
  const res = await send(app, KEYS.normal, { ...BASE, tier: 'bulk', to: 'nonsense' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "tier must be 'transactional' or 'marketing'" });
});

test('order: payload validation beats the kill-switch — bad tier on a hard_off project → 400', async () => {
  const { app, logged } = makeHarness();
  const res = await send(app, KEYS.hardOff, { ...BASE, tier: 'bulk' });
  assert.equal(res.status, 400);
  assert.equal(logged.length, 0); // nothing is logged for a validation reject
});

test('order: template namespace check beats the kill-switch — hard_off project → namespace 403', async () => {
  const { app, logged } = makeHarness();
  const res = await send(app, KEYS.hardOff, {
    tier: 'transactional',
    to: 'user@example.com',
    template: 'rnb-vault/password-reset',
    data: { resetUrl: 'https://example.com/reset' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /outside project namespace/);
  assert.equal(logged.length, 0);
});

test('order: template rendering beats the missing-subject / missing-html checks', async () => {
  const { app, delivered } = makeHarness();
  // no subject and no html in the body — the template supplies both
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.com',
    template: 'rnb-vault/password-reset',
    data: { resetUrl: 'https://example.com/reset' },
  });
  assert.equal(res.status, 200);
  assert.equal(delivered[0].subject, 'Reset your RnB Vault password');
});

// --- exact reject shapes ---

test('invalid JSON body → 400 "invalid JSON body" (after auth)', async () => {
  const { app } = makeHarness();
  const res = await app.request('/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
});

test('missing bearer token → 401 "missing bearer token"', async () => {
  const { app } = makeHarness();
  const res = await app.request('/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(BASE),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'missing bearer token' });
});

test('missing recipient / invalid recipient → 400 "invalid recipient"', async () => {
  const { app } = makeHarness();
  for (const to of [undefined, '', 'nonsense', 'a@b', 'a b@example.com']) {
    const res = await send(app, KEYS.normal, { ...BASE, to });
    assert.equal(res.status, 400, `to=${String(to)}`);
    assert.deepEqual(await res.json(), { error: 'invalid recipient' });
  }
});

test('missing subject → 400; missing html → 400 (in that order)', async () => {
  const { app } = makeHarness();
  const noSubject = await send(app, KEYS.normal, { tier: 'transactional', to: 'user@example.com' });
  assert.equal(noSubject.status, 400);
  assert.deepEqual(await noSubject.json(), { error: 'missing subject' });

  const noHtml = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.com',
    subject: 'Hi',
  });
  assert.equal(noHtml.status, 400);
  assert.deepEqual(await noHtml.json(), { error: 'missing html (or template)' });
});

// --- kill-switch: exact response AND exact log row ---

test('marketing suppressed: exact response shape and exact log row', async () => {
  const { app, logged, delivered } = makeHarness();
  const res = await send(app, KEYS.marketingOff, { ...BASE, tier: 'marketing' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, suppressed: true, reason: 'marketing_disabled' });
  assert.equal(delivered.length, 0);
  assert.deepEqual(logged, [
    {
      project_id: 'marketing-off',
      tier: 'marketing',
      template: undefined,
      recipient: 'user@example.com',
      subject: 'Hi',
      status: 'suppressed',
      suppress_reason: 'marketing_disabled',
    },
  ]);
});

test('hard_off: exact response shape and exact log row, both tiers', async () => {
  const { app, logged, delivered } = makeHarness();
  for (const tier of ['transactional', 'marketing']) {
    const res = await send(app, KEYS.hardOff, { ...BASE, tier });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'project is hard-off', suppressed: true });
  }
  assert.equal(delivered.length, 0);
  assert.deepEqual(logged, [
    {
      project_id: 'decommissioned',
      tier: 'transactional',
      template: undefined,
      recipient: 'user@example.com',
      subject: 'Hi',
      status: 'suppressed',
      suppress_reason: 'hard_off',
    },
    {
      project_id: 'decommissioned',
      tier: 'marketing',
      template: undefined,
      recipient: 'user@example.com',
      subject: 'Hi',
      status: 'suppressed',
      suppress_reason: 'hard_off',
    },
  ]);
});

// --- what reaches the provider ---

test('exact fields forwarded to sendEmail (from comes from the project row, not the body)', async () => {
  const { app, delivered } = makeHarness();
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    replyTo: 'reply@example.com',
    // deliberately present and deliberately ignored:
    fromEmail: 'attacker@example.com',
    fromName: 'Attacker',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(delivered, [
    {
      fromEmail: 'noreply@rnb-vault.example.com',
      fromName: 'rnb-vault display',
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      replyTo: 'reply@example.com',
    },
  ]);
});

test('success: exact response shape and exact log row', async () => {
  const { app, logged } = makeHarness();
  const res = await send(app, KEYS.normal, BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, messageId: 'char-message-id' });
  assert.deepEqual(logged, [
    {
      project_id: 'rnb-vault',
      tier: 'transactional',
      template: undefined,
      recipient: 'user@example.com',
      subject: 'Hi',
      status: 'sent',
      provider_message_id: 'char-message-id',
    },
  ]);
});

test('provider throws → 502 {error:"send failed"}, failed log row carries the provider message', async () => {
  const { app, logged } = makeHarness({
    sendEmail: async () => {
      throw new Error('MailerSend 422: recipient blocked');
    },
  });
  const res = await send(app, KEYS.normal, BASE);
  assert.equal(res.status, 502);
  // the provider message is logged but NOT returned to the caller
  assert.deepEqual(await res.json(), { error: 'send failed' });
  assert.deepEqual(logged, [
    {
      project_id: 'rnb-vault',
      tier: 'transactional',
      template: undefined,
      recipient: 'user@example.com',
      subject: 'Hi',
      status: 'failed',
      error: 'MailerSend 422: recipient blocked',
    },
  ]);
});

test('provider throws a non-Error → log records "unknown error"', async () => {
  const { app, logged } = makeHarness({
    sendEmail: async () => {
      throw 'boom';
    },
  });
  assert.equal((await send(app, KEYS.normal, BASE)).status, 502);
  assert.equal(logged[0].error, 'unknown error');
});

// --- template path details ---

test('a caller-supplied subject wins over the template subject; html/text always come from the template', async () => {
  const { app, logged, delivered } = makeHarness();
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.com',
    subject: 'Caller subject',
    html: '<p>caller html — discarded</p>',
    template: 'rnb-vault/password-reset',
    data: { resetUrl: 'https://example.com/reset' },
  });
  assert.equal(res.status, 200);
  assert.equal(delivered[0].subject, 'Caller subject');
  assert.notEqual(delivered[0].html, '<p>caller html — discarded</p>');
  assert.match(delivered[0].html, /https:\/\/example\.com\/reset/);
  assert.equal(logged[0].template, 'rnb-vault/password-reset');
  assert.equal(logged[0].subject, 'Caller subject');
});

test('template missing its required data → 400 with the template error message', async () => {
  const { app } = makeHarness();
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.com',
    template: 'rnb-vault/password-reset',
    data: {},
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "template 'rnb-vault/password-reset' requires data.resetUrl",
  });
});

// --- rate-limit bucket keys ---

test('requests without x-forwarded-for share the single "unknown" IP bucket', async () => {
  const { app } = makeHarness({ ipLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }) });
  assert.equal((await send(app, KEYS.normal, BASE)).status, 200);
  // a different caller, also without the header, is limited by the first one's spend
  assert.equal((await send(app, KEYS.marketingOff, BASE)).status, 429);
});

test('only the first x-forwarded-for hop keys the IP bucket', async () => {
  const { app } = makeHarness({ ipLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }) });
  assert.equal((await send(app, KEYS.normal, BASE, '203.0.113.1, 198.51.100.1')).status, 200);
  assert.equal((await send(app, KEYS.normal, BASE, '203.0.113.1, 198.51.100.2')).status, 429);
  assert.equal((await send(app, KEYS.normal, BASE, '203.0.113.2, 198.51.100.1')).status, 200);
});

// --- health ---

test('/health: {ok:true} when the DB answers, 503 {ok:false,db:"unreachable"} when it does not', async () => {
  const up = makeHarness();
  const upRes = await up.app.request('/health');
  assert.equal(upRes.status, 200);
  assert.deepEqual(await upRes.json(), { ok: true });

  const down = makeHarness({
    checkHealth: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const downRes = await down.app.request('/health');
  assert.equal(downRes.status, 503);
  assert.deepEqual(await downRes.json(), { ok: false, db: 'unreachable' });
});

// --- listUnsubscribe: a NEW optional field on /send, not legacy behaviour ---
// Everything above pins what /send already did. These cover the field added
// for the bulk work: absent behaves exactly as before, present is validated.

test('listUnsubscribe absent → the forwarded input is unchanged (no stray key)', async () => {
  const { app, delivered } = makeHarness();
  await send(app, KEYS.normal, BASE);
  assert.equal('listUnsubscribe' in delivered[0], false);
});

test('a valid listUnsubscribe is forwarded to the provider layer', async () => {
  const { app, delivered } = makeHarness();
  const value = '<https://example.com/u/abc>, <mailto:unsubscribe@example.com>';
  const res = await send(app, KEYS.normal, { ...BASE, listUnsubscribe: value });
  assert.equal(res.status, 200);
  assert.equal(delivered[0].listUnsubscribe, value);
});

test('a listUnsubscribe carrying CR/LF is rejected — it would split the header', async () => {
  const { app, delivered } = makeHarness();
  for (const bad of [
    '<https://example.com/u>\r\nBcc: x@example.com',
    '<https://example.com/u>\nX-Injected: 1',
    'a\u0000b',
    'a\u007Fb',
  ]) {
    const res = await send(app, KEYS.normal, { ...BASE, listUnsubscribe: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, /listUnsubscribe/);
  }
  assert.equal(delivered.length, 0);
});

test('listUnsubscribe must be a string and is capped at 990 characters', async () => {
  const { app } = makeHarness();
  const tooLong = `<https://example.com/${'x'.repeat(990)}>`;
  assert.equal((await send(app, KEYS.normal, { ...BASE, listUnsubscribe: 42 })).status, 400);
  assert.equal((await send(app, KEYS.normal, { ...BASE, listUnsubscribe: tooLong })).status, 400);
  assert.equal(
    (await send(app, KEYS.normal, { ...BASE, listUnsubscribe: 'y'.repeat(990) })).status,
    200,
  );
});

test('listUnsubscribe is validated before the kill-switch, like the other payload checks', async () => {
  const { app, logged } = makeHarness();
  const res = await send(app, KEYS.hardOff, { ...BASE, listUnsubscribe: 'a\rb' });
  assert.equal(res.status, 400);
  assert.equal(logged.length, 0);
});
