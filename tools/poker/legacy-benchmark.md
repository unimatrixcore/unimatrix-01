# Legacy Benchmark migration

The native `legacy_benchmark` example plans conversion from the collector registry into the active Gameplay store. Planning opens SQLite only on temporary copies, including the committed WAL when present. It checks source database and sidecar hashes before and after planning; a changing source is rejected. Original dataset directories, registry flags, databases and image files remain untouched.

Create a fresh private plan with benchmark writers stopped:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node infra/scripts/run-local-workload.mjs -- \
  cargo run -p poker-native --example legacy_benchmark -- registry-plan \
  "$HOME/.local/share/poker/collector_datasets/datasets.json" \
  /path/to/private/legacy-benchmark-plan.json /path/to/private/archived-regions.json
```

The output path must be new. Plans contain private labels, source paths and queue/review evidence; keep them in ignored private storage. `plan <sources.json> <new-plan.json> [recovered-region-files ...]` accepts explicit `[{"id":"stable-source-id","name":"Source name","directory":"/absolute/source/path"}]` instead of the registry. Changing a source identity creates a different import identity; do not rename source identities to bypass a revision conflict.

Planning reads full-frame PNGs to retain their hashes and dimensions. It does not open a destination, run OCR, call a provider or perform a new visual review. Version 2 plans apply the owner-authorized `occurrence_owned_legacy_annotations_v2` trust policy; version 1 plans are rejected at apply. Recovered region configurations are attached only when their Python sorted-JSON MD5 matches the saved source digest. Use recovered files from the region archive or another preserved source snapshot: startup archives the old `regions.json`. Unknown configurations remain unresolved. Original timestamps and monitor/configuration metadata are preserved; filename resemblance does not establish capture provenance.

The explicit apply command is:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node infra/scripts/run-local-workload.mjs -- \
  cargo run -p poker-native --example legacy_benchmark -- apply \
  /path/to/private/legacy-benchmark-plan.json "$HOME/.local/share/poker/gameplay_recordings" --apply
```

The destination must already exist and must not overlap a source. Apply checks source receipts and each PNG hash, publishes deterministic frame files, then commits native sessions/frames and unique origin records transactionally. An unchanged rerun reuses imported origins. A changed source, conflicting destination identity or corrupted published PNG fails instead of overwriting evidence. Published files left by an interrupted transaction can be reused after hash verification. Existing recordings, OCR states, user corrections and archive flags are preserved. Import opens the store without running unrelated pending-OCR startup recovery. Source annotation pixels use the content-addressed pixel-asset helper in the same transaction as their occurrence-owned labels.

`Legacy Benchmark` is a collection in the same Gameplay store. Each source dataset becomes a stopped recording because the source corpus does not establish original recording boundaries or a regular capture cadence. `interval_ms: 0` denotes unknown/sparse cadence. Games use unambiguous stored hand-ID evidence, with one rendered `#` prefix removed and surrounding whitespace trimmed; nonnumeric identifiers, original labels and conflicts remain in provenance. Missing or conflicting IDs stay unassigned. Queue-only game-ID predictions never assign a hand, even when they name an available frame; their raw candidates remain evidence.

Every available full-capture row becomes one frame, including captures that retained no crops. Deduplicated sparse crop rows are annotations, not separate gameplay frames. Null/dangling crop links, missing or invalid full-frame pixels, orphan files, queue-only sources and review events remain explicit ledger evidence. Missing full frames are never reconstructed from crops. Original review events retain their source evidence; migration does not promote them into global verification-cache hits.

Imported frames retain original PNGs, timestamps, configuration and incomplete OCR status. Saved annotations and explicit reviewed blanks become `legacy_verified` readings with `source: legacy`, preserving label strings verbatim and `visually_verified: false`. Their provenance pins the source database receipt, capture/crop records, configuration digest, semantic region, original rectangle, PNG/pixel identities and target profile hash. A blank string is verified evidence, not a missing label. Pending queue predictions are not annotations.

A source label projects only when its recovered configuration, original crop bounds and source-frame pixels agree and its semantic mapping is unambiguous. Conflicting labels and uncertain links remain unresolved. New suits, the table line and other missing fields remain unverified. Frame, game and list summaries expose legacy verification before preparation. Original OCR completion remains separate.

Preparation creates occurrence-owned legacy readings without a provider queue entry or shared label-cache alias. Review displays the original legacy crop without current tight-crop guides; that crop is not asserted pixel-equivalent to a current tight crop. New missing fields use normal preparation, while an explicit current manual decision takes precedence and survives rerun/restart. Migration starts no provider work.

## Profile and verification boundaries

Generate the active profile with `tools/poker/mock-regions/profile.mts` from the
private mock DOM/CSS. The active CLI fixes the viewport at 1920×1080 and rejects
`--legacyConfig` and `--geometryBase`; it uses the established source seat mapping
`(legacy seat + 3) % 9`. The bundled profile retains legacy seat identities without
an additional rotation. Preserve archived configurations and frame snapshots as
source evidence. Current pixel localizers, masks and card sampling are described
in `tools/poker/mock-regions/README.md`.

Source allocations are search bounds, not accepted label images. Nearby text,
cards, dealer markers and panel corners must not be concatenated into the intended
field. Synthetic controlled-state labels and visibility cannot establish real-frame
verification. Pixel storage deduplication does not transfer legacy annotations to
another occurrence or to a current tight crop.

Migration and real-recording AI validation are independent. Verify import
preservation and label provenance separately from AI accuracy and manual releases.
Do not run a legacy bulk ChatGPT review: pending predictions and newly introduced
fields remain unverified until separately reviewed. Keep live acceptance progress,
private receipts and source inventories in an ignored handoff; publish an outcome
only after the actual run and preservation checks finish.

## Check pointers

These checks exercise implementation boundaries; they do not establish that the
real migration or full-recording acceptance passed:

- `packages/poker-native/tests/legacy_benchmark.rs`: source snapshots/WAL,
  missing evidence, trusted hand IDs, version conflicts, apply/rerun and preservation.
- `packages/poker-native/tests/gameplay_migrated_readiness.rs`: native collection,
  recording, game, frame, original-image and review routes; legacy text/blanks,
  missing fields, manual precedence, restart and idempotence. Its optional
  `POKER_MIGRATED_RESPONSE_FIXTURE` output belongs in ignored storage;
  `packages/shared/test/poker-gameplay-legacy.test.ts` validates exported responses.
- `apps/poker/test/gameplay-effective-regions.test.ts`: effective profile geometry
  and preservation of original predictions.
- `packages/poker-native/src/lab/gameplay/ai_tests.rs` and
  `evidence_cache_tests.rs`: verification summaries, exact reuse, occurrence-owned
  conflicts, quarantine, raw-reading recovery, same-job Resume budgets and the
  supported-card blank guard.
- `near_reuse_requires_unchanged_pixels_and_padding` in
  `packages/poker-native/src/lab/gameplay/regions.rs`: conservative near equivalence.

Run migration fixtures without opening live stores:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node infra/scripts/run-local-workload.mjs -- \
  cargo test -p poker-native --test legacy_benchmark --test gameplay_migrated_readiness
```
