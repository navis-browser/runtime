# Runtime source preparation and packaging

Runtime owns its Rust Core, private bindings, exact Gecko pin, ordered semantic ports and independent API fixtures. It contains no Navis product UI. This is a source API, not a stable prebuilt libxul ABI or public Android AAR SDK.

Run from this Runtime checkout (or the extracted Runtime source archive):

```sh
python3 scripts/package-embedder-source.py --check
python3 scripts/package-embedder-source.py --output /path/to/source.tar.xz
python3 scripts/package-embedder-source.py --verify /path/to/source.tar.xz
```

The explicit definition selects desktop Runtime sources, pins, semantic ports, API fixtures and these public contracts. No sibling Navis/Platform or private work directory is read. Android source remains in the Runtime repository; this desktop embedder archive is not an Android SDK.

Each archive member has a mode, size and hash. Verification rejects unsafe paths, links, unexpected entries, altered pins/ports and broken packaged documentation links. Existing output is not overwritten by default. This does not build an engine or imply native acceptance.

For a fresh engine tree, install the pinned Gecko version's build prerequisites (Git, supported Python, Rust, Clang/cbindgen, Node, NASM and target SDKs), then:

```sh
python3 scripts/prepare-desktop-embedder.py --source-root . --gecko gecko
```

Preparation fetches substantial upstream source and applies the hash-owned semantic ports. Gecko is generated state, not a submodule. Product composition and target build commands belong to the sibling Navis repository; they mount Platform into the prepared engine. Neither source checks nor archive checks need generated Gecko unless explicitly identified as prepared-source tests.

See [API](desktop-embedder-api.md), [upstream maintenance](gecko-esr-update-review.md) and [validation](runtime-validation.md).
