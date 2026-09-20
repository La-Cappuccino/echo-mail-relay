// POST /send-bulk and GET /send-bulk/:bulkEmailId.
//
// The provider is always a fake injected through AppDeps — these tests never
// reach MailerSend. The properties under test are the ones a wrong answer
// would make expensive: one recipient can never see another's opt-out URL,
// and the relay never reports an outcome it cannot prove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp, type AppDeps } from './app.js';
import type { Project, SendLogEntry } from './db.js';
import { MailerSendError, type BulkStatus, type MailerSendInput } from './mailersend.js';
import { RateLimiter } from './ratelimit.js';

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

interface Harness {
  app: ReturnType<typeof createApp>;
  logged: SendLogEntry[][]; // one array per logSends() call
  batches: MailerSendInput[][]; // one array per sendBulkEmail() call
  statusReads: string[];
}

function makeHarness(overrides: Partial<AppDeps> = {}): Harness {
  const logged: SendLogEntry[][] = [];
  const batches: MailerSendInput[][] = [];
  const statusReads: string[] = [];
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
    getBulkStatus: async (id): Promise<BulkStatus> => {
      statusReads.push(id);
      return { state: 'completed', validationErrorsCount: 0, suppressedCount: 0, raw: { data: {} } };
    },
    checkHealth: async () => {},
    ipLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    keyLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    bulkLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    recipientLimiter: new RateLimiter({ capacity: 100_000, refillPerSec: 100_000 }),
    ...overrides,
  });
  return { app, logged, batches, statusReads };
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

function getStatus(app: Harness['app'], key: string | null, id: string) {
  const headers: Record<string, string> = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
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

test('auth: the IP bucket is checked before auth, the key bucket before the DB lookup', async () => {
  const noIp = makeHarness({ ipLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }) });
  assert.equal((await postBulk(noIp.app, null, BASE, '203.0.113.5')).status, 429);

  let lookups = 0;
  const noKey = makeHarness({
    keyLimiter: new RateLimiter({ capacity: 0, refillPerSec: 0 }),
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
