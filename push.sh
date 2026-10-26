#!/usr/bin/env bash
# Collect a fresh Artemis snapshot on the box and push it to the dashboard.
# Usage: ./push.sh [--run-tests] [--no-collect]
# Reads the ingest token from .ingest_token (chmod 600) and the URL from .dashboard_url.
# Never prints the token.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR=/workspace/artemis-dashboard/collect.py
SNAP=/workspace/artemis-dashboard/snapshot.json
URL="${DASHBOARD_URL:-$(cat "$HERE/.dashboard_url" 2>/dev/null || true)}"
[ -n "$URL" ] || { echo "No dashboard URL (set DASHBOARD_URL or write $HERE/.dashboard_url)" >&2; exit 2; }
[ -s "$HERE/.ingest_token" ] || { echo "Missing $HERE/.ingest_token" >&2; exit 2; }

COLLECT=1; ARGS=()
for a in "$@"; do case "$a" in --no-collect) COLLECT=0;; *) ARGS+=("$a");; esac; done
if [ "$COLLECT" = 1 ]; then python3 "$COLLECTOR" "${ARGS[@]}" >/dev/null; fi
[ -s "$SNAP" ] || { echo "No snapshot at $SNAP" >&2; exit 3; }

# Refuse to push anything that looks like a credential.
if grep -qiE 'nvapi-|api[_-]?key"|"password|BEGIN [A-Z ]*PRIVATE KEY|jupyter_token|instance_api_key|Bearer |sk_(live|test)_|eyJ[A-Za-z0-9_-]{20,}\.' "$SNAP"; then
  echo "Snapshot contains something that looks like a secret; not pushing." >&2; exit 4
fi

HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT; chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$HERE/.ingest_token")" > "$HDR"
code=$(curl -sS -o /tmp/artemis-push.out -w '%{http_code}' --max-time 120 --retry 3 --retry-all-errors \
  -H @"$HDR" -H 'Content-Type: application/json' --data-binary @"$SNAP" "${URL%/}/api/ingest")
echo "$(date '+%Y-%m-%d %H:%M %Z') push -> HTTP $code $(cat /tmp/artemis-push.out)"
[ "$code" = 200 ]
