# Runtime validation

From a standalone Runtime checkout, select the check relevant to the change:

```sh
node tests/address-input.mjs
node tests/address-display.mjs
node tests/desktop-locale.mjs
node tests/desktop-permission-policy.mjs
node tests/desktop-site-permissions.mjs
node tests/desktop-media-indicators.mjs
node --test tests/desktop-context-menu.mjs
node --test tests/android-media-permission.test.mjs
python3 -m unittest discover -s tests -p test_review_gecko_esr_update.py
python3 scripts/package-embedder-source.py --check
cargo test --manifest-path core/rust/Cargo.toml
```

Tests live with their owner. Node tests execute real Runtime modules with bounded service mocks. Tests reading `gecko/` require the exact prepared pin and semantic ports; an absent engine tree is not a passing test. Run only tests present at the selected version: Android is absent at v0.1.0. Core Rust tests stay beside the implementation. Python tests exercise preparation and archive rejection.

Android input unit tests include `NavisAndroidTextInputTest` in `:navis-runtime-android:testReleaseUnitTest`. The private input peer follows GeckoEditable's system-key exclusions so Back and other Android-owned keys fall through to their platform owners while text, editing and gamepad input still reach Gecko. Packaged-device replay must compare system Back with menu navigation after content focus, verify menu/fullscreen dismissal before history traversal, and verify that the first Back dismisses a visible keyboard without navigating. Key and edge-gesture evidence must be recorded separately; synthetic key input alone does not prove a physical gesture.

Context-menu coverage includes saved link/image/media addresses after target hiding, removal or adoption; originating-document ownership; live-element mutations; and dismissed, replaced, destroyed, navigated and unoffered requests. `python3 tests/test_context_menu_hover.py --output /path/to/new-results` executes the prepared native hover methods under ASan/UBSan with explicit popup and IPC peers. It checks deferred exits, suppression of moves/enters outside a still-open menu, restoration of only the latest real target after all exits, later-exit invalidation, synthetic-event exclusion, Fission-frame and window ownership, parent-menu lifetime, original coordinates, repeated closure and ordinary input. This method fixture does not establish native widget interaction; replay page hover, pointer/mouse events, movement back into content, restored current-pointer hit testing, command selection and cancellation in the packaged browser on each affected desktop target.

Address-display coverage checks readable Unicode, reserved delimiters, literal percent sequences, malformed UTF-8, control/invisible characters, re-submission semantics and the backend's canonical copy after link cleaning. Platform's `tests/omnibox-clipboard.mjs` exercises its actual handlers with input/clipboard peers to distinguish unmodified URLs, partial selection, typed or rejected input, Session changes and cut. Packaged replay must verify actual address rendering, native clipboard data, Clean Links on/off, cut, blur and Escape; peer results alone do not establish those native behaviors.

Native content-window startup uses the initial descriptor supplied by Gecko through Runtime. `node tests/initial-window-session.mjs` covers exact descriptor adoption, delegated Session setup, no replacement navigation, foreign/closed/already-bound owners, single-use admission, reentrant creation and rollback. Platform startup coverage in `tests/initial-window-startup.mjs` verifies that pending content bypasses saved-tab restoration and that ordinary startup keeps its URL/private-mode behavior. These fixtures establish descriptor ownership and rollback with recorded peers; packaged replay must independently cover native window adoption. Document Picture-in-Picture remains deferred and product-locked off. Verify secure-content absence even when an existing Profile requests `dom.documentpip.enabled=true`.

Document Permissions Policy inheritance distinguishes an embedding document's response policy from its container declaration. The serialized parent snapshot preserves the parent origin, response declaration and inherited denials; the loaded document recalculates delegation for its final origin while retaining the original iframe `src` origin. `python3 tests/test_policy_info_inheritance.py` runs extracted production methods with recorded parser/principal peers under ASan/UBSan. Cover redirects into and out of an allowed origin, explicit/default/legacy delegation, parent and child denial, missing or inconsistent parent metadata, policy replacement and all default allowlist kinds. Run the parent-policy fixture as well, and compile the actual policy serialization, Document and container/IPC consumers. Packaged browser replay must confirm modern header parsing, cross-process metadata, redirected requests and effective live revocation; these method checks do not replace native browser or payment-provider evidence.

Object/embed document loads publish container policy before the document loader can create a document, including same-process loads. `python3 tests/test_object_container_policy.py` extracts the actual document-load arm and publication methods and checks ordering, frame-state guards, load failures and refreshed owner/origin under ASan/UBSan with recorded loader, policy and IPC peers. Compile the complete changed translation unit against configured headers. Packaged browser replay must cover direct and redirected object/embed documents, allowed and denied parent/child response policies, plus iframe and live-revocation regressions. These checks do not establish payment-provider or product UI completion.

`tests/embedder-shell/` is an independent Runtime/Session/View/Delegate consumer. `tests/m2-site/` and `scripts/m2-server.py` provide deterministic Web interactions. Use `scripts/inject-embedder-shell-into-omnijar.sh` only on a disposable package copy, never the user's package/profile; the shell must not ship in a release. The content-only automation client is `scripts/navis-webdriver.py --help`.

The media portion of the M2 fixture checks `getUserMedia`, `RTCPeerConnection`, permission/device-selection and track shutdown, while asserting that the product-locked `getDisplayMedia` entry point is absent. Web Push is excluded from the default runtime graph; Service Workers, Cache Storage and Web Notifications are tested independently.

Cross-repository tests and product capability/security gates live in Navis; Platform owns UI component tests. None needs private acceptance runner sources. Native acceptance still covers navigation, input, rendering, permissions, extensions, sandbox and recovery on each required target. Record OS, architecture, BuildID and exact source/archive hashes separately from human acceptance. Limit automation to owned processes/windows, bounded memory and cleanup; never control unrelated applications. A source-only result is not native acceptance.

Scoped permission regression checks include `node tests/site-permission-origins.mjs`, `node tests/desktop-site-permissions.mjs`, `node tests/android-site-permissions.mjs`, `node tests/desktop-media-consent.mjs` and `node tests/desktop-media-indicators.mjs`. They cover authenticated frame inventories, removed/replaced choices, exact-attribute isolation, revocation across embedded peer documents, whole-tab stop, stale media consent and frame aggregation. Native replay must additionally prove actual camera/microphone consent, track shutdown, origin isolation, history navigation and teardown on the selected native target. Source fixtures do not establish physical capture or Android execution.

Excluded browser-mediated APIs require disabled configure facts, absent native/Rust graph and generated bindings, absent packaged services, and secure-content absence after stale preference attempts. The Navis composition owns `scripts/verify-excluded-web-apis.py`, its source/objdir/package checks and ordinary-content fixture. Pair negative tests with retained media, WebAuthn, Worker/ServiceWorker, permission, navigation and extension regressions. No removed API needs peripheral, wallet, payment-provider or headset acceptance.

## Local PDF and printing checks

```sh
node tests/pdf-document-boundary.mjs
node tests/desktop-printing.mjs
node tests/android-documents.mjs
```

These deterministic checks cover authenticated viewer/save authority, blob/original addresses, embedded download sandboxing, stale-document denial, print-host ownership/modal rollback and private Android print lease cancellation. They do not prove PDF rendering or native printers. Required packaged-runtime checks include local/HTTP/ranged/encrypted/malformed PDFs, viewer find/navigation/accessibility, form and annotation edited-file save/reopen, print events, cancellation, ordinary/private isolation and native Save as PDF. Desktop tests must exercise the real preview/settings host; Android must exercise content-provider grants and the system spooler on a device. Keep failed attempts, build/package identities and human appearance/device acceptance separate.
