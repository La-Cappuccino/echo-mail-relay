// POST /send-bulk and GET /send-bulk/:bulkEmailId.
//
// The provider is always a fake injected through AppDeps — these tests never
// reach MailerSend. The properties under test are the ones a wrong answer
// would make expensive: one recipient can never see another's opt-out URL,
// and the relay never reports an outcome it cannot prove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp, MAX_BULK_BODY_BYTES, type AppDeps } from './app.js';
import type { Project, SendLogEntry } from './db.js';
import { MailerSendError, type BulkStatus, type MailerSendInput } from './mailersend.js';
import { RateLimiter } from './ratelimit.js';
import { renderRecipients } from './substitute.js';

const KEYS = {
  normal: 'b-normal-project',
  marketingOff: 'b-marketing-off',
  hardOff: 'b-hard-off',
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
  project('afrobeats', KEYS.normal),
  project('marketing-off', KEYS.marketingOff, { marketing_enabled: false }),
  project('decommissioned', KEYS.hardOff, { hard_off: true }),
];

// Which batches each project has on record. The status read must prove
// ownership from this before it will ask the provider anything.
const OWNED_BULK_IDS: Record<string, string[]> = {
  afrobeats: ['bulk-1', '614470d1588b866d0454f3e2', 'a_b-c', 'x'.repeat(64)],
  'marketing-off': ['bulk-mo'],
};

interface Harness {
  app: ReturnType<typeof createApp>;
  logged: SendLogEntry[][]; // one array per logSends() call
  batches: MailerSendInput[][]; // one array per sendBulkEmail() call
  statusReads: string[];
  ownershipChecks: [string, string][];
}

function makeHarness(overrides: Partial<AppDeps> = {}): Harness {
  const logged: SendLogEntry[][] = [];
  const batches: MailerSendInput[][] = [];
  const statusReads: string[] = [];
  const ownershipChecks: [string, string][] = [];
  const app = createApp({
    findProjectByKeyHash: async (hash) => PROJECTS.find((p) => p.api_key_hash === hash) ?? null,
    logSend: async () => {},
    logSends: async (entries) => {
      logged.push(entries);
    },
    sendEmail: async () => ({ messageId: 'single-id' }),
    sendBulkEmail: async (inputs) => {
      batches.push(inputs);
      return { bulkEmailId: 'bulk-1' };
    },
    ownsBulkId: async (projectId, id) => {
      ownershipChecks.push([projectId, id]);
      return (OWNED_BULK_IDS[projectId] ?? []).includes(id);
    },
    getBulkStatus: async (id): Promise<BulkStatus> => {
      statusReads.push(id);
      return { state: 'completed', validationErrorsCount: 0, suppressedCount: 0, raw: { data: {} } };
    },
    checkHealth: async () => {},
    ipLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    keyLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    bulkIpLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    bulkKeyLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    bulkLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    recipientLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    ...overrides,
  });
  return { app, logged, batches, statusReads, ownershipChecks };
}

function postBulk(app: Harness['app'], key: string | null, body: unknown, ip?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (ip) headers['x-forwarded-for'] = ip;
  return app.request('/send-bulk', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getStatus(app: Harness['app'], key: string | null, id: string, ip?: string) {
  const headers: Record<string, string> = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (ip) headers['x-forwarded-for'] = ip;
  return app.request(`/send-bulk/${id}`, { method: 'GET', headers });
}

const recipients = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    to: `r${i + 1}@example.com`,
    substitutions: { unsubscribe_url: `https://example.com/u/${i + 1}` },
  }));

const BASE = {
  tier: 'marketing',
  subject: 'Issue 1',
  html: '<p>hi</p><a href="{{unsubscribe_url}}">Stop</a>',
  text: 'hi — stop: {{unsubscribe_url}}',
  recipients: recipients(3),
};

async function expect400(res: Response, match?: RegExp) {
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  if (match) assert.match((await res.json()).error, match);
}

// --- happy path: the core safety property (C5) ---

test('3 recipients → one provider call with 3 objects, each carrying only its own URL', async () => {
  const { app, batches, logged } = makeHarness();
  const res = await postBulk(app, KEYS.normal, BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    bulkEmailId: 'bulk-1',
    accepted: 3,
    logged: true,
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  batches[0].forEach((email, i) => {
    const n = i + 1;
    assert.equal(email.to, `r${n}@example.com`);
    assert.equal(email.fromEmail, 'noreply@afrobeats.example.com'); // from the project row
    assert.equal(email.fromName, 'afrobeats display');
    assert.equal(email.subject, 'Issue 1');
    assert.equal(email.html.includes('{{'), false, 'no unsubstituted token may survive');
    assert.match(email.html, new RegExp(`https://example\\.com/u/${n}"`));
    assert.match(email.text ?? '', new RegExp(`https://example\\.com/u/${n}$`));
    for (const other of [1, 2, 3].filter((x) => x !== n)) {
      assert.equal(email.html.includes(`/u/${other}`), false, 'cross-recipient URL leak');
      assert.equal((email.text ?? '').includes(`/u/${other}`), false);
    }
  });

  // one ledger row per recipient, all carrying the bulk id
  assert.equal(logged.length, 1);
  assert.deepEqual(
    logged[0].map((e) => [e.project_id, e.tier, e.recipient, e.status, e.provider_message_id]),
    [
      ['afrobeats', 'marketing', 'r1@example.com', 'sent', 'bulk-1'],
      ['afrobeats', 'marketing', 'r2@example.com', 'sent', 'bulk-1'],
      ['afrobeats', 'marketing', 'r3@example.com', 'sent', 'bulk-1'],
    ],
  );
});

test('replyTo is forwarded; a template without tokens needs no substitutions', async () => {
  const { app, batches } = makeHarness();
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Plain',
    html: '<p>no tokens</p>',
    replyTo: 'reply@example.com',
    recipients: [{ to: 'a@example.com', substitutions: {} }],
  });
  assert.equal(res.status, 200);
  assert.equal(batches[0][0].replyTo, 'reply@example.com');
  assert.equal(batches[0][0].text, undefined);
});

// --- auth parity with /send ---

test('auth: missing token → 401, unknown key → 401, and nothing is sent', async () => {
  const { app, batches } = makeHarness();
  assert.equal((await postBulk(app, null, BASE)).status, 401);
  assert.equal((await postBulk(app, 'not-a-real-key', BASE)).status, 401);
  assert.equal(batches.length, 0);
});

test('auth: the bulk IP bucket is checked before auth, the bulk key bucket before the DB lookup', async () => {
  const noIp = makeHarness({ bulkIpLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }) });
  assert.equal((await postBulk(noIp.app, null, BASE, '203.0.113.5')).status, 429);

  let lookups = 0;
  const noKey = makeHarness({
    bulkKeyLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }),
    findProjectByKeyHash: async () => {
      lookups += 1;
      return null;
    },
  });
  assert.equal((await postBulk(noKey.app, 'not-a-real-key', BASE)).status, 429);
  assert.equal(lookups, 0);
});

test('auth beats payload validation — a bad key with a broken body still gets 401', async () => {
  const { app } = makeHarness();
  const res = await postBulk(app, 'not-a-real-key', { tier: 'transactional' });
  assert.equal(res.status, 401);
});

// --- validation (§3) ---

test('tier: only "marketing" is accepted', async () => {
  const { app, batches } = makeHarness();
  for (const tier of ['transactional', 'bulk', '', undefined, 1]) {
    await expect400(await postBulk(app, KEYS.normal, { ...BASE, tier }), /tier/);
  }
  assert.equal(batches.length, 0);
});

test('subject: required, 1..200 characters', async () => {
  const { app } = makeHarness();
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, subject: undefined }), /subject/);
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, subject: '' }), /subject/);
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, subject: 'x'.repeat(201) }), /subject/);
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, subject: 42 }), /subject/);
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, subject: 'x'.repeat(200) })).status, 200);
});

test('html: required and non-empty', async () => {
  const { app } = makeHarness();
  const noTokens = { ...BASE, text: undefined, recipients: [{ to: 'a@example.com', substitutions: {} }] };
  await expect400(await postBulk(app, KEYS.normal, { ...noTokens, html: undefined }), /html/);
  await expect400(await postBulk(app, KEYS.normal, { ...noTokens, html: '' }), /html/);
  await expect400(await postBulk(app, KEYS.normal, { ...noTokens, html: 42 }), /html/);
});

test('optional text / replyTo / listUnsubscribe must be strings of the right shape', async () => {
  const { app } = makeHarness();
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, text: 42 }), /text/);
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, replyTo: 'nonsense' }), /replyTo/);
  await expect400(await postBulk(app, KEYS.normal, { ...BASE, listUnsubscribe: 42 }), /listUnsubscribe/);
});

test('a control character in listUnsubscribe is rejected (header injection)', async () => {
  const { app, batches } = makeHarness();
  await expect400(
    await postBulk(app, KEYS.normal, {
      ...BASE,
      listUnsubscribe: '<https://example.com/u>\r\nBcc: x@example.com',
    }),
    /listUnsubscribe/,
  );
  assert.equal(batches.length, 0);
});

test('recipients: must be a non-empty array of at most 500', async () => {
  const { app, batches } = makeHarness();
  for (const bad of [undefined, [], {}, 'x', recipients(501)]) {
    await expect400(await postBulk(app, KEYS.normal, { ...BASE, recipients: bad }), /recipients/);
  }
  assert.equal(batches.length, 0);
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(500) })).status, 200);
});

test('recipients: every `to` must look like an email address', async () => {
  const { app } = makeHarness();
  for (const to of [undefined, '', 'nonsense', 'a@b', 42]) {
    await expect400(
      await postBulk(app, KEYS.normal, {
        ...BASE,
        recipients: [{ to, substitutions: { unsubscribe_url: 'https://example.com/u/1' } }],
      }),
      /recipient/,
    );
  }
});

test('recipients: duplicates by lower(to) → 400, nothing sent', async () => {
  const { app, batches } = makeHarness();
  for (const second of ['a@example.com', 'A@Example.com']) {
    await expect400(
      await postBulk(app, KEYS.normal, {
        ...BASE,
        recipients: [
          { to: 'a@example.com', substitutions: { unsubscribe_url: 'https://example.com/u/1' } },
          { to: second, substitutions: { unsubscribe_url: 'https://example.com/u/2' } },
        ],
      }),
      /duplicate/,
    );
  }
  assert.equal(batches.length, 0);
});

test('recipients: a whitespace-padded address is rejected as invalid before the dedup check', async () => {
  // The uniqueness key is lower(trim(to)), but EMAIL_RE rejects surrounding
  // whitespace outright — so a padded duplicate never reaches the dedup test.
  // Both paths are 400 with nothing sent; this pins which one answers.
  const { app, batches } = makeHarness();
  await expect400(
    await postBulk(app, KEYS.normal, {
      ...BASE,
      recipients: [
        { to: 'a@example.com', substitutions: { unsubscribe_url: 'https://example.com/u/1' } },
        { to: '  a@example.com  ', substitutions: { unsubscribe_url: 'https://example.com/u/2' } },
      ],
    }),
    /invalid recipient/,
  );
  assert.equal(batches.length, 0);
});

test('invalid JSON → 400, nothing sent', async () => {
  const { app, batches } = makeHarness();
  await expect400(await postBulk(app, KEYS.normal, '{not json'), /JSON/);
  assert.equal(batches.length, 0);
});

// --- substitution failures reach the caller as 400, never as a partial send ---

test('a token missing for ONE recipient → 400 and zero provider calls', async () => {
  const { app, batches } = makeHarness();
  await expect400(
    await postBulk(app, KEYS.normal, {
      ...BASE,
      recipients: [
        { to: 'a@example.com', substitutions: { unsubscribe_url: 'https://example.com/u/1' } },
        { to: 'b@example.com', substitutions: {} },
      ],
    }),
    /unsubscribe_url/,
  );
  assert.equal(batches.length, 0);
});

test('a javascript: value for a _url token → 400', async () => {
  const { app, batches } = makeHarness();
  await expect400(
    await postBulk(app, KEYS.normal, {
      ...BASE,
      recipients: [{ to: 'a@example.com', substitutions: { unsubscribe_url: 'javascript:alert(1)' } }],
    }),
    /https/,
  );
  assert.equal(batches.length, 0);
});

test('CR or LF inside a substitution value → 400', async () => {
  const { app, batches } = makeHarness();
  for (const bad of ['https://example.com/u/1\r\nX: y', 'line\nbreak']) {
    await expect400(
      await postBulk(app, KEYS.normal, {
        ...BASE,
        html: '<p>{{note}}</p>{{unsubscribe_url}}',
        text: undefined,
        recipients: [
          {
            to: 'a@example.com',
            substitutions: { unsubscribe_url: 'https://example.com/u/1', note: bad },
          },
        ],
      }),
    );
  }
  assert.equal(batches.length, 0);
});

test('a substitution value containing {{other}} is inserted literally, not expanded', async () => {
  const { app, batches } = makeHarness();
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'One pass',
    html: '{{note}}|{{unsubscribe_url}}',
    recipients: [
      {
        to: 'a@example.com',
        substitutions: { note: '{{unsubscribe_url}}', unsubscribe_url: 'https://example.com/u/1' },
      },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(batches[0][0].html, '{{unsubscribe_url}}|https://example.com/u/1');
});

test('a malformed token in the template → 400 before anything is sent', async () => {
  const { app, batches } = makeHarness();
  await expect400(
    await postBulk(app, KEYS.normal, { ...BASE, html: '<p>{{Unsubscribe_URL}}</p>', text: undefined }),
  );
  assert.equal(batches.length, 0);
});

// --- volume protection (C13) ---

test('body larger than 2 MB → 413, before parsing', async () => {
  const { app, batches } = makeHarness();
  const huge = JSON.stringify({ ...BASE, html: `<p>${'x'.repeat(2 * 1024 * 1024)}</p>` });
  const res = await postBulk(app, KEYS.normal, huge);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  assert.equal(batches.length, 0);
});

test('a declared content-length over the cap → 413 without reading the body', async () => {
  const { app } = makeHarness();
  const res = await app.request('/send-bulk', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEYS.normal}`,
      'content-type': 'application/json',
      'content-length': String(3 * 1024 * 1024),
    },
    body: JSON.stringify(BASE),
  });
  assert.equal(res.status, 413);
});

test('the bulk request limiter is separate from the /send limiter', async () => {
  const { app, batches } = makeHarness({
    bulkLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  const limited = await postBulk(app, KEYS.normal, BASE);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate limited' });
  assert.equal(batches.length, 2);

  // /send is unaffected — transactional mail must not be starved by newsletters
  const single = await app.request('/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 'transactional', to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' }),
  });
  assert.equal(single.status, 200);
});

test('the recipient budget is weighted per project and survives a key rotation', async () => {
  const { app, batches } = makeHarness({
    recipientLimiter: new RateLimiter({ capacity: 10, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(6) })).status, 200);
  const limited = await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(6) });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /recipient budget/);
  assert.equal(batches.length, 1); // the refused batch never reached the provider
  // what is left is still spendable
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(4) })).status, 200);
});

test('a refused batch spends no recipient budget', async () => {
  const { app } = makeHarness({
    recipientLimiter: new RateLimiter({ capacity: 5, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(6) })).status, 429);
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(5) })).status, 200);
});

// --- kill-switch (C4) ---

test('marketing_enabled=false → suppressed success-shape, nothing sent, every recipient logged', async () => {
  const { app, batches, logged } = makeHarness();
  const res = await postBulk(app, KEYS.marketingOff, BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, suppressed: true, reason: 'marketing_disabled' });
  assert.equal(batches.length, 0);
  assert.equal(logged[0].length, 3);
  assert.deepEqual(new Set(logged[0].map((e) => e.status)), new Set(['suppressed']));
  assert.deepEqual(new Set(logged[0].map((e) => e.suppress_reason)), new Set(['marketing_disabled']));
});

test('hard_off → 403 loud, nothing sent', async () => {
  const { app, batches, logged } = makeHarness();
  const res = await postBulk(app, KEYS.hardOff, BASE);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'project is hard-off', suppressed: true });
  assert.equal(batches.length, 0);
  assert.deepEqual(new Set(logged[0].map((e) => e.suppress_reason)), new Set(['hard_off']));
});

test('a suppressed call spends no recipient budget', async () => {
  const { app } = makeHarness({
    recipientLimiter: new RateLimiter({ capacity: 5, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.marketingOff, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(5) })).status, 200);
});

// --- outcome honesty (C7) ---

test('provider 4xx → 502 outcome "rejected", logged as failed', async () => {
  const { app, logged } = makeHarness({
    sendBulkEmail: async () => {
      throw new MailerSendError('MailerSend bulk 422: validation failed', 'rejected');
    },
  });
  const res = await postBulk(app, KEYS.normal, BASE);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.outcome, 'rejected');
  assert.match(json.error, /422/);
  assert.deepEqual(new Set(logged[0].map((e) => e.status)), new Set(['failed']));
});

test('provider 5xx / timeout / network error → 502 outcome "unknown"', async () => {
  for (const message of ['MailerSend bulk 503: upstream', 'MailerSend request failed: aborted']) {
    const { app, logged } = makeHarness({
      sendBulkEmail: async () => {
        throw new MailerSendError(message, 'unknown');
      },
    });
    const res = await postBulk(app, KEYS.normal, BASE);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).outcome, 'unknown');
    // the log row has to say so too — `sends.status` has no 'unknown' value
    assert.match(logged[0][0].error ?? '', /^outcome=unknown: /);
  }
});

test('an unexpected (non-MailerSendError) throw is treated as unknown, never as rejected', async () => {
  const { app } = makeHarness({
    sendBulkEmail: async () => {
      throw new TypeError('something else broke');
    },
  });
  const res = await postBulk(app, KEYS.normal, BASE);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).outcome, 'unknown');
});

test('provider accepted + logSends throws → still 200 ok with logged:false (never a false failure)', async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const { app, batches } = makeHarness({
      logSends: async () => {
        throw new Error('db down');
      },
    });
    const res = await postBulk(app, KEYS.normal, BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      bulkEmailId: 'bulk-1',
      accepted: 3,
      logged: false,
    });
    assert.equal(batches.length, 1);
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});

test('a log failure on the suppressed path still returns the suppressed shape', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { app } = makeHarness({
      logSends: async () => {
        throw new Error('db down');
      },
    });
    const res = await postBulk(app, KEYS.marketingOff, BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, suppressed: true, reason: 'marketing_disabled' });
  } finally {
    console.error = original;
  }
});

test('a log failure on the provider-failure path does not change the outcome', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { app } = makeHarness({
      sendBulkEmail: async () => {
        throw new MailerSendError('MailerSend bulk 422: nope', 'rejected');
      },
      logSends: async () => {
        throw new Error('db down');
      },
    });
    const res = await postBulk(app, KEYS.normal, BASE);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).outcome, 'rejected');
  } finally {
    console.error = original;
  }
});

// --- List-Unsubscribe (C14) ---

test('listUnsubscribe is substituted per recipient and handed to the provider layer', async () => {
  const { app, batches } = makeHarness();
  const res = await postBulk(app, KEYS.normal, {
    ...BASE,
    listUnsubscribe: '<{{unsubscribe_url}}>',
  });
  assert.equal(res.status, 200);
  // raw (not HTML-escaped) in a header value, and per-recipient
  assert.deepEqual(
    batches[0].map((e) => e.listUnsubscribe),
    ['<https://example.com/u/1>', '<https://example.com/u/2>', '<https://example.com/u/3>'],
  );
});

test('whether listUnsubscribe reaches MailerSend is the provider layer\'s flag, not the route\'s', async () => {
  // The route always passes the value down; mailersend.ts drops it unless
  // MAILERSEND_LIST_UNSUBSCRIBE=true (see mailersend.test.ts). Nothing here
  // claims a header is sent.
  const { app, batches } = makeHarness();
  await postBulk(app, KEYS.normal, BASE);
  assert.equal(batches[0][0].listUnsubscribe, undefined);
});

// --- GET /send-bulk/:bulkEmailId ---

test('status: same auth as the send route', async () => {
  const { app, statusReads } = makeHarness();
  assert.equal((await getStatus(app, null, 'bulk-1')).status, 401);
  assert.equal((await getStatus(app, 'not-a-real-key', 'bulk-1')).status, 401);
  assert.equal(statusReads.length, 0);
});

test('status: maps the provider payload through', async () => {
  const { app, statusReads } = makeHarness({
    getBulkStatus: async (id) => ({
      state: 'completed',
      validationErrorsCount: 2,
      suppressedCount: 1,
      raw: { data: { id } },
    }),
  });
  const res = await getStatus(app, KEYS.normal, 'bulk-1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    state: 'completed',
    validationErrorsCount: 2,
    suppressedCount: 1,
    raw: { data: { id: 'bulk-1' } },
  });
  assert.deepEqual(statusReads, []);
});

test('status: a malformed id is rejected before it can reach a provider URL', async () => {
  const { app, statusReads } = makeHarness();
  for (const id of ['a%2F..%2Fb', 'a.b', 'a%20b', 'x'.repeat(65), 'a!b', "a'b"]) {
    const res = await getStatus(app, KEYS.normal, id);
    assert.equal(res.status, 400, `id=${id}`);
    assert.match((await res.json()).error, /bulk email id/);
  }
  // A `..` segment (encoded or not) is normalised out of the URL, so it never
  // reaches the route at all — also safe, but a 404 rather than a 400.
  for (const id of ['..', '%2e%2e']) {
    assert.equal((await getStatus(app, KEYS.normal, id)).status, 404, `id=${id}`);
  }
  assert.equal(statusReads.length, 0);
});

test('status: a plain token id is accepted', async () => {
  const { app, statusReads } = makeHarness();
  for (const id of ['614470d1588b866d0454f3e2', 'a_b-c', 'x'.repeat(64)]) {
    assert.equal((await getStatus(app, KEYS.normal, id)).status, 200, id);
  }
  assert.deepEqual(statusReads, ['614470d1588b866d0454f3e2', 'a_b-c', 'x'.repeat(64)]);
});

test('status: provider failure → 502 carrying the outcome', async () => {
  for (const outcome of ['rejected', 'unknown'] as const) {
    const { app } = makeHarness({
      getBulkStatus: async () => {
        throw new MailerSendError('MailerSend bulk status 500: boom', outcome);
      },
    });
    const res = await getStatus(app, KEYS.normal, 'bulk-1');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).outcome, outcome);
  }
});

test('status: a hard-off project cannot read batches either', async () => {
  const { app, statusReads } = makeHarness();
  const res = await getStatus(app, KEYS.hardOff, 'bulk-1');
  assert.equal(res.status, 403);
  assert.equal(statusReads.length, 0);
});

// --- bulk must not starve transactional mail (Codex #1) ---

/** A single-send request, used to prove /send's buckets are untouched. */
function postSend(app: Harness['app'], key: string, ip?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  if (ip) headers['x-forwarded-for'] = ip;
  return app.request('/send', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tier: 'transactional',
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    }),
  });
}

test('draining the bulk pre-auth buckets leaves /send untouched', async () => {
  // Realistic shape: both routes given a 20-burst bucket, as in production.
  const { app } = makeHarness({
    ipLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    keyLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    bulkIpLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    bulkKeyLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    bulkLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 0 }),
  });
  const ip = '203.0.113.20';

  // 25 bulk attempts: the bulk pre-auth buckets empty at 20.
  let bulkLimited = 0;
  for (let i = 0; i < 25; i += 1) {
    if ((await postBulk(app, KEYS.normal, BASE, ip)).status === 429) bulkLimited += 1;
  }
  assert.ok(bulkLimited > 0, 'bulk should have been rate limited');

  // Auth mail from the same IP and the same key still goes out.
  assert.equal((await postSend(app, KEYS.normal, ip)).status, 200);
});

test('status polling drains only the bulk buckets', async () => {
  const { app } = makeHarness({
    ipLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    keyLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    bulkIpLimiter: new RateLimiter({ capacity: 5, refillPerSec: 0 }),
    bulkKeyLimiter: new RateLimiter({ capacity: 5, refillPerSec: 0 }),
  });
  const ip = '203.0.113.21';
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await getStatus(app, KEYS.normal, 'bulk-1', ip)).status, 200);
  }
  assert.equal((await getStatus(app, KEYS.normal, 'bulk-1', ip)).status, 429);
  assert.equal((await postSend(app, KEYS.normal, ip)).status, 200);
});

test('draining /send leaves bulk untouched', async () => {
  const { app } = makeHarness({
    ipLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
    keyLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
    bulkIpLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
    bulkKeyLimiter: new RateLimiter({ capacity: 20, refillPerSec: 0 }),
  });
  const ip = '203.0.113.22';
  assert.equal((await postSend(app, KEYS.normal, ip)).status, 200);
  assert.equal((await postSend(app, KEYS.normal, ip)).status, 200);
  assert.equal((await postSend(app, KEYS.normal, ip)).status, 429);

  assert.equal((await postBulk(app, KEYS.normal, BASE, ip)).status, 200);
});

// --- the 2 MB cap must bound buffering, not just measure it (Codex #2) ---

const CHUNK_BYTES = 64 * 1024;

/** A body with no content-length that can supply far more than the cap. */
function chunkedBody(maxChunks: number) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      if (state.pulled > maxChunks) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x78)); // 'x'
    },
  });
  return { stream, state };
}

test('a chunked body with no content-length is cut off the moment it passes the cap', async () => {
  const { app, batches } = makeHarness();
  const available = 200; // 12.8 MB if fully drained
  const { stream, state } = chunkedBody(available);

  const res = await app.request('/send-bulk', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: string });

  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  assert.equal(batches.length, 0);
  // The reader stopped early instead of buffering the whole source: the cap is
  // 2 MB, so it should have pulled ~33 of the 200 available chunks.
  assert.ok(state.pulled < available, `reader drained the whole source (pulled=${state.pulled})`);
  assert.ok(
    state.pulled <= MAX_BULK_BODY_BYTES / CHUNK_BYTES + 2,
    `reader over-buffered (pulled=${state.pulled})`,
  );
});

test('a chunked body under the cap is read in full', async () => {
  const { app } = makeHarness();
  const payload = JSON.stringify(BASE);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // deliberately split mid-document so reassembly is exercised
      const bytes = Buffer.from(payload, 'utf8');
      controller.enqueue(new Uint8Array(bytes.subarray(0, 10)));
      controller.enqueue(new Uint8Array(bytes.subarray(10)));
      controller.close();
    },
  });
  const res = await app.request('/send-bulk', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: string });
  assert.equal(res.status, 200);
});

test('a multi-byte character split across chunks survives reassembly', async () => {
  const { app, batches } = makeHarness();
  const payload = Buffer.from(
    JSON.stringify({
      ...BASE,
      text: undefined,
      html: '<p>Blåbærsyltetøy — æøå 🎧</p>{{unsubscribe_url}}',
    }),
    'utf8',
  );
  // split at a byte that lands inside a multi-byte sequence
  const cut = payload.indexOf(Buffer.from('🎧', 'utf8')) + 2;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(payload.subarray(0, cut)));
      controller.enqueue(new Uint8Array(payload.subarray(cut)));
      controller.close();
    },
  });
  const res = await app.request('/send-bulk', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEYS.normal}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: string });
  assert.equal(res.status, 200);
  assert.match(batches[0][0].html, /Blåbærsyltetøy — æøå 🎧/);
});

// --- substitution amplification (Codex #3) ---

/** A harness that counts how many times bodies were actually materialised. */
function harnessWithRenderSpy(overrides: Partial<AppDeps> = {}) {
  const calls: number[] = [];
  const h = makeHarness({
    renderBodies: (templates, validated) => {
      calls.push(validated.bags.length);
      return renderRecipients(templates, validated);
    },
    ...overrides,
  });
  return { ...h, renderCalls: calls };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(previous);
  }
}

/** ~1 MB of JSON describing ~1 GB of rendered output. */
const AMPLIFYING = {
  tier: 'marketing',
  subject: 'Boom',
  html: '{{unsubscribe_url}}'.repeat(1000),
  recipients: Array.from({ length: 500 }, (_, i) => ({
    to: `r${i + 1}@example.com`,
    substitutions: { unsubscribe_url: `https://example.com/${'x'.repeat(1960)}/${i + 1}` },
  })),
};

test('an amplifying payload is refused by size before a single body is built', async () => {
  const { app, batches, renderCalls } = harnessWithRenderSpy();
  const res = await postBulk(app, KEYS.normal, AMPLIFYING);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /rendered email exceeds/);
  assert.equal(renderCalls.length, 0, 'nothing may be rendered');
  assert.equal(batches.length, 0);
});

test('the per-email cap names the offending recipient', async () => {
  const { app } = withEnv({ BULK_MAX_RENDERED_EMAIL_BYTES: '200' }, () => harnessWithRenderSpy());
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Mixed',
    html: '{{note}}',
    recipients: [
      { to: 'a@example.com', substitutions: { note: 'short' } },
      { to: 'b@example.com', substitutions: { note: 'y'.repeat(300) } },
    ],
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /recipient 2/);
});

test('the batch total cap refuses a batch of individually-acceptable emails', async () => {
  const { app, renderCalls } = withEnv(
    { BULK_MAX_RENDERED_EMAIL_BYTES: '4096', BULK_MAX_RENDERED_TOTAL_BYTES: '5000' },
    () => harnessWithRenderSpy(),
  );
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Sum',
    html: '{{note}}',
    recipients: Array.from({ length: 10 }, (_, i) => ({
      to: `r${i + 1}@example.com`,
      substitutions: { note: 'z'.repeat(1000) },
    })),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /rendered batch exceeds/);
  assert.equal(renderCalls.length, 0);
});

test('a size-refused request spends NO recipient budget', async () => {
  const { app } = withEnv({ BULK_MAX_RENDERED_EMAIL_BYTES: '200' }, () =>
    harnessWithRenderSpy({ recipientLimiter: new RateLimiter({ capacity: 5, refillPerSec: 0 }) }),
  );
  const big = {
    tier: 'marketing',
    subject: 'Big',
    html: '{{note}}',
    recipients: [{ to: 'a@example.com', substitutions: { note: 'y'.repeat(300) } }],
  };
  assert.equal((await postBulk(app, KEYS.normal, big)).status, 413);
  // all 5 are still available
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(5) })).status, 200);
});

test('a suppressed request never materialises bodies', async () => {
  const { app, renderCalls } = harnessWithRenderSpy();
  assert.equal((await postBulk(app, KEYS.marketingOff, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.hardOff, BASE)).status, 403);
  assert.equal(renderCalls.length, 0);
});

test('a budget-refused request never materialises bodies', async () => {
  const { app, renderCalls } = harnessWithRenderSpy({
    recipientLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 429);
  assert.equal(renderCalls.length, 0);
});

test('a request that survives every gate renders exactly once, for every recipient', async () => {
  const { app, renderCalls } = harnessWithRenderSpy();
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  assert.deepEqual(renderCalls, [3]);
});

test('a suppressed request spends no bulk request slot either', async () => {
  // The request limiter sits after the kill-switch, so a project whose
  // marketing is off cannot burn its own send allowance by retrying.
  const { app } = makeHarness({ bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }) });
  assert.equal((await postBulk(app, KEYS.marketingOff, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 429);
});

test('a payload refused for size is refused for size, not mislabelled as a body-cap 413', async () => {
  const { app } = harnessWithRenderSpy();
  const res = await postBulk(app, KEYS.normal, AMPLIFYING);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.includes('body too large'), false);
});

// --- the status read must prove ownership (Codex #4) ---

test('a project cannot read another project\'s batch', async () => {
  const { app, statusReads } = makeHarness();
  // 'bulk-1' belongs to afrobeats; marketing-off holds a valid key of its own
  const res = await getStatus(app, KEYS.marketingOff, 'bulk-1');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
  assert.equal(statusReads.length, 0, 'the provider must not be asked at all');
});

test('an id that was never recorded → 404, no provider call', async () => {
  const { app, statusReads } = makeHarness();
  const res = await getStatus(app, KEYS.normal, 'never-seen-id');
  assert.equal(res.status, 404);
  assert.equal(statusReads.length, 0);
});

test('a project reads its own batch', async () => {
  const { app, statusReads, ownershipChecks } = makeHarness();
  assert.equal((await getStatus(app, KEYS.normal, 'bulk-1')).status, 200);
  assert.deepEqual(ownershipChecks, [['afrobeats', 'bulk-1']]);
  assert.deepEqual(statusReads, ['bulk-1']);
});

test('ownership is checked after the id shape, so a malformed id never hits the DB', async () => {
  const { app, ownershipChecks } = makeHarness();
  assert.equal((await getStatus(app, KEYS.normal, 'a!b')).status, 400);
  assert.equal(ownershipChecks.length, 0);
});

test('an ownership lookup failure fails closed, it does not fall through to the provider', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { app, statusReads } = makeHarness({
      ownsBulkId: async () => {
        throw new Error('db down');
      },
    });
    const res = await getStatus(app, KEYS.normal, 'bulk-1');
    assert.equal(res.status, 503);
    assert.equal(statusReads.length, 0);
  } finally {
    console.error = original;
  }
});

// --- a garbage numeric env must not disable the safeguard it configures ---
// (Codex round-2 #1). Each case sets the variable to something that used to
// become NaN/0/Infinity and asserts the limit is still ENFORCED at the route.

const GARBAGE = ['512KB', '', '0', '-5', 'NaN', '1e99'];

/** Silences the one warn line the env helper emits for an invalid value. */
function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

test('BULK_MAX_RENDERED_EMAIL_BYTES garbage → the 512 KB default still refuses an oversized email', async () => {
  for (const raw of GARBAGE) {
    const { app, batches } = quietly(() =>
      withEnv({ BULK_MAX_RENDERED_EMAIL_BYTES: raw }, () => harnessWithRenderSpy()),
    );
    // ~600 KB rendered — accepted while the cap was NaN, refused with the default
    const res = await postBulk(app, KEYS.normal, {
      tier: 'marketing',
      subject: 'Big',
      html: '{{note}}'.repeat(300),
      recipients: [{ to: 'a@example.com', substitutions: { note: 'x'.repeat(2000) } }],
    });
    assert.equal(res.status, 413, `BULK_MAX_RENDERED_EMAIL_BYTES=${JSON.stringify(raw)}`);
    assert.equal(batches.length, 0);
  }
});

test('BULK_MAX_RENDERED_TOTAL_BYTES garbage → the 32 MB default still refuses an oversized batch', async () => {
  for (const raw of GARBAGE) {
    const { app, batches } = quietly(() =>
      withEnv({ BULK_MAX_RENDERED_TOTAL_BYTES: raw }, () => harnessWithRenderSpy()),
    );
    // 500 × ~400 KB ≈ 200 MB total, each email under the 512 KB per-email cap
    const res = await postBulk(app, KEYS.normal, {
      tier: 'marketing',
      subject: 'Sum',
      html: '{{note}}'.repeat(200),
      recipients: Array.from({ length: 500 }, (_, i) => ({
        to: `r${i + 1}@example.com`,
        substitutions: { note: 'x'.repeat(2000) },
      })),
    });
    assert.equal(res.status, 413, `BULK_MAX_RENDERED_TOTAL_BYTES=${JSON.stringify(raw)}`);
    assert.equal(batches.length, 0);
  }
});

test('BULK_RECIPIENTS_PER_HOUR garbage → the 2000 default budget is still enforced', async () => {
  for (const raw of GARBAGE) {
    const { app } = quietly(() =>
      withEnv({ BULK_RECIPIENTS_PER_HOUR: raw }, () =>
        makeHarness({ recipientLimiter: undefined }),
      ),
    );
    // 2000 recipients of budget = four 500-recipient batches, then refused
    for (let i = 0; i < 4; i += 1) {
      const ok = await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(500) });
      assert.equal(ok.status, 200, `BULK_RECIPIENTS_PER_HOUR=${JSON.stringify(raw)} call ${i + 1}`);
    }
    const refused = await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(500) });
    assert.equal(refused.status, 429, `BULK_RECIPIENTS_PER_HOUR=${JSON.stringify(raw)}`);
  }
});

test('BULK_RATE_LIMIT_BURST garbage → the default 20-token pre-auth bucket is still enforced', async () => {
  for (const raw of ['512KB', '0', '-5', 'NaN']) {
    const { app } = quietly(() =>
      withEnv({ BULK_RATE_LIMIT_BURST: raw, BULK_RATE_LIMIT_PER_MINUTE: raw }, () =>
        makeHarness({ bulkIpLimiter: undefined, bulkKeyLimiter: undefined }),
      ),
    );
    const ip = '203.0.113.40';
    let limited = false;
    for (let i = 0; i < 25 && !limited; i += 1) {
      limited = (await postBulk(app, KEYS.normal, BASE, ip)).status === 429;
    }
    assert.ok(limited, `BULK_RATE_LIMIT_BURST=${JSON.stringify(raw)} should still rate limit`);
  }
});

test('a valid numeric env is honoured exactly, and logs nothing', async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const { app } = withEnv({ BULK_RECIPIENTS_PER_HOUR: '7' }, () =>
      makeHarness({ recipientLimiter: undefined }),
    );
    assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(7) })).status, 200);
    assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(1) })).status, 429);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logs, []);
});

// --- a size refusal must not spend a bulk request slot (round-2 #2) ---

const OVERSIZED = {
  tier: 'marketing',
  subject: 'Big',
  html: '{{note}}',
  recipients: [{ to: 'a@example.com', substitutions: { note: 'y'.repeat(300) } }],
};

test('a 413 spends no bulk request slot — the next valid request still goes through', async () => {
  const { app } = withEnv({ BULK_MAX_RENDERED_EMAIL_BYTES: '200' }, () =>
    harnessWithRenderSpy({ bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }) }),
  );
  assert.equal((await postBulk(app, KEYS.normal, OVERSIZED)).status, 413);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
});

test('a batch-total 413 spends no bulk request slot either', async () => {
  const { app } = withEnv({ BULK_MAX_RENDERED_TOTAL_BYTES: '100' }, () =>
    harnessWithRenderSpy({ bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }) }),
  );
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 413);
  const { app: fresh } = harnessWithRenderSpy({
    bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(fresh, KEYS.normal, BASE)).status, 200);
});

test('a budget refusal spends no bulk request slot', async () => {
  const { app } = harnessWithRenderSpy({
    bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }),
    recipientLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 429); // needs 3, has 1
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(1) })).status, 200);
});

test('a successful send still spends exactly one request slot and its recipients', async () => {
  const { app } = harnessWithRenderSpy({
    bulkLimiter: new RateLimiter({ capacity: 2, refillPerSec: 0 }),
    recipientLimiter: new RateLimiter({ capacity: 6, refillPerSec: 0 }),
  });
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
  assert.equal((await postBulk(app, KEYS.normal, { ...BASE, recipients: recipients(1) })).status, 429);
});

// --- substitution must not smuggle past the 990-char header cap (round-2 #3) ---

test('an expanded listUnsubscribe over 990 is refused, naming the recipient', async () => {
  const { app, batches, renderCalls } = harnessWithRenderSpy();
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Header',
    html: '<p>hi</p>',
    listUnsubscribe: '{{a}}',
    recipients: [
      { to: 'a@example.com', substitutions: { a: 'x'.repeat(10) } },
      { to: 'b@example.com', substitutions: { a: 'x'.repeat(2000) } },
    ],
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /listUnsubscribe/);
  assert.match(error, /recipient 2/);
  assert.equal(batches.length, 0);
  assert.equal(renderCalls.length, 0);
});

test('an expanded listUnsubscribe of exactly 990 passes; 991 does not', async () => {
  const body = (n: number) => ({
    tier: 'marketing',
    subject: 'Header',
    html: '<p>hi</p>',
    listUnsubscribe: '{{a}}',
    recipients: [{ to: 'a@example.com', substitutions: { a: 'x'.repeat(n) } }],
  });
  const { app, batches } = harnessWithRenderSpy();
  assert.equal((await postBulk(app, KEYS.normal, body(990))).status, 200);
  assert.equal(batches[0][0].listUnsubscribe?.length, 990);
  assert.equal((await postBulk(app, KEYS.normal, body(991))).status, 400);
});

test('the expanded-header refusal spends neither a request slot nor budget', async () => {
  const { app } = harnessWithRenderSpy({
    bulkLimiter: new RateLimiter({ capacity: 1, refillPerSec: 0 }),
    recipientLimiter: new RateLimiter({ capacity: 3, refillPerSec: 0 }),
  });
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Header',
    html: '<p>hi</p>',
    listUnsubscribe: '{{a}}',
    recipients: [{ to: 'a@example.com', substitutions: { a: 'x'.repeat(2000) } }],
  });
  assert.equal(res.status, 400);
  assert.equal((await postBulk(app, KEYS.normal, BASE)).status, 200);
});

test('a multi-token listUnsubscribe is measured expanded, not as a template', async () => {
  const { app } = harnessWithRenderSpy();
  const res = await postBulk(app, KEYS.normal, {
    tier: 'marketing',
    subject: 'Header',
    html: '<p>hi</p>',
    listUnsubscribe: '<{{a}}>, <{{b}}>',
    recipients: [
      {
        to: 'a@example.com',
        substitutions: { a: `https://example.com/${'x'.repeat(500)}`, b: `mailto:${'y'.repeat(500)}@example.com` },
      },
    ],
  });
  assert.equal(res.status, 400);
});
