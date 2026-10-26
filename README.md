# Artemis Dashboard

Password-protected, trading-terminal-style ops dashboard for Artemis (Cutline Industries LLC).
Live at: https://admin.artemisstatistics.artemisai-bycutlineindustries.studio (Azure Container Apps `ca-artemis-dashboard`, managed cert).

## Pieces
- `server.js`: Node 20 `http` server. Only dependency: `bcryptjs`.
  - Server-side `/login`; every page, static app asset and `/api/*` route needs a session.
  - At startup, `DASHBOARD_PASSWORD` is hashed with bcrypt (cost 12) and then removed from `process.env`. The app refuses to start without it.
  - Sessions are HMAC-signed cookies (`HttpOnly; Secure; SameSite=Strict`, 12 h). `POST /logout` revokes the session.
  - Login rate limit: 5 failures per IP per 15 min, 50 failures globally per 15 min, then HTTP 429.
  - `POST /api/ingest` takes `Authorization: Bearer <INGEST_TOKEN>`, compared in constant time.
  - Strict CSP (no inline script or style), HSTS, DENY framing, `no-store`.
  - Storage is Azure Blob, through a container SAS (`BLOB_SAS_URL`): `latest.json` plus `day-YYYY-MM-DD.json` (ET), keeping the last 30 days. Without `BLOB_SAS_URL`, it writes to the local `data/` folder.
- `public/`: login page and dashboard (vanilla JS, SVG charts, no CDN).
- `push.sh`: runs `/workspace/artemis-dashboard/collect.py`, refuses to push anything that looks like a secret, then POSTs the snapshot.
  - It reads `.ingest_token` (chmod 600, gitignored) and `.dashboard_url`.

## Env / secrets (Container App secrets, never committed)
`DASHBOARD_PASSWORD`, `INGEST_TOKEN`, `SESSION_SECRET`, `BLOB_SAS_URL` (all `secretref:`)

## Daily push
    /workspace/artemis-dashboard-site/push.sh            # collect + push
    /workspace/artemis-dashboard-site/push.sh --run-tests
