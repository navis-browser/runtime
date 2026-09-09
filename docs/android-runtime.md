# Android Runtime boundary

Android enters after the desktop 0.1.0 baseline. This is the maintained contract, not the internal chronological bring-up log or proof of a complete native run.

Platform owns Kotlin/Compose UI, menus, tabs, native storage/permission prompts and host integration. It consumes the shared Rust lifecycle Core through the Navis-owned private Android engine module. It does not adopt public GeckoView Runtime/Session/View as product owners or depend on a GeckoView AAR.

The private binding owns Gecko process/JNI startup, native windows, compositor surfaces and normalized callbacks. The explicit integration inventory is:

- APZ/touch attached to the originating surface;
- IME attached through the native input connection;
- accessibility attached to the Android content surface;
- content-process termination attached to the owned Session;
- DOM fullscreen attached with bounded enter/exit semantics;
- new-window handoff attached with fail-closed ownership;
- advanced IME features require their own focused native evidence.

Source availability is not an assertion that every device/IME path is accepted. The current source verifiers and platform tests govern each interface. Browser feature, preference, persistence and failure semantics follow the common capability matrix; native layouts and gestures may adapt. Developer tools run inside the application using Gecko's page toolbox rather than substituting a remote-debugging toggle. Unsupported authentication/device integrations fail closed and may not be represented as a successful native provider exchange.
