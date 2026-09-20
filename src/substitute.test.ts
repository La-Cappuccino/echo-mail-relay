import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTokens, renderRecipients, SubstitutionError } from './substitute.js';

const HTML = '<a href="{{unsubscribe_url}}">Stop</a>';

function recipient(url: string, extra: Record<string, string> = {}) {
  return { substitutions: { unsubscribe_url: url, ...extra } };
}

// --- token collection ---

test('collects tokens from html, text and listUnsubscribe, sorted and deduped', () => {
  assert.deepEqual(
    collectTokens({
      html: '{{b}} {{a}} {{b}}',
      text: '{{c}}',
      listUnsubscribe: '<{{a}}>',
    }),
    ['a', 'b', 'c'],
  );
});

test('templates without tokens collect nothing', () => {
  assert.deepEqual(collectTokens({ html: '<p>hi</p>' }), []);
});

test('a token-shaped sequence that breaks the key grammar is rejected, not passed through', () => {
  for (const html of ['{{Foo}}', '{{ bar }}', '{{1abc}}', '{{a-b}}', `{{${'x'.repeat(41)}}}`, '{{}}']) {
    assert.throws(() => collectTokens({ html }), SubstitutionError, html);
  }
});

test('an unbalanced or nested {{ is rejected (no literal {{ may survive)', () => {
  for (const html of ['{{a{{b}}', 'trailing {{', '{{a}} then {{']) {
    assert.throws(() => collectTokens({ html }), SubstitutionError, html);
  }
});

// --- required-for-every-recipient ---

test('every token must be supplied by every recipient; a single gap renders nothing', () => {
  assert.throws(
    () =>
      renderRecipients({ html: HTML }, [
        recipient('https://example.com/u/1'),
        { substitutions: {} },
      ]),
    (err: Error) => {
      assert.ok(err instanceof SubstitutionError);
      assert.match(err.message, /recipient 2/);
      assert.match(err.message, /unsubscribe_url/);
      return true;
    },
  );
});

test('a token used only in text must still be supplied', () => {
  assert.throws(
    () => renderRecipients({ html: '<p>hi</p>', text: '{{name}}' }, [{ substitutions: {} }]),
    SubstitutionError,
  );
});

test('a token used only in listUnsubscribe must still be supplied', () => {
  assert.throws(
    () =>
      renderRecipients({ html: '<p>hi</p>', listUnsubscribe: '<{{unsubscribe_url}}>' }, [
        { substitutions: {} },
      ]),
    SubstitutionError,
  );
});

// --- rendering ---

test('each recipient gets only its own value; no {{ survives', () => {
  const out = renderRecipients({ html: HTML, text: 'Stop: {{unsubscribe_url}}' }, [
    recipient('https://example.com/u/1'),
    recipient('https://example.com/u/2'),
    recipient('https://example.com/u/3'),
  ]);
  assert.equal(out.length, 3);
  out.forEach((r, i) => {
    assert.equal(r.html, `<a href="https://example.com/u/${i + 1}">Stop</a>`);
    assert.equal(r.text, `Stop: https://example.com/u/${i + 1}`);
    assert.equal(r.html.includes('{{'), false);
    for (const other of [1, 2, 3].filter((n) => n !== i + 1)) {
      assert.equal(r.html.includes(`/u/${other}`), false);
    }
  });
});

test('values are HTML-escaped into html but raw into text and listUnsubscribe', () => {
  const [out] = renderRecipients(
    { html: '<p>{{name}}</p>', text: '{{name}}', listUnsubscribe: '{{name}}' },
    [{ substitutions: { name: `Ada & <b>"Bob"</b> 'x'` } }],
  );
  assert.equal(out.html, `<p>Ada &amp; &lt;b&gt;&quot;Bob&quot;&lt;/b&gt; &#39;x&#39;</p>`);
  assert.equal(out.text, `Ada & <b>"Bob"</b> 'x'`);
  assert.equal(out.listUnsubscribe, `Ada & <b>"Bob"</b> 'x'`);
});

test('one pass only: a value containing {{other}} is not expanded', () => {
  const [out] = renderRecipients({ html: '{{a}}|{{b}}', text: '{{a}}' }, [
    { substitutions: { a: '{{b}}', b: 'REAL' } },
  ]);
  assert.equal(out.html, '{{b}}|REAL');
  assert.equal(out.text, '{{b}}');
});

test('a token repeated in a template is replaced everywhere', () => {
  const [out] = renderRecipients({ html: '{{a}}-{{a}}-{{a}}' }, [{ substitutions: { a: 'x' } }]);
  assert.equal(out.html, 'x-x-x');
});

test('optional text and listUnsubscribe stay absent when not supplied', () => {
  const [out] = renderRecipients({ html: HTML }, [recipient('https://example.com/u/1')]);
  assert.equal(out.text, undefined);
  assert.equal(out.listUnsubscribe, undefined);
});

test('a $-bearing value is inserted literally (no replacement-pattern expansion)', () => {
  const [out] = renderRecipients({ html: '[{{a}}]', text: '[{{a}}]' }, [
    { substitutions: { a: "$' $` $& $1 $$" } },
  ]);
  assert.equal(out.text, "[$' $` $& $1 $$]");
});

// --- value validation ---

test('_url keys must be https: — anything else is rejected', () => {
  for (const bad of [
    'javascript:alert(1)',
    'http://example.com/u/1',
    'data:text/html,x',
    'HTTP://example.com',
    '/relative/path',
    'example.com',
    '',
  ]) {
    assert.throws(() => renderRecipients({ html: HTML }, [recipient(bad)]), SubstitutionError, bad);
  }
});

test('_url keys accept an https URL', () => {
  const [out] = renderRecipients({ html: HTML }, [
    recipient('https://example.com/u/1?t=abc&x=1'),
  ]);
  assert.match(out.html, /https:\/\/example\.com\/u\/1/);
});

test('control characters in any value are rejected (CR, LF, NUL, DEL, tab)', () => {
  for (const bad of ['a\rb', 'a\nb', 'a\u0000b', 'a\u007Fb', 'a\tb']) {
    assert.throws(
      () => renderRecipients({ html: '{{a}}' }, [{ substitutions: { a: bad } }]),
      SubstitutionError,
      JSON.stringify(bad),
    );
  }
});

test('a control character in a listUnsubscribe value is rejected (header injection)', () => {
  assert.throws(
    () =>
      renderRecipients({ html: '<p>hi</p>', listUnsubscribe: '<{{u}}>' }, [
        { substitutions: { u: 'https://example.com\r\nBcc: x@example.com' } },
      ]),
    SubstitutionError,
  );
});

test('a value longer than 2000 chars is rejected; exactly 2000 is accepted', () => {
  const ok = 'x'.repeat(2000);
  assert.doesNotThrow(() => renderRecipients({ html: '{{a}}' }, [{ substitutions: { a: ok } }]));
  assert.throws(
    () => renderRecipients({ html: '{{a}}' }, [{ substitutions: { a: ok + 'x' } }]),
    SubstitutionError,
  );
});

test('more than 10 substitution keys for one recipient is rejected; exactly 10 is accepted', () => {
  const keys = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
  assert.doesNotThrow(() => renderRecipients({ html: '{{k0}}' }, [{ substitutions: keys(10) }]));
  assert.throws(
    () => renderRecipients({ html: '{{k0}}' }, [{ substitutions: keys(11) }]),
    SubstitutionError,
  );
});

test('a non-string value is rejected — never coerced', () => {
  for (const bad of [1, null, true, ['x'], { a: 1 }, undefined]) {
    assert.throws(
      () => renderRecipients({ html: '{{a}}' }, [{ substitutions: { a: bad } as never }]),
      SubstitutionError,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('a supplied key that cannot be a token is rejected', () => {
  assert.throws(
    () => renderRecipients({ html: '{{a}}' }, [{ substitutions: { a: 'x', 'Bad-Key': 'y' } }]),
    SubstitutionError,
  );
});

test('a missing or non-object substitutions bag is rejected', () => {
  for (const bad of [undefined, null, 'x', 42, ['a']]) {
    assert.throws(
      () => renderRecipients({ html: '{{a}}' }, [{ substitutions: bad as never }]),
      SubstitutionError,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('templates with no tokens render unchanged and need no substitutions', () => {
  const [out] = renderRecipients({ html: '<p>hi</p>', text: 'hi' }, [{ substitutions: {} }]);
  assert.equal(out.html, '<p>hi</p>');
  assert.equal(out.text, 'hi');
});

test('an inherited prototype property is not accepted as a supplied token', () => {
  const bag = Object.create({ unsubscribe_url: 'https://example.com/inherited' });
  assert.throws(() => renderRecipients({ html: HTML }, [{ substitutions: bag }]), SubstitutionError);
});
