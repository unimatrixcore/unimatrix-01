# Poker Assistant

```sh
pnpm --filter @unimatrix/poker-assistant tauri dev
```

Use `pnpm --filter @unimatrix/poker-assistant dev:x11` for the WebKit X11 renderer workaround, or `pnpm --filter @unimatrix/poker-assistant tauri build` to create desktop bundles.

The separate desktop app retains the original Stake Poker Assistant control panel. Enter your Stake username, select a monitor, then use Start Assistant or Test Capture. Refresh reloads the monitor list and card colors. Save Debug Screenshot writes a native capture, and the debug overlay shows configured regions alongside the screenshot and detected table state.

Start Assistant submits captures serially, targeting a 500 ms interval, and polls the production reader every 100 ms after each completed poll. Only available, confirmed reads less than one second old populate the table. Unknown, stale or failed reads clear the displayed game state; capture failures also clear it while later captures retry. Stopping or changing monitors waits for pending requests and stops the previous reader. Test Capture provides a preview and briefly polls for a confirmed read.

The native application requires the retained Python ONNX production helper and its frozen general and name-specialist model release. Configure `POKER_OCR_PYTHON`, `POKER_OCR_RELEASE` and `POKER_OCR_SERVICE` when their managed defaults are unavailable. The helper source is under `tools/poker`; compilation alone does not install its Python dependencies or model artifacts. Legacy RTen models do not replace this reader.

Capture uses saved native region configuration; the standalone Poker Lab region editor manages those rectangles. Both apps preserve the original `$XDG_DATA_HOME/poker` data and `$XDG_CONFIG_HOME/poker` configuration directories, falling back to `~/.local/share/poker` and `~/.config/poker`. Username and monitor preferences persist there, and existing data and models are reused without an import or copy. See [Poker Lab](../poker/README.md) for the migration baseline and isolated-test boundaries.

Equity calculation and move recommendations are unavailable. Browser fixtures verify control behavior and IPC requests. They do not establish native WebView behavior, physical capture accuracy, OCR accuracy or GPU execution; those require independent native and live-table validation. Fixture tests make no paid AI calls.
