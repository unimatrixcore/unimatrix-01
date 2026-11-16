# Poker Lab

The desktop app uses the shared Rust Lab service and monorepo UI. Retained controller compatibility is tracked in `migration-baseline.json` and `migration-parity.md`. Fixture checks, browser behavior, physical capture, OCR accuracy and actual recording acceptance are separate evidence requirements.

The storage contract preserves the original directories: `$XDG_DATA_HOME/poker`
for datasets, models and `gameplay_recordings`, and `$XDG_CONFIG_HOME/poker` for
configuration. With unset XDG variables, these resolve to `~/.local/share/poker`
and `~/.config/poker`. Poker Lab keeps its `webview/poker-lab` browser profile
under the data directory. The migrated apps reuse existing files at those paths;
no import, copy or additional `unimatrix` directory is required. An optional
backup/import helper is separate from normal startup. Tests use isolated
directories; the path contract alone does not establish live-data acceptance.

Gameplay and OCR Training occupy the primary rail. Settings opens the read-only
OCR Benchmark archive; its original controllers remain covered by the retained
VM suites. The archive does not initialize capture or labeling controllers.
The UI uses this monorepo's shared components and styles.

Gameplay keeps recording selection and editing on the right of its top bar.
The normal recording menu includes imported recordings alongside captured ones.
Recording controls appear only in the Recording view; switching views does not
stop the recording controller. AI uses the Benchmark review workflow through a
Gameplay adapter, with a focused crop queue and revision-checked corrections.
Opening AI reads persisted state without preparing crops or requesting a review.
Global cache reuse and manual correction propagation belong to the native ledger,
not browser state.

Start and Resume request crop preparation followed by ChatGPT review through
persisted native intent. The manual queue appears after the AI job completes.
Opening the view or reading status never starts provider work; API callers that
omit `review_after_prepare` retain preparation-only behavior. Pause remains pending
until acknowledged by the native ledger. Fake-provider tests exercise the handoff;
fixture timing does not measure live native pause latency. Request limits are
cumulative per review job. A run
that reaches its limit requires an explicitly larger limit before it can continue;
Resume can explicitly update the same job's cumulative ceiling and preserves its
usage and saved responses; it does not create a fresh budget. Unknown provider
outcomes block automatic retry.

The current profile is fixed at 1920×1080 with 95 OCR targets and nine CV
contexts. `tools/poker/mock-regions/profile.mts` derives geometry offline from the
private mock DOM/CSS; native localizers resolve fields from live frame pixels.
The bundled profile needs no running mock. Cards reach local OCR, including weak
fits and hidden-card targets, except at seats proven empty from source-specific
pixels. Automatic card verification additionally requires source-supported glyph
evidence; a blank cannot override supported visible card foreground. Frame previews
use the effective profile while retaining captured configurations and predictions.
Other viewports require their own supported profile, never scaling this one.

Gameplay stores content-addressed opaque RGB crops and occurrence context in the
persistent app-wide `ocr-evidence.sqlite3` ledger. Exact reuse checks semantic
family, pixels and current evidence policy. Near reuse requires unchanged pixels
under conservative padding translation; perceptual similarity alone cannot transfer
a label. Automatic acceptance requires two matching blind readings plus current
contract and source-support checks. Manual occurrence decisions remain explicit.
See `packages/poker-native/src/lab/gameplay/evidence_cache.rs` and
`packages/poker-native/src/lab/ai_review/protocol.rs` for admission rules.

Quarantined jobs cannot resume or supply automatic cache truth. Explicit recovery
creates a new job and revalidates saved raw readings against original request-guide,
pixel, sample, family, model and contract evidence. Missing evidence requires fresh
bounded reads; an unknown provider outcome blocks recovery. The original job and
paid evidence remain quarantined. See `packages/poker-native/src/lab/ai_review/recovery.rs`.

Legacy Benchmark import follows `tools/poker/legacy-benchmark.md`: saved labels
and explicit reviewed blanks remain occurrence-owned `legacy_verified` readings
with `source: legacy` and `visually_verified: false`. Pending predictions and new
missing fields remain unverified. Migration does not start bulk ChatGPT review;
Import preservation and real-recording AI acceptance are validated independently.

The native boundary uses `lab_request` for operations and `lab_list_page` for
catalog reads, with request and response schemas in `@unimatrix/shared`. Dataset
identity travels with each scoped request. Media responses use the local
`pokerlab` protocol. The separate Poker Assistant uses the shared native crate.

List cursors belong to their dataset, resource, filters and sort order. A cursor
conflict means the catalog changed and the query must restart from its first page.
Gameplay summary reads separately retry evidence/profile conflicts at most twice,
with cancellation-aware backoff. Review decisions and other writes are not retried.
Unchanged Games and Frames reads reuse summaries while evidence, profile and
recording epochs match. First loads and reads after invalidation rebuild them;
private-copy backend measurements do not establish native UI latency.
Gameplay hands and frames retain the first page's capture ceiling until explicit
refresh, so recording cannot move the history being browsed. IPC pages accept at
most 500 rows; queue, review and AI result reads retain their smaller native caps.
The dataset registry is a JSON catalog read in memory before its bounded IPC
page is selected; database-backed catalogs apply SQL limits before collecting
rows. The local-window-only memory command uses the shared desktop runtime.
OS memory telemetry is supported on Linux; the shared list policy supplies its
fallback when the operating system helper is unavailable.

The Poker adapters retain their existing Tauri argument shapes: Lab sends `request`,
the launcher sends `operation` and `selection`, and Assistant commands have their
own arguments. `@unimatrix/tauri`'s command client wraps arguments in `input`, so
using it requires changing both sides of these IPC contracts. The adapters validate
their responses with `@unimatrix/shared` and keep browser fixtures isolated.

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
