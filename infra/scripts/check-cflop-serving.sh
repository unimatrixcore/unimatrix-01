#!/usr/bin/env bash
#
# Asserts how the built cflop image serves URLs.
#
# The routing lives in `apps/cflop/nginx.conf` and nothing else in this repo
# exercises it: the unit suite never starts a server, Playwright drives a client
# router that hides a soft 404 behind a rendered card, and `vite preview`
# reproduces none of the rules. Restoring the SPA fallback would leave every
# other check green while every unknown path answered 200 again.
#
# Usage: bash infra/scripts/check-cflop-serving.sh [image-tag]
set -euo pipefail

IMAGE="${1:-unimatrix-cflop:ci}"
CONTAINER=""
BASE_URL=""
failures=0

cleanup() {
  if [[ -n "${CONTAINER}" ]]; then
    docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$1"; }

fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

# Status, and the `Location` header when the row expects a redirect. `curl -s -D`
# keeps the headers so both come from one request.
check_url() {
  local path="$1" expected_status="$2" expected_location="${3:-}"
  local headers status location label
  headers="$(mktemp)"

  status="$(curl -s -o /dev/null -D "${headers}" -w '%{http_code}' "${BASE_URL}${path}")"
  location="$(grep -i '^location:' "${headers}" | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//' || true)"
  rm -f "${headers}"

  label="${path} -> ${expected_status}"
  if [[ -n "${expected_location}" ]]; then
    label="${label} ${expected_location}"
  fi

  if [[ "${status}" != "${expected_status}" ]]; then
    fail "${label} (got ${status})"
    return
  fi
  if [[ -n "${expected_location}" && "${location}" != "${expected_location}" ]]; then
    fail "${label} (got Location: ${location:-none})"
    return
  fi
  pass "${label}"
}

check_body_contains() {
  local path="$1" needle="$2"
  # No `-f`: several rows below read the body of an error response.
  if curl -s "${BASE_URL}${path}" | grep -qF -- "${needle}"; then
    pass "${path} body contains ${needle}"
  else
    fail "${path} body does not contain ${needle}"
  fi
}

check_header() {
  local path="$1" header="$2" value="$3"
  if curl -s -o /dev/null -D - "${BASE_URL}${path}" | tr -d '\r' | grep -qiF "${header}: ${value}"; then
    pass "${path} sends ${header}: ${value}"
  else
    fail "${path} does not send ${header}: ${value}"
  fi
}

printf 'check-cflop-serving: %s\n\n' "${IMAGE}"

CONTAINER="$(docker run --detach --publish 127.0.0.1::8080 "${IMAGE}")"
port="$(docker port "${CONTAINER}" 8080/tcp | head -n 1 | sed -E 's/.*:([0-9]+)$/\1/')"
BASE_URL="http://127.0.0.1:${port}"

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${BASE_URL}/"; then break; fi
  sleep 0.5
done

# Without this, a container that never answers fails at the first `check_url`
# instead, where `set -e` aborts inside a command substitution and prints
# nothing at all — the log would show a passing run that simply stopped.
if ! curl -sf -o /dev/null "${BASE_URL}/"; then
  printf 'check-cflop-serving: no answer on %s within 30s\n' "${BASE_URL}" >&2
  docker logs "${CONTAINER}" >&2 || true
  exit 1
fi

# The config the rest of this script probes, checked directly: a syntax error
# would otherwise surface as every row failing at once.
if docker exec "${CONTAINER}" nginx -t >/dev/null 2>&1; then
  pass "nginx -t"
else
  fail "nginx -t"
fi

# The image's own HEALTHCHECK command. `location = / { try_files /index.html
# =404; }` is what answers it, and an unhealthy container is a deploy that never
# comes up.
if docker exec "${CONTAINER}" wget -q -O /dev/null http://127.0.0.1:8080/; then
  pass "HEALTHCHECK request succeeds"
else
  fail "HEALTHCHECK request succeeds"
fi

check_url / 200
check_url /learn 200
check_url /drill 200
check_url /origin-migration 200
check_url /learn/ 301 /learn
check_url '/learn/?x=1' 301 '/learn?x=1'
check_url /learn.html 301 /learn
check_url /index.html 301 /
check_url /index 404
check_url /404 404
check_url /404.html 404
check_url /nonsense 404
check_url /nonsense/ 301 /nonsense
check_url /assets 404
check_url /assets/ 301 /assets
check_url /robots.txt 200
check_url /sitemap.xml 200
check_url /favicon.svg 200

# The hashed bundle name changes every build, so it is read from the document
# rather than written down here.
bundle="$(curl -sf "${BASE_URL}/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -n 1)"
if [[ -n "${bundle}" ]]; then
  check_url "${bundle}" 200
else
  fail "no /assets/index-*.js reference found in /"
fi

check_body_contains /learn '<title>CFLOP - Learn</title>'
check_body_contains /drill '<title>CFLOP - Drill</title>'
check_body_contains /origin-migration 'name="robots" content="noindex,follow"'
# The 404 body is the prerendered not-found *head* over an empty `#app`; the
# card itself is rendered by the client router, as on every other route.
check_body_contains /nonsense '<title>CFLOP</title>'
check_body_contains /nonsense '<div id="app"></div>'
check_body_contains /robots.txt 'Sitemap: https://cflop.us/sitemap.xml'
check_body_contains /sitemap.xml '<loc>https://cflop.us/</loc>'
if sitemap="$(curl -sf "${BASE_URL}/sitemap.xml")" && [[ "${sitemap}" != *'/origin-migration'* ]]; then
  pass '/sitemap.xml excludes /origin-migration'
else
  fail '/sitemap.xml must exclude /origin-migration'
fi

# A tab open across a deploy still has `import()` calls pointing at chunk hashes
# the new build dropped, so the HTML has to be `no-cache` or a fresh navigation
# could be served a stale document out of the browser's heuristic cache. The
# missing-asset row is the regression guard for `$uri` vs `$request_uri`: keyed
# on the wrong variable, a 404 for a hash a later deploy could reissue would
# cache `immutable` for a year instead.
check_header / cache-control 'no-cache'
check_header "${bundle}" cache-control 'public, max-age=31536000, immutable'
check_header /assets/gone-0000000000000000.js cache-control 'no-cache'

check_header /robots.txt content-type 'text/plain'
check_header /sitemap.xml content-type 'text/xml'

# `always` on both `add_header` directives is the only reason these survive a
# redirect or an error response. The hashed bundle is in this list too — it is
# the one path served out of the `map`-selected cache-control block rather than
# the top-level `server` one, so it is the row that would actually catch a
# location-level `add_header` stripping these on a JS asset.
for path in / /learn/ /nonsense "${bundle}"; do
  check_header "${path}" content-security-policy "frame-ancestors 'self'"
  check_header "${path}" x-content-type-options nosniff
done

printf '\n'

if ((failures > 0)); then
  printf 'check-cflop-serving: %d failure(s)\n' "${failures}"
  exit 1
fi

printf 'check-cflop-serving: all rows served as expected\n'
