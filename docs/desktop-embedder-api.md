# Desktop embedder API

Source API version: 2; native ABI remains out of scope Version scope: Firefox ESR 153.6.0 Module: `resource://gre/modules/DesktopEngine.sys.mjs`

The source API is privileged JavaScript compiled with a pinned Gecko source dependency. It is not a stable native ABI or a promise of source compatibility with another ESR.

## Product entry point

```js
const {
  DESKTOP_EMBEDDER_API_VERSION,
  EngineRuntime,
  EngineView,
  getDesktopLocaleState,
} = ChromeUtils.importESModule("resource://gre/modules/DesktopEngine.sys.mjs");

if (DESKTOP_EMBEDDER_API_VERSION !== 2) {
  throw new Error("Unsupported Desktop Embedder source API");
}

const runtime = new EngineRuntime();
const createView = () => new EngineView({ document, host: viewHost });
const session = runtime.createSession({ view: createView() });
```

Products use `ChromeUtils.importESModule` because this module belongs to Gecko's privileged module loader. A static DOM-module import from a product `chrome://` document does not establish the same loader boundary.

## `EngineRuntime`

Construction takes no arguments. Runtime is a process-level owner and captures neither a chrome window nor a product View factory. A window enters the Runtime only when a product explicitly supplies one of its Views to `createSession()` or `adoptInitialSession()`.

Public state and operations:

- `sessionCount`, `windowCount`, `closed`, and immutable build `capabilities`;
- process-level display locale is read through the module-level `getDesktopLocaleState()` function before Runtime construction; locale mutation remains bounded by `runtime.setLocaleSetting()`, and `await runtime.relaunchForLocaleChange()` closes any live toolbox before asking Gecko to restart;
- immutable `processIsolationState` and bounded `setProcessIsolationMode(mode)` / `await relaunchForProcessIsolationChange()` operations;
- `ready`, which resolves after the profile and application built-ins are ready;
- `downloads`, an immutable array of projected download states;
- `createSession({ view, delegates?, privateMode? })`;
- `adoptInitialSession({ view, delegates? })`;
- `activateSession(session)`;
- `close()`;
- `getWindowState(window)` and `openPlatformWindow({ ownerWindow, uri, privateMode? })`;
- `setSessionDelegateFactory(factory)`;
- `setNavigationDelegate(delegate)`;
- `setDownloadDelegate(delegate)`;
- `setHistoryDelegate(delegate)`;
- `setHistoryVisited(uri, visited)`, `queryHistory()`, `deleteHistory()`, and `clearHistory()`;
- `listBookmarks()`, `createBookmark()`, `updateBookmark()`, `moveBookmark()`, and `removeBookmark()`;
- `listCredentials()`, `saveCredential()`, `revealCredential()`, `removeCredential()`, and `clearCredentials()`;
- `setCredentialReauthenticationPresentation({ reason, caption })`;
- `configurePrinting({ ownerWindow, styleSheets? })` supplies bounded packaged presentation styles before a print dialog opens;
- `loadSessionState()` and `saveSessionState()`;
- `clearSiteData()`;
- `measureSessionMemoryUsage(session)`;
- `getDeveloperToolsState(session)`, `toggleDeveloperTools(session, options?)`, and `closeDeveloperTools(session)`;
- `getStartupURIs({ window, fallbackURI })`;
- `cancelDownload(id)`, `retryDownload(id)`, and `removeDownload(id)`;
- `getExtensionInventory()` for the general extension-manager projection.

`setSessionDelegateFactory()` must run before the first session is created. It is the normal way to ensure that sessions created by Gecko popup/new-window requests receive the same delegates as product-created sessions. A product can instead pass a `content`, `permission`, `prompt`, `media`, and/or `crash` delegate bag to one `createSession()` call. Delegate installation completes before the backing remote browser is created.

`adoptInitialSession()` is the startup path for a native content-created window. It returns a normal Session for the exact initial document already selected by Gecko, or `null` when the host has no pending content. Call it before creating any other Session in that host and before the chrome document finishes loading: native creation checks for initial content at that point. A module bootstrap must retain startup in its static dependency graph instead of leaving a detached dynamic import to complete after `load`. Make the initial View visible and activate the returned Session before awaiting `runtime.ready`; profile-dependent presentation can follow readiness, and closing the host during that wait must close its Runtime. It uses the same delegate factory and View/Core ownership as `createSession()`, preserves the native opener and origin attributes, and does not load a replacement URL. The caller adopts the returned Session without calling `open()` or restoring saved tabs; ordinary startup can reuse the unbound View when the result is `null`. Native actor adoption is attempted once per host, including failures and reentrant callbacks. Failure closes the partially created Session and never permits actor reuse. The native open-window descriptor remains private to Runtime.

Every Session initially requires an explicit, currently unbound `EngineView`. Reusing a View that is still owned by another Session is rejected. A live Session can later detach from that View and attach to another one. Active Session state is tracked per chrome window and follows a cross-window attachment, so two windows can each have an active remote browser without deactivating one another.

`close()` is idempotent. Its first call closes every owned Session, unregisters every registered window and the Toolkit download observer, clears download projections, releases delegates owned by that Runtime, and rejects later Session creation. Unloading one registered window closes only the Sessions whose current View or detached-content parking host belongs to that window and decrements `windowCount`; it does not close the process Runtime or Sessions in other windows. Attaching a Session to a View in another window moves that lifecycle ownership to the destination window. The Runtime owner must still call `close()` during application shutdown. If another Runtime has since become the process-wide HistoryDelegate owner, closing the older Runtime does not clear the newer owner's delegate.

Runtime is not an `EventTarget`. Downloads and popup rejections cross the boundary only through their delegates. A Gecko-approved new-window request is delivered through `NavigationDelegate.onSessionCreated()` after the Session's delegate factory and backing remote browser have been installed.

The runtime owns global browser-window integration and Toolkit download observation. It does not own product tabs or toolbar UI.

### Extension projection

The general extension manager remains authoritative. Runtime exposes frozen inventory/action/page-action state and generic commands to Platform without placing extension state in the public Rust Core. Built-ins use the same action, popup, options and lifecycle APIs as user extensions; no per-extension private adapter is part of this API.

`capabilities` is a frozen build-fact object. It currently exposes Boolean `builtInExtensions`, `developerTools`, `jpegXL`, `mediaCapture`, `peerConnection`, `passwordManager`, `persistentData`, and `privateBrowsing` fields. `passwordManager` reports the Navis-owned local credential contract; it does not mean that Firefox Login Manager is present. The maintained general-browsing profile retains WebRTC and camera/microphone capture and reports both graphs as true. Web Push is excluded from the Navis runtime graph. `jpegXL` means that the decoder is compiled in; a product preference can still leave that compiled capability dormant. Products use these facts to install or present optional policy surfaces without probing Gecko implementation objects.

### Page developer tools

`developerTools` is true only when the Desktop Embedder was built with the complete Gecko page-tool closure. Generic Desktop Embedder consumers do not receive that closure unless they opt in at configure time.

`getDeveloperToolsState(session)` returns a frozen `{ available, open, host, tool }` snapshot. `host` and `tool` are strings or `null`; the snapshot never contains a browser element, target front, toolbox, actor, protocol client or other Gecko object. The Session must be live and owned by the receiving Runtime.

`toggleDeveloperTools(session, { toolId? } = {})` opens the selected page tool for that Session in Gecko's bottom host, closes an already-open docked toolbox, or raises an already-open separate toolbox window. `toolId` selects only an upstream page-tool panel; Platform cannot use this command to request Browser Toolbox or parent-process debugging. A build without the capability rejects the command instead of presenting a nonfunctional surface.

`closeDeveloperTools(session)` closes that Session's toolbox and returns whether one was open. It is safe when the capability is compiled out and does not instantiate the private adapter. Runtime shutdown closes all remaining toolboxes. Product tab teardown calls this bounded operation before destroying the Session host.

Before a Session browser is detached or transferred to another View, Runtime retires its current toolbox before `swapDocShells()` changes the browser host. An F12 request after the transfer waits for that teardown and can open a new toolbox against the destination host; an asynchronous open from the old target cannot publish stale state. The private tab identity remains stable while its membership moves between the per-window tab lists, and active selection follows it to the destination window only when that Session was active in its source window.

The DevTools adapter and its Gecko compatibility facade are private Binding details. Product code owns the F12 shortcut, application-menu entry and per-Session presentation host, but may interact with the toolbox only through these Runtime operations and their immutable state projection. A page-context Inspect command passes a short-lived `ContentDOMReference` only across the private Binding boundary; neither the node nor its identifier enters the public ContextMenuDelegate descriptor. This additive surface retains source API version 2.

The adapter also owns its lifecycle instead of attaching Firefox's browser integration to a Navis window. It obtains `gDevTools` and `DevToolsServer` directly, installs only the bounded Navis window facade, closes per-Session toolboxes before transfer or destruction and registers its own profile-shutdown blocker. Docked hosts and RDM still consume `gDevToolsBrowser`'s shared stylesheet service, but the adapter immediately removes its Firefox browser-window, menu-startup and shutdown observers. No Firefox menu document or Firefox-window lifecycle becomes part of the Navis product shell.

On Linux and Windows the product keyset mirrors the pinned ESR page-tool bindings for Ctrl+Shift+I, Inspector, Console, Debugger and Network, in addition to F12. It deliberately does not register Browser Toolbox or Browser Console shortcuts. The private tab registry sends its existing facade events for RDM and local descriptor consumers and also bubbles browser-targeted `TabOpen`, `TabSelect` and `TabClose` DOM events to the owning chrome window for Gecko's server-side `BrowserTabList`. `TabClose` is emitted while the browser element and registry entry are still live.

Responsive Design Mode retains Gecko's device selector, numeric width and height fields, and drag handles. Gecko's own RDM stylesheet owns viewport geometry; leaving the mode restores ordinary Session layout. The preset catalog is the packaged-only `main/devtools-devices` Remote Settings bootstrap, so presets work offline and this consumer never synchronizes that collection. Candidate interaction evidence must select a featured preset and observe its exact content viewport, then independently commit numeric width and height, rotate them, and (when the AT-SPI bridge exposes screen extents) resize through a real pointer drag. A bridge that exposes the remote document without screen extents must be recorded as a geometry limitation; it must not be worked around with guessed coordinates. The independent WebDriver viewport assertions remain required. Merely opening an empty selector is not a passing device-emulation result.

## `EngineSession`

A session owns one browsing lifecycle and its projected state.

Public state and operations:

- `id`, `state`, and `view`;
- `open(uri)` and `close()`;
- `loadUri(uri)`, `goBack()`, `goForward()`, `reload()`, and `stop()`;
- `fillCredential(id)` for an ID currently projected to that Session;
- `restore()` after a content-process crash;
- `executeContextMenuCommand(requestId, command)` and `dismissContextMenu(requestId)` for the current short-lived menu request;
- `setDelegates({ content?, contextMenu?, permission?, prompt?, media?, crash? })`;
- `setContentDelegate()`, `setContextMenuDelegate()`, `setPermissionDelegate()`, `setPromptDelegate()`, `setMediaDelegate()`, and `setCrashDelegate()`.

Session is not an `EventTarget` and exposes no direct native-prompt response method. State, crash, prompt, and media changes have one product path: their declared delegates.

`loadUri()` and `restore()` are browser-owned navigations. They retain the system caller needed to enter an exact privileged internal route, while always setting Gecko's `LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL`. A Web destination can therefore never inherit authority from the internal or Web document it replaces, and ordinary HTTP(S) channels remain eligible for extension network interception. Gecko-originated content, popup, and extension navigations keep their supplied triggering principal through the private Binding path.

`view` is the current `EngineView`, or `null` while detached. Detachment does not close or serialize the Session. Its live remote browsing context remains owned by Runtime, so navigation, reload, delegates, and session history can continue while no product View presents it. `close()` releases either the attached browser or the detached lifecycle.

Session state is a frozen plain object. It contains no principal, browsing context, XPCOM request, actor, device handle, or browser element.

Its navigation projection contains:

- `navigationId`, a per-Session monotonically increasing Core identity (`0` before the first navigation);
- `navigationRevision`, a monotonically increasing revision of the normalized Core navigation snapshot;
- `url`, `title`, `baseDomain`, and `loading`; `baseDomain` is the HTTP(S) registrable domain (with a safe host fallback) or a bounded scheme identity for internal/non-Web pages;
- `security`, one of `unknown`, `insecure`, `broken`, or `secure`;
- `canGoBack` and `canGoForward`; and
- `failureCode`, an unsigned Gecko result code for a failed navigation or `null`.

Its `credentials` projection is a frozen `{ origin, items }` object. `items` contains only frozen credential summaries for the currently discovered HTTP(S) origin; no password, key-store handle, DOM field, actor or storage object crosses the boundary. Private Sessions always project an empty set.

Public load, reload, back, forward, and restore commands allocate an identity before invoking Gecko. A top-level navigation initiated by page content gets the same kind of identity when Gecko reports its network start. Redirects and later facts retain that identity. The binding correlates request callbacks to it, and Core ignores an event carrying an older identity, so late completion from an earlier request cannot roll public state backward. `navigationId` and `navigationRevision` are observations for ordering and diagnostics; products must not invent or submit either value.

`stop()` cancels the active document load and returns `true` only when a non-crashed Session was loading. It synchronously projects `loading: false` so the product can restore its Reload affordance without waiting for a later progress callback. Calling it while idle or crashed is a no-op that returns `false`; a closed Session rejects the operation like the other navigation methods.

### Site-isolation and tab-memory projections

`processIsolationState` is a frozen `{ available, selected, active, strategy, restartRequired }` value. `available` is exactly `full`, `selective`, and `shared`; the default is `full`. These map to Gecko's `IsolateEverything`, `IsolateHighValue`, and `IsolateNothing` Web-content allocation strategies. Selecting a mode persists only the next-start choice. The active strategy is frozen early in startup and a relaunch is required to change it. Multiprocess browsing, Fission, content sandboxing, and dedicated special-content processes are not part of this setting.

`measureSessionMemoryUsage(session)` asynchronously returns a frozen `{ available, bytes, processCount, estimated: true }` snapshot. Binding walks the Session's live browsing-context tree, correlates real OS process IDs with `ChromeUtils.requestProcInfo()`, gives a top-level frame twice a subframe's weight, and divides shared-process memory among all live Navis Sessions. The result is suitable for a user-facing approximate tab value; it is not exact per-document memory accounting. Missing or racing process information returns `available: false` rather than inventing a number.

## `EngineView`

`new EngineView({ document, host })` owns creation, attachment, visibility, activeness, crash hiding, replacement, and destruction of the native remote `<browser>` element. Its public surface is `attached`, `session`, `visible`, `focused`, `bounds`, `focus()`, `blur()`, `attach(session)`, and `detach()`; the backing element is intentionally private.

```js
const session = runtime.createSession({ view: firstView });
session.open(uri);

firstView.detach();
secondView.attach(session);
```

`detach()` returns the released Session, or `null` when the View is already unbound. On success, both `view.session` and `session.view` become `null` while the browsing lifecycle remains live. `attach(session)` returns the View. It is idempotent for the same existing binding, rejects a closed Session, rejects a Session that has not explicitly detached its current View, and rejects a View already owned by another Session. Closing a Session also releases its View so that the product can bind that View to a later Session.

The implementation does not move the `<browser>` DOM node. Runtime creates a layout-connected, off-screen parking browser and uses Gecko's frame-loader swap to transfer the live browsing context into a freshly connected browser in the destination View. This works on both ESR 140 and ESR 153; direct DOM moves would destroy the frame loader on ESR 140. URL, title, delegates, JavaScript state, and session history therefore stay with the Session rather than with a particular View.

Both chrome documents must have the same principal and compatible origin attributes, and both source and destination hosts must participate in layout at the instant of transfer. In particular, a disconnected host or an ancestor with `display:none` cannot supply the native frame required by Gecko. A rejected transfer leaves the Session detached and usable, and leaves the destination View unbound. These are source-contract errors; native Gecko objects are never returned to the product.

Detachment is a presentation operation, not discard or suspension. It retains the remote browsing context and its memory. Each transfer also creates and then destroys a blank placeholder browser, so products should use it for real presentation changes rather than high-frequency animation.

`visible` is true only while the View is attached to a live, active, non-crashed Session and its presentation is not hidden. Runtime activation is separate from input ownership: activating a Session can render its View but does not implicitly steal focus. `focused` reports whether its content browser currently owns focus. `focus()` acquires content focus only for a visible View and returns whether it did so; `blur()` releases focus only when owned and is otherwise an idempotent no-op.

`bounds` is a frozen snapshot of the product host's current rectangle in chrome CSS pixels, with `x`, `y`, `width`, and `height` fields. It is observational: the product's layout/CSS remains the sizing authority, and the API deliberately has no bounds setter. A detached View can still report its host rectangle even though `visible` is false.

This is an additive completion of the View lifecycle promised by source API v2, so `DESKTOP_EMBEDDER_API_VERSION` remains `2` under the compatibility rule in [desktop-embedder-source-package.md](desktop-embedder-source-package.md).

## `NavigationDelegate`

```js
runtime.setNavigationDelegate({
  onNewSession(request) {
    return {
      allow: true,
      activate: request.disposition !== "background",
      view: createView(),
    };
  },

  onSessionCreated({ session, activate }) {
    presentSession(session, { activate });
  },

  onPopupBlocked(request) {
    showBlockedPopup(request.uri, request.reason);
  },
});
```

`request` is frozen plain data with `uri`, `disposition`, `external`, and `hasOpener`. The delegate returns a bounded allow/activation/View decision. The View is product-owned presentation allocation performed before Gecko's synchronous open-window call creates the backing browser. Returning Boolean `true`, omitting `view`, or returning an already-bound View fails closed. Gecko's user-activation popup blocker runs before this delegate. A `NavigationDelegate` must implement both `onNewSession()` and `onSessionCreated()`; an incomplete delegate is rejected at installation. `onSessionCreated()` receives frozen lifecycle details containing the public `EngineSession`, `reason`, `activate`, and `openerSessionId`. Optional `onPopupBlocked()` receives frozen `uri` and `reason` data when the adapter or product policy rejects a request. Lifecycle delivery is synchronous because Gecko needs the backing browser before its open-window call returns. If the callback throws, returns a Promise, or closes the Session, the new Session is closed as needed, the previous active Session is restored, and the request is reported as blocked. If no NavigationDelegate is installed, new Session requests fail closed rather than creating an unowned background Session.

## `HistoryDelegate`

```js
runtime.setHistoryDelegate({
  onVisited(request) {
    persistVisit(request);
    return true;
  },

  getVisited(urls) {
    return urls.map(url => historyStore.has(url));
  },

  onTitleChanged(change) {
    persistTitle(change);
  },

  onClear() {
    historyStore.clear();
  },
});
```

The Desktop Embedder implements Gecko's native `IHistory` boundary and the Fission visited-link IPC without restoring Places, frecency, Places Sync or their Firefox product modules. Its default Core-private profile store keeps local visit/title/time rows in `navis.sqlite`, maintains a synchronous visited cache and installs its own `HistoryDelegate`. A reusable consumer may replace that process-wide delegate when it owns an alternative history policy:

- `onVisited(request)` receives frozen plain data containing `url`, optional `lastVisitedUrl`, Gecko visit `flags`, and `browserId`. Returning a Boolean selects the URL's immediate visited state.
- `getVisited(urls)` returns one Boolean per URL for initial link coloring.
- `onTitleChanged(change)` optionally receives frozen `url` and `title` data.
- `onClear()` clears the delegate-owned product store when the runtime receives an explicit clear request.
- `setHistoryVisited(uri, visited)` publishes a later store result to every interested content process; `clearHistory()` publishes unvisited state for all URLs held in the fallback session cache after invoking `onClear()`.

The initial `getVisited` answer is synchronous in E3. A product with an asynchronous store can return its cached answer and call `setHistoryVisited` when durable state arrives. History is process-wide in Gecko, so this delegate is also process-wide; the most recently installed delegate is active. Products should install one owner during startup rather than assigning one per tab.

If no delegate is installed, the native backend still provides session-only visited-link state in memory. `EngineRuntime` normally installs the durable profile delegate during construction; private Session visits and titles are discarded before that store boundary.

## Persistent profile operations

`queryHistory({ search?, limit? })` returns a frozen, most-recent-first array of frozen `{ url, title, lastVisitedAt, visitCount }` records. `deleteHistory(urls)` and `clearHistory()` update durable rows and project the corresponding unvisited state through Gecko's native visited-link boundary.

Bookmarks are frozen plain records with `id`, `parentId`, `type`, `url`, `title`, `position`, `createdAt`, and `updatedAt`. The synthetic `root` folder is not stored as a row. Folder moves reject cycles; sibling positions remain contiguous; deleting a folder recursively deletes its descendants. Platform sees no SQLite or Places object.

`saveSessionState({ sessions, selectedSession })` accepts an ordered nonempty set of live normal Sessions with exactly one selected item. It stores only normalized URLs, order and selection. A private-only set returns `false`, and mixing normal and private Sessions is rejected. `loadSessionState()` returns the frozen stored projection; it never recreates Gecko objects itself.

`getWindowState(window)` exposes only the immutable private-mode fact. `openPlatformWindow()` accepts an application-owned `chrome://` URI and asks Gecko to create a normal or private host window. Session private identity is allocated in shared Rust Core, is immutable for the Session lifetime, and must match the host window before a remote browser is created.

Credential summaries contain `id`, normalized `origin` and `actionOrigin`, `username`, bounded field names, timestamps and use count, but never a password. `saveCredential()` creates or updates the same origin/username identity. `revealCredential(id, { window })` is the only public operation that returns a password and requests native reauthentication on Windows and macOS; Linux has no Gecko OS-reauthenticator and therefore requires an explicit Platform reveal gesture. `removeCredential()` deletes one row and `clearCredentials()` removes all rows plus the profile's unreferenced key.

Desktop Platform supplies the localized native-prompt reason once per Runtime through `setCredentialReauthenticationPresentation({ reason, caption })`. Storage and Core do not own that natural-language string; an embedder that does not supply one receives the operating system's generic presentation.

Each profile stores only a random key identifier and ciphertext in `navis.sqlite`. The corresponding encryption key is generated and retained by Gecko's `nsIOSKeyStore`: macOS Keychain, Windows Credential Manager, and libsecret with Gecko's NSS key-store fallback on GTK. Profiles never share a key label, so clearing one cannot invalidate another. If a populated profile's key is missing, Navis fails closed instead of silently generating a new key over unreadable rows.

`clearSiteData()` composes the retained Cookie, Quota/Service Worker, Reporting, HSTS, authentication, storage-permission and related security-state cleaners. It deliberately does not call upstream aggregate flags whose Push, EME or Cookie Banner cleaners belong to capability graphs excluded from Navis. Any retained cleaner failure rejects the operation for product UI.

## `ContentDelegate`

```js
session.setContentDelegate({
  onStateChanged(state) {
    render(state);
  },
});
```

`onStateChanged()` receives the same frozen session projection returned by `session.state`: URL, title, loading, security, back/forward availability, crash/closed state, current permission or prompt descriptor, and frozen `media` recording state. Camera/microphone indicators follow actual frame-owned capture, including acknowledged stop and teardown. It is the primary product presentation input. Installing a delegate does not replay state synchronously; products should read `session.state` for an initial snapshot and install delegates before `open()`.

## `ContextMenuDelegate`

```js
session.setContextMenuDelegate({
  onShow(request) {
    renderProductMenu(request);
  },

  onDismissed(request) {
    dismissProductMenu(request.id, request.reason);
  },
});
```

`onShow()` receives a frozen descriptor containing `id`, `sessionId`, frozen window-relative `position`, frozen context booleans, bounded link/image/media addresses, bounded selected text and a frozen ordered `items` list. Each item contains only `id`, semantic `group` and current `enabled` state. Labels, shortcuts, grouping visuals, focus and accessibility remain Platform-owned. The one bounded exception is a `spelling` item: one of the five fixed `spell-replace-0` through `spell-replace-4` slots additionally carries the dictionary-produced `suggestion` string. Platform presents that string verbatim; it is not product-localized text. The context projection exposes only a `misspelled` Boolean and never the editor or spellcheck range.

The content actor retains the target privately. The product chooses an offered and enabled item through `executeContextMenuCommand()` or closes the request through `dismissContextMenu()`. A newer menu, navigation, crash, browser/View replacement or Session close invalidates the old request; stale IDs and disabled/unoffered commands return `false`. `onDismissed()` is optional and contains only `id`, `sessionId` and a bounded reason. DOM targets, actors, browsing contexts, principals and clipboard services never cross this public contract. Spell replacement follows the same token and navigation checks and executes in the originating content process through Gecko's editor.

Address commands use the URL captured when the menu opened and the originating document. Hiding, removing or adopting the original element does not invalidate an offered Open in New Tab or Copy Address command. Element mutations still require the live target in its original document. A browser-owned context menu retains the page's mouse/pointer hover for its entire open lifetime, including movement outside the popup back over content. Closing or cancelling releases deferred exits before restoring the latest real pointer target, including its precise cross-process subframe, and requesting native pointer hit testing. A later real exit discards an obsolete move; synthetic moves cannot replace the held physical position. Other chrome windows and ordinary page input remain unaffected.

`formatAddressForDisplay(value)` returns a plain, readable URL string using Gecko's safe IDN display and lossless URL-bar decoding. Reserved escaped delimiters, literal percent sequences and dangerous invisible/control characters retain their encoding. It does not change `session.state.url` or navigation input. `copyAddressLink(value)` copies a canonical encoded HTTP(S) URL and applies the current Clean Links policy. Platform uses the original Session URL when copying or cutting the entire unmodified displayed address; partial selections and user-edited text retain ordinary text-copy behavior, with the existing full-URL Clean Links policy still applicable to edited HTTP(S) addresses.

## `PermissionDelegate`

```js
session.setPermissionDelegate({
  async onRequest(request) {
    return showProductPermissionUI(request);
  },

  onUpdated(request) {
    updateProductPermissionUI(request);
  },

  onCanceled(request) {
    dismissProductPermissionUI(request.id, request.reason);
  },
});
```

`onRequest()` receives a frozen descriptor with `id`, `category`, `kind`, `permissions`, `origin`, `frameOrigin`, and `userGesture`. Its frozen `decisions` list is authoritative: private requests omit persistent grants, and choosers may omit unsupported actions. The result is a decision or a Promise for one of the offered decisions:

- `allow-session`;
- `allow-always`;
- `block`;
- `dismiss`.

When a request contains `choices`, each key identifies a choice group containing frozen `{id, label}` options. Camera and microphone requests use independent groups. An allow response must be `{decision, choices: {camera: "1", microphone: "0"}}`, selecting exactly one offered ID for each group; an omitted, extra or forged selection fails closed. IDs are private to that request. Native device paths and handles are never projected. A stored media grant does not silently select among multiple candidate devices.

`onUpdated()` is optional. A live device chooser can start empty and change its frozen choices while retaining the same request ID and original decision Promise. Only the active FIFO entry delivers updates; a queued request supplies its latest snapshot when first shown. Preserve an explicit selection if its ID remains offered, clear it when removed, and disable confirmation without a current selection. Never infer a selection from an option's position. Responses are checked against the latest choices, and cancellation stops further updates.

An invalid value, missing/`undefined` decision, exception, or rejected Promise fails closed to `dismiss`. `onCanceled()` is optional and reports a pending request invalidated by Session close, navigation, crash, native cancellation, permission changes or Delegate replacement. Batch cancellation removes affected requests before the next prompt is dispatched. Principals, native permission requests, and device handles never cross the boundary.

`runtime.getSitePermissionState(session)` returns `{available, origin, navigationId, permissions}` for the current authenticated HTTP(S) page and its attached Web frames. Each permission has `kind`, `label`, display `origin`, an opaque `originToken`, `embedded`, `state` (`ask`, `allow`, `block`), `temporary` and offered `decisions`. The native principal, origin attributes and window identities stay private. Unavailable capabilities are omitted. `await runtime.setSitePermission(session, {navigationId, originToken, kind, decision})` rejects foreign Sessions, stale navigation and tokens for removed or replaced documents. Tokens are not transferable between Sessions.

Grants and blocks use the exact requesting principal, including private/container attributes; private decisions last only for the session. Permissions Policy limits whether an embedded document may request an API, but does not transfer the embedding site's grants. Native permission queries, prompts and revocation share this ownership. Reset or block reaches that principal in every live Session, including embedded documents. Media stop waits for actor delivery and reports failures; an individual origin reset leaves other origins' capture intact. `await runtime.stopSiteDevices(session, {navigationId, kind})` accepts `camera` or `microphone` and stops capture for every currently attached Web origin in that tab. Media consent authenticates both requesting and embedding documents. A late decision for a replaced frame cannot persist a grant. Media indicators follow actual recording state; stop waits for actor delivery and reports failures.

External-device, XR, payment, federated-identity and digital-wallet requests are outside the product contract. There is no background-device activity projection. Ordinary WebAuthn, credential operations and camera/microphone selection use their retained delegates.


## `PromptDelegate`

```js
session.setPromptDelegate({
  async onPrompt(request) {
    return showProductPrompt(request);
  },

  onCanceled(request) {
    dismissProductPrompt(request.id, request.reason);
  },
});
```

`onPrompt()` receives a recursively frozen, plain-data descriptor for JavaScript modal dialogs, HTTP authentication, select prompts, before-unload decisions, and Navis credential save/update decisions. Common fields are `id`, `sessionId`, `category`, `kind`, `origin`, `frameOrigin`, `title`, `message`, `modalScope`, `beforeUnload`, `buttons`, `defaultButton`, `cancelButton`, and an optional `checkbox`. Authentication descriptors additionally report `insecureAuth` and `crossOriginAuth`; no channel, principal, browsing context, prompt actor, or authentication object crosses the boundary.

`kind` is one of `alert`, `confirm`, `text`, `auth`, `choice`, `before-unload`, `password-save`, `password-update`, or `unknown`. Credential descriptors use `category: "credential"`, contain a display-only username, and never carry the captured password. Their `title`, `message`, and button labels are intentionally empty: Platform derives localized presentation from `kind`, `username`, and button role rather than putting natural language in the shared descriptor. The optional frozen `input` is one of:

- `{ type: "text", defaultValue }`;
- `{ type: "credentials", defaultUsername, passwordOnly }`; or
- `{ type: "choice", choices, selected }`.

The delegate returns a response or Promise with `action: "accept"` or `"dismiss"` and, optionally, a valid projected button number and checkbox state. An accepted text response may carry `value`; credentials require `password` and may carry `username`; a choice may carry `selected`. Invalid values, exceptions, and rejected Promises are normalized to dismissal. A missing/`undefined` response is normalized to dismissal. If no PromptDelegate is installed, the request is also dismissed rather than invoking Firefox product UI.

Prompt and permission requests share one FIFO per Session, so two product surfaces cannot race for the same tab-modal slot. Optional `onCanceled()` gets the descriptor plus `reason`: `session-closed`, `navigation`, `crash`, `actor-destroyed`, or `native-canceled` as applicable.

The Desktop Embedder supplies product-neutral Gecko service bridges for the generic web cases: the Prompt actor, HTTP-auth prompt factory, and prompt collection used by before-unload, form repost, and folder-upload confirmation. It does not import Firefox Login Manager, Firefox password storage/autofill/capture, Firefox tab UI, PDF.js special dialogs, profile-reset UI, or Firefox prompt telemetry. Navis supplies its own bounded actor, encrypted profile store and Platform surface as a separate product capability.

## `WebAuthnDelegate`

```js
session.setWebAuthnDelegate({
  async onRequest(request) {
    return showProductWebAuthnUI(request);
  },

  onCanceled(request) {
    dismissProductWebAuthnUI(request.id, request.reason);
  },
});
```

The frozen descriptor contains `id`, `sessionId`, `category: "webauthn"`, `kind`, an authenticated `origin` and display `host`, optional related-origin or conditional `rpId`, optional retry/error state, a frozen bounded account list and the exact frozen `actions` accepted for that state. It never exposes Gecko's transaction ID, principal, browsing context, credential ID, device handle or callback.

Responses use `cancel`; `submit` plus a bounded `pin`; `select` plus a valid account index; `allow-identifying-attestation`; `continue-anonymized`; or `continue` for related-origin consent or the conditional “another authenticator” path, but only when that action was offered. Conditional credential IDs remain in Binding and only their displayed account index enters this contract. Invalid, missing, throwing or rejected responses fail closed. `onCanceled()` is optional and dismisses an update, native cancellation, navigation, crash, Delegate replacement or Session close. WebAuthn participates in the same per-Session prompt FIFO described above and blocks content fullscreen while active. The complete state/action and security contract is in `navis-webauthn.md`.

## `DownloadDelegate`

```js
runtime.setDownloadDelegate({
  onDownloadsChanged(downloads) {
    renderDownloads(downloads);
  },
});
```

The callback receives a frozen array of frozen projected downloads. Each item contains exactly `id`, `fileName`, `sourceUrl`, `private`, `status`, `progress`, `currentBytes`, `totalBytes`, `canCancel`, and `canRetry`. `status` is one of `pending`, `downloading`, `complete`, `canceled`, or `failed`. No target path, partial-file path, file handle, Toolkit download object or principal crosses the boundary.

Legal mutations remain the bounded Runtime methods `cancelDownload(id)`, `retryDownload(id)`, and `removeDownload(id)`. Cancel and removal discard partial data. Retry also discards stale partial/HTTP-resume state before starting again, so a failed non-resumable transfer is retried from byte zero. Native destination selection remains Toolkit behavior when product preferences do not select an automatic directory. Platform filters the frozen `private` identity so a normal and private window never present each other's transfer list.

## `MediaDelegate`

`session.setMediaDelegate({ onStateChanged(media) {} })` receives frozen `sessionId`, `camera`, `microphone`, and `screen` booleans. This callback is the product indicator boundary; permission decisions remain in `PermissionDelegate`. A product should install this delegate only when `runtime.capabilities.mediaCapture` is true; Navis follows that rule.

## `CrashDelegate`

`session.setCrashDelegate({ onCrash(details) {} })` receives frozen `sessionId`, `browsingContextId`, and `childId` data after the Session has entered its crashed state. The product can present recovery and call `session.restore()` without receiving a process handle or browser element.

## Source API version and current omissions

Source API version 2 retains version 1's Delegate-only surface and removes the one-window Runtime constructor. Runtime is process-level, View allocation is explicitly product-owned, and window unload has per-window scope. Navis and the independent shell consume Content, Permission, Prompt, Media, Crash, Download, Navigation, and History delegates exclusively. Delegate exceptions are contained at the adapter boundary, with navigation, permission, and prompt errors specifically failing closed. The version identifies this source contract; it is not a stable native ABI or a promise that Gecko-private implementation files remain unchanged across ESRs.

JavaScript modal, HTTP authentication, and before-unload paths now use the public `PromptDelegate`; Navis provides one consumer UI and the independent shell provides a second consumer. File input continues through the native Toolkit picker rather than a product file-handle API. Persistent credentials are intentionally absent until a product-owned storage contract is designed.

## Product-independent contract shell

`tests/embedder-shell/` is a product-independent consumer with no Navis toolbar, tab, or prompt-panel code. It temporarily opens a second real chrome window and proves that one Runtime owns both window contexts, then closes that window and verifies that only its Session is released. The shell also verifies explicit and factory delegate installation, frozen callback values, and a Fission history round trip. It is rejected if it enters a release package.

## Compatibility rules

- Product code must not inspect the private browser element or process actors.
- Public request and state values must remain immutable plain data.
- Tabs, windows, persistence, and presentation remain product concepts.
- Fission remoteness and sandbox behavior remain adapter/Gecko concerns.
- History persistence, bookmarks, and ranking remain product capabilities; Gecko's visited-link protocol remains an embedder responsibility.
- Runtime-created popup sessions must receive the same delegate factory as product-created sessions.
- API changes require both product-independent and Navis-consumer contract tests before the surface is called stable.

## Local documents and printing

Immutable capabilities `pdfViewer` and `printing` describe the built-in PDF.js reader and local printing host. `session.openFile()` presents the native open picker (PDF/all files) and navigates only the selected live Session. `session.print()` starts an owned Gecko print preview and returns whether a new preview was opened; repeated requests focus the existing preview. Both require an open, attached, non-crashed Session. Standard content `window.print()` uses Gecko's static-clone handoff under the same ownership checks. Closing, detaching or replacing a browser aborts its dialog and restores input/focus.

PDF conversion retains the original response/channel, range fetching, origin attributes and scripting sandbox. The reader provides its own find UI. An application may register the optional `navis-pdf-style` resource directory containing `pdf-reader.css` and its packaged imports. The private child actor attaches it as an author sheet only for the exact PDF viewer content principal. Runtime includes no reader artwork or UI rules, adds no remote stylesheet preference and leaves the upstream reader unchanged when the resource is absent. A private authenticated PDF actor saves only the current viewer's original address or a permitted viewer blob; picker waits recheck document/host ownership before writing. Embedded download sandbox restrictions remain enforced. Original and edited bytes enter the ordinary public/private download lifecycle. Explicit existing MIME preferences and OS file associations are not overwritten. PDF.js forms and basic annotations remain local; ML, remote models, telemetry and signature storage have no host implementation.

Desktop preview/settings reuse the pinned Toolkit print machinery and native printers, with Platform-supplied Material styles. Save as PDF uses an explicit native destination picker. Native principals, browsing contexts and preview clones never enter the public Core projection. Printing a webpage can use its existing network resources; Navis adds no document-processing endpoint.
