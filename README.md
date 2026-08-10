# echo-mail-relay

Central email control plane for all Echo products (SPEC-echo-mail-relay.md). One MailerSend backend, per-project bearer keys, tiered kill-switches, full send log in Postgres.

## API

- `GET /health` — liveness + DB check.
- `POST /send` — `Authorization: Bearer <project key>`; body:
  ```json
  { "tier": "transactional|marketing", "to": "user@x.no", "subject": "…", "html": "…", "text": "…", "replyTo": "…" }
  ```
  Responses: `{ok:true,messageId}` sent · `{ok:true,suppressed:true}` marketing kill-switch · `403` hard-off · `401` bad key · `429` rate limited · `502` MailerSend failure (logged).

## Provider

MailerSend is the sole provider (`src/mailersend.ts`, REST, no SDK). Brevo was removed 2026-07-19 — its SMTP account was never activated (silent 403 for days). To restore it: `src/brevo.ts` lives in git history, keys in Vaultwarden (`keychain:brevo-api-key-rnb-vault` et al.); re-add the client plus an `EMAIL_PROVIDER` selector and set `BREVO_API_KEY`.

## Kill-switch semantics (D4)

| State | transactional | marketing |
|---|---|---|
| normal | sends | sends |
| `marketing_enabled=false` | **sends** | suppressed (silent, logged) |
| `hard_off=true` | 403 | 403 |

## Rate limiting (D2)

In-process token buckets on `POST /send` — one per client IP (first `X-Forwarded-For` hop) and one per bearer-key hash (checked before the DB lookup). Either bucket empty → `429 {error:"rate limited"}`, logged. Env: `RATE_LIMIT_PER_MINUTE` (default 60 sustained/min per bucket), `RATE_LIMIT_BURST` (default 20). Single-instance in-memory state — correct while the relay runs as one container.

## Send log

`sends.brevo_message_id` holds the **provider** message id (MailerSend today). The column keeps its schema-v0 legacy name on purpose: this relay is the column's only reader/writer, so a destructive rename or a compat view would add migration risk for zero benefit. Code refers to it as `provider_message_id` (`src/db.ts`).

## Ops

```bash
npm run migrate                                  # apply migrations (DATABASE_URL)
npm test                                         # kill-switch matrix, auth, namespace, rate-limit tests
npx tsx src/register-project.ts rnb-vault "RnB Vault" noreply@rnbvault.no "RnB Vault" rnbvault.no
# → prints project API key ONCE; store in Vaultwarden as emr-key-rnb-vault
```

Env: `MAILERSEND_API_KEY`, `DATABASE_URL`, `PORT` (default 8080), `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`.

Deploy: Coolify → Dockerfile app → domain `mail.echoalgoridata.no` (TLS via Traefik). Admin ops (register/toggle) run via SSH/Tailscale only — no public admin surface.

Toggle examples (SQL until the slice-3 CLI):
```sql
UPDATE projects SET marketing_enabled=false, updated_at=now() WHERE id='rnb-vault';
UPDATE projects SET hard_off=true, updated_at=now() WHERE id='old-project';
```
