# Global crop assets

Gameplay's persistent app-wide ledger stores crop assets separately from
occurrence context, readings and decisions. Deduplicating pixels does not verify
a label: reuse must also satisfy the current semantic family, guide and review
policy in `src/lab/gameplay/evidence_cache.rs`. Near reuse requires unchanged
pixels under the conservative padding-translation predicate in
`src/lab/gameplay/regions.rs`. Legacy annotations remain occurrence-owned even
when their pixels share an asset. Quarantined automatic decisions cannot supply
cache truth; saved raw observations require explicit new-job recovery checks.

Close Poker Lab and retain a verified SQLite recovery snapshot before migrating its
app-wide `ocr-evidence.sqlite3`. The example requires that filename and the Gameplay
ledger tables; dataset `data.db` files are outside its scope.

```sh
CARGO_BUILD_JOBS=2 cargo build -p poker-native --example pixel-assets --locked
./target/debug/examples/pixel-assets inspect --db /absolute/path/ocr-evidence.sqlite3
./target/debug/examples/pixel-assets verify --db /absolute/path/ocr-evidence.sqlite3
./target/debug/examples/pixel-assets migrate --db /absolute/path/ocr-evidence.sqlite3 --compact
```

`inspect` reports storage counts and semantic table digests. `verify` also decodes
every asset and referenced crop, checks its identity and dimensions, and runs SQLite's
integrity check. Both open the ledger read-only. SQLite can require writable auxiliary
files for a WAL database, so use a consistent recovery copy when inspecting a protected
source.

Migration replaces inline crop bytes with references in transactions of at most 64
rows. An error rolls back the current batch; previously committed batches remain.
Correct the source error using the recovery snapshot before rerunning. A completed
rerun preserves the same assets and semantic rows. `--compact` reclaims freed SQLite
pages after verification. Keep the JSON receipt, which compares semantic digests before
and after the operation, with the recovery snapshot.

Identity is SHA-256 of dimensions and decoded RGB bytes. PNGs containing alpha are
accepted only when every alpha value is fully opaque, including 16-bit alpha. Transparent
crops and masks fail closed; they need an explicit identity policy before storage.

Each asset retains its first verified PNG encoding, encoded SHA-256 and dimensions.
Historical prediction payloads and sample provenance retain their original encoded
SHA values. A resolved crop can therefore have a different encoding from that historical
value while retaining identical RGB pixels; new predictions describe the resolved bytes.
