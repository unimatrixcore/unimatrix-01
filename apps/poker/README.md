# Poker Lab migration

The compatibility baseline is the Poker repository's `main` worktree at revision `dbfd67b`. The repository-root checkout is detached at an older revision and does not describe the installed app.

The desktop app uses the shared Rust Lab service, with the original controller behavior and shared monorepo UI. Repository checks, original behavior suites, browser workflows and isolated native WebView checks cover the migrated application. Fresh physical capture and CUDA accuracy remain separate acceptance checks.

The storage contract preserves the original directories: `$XDG_DATA_HOME/poker`
for datasets, models and `gameplay_recordings`, and `$XDG_CONFIG_HOME/poker` for
configuration. With unset XDG variables, these resolve to `~/.local/share/poker`
and `~/.config/poker`. Poker Lab keeps its `webview/poker-lab` browser profile
under the data directory. The migrated apps reuse existing files at those paths;
no import, copy or additional `unimatrix` directory is required. An optional
backup/import helper is separate from normal startup. Tests use isolated
directories; the path contract alone does not establish live-data acceptance.

Poker Lab retains the poker-chip logo, the OCR Data and Gameplay rail sections, and the Collection / Labeling / Review / Database workflow. Proven behavior modules remain in JavaScript while the Vite entry, shared UI integration and native boundary use TypeScript. The UI imports this monorepo's actual shared components and styles.

The native boundary is `lab_request`, with request and response schemas in `@unimatrix/shared`. Dataset identity travels with each scoped request. Media responses use the local `pokerlab` protocol. The separate Poker Assistant uses the shared native crate.

The current model suggestions use the frozen general and name-specialist ONNX models. The retained inference and training tooling is under `tools/poker`; the legacy assistant's RTen models are not a substitute for those models. Inference remains an isolated Python worker until equivalent preprocessing, decoding, frozen-artifact validation and CUDA placement are demonstrated in Rust. Portable application services run in the shared Rust crate.

Development commands:

```sh
pnpm --filter @unimatrix/poker-app tauri dev
pnpm --filter @unimatrix/poker-app dev:x11
```

The browser test mode uses isolated adapters and must not spend on AI review or mutate live datasets. Fresh monitor/window capture and OCR accuracy require independent physical validation. Keep original data and model artifacts intact throughout migration.

The desktop launcher is `apps/poker/scripts/launch.ts`, run with Node 24 and
`--git-dir` pointing to the repository's absolute Git common directory. Its
default selection, Latest commit, chooses the eligible active worktree with the
newest commit timestamp and keeps that worktree's uncommitted changes. The
bottom rail branch menu can select another active worktree. Its tooltip identifies
the running branch and any requested replacement; the expanded control shows only
the selected option.

The launcher opens a verified cached native app with an owned Vite development
server. UI, stylesheet, font and asset edits update in the existing WebView;
they do not rebuild or restart the native process. Only Rust/native build inputs
trigger a background Cargo build. A validated replacement starts after the prior
process exits; a failed build leaves the running app in place. Branch changes
switch the native app and Vite root together. Closing the app closes its
supervisor and owned Vite server. No branch is checked out, reset, pulled or committed.

Selection persists in `$XDG_CONFIG_HOME/poker/launcher.json`; runtime status and
native binaries use `$XDG_CACHE_HOME/poker` (fallback `~/.cache/poker`). Persistent
`native-dev` manifests bind each worktree's development binary, native-source
fingerprint and checksum. Unchanged startup uses that cache without Cargo or a
production Vite build. A missing cache requires one native build. Native builds
share `native-target` unless `CARGO_TARGET_DIR` overrides it.
On Linux, available `strip` removes debug information from newly staged ELF
runtime copies before checksumming them. The original build output keeps its
debug information; a missing or failed strip tool preserves the complete copy.
`POKER_LAB_PREFERRED_WORKTREE` supplies the initial worktree preference when
commit timestamps tie, including when the launcher script is installed outside
the checkout. `--status` prints current, desired and available worktrees as JSON;
`--select latest` or `--select <worktree identity>` persists a validated selection.
To preseed the selected worktree, build `cargo build -p unimatrix-poker
--no-default-features`, then pass `--seed-native <absolute development binary>`
to the launcher. Development binaries use the local Vite origin; the launcher
removes `POKER_LAB_BUNDLED` from their environment.

The development UI uses `http://localhost:5180`; bundled builds use
`pokerlab://localhost`. Browser-only preferences are separate for these origins,
so switching modes can require selecting the working dataset once. Datasets,
labels, queues, recordings and native configuration use the same XDG stores.
