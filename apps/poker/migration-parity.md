# Poker Lab migration parity

The UI baseline is Poker main `dbfd67b6e61d2acea5ea838f2d1c0161450b6cd9`.
`migration-baseline.json` records the source identities for retained controller,
completion, scoring, watch, queue, review, card, scroll, and CSS modules. The
shared React controls resolve to the packages in this monorepo.

Retained source files preserve their original bytes, including upstream
whitespace. Consequently, `git diff --check` reports whitespace in those imports;
the authored-file check passes separately. The source-hash test guards retained
identity rather than silently reformatting the compatibility baseline.

`test:legacy` rebuilds these React adapters for the original JavaScript VM tests
and runs them against the migrated controller files in a temporary fixture.
The fixture reconstructs the classic-script bootstrap expected by those tests;
the app itself loads the adapters before the controllers through its Vite entry.
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

## Inherited dataset-switch limitation

Creating or switching a dataset can leave Capture and Record disabled until a
controller redraw or page reload. This reproduces with the retained controller
in the isolated browser fixture: `switchDataset()` redraws while
`datasetSwitching` is true, then clears the flag in `finally` without another
redraw. The migration preserves this source behavior. Reload Collection after
switching if the controls remain disabled.

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

The updated frontend measures 45.70% statement and 46.76% function
coverage, with integer floors of 41 and 43. Assistant coverage separately measures
76.07% statements and 69.64% functions, with floors of 76 and 69.

## Standalone region editor

The separate `regions.html` entry ports `dev_tools/region_definer.py` from the same
`dbfd67b` baseline. Run `pnpm --filter @unimatrix/poker-app dev:regions` for the
Vite entry, or `pnpm --filter @unimatrix/poker-app tauri:regions` for the desktop
window. It adds no Poker Lab rail destination or toolbar action.

The editor retains the 80-region ordering, first-undefined selection, source-pixel
rectangles, cursor-anchored zoom, middle-button or Alt-drag pan, image navigation,
video seek and 1/30-second frame steps. Tab advances to the next undefined region;
Delete or Backspace clears the selection; Space toggles video playback. Reference
images and videos are selected with the file picker instead of a Flask-served
screenshot directory. Media stays in browser object URLs. Export dimensions use
the first sorted image, or the original 1920×1080 default for video-only media.

Flat drafts autosave through the typed `/api/editor/regions` native adapter.
Saves are serialized, failures remain visible, and export waits for pending saves
before requesting the shared active nested JSON. Browser fixtures establish editor
interaction and request behavior; actual XDG persistence and active region export
remain native acceptance checks.

Editor drafts and exports preserve signed and out-of-image coordinates as the original tool does. Capture admission validates active rectangles before reading pixels; the editor never silently clamps a drawn box.

## Requested presentation changes

Review actions use shared icon buttons and checkboxes; Shift previews enlarge
the crop with its original aspect ratio. Redundant source-panel helper copy and
the branch selector's extra active-branch line are omitted. The retained watch
suite's summary-text assertion now checks the intentionally removed element;
its dynamic interval-status assertion remains.

Gameplay derives suit and in-play metadata from the recording's original pixels
and saved configuration. It hides only seats classified explicitly out of play;
unknown evidence remains visible. Ranks and recorded OCR rows are unchanged.
These read-time annotations are cached and do not relabel recordings.

The shared font is GeistMono Nerd Font. Browser checks verify the self-hosted
font assets and actual Nerd glyph rendering. Native development checks verify
IPC, real crop media and Vite module updates without a page reload. Cached
startup and UI changes avoid native builds; native source changes and explicit
worktree switches can replace the process.
