// Per-recipient token substitution for POST /send-bulk.
//
// The whole point is that recipient N can never see recipient M's opt-out URL,
// so the rules are deliberately unforgiving: tokens are collected from the
// ORIGINAL templates, every token must be supplied by every recipient, and a
// single bad value fails the whole call before anything is sent.
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

/** One pass over the original template; substituted text is never re-scanned. */
function substitute(template: string, values: Record<string, string>, escape: boolean): string {
  return template.replace(TOKEN_SCAN_RE, (_match, key: string) =>
    escape ? escapeHtml(values[key]) : values[key],
  );
}

/**
 * Renders one set of bodies per recipient, or throws — never partially. The
 * caller can therefore treat a throw as "nothing was sent, and nothing will be".
 */
export function renderRecipients(
  templates: SubstitutionTemplates,
  recipients: RecipientSubstitutions[],
): RenderedBodies[] {
  const tokens = collectTokens(templates);

  // Validate every recipient before rendering any of them.
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

  return bags.map((bag) => ({
    html: substitute(templates.html, bag, true),
    ...(templates.text !== undefined ? { text: substitute(templates.text, bag, false) } : {}),
    ...(templates.listUnsubscribe !== undefined
      ? { listUnsubscribe: substitute(templates.listUnsubscribe, bag, false) }
      : {}),
  }));
}
