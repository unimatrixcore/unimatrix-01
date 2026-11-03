#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: ./infra/scripts/pnpm-with-pinned-node.sh <pnpm-args...>" >&2
  exit 1
fi

# pnpm selects the exact workspace runtime before commands and dependency builds.
node_pin="$(tr -d '[:space:]' < "${repo_root}/.node-version")"
pnpm_pin="$(node -p 'require(process.argv[1]).packageManager.split("@").pop()' "${repo_root}/package.json" 2>/dev/null || echo "")"

if [ -z "${node_pin}" ] || [ -z "${pnpm_pin}" ]; then
  echo "pnpm-with-pinned-node: could not read the Node/pnpm pins from .node-version and package.json" >&2
  exit 1
fi

pnpm_version=""

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(cd "${repo_root}" && pnpm -v 2>/dev/null)" || pnpm_version=""
fi

if [ "${pnpm_version}" = "${pnpm_pin}" ]; then
  echo "pnpm-with-pinned-node: using pnpm ${pnpm_pin} with workspace Node ${node_pin}" >&2
  cd "${repo_root}"
  exec pnpm "$@"
fi

echo "pnpm-with-pinned-node: bootstrapping pnpm@${pnpm_pin} with workspace Node ${node_pin} via npm exec" >&2
cd "${TMPDIR:-/tmp}"
# shellcheck disable=SC2016  # `$1`/`$@` belong to the inner `sh -c`, not to this shell.
exec npm exec --yes --package="pnpm@${pnpm_pin}" -- sh -c 'cd "$1" && shift && exec pnpm "$@"' sh "${repo_root}" "$@"
