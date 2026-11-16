# OCR value contract

`packages/shared/src/schemas/poker-ocr-values.ts` owns value metadata, the Zod factory and normalization rules. `tools/poker/generate-ocr-contract.mts` writes the native/Python JSON artifacts and TypeScript digest. The adapters consume those artifacts; parity fixtures check their output against the same expected transcriptions.

```sh
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/generate-ocr-contract.mts --write
./infra/scripts/pnpm-with-pinned-node.sh exec node tools/poker/generate-ocr-contract.mts --check
```

The contract preserves the original displayed-value targets. Visible `G`/`S` currency badges belong in monetary OCR readings even though CSS imagery renders them. The upper pot retains `Pot:` and its `Run It Twice pause (N sec)` alternative. `split_pot` is one ordered list of displayed amounts, not a scalar. Normalization repairs separators and known casing without inventing digits, currency markers or missing units.

Default completed monetary values use BB units. Cash validation requires an explicit display/format context: otherwise a clipped `BB` must not become an accepted cash `B` suffix. Source formatter precision and grouping are supported; negative active amounts are rejected. Cash shortening applies to bets and split pots, not banks, total pot or blinds. Custom templates require their actual context and preserve the visible badge as well as literal template text. Repeated substitutions must contain the same value.

Use `pokerOcrValueSchema` with known formatter options in TypeScript. Native and Python `validate_text_with_currency_format` accept a known cash template; an absent template uses the default completed contract. Arbitrary templates are never inferred from OCR output. The original `normalize_legacy_text` and `legacyCurrencyIcons` adapter interfaces retain currency markers.

Names transcribe visible display text, preserving case, internal spaces and displayed ellipsis. An accurate truncated name can be verified without recovering its hidden suffix. This is not an account-identity grammar. Source-backed status labels form an explicit enum; human outside-contract status review remains separate from automatic acceptance. A permissive mock string property does not establish a live hand-ID grammar: the live profile retains the original numeric ID format. The table line is one field, including its name, variant, visible currency marker and unshortened cash blinds.

Suits use `d`, `h`, `c`, `s`. Displayed ten remains `10`; internal card-code aliases are not alternative completed OCR glyphs. Explicit reviewed blanks remain distinct from completed positive-text validation and do not alone prove an absent region. Two matching blind blank reads cannot automatically verify a card target with supported visible foreground; missing raw text is not an explicit blank. Legacy labels and explicit reviewed blanks retain `legacy_verified`, `source: legacy` and `visually_verified: false`; pending predictions and new missing fields remain unverified. Existing card-background and nameplate color evidence must retain its own sampling geometry when glyph crops change.

Formatter and normalization fixtures contain clean-room output values, not private mock source or assets. Their tests cover source-backed format variants and cross-runtime agreement; schema validity does not prove pixel correctness or authorize cache reuse. Search areas and maximum-position envelopes are not OCR crops.
