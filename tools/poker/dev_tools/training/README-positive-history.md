# OCR benchmark and fine-tuning

PP-OCRv6-small won the comparison of five untouched pretrained recognizers on
890 identical labeled validation crops. The completed initial corrected transfer run
used 6,221 training crops, shuffled batches of 32, three epochs, the original
48x320 input convention and a frozen pretrained feature extractor/BatchNorm.
Only its CTC encoder and recognition head were optimized. Epoch 3 was selected.
That run is superseded by the compact high-resolution run below.
No manual thermal pacing is used in the corrected run.

The earlier model's native Paddle inference export and training checkpoint are
in `.local/ocr-training/corrected-results/paddle-transfer-v2/`. This directory
also contains `final-report.md/json`, full predictions, the actual training
configuration, and tensor-level proof that the backbone and BN buffers stayed
unchanged. Raw crop recognition is distinct from the app's existing ocrs
text-detection/card-preprocessing pipeline; this model is not a drop-in
replacement for that engine and has not been installed in the app.

## Selected compact model

`.local/ocr-training/compact-results/compact-ocr-v5/` contains the selected native
export, checkpoint, per-crop predictions, configuration and audit evidence.
The final pipeline has 890/890 validation and 910/910 test exact matches.
Raw recognition is 888/890 and 907/910; its remaining errors concern whitespace.
The corrected full-corpus regression audit is 8,021/8,021 pipeline and 8,008/8,021
raw; it includes training data and is not an independent generalization score.
These are reused development evaluation sets, not fresh prospective acceptance.

The model retains the pretrained visual backbone and its BatchNorm statistics,
uses width pooling 1 instead of 2 (80 rather than 40 CTC positions at width 320),
and keeps 70 output classes covering collector schemas. Class remapping was
verified against the original export at three widths, with maximum probability
error below 0.000001. All backbone/BN tensors remained unchanged during training.
The CTC encoder/head trained for four compact epochs and a 12-epoch clean-label
continuation, with shuffled batches of 32 on 6,221 real crops and 2,000 generic
repetition examples. Validation selected the
checkpoint; the optimizer never consumed validation/test images. Synthetic glyphs
come from individually checked training-only sources in `reviewed-glyph-bank.json`.
The earlier automatic projection bank failed audit and was excluded.

Required preprocessing is `prepare_ocr_inputs.py`: color-alpha name normalization,
removal of connected border artifacts, status/bet pill localization and rejection
of exterior artwork inconsistent with the colored button's black text. It reads
only pixels and region category. `ocr_output.py` restores schema whitespace while
preserving every non-whitespace character. It never guesses letters or digits.
The two source-label corrections (8248: `G 76.3 BB`, 8425: `G 96.3 BB`) were
verified visually and against original capture recrops; original DB is untouched.
The subsequent 43-disagreement corpus audit verified 31 further incorrect
training labels (29 matched source recrops; two sources unavailable). See
`reviewed-label-corrections.json`; the seven genuine GodzillaTa letter-count
errors were retained and fixed by training. There are 37 exported-label fixes
in total; original annotations and historical evaluations remain available.

Use the portable label-free inference runner:

```sh
PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True python recognize_crops.py \
  --model-dir export --image /path/to/crop.png --category name --device cpu
```

Copy `recognize_crops.py`, `prepare_ocr_inputs.py`, `ocr_output.py` alongside the
export, or use the scripts bundled with the result. Requires PaddleOCR 3.7.0,
PaddlePaddle 3.3.1, OpenCV, NumPy and PyYAML. CPU and GPU inference were checked.
This model has not replaced the app's RTen recognizer.

Reproduce from the existing job directory and v2 checkpoint:

```sh
python augment_repeated_glyphs.py --manifest full-bundle/curated.jsonl \
  --image-root full-bundle --output compact-ocr-v4/reviewed-augmentation \
  --reviewed-bank reviewed-glyph-bank.json --count 2000
python prepare_compact_ocr.py --root . \
  --manifest compact-ocr-v4/all-reviewed-manifest.jsonl \
  --augmentation compact-ocr-v4/reviewed-augmentation
python prepare_ocr_inputs.py --manifest compact-ocr-v4/all-reviewed-manifest.jsonl \
  --image-root full-bundle --output compact-ocr-v4/inputs \
  --normalize-names --localize-pills --profile v4-training
cd paddle-training-source
OMP_NUM_THREADS=4 ../paddle-gpu-venv/bin/python ../run_compact_ocr.py \
  --source . --mode train --pool-width 1 -c ../compact-ocr-v4/train.yml
../paddle-gpu-venv/bin/python ../run_compact_ocr.py --source . \
  --mode export --pool-width 1 -c ../compact-ocr-v4/train.yml \
  -o Global.pretrained_model=../compact-ocr-v4/checkpoints/best_accuracy \
  Global.save_inference_dir=../compact-ocr-v4/export
cd ..
python fix_export_metadata.py --export compact-ocr-v4/export \
  --reference paddle-transfer-v2/export
```

Continue from v4 with the verified clean labels:

```sh
python prepare_compact_continuation.py --root . \
  --corrections reviewed-label-corrections.json
python prepare_ocr_inputs.py --manifest compact-ocr-v5/manifest.jsonl \
  --image-root full-bundle --output compact-ocr-v5/inputs \
  --normalize-names --localize-pills --profile v5-training
cd paddle-training-source
OMP_NUM_THREADS=4 ../paddle-gpu-venv/bin/python ../run_compact_ocr.py \
  --source . --mode train --pool-width 1 -c ../compact-ocr-v5/train.yml
```

Export with the same wrapper, pool width 1, selected v5 checkpoint and v5 export
directory. Adapt metadata using `fix_export_metadata.py`, then verify with
`verify_selected_ocr.py`. `benchmark_models.py --canonicalize-structured` records
raw and pipeline outputs separately. Final benchmarks use the exact bundled
pixel preprocessing scripts; intermediate image controls remain historical.
Use `--profile runtime` for the final inference/evaluation inputs. The training
profiles reproduce the actual historical training pixels; all three profiles
were compared pixel-for-pixel against all 8,021 real inputs.

All label corrections belong in the exported manifest before training. The
packaged manifest includes all 37 audited corrections and original provenance.

## Data and review

The collector already rejects 256-bit dHash distance <=2 within the **exact
region ID**. It does not deduplicate by label. Same-label seat, crop size,
normal/turn/urgent background, card-color and dimness variants remain valuable.
`curate_full.py` preserves them without grayscale-MAE or label-based pruning.

The consistent source snapshot is read-only. Of 8,022 nonempty labels, 8,021
were retained: four visually checked missing ` BB` suffixes were corrected only
in the exported manifest, and one clipped bet crop was quarantined. Empty
records were not assumed to be labeled blank negatives. 824 accepted examples
were individually rechecked; other rows retain collector annotations plus
schema/image/category audits, not claims of exhaustive second visual review.

Whole source-capture sessions are kept together. Latest eligible sessions form
890 validation and 910 test crops; 6,221 crops form training. Unknown-source
rows are training-only. Identical pixels would link provenance groups before
splitting. Stored same-region dHash similarities are review signals, not an
additional deletion rule. The dataset audit found no exact pixel conflicts,
exact duplicate groups, or cross-split pairs within the collector's same-region
threshold. The test session is held out from training, but has been reused to
compare experiments; it is not a fresh prospective acceptance set.

Generated data and large models stay under ignored `.local/ocr-training/`.
Do not import `poker_lab.py` during analysis: its startup sync worker can
rewrite recrops. Use SQLite read-only backup instead.

```sh
python dev_tools/training/curate_snapshot.py \
  /home/gwenp/repositories/poker/dev_tools/ocr_database/data.db \
  .local/ocr-training/source-snapshot.db
python dev_tools/training/curate_full.py
python dev_tools/training/condition_hints.py
python dev_tools/training/package_training.py
```

`full/curated.jsonl`, `full/exclusions.jsonl`, `full/audit.json` and the
`variant-review/` sheets record provenance, corrections and exact reviewed IDs.
Color-condition hints are reporting aids, not acceptance labels or filters.
The original 300-crop starter set and first full-network trial are superseded
experiment artifacts, not the selected training procedure.

## Model selection

`benchmark_models.py` saves every raw prediction, edit distance, confidence when
available, and metrics by category, exact region and condition. It compares
English PP-OCRv5, PP-OCRv6 small/medium, Microsoft TrOCR-small printed and stock
CRNN. Models use their documented image processors on the same original field
crops. No target-based cropping, case folding, punctuation removal, dictionary
repair or label-dependent transform is allowed. Exact match is primary, CER is
the tie-breaker; whitespace-only normalization is secondary.

`compare_models.py` verifies identical sample IDs, targets and manifest hashes.
The frozen validation sample has 63 exact region IDs and 56 crop dimensions.
Starting-model comparison is in `model-benchmarks/benchmarks/`. The stock CRNN
row is recognizer-only, not the deployed app's detector/preprocessing accuracy.
Backend-specific amortized batch timings are not a controlled latency ranking.

## Reproduce selected transfer run

Training host: unimatrix-01. Git-ignored job directory:
`/home/gwenny/unimatrix-01/node_modules/.cache/poker-ocr-training`.
Official Paddle training source commit:
`dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf`.
Official inference model revision:
`PaddlePaddle/PP-OCRv6_small_rec@bd619643acac4b9650c040234da8d944476ee3f1`.
Official trainable checkpoint SHA-256:
`25c9bd54b0e5900916e8bb6ada938abeffb1eac1baedac0ca54a45b1c9310825`.
PaddlePaddle GPU 3.3.1 (CUDA 12.6) and PaddleOCR 3.7.0; exact environment freeze
is included with the result artifacts.

From the job directory, after transferring the curated bundle and scripts:

```sh
paddle-gpu-venv/bin/python prepare_paddle_training.py --root .
cd paddle-training-source
POKER_PADDLE_SOURCE="$PWD" OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=1 \
  ../paddle-gpu-venv/bin/python ../train_paddle_transfer.py \
  -c ../paddle-transfer-v2/config.yml
```

The wrapper enforces feature/BN freezing before every forward pass because the
native trainer calls `model.train()` for every batch. The sampler shuffles the
entire dataset and advances its epoch seed. A replay audit of the original
batch-4 configuration covered all 6,221 unique samples, with no same-label full
batches and a maximum identical-label run of two; historical batch traces were
not logged. The corrected run uses batches of 32, not label blocks.

Export via the official `tools/export_model.py`. Preserve native export metadata,
verify the character list/order, and use the original inference metadata for
paired comparisons so preprocessing is identical. The final evaluation records
model-file hashes and uses identical baseline/tuned samples and targets.
