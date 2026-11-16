# Poker Lab migration parity

The UI baseline is Poker main `dbfd67b6e61d2acea5ea838f2d1c0161450b6cd9`.
`migration-baseline.json` records the source identities for retained controller,
completion, scoring, watch, queue, review, card, scroll, and CSS modules. The
shared React controls resolve to the packages in this monorepo.

Retained source files marked `preserved` retain their original bytes, including upstream
whitespace. Consequently, `git diff --check` reports whitespace in those imports;
the authored-file check passes separately. The source-hash test guards retained
identity rather than silently reformatting the compatibility baseline. Adapted files
retain their upstream source hash and record the intentional target hash separately.
The controller autocomplete builds text nodes for typed and suggested labels so
label markup cannot become HTML; its score renderer runs directly because the
same render path requires that function unconditionally.

`test:legacy` rebuilds these React adapters for the original JavaScript VM tests
and runs them against the migrated controller files in a temporary fixture.
The fixture reconstructs the classic-script bootstrap expected by those tests.
The active app does not start the archived Benchmark controllers.
The Flask route integration test is excluded from this JavaScript suite. Native
route acceptance belongs to the Rust backend checks.

## Storage contract

The migrated apps preserve `$XDG_DATA_HOME/poker` and `$XDG_CONFIG_HOME/poker`,
falling back to `~/.local/share/poker` and `~/.config/poker`. Gameplay recordings
remain in the data directory's `gameplay_recordings` subdirectory; Poker Lab
retains `webview/poker-lab` there. Existing datasets, model artifacts and
configuration are reused directly, with no mandatory import or copy. Tests
override these roots with isolated directories. Matching defaults is a storage
contract; live-data and native WebView acceptance require their own checks.

Browser fixtures and VM tests exercise the UI and its persistence requests.
They do not establish live monitor/window capture or OCR accuracy.

## Validation split

Vitest measures the native TypeScript transport and a partial set of retained
React adapters. Its coverage floors were established for this migrated source;
they do not describe coverage of the classic JavaScript controllers. The
original VM suites exercise those controllers with their actual shared-UI
bundle, and browser tests check the integrated branding, navigation, controls
and workspace behavior. Native route and physical capture checks remain
separate from fixture UI evidence.

Each workspace's Vitest configuration owns its coverage floors.

## Requested presentation changes

Review actions use shared icon buttons and checkboxes; Shift previews enlarge
the crop with its original aspect ratio. Redundant source-panel helper copy and
the branch selector's extra active-branch line are omitted. The retained watch
suite's summary-text assertion now checks the intentionally removed element;
its dynamic interval-status assertion remains.

Gameplay previews use the effective current region profile and readings when
provided by the native service. Original frame OCR and configuration snapshots
remain available as evidence. Legacy color metadata is mapped to the canonical
visual seat before deciding which inactive seats to hide; unknown seats remain
visible. Fixture checks cover geometry replacement, separate suit labels and
Recording-only controls. Live region alignment and paid verification require
their own acceptance run.

The shared font is GeistMono Nerd Font. Browser checks verify the self-hosted
font assets and actual Nerd glyph rendering. Native development checks verify
IPC, real crop media and Vite module updates without a page reload. Cached
startup and UI changes avoid native builds; native source changes and explicit
worktree switches can replace the process.
