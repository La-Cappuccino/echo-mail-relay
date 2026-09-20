import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTokens,
  renderedSizes,
  renderRecipients,
  SubstitutionError,
  validateSubstitutions,
  type RecipientSubstitutions,
  type SubstitutionTemplates,
} from './substitute.js';

/**
 * Validate-then-render, the way the route does it. Most of these cases care
 * only that a bad input never reaches rendering, so they go through here.
 */
const render = (t: SubstitutionTemplates, recipients: RecipientSubstitutions[]) =>
  renderRecipients(t, validateSubstitutions(t, recipients));

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
      render({ html: HTML }, [
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
    () => render({ html: '<p>hi</p>', text: '{{name}}' }, [{ substitutions: {} }]),
    SubstitutionError,
  );
});

test('a token used only in listUnsubscribe must still be supplied', () => {
  assert.throws(
    () =>
      render({ html: '<p>hi</p>', listUnsubscribe: '<{{unsubscribe_url}}>' }, [
        { substitutions: {} },
      ]),
    SubstitutionError,
  );
});

// --- rendering ---

test('each recipient gets only its own value; no {{ survives', () => {
  const out = render({ html: HTML, text: 'Stop: {{unsubscribe_url}}' }, [
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
  const [out] = render(
    { html: '<p>{{name}}</p>', text: '{{name}}', listUnsubscribe: '{{name}}' },
    [{ substitutions: { name: `Ada & <b>"Bob"</b> 'x'` } }],
  );
  assert.equal(out.html, `<p>Ada &amp; &lt;b&gt;&quot;Bob&quot;&lt;/b&gt; &#39;x&#39;</p>`);
  assert.equal(out.text, `Ada & <b>"Bob"</b> 'x'`);
  assert.equal(out.listUnsubscribe, `Ada & <b>"Bob"</b> 'x'`);
});

test('one pass only: a value containing {{other}} is not expanded', () => {
  const [out] = render({ html: '{{a}}|{{b}}', text: '{{a}}' }, [
    { substitutions: { a: '{{b}}', b: 'REAL' } },
  ]);
  assert.equal(out.html, '{{b}}|REAL');
  assert.equal(out.text, '{{b}}');
});

test('a token repeated in a template is replaced everywhere', () => {
  const [out] = render({ html: '{{a}}-{{a}}-{{a}}' }, [{ substitutions: { a: 'x' } }]);
  assert.equal(out.html, 'x-x-x');
});

test('optional text and listUnsubscribe stay absent when not supplied', () => {
  const [out] = render({ html: HTML }, [recipient('https://example.com/u/1')]);
  assert.equal(out.text, undefined);
  assert.equal(out.listUnsubscribe, undefined);
});

test('a $-bearing value is inserted literally (no replacement-pattern expansion)', () => {
  const [out] = render({ html: '[{{a}}]', text: '[{{a}}]' }, [
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
    assert.throws(() => render({ html: HTML }, [recipient(bad)]), SubstitutionError, bad);
  }
});

test('_url keys accept an https URL', () => {
  const [out] = render({ html: HTML }, [
    recipient('https://example.com/u/1?t=abc&x=1'),
  ]);
  assert.match(out.html, /https:\/\/example\.com\/u\/1/);
});

test('control characters in any value are rejected (CR, LF, NUL, DEL, tab)', () => {
  for (const bad of ['a\rb', 'a\nb', 'a\u0000b', 'a\u007Fb', 'a\tb']) {
    assert.throws(
      () => render({ html: '{{a}}' }, [{ substitutions: { a: bad } }]),
      SubstitutionError,
      JSON.stringify(bad),
    );
  }
});

test('a control character in a listUnsubscribe value is rejected (header injection)', () => {
  assert.throws(
    () =>
      render({ html: '<p>hi</p>', listUnsubscribe: '<{{u}}>' }, [
        { substitutions: { u: 'https://example.com\r\nBcc: x@example.com' } },
      ]),
    SubstitutionError,
  );
});

test('a value longer than 2000 chars is rejected; exactly 2000 is accepted', () => {
  const ok = 'x'.repeat(2000);
  assert.doesNotThrow(() => render({ html: '{{a}}' }, [{ substitutions: { a: ok } }]));
  assert.throws(
    () => render({ html: '{{a}}' }, [{ substitutions: { a: ok + 'x' } }]),
    SubstitutionError,
  );
});

test('more than 10 substitution keys for one recipient is rejected; exactly 10 is accepted', () => {
  const keys = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
  assert.doesNotThrow(() => render({ html: '{{k0}}' }, [{ substitutions: keys(10) }]));
  assert.throws(
    () => render({ html: '{{k0}}' }, [{ substitutions: keys(11) }]),
    SubstitutionError,
  );
});

test('a non-string value is rejected — never coerced', () => {
  for (const bad of [1, null, true, ['x'], { a: 1 }, undefined]) {
    assert.throws(
      () => render({ html: '{{a}}' }, [{ substitutions: { a: bad } as never }]),
      SubstitutionError,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('a supplied key that cannot be a token is rejected', () => {
  assert.throws(
    () => render({ html: '{{a}}' }, [{ substitutions: { a: 'x', 'Bad-Key': 'y' } }]),
    SubstitutionError,
  );
});

test('a missing or non-object substitutions bag is rejected', () => {
  for (const bad of [undefined, null, 'x', 42, ['a']]) {
    assert.throws(
      () => render({ html: '{{a}}' }, [{ substitutions: bad as never }]),
      SubstitutionError,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('templates with no tokens render unchanged and need no substitutions', () => {
  const [out] = render({ html: '<p>hi</p>', text: 'hi' }, [{ substitutions: {} }]);
  assert.equal(out.html, '<p>hi</p>');
  assert.equal(out.text, 'hi');
});

test('an inherited prototype property is not accepted as a supplied token', () => {
  const bag = Object.create({ unsubscribe_url: 'https://example.com/inherited' });
  assert.throws(() => render({ html: HTML }, [{ substitutions: bag }]), SubstitutionError);
});

// --- validate does not render (Codex #3) ---

test('validateSubstitutions returns bags and tokens without building any body', () => {
  const templates = { html: '{{a}}{{b}}', text: '{{a}}' };
  const validated = validateSubstitutions(templates, [
    { substitutions: { a: '1', b: '2' } },
    { substitutions: { a: '3', b: '4' } },
  ]);
  assert.deepEqual(validated.tokens, ['a', 'b']);
  assert.deepEqual(validated.bags, [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  // the returned shape carries no rendered text at all
  assert.equal(JSON.stringify(validated).includes('12'), false);
});

test('validateSubstitutions rejects an amplifying payload no differently — size is the route\'s job', () => {
  // 1000 occurrences × a 2000-char value is legal per-value; it is the SIZE
  // preflight that must refuse it, not validation.
  const templates = { html: '{{a}}'.repeat(1000) };
  const validated = validateSubstitutions(templates, [{ substitutions: { a: 'x'.repeat(2000) } }]);
  assert.deepEqual(validated.tokens, ['a']);
});

// --- rendered size arithmetic ---

/** The size the renderer actually produces, for cross-checking the arithmetic. */
function actualSize(t: SubstitutionTemplates, recipients: RecipientSubstitutions[]): number[] {
  return render(t, recipients).map(
    (b) =>
      Buffer.byteLength(b.html) +
      (b.text !== undefined ? Buffer.byteLength(b.text) : 0) +
      (b.listUnsubscribe !== undefined ? Buffer.byteLength(b.listUnsubscribe) : 0),
  );
}

test('renderedSizes matches what the renderer actually produces', () => {
  const cases: [SubstitutionTemplates, RecipientSubstitutions[]][] = [
    [{ html: '<p>{{a}}</p>' }, [{ substitutions: { a: 'plain' } }]],
    // escaping: every escapable character, counted not escaped
    [{ html: '{{a}}' }, [{ substitutions: { a: `&<>"'` } }]],
    // raw into text and listUnsubscribe, escaped into html, same value
    [
      { html: '{{a}}', text: '{{a}}', listUnsubscribe: '<{{a}}>' },
      [{ substitutions: { a: 'a&b<c>d"e\'f' } }]
    ],
    // multi-byte: byte length, not character count
    [{ html: '{{a}}—{{a}}' }, [{ substitutions: { a: 'Blåbær 🎧' } }]],
    // repeated tokens and several recipients
    [
      { html: '{{a}}-{{a}}-{{b}}', text: '{{b}}' },
      [
        { substitutions: { a: 'xx', b: 'yyy' } },
        { substitutions: { a: '', b: '&&&' } },
      ],
    ],
    // no tokens at all
    [{ html: '<p>static</p>', text: 'static' }, [{ substitutions: {} }]],
  ];
  for (const [templates, recipients] of cases) {
    const validated = validateSubstitutions(templates, recipients);
    assert.deepEqual(
      renderedSizes(templates, validated).perEmail,
      actualSize(templates, recipients),
      JSON.stringify(templates),
    );
  }
});

test('renderedSizes totals the batch', () => {
  const templates = { html: '{{a}}' };
  const recipients = [
    { substitutions: { a: 'x'.repeat(10) } },
    { substitutions: { a: 'y'.repeat(20) } },
  ];
  const sizes = renderedSizes(templates, validateSubstitutions(templates, recipients));
  assert.deepEqual(sizes.perEmail, [10, 20]);
  assert.equal(sizes.total, 30);
});

test('renderedSizes sees the amplification without allocating it', () => {
  // 1000 occurrences × 2000 chars × 500 recipients ≈ 1 GB if rendered.
  const templates = { html: '{{a}}'.repeat(1000) };
  const recipients = Array.from({ length: 500 }, () => ({
    substitutions: { a: 'x'.repeat(2000) },
  }));
  const sizes = renderedSizes(templates, validateSubstitutions(templates, recipients));
  assert.equal(sizes.perEmail[0], 1000 * 2000);
  assert.equal(sizes.total, 500 * 1000 * 2000);
});
