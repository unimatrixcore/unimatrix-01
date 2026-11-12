# Poker OCR model tooling

The `dev_tools/training` tree preserves the current Poker repository's inference, training, export and qualification tools with their relative import layout. The collector's contract adapter and database source are retained for runtime schema and source-fingerprint compatibility. They do not start an application server.

The desktop inference entry point is `dev_tools/training/collector_inference.py`. It uses OpenCV, NumPy and ONNX Runtime with the existing frozen general/name model release. Paddle dependencies belong to the training/export tools. Model weights, Python environments, datasets and credentials stay outside source control.

Select the existing model interpreter and release with `OCR_MODEL_PYTHON`, `OCR_MODEL_RELEASE` and `OCR_MODEL_DEVICE`. A successful worker fixture test is not CUDA-placement or fresh physical OCR proof. Preserve the release's raw BGR preprocessing, dictionary/weight pins and contract identity when replacing this worker.
