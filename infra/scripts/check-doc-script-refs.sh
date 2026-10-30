#!/usr/bin/env bash
#
# A tracked doc must not name a script file this repo does not contain.
#
# Naming `foo.sh` in a committed `.md` reads as "this repo has foo.sh". When it
# does not, the doc is asserting config that lives only on one machine: no
# reviewer can check it, no clone gets it, and the reader's only way to find out
# is to run something that is not there. That is the drift this fails on.
#
# The check: every `<name>.sh` / `<name>.mjs` token in a tracked `*.md` must
# match the basename of some tracked file. Basename rather than path on purpose
# — docs name scripts inline in prose (`check-app-wiring.sh`) as often as by
# path, and a path check would fail on the former for no real reason.
#
# What it does NOT catch, because the doc names no file:
#
#   * a prose claim about machine-local config that names no file here.
#     Nothing mechanical sees it; labelling those is on the author.
#   * whether a script that does exist is registered, wired into CI, or called
#     by anything at all.
#
# So this is a ratchet on the next doc, not an audit of the current ones.
#
# Fails closed: zero tracked `*.md` files, or zero tracked files at all, is a
# failure rather than a vacuous pass — as does a `grep` that fails for any reason
# other than finding nothing.
#
# Assumes GNU bash 4+ and GNU coreutils, as `check-app-wiring.sh` does.
# CI runs ubuntu-24.04.

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  # Header block by shape, not by line number: a fixed range silently truncates
  # or over-runs the moment the comment above is edited.
  sed -n '2,${/^#/!q; s/^# \{0,1\}//; p;}' "${BASH_SOURCE[0]}"
  exit 0
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

cd "${repo_root}"

failures=0

fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

printf 'check-doc-script-refs: every script named in a tracked .md must exist here\n\n'

# The universe of names a doc is allowed to use: the basename of every tracked
# file, not just `infra/scripts/*`. Docs legitimately name `eslint.config.mjs`,
# `boundaries.mjs` and the other tracked infrastructure helpers.
declare -A tracked_basenames=()
tracked_count=0

while IFS= read -r -d '' tracked_file; do
  tracked_basenames["$(basename "${tracked_file}")"]=1
  tracked_count=$((tracked_count + 1))
done < <(git ls-files -z)

if ((tracked_count == 0)); then
  fail "git ls-files returned nothing — the check cannot pass vacuously"
  printf '\ncheck-doc-script-refs: 1 failure\n'
  exit 1
fi

doc_count="$(git ls-files -- '*.md' | wc -l)"

if ((doc_count == 0)); then
  fail "no tracked *.md files found — the check cannot pass vacuously"
  printf '\ncheck-doc-script-refs: 1 failure\n'
  exit 1
fi

# Working tree, not HEAD: an uncommitted doc edit is exactly what this should
# catch before it is committed.
#
# `grep` exits 1 for a doc naming no script, which is legitimate, and 2+ when it
# actually failed. Only the first is swallowed: a blanket `|| true` here would
# turn a broken scan into `0 script reference(s), all resolved` — a green check
# over documents nobody read, which is the one wrong answer this must never give.
# The status is collected through a file rather than a process substitution
# because a substitution's exit status is invisible to the shell that reads it.
scan_docs() {
  local doc status
  while IFS= read -r -d '' doc; do
    grep -onHE '[A-Za-z0-9._-]+\.(sh|mjs)' -- "${doc}" && continue
    status=$?
    if ((status != 1)); then
      printf 'grep failed on %s with status %d\n' "${doc}" "${status}" >&2
      return "${status}"
    fi
  done < <(git ls-files -z -- '*.md')
}

scan_output="$(mktemp)"
# shellcheck disable=SC2064  # expand now: the path must survive the function's scope
trap "rm -f '${scan_output}'" EXIT

scan_docs >"${scan_output}"

refs=0
while IFS= read -r hit; do
  [[ -n "${hit}" ]] || continue
  refs=$((refs + 1))

  # grep -onH emits `file:line:match`; the match cannot contain a colon.
  name="${hit##*:}"
  location="${hit%:*}"

  if [[ -z "${tracked_basenames[${name}]:-}" ]]; then
    fail "${location}: names '${name}', which no tracked file in this repo provides"
  fi
done <"${scan_output}"

printf '\n'

if ((failures > 0)); then
  printf 'check-doc-script-refs: %d failure(s) — a doc naming a script this repo does not ship is asserting config nobody can review\n' "${failures}"
  exit 1
fi

printf 'check-doc-script-refs: %d script reference(s) across %d tracked .md files, all resolved\n' "${refs}" "${doc_count}"
