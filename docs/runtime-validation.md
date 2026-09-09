# Runtime validation

From a standalone Runtime checkout, select the check relevant to the change:

```sh
node tests/address-input.mjs
node tests/desktop-locale.mjs
python3 -m unittest discover -s tests -p test_review_gecko_esr_update.py
python3 scripts/package-embedder-source.py --check
cargo test --manifest-path core/rust/Cargo.toml
```

Tests live with their owner. Node tests execute real Runtime modules with bounded service mocks. Tests reading `gecko/` require the exact prepared pin and semantic ports; an absent engine tree is not a passing test. Run only tests present at the selected version: Android is absent at v0.1.0. Core Rust tests stay beside the implementation. Python tests exercise preparation and archive rejection.

`tests/embedder-shell/` is an independent Runtime/Session/View/Delegate consumer. `tests/m2-site/` and `scripts/m2-server.py` provide deterministic Web interactions. Use `scripts/inject-embedder-shell-into-omnijar.sh` only on a disposable package copy, never the user's package/profile; the shell must not ship in a release. The content-only automation client is `scripts/navis-webdriver.py --help`.

Cross-repository tests and product capability/security gates live in Navis; Platform owns UI component tests. None needs private acceptance runner sources. Native acceptance still covers navigation, input, rendering, permissions, extensions, sandbox and recovery on each required target. Record OS, architecture, BuildID and exact source/archive hashes separately from human acceptance. Limit automation to owned processes/windows, bounded memory and cleanup; never control unrelated applications. A source-only result is not native acceptance.
