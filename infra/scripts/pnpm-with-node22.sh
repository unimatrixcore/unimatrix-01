#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: ./infra/scripts/pnpm-with-node22.sh <pnpm-args...>" >&2
  exit 1
fi

NODE_PACKAGE="node@22.22.1"
PNPM_PACKAGE="pnpm@10.30.3"

node_major=""
pnpm_version=""

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "process.versions.node.split('.')[0]")"
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm -v)"
fi

if [ "${node_major}" = "22" ] && [ "${pnpm_version}" = "10.30.3" ]; then
  echo "pnpm-with-node22: using local Node 22.x and pnpm 10.30.3" >&2
  cd "${repo_root}"
  exec pnpm "$@"
fi

echo "pnpm-with-node22: bootstrapping node@22.22.1 and pnpm@10.30.3 via npm exec" >&2
cd "${TMPDIR:-/tmp}"
exec npm exec --yes --package="${NODE_PACKAGE}" --package="${PNPM_PACKAGE}" -- sh -c 'cd "$1" && shift && exec pnpm "$@"' sh "${repo_root}" "$@"
