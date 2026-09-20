# echo-mail-relay

Central email control plane for all Echo products (SPEC-echo-mail-relay.md). One MailerSend backend, per-project bearer keys, tiered kill-switches, full send log in Postgres.

## API

- `GET /health` — liveness + DB check.
- `POST /send` — one email. `Authorization: Bearer <project key>`; body:
  ```json
  { "tier": "transactional|marketing", "to": "user@example.com", "subject": "…", "html": "…", "text": "…", "replyTo": "…", "listUnsubscribe": "…" }
  ```
  Responses: `{ok:true,messageId}` sent · `{ok:true,suppressed:true}` marketing kill-switch · `403` hard-off · `401` bad key · `429` rate limited · `502` MailerSend failure (logged).
- `POST /send-bulk` — one marketing batch. See below.
- `GET /send-bulk/:bulkEmailId` — read a batch back for reconciliation.

## Bulk send

One batch, at most once, no retry. The caller initiates an issue once; this
endpoint's job is to make the outcome **knowable** — sent, provably-not-sent,
or honestly unknown. There is deliberately no retry, reset or clone here: a
second call would be a second batch of real mail.

```json
POST /send-bulk            Authorization: Bearer <project key>
{
  "tier": "marketing",
  "subject": "string, 1..200",
  "html": "string, required, may contain {{key}} tokens",
  "text": "string, optional, same tokens",
  "replyTo": "email, optional",
  "listUnsubscribe": "string, optional, tokens allowed",
  "recipients": [
    { "to": "user@example.com", "substitutions": { "unsubscribe_url": "https://example.com/u/abc" } }
  ]
}
```

| Response | Meaning |
|---|---|
| `200 {ok:true, bulkEmailId, accepted, logged}` | accepted by MailerSend. `logged:false` means the send-log write failed *after* the provider accepted — the mail still went out |
| `200 {ok:true, suppressed:true, reason:"marketing_disabled"}` | kill-switch; **nothing was sent** |
| `400` | validation or substitution error; nothing sent |
| `401` bad key · `403` hard-off · `413` body > 2 MB · `429` rate or budget | nothing sent |
| `502 {error, outcome:"rejected"}` | provider 4xx, or a paused account — **provably nothing was sent** |
| `502 {error, outcome:"unknown"}` | provider 5xx, 15 s timeout, network error, or an accept with no usable `bulk_email_id`. It may or may not have gone out — **do not resend**; reconcile with the status read |

```json
GET /send-bulk/:bulkEmailId        (same auth)
→ 200 { "ok": true, "state": "…", "validationErrorsCount": 0, "suppressedCount": 0, "raw": { … } }
```

The id must be a plain token (`^[A-Za-z0-9_-]{1,64}$`) before it is placed in a
provider URL. A `hard_off` project cannot read batches; a `marketing_enabled=false`
one can, so an already-sent batch stays reconcilable after the switch is flipped.

### Substitution rules

Tokens are `{{key}}` with `key` matching `^[a-z][a-z0-9_]{0,39}$`.

- Tokens are collected from `html`, `text` and `listUnsubscribe` **before** any
  substitution, and **every token must be supplied by every recipient** — one
  gap is a 400 for the whole call and nothing is sent.
- Any `{{…}}` that is not a well-formed token (`{{Foo}}`, `{{ bar }}`), and any
  unbalanced or nested `{{`, is a 400. Literal `{{…}}` is not supported, so no
  stray braces can reach an inbox.
- One pass over the original template: a value containing `{{other}}` stays
  literal.
- Values are HTML-escaped (`& < > " '`) into `html`, and inserted raw into
  `text` and `listUnsubscribe`.
- Per recipient: ≤10 keys, each value ≤2000 chars, no control characters.
  Any key ending `_url` must parse as an `https:` URL.

Each recipient gets a fully rendered email object. MailerSend's own
`personalization` is not used — that is what keeps one recipient's opt-out URL
out of another's mail.

### Send log

A bulk send writes one `sends` row per recipient in a single multi-row insert,
all carrying the `bulk_email_id` in the provider-id column. `sends.status` has
only `sent | suppressed | failed`, and this slice adds no migration, so an
`unknown` outcome is logged as `failed` with the error prefixed
`outcome=unknown: `. The HTTP response is the authoritative classification.

### List-Unsubscribe

`listUnsubscribe` is accepted on both send shapes but reaches MailerSend **only**
when `MAILERSEND_LIST_UNSUBSCRIBE` is exactly `true`. It defaults to **off**
because MailerSend restricts `headers` and `list_unsubscribe` to Professional and
Enterprise accounts, and this account is on Starter — so with the flag off the
relay sends no such header and nothing here claims otherwise. The opt-out link
lives in the message body instead. Turning the flag on is a plan decision, not a
code change.

### Known limitation

`GET /send-bulk/:bulkEmailId` authenticates the caller but does not verify that
the batch belongs to that caller's project — the relay does not index bulk ids
per project. A cross-project read would require guessing a 64-character provider
id. Closing it properly needs a lookup against `sends`; out of scope for this
slice.

## Provider

MailerSend is the sole provider (`src/mailersend.ts`, REST, no SDK). Brevo was removed 2026-07-19 — its SMTP account was never activated (silent 403 for days). To restore it: `src/brevo.ts` lives in git history, keys in Vaultwarden (`keychain:brevo-api-key-rnb-vault` et al.); re-add the client plus an `EMAIL_PROVIDER` selector and set `BREVO_API_KEY`.

## Kill-switch semantics (D4)

| State | transactional | marketing |
|---|---|---|
| normal | sends | sends |
| `marketing_enabled=false` | **sends** | suppressed (silent, logged) |
| `hard_off=true` | 403 | 403 |

## Rate limiting (D2)

In-process token buckets, shared by both send routes for the blunt pre-auth
checks and separate for bulk volume. Any empty bucket → `429 {error:"rate limited"}`,
logged. Single-instance in-memory state — correct while the relay runs as one
container.

| Bucket | Keyed by | Applies to | Env (default) |
|---|---|---|---|
| IP | first `X-Forwarded-For` hop | `/send`, `/send-bulk` | `RATE_LIMIT_PER_MINUTE` (60), `RATE_LIMIT_BURST` (20) |
| key | bearer-key hash, before the DB lookup | `/send`, `/send-bulk` | same as above |
| bulk requests | bearer-key hash | `/send-bulk` only | `BULK_REQUESTS_PER_MINUTE` (10) |
| recipient budget | project id, **weighted by recipient count** | `/send-bulk` only | `BULK_RECIPIENTS_PER_HOUR` (2000) |

Bulk has its own buckets so a newsletter can never starve transactional mail.
The recipient budget is charged only when a send is actually about to happen —
a suppressed or refused batch spends nothing. Body cap: **2 MB** (fixed, part
of the contract), and recipients are capped at **500 per call**.

## Send log

`sends.brevo_message_id` holds the **provider** message id (MailerSend today) — a
single message id, or the `bulk_email_id` for every row of a bulk batch. The column keeps its schema-v0 legacy name on purpose: this relay is the column's only reader/writer, so a destructive rename or a compat view would add migration risk for zero benefit. Code refers to it as `provider_message_id` (`src/db.ts`).

## Ops

```bash
npm run migrate                                  # apply migrations (DATABASE_URL)
npm run build                                    # tsc
npm test                                         # every src/*.test.ts (no DB, no network: all fakes)
npx tsx src/register-project.ts rnb-vault "RnB Vault" noreply@rnbvault.no "RnB Vault" rnbvault.no
# → prints project API key ONCE; store in Vaultwarden as emr-key-rnb-vault
```

Env: `MAILERSEND_API_KEY`, `DATABASE_URL`, `PORT` (default 8080),
`RATE_LIMIT_PER_MINUTE` (60), `RATE_LIMIT_BURST` (20),
`BULK_REQUESTS_PER_MINUTE` (10), `BULK_RECIPIENTS_PER_HOUR` (2000),
`MAILERSEND_LIST_UNSUBSCRIBE` (default off — see § List-Unsubscribe).

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build && npm test` on
Node 22 for every PR and every push to `main`, with no `DATABASE_URL` and no
`MAILERSEND_API_KEY` — a green run proves the suite reaches neither Postgres
nor the provider.

Deploy: Coolify → Dockerfile app → domain `mail.echoalgoridata.no` (TLS via Traefik). Admin ops (register/toggle) run via SSH/Tailscale only — no public admin surface.

Toggle examples (SQL until the slice-3 CLI):
```sql
UPDATE projects SET marketing_enabled=false, updated_at=now() WHERE id='rnb-vault';
UPDATE projects SET hard_off=true, updated_at=now() WHERE id='old-project';
```
