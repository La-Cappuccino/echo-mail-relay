// Relay behavior tests — run with `npm test` (tsx + node:test, no DB needed).
// Covers: auth 401s, template namespace enforcement, the tiered kill-switch
// matrix (SPEC D4), and /send rate limiting (SPEC D2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp, type AppDeps } from './app.js';
import type { Project, SendLogEntry } from './db.js';
import { RateLimiter } from './ratelimit.js';

const KEYS = {
  normal: 'k-normal-project',
  marketingOff: 'k-marketing-off',
  hardOff: 'k-hard-off',
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function project(id: string, key: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    display_name: id,
    from_email: `noreply@${id}.no`,
    from_name: id,
    domain: `${id}.no`,
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
  sent: SendLogEntry[]; // logSend calls
  delivered: { to: string; subject: string }[]; // sendEmail calls
}

function makeHarness(overrides: Partial<AppDeps> = {}): Harness {
  const sent: SendLogEntry[] = [];
  const delivered: { to: string; subject: string }[] = [];
  const app = createApp({
    findProjectByKeyHash: async (hash) =>
      PROJECTS.find((p) => p.api_key_hash === hash) ?? null,
    logSend: async (entry) => {
      sent.push(entry);
    },
    sendEmail: async (input) => {
      delivered.push({ to: input.to, subject: input.subject });
      return { messageId: 'test-message-id' };
    },
    checkHealth: async () => {},
    // Generous defaults so ordinary tests never trip the limiter.
    ipLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    keyLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    ...overrides,
  });
  return { app, sent, delivered };
}

function send(app: Harness['app'], key: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return app.request('/send', { method: 'POST', headers, body: JSON.stringify(body) });
}

const BASE = { tier: 'transactional', to: 'user@example.no', subject: 'Hi', html: '<p>hi</p>' };

// --- auth ---

test('missing bearer token → 401', async () => {
  const { app, delivered } = makeHarness();
  const res = await send(app, null, BASE);
  assert.equal(res.status, 401);
  assert.equal(delivered.length, 0);
});

test('unknown project key → 401', async () => {
  const { app, delivered } = makeHarness();
  const res = await send(app, 'not-a-real-key', BASE);
  assert.equal(res.status, 401);
  assert.equal(delivered.length, 0);
});

// --- kill-switch matrix (SPEC D4) ---

test('normal project: transactional and marketing both send', async () => {
  const { app, sent, delivered } = makeHarness();
  for (const tier of ['transactional', 'marketing']) {
    const res = await send(app, KEYS.normal, { ...BASE, tier });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.messageId, 'test-message-id');
  }
  assert.equal(delivered.length, 2);
  assert.deepEqual(sent.map((s) => s.status), ['sent', 'sent']);
});

test('marketing_enabled=false: transactional still sends', async () => {
  const { app, sent, delivered } = makeHarness();
  const res = await send(app, KEYS.marketingOff, { ...BASE, tier: 'transactional' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(sent[0].status, 'sent');
});

test('marketing_enabled=false: marketing suppressed silently (success-shape, logged, not sent)', async () => {
  const { app, sent, delivered } = makeHarness();
  const res = await send(app, KEYS.marketingOff, { ...BASE, tier: 'marketing' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { ok: true, suppressed: true, reason: 'marketing_disabled' });
  assert.equal(delivered.length, 0);
  assert.equal(sent[0].status, 'suppressed');
  assert.equal(sent[0].suppress_reason, 'marketing_disabled');
});

test('hard_off: 403 loud for BOTH tiers, logged, nothing sent', async () => {
  const { app, sent, delivered } = makeHarness();
  for (const tier of ['transactional', 'marketing']) {
    const res = await send(app, KEYS.hardOff, { ...BASE, tier });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.suppressed, true);
    assert.equal(json.error, 'project is hard-off');
  }
  assert.equal(delivered.length, 0);
  assert.deepEqual(sent.map((s) => s.suppress_reason), ['hard_off', 'hard_off']);
});

// --- template namespace enforcement ---

test("template outside the caller's namespace → 403", async () => {
  const { app, delivered } = makeHarness();
  const res = await send(app, KEYS.marketingOff, {
    tier: 'transactional',
    to: 'user@example.no',
    template: 'rnb-vault/password-reset', // marketing-off project ≠ rnb-vault
    data: { resetUrl: 'https://example.no/reset' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /outside project namespace/);
  assert.equal(delivered.length, 0);
});

test('own-namespace template renders and sends', async () => {
  const { app, delivered } = makeHarness();
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.no',
    template: 'rnb-vault/password-reset',
    data: { resetUrl: 'https://example.no/reset' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].subject, 'Reset your RnB Vault password');
});

test('unknown template in own namespace → 400', async () => {
  const { app } = makeHarness();
  const res = await send(app, KEYS.normal, {
    tier: 'transactional',
    to: 'user@example.no',
    template: 'rnb-vault/no-such-template',
  });
  assert.equal(res.status, 400);
});

// --- rate limiting (SPEC D2) ---

test('per-IP bucket empties → 429', async () => {
  const { app, delivered } = makeHarness({
    ipLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
  });
  const headers = { 'x-forwarded-for': '203.0.113.7' };
  const req = () =>
    app.request('/send', {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
      body: JSON.stringify(BASE),
    });
  assert.equal((await req()).status, 200);
  assert.equal((await req()).status, 200);
  const limited = await req();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate limited' });
  assert.equal(delivered.length, 2);
});

test('per-key bucket empties → 429, other keys unaffected', async () => {
  const { app } = makeHarness({
    keyLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }),
  });
  assert.equal((await send(app, KEYS.normal, BASE)).status, 200);
  assert.equal((await send(app, KEYS.normal, BASE)).status, 429);
  // a different bearer key has its own bucket
  assert.equal((await send(app, KEYS.marketingOff, BASE)).status, 200);
});
