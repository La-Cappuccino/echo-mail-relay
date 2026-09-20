// Numeric configuration, read defensively.
//
// `Number(process.env.X ?? fallback)` looks harmless and is not: a typo like
// BULK_MAX_RENDERED_EMAIL_BYTES="512KB" yields NaN, every comparison against
// NaN is false, and the cap it configures silently stops existing. "0", "-5"
// and "1e99" fail in their own ways — a zero-capacity bucket blocks all mail,
// a zero timeout aborts every response.
//
// This is shared production infrastructure, so a bad value must not take the
// relay down either. The rule is: unset uses the default silently; set-but-
// invalid uses the default and says so, once.

const warned = new Set<string>();

function warnOnce(name: string, raw: string, fallback: number): void {
  const marker = `${name}=${raw}`;
  if (warned.has(marker)) return;
  warned.add(marker);
  console.error(`[relay] invalid ${name}=${raw}, using default ${fallback}`);
}

export interface IntBounds {
  min?: number;
  max?: number;
}

/**
 * A positive integer from the environment. Guaranteed never to return NaN,
 * zero, a negative number or Infinity — callers can treat the result as a
 * usable limit without re-checking it.
 */
export function positiveInt(name: string, fallback: number, bounds: IntBounds = {}): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    warnOnce(name, raw, fallback);
    return fallback;
  }
  return value;
}
