// Provider-client tests. `fetch` is always stubbed — these never touch
// MailerSend. The single-send cases are characterization (R1): they pin the
// 202-with-no-body and x-send-paused handling that hid the Brevo outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBulkStatus,
  MailerSendError,
  mailersendSend,
  sendBulkEmail,
} from './mailersend.js';

const realFetch = globalThis.fetch;

interface StubCall {
  url: string;
  init: RequestInit;
}

/** Replace global fetch with a canned response; returns the captured calls. */
function stubFetch(respond: (call: StubCall) => Response): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

const API_KEY_ENV = 'MAILERSEND_API_KEY';
const LIST_UNSUBSCRIBE_ENV = 'MAILERSEND_LIST_UNSUBSCRIBE';

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}

const withApiKey = <T>(value: string | undefined, fn: () => Promise<T>) =>
  withEnv({ [API_KEY_ENV]: value }, fn);

const INPUT = {
  fromEmail: 'noreply@example.com',
  fromName: 'Example',
  to: 'user@example.com',
  subject: 'Hi',
  html: '<p>hi</p>',
};

test('missing API key → throws before any network call', async () => {
  const calls = stubFetch(() => new Response(null, { status: 202 }));
  try {
    await withApiKey(undefined, async () => {
      await assert.rejects(mailersendSend(INPUT), /MAILERSEND_API_KEY not configured/);
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('202 with x-message-id → messageId; request body and headers are as expected', async () => {
  const calls = stubFetch(
    () => new Response(null, { status: 202, headers: { 'x-message-id': 'msg-1' } }),
  );
  try {
    const result = await withApiKey('test-key', () =>
      mailersendSend({ ...INPUT, text: 'hi', replyTo: 'reply@example.com' }),
    );
    assert.deepEqual(result, { messageId: 'msg-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.mailersend.com/v1/email');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      from: { email: 'noreply@example.com', name: 'Example' },
      to: [{ email: 'user@example.com' }],
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      reply_to: { email: 'reply@example.com' },
    });
  } finally {
    restoreFetch();
  }
});

test('optional fields are omitted from the provider body, not sent as undefined', async () => {
  const calls = stubFetch(
    () => new Response(null, { status: 202, headers: { 'x-message-id': 'msg-2' } }),
  );
  try {
    await withApiKey('test-key', () => mailersendSend(INPUT));
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal('text' in body, false);
    assert.equal('reply_to' in body, false);
  } finally {
    restoreFetch();
  }
});

test('202 without x-message-id → empty-string messageId (no throw)', async () => {
  stubFetch(() => new Response(null, { status: 202 }));
  try {
    const result = await withApiKey('test-key', () => mailersendSend(INPUT));
    assert.deepEqual(result, { messageId: '' });
  } finally {
    restoreFetch();
  }
});

test('x-send-paused: true on a 202 → throws (nothing was actually sent)', async () => {
  stubFetch(
    () =>
      new Response(null, {
        status: 202,
        headers: { 'x-message-id': 'msg-3', 'x-send-paused': 'true' },
      }),
  );
  try {
    await withApiKey('test-key', async () => {
      await assert.rejects(mailersendSend(INPUT), /account or domain is paused/);
    });
  } finally {
    restoreFetch();
  }
});

test('non-2xx → throws "MailerSend <status>: <body>", body truncated to 500 chars', async () => {
  stubFetch(() => new Response('x'.repeat(900), { status: 422 }));
  try {
    await withApiKey('test-key', async () => {
      await assert.rejects(mailersendSend(INPUT), (err: Error) => {
        assert.equal(err.message, `MailerSend 422: ${'x'.repeat(500)}`);
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

// --- bulk send (R2) ---

const BULK_URL = 'https://api.mailersend.com/v1/bulk-email';

const accepted = (id = 'bulk-1') =>
  new Response(JSON.stringify({ message: 'The bulk email is being processed.', bulk_email_id: id }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });

async function bulkWithStub(
  respond: (call: StubCall) => Response | Promise<Response>,
  inputs = [INPUT],
  env: Record<string, string | undefined> = {},
) {
  const calls = stubFetch(respond as (call: StubCall) => Response);
  try {
    const result = await withEnv({ [API_KEY_ENV]: 'test-key', ...env }, () => sendBulkEmail(inputs));
    return { result, calls };
  } finally {
    restoreFetch();
  }
}

async function bulkRejects(
  respond: (call: StubCall) => Response | Promise<Response>,
  outcome: 'rejected' | 'unknown',
  inputs = [INPUT],
) {
  stubFetch(respond as (call: StubCall) => Response);
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key' }, async () => {
      await assert.rejects(sendBulkEmail(inputs), (err: Error) => {
        assert.ok(err instanceof MailerSendError, `expected MailerSendError, got ${err}`);
        assert.equal(err.outcome, outcome, err.message);
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
}

test('bulk: 202 → bulkEmailId; one POST with an array of fully rendered email objects', async () => {
  const { result, calls } = await bulkWithStub(() => accepted('bulk-abc'), [
    { ...INPUT, text: 'hi', replyTo: 'reply@example.com' },
    { ...INPUT, to: 'second@example.com', subject: 'Hi 2', html: '<p>hi 2</p>' },
  ]);
  assert.deepEqual(result, { bulkEmailId: 'bulk-abc' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BULK_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), [
    {
      from: { email: 'noreply@example.com', name: 'Example' },
      to: [{ email: 'user@example.com' }],
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      reply_to: { email: 'reply@example.com' },
    },
    {
      from: { email: 'noreply@example.com', name: 'Example' },
      to: [{ email: 'second@example.com' }],
      subject: 'Hi 2',
      html: '<p>hi 2</p>',
    },
  ]);
});

test('bulk: no MailerSend personalization is used — each object carries its own rendered body', async () => {
  const { calls } = await bulkWithStub(() => accepted(), [
    { ...INPUT, html: '<a href="https://example.com/u/1">x</a>' },
    { ...INPUT, to: 'b@example.com', html: '<a href="https://example.com/u/2">x</a>' },
  ]);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal('personalization' in body[0], false);
  assert.equal(body[0].html.includes('/u/2'), false);
  assert.equal(body[1].html.includes('/u/1'), false);
});

test('bulk: an empty input array never reaches the provider', async () => {
  const calls = stubFetch(() => accepted());
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key' }, async () => {
      await assert.rejects(sendBulkEmail([]), MailerSendError);
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('bulk: missing API key → rejected (provably nothing sent), no network call', async () => {
  const calls = stubFetch(() => accepted());
  try {
    await withEnv({ [API_KEY_ENV]: undefined }, async () => {
      await assert.rejects(sendBulkEmail([INPUT]), (err: Error) => {
        assert.ok(err instanceof MailerSendError);
        assert.equal(err.outcome, 'rejected');
        return true;
      });
    });
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('bulk: provider 4xx → rejected; the status and body reach the message', async () => {
  stubFetch(() => new Response('{"message":"validation failed"}', { status: 422 }));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key' }, async () => {
      await assert.rejects(sendBulkEmail([INPUT]), (err: Error) => {
        assert.ok(err instanceof MailerSendError);
        assert.equal(err.outcome, 'rejected');
        assert.match(err.message, /422/);
        assert.match(err.message, /validation failed/);
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

test('bulk: every 4xx is rejected and every 5xx is unknown', async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    await bulkRejects(() => new Response('nope', { status }), 'rejected');
  }
  for (const status of [500, 502, 503, 504]) {
    await bulkRejects(() => new Response('boom', { status }), 'unknown');
  }
});

test('bulk: a network error → unknown (it may or may not have been sent)', async () => {
  await bulkRejects(() => {
    throw new TypeError('fetch failed');
  }, 'unknown');
});

test('bulk: an aborted request → unknown, and the 15s timeout signal is passed to fetch', async () => {
  let sawSignal = false;
  await bulkRejects((call) => {
    sawSignal = call.init.signal instanceof AbortSignal;
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  }, 'unknown');
  assert.equal(sawSignal, true);
});

test('bulk: x-send-paused → rejected (the account is paused, so nothing went out)', async () => {
  await bulkRejects(
    () =>
      new Response(JSON.stringify({ bulk_email_id: 'bulk-x' }), {
        status: 202,
        headers: { 'content-type': 'application/json', 'x-send-paused': 'true' },
      }),
    'rejected',
  );
});

test('bulk: accepted but no bulk_email_id (or unparseable body) → unknown, never a fake id', async () => {
  await bulkRejects(() => new Response('{}', { status: 202 }), 'unknown');
  await bulkRejects(() => new Response('not json', { status: 202 }), 'unknown');
  await bulkRejects(() => new Response(JSON.stringify({ bulk_email_id: 42 }), { status: 202 }), 'unknown');
});

// --- List-Unsubscribe flag (AM1) ---

test('listUnsubscribe is dropped from the provider body while the flag is off (default)', async () => {
  const input = { ...INPUT, listUnsubscribe: '<https://example.com/u/1>, <mailto:u@example.com>' };
  for (const flag of [undefined, 'false', 'TRUE', '1', 'yes']) {
    const { calls } = await bulkWithStub(() => accepted(), [input], {
      [LIST_UNSUBSCRIBE_ENV]: flag,
    });
    assert.equal('list_unsubscribe' in JSON.parse(String(calls[0].init.body))[0], false, String(flag));
  }
});

test('listUnsubscribe reaches the provider only when the flag is exactly "true"', async () => {
  const { calls } = await bulkWithStub(
    () => accepted(),
    [{ ...INPUT, listUnsubscribe: '<https://example.com/u/1>' }],
    { [LIST_UNSUBSCRIBE_ENV]: 'true' },
  );
  assert.equal(
    JSON.parse(String(calls[0].init.body))[0].list_unsubscribe,
    '<https://example.com/u/1>',
  );
});

test('single send: same flag rule — off by default, forwarded when on', async () => {
  const input = { ...INPUT, listUnsubscribe: '<https://example.com/u/1>' };
  const off = stubFetch(() => new Response(null, { status: 202, headers: { 'x-message-id': 'm' } }));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [LIST_UNSUBSCRIBE_ENV]: undefined }, () =>
      mailersendSend(input),
    );
    assert.equal('list_unsubscribe' in JSON.parse(String(off[0].init.body)), false);
  } finally {
    restoreFetch();
  }

  const on = stubFetch(() => new Response(null, { status: 202, headers: { 'x-message-id': 'm' } }));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [LIST_UNSUBSCRIBE_ENV]: 'true' }, () =>
      mailersendSend(input),
    );
    assert.equal(JSON.parse(String(on[0].init.body)).list_unsubscribe, '<https://example.com/u/1>');
  } finally {
    restoreFetch();
  }
});

// --- bulk status read ---

const STATUS_PAYLOAD = {
  data: {
    id: 'bulk-1',
    state: 'completed',
    total_recipients_count: 3,
    suppressed_recipients_count: 1,
    suppressed_recipients: null,
    validation_errors_count: 2,
    validation_errors: null,
    messages_id: "['m1']",
  },
};

test('status: maps state, validation errors and suppressed count, and keeps the raw payload', async () => {
  const calls = stubFetch(
    () => new Response(JSON.stringify(STATUS_PAYLOAD), { status: 200 }),
  );
  try {
    const status = await withEnv({ [API_KEY_ENV]: 'test-key' }, () => getBulkStatus('bulk-1'));
    assert.equal(calls[0].url, `${BULK_URL}/bulk-1`);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(status.state, 'completed');
    assert.equal(status.validationErrorsCount, 2);
    assert.equal(status.suppressedCount, 1);
    assert.deepEqual(status.raw, STATUS_PAYLOAD);
  } finally {
    restoreFetch();
  }
});

test('status: absent counts default to 0 and an absent state reads "unknown"', async () => {
  stubFetch(() => new Response(JSON.stringify({ data: { id: 'bulk-1' } }), { status: 200 }));
  try {
    const status = await withEnv({ [API_KEY_ENV]: 'test-key' }, () => getBulkStatus('bulk-1'));
    assert.equal(status.state, 'unknown');
    assert.equal(status.validationErrorsCount, 0);
    assert.equal(status.suppressedCount, 0);
  } finally {
    restoreFetch();
  }
});

test('status: the id is URL-encoded into the provider path', async () => {
  const calls = stubFetch(() => new Response(JSON.stringify(STATUS_PAYLOAD), { status: 200 }));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key' }, () => getBulkStatus('a/../b'));
    assert.equal(calls[0].url, `${BULK_URL}/a%2F..%2Fb`);
  } finally {
    restoreFetch();
  }
});

test('status: 404 → rejected, 500 → unknown, network error → unknown', async () => {
  for (const [respond, outcome] of [
    [() => new Response('missing', { status: 404 }), 'rejected'],
    [() => new Response('boom', { status: 500 }), 'unknown'],
    [
      () => {
        throw new TypeError('fetch failed');
      },
      'unknown',
    ],
  ] as const) {
    stubFetch(respond as () => Response);
    try {
      await withEnv({ [API_KEY_ENV]: 'test-key' }, async () => {
        await assert.rejects(getBulkStatus('bulk-1'), (err: Error) => {
          assert.ok(err instanceof MailerSendError);
          assert.equal(err.outcome, outcome);
          return true;
        });
      });
    } finally {
      restoreFetch();
    }
  }
});

// --- the deadline must cover the body, not just the headers (Codex #5) ---

const TIMEOUT_ENV = 'MAILERSEND_TIMEOUT_MS';

/** Headers arrive, then the body never does — until the request is aborted. */
function stallingBody(status: number) {
  return (call: StubCall): Response => {
    const signal = call.init.signal as AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () =>
          controller.error(Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          }));
        if (!signal) return; // no signal → the stream really would hang
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      },
    });
    return new Response(stream, { status });
  };
}

test('a 2xx whose body stalls aborts and classifies as unknown — it may have been accepted', async () => {
  stubFetch(stallingBody(202));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [TIMEOUT_ENV]: '50' }, async () => {
      await assert.rejects(sendBulkEmail([INPUT]), (err: Error) => {
        assert.ok(err instanceof MailerSendError);
        assert.equal(err.outcome, 'unknown', 'a 2xx that stalled must never be "rejected"');
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

test('a 4xx whose body stalls is still rejected — the status line is proof enough', async () => {
  stubFetch(stallingBody(422));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [TIMEOUT_ENV]: '50' }, async () => {
      await assert.rejects(sendBulkEmail([INPUT]), (err: Error) => {
        assert.ok(err instanceof MailerSendError);
        assert.equal(err.outcome, 'rejected');
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

test('a 5xx whose body stalls stays unknown', async () => {
  stubFetch(stallingBody(503));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [TIMEOUT_ENV]: '50' }, async () => {
      await assert.rejects(sendBulkEmail([INPUT]), (err: Error) => {
        assert.equal((err as MailerSendError).outcome, 'unknown');
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

test('the status read is bounded by the same deadline', async () => {
  stubFetch(stallingBody(200));
  try {
    await withEnv({ [API_KEY_ENV]: 'test-key', [TIMEOUT_ENV]: '50' }, async () => {
      await assert.rejects(getBulkStatus('bulk-1'), (err: Error) => {
        assert.ok(err instanceof MailerSendError);
        assert.equal(err.outcome, 'unknown');
        return true;
      });
    });
  } finally {
    restoreFetch();
  }
});

test('a normal response still resolves well inside the deadline', async () => {
  stubFetch(() => accepted('bulk-ok'));
  try {
    const result = await withEnv({ [API_KEY_ENV]: 'test-key', [TIMEOUT_ENV]: '2000' }, () =>
      sendBulkEmail([INPUT]),
    );
    assert.deepEqual(result, { bulkEmailId: 'bulk-ok' });
  } finally {
    restoreFetch();
  }
});
