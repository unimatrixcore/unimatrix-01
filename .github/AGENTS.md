# AGENTS.md — CI and Dependabot mechanics

Loaded when working in `.github/`. The root `AGENTS.md` keeps only the rules that bind everywhere;
this file holds the mechanics, each of which was learned the hard way.

## Dependabot

- Dependabot runs daily with a 14-day `cooldown`; `pnpm-workspace.yaml` sets `minimumReleaseAge` to
  3 days. The pnpm value must stay **below** Dependabot's, or updates fail with a misleading "no
  matching version" error.
- All three ecosystems set a `cooldown`: 14 days for `npm` and `docker`, **7 days for
  `github-actions`** — an action bump is a SHA change against a public, reviewable repo rather than
  an opaque registry tarball, and frequent releasers like `github/codeql-action` make a long window
  costly. `github-actions` supports only `default-days`; the `semver-*-days` keys are not valid
  there, and an unsupported key makes Dependabot reject the whole file, silently disabling npm
  updates too.
- **Dependabot's npm updater runs inside its own image — Node 24, pnpm 10.16.0, npm 11.17.0**
  (`npm_and_yarn/Dockerfile` in dependabot-core). Root `engines.node` must stay satisfiable by
  *their* Node, not ours: it was `>=22 <23` with `engine-strict=true` in `.npmrc`, and every npm job
  errored with "Dependabot does not support your Node version" — no npm PR was ever opened, for the
  repo's entire life, while the github-actions ecosystem worked fine because it needs no Node. It is
  now `>=22`, an open-ended floor, so a future Dependabot Node bump cannot re-break it. The real pin
  for humans and CI is `.node-version` plus CI's `node-version-file`, not `engines`.
- `minimumReleaseAge` needs pnpm >= 10.16 and Dependabot ships exactly **10.16.0** — no margin. If
  they ever ship older, that setting silently becomes a no-op.
- **Check `/network/updates` (Insights → Dependency graph → Dependabot) after touching anything
  Dependabot reads.** The `.github/dependabot.yml` status check on a PR proves only that the *file
  parses*; it says nothing about whether the updater can run. A rejected config looks exactly like a
  quiet week.
- Auto-merge is armed for grouped minor/patch Dependabot PRs only, and gates on CI rather than on
  any review.

## CI

- `Verify` always runs repository guards, then filters workspace tasks on PRs
  through `infra/scripts/ci-plan.mjs`. Main/manual runs and uncertain comparisons
  select everything. Keep required check names reporting on every PR; workflow
  path filters can leave required checks pending forever. Browser setup and
  Lighthouse follow the same plan, but image checks remain unconditional.
- Turbo caches static tasks; tests and the host-SDK-dependent TV build run fresh.
  Only successful main runs save the bounded cache, and PRs only restore it.
  `pnpm check:ci` proves selection failures, required coverage artifacts, and
  invalidation when shared configuration sources change.
- CI's `Images` job builds every `apps/*/Dockerfile`. The required status checks on `main` are
  whatever GitHub’s `rules/branches/main` API reports rather than a list here. This exists because `Verify` is Vite and tsc only and never touches
  a Dockerfile, so a dependency could pass every check while making the deployable image unbuildable.
  `better-sqlite3@13` is the live example: no published prebuilds, so it falls back to `node-gyp` and
  dies on alpine. **If you add a Dockerfile, add it to the matrix and to the required checks, or it is
  unverified.**
- `infra/scripts/check-app-wiring.sh` (run by `pnpm check`/`pnpm verify` and by the `App wiring`
  step in `Verify`, placed before `pnpm install` because it needs no `node_modules`) is the
  mechanical guard on four things nothing else sees: an `@source` line resolving to
  `packages/<name>/src` for every `packages/*` dependency that ships a `.tsx`, `@tanstack/react-router`
  in its vite `dedupe`, every `apps/*/Dockerfile` appearing in **every** `app: [...]` matrix array
  in `ci.yml` — today that is `Images` and `Publish`, and an app present in one and missing from the
  other fails naming which matrix (`matrix #1`, `matrix #2`, ...) it is missing from — and every
  `infra/docker/<app>-compose.yaml` pulling the `ghcr.io/unimatrixcore/unimatrix-<app>` image
  `Publish` pushes for that app, which is the only thing anywhere comparing the two spellings of
  that registry path. It walks
  `apps/*` only, so `lab` carries the first two requirements unchecked. It is also the app template,
  but only for an app it can classify: a new Vite or Dockerized app satisfies it or the check goes
  red, while an `apps/*` directory with neither `vite.config.ts` nor `Dockerfile` is skipped and
  passes.
- `Publish` builds and pushes affected `apps/*/Dockerfile` images to
  `ghcr.io/unimatrixcore/unimatrix-<app>` on a push to `main`; manual `workflow_dispatch` publishes
  all images from any branch. Only the push-to-`main` path moves the `:main` tag.
  `infra/scripts/deploy-plan.mjs` derives dependencies from current and deployed workspace manifests
  and compares each service's fresh verified running commit with the target tree. Publish and Deploy
  consume the same run-bound plan; Deploy revalidates skipped baselines before mutations. Missing
  provenance or comparison history selects conservatively. CI ingress must allow the authenticated
  `GET /deployment/baselines` read or every service is selected. The full `app: [...]` matrix must match
  `Images`' — `check-app-wiring.sh` above enforces that across both. It is deliberately not a
  required check: it never runs on `pull_request`, so arming it would create a required check that
  is permanently green on every PR without verifying anything there.
- `Deploy` follows `Publish` on a push to `main` alone. It reserves durable attempts and requests
  `/deployment/execute`; the deploy service writes each service's `IMAGE_TAG` and queues Dokploy.
  The next affected deployment replaces that service's rollback target. Actions must never fall back to
  project tag writes or direct queue mutations: that would bypass the reservations shared with
  rollback. Missing activation or reporting configuration fails closed. A green `Deploy` proves
  queue acknowledgement, not that the image is serving. The job retains Dokploy credentials only
  for read-only mapping and the web/status domain cutover guard; never print their response bodies.
  `docs/deployment.md` carries activation and rollback constraints.
- The remaining guards, each aimed at one kind of drift.
  `check-stale-comments.mjs` (`Stale comments`) fails when a backticked
  `PascalCase` name in a comment exists in no code; an "occluder" mechanism was deleted and five
  comments across four workspaces outlived it. `check-coverage-drift.mjs` (`Coverage drift`) runs
  **after** tests because it requires each selected Vitest workspace's
  `coverage/coverage-summary.json`, and
  fails when a floor sits more than 5 points under the measurement — `packages/auth` gated at 26
  while measuring 73.84. The 5 points are deliberate: V8 re-attributes functions between Node
  majors, so a floor pinned to the exact figure reddens on the next runtime bump for no real reason.
  `Deploy config` (`check:deploy-config`, **after** `Install dependencies`, unlike the other bash/
  plain-Node gates above) is the only thing that reads `apps/*/Dockerfile` and
  `infra/docker/*-compose.yaml` at all: `Images (*)` builds each Dockerfile directly and never opens
  a compose file, so one that stops passing env into a perfectly good image is green everywhere until
  the deployed container restart-loops — the API once shipped with no `CLERK_*` under `environment:`
  and every required check passed. It runs `infra/scripts/validate-deploy-config.mjs` (pairing in
  both directions between `apps/*/deploy.config.ts` and the generated files, plus the API env probe
  against the real `loadApiRuntimeConfig`) and then `infra/scripts/generate-deploy-config.mjs --check`
  (regenerates in memory and diffs against what is committed) — see `packages/deploy-config/AGENTS.md`.
  It needs `node_modules` (it imports `@unimatrix/deploy-config` and `apps/api/src/config.ts` by
  absolute path, and `generate-deploy-config.mjs --check` formats through prettier's API), which is
  why it runs after install rather than in the pre-install band the check it replaced used.
  `check-runner-labels.mjs` (`Runner labels`) allowlists every `runs-on:`
  value rather than grepping for `self-hosted`, because a runner is targeted by label and
  `runs-on: my-homelab` reaches one without the string ever appearing; it enforces naming only and
  cannot see what hardware a label routes to, and a *remote* reusable workflow carries a `runs-on:`
  in a file it can never read.
  `check-doc-script-refs.sh` (`Doc script references`, placed pre-install with the other bash gates)
  fails when a tracked `.md` names a `.sh`/`.mjs` file no tracked file provides — a doc naming a
  script this repo does not ship asserts config no reviewer can see and no clone gets. It is a
  ratchet on the next doc rather than an audit: it resolved every reference on `main` the day it
  landed, and a prose claim that names no file is invisible to it.
- Each was validated by breaking it on purpose, not by watching it pass. A check that
  cannot be shown to fail is not known to work.
- **`Verify` shellchecks every tracked `*.sh`, and nothing local does.** `pnpm check` and
  `pnpm verify` do not run it — measured, they differ by one word and neither word is this one — so
  an agent can edit a script, watch the normal gate go green, and redden a required check on a lint
  it never saw. Run `shellcheck` yourself on any script you touch. It is not installed on the
  owner's machine, and `pnpm dlx shellcheck` downloads whatever ShellCheck is current — 0.11.0 as of
  2026-07-31, against the runner image's 0.9.0. **There is no local way to match CI exactly**: the
  npm wrapper's versions are its own (4.1.0), not ShellCheck's, and its documented
  `SHELLCHECKJS_RELEASE` pin does not take — `v0.9.0` on a clean cache still installed 0.11.0. So a
  clean local run is a strong hint and CI is what decides.
- Two workflows serve `lab`. `Prototypes guard` (job `No prototypes on main`) runs on **every**
  pull request to `main` with no `paths:` filter and fails when the diff adds a file under
  `lab/prototypes/` — the `.gitkeep` and `README.md` scaffolding are allow-listed. The filter is
  omitted deliberately: a path-filtered workflow that does not run reports nothing, and a required
  check that never reports blocks a PR forever instead of passing it. This is repo hygiene, not a
  security control. `Lab` runs lint + typecheck of `lab/src` on `lab/**` branches; full `Verify`
  there would fail on coverage thresholds and burn minutes for nothing. `No prototypes on main` is a
  required check on `main`; `Lab` is not armed.
- Several workflow settings that look redundant are load-bearing and carry a comment saying why.
  Read the comment before removing one.
