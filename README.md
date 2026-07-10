# echo-mail-relay

Central email control plane for all Echo products (SPEC-echo-mail-relay.md). One Brevo (EU) backend, per-project bearer keys, tiered kill-switches, full send log in Postgres.

## API

- `GET /health` — liveness + DB check.
- `POST /send` — `Authorization: Bearer <project key>`; body:
  ```json
  { "tier": "transactional|marketing", "to": "user@x.no", "subject": "…", "html": "…", "text": "…", "replyTo": "…" }
  ```
  Responses: `{ok:true,messageId}` sent · `{ok:true,suppressed:true}` marketing kill-switch · `403` hard-off · `401` bad key · `502` Brevo failure (logged).

## Kill-switch semantics (D4)

| State | transactional | marketing |
|---|---|---|
| normal | sends | sends |
| `marketing_enabled=false` | **sends** | suppressed (silent, logged) |
| `hard_off=true` | 403 | 403 |

## Ops

```bash
npm run migrate                                  # apply migrations (DATABASE_URL)
npx tsx src/register-project.ts rnb-vault "RnB Vault" noreply@rnbvault.no "RnB Vault" rnbvault.no
# → prints project API key ONCE; store in Vaultwarden as emr-key-rnb-vault
```

Env: `BREVO_API_KEY`, `DATABASE_URL`, `PORT` (default 8080).

Deploy: Coolify → Dockerfile app → domain `mail.echoalgoridata.no` (TLS via Traefik). Admin ops (register/toggle) run via SSH/Tailscale only — no public admin surface.

Toggle examples (SQL until the slice-3 CLI):
```sql
UPDATE projects SET marketing_enabled=false, updated_at=now() WHERE id='rnb-vault';
UPDATE projects SET hard_off=true, updated_at=now() WHERE id='old-project';
```
