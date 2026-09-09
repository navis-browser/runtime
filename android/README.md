# Navis Android Runtime backend

This private Android library owns the Navis engine package. It is not a published GeckoView AAR and the Platform application must depend only on this module.

The module packages the configured Gecko native stage from `dist/navis-android`, the matching `omni.ja`, generated JNI/SDK bindings and the pinned low-level Android engine primitives. Navis owns the public Runtime/Session/View lifecycle. Historical `org.mozilla.*` package names that remain in the module are private engine ABI details, not a product API.

The source closure is the reviewed allowlist in `gecko-java-primitives.list`. It deliberately excludes GeckoView's public lifecycle owners, and the package verifier independently enforces that boundary against the final DEX class definitions.

The complete configured native stage is authoritative. Do not reduce it to only `libxul.so` and `libmozglue.so`: NSS, codecs, child-process and dynamically loaded libraries are part of the runtime closure.
