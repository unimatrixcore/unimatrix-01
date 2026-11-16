# Mock-derived OCR regions

`profile.mts` generates the Gameplay layout for fullscreen 1920×1080. The bundled profile has 95 OCR targets and nine non-OCR CV contexts; field identities and extraction metadata live in `packages/poker-native/assets/gameplay-regions.json`. Currency markers, the whole `Pot:` caption, Run It Twice pause text, ordered split-pot lists, player announcements and displayed username ellipses retain their original reading contracts.

Start the private mock separately and regenerate the geometry-only bundle:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/mock-regions/profile.mts \
  --url http://127.0.0.1:5173 --output /tmp/gameplay-regions.json
```

The mock supplies CSS allocations, card transforms, closed-card positions and panel styles offline. Runtime extraction uses only the screenshot and generated profile. Keep the mock source, fonts, artwork and generated screenshots outside Git. The shipped geometry asset lets Gameplay start without the mock running.

The original seat IDs retain their established mapping: source seat `(legacy seat + 3) % 9`. Active generation does not infer this mapping from an archived configuration; `--legacyConfig` is rejected. Money search bounds use the source CSS and formatter's theoretical allocation, while split-pot bounds follow the wrapping container.

The native resolver searches each source allocation for its painted field. Search windows are never OCR crops or overlay rectangles. Bet panels grow and shrink with visible content; `split_pot` remains one logical list in visual row order, including wrapped rows. Overlapping or incomplete panels remain ambiguous. Both S and G currency badges are included. A no-badge Run It Twice pause remains a supported pot field. Table information is one complete line, and the game-ID tab keeps square left corners and rounded right caps.

Status crops follow the actual announcement panel, including two-line labels. The source renders Disconnected as a translucent overlay over the bank: underlying gray bank pixels remain visible in the screenshot. Extraction preserves those pixels rather than reconstructing a clean label. Ambiguous, merged or physically clipped panels require review.

Cards share one card-plane resolution for rank and suit. Confirmed edges refine the source pose; rotated fields use bilinear sampling, while upright board sampling preserves its pixel grid. Separate foreground components retain both digits of `10` and descenders while excluding adjacent suit/rank fragments. A weak edge fit retains explicit fallback provenance. Card targets reach local OCR, including backs, avatars and weak fits, except at seats proven empty from source-specific screenshot pixels. When glyph isolation fails, the nominal crop is retained. Local OCR output alone cannot establish a verified reading: automatic acceptance requires supported card-plane/glyph evidence and two matching blind reads. Blank readings that contradict supported card foreground remain unresolved. Suit labels are lowercase `d`, `h`, `c`, `s`, determined from glyph shape rather than color.

Profiles declaring `presence_policy` use screenshot presence results before local OCR or AI preparation for automatically localized noncard fields. Fixed source fields reach OCR when their crop is valid. Confidently absent auto fields produce no OCR request, material PNG, review item or provider request. Unreadable fields remain ambiguous rather than becoming blank labels. Source-proven empty seats skip all their fields before cropping or OCR; uncertain occupancy cannot suppress a card target. Absence is counted separately from verified readings. Original Training negative collection remains available independently.

Rounded masks follow actual panel bounds. Name and bank rows share their full nameplate parent; split lists use the union of their individual panels. Canonical OCR/provider/cache images stay opaque RGB; display PNGs derive transparent corners from the same saved descriptor. Card component masks remove only excluded neighboring foreground. Original frame pixels and CV sampling remain unchanged. The nine nameplate contexts and separate card color contexts retain in-play, turn, urgent, suit and dim evidence without entering the OCR denominator.

The same resolved snapshot supplies native OCR, AI evidence, media and preview geometry. Captured configurations and original predictions remain immutable. The app-wide ledger persists occurrence context alongside content-addressed RGB assets. Profile, presence and glyph-policy metadata preserve extraction provenance; an old broad crop must not become a new tight crop's accepted reading merely because its semantic name matches.

For an isolated native pixel proof, use a selection of up to 24 `{frame_id, region_id}` pairs and a directory of original `<frame_id>.png` files:

```sh
cargo build --manifest-path packages/poker-native/Cargo.toml -p poker-native --example gameplay-ai --locked
target/debug/examples/gameplay-ai export \
  --selection /tmp/selection.json --profile /tmp/gameplay-regions.json \
  --frames /path/to/private/frames --output /tmp/poker-pixel-proof --allow-unavailable true
```

This file-only path creates no manager, database job, model request or provider call. Receipts identify source-frame and decoded RGB hashes, resolved bounds, masks, presence and card-sampling provenance. Diagnostic exports can include absent/ambiguous source slots; production preparation skips absent fields.

`capture.mts` remains a separate synthetic research tool. Its controlled-state labels are not visually verified labels, and its maximum-content/motion envelopes are not Gameplay extraction crops:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/mock-regions/capture.mts \
  --url http://127.0.0.1:5173 --output /tmp/poker-synthetic-capture \
  --width 1920 --height 1080 --state /tmp/state.json
```

Validate layout changes against independent source measurements and original recording pixels. Coverage must include short/long S/G amounts with full `BB`, all card ranks and suits, faded visible faces, supported card themes, known backs, no-card avatars, status styles and nearby lookalike panels. Preserve unavailable and ambiguous outcomes in receipts. These checks establish extraction behavior, not OCR model accuracy or exhaustive support for custom artwork, arbitrary overlays or other viewport layouts.
