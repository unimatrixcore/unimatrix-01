# Mock-derived OCR regions

Start the private mock separately, then capture its rendered game state with the repository's pinned Node:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/mock-regions/capture.mts \
  --url http://127.0.0.1:5173 --output /tmp/poker-regions \
  --width 1280 --height 800
```

The output directory must be new and outside the repository, or inside ignored `.notes`. `--state /tmp/state.json` applies a friendly-state patch through the mock's validated console API. The browser permits requests only to the supplied loopback origin. Keep the mock's source, fonts, assets and generated pixels private.

`manifest.json` records each region's exact rendered label, category, logical seat, visual seat template, card slot, viewport, maximum-content `bounds`/`polygon`, and separate current `inkBounds`/`inkPolygon`. Rank and suit are separate regions. Their maximum polygons union all faces in the selected deck and follow the card transform; PNG crops undo that rotation. The complete table information line, including name, number, variant and blinds, is one region covering its full CSS allocation.

Money envelopes derive from the native safe-integer funds limit, precision ranges, grouping, built-in BB/currency output, font metrics, currency icon allocation and CSS alignment. Short and long amounts share an envelope at each seat/layout. Arbitrary `currencyFormat` templates are unsupported. Names and bank rows use their full clipped CSS slots; action/status text uses the seat allocation. Numeric timers reserve their finite decimal/scientific output range. Split pots share the potential wrapping group area for up to ten pots, because their individual locations move with other pot widths and wrapping. Header, popup and combination text use bounded visible layout profiles; uncapped or wrapped text beyond those allocations is explicitly unsupported rather than assigned a guessed maximum.

Full envelopes can extend beyond the capture viewport. `cropBounds` records their visible intersection while the region retains its complete bounds; PNG output preserves that full size with transparent pixels outside the screenshot. Empty or wholly unsupported targets are not admitted. Large envelopes can include neighboring text, cards or a dealer marker. `cropOverlaps` records intersections with other current region ink; those crops have `autoLabelEligible: false` and `cropLabel: null`. `label` remains the controlled target's value, not a claim that the whole PNG contains only that text. The version2 manifest lists all rendered previews in `previewCrops`; only isolated supported crops receive `cropLabel` and an entry in `crops`. This preparation step does not import a training corpus.

Labels carry `controlled_render_state` evidence and `visuallyVerified: false`. Absent, face-down, flipping, clipped and unsupported card images produce no admitted crop. Foreground intersections conservatively suppress text/card labels; nontext active/dealer/timer crops carry separate semantic values. Ellipsized usernames are excluded rather than labeled with their invisible full name. A large bet can cover table information, so metadata and maximum-bet coverage need separate states.

The manifest is a synthetic-region preparation format. It does not import examples into OCR Benchmark, change existing benchmark labels, train a model, or alter the current model alphabet. The native mock renders NLHE; other variants, canvas squeeze glyphs, arbitrary overlay effects and every animation frame are not proven. Custom card artwork with unsupported glyph geometry is rejected.

Run the bounded local-browser sweep and negative controls:

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/mock-regions/validate.mts \
  http://127.0.0.1:5173 /tmp/poker-regions-validation
POKER_MOCK_URL=http://127.0.0.1:5173 ./infra/scripts/pnpm-with-pinned-node.sh exec node \
  --test tools/poker/mock-regions/geometry.test.mts tools/poker/mock-regions/regression.test.mts
```

The sweep asserts every rank/suit in each card slot at every logical seat, the default and four-color decks, all visual seat templates, several viewport sizes, folded cards, digital timers, table metadata and complete `355.6 BB` labels. It writes a coverage receipt and representative screenshots. The regression checks unchanged maximum bounds across short/extreme built-in amount formats and different card glyphs, and rejects opaque overlays even when they disable pointer events, flipping faces and vertical text clipping. These layout and crop checks do not establish OCR model accuracy or exhaustive pixel equivalence with a live game.
