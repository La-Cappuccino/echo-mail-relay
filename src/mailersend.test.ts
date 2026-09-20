// Provider-client tests. `fetch` is always stubbed — these never touch
// MailerSend. The single-send cases are characterization (R1): they pin the
// 202-with-no-body and x-send-paused handling that hid the Brevo outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailersendSend } from './mailersend.js';

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

function withApiKey<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env[API_KEY_ENV];
  if (value === undefined) delete process.env[API_KEY_ENV];
  else process.env[API_KEY_ENV] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previous;
  }
}

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
