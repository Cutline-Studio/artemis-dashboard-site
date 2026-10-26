#!/usr/bin/env bash
# Bind admin.artemisstatistics.artemisai-bycutlineindustries.studio to ca-artemis-dashboard
# with a free Azure managed certificate, once the DNS records resolve.
# Usage: ./bind-domain.sh [--wait MINUTES]   (default: check once, no waiting)
# Subscription 52056bc2 only. Reads DNS through Google / Cloudflare DNS-over-HTTPS (no dig needed).
set -euo pipefail
SUB=52056bc2-3eb2-437d-95e7-36d360871ea7
RG=rg-artemis-dashboard
APP=ca-artemis-dashboard
ENV_ID=/subscriptions/$SUB/resourceGroups/cutline-cloud-pilot/providers/Microsoft.App/managedEnvironments/apollo-core-env
HOST=admin.artemisstatistics.artemisai-bycutlineindustries.studio
FQDN=ca-artemis-dashboard.politegrass-b7b59577.eastus2.azurecontainerapps.io
VID=4BADB844A72339143A80074196CFB311225E2EB5559CD9A2FDE77C1485D06C3C
WAIT_MIN=0; [ "${1:-}" = "--wait" ] && WAIT_MIN="${2:-20}"

doh() { # doh NAME TYPE  -> answers, one per line
  for u in "https://dns.google/resolve?name=$1&type=$2" "https://cloudflare-dns.com/dns-query?name=$1&type=$2"; do
    out=$(curl -s --max-time 10 -H 'accept: application/dns-json' "$u" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); [print(a["data"].strip("\"").rstrip(".")) for a in d.get("Answer",[])]
except Exception: pass') && [ -n "$out" ] && { echo "$out"; return; }
  done
}
check() {
  CN=$(doh "$HOST" CNAME | tr 'A-Z' 'a-z' | head -1); TX=$(doh "asuid.$HOST" TXT | tr -d ' ')
  echo "$(date '+%H:%M:%S %Z')  CNAME $HOST -> ${CN:-<none>}   TXT asuid -> ${TX:-<none>}"
  [ "$CN" = "$FQDN" ] && grep -qx "$VID" <<<"$TX"
}
deadline=$(( $(date +%s) + WAIT_MIN*60 ))
until check; do
  [ "$(date +%s)" -ge "$deadline" ] && { echo "DNS not ready. Records needed:"; echo "  CNAME admin.artemisstatistics -> $FQDN"; echo "  TXT   asuid.admin.artemisstatistics = $VID"; exit 10; }
  sleep 60
done

echo "DNS OK. Binding $HOST ..."
if ! az containerapp hostname list --subscription $SUB -g $RG -n $APP --query "[].name" -o tsv 2>/dev/null | grep -qx "$HOST"; then
  az containerapp hostname add --subscription $SUB -g $RG -n $APP --hostname "$HOST" -o none
fi
az containerapp hostname bind --subscription $SUB -g $RG -n $APP --hostname "$HOST" \
  --environment "$ENV_ID" --validation-method CNAME -o none
az containerapp hostname list --subscription $SUB -g $RG -n $APP -o table

echo "Verifying HTTPS (cert issuance can take a few minutes) ..."
for i in $(seq 1 20); do
  login=$(curl -s -o /tmp/bind-login.html -w '%{http_code}' --max-time 20 "https://$HOST/login" || true)
  api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/api/snapshot" || true)
  if [ "$login" = 200 ] && grep -q 'ARTEMIS' /tmp/bind-login.html && [ "$api" = 401 ]; then
    echo "OK: https://$HOST/login -> 200 (login page), /api/snapshot unauthenticated -> 401"
    echo | timeout 15 openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null || true
    exit 0
  fi
  echo "  attempt $i: login=$login api=$api; retrying in 30s"; sleep 30
done
echo "Bound, but HTTPS verification did not pass yet; re-run the curl checks later." ; exit 11
