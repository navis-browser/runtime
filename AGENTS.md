# Navis Runtime instructions

This repository owns the shared Rust Core, private Gecko bindings, upstream pin, semantic-port series and Runtime build profiles. It does not own product UI or host policy.

Read this repository's README and relevant local `docs/` contracts first. When checked out in the standard sibling workspace, also read the relevant public contracts under `../navis/docs/` before substantial work. A standalone Runtime change must still preserve the architecture and evidence rules recorded there; if the sibling repository is unavailable, limit work to the Runtime contract stated in this README and do not infer product requirements.

- Core must not depend on Platform UI, Gecko/XPCOM/DOM/JNI or host event-loop types. Those remain behind reviewed private bindings.
- Every retained Gecko edit belongs to the ordered, hash-owned `config/gecko-semantic-ports.json` series. `gecko/` is generated state, never source of record or a submodule.
- Prefer the smallest complete change, reuse current Runtime/native facilities, and avoid speculative abstractions or dependencies.
- Preserve valid object directories and caches. Choose checks appropriate to the changed graph; distinguish incremental work from clean-build evidence.
- Keep operating system and architecture explicit in build or native-test claims. Distinguish source checks, builds, package checks and human evidence.
