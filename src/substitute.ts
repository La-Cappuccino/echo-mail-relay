// Per-recipient token substitution for POST /send-bulk.
//
// The whole point is that recipient N can never see recipient M's opt-out URL,
// so the rules are deliberately unforgiving: tokens are collected from the
// ORIGINAL templates, every token must be supplied by every recipient, and a
// single bad value fails the whole call before anything is sent.
//
// The work is split in three deliberately separate steps, because rendering is
// the expensive one and must be the LAST thing that happens:
//   validateSubstitutions — checks tokens, keys and values. Allocates nothing
//                           proportional to the output.
//   renderedSizes         — the exact rendered byte size, by arithmetic, so an
//                           amplifying payload ({{a}}×1000 with a 2000-char
//                           value, ×500 recipients) is refused BEFORE it is
//                           built.
//   renderRecipients      — actually materialises the bodies.
//
// MailerSend's own `personalization` is not used — the relay renders each
// email fully and hands the provider finished bodies.

const TOKEN_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// `[^{}]*` so a nested `{{a{{b}}` cannot be swallowed as one well-formed token.
const TOKEN_SCAN_RE = /\{\{([^{}]*)\}\}/g;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

const MAX_KEYS_PER_RECIPIENT = 10;
const MAX_VALUE_LENGTH = 2000;

export class SubstitutionError extends Error {}

export interface SubstitutionTemplates {
  html: string;
  text?: string;
  listUnsubscribe?: string;
}

export interface RecipientSubstitutions {
  substitutions: Record<string, string>;
}

export interface RenderedBodies {
  html: string;
  text?: string;
  listUnsubscribe?: string;
}

/** The product of validation: safe to size, safe to render, nothing rendered yet. */
export interface ValidatedSubstitutions {
  tokens: string[];
  bags: Record<string, string>[];
}

export interface RenderedSizes {
  perEmail: number[];
  total: number;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Byte length the value would occupy once HTML-escaped — without escaping it. */
function escapedByteLength(value: string): number {
  let extra = 0;
  for (let i = 0; i < value.length; i += 1) {
    switch (value.charCodeAt(i)) {
      case 38: // & -> &amp;
        extra += 4;
        break;
      case 60: // < -> &lt;
      case 62: // > -> &gt;
        extra += 3;
        break;
      case 34: // " -> &quot;
        extra += 5;
        break;
      case 39: // ' -> &#39;
        extra += 4;
        break;
      default:
        break;
    }
  }
  return Buffer.byteLength(value) + extra;
}

function templateParts(templates: SubstitutionTemplates): string[] {
  return [templates.html, templates.text, templates.listUnsubscribe].filter(
    (part): part is string => typeof part === 'string',
  );
}

/**
 * Every `{{…}}` in the templates, validated and deduped. Throws if any
 * token-shaped sequence is not a well-formed key — a stray `{{Foo}}` would
 * otherwise reach a real inbox as literal text.
 */
export function collectTokens(templates: SubstitutionTemplates): string[] {
  const tokens = new Set<string>();
  for (const part of templateParts(templates)) {
    for (const [, key] of part.matchAll(TOKEN_SCAN_RE)) {
      if (!TOKEN_KEY_RE.test(key)) {
        throw new SubstitutionError(`invalid substitution token '{{${key}}}'`);
      }
      tokens.add(key);
    }
    if (part.replace(TOKEN_SCAN_RE, '').includes('{{')) {
      throw new SubstitutionError('unbalanced or nested {{ }} in template');
    }
  }
  return [...tokens].sort();
}

function validateBag(bag: unknown, position: number): Record<string, string> {
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) {
    throw new SubstitutionError(`recipient ${position}: substitutions must be an object`);
  }
  const record = bag as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > MAX_KEYS_PER_RECIPIENT) {
    throw new SubstitutionError(
      `recipient ${position}: more than ${MAX_KEYS_PER_RECIPIENT} substitution keys`,
    );
  }
  for (const key of keys) {
    if (!TOKEN_KEY_RE.test(key)) {
      throw new SubstitutionError(`recipient ${position}: invalid substitution key '${key}'`);
    }
    const value = record[key];
    if (typeof value !== 'string') {
      throw new SubstitutionError(`recipient ${position}: '${key}' must be a string`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new SubstitutionError(
        `recipient ${position}: '${key}' exceeds ${MAX_VALUE_LENGTH} characters`,
      );
    }
    if (CONTROL_CHAR_RE.test(value)) {
      throw new SubstitutionError(`recipient ${position}: '${key}' contains a control character`);
    }
    if (key.endsWith('_url') && !isHttpsUrl(value)) {
      throw new SubstitutionError(`recipient ${position}: '${key}' must be an https: URL`);
    }
  }
  return record as Record<string, string>;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates the templates and every recipient's values, or throws — never
 * partially. A throw therefore means "nothing was sent, and nothing will be".
 * Nothing is rendered here.
 */
export function validateSubstitutions(
  templates: SubstitutionTemplates,
  recipients: RecipientSubstitutions[],
): ValidatedSubstitutions {
  const tokens = collectTokens(templates);
  const bags = recipients.map((recipient, index) => {
    const position = index + 1;
    const bag = validateBag(recipient?.substitutions, position);
    for (const token of tokens) {
      if (!Object.prototype.hasOwnProperty.call(bag, token)) {
        throw new SubstitutionError(`recipient ${position}: missing substitution '${token}'`);
      }
    }
    return bag;
  });
  return { tokens, bags };
}

/** How many times each token occurs in a field, plus the field's own byte size. */
interface FieldShape {
  baseBytes: number;
  occurrences: Map<string, number>;
}

function fieldShape(field: string): FieldShape {
  const occurrences = new Map<string, number>();
  for (const [, key] of field.matchAll(TOKEN_SCAN_RE)) {
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  return { baseBytes: Buffer.byteLength(field), occurrences };
}

function fieldSize(shape: FieldShape, bag: Record<string, string>, escape: boolean): number {
  let size = shape.baseBytes;
  for (const [token, count] of shape.occurrences) {
    const value = bag[token];
    const replacement = escape ? escapedByteLength(value) : Buffer.byteLength(value);
    // each occurrence loses `{{token}}` and gains the replacement
    size += count * (replacement - (token.length + 4));
  }
  return size;
}

/**
 * Exact rendered size per email, by arithmetic — nothing is materialised.
 * Covers the three substituted fields; the subject is not substituted and is
 * already capped by the route.
 */
export function renderedSizes(
  templates: SubstitutionTemplates,
  validated: ValidatedSubstitutions,
): RenderedSizes {
  const html = fieldShape(templates.html);
  const text = templates.text !== undefined ? fieldShape(templates.text) : undefined;
  const listUnsubscribe =
    templates.listUnsubscribe !== undefined ? fieldShape(templates.listUnsubscribe) : undefined;

  let total = 0;
  const perEmail = validated.bags.map((bag) => {
    const size =
      fieldSize(html, bag, true) +
      (text ? fieldSize(text, bag, false) : 0) +
      (listUnsubscribe ? fieldSize(listUnsubscribe, bag, false) : 0);
    total += size;
    return size;
  });
  return { perEmail, total };
}

/** One pass over the original template; substituted text is never re-scanned. */
function substitute(template: string, values: Record<string, string>, escape: boolean): string {
  return template.replace(TOKEN_SCAN_RE, (_match, key: string) =>
    escape ? escapeHtml(values[key]) : values[key],
  );
}

/** Materialises one set of bodies per recipient. Validate (and size) first. */
export function renderRecipients(
  templates: SubstitutionTemplates,
  validated: ValidatedSubstitutions,
): RenderedBodies[] {
  return validated.bags.map((bag) => ({
    html: substitute(templates.html, bag, true),
    ...(templates.text !== undefined ? { text: substitute(templates.text, bag, false) } : {}),
    ...(templates.listUnsubscribe !== undefined
      ? { listUnsubscribe: substitute(templates.listUnsubscribe, bag, false) }
      : {}),
  }));
}
