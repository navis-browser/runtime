# Navis Runtime

`runtime/` is the source publication boundary for Navis Core and its private Gecko-derived target backends. It contains no browser chrome or native product UI.

- `core/` is the dependency-free shared Rust Runtime/Session/View lifecycle authority and its narrow private C ABI.
- `embedder/` is the desktop Gecko backend.
- `android/` is the private Android engine/Gradle backend consumed by the Kotlin/Compose Platform application.
- `patches/gecko/` is the ordered semantic-port source applied to the selected Gecko revision.
- `config/gecko-semantic-ports.json` hash-owns that complete ordered series; `config/gecko-esr-review-routes.json` controls upstream review routing.
- `scripts/prepare-desktop-embedder.py` reconstructs and validates generated Gecko state using only Runtime-owned inputs.
- `vendor/` pins that upstream revision.
- `mozconfig.*` selects the reviewed development and candidate graphs.

`gecko/` is generated working state. It is reconstructed from the pin and the hash-owned semantic-port ledger, is ignored by Navis Git, and is not a Git submodule or part of Runtime release history. Navis reviews upstream Firefox changes and rewrites retained intent; it does not merge or cherry-pick Firefox history.

Runtime is an independent publication repository in the local multi-repository workspace. Product policy and composition gates live in the sibling `navis` repository, while Linux/Windows/Android UI and OS integration live in the sibling `platform` repository. Runtime owns the upstream pin and semantic-port source; the composition selected by Navis additionally locks the matching integration contract. Copying only generated `gecko/` is never a Runtime release.

The intended publication slug is `navis-browser/runtime`.

## Consumption and licensing

This is a source distribution, not a stable prebuilt `libxul` ABI or Android AAR SDK. Prepare it against the exact Gecko pin and semantic ports. For the complete browser use the sibling Navis repository's `navis/docs/repository-publication.md` and locked peer revisions; a standalone Runtime checkout does not include Navis product UI or its acceptance suite.

Navis-owned code is MPL-2.0; see LICENSE and THIRD_PARTY_NOTICES.md for upstream exceptions and binary-distribution source/notice obligations.

History note: `v0.1.0` contains the desktop Runtime/Core baseline. The private Android backend first appears in later development and is therefore absent when that tag is checked out.

## Develop Runtime independently

Start with [the source API](docs/desktop-embedder-api.md), [preparation and source distribution](docs/desktop-embedder-source-package.md) and [focused validation](docs/runtime-validation.md). `scripts/` and `tests/` belong to this Runtime contract; source packaging requires no sibling repository or private files. The archive is a desktop source API distribution, not a prebuilt Android SDK. Generated Gecko/objects are deliberately excluded.

```sh
node tests/address-input.mjs
python3 scripts/package-embedder-source.py --check
python3 -m unittest discover -s tests -p test_review_gecko_esr_update.py
```
