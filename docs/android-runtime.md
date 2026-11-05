# Android Runtime boundary

Android enters after the desktop 0.1.0 baseline. This is the maintained contract, not the internal chronological bring-up log or proof of a complete native run.

## Build variants

`mozconfig.android-aarch64.sccache` selects the development Debug application (`org.navis.browser.debug`) with optimized native Gecko. `mozconfig.android-aarch64.release` selects a separate Release object graph (`obj-navis-android-aarch64-release`), disables native debugging and developer options, and enables native optimization. Configure selects the matching Navis Gradle variant and JNI wrapper generation. The Release application (`org.navis.browser`) enables R8 code optimization, shrinking, obfuscation and resource shrinking; it can coexist with Debug without replacing Debug data. Neither profile alone establishes PGO training or a measured performance gain.

Runtime consumer rules preserve JNI, generated entry points, annotated reflection targets and package BuildID. Cross-language protocol values must be explicit constants, never derived from class names that R8 may rename. The application contributes its private Core JNI keep rule. Do not blanket-keep the former GeckoView API or disable shrinking to hide an integration failure. Retain R8 configuration, mapping, usage and seeds alongside the package audit; a full Release JVM suite complements, but does not replace, startup and interaction tests on the delivered ABI/device.

The composition repository documents [building and signing an Android candidate](https://github.com/navis-browser/navis/blob/main/docs/android-build.md). A Release variant signed with a test key is a performance-test candidate, not an officially signed distribution.

Platform owns Kotlin/Compose UI, menus, tabs, native storage/permission prompts and host integration. It consumes the shared Rust lifecycle Core through the Navis-owned private Android engine module. It does not adopt public GeckoView Runtime/Session/View as product owners or depend on a GeckoView AAR.

The private binding owns Gecko process/JNI startup, native windows, compositor surfaces and normalized callbacks.

Named event dispatchers can be released before native attachment or after native window teardown. Cleanup must not enter JNI with a detached handle, and repeated cleanup of an old owner must not remove a replacement dispatcher. Android packages shared permission-origin dependencies used by its host; the composition package gate verifies the delivered module dependencies.

The explicit integration inventory is:

- APZ/touch attached to the originating surface;
- IME attached through the native input connection;
- accessibility attached to the Android content surface;
- content-process termination attached to the owned Session;
- DOM fullscreen attached with bounded enter/exit semantics;
- new-window handoff attached with fail-closed ownership;
- advanced IME features require their own focused native evidence.

Source availability is not an assertion that every device/IME path is accepted. The current source verifiers and platform tests govern each interface. Browser feature, preference, persistence and failure semantics follow the common capability matrix; native layouts and gestures may adapt. Developer tools run inside the application using Gecko's page toolbox rather than substituting a remote-debugging toggle. Unsupported authentication/device integrations fail closed and may not be represented as a successful native provider exchange.

Site permission state includes the current page and its attached Web origins. The backend issues opaque origin tokens tied to those native documents; Platform returns an offered token with the site-information navigation token when changing a permission. Removed or replaced frame tokens fail closed. Grants belong to the requesting origin, subject to Permissions Policy; an embedding site's grant cannot bypass the requesting site's block. Exact principal attributes isolate normal, private and container decisions. The backend propagates revocation to matching frames across all owned hosts, and the whole-tab stop operation resets every attached camera/microphone origin. Native principals, document identities and device paths never cross the immutable projection. Source and Kotlin parser tests do not establish native Android device or UI acceptance.

Camera/microphone activity crosses JNI as two immutable Boolean values. The backend aggregates current frame recording state, invalidates stale media decisions after permission changes, and waits for native media-stop delivery. Platform retains the recording indicator and site permission controls.

The Android product has no external-device, XR, payment, federated-identity or digital-wallet integration. Its manifest requests no Bluetooth scan/connect or USB-host capability for those APIs. WebAuthn, local credentials, ordinary input/Bluetooth audio, capture and general Workers remain separate retained facilities. All API exclusions follow the common Navis capability matrix and compiled graph gates.

## Local documents and system printing

Android uses the same pinned complete responsive PDF.js reader and private authenticated save actor as desktop. Ordinary navigation to a PDF resource enters the reader through MIME handling; there is no PDF-specific Open menu or file picker. Local file and content-URI access remains subject to platform access grants. Document bytes and saved edits use the existing download/open integration. PDF.js's local forms/basic annotations remain available without AI, model downloads, Nimbus or telemetry.

The private Session binding projects a print request and an owned closeable document transport. Platform receives only the title, PDF byte stream and plain media size/margins/color/page ranges. Native window and static-clone identities stay in the private backend, which rechecks the live source before each render. Standard `window.print()` retains its native snapshot and print-event lifecycle. The Android system spooler owns preview, printer selection, settings and Save as PDF. Temporary output is app-private, bounded, cancelled on finish and removed after its streams close; abandoned owned files are cleaned without touching active jobs. This is a system print integration, not a GeckoView Runtime/Session/View owner. Print preparation failures retain their bounded engine reason in a dismissible product dialog; layout/write failures retain it in the system spooler. Native built-in pages do not offer page printing or inspection. A native device run remains necessary to accept spooler and content-provider behavior.

The document bridge passes the message type and payload separately to the pinned Messaging dispatcher for webpage printing and PDF saves. Native acceptance covers menu printing and `window.print()` independently, plus original or edited viewer saves; successful menu printing alone does not verify those document-message paths.

For `window.print()`, the bridge returns the parent browser before dispatching the native print request and waits boundedly for its static snapshot to replace the initial blank document. A navigation, close or snapshot timeout cancels preparation; the native renderer retains its current-document and ownership checks.
