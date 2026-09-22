import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positiveInt } from './env.js';

/** Runs `fn` with one env var set, capturing anything written to console.error. */
function withVar<T>(name: string, value: string | undefined, fn: () => T): { result: T; logs: string[] } {
  const previous = process.env[name];
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => logs.push(args.join(' '));
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return { result: fn(), logs };
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('an unset variable uses the default, silently', () => {
  const { result, logs } = withVar('RELAY_TEST_UNSET', undefined, () =>
    positiveInt('RELAY_TEST_UNSET', 42),
  );
  assert.equal(result, 42);
  assert.deepEqual(logs, []);
});

test('a valid value is used as-is, silently', () => {
  for (const [raw, expected] of [
    ['30', 30],
    ['  30  ', 30],
    ['1', 1],
    ['2000', 2000],
  ] as const) {
    const { result, logs } = withVar(`RELAY_TEST_OK_${raw.trim()}`, raw, () =>
      positiveInt(`RELAY_TEST_OK_${raw.trim()}`, 99),
    );
    assert.equal(result, expected, raw);
    assert.deepEqual(logs, [], raw);
  }
});

test('a set-but-invalid value falls back to the default and logs once', () => {
  // The exact shapes that used to produce NaN, 0, a negative or Infinity —
  // any of which silently disables the safeguard the variable configures.
  const cases = ['512KB', '', '   ', '0', '-5', 'NaN', '1e99', 'Infinity', '1.5', 'true'];
  cases.forEach((raw, i) => {
    const name = `RELAY_TEST_BAD_${i}`;
    const { result, logs } = withVar(name, raw, () => positiveInt(name, 512, { max: 1_000_000 }));
    assert.equal(result, 512, `${name}=${JSON.stringify(raw)}`);
    assert.equal(logs.length, 1, `${name}=${JSON.stringify(raw)} should log exactly once`);
    assert.match(logs[0], new RegExp(`invalid ${name}=`));
    assert.match(logs[0], /using default 512/);
  });
});

test('the result is never NaN, zero, negative or Infinity', () => {
  for (const raw of ['512KB', '', '0', '-5', 'NaN', 'Infinity', '-Infinity', '1e99']) {
    const name = 'RELAY_TEST_NEVER';
    const { result } = withVar(name, raw, () => positiveInt(name, 7, { max: 1000 }));
    assert.ok(Number.isInteger(result), raw);
    assert.ok(result > 0, raw);
    assert.ok(Number.isFinite(result), raw);
  }
});

test('min and max bounds are enforced', () => {
  const name = 'RELAY_TEST_BOUNDS';
  assert.equal(withVar(name, '5', () => positiveInt(name, 50, { min: 10, max: 100 })).result, 50);
  assert.equal(withVar(name, '500', () => positiveInt(name, 50, { min: 10, max: 100 })).result, 50);
  assert.equal(withVar(name, '10', () => positiveInt(name, 50, { min: 10, max: 100 })).result, 10);
  assert.equal(withVar(name, '100', () => positiveInt(name, 50, { min: 10, max: 100 })).result, 100);
});

test('repeated reads of the same bad value log only once', () => {
  const name = 'RELAY_TEST_REPEAT';
  const { logs } = withVar(name, 'nonsense', () => {
    for (let i = 0; i < 5; i += 1) positiveInt(name, 8);
    return null;
  });
  assert.equal(logs.length, 1);
});
