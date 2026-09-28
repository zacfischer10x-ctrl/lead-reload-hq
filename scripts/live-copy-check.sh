#!/usr/bin/env bash
# Live copy check: fetch the public pages/assets of the site and grep for
# wording Dan has ruled out (exclusivity, opt-in/consent/permission claims,
# TCPA/verification claims). Run right after a deploy:
#
#   bash scripts/live-copy-check.sh                    # https://leadreloadhq.com
#   bash scripts/live-copy-check.sh https://<deploy-preview>.netlify.app
#
# Exit 0 = no hits, 1 = hits found, 2 = a fetch failed. Read-only (GET only).
set -u
BASE="${1:-https://leadreloadhq.com}"
BASE="${BASE%/}"
PATTERN='exclusiv|opt-?in|opted|consent|permission|tcpa|verified|fresh opt'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fixed list + every same-origin .js/.css/.html referenced from / and /admin/.
PATHS="/ /app.js /styles.css /identity-redirect.js /admin/ /admin/admin.js /admin/admin.css /terms/ /subscription-terms/ /privacy/ /robots.txt"
for page in / /admin/; do
  curl -fsSL --max-time 20 "$BASE$page" 2>/dev/null \
    | grep -oE '(src|href)="[^"]+"' | sed -E 's/^(src|href)="//; s/"$//; s/\?.*$//' \
    | grep -E '\.(js|css|html)$' | grep -vE '^(https?:)?//' \
    | while read -r ref; do
        case "$ref" in /*) echo "$ref" ;; *) echo "${page%/}/$ref" ;; esac
      done >> "$TMP/refs"
done
PATHS="$PATHS $(sort -u "$TMP/refs" 2>/dev/null | tr '\n' ' ')"

hits=0; failed=0
printf 'Live copy check against %s at %s\n' "$BASE" "$(date '+%Y-%m-%d %H:%M %Z')"
printf 'Pattern (case-insensitive): %s\n\n' "$PATTERN"
for p in $(printf '%s\n' $PATHS | sort -u); do
  out="$TMP/body"
  code="$(curl -sSL --max-time 20 -o "$out" -w '%{http_code}' "$BASE$p" 2>/dev/null || echo 000)"
  if [ "$code" = "404" ]; then printf '  %-24s 404 (skipped)\n' "$p"; continue; fi
  if [ "$code" != "200" ]; then printf '  %-24s HTTP %s (FETCH FAILED)\n' "$p" "$code"; failed=1; continue; fi
  n="$(grep -ciE "$PATTERN" "$out" || true)"
  if [ "$n" -gt 0 ]; then
    printf '  %-24s 200  %s line(s) with hits:\n' "$p" "$n"
    grep -noiE ".{0,50}($PATTERN).{0,50}" "$out" | sed 's/^/      /'
    hits=$((hits + n))
  else
    printf '  %-24s 200  clean\n' "$p"
  fi
done
echo
if [ "$failed" -ne 0 ]; then echo "RESULT: fetch failure(s) — rerun"; exit 2; fi
if [ "$hits" -gt 0 ]; then echo "RESULT: $hits line(s) with banned wording"; exit 1; fi
echo "RESULT: clean — no banned wording found"
