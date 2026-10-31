#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: check-status-serving.sh <image>}"
work="$(mktemp -d)"
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" > /dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT

container="$(docker run -d -p 127.0.0.1::8080 "$image")"
port="$(docker port "$container" 8080/tcp | cut -d: -f2)"
base="http://127.0.0.1:${port}"

curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 \
  "$base/" -o "$work/root.html"
grep -q '<title>Unimatrix Status</title>' "$work/root.html"

code="$(curl --silent --show-error -D "$work/headers" -o /dev/null -w '%{http_code}' "$base/status")"
[ "$code" = "308" ]
tr -d '\r' < "$work/headers" | grep -qi '^Location: /$'

printf 'status serving contract: root served; /status redirects to /\n'
