# OCR production candidate and evaluation

The selected candidate uses **v11 general OCR plus v13 high-resolution name OCR**,
both exported to ONNX. Runtime inputs preserve the original BGR pixels. The
production-facing API is `RealtimeCollector` in `realtime_collector.py`; it pins
both models, code, collector schemas, geometry, colors, CUDA execution and
freshness policy through a release manifest. The running Tauri capture path now uses this persistent CUDA service; legacy
RTen commands remain available only for explicit debug use. Suit and dimness
detection retain the existing color logic on the validated source pixels.

Release artifacts and measured evidence are under ignored
`$XDG_DATA_HOME/poker/ocr-training/release-candidate/` (default `~/.local/share/poker/ocr-training/release-candidate/`). `freeze.json` identifies the exact
candidate; `matrix-gpu/` contains the complete 19-condition database benchmark,
`spatial-policy/` reports errors separately from abstention, and
`runtime-acceptance.json` records blind sealed-target scoring and changing-frame
replay on the production RTX4060. Earlier v8 archives below are historical.

On original database crops, the selected two-model pipeline scored 9,555/9,569
exact against audited labels. Five-view agreement accepted 8,898/9,569 with zero
accepted errors: 70 abstentions among 8,968 geometry-backed rows, plus 601 rows
without source geometry. Positive coverage among geometry-backed rows was
99.16%; reused test-session positive coverage was 98.46%. These development
splits have been reused; neither zero observed errors nor the small two-capture
sealed check establishes broad prospective risk.

Private body observations begin with the first spatially valid Game ID, while
all publication waits for both header and body confirmation. The runtime
requires two distinct capture observations, five spatial views,
collector region admission and one-second result expiry. A changed pending
capture immediately revokes changed fields; configuration or Game ID changes
revoke the frame. Unknowns are explicit and never silently treated as blank.
Exactly uniform BGR inputs are deterministic blanks; nonuniform inputs always
use the neural recognizer. No confidence threshold or automatic glyph repair
is used. CUDA startup verifies actual heavy-operator placement and disables
runtime fallback; CPU shape bookkeeping remains permitted.

Run software regressions with:

```sh
"${XDG_DATA_HOME:-$HOME/.local/share}/poker/ocr-training/runtime-venv/bin/python" -m unittest discover -s dev_tools/training -p 'test_*.py'
```

Run the pinned GPU acceptance/replay check with:

```sh
"${XDG_DATA_HOME:-$HOME/.local/share}/poker/ocr-training/desktop-gpu/bin/python" dev_tools/training/verify_release_candidate.py
```

That check uses archived pixels with generated capture identities and times.
It measures bounded software behavior and GPU latency, not fresh physical
capture accuracy. See `production-readiness/runtime-review-disposition.md`
under the artifact root for the six runtime review findings and their fixes.

## What is actually in the database

All 9,569 image rows are benchmarked: 8,022 nonempty transcriptions and 1,547
intentional target-region negatives. Every empty-label crop was visually reviewed;
all are correct negatives. A dealer D inside a CARD crop, ranks inside a STATUS
crop, logos and clipped neighboring fragments remain negatives for that field.
`verified-negative-review.json` records every reviewed ID, decision and source hash.
The source SQLite database and its images are never rewritten.

The previous v5 report's “full corpus” contained 8,021 positive examples, excluding
these negatives and one clipped crop. Its positive-only 100% score was not a
whole-database score. After negative review, the unchanged v5 model scored
9,387/9,569 exact and emitted text on 182/1,547 negatives. The retained-reader v8
candidate reads all 8,022 positive targets correctly on native crops and emits
text on 18 negatives; all 18 outputs violate their field schemas. Raw abstention
and hypothetical schema rejection are reported separately.

All variants are retained. Collector dedup is 256-bit dHash distance <=2 within
one exact region ID; label similarity, grayscale MAE and cross-seat similarity
are never deletion rules. `curate_full.py` now keeps hash-matching visually
verified negatives as true empty strings. Unreviewed or changed empty examples
require renewed visual review. Its current 9,568-row training/evaluation manifest
excludes clipped ID8137 from optimization; the full-database benchmark includes it.

Whole source captures stay together; capture timestamps, not labeling commit times,
define sessions with gaps above ten minutes. Sessions18/19 are validation/test.
Unknown-source examples are training-only. The split has 6,221 positive+1,270
negative training crops, 890 positive+154 negative validation crops, and 910
positive+123 negative test crops. The extra quarantined positive belongs to the
validation session and is included in whole-database scoring. All 9,569 raw
images are unique; no exact pixels or capture groups cross these partitions.
The raw-input prepared-pixel audit covered the 9,569 real crops plus 4,000
raw repetition examples and found no cross-split exact overlap. It is not an
exhaustive audit of every augmented training variant. The older destructive
preprocessing overlap audit is retained as historical evidence. Validation/test were reused during model
development, so none of this is prospective acceptance evidence.

## Train with real blank targets

The OCR Training tab starts each version from the same original pretrained
initialization. `lab_training_data.discover()` verifies the official source,
the lossless tensor and character-column mapping, and the mapped checkpoint
against `production-clean-start/provenance.json` under the training artifact
root. Earlier poker fine-tunes are never selected as starting weights. The
active frozen release supplies the benchmark baseline. Each version records
its starting lineage and dataset audit hash.

`lab_training_curriculum.py` builds the recovered training schedule: shared
general adaptation, separate general and high-resolution name branches, then
real-name reweighting. It preserves audited glyph controls, train-only crop
variations, and hash-bound semantic exclusions. The epoch setting controls the
final name-refinement phase; prerequisite phases use the recovered schedule.
Validation and test images are never augmented into training. Stage receipts
bind the configuration, inputs, implementation and actual checkpoint dependency
so resuming cannot substitute a different model branch.
Export chooses the highest validation accuracy across phases with identical
validation inputs and evaluation policy; ties prefer the later phase. A worse
refinement cannot replace a better specialization checkpoint. The exported
copy and its evidence are recorded separately in `model-selection.json`, while
all trained checkpoints and optimizer states remain intact.

The training wrapper preserves the configured dataset RNG seed without changing
augmentation epochs. This provides repeatable initial sampling and shuffling;
it does not establish bitwise GPU determinism. Benchmark comparisons require
matching held-out identities, labels, source pixels, roles and conditions.
An inference failure on either model invalidates the comparison. Validation
selects the checkpoint; the frozen test set evaluates the resulting candidate.

Use a Python3.12 Paddle environment under
`$XDG_DATA_HOME/poker/ocr-training` (default `~/.local/share/poker/ocr-training`).
The earlier remote experiments used a machine-specific npm cache location;
that historical path is no longer a default.
PaddlePaddle GPU3.3.1, PaddleOCR3.7.0, official training source commit
`dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf`. Environment freeze and source/checkpoint
hashes are bundled with results. No manual thermal pacing is used.

The default upstream encoder rejects empty strings. `negative_ctc_policy.py`
encodes verified negatives with target length0, not a fake space character.
Native GPU warpCTC crashes when a whole batch has zero target labels, so the
custom loss computes the exact unique all-blank path analytically and sends
positive rows to native CTC. All-empty, mixed and all-positive value/gradient
checks passed on CPU and GPU.

From the existing job directory, after packaging every DB row with
`package_stress_database.py` and transferring the verified review sidecar:

```sh
paddle-gpu-venv/bin/python prepare_negative_training.py --root . \
  --review verified-negative-review-hashed.json
paddle-gpu-venv/bin/python prepare_ocr_inputs.py \
  --manifest negative-ocr-v6/manifest.jsonl --image-root stress-database \
  --output negative-ocr-v6/inputs --normalize-names --localize-pills
cd paddle-training-source
OMP_NUM_THREADS=4 ../paddle-gpu-venv/bin/python ../run_negative_ocr.py \
  --source . --mode train -c ../negative-ocr-v6/train.yml
cd ..
paddle-gpu-venv/bin/python prepare_retention_training.py --root .
cd paddle-training-source
OMP_NUM_THREADS=4 ../paddle-gpu-venv/bin/python ../run_negative_ocr.py \
  --source . --mode train -c ../negative-ocr-v8/train.yml \
  --retain-positive-checkpoint ../compact-ocr-v5/checkpoints/best_accuracy.pdparams \
  --retain-positive-config ../compact-ocr-v5/train.yml --retention-weight 1
```

The v6 stage retains 2,000 generic repetition examples made from individually
checked training glyphs. A real-only continuation was rejected because it forgot
an i in a previously unseen repeated username. V8 keeps those repetition examples
and adds positive-only KL retention against the frozen prior v5 reader. Its teacher
never imitates old predictions on negatives. Identical frozen backbone features
are shared; teacher neck/head are gradient-free. Only the selected student exports.
Training uses shuffled batches32, frozen backbone/BN, and validation selection.
`partition_audit.py` enforces source/pixel isolation and training-only glyph provenance.

## Export and run

Export with `run_negative_ocr.py --mode export`, selected checkpoint and the same
width-pooling policy. Use `fix_export_metadata.py` with the previous export as
preprocessing reference; retain the new 70-class character dictionary.
`verify_selected_ocr.py --root . --run negative-ocr-v8` checks frozen tensors and
training/export probability parity at three widths.

```sh
PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True paddle-gpu-venv/bin/python \
  recognize_crops.py --model-dir negative-ocr-v8/export \
  --image /path/to/crop.png --category bank --device cpu
```

`prepare_ocr_inputs.py` performs pixel-only, region-aware preparation.
`ocr_output.py` changes schema whitespace only; it never repairs letters or digits.
Confidence is the mean probability of emitted characters, not probability that the
whole field is correct; a dropped decimal/letter can retain near-1 confidence.
This is a native Paddle export, not a drop-in RTen model replacement.

## Stress protocol

`stress_ocr.py` runs every database row and preserves raw/formatted text, confidence,
preprocessing decisions, hashes, split and category. Processing failures count as
exact-match misses. Positive accuracy and negative false outputs stay separate.
Schema-reject-to-empty scores are hypothetical policy controls, not model blank
accuracy or evidence that the app has integrated rejection.

The published sweep uses a single-crop native baseline, then batch8 with its own
identity control across19 full-database conditions: brightness, gamma, resize,
blur, JPEG, combinations, uniform/noise blanks and six full-capture crop shifts.
`package_recrop_stress.py` recrops 8,968 source-backed images; 601 rows with no
source remain unchanged and are reported separately. Every available unshifted
source recrop matched the stored crop exactly. `make_novel_name_challenge.py`
adds512 constructed identifiers excluded from this project's training labels,
using reviewed training-font glyphs and varied repetition counts/spacing.

`ablate_ocr_filters.py` diagnoses JPEG failure by bypassing one color filter at a
time with weights fixed. It does not select a replacement pipeline. Actual failed
inputs are reconstructed and pixel-hash checked by `export_stress_examples.py`.
`report_ocr_stress.py` aggregates complete coverage, confidence sweeps, raw failure
counts and per-region/category results. No model training follows the frozen sweep.
