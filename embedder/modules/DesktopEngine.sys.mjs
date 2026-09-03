/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";
import { DesktopExtensionMenus } from "resource://gre/modules/DesktopExtensionMenus.sys.mjs";
import {
  DESKTOP_SEARCH_PROVIDERS,
  resolveDesktopAddressInput,
} from "resource://gre/modules/DesktopAddressInput.sys.mjs";
import {
  getDesktopCleanLinksEnabled,
  prepareDesktopCleanLinks,
  projectDesktopCopiedLink,
  setDesktopCleanLinksEnabled,
} from "resource://gre/modules/DesktopCleanLinks.sys.mjs";
import {
  isNavisInternalErrorId,
  resolveNavisInternalPageURI,
} from "resource://gre/modules/DesktopInternalPages.sys.mjs";
import {
  getDesktopLocaleState,
  initializeDesktopLocale,
  setDesktopLocaleSetting,
} from "resource://gre/modules/DesktopLocale.sys.mjs";
import {
  getDesktopProcessIsolationState,
  initializeDesktopProcessIsolation,
  setDesktopProcessIsolationMode,
} from "resource://gre/modules/DesktopProcessIsolation.sys.mjs";
import { getDesktopProfileStore } from "resource://gre/modules/DesktopProfileStore.sys.mjs";
import {
  SUBFRAME_MEMORY_WEIGHT,
  TOP_LEVEL_FRAME_MEMORY_WEIGHT,
  allocateTabMemory,
} from "resource://gre/modules/DesktopTabMetrics.sys.mjs";
import {
  registerDesktopWindow,
  unregisterDesktopWindow,
} from "resource:///modules/BrowserWindowTracker.sys.mjs";
import { forgetDesktopWebAuthnPrompt } from "resource://gre/modules/DesktopWebAuthnPrompt.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// An untitled Core navigation stays language-neutral. Platform supplies the
// localized "New tab" presentation.
const DEFAULT_TITLE = "";
const EMPTY_EXTENSION_OMNIBOX_STATE = Object.freeze({
  active: false,
  defaultDescription: "",
  extensionId: "",
  extensionName: "",
  input: "",
  keyword: "",
  suggestions: Object.freeze([]),
});
const SET_SESSION_ACTIVE = Symbol("set-session-active");
const FORGET_SESSION = Symbol("forget-session");
const CREATE_BROWSER = Symbol("create-browser");
const CREATE_VIEW_BROWSER = Symbol("create-view-browser");
const DESTROY_VIEW_BROWSER = Symbol("destroy-view-browser");
const GET_BROWSER = Symbol("get-browser");
const SET_VIEW_STATE = Symbol("set-view-state");
const LOAD_GECKO_URI = Symbol("load-gecko-uri");
const OPEN_FROM_GECKO = Symbol("open-from-gecko");
const GET_VIEW_WINDOW = Symbol("get-view-window");
const CLAIM_VIEW = Symbol("claim-view");
const RELEASE_VIEW = Symbol("release-view");
const COUNT_WINDOW_SESSIONS = Symbol("count-window-sessions");
const CREATE_PARKING_BROWSER = Symbol("create-parking-browser");
const DESTROY_PARKING_BROWSER = Symbol("destroy-parking-browser");
const ATTACH_VIEW = Symbol("attach-view");
const DETACH_VIEW = Symbol("detach-view");
const GET_CORE_SESSION_ID = Symbol("get-core-session-id");
const PREPARE_ATTACH_VIEW = Symbol("prepare-attach-view");
const COMMIT_ATTACH_VIEW = Symbol("commit-attach-view");
const COMMIT_DETACH_VIEW = Symbol("commit-detach-view");
const SET_SESSION_CRASHED = Symbol("set-session-crashed");
const BEGIN_CORE_NAVIGATION = Symbol("begin-core-navigation");
const UPDATE_CORE_NAVIGATION = Symbol("update-core-navigation");
const GET_CORE_NAVIGATION_STATE = Symbol("get-core-navigation-state");
const RECORD_HISTORY_TITLE = Symbol("record-history-title");
const QUERY_CREDENTIALS = Symbol("query-credentials");
const SUBMIT_CREDENTIAL = Symbol("submit-credential");
const SAVE_CREDENTIAL_CAPTURE = Symbol("save-credential-capture");
const SET_CREDENTIAL_STATE = Symbol("set-credential-state");
const CREDENTIAL_ACTOR_DESTROYED = Symbol("credential-actor-destroyed");
const QUEUE_CREDENTIAL_PROMPT = Symbol("queue-credential-prompt");
const QUEUE_EXTENSION_PERMISSION = Symbol("queue-extension-permission");
const SEND_CREDENTIAL_FILL = Symbol("send-credential-fill");
const FILL_CREDENTIAL = Symbol("fill-credential");
const HANDLE_INTERNAL_PAGE_COMMAND = Symbol("handle-internal-page-command");
const LIVE_ENGINE_SESSIONS = new Set();

export const DESKTOP_EMBEDDER_API_VERSION = 2;

// Products resolve process-level presentation state through the single public
// DesktopEngine module rather than importing Core-private locale machinery.
export { getDesktopLocaleState };
export { getDesktopProcessIsolationState };

const CORE_NAVIGATION_COMMANDS = Object.freeze({
  load: 0,
  reload: 1,
  back: 2,
  forward: 3,
  restore: 4,
});
const CORE_NAVIGATION_START_KINDS = Object.freeze({
  standard: 0,
  internalPage: 1,
});
const CORE_NAVIGATION_ACTIVITIES = Object.freeze([
  "idle",
  "pending",
  "visible",
  "silent",
]);
const CORE_NAVIGATION_SECURITY = Object.freeze([
  "unknown",
  "insecure",
  "broken",
  "secure",
]);
const CORE_NAVIGATION_IDENTITIES = Object.freeze([
  "unknown",
  "web",
  "internal-page",
  "built-in-extension",
  "internal-error",
]);
const CORE_NAVIGATION_IDENTITY_IDS = Object.freeze({
  unknown: 0,
  web: 1,
  "internal-page": 2,
  "built-in-extension": 3,
  "internal-error": 4,
});
const BUILTIN_EXTENSION_IDS_PREF = "extensions.applicationBuiltins.allowedIds";
const CORE_NAVIGATION_UPDATE_METHODS = new Set([
  "observeNavigationStart",
  "setNavigationLocation",
  "setNavigationTitle",
  "setNavigationSecurity",
  "setNavigationIdentity",
  "setNavigationHistory",
  "finishNavigation",
  "stopNavigation",
]);

const RUNTIME_CAPABILITIES = Object.freeze({
  builtInExtensions: AppConstants.MOZ_WEBEXTENSIONS_RUNTIME,
  jpegXL: AppConstants.MOZ_JXL,
  mediaCapture: AppConstants.MOZ_WEBRTC,
  peerConnection: AppConstants.MOZ_WEBRTC,
  passwordManager: true,
  persistentData: true,
  privateBrowsing: true,
  localization: true,
  webAuthn: true,
});

// The upstream convenience flag also invokes Push, EME and Cookie Banner
// cleaners. Those capability graphs are deliberately absent from Navis 1.0,
// so the product composes the retained storage/security cleaners explicitly.
const NAVIS_SITE_DATA_FLAGS = Object.freeze([
  Ci.nsIClearDataService.CLEAR_COOKIES,
  Ci.nsIClearDataService.CLEAR_DOM_QUOTA,
  Ci.nsIClearDataService.CLEAR_REPORTS,
  Ci.nsIClearDataService.CLEAR_HSTS,
  Ci.nsIClearDataService.CLEAR_AUTH_TOKENS,
  Ci.nsIClearDataService.CLEAR_AUTH_CACHE,
  Ci.nsIClearDataService.CLEAR_FINGERPRINTING_PROTECTION_STATE,
  Ci.nsIClearDataService.CLEAR_BOUNCE_TRACKING_PROTECTION_STATE,
  Ci.nsIClearDataService.CLEAR_STORAGE_PERMISSIONS,
  Ci.nsIClearDataService.CLEAR_MESSAGING_LAYER_SECURITY_STATE,
  Ci.nsIClearDataService.CLEAR_TLS_TOKEN_CACHE,
]).reduce((flags, flag) => (flags | flag) >>> 0, 0);
const BOOKMARK_BAR_VISIBLE_PREF = "navis.bookmarks.bar.visible";
const DEFAULT_SEARCH_PROVIDER_PREF = "navis.search.defaultProvider";
const SEARCH_PROVIDER_BY_ID = new Map(
  DESKTOP_SEARCH_PROVIDERS.map(provider => [provider.id, provider])
);

const HISTORY_VISIT_TOPIC = "desktop-embedder-history-visit";
const HISTORY_QUERY_TOPIC = "desktop-embedder-history-query";
const HISTORY_TITLE_TOPIC = "desktop-embedder-history-title";
const HISTORY_STATUS_TOPIC = "desktop-embedder-history-status";

const PROMPT_DECISIONS = new Set([
  "allow-session",
  "allow-always",
  "block",
  "dismiss",
]);
const EXTENSION_PERMISSION_TIMEOUT_MS = 2 * 60 * 1000;
const GENERIC_PROMPT_ACTIONS = new Set(["accept", "dismiss"]);
const WEB_AUTHN_ACTIONS = Object.freeze({
  "attestation-consent": Object.freeze([
    "allow-identifying-attestation",
    "continue-anonymized",
    "cancel",
  ]),
  "pin-invalid": Object.freeze(["submit", "cancel"]),
  "pin-required": Object.freeze(["submit", "cancel"]),
  "select-sign-result": Object.freeze(["select", "cancel"]),
  "related-origin-create": Object.freeze(["continue", "cancel"]),
  "related-origin-use": Object.freeze(["continue", "cancel"]),
});
const CONDITIONAL_WEB_AUTHN_ACTIONS = Object.freeze({
  accounts: Object.freeze(["select", "continue", "cancel"]),
  empty: Object.freeze(["continue", "cancel"]),
});
const DEFAULT_WEB_AUTHN_ACTIONS = Object.freeze(["cancel"]);
const CONTEXT_MENU_COMMAND_GROUPS = Object.freeze({
  "open-link-new-tab": "link",
  "copy-link-address": "link",
  "open-image-new-tab": "image",
  "copy-image-address": "image",
  "play-media": "media",
  "pause-media": "media",
  "mute-media": "media",
  "unmute-media": "media",
  "show-media-controls": "media",
  "hide-media-controls": "media",
  "open-media-new-tab": "media",
  "copy-media-address": "media",
  undo: "edit",
  redo: "edit",
  cut: "edit",
  copy: "edit",
  paste: "edit",
  "select-all": "edit",
  "spell-replace-0": "spelling",
  "spell-replace-1": "spelling",
  "spell-replace-2": "spelling",
  "spell-replace-3": "spelling",
  "spell-replace-4": "spelling",
});
const SESSION_DELEGATE_NAMES = new Set([
  "content",
  "contextMenu",
  "permission",
  "prompt",
  "webAuthn",
  "media",
  "crash",
]);

const PROGRESS_FLAGS =
  Ci.nsIWebProgress.NOTIFY_LOCATION |
  Ci.nsIWebProgress.NOTIFY_SECURITY |
  Ci.nsIWebProgress.NOTIFY_STATE_NETWORK;

const CONTENT_PERMISSIONS = new Map([
  ["geolocation", { key: "geo", label: "location" }],
  [
    "desktop-notification",
    { key: "desktop-notification", label: "notifications" },
  ],
  [
    "persistent-storage",
    { key: "persistent-storage", label: "persistent storage" },
  ],
]);

const MEDIA_PERMISSION_KEYS = new Map([
  ["Camera", "camera"],
  ["Microphone", "microphone"],
]);

let nextPromptId = 1;
let nextDownloadId = 1;
let nextContextMenuRequestId = 1;
let historyDelegate = null;
const historyDelegateOwners = new Set();
const browserPrivateModes = new Map();
let browserDelayedStartupNotified = false;
let extensionsLateStartupScheduled = false;
let extensionsLateStartupNotified = false;
let browserIdleStartupScheduled = false;
let browserIdleStartupNotified = false;

function notifyBrowserStartupComplete(ownerWindow, extensionRuntimeReady) {
  if (browserIdleStartupNotified || browserIdleStartupScheduled) {
    return;
  }
  if (!browserDelayedStartupNotified) {
    browserDelayedStartupNotified = true;
    // ScriptPreloader must stop accepting parent-process stencils before its
    // background writer is allowed to snapshot them. Firefox establishes this
    // ordering with these two notifications; a standalone embedder owns the
    // equivalent lifecycle boundary itself.
    Services.obs.notifyObservers(
      ownerWindow,
      "browser-delayed-startup-finished"
    );
  }
  if (!extensionsLateStartupNotified && !extensionsLateStartupScheduled) {
    extensionsLateStartupScheduled = true;
    // This is the SessionStore-independent WebExtension startup boundary used
    // by GeckoView/FxR.  Couple it to both AddonManager readiness (owned by the
    // extension manager) and the first real browser session so remote
    // background/options documents cannot start from a provisional policy.
    Promise.resolve(extensionRuntimeReady)
      .then(() => {
        extensionsLateStartupScheduled = false;
        if (extensionsLateStartupNotified) {
          return;
        }
        extensionsLateStartupNotified = true;
        Services.obs.notifyObservers(ownerWindow, "extensions-late-startup");
      })
      .catch(error => {
        extensionsLateStartupScheduled = false;
        console.error(
          "Desktop embedder could not signal extension late startup",
          error
        );
      });
  }
  browserIdleStartupScheduled = true;
  Services.tm.idleDispatchToMainThread(() => {
    browserIdleStartupScheduled = false;
    if (browserIdleStartupNotified) {
      return;
    }
    browserIdleStartupNotified = true;
    Services.obs.notifyObservers(
      ownerWindow?.closed ? null : ownerWindow,
      "browser-idle-startup-tasks-finished"
    );
  });
}

function optionalProperty(bag, name, fallback = null) {
  try {
    return bag.getProperty(name);
  } catch {
    return fallback;
  }
}

function validateDelegate(delegate, name, methods, requiredMethods = []) {
  if (delegate === null) {
    return;
  }
  if (typeof delegate !== "object") {
    throw new TypeError(`${name} must be an object or null`);
  }
  for (const method of methods) {
    if (
      delegate[method] !== undefined &&
      typeof delegate[method] !== "function"
    ) {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
  for (const method of requiredMethods) {
    if (typeof delegate[method] !== "function") {
      throw new TypeError(`${name} must implement ${method}()`);
    }
  }
}

function callDelegate(delegate, delegateName, method, ...args) {
  if (typeof delegate?.[method] !== "function") {
    return undefined;
  }
  try {
    return delegate[method](...args);
  } catch (error) {
    console.error(`${delegateName}.${method} failed`, error);
    return undefined;
  }
}

function freezeMediaState(sessionId, media) {
  return Object.freeze({
    sessionId,
    camera: Boolean(media?.camera),
    microphone: Boolean(media?.microphone),
    screen: Boolean(media?.screen),
  });
}

function boundedContextMenuText(value, maximum = 4096) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function contextMenuCoordinate(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function projectContextMenuItems(data, state) {
  const navigationItems = [
    Object.freeze({
      id: "back",
      group: "navigation",
      enabled: !state.crashed && state.canGoBack,
    }),
    Object.freeze({
      id: "forward",
      group: "navigation",
      enabled: !state.crashed && state.canGoForward,
    }),
    Object.freeze({
      id: "reload",
      group: "navigation",
      enabled: !state.crashed,
    }),
  ];
  const contentItems = [];
  const seen = new Set(navigationItems.map(item => item.id));
  if (Array.isArray(data?.items)) {
    for (const candidate of data.items.slice(0, 24)) {
      const id = typeof candidate?.id === "string" ? candidate.id : "";
      const group = CONTEXT_MENU_COMMAND_GROUPS[id];
      if (!group || candidate.group !== group || seen.has(id)) {
        continue;
      }
      const suggestion =
        group === "spelling"
          ? boundedContextMenuText(candidate.suggestion, 128)
          : "";
      if (
        group === "spelling" &&
        (!suggestion || containsControlCharacter(suggestion))
      ) {
        continue;
      }
      seen.add(id);
      contentItems.push(
        Object.freeze({
          id,
          group,
          enabled: Boolean(candidate.enabled),
          ...(suggestion ? { suggestion } : {}),
        })
      );
    }
  }
  const contentFirst = Boolean(
    data?.context?.link ||
    data?.context?.image ||
    data?.context?.media ||
    data?.context?.editable ||
    data?.context?.hasSelection ||
    data?.context?.misspelled
  );
  return Object.freeze(
    contentFirst
      ? [...contentItems, ...navigationItems]
      : [...navigationItems, ...contentItems]
  );
}

function indexContextMenuItems(items, result = new Map()) {
  for (const item of items) {
    result.set(item.id, item);
    if (Array.isArray(item.children)) {
      indexContextMenuItems(item.children, result);
    }
  }
  return result;
}

function freezeSettingsPageState(runtime, outcome = "ready") {
  return Object.freeze({
    pageKey: "settings",
    outcome,
    search: Object.freeze({
      providers: runtime.searchProviders,
      defaultProvider: runtime.defaultSearchProvider,
    }),
    locale: runtime.localeState,
    processIsolation: runtime.processIsolationState,
    cleanLinksEnabled: runtime.cleanLinksEnabled,
    bookmarkBarVisible: runtime.bookmarkBarVisible,
    clearSiteDataAvailable: true,
  });
}

async function freezeExtensionsPageState(
  manager,
  outcome = "ready",
  details = undefined
) {
  return Object.freeze({
    pageKey: "extensions",
    outcome,
    extensions: await manager.snapshot(),
    ...(details || {}),
  });
}

function extensionOperationFailure(error) {
  const rawCode =
    typeof error?.code === "string" ? error.code : "operation-failed";
  const code = /^[a-z0-9-]{1,80}$/.test(rawCode) ? rawCode : "operation-failed";
  return Object.freeze({ code });
}

function boundedDiagnosticValue(value, maximum = 1024) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function diagnosticEntry(label, value) {
  return Object.freeze([label, boundedDiagnosticValue(value)]);
}

function readDiagnostic(read, fallback = "") {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function formatSessionUptime() {
  try {
    const processStart = Services.startup.getStartupInfo().process.getTime();
    const totalSeconds = Math.max(
      0,
      Math.floor((Date.now() - processStart) / 1000)
    );
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
      .map(value => String(value).padStart(2, "0"))
      .join(":");
  } catch {
    return "";
  }
}

function graphicsProperty(gfxInfo, name) {
  try {
    return boundedDiagnosticValue(gfxInfo?.[name]);
  } catch {
    return "";
  }
}

function graphicsFailureCount(gfxInfo) {
  try {
    const indices = {};
    return String(gfxInfo.getFailures(indices).length);
  } catch {
    return "0";
  }
}

function summarizeRemoteProcesses(processInfo) {
  const counts = new Map();
  for (const process of processInfo?.children || []) {
    let type = boundedDiagnosticValue(process.type, 64) || "other";
    if (type === "utility" && Array.isArray(process.utilityActors)) {
      const actors = process.utilityActors
        .map(actor => boundedDiagnosticValue(actor?.actorName, 48))
        .filter(Boolean);
      type = actors.length ? `utility:${actors.join("+")}` : type;
    }
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type} (${count})`)
    .join(", ");
}

function collectSessionProcessWeights(session) {
  const weights = new Map();
  const root = session[GET_BROWSER]()?.browsingContext;
  if (!root) {
    return weights;
  }
  const visit = (context, topLevel) => {
    try {
      const pid = context.currentWindowGlobal?.osPid;
      if (Number.isInteger(pid) && pid > 0) {
        const weight = topLevel
          ? TOP_LEVEL_FRAME_MEMORY_WEIGHT
          : SUBFRAME_MEMORY_WEIGHT;
        weights.set(pid, (weights.get(pid) || 0) + weight);
      }
      for (const child of context.children) {
        visit(child, false);
      }
    } catch {
      // A navigation may replace a WindowGlobal while the tree is sampled.
    }
  };
  visit(root, true);
  return weights;
}

async function measureLiveSessionMemory() {
  const tabProcessWeights = new Map();
  for (const session of LIVE_ENGINE_SESSIONS) {
    tabProcessWeights.set(session, collectSessionProcessWeights(session));
  }
  const processMemory = new Map();
  const processInfo = await ChromeUtils.requestProcInfo();
  for (const child of processInfo?.children || []) {
    if (
      Number.isInteger(child.pid) &&
      child.pid > 0 &&
      Number.isFinite(child.memory) &&
      child.memory >= 0
    ) {
      processMemory.set(child.pid, child.memory);
    }
  }
  return allocateTabMemory(tabProcessWeights, processMemory);
}

// The diagnostic snapshot deliberately keeps every optional platform probe in
// one auditable fail-soft boundary; each probe independently contributes to
// the complexity score.
// eslint-disable-next-line complexity
async function freezeSupportDiagnosticsState(pageKey, browser, runtime) {
  let compositor = "";
  let gpuProcess = "not-active";
  let diagnosticWindow = null;
  let windowUtils = null;
  let fallbackWindow = null;
  let fallbackWindowUtils = null;
  let fallbackCompositor = "";
  const ownerWindow = browser?.ownerGlobal;
  const windows = ownerWindow ? [ownerWindow] : [];
  for (const candidate of Services.ww.getWindowEnumerator()) {
    if (candidate !== ownerWindow) {
      windows.push(candidate);
    }
  }
  for (const candidate of windows) {
    try {
      const candidateWindowUtils = candidate?.windowUtils;
      const layerManagerType = candidateWindowUtils?.layerManagerType || "";
      // Mirror Gecko's Troubleshoot graphics provider: detached/windowless
      // documents can expose "None", while the actual top-level compositor
      // is the first window with a remote LayerManager.
      if (!layerManagerType || layerManagerType === "None") {
        continue;
      }
      if (!fallbackWindow) {
        fallbackWindow = candidate;
        fallbackWindowUtils = candidateWindowUtils;
        fallbackCompositor = layerManagerType;
      }
      if (!candidateWindowUtils?.layerManagerRemote) {
        continue;
      }
      compositor = layerManagerType;
      diagnosticWindow = candidate;
      windowUtils = candidateWindowUtils;
      if (readDiagnostic(() => windowUtils.gpuProcessPid, -1) !== -1) {
        gpuProcess = "active";
      }
      break;
    } catch {
      // Windows can disappear while the enumerator is being consumed.
    }
  }
  if (!compositor && fallbackCompositor) {
    compositor = fallbackCompositor;
    diagnosticWindow = fallbackWindow;
    windowUtils = fallbackWindowUtils;
    if (readDiagnostic(() => windowUtils.gpuProcessPid, -1) !== -1) {
      gpuProcess = "active";
    }
  }
  if (!compositor || compositor === "None") {
    return Object.freeze({ pageKey, outcome: "pending" });
  }
  let gfxInfo = null;
  try {
    gfxInfo = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo);
  } catch {}
  let processSummary = "";
  let logicalProcessors = "";
  try {
    processSummary = summarizeRemoteProcesses(
      await ChromeUtils.requestProcInfo()
    );
  } catch {}
  try {
    logicalProcessors = String((await Services.sysinfo.processInfo).count);
  } catch {}
  let builtInExtensions = runtime.capabilities.builtInExtensions
    ? ""
    : "not-included";
  try {
    await runtime.ready;
    builtInExtensions = (await runtime.getExtensionInventory())
      .filter(extension => extension.builtIn)
      .map(
        extension =>
          `${extension.name} ${extension.version} (${extension.enabled ? "enabled" : "disabled"})`
      )
      .join(", ");
  } catch {}
  const adapterDescription = graphicsProperty(gfxInfo, "adapterDescription");
  const adapterIdentity = [
    graphicsProperty(gfxInfo, "adapterVendorID"),
    graphicsProperty(gfxInfo, "adapterDeviceID"),
  ]
    .filter(Boolean)
    .join(":");
  const graphicsAdapter = [adapterDescription, adapterIdentity]
    .filter(Boolean)
    .join(" — ");
  const graphicsDriver = [
    graphicsProperty(gfxInfo, "adapterDriverVendor"),
    graphicsProperty(gfxInfo, "adapterDriverVersion"),
    graphicsProperty(gfxInfo, "adapterDriverDate"),
  ]
    .filter(Boolean)
    .join(" ");
  let codecSupport = graphicsProperty(gfxInfo, "CodecSupportInfo");
  if (!codecSupport || codecSupport === "Unknown") {
    codecSupport = "unavailable";
  }
  const privateWindow = Boolean(
    readDiagnostic(() => runtime.getWindowState(ownerWindow).private, false)
  );
  const devicePixelRatio = Number(
    readDiagnostic(() => diagnosticWindow?.devicePixelRatio, 0)
  );
  const preferredSampleRate = Number(
    readDiagnostic(() => windowUtils?.currentPreferredSampleRate, 0)
  );
  return Object.freeze({
    pageKey,
    outcome: "ready",
    diagnostics: Object.freeze([
      diagnosticEntry("diagnostics.sessionUptime", formatSessionUptime()),
      diagnosticEntry("diagnostics.remoteProcesses", processSummary),
      diagnosticEntry(
        "diagnostics.socketProcess",
        readDiagnostic(() => Services.io.socketProcessLaunched, false)
          ? "active"
          : "not-active"
      ),
      diagnosticEntry("diagnostics.compositor", compositor),
      diagnosticEntry(
        "diagnostics.hardwareAcceleration",
        compositor === "Basic" || compositor.includes("Software")
          ? "disabled"
          : "enabled"
      ),
      diagnosticEntry("diagnostics.gpuProcess", gpuProcess),
      diagnosticEntry("diagnostics.graphicsAdapter", graphicsAdapter),
      diagnosticEntry("diagnostics.graphicsDriver", graphicsDriver),
      diagnosticEntry(
        "diagnostics.windowProtocol",
        graphicsProperty(gfxInfo, "windowProtocol") ||
          readDiagnostic(() => Services.appinfo.desktopEnvironment)
      ),
      diagnosticEntry(
        "diagnostics.devicePixelRatio",
        devicePixelRatio
          ? `${devicePixelRatio} (${Math.round(devicePixelRatio * 100)}%)`
          : ""
      ),
      diagnosticEntry(
        "diagnostics.webgpu",
        readDiagnostic(() => Boolean(diagnosticWindow?.navigator?.gpu), false)
          ? "enabled"
          : "disabled"
      ),
      diagnosticEntry(
        "diagnostics.graphicsFailures",
        graphicsFailureCount(gfxInfo)
      ),
      diagnosticEntry(
        "diagnostics.audioBackend",
        readDiagnostic(() => windowUtils?.currentAudioBackend)
      ),
      diagnosticEntry(
        "diagnostics.maximumAudioChannels",
        readDiagnostic(() => windowUtils?.currentMaxAudioChannels)
      ),
      diagnosticEntry(
        "diagnostics.preferredSampleRate",
        preferredSampleRate ? `${preferredSampleRate} Hz` : ""
      ),
      diagnosticEntry("diagnostics.codecSupport", codecSupport),
      diagnosticEntry(
        "diagnostics.networkState",
        readDiagnostic(() => Services.io.offline, false) ? "offline" : "online"
      ),
      diagnosticEntry(
        "diagnostics.privateWindow",
        privateWindow ? "private" : "regular"
      ),
      diagnosticEntry("diagnostics.builtInExtensions", builtInExtensions),
      diagnosticEntry("diagnostics.logicalProcessors", logicalProcessors),
    ]),
  });
}

function applicationBuiltInIds() {
  if (!Services.prefs.prefIsLocked(BUILTIN_EXTENSION_IDS_PREF)) {
    return new Set();
  }
  return new Set(
    Services.prefs
      .getStringPref(BUILTIN_EXTENSION_IDS_PREF, "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function aboutModuleId(uri) {
  try {
    if (!uri?.schemeIs("about")) {
      return null;
    }
    return uri.pathQueryRef.split(/[?#]/u, 1)[0].toLowerCase();
  } catch {
    return null;
  }
}

function authenticatedInternalPage(browser) {
  const documentURI = browser?.documentURI;
  const principal = browser?.contentPrincipal;
  if (!documentURI || !principal) {
    return null;
  }

  const page = resolveNavisInternalPageURI(documentURI);
  if (page && !principal.isSystemPrincipal) {
    const principalPage = resolveNavisInternalPageURI(principal.URI);
    if (
      principalPage?.id === page.id &&
      principalPage.route === page.route &&
      !principal.addonId
    ) {
      return page;
    }
  }
  return null;
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function authenticatedWebPrincipal(browser) {
  const documentURI = browser?.documentURI;
  const principal = browser?.contentPrincipal;
  if (
    !documentURI ||
    !principal ||
    principal.isSystemPrincipal ||
    principal.addonId ||
    (!documentURI.schemeIs("http") && !documentURI.schemeIs("https"))
  ) {
    return null;
  }
  try {
    const principalURI = principal.URI;
    if (
      (!principalURI.schemeIs("http") && !principalURI.schemeIs("https")) ||
      principalURI.prePath !== documentURI.prePath
    ) {
      return null;
    }
    return Object.freeze({
      principal,
      origin: principalURI.prePath,
      host: principalURI.asciiHost,
      loopback: isLoopbackHost(principalURI.asciiHost),
    });
  } catch {
    return null;
  }
}

function authenticatedWebAuthnOrigin(browser, value, contextId = null) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    return null;
  }
  let uri;
  try {
    uri = Services.io.newURI(value);
  } catch {
    return null;
  }
  if (
    !uri.schemeIs("https") &&
    !(uri.schemeIs("http") && isLoopbackHost(uri.asciiHost))
  ) {
    return null;
  }

  const origin = uri.prePath;
  let contexts;
  if (contextId === null) {
    contexts = [browser?.browsingContext];
  } else {
    if (!Number.isSafeInteger(contextId) || contextId <= 0) {
      return null;
    }
    const context = BrowsingContext.get(contextId);
    if (!context || context.top?.id !== browser?.browsingContext?.id) {
      return null;
    }
    contexts = [context];
  }
  while (contexts.length) {
    const context = contexts.shift();
    if (!context) {
      continue;
    }
    if (contextId === null) {
      contexts.push(...context.children);
    }
    try {
      const principal = context.currentWindowGlobal?.documentPrincipal;
      if (
        principal &&
        !principal.isSystemPrincipal &&
        !principal.addonId &&
        principal.originNoSuffix === origin &&
        principal.URI?.prePath === origin
      ) {
        return Object.freeze({ origin, host: uri.asciiHost });
      }
    } catch {}
  }
  return null;
}

function canonicalWebAuthnRpId(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 253 ||
    !/^[a-z0-9.-]+$/iu.test(value)
  ) {
    return null;
  }
  const normalized = value.toLowerCase();
  const labels = normalized.split(".");
  if (
    labels.some(
      label =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-")
    )
  ) {
    return null;
  }
  try {
    const uri = Services.io.newURI(`https://${normalized}`);
    return uri.asciiHost === normalized ? normalized : null;
  } catch {
    return null;
  }
}

function projectWebAuthnDescriptor(sessionId, event, browser) {
  if (!event || typeof event !== "object" || !Array.isArray(event.accounts)) {
    return null;
  }
  const authenticated = authenticatedWebAuthnOrigin(browser, event.origin);
  if (!authenticated) {
    return null;
  }
  const actions = WEB_AUTHN_ACTIONS[event.type] ?? DEFAULT_WEB_AUTHN_ACTIONS;
  const accounts = Object.freeze(
    event.accounts.map(account =>
      Object.freeze({
        name: account.name,
        displayName: account.displayName,
      })
    )
  );
  return Object.freeze({
    id: `prompt-${nextPromptId++}`,
    sessionId,
    category: "webauthn",
    kind: event.type,
    origin: authenticated.origin,
    host: authenticated.host,
    retries: event.retries,
    errorKind: event.errorKind,
    accounts,
    actions,
  });
}

function projectRelatedOriginWebAuthnDescriptor(sessionId, event, browser) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.isCreate !== "boolean"
  ) {
    return null;
  }
  const authenticated = authenticatedWebAuthnOrigin(
    browser,
    event.origin,
    event.browsingContextId
  );
  const rpId = canonicalWebAuthnRpId(event.rpId);
  if (!authenticated || !rpId) {
    return null;
  }
  const kind = event.isCreate ? "related-origin-create" : "related-origin-use";
  return Object.freeze({
    id: `prompt-${nextPromptId++}`,
    sessionId,
    category: "webauthn",
    kind,
    origin: authenticated.origin,
    host: authenticated.host,
    rpId,
    retries: null,
    errorKind: null,
    accounts: Object.freeze([]),
    actions: WEB_AUTHN_ACTIONS[kind],
  });
}

function projectConditionalWebAuthnDescriptor(sessionId, event, browser) {
  if (
    !event ||
    typeof event !== "object" ||
    !Array.isArray(event.accounts) ||
    event.accounts.length > 32
  ) {
    return null;
  }
  const authenticated = authenticatedWebAuthnOrigin(
    browser,
    event.origin,
    event.browsingContextId
  );
  const rpId = event.rpId === null ? null : canonicalWebAuthnRpId(event.rpId);
  if (!authenticated || (event.rpId !== null && !rpId)) {
    return null;
  }
  const accounts = [];
  for (const account of event.accounts) {
    if (
      !account ||
      typeof account.name !== "string" ||
      typeof account.displayName !== "string" ||
      account.name.length > 256 ||
      account.displayName.length > 256 ||
      containsControlCharacter(account.name) ||
      containsControlCharacter(account.displayName)
    ) {
      return null;
    }
    accounts.push(
      Object.freeze({
        name: account.name,
        displayName: account.displayName,
      })
    );
  }
  return Object.freeze({
    id: `prompt-${nextPromptId++}`,
    sessionId,
    category: "webauthn",
    kind: "conditional-get",
    origin: authenticated.origin,
    host: authenticated.host,
    rpId,
    retries: null,
    errorKind: null,
    accounts: Object.freeze(accounts),
    actions: accounts.length
      ? CONDITIONAL_WEB_AUTHN_ACTIONS.accounts
      : CONDITIONAL_WEB_AUTHN_ACTIONS.empty,
  });
}

function normalizeWebAuthnResponse(response, descriptor) {
  if (
    !response ||
    typeof response !== "object" ||
    !descriptor.actions.includes(response.action)
  ) {
    return null;
  }
  if (response.action === "submit") {
    if (
      typeof response.pin !== "string" ||
      !response.pin ||
      containsControlCharacter(response.pin) ||
      new TextEncoder().encode(response.pin).length > 63
    ) {
      return null;
    }
    return Object.freeze({ action: "submit", pin: response.pin });
  }
  if (response.action === "select") {
    if (
      !Number.isInteger(response.selected) ||
      response.selected < 0 ||
      response.selected >= descriptor.accounts.length
    ) {
      return null;
    }
    return Object.freeze({
      action: "select",
      selected: response.selected,
    });
  }
  return Object.freeze({ action: response.action });
}

function authenticatedNavigationIdentity(browser) {
  const documentURI = browser?.documentURI;
  const principal = browser?.contentPrincipal;
  if (!documentURI || !principal) {
    return Object.freeze({ id: CORE_NAVIGATION_IDENTITY_IDS.unknown, key: "" });
  }

  const page = authenticatedInternalPage(browser);
  if (page) {
    return Object.freeze({
      id: CORE_NAVIGATION_IDENTITY_IDS["internal-page"],
      key: page.key,
    });
  }

  const webPrincipal = authenticatedWebPrincipal(browser);
  if (webPrincipal?.loopback) {
    return Object.freeze({
      id: CORE_NAVIGATION_IDENTITY_IDS.web,
      key: "local-page",
    });
  }

  try {
    const policy = principal.addonPolicy;
    if (
      documentURI.schemeIs("moz-extension") &&
      policy?.active &&
      principal.addonId === policy.id &&
      policy.mozExtensionHostname === documentURI.asciiHost &&
      applicationBuiltInIds().has(policy.id)
    ) {
      return Object.freeze({
        id: CORE_NAVIGATION_IDENTITY_IDS["built-in-extension"],
        key: policy.id,
      });
    }
  } catch {}

  const errorId = aboutModuleId(documentURI);
  if (
    errorId &&
    isNavisInternalErrorId(errorId) &&
    !principal.isSystemPrincipal
  ) {
    return Object.freeze({
      id: CORE_NAVIGATION_IDENTITY_IDS["internal-error"],
      key: errorId,
    });
  }

  return Object.freeze({ id: CORE_NAVIGATION_IDENTITY_IDS.web, key: "" });
}

function readSecurityValue(object, property, fallback = null) {
  try {
    const value = object?.[property];
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function boundedSecurityText(value, maximum = 4096) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function certificateTime(value) {
  const milliseconds = Number(value) / 1000;
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function projectCertificate(certificate) {
  if (!certificate) {
    return null;
  }
  const validity = readSecurityValue(certificate, "validity");
  return Object.freeze({
    displayName: boundedSecurityText(
      readSecurityValue(certificate, "displayName", "")
    ),
    commonName: boundedSecurityText(
      readSecurityValue(certificate, "commonName", "")
    ),
    subjectName: boundedSecurityText(
      readSecurityValue(certificate, "subjectName", "")
    ),
    organization: boundedSecurityText(
      readSecurityValue(certificate, "organization", "")
    ),
    organizationalUnit: boundedSecurityText(
      readSecurityValue(certificate, "organizationalUnit", "")
    ),
    issuerCommonName: boundedSecurityText(
      readSecurityValue(certificate, "issuerCommonName", "")
    ),
    issuerName: boundedSecurityText(
      readSecurityValue(certificate, "issuerName", "")
    ),
    issuerOrganization: boundedSecurityText(
      readSecurityValue(certificate, "issuerOrganization", "")
    ),
    serialNumber: boundedSecurityText(
      readSecurityValue(certificate, "serialNumber", "")
    ),
    validFrom: certificateTime(readSecurityValue(validity, "notBefore")),
    validTo: certificateTime(readSecurityValue(validity, "notAfter")),
    sha256Fingerprint: boundedSecurityText(
      readSecurityValue(certificate, "sha256Fingerprint", "")
    ),
    sha256SubjectPublicKeyInfoDigest: boundedSecurityText(
      readSecurityValue(certificate, "sha256SubjectPublicKeyInfoDigest", "")
    ),
  });
}

function tlsVersionName(version) {
  return (
    Object.freeze({
      0: "SSL 3",
      1: "TLS 1.0",
      2: "TLS 1.1",
      3: "TLS 1.2",
      4: "TLS 1.3",
    })[version] ?? "Unknown"
  );
}

function projectSecurityDetails(browser, state) {
  const unavailable = () =>
    Object.freeze({
      navigationId: state.navigationId,
      identity: state.identity,
      identityKey: state.identityKey,
      available: false,
      errorCode: 0,
      errorCodeString: "",
      connection: null,
      certificate: null,
      certificateChain: Object.freeze([]),
    });
  if (state.identity === "unknown") {
    return unavailable();
  }
  const securityInfo = readSecurityValue(browser?.securityUI, "secInfo");
  if (!securityInfo) {
    return unavailable();
  }
  const chainSource = readSecurityValue(securityInfo, "succeededCertChain", []);
  const fallbackChain = readSecurityValue(
    securityInfo,
    "handshakeCertificates",
    []
  );
  const chain = [...(chainSource?.length ? chainSource : fallbackChain)]
    .slice(0, 16)
    .map(projectCertificate)
    .filter(Boolean);
  return Object.freeze({
    navigationId: state.navigationId,
    identity: state.identity,
    identityKey: state.identityKey,
    available: true,
    errorCode: Number(readSecurityValue(securityInfo, "errorCode", 0)) || 0,
    errorCodeString: boundedSecurityText(
      readSecurityValue(securityInfo, "errorCodeString", "")
    ),
    connection: Object.freeze({
      protocol: tlsVersionName(
        Number(readSecurityValue(securityInfo, "protocolVersion", -1))
      ),
      cipher: boundedSecurityText(
        readSecurityValue(securityInfo, "cipherName", "")
      ),
      keyExchange: boundedSecurityText(
        readSecurityValue(securityInfo, "keaGroupName", "")
      ),
      signature: boundedSecurityText(
        readSecurityValue(securityInfo, "signatureSchemeName", "")
      ),
      keyLength: Number(readSecurityValue(securityInfo, "keyLength", 0)) || 0,
      secretKeyLength:
        Number(readSecurityValue(securityInfo, "secretKeyLength", 0)) || 0,
      privateDNS: Boolean(
        readSecurityValue(securityInfo, "usedPrivateDNS", false)
      ),
      acceptedECH: Boolean(
        readSecurityValue(securityInfo, "isAcceptedEch", false)
      ),
      resumed: Boolean(readSecurityValue(securityInfo, "resumed", false)),
      rootBuiltIn: Boolean(
        readSecurityValue(
          securityInfo,
          "isBuiltCertChainRootBuiltInRoot",
          false
        )
      ),
      certificateTransparency:
        Number(
          readSecurityValue(securityInfo, "certificateTransparencyStatus", 0)
        ) || 0,
    }),
    certificate: projectCertificate(
      readSecurityValue(securityInfo, "serverCert")
    ),
    certificateChain: Object.freeze(chain),
  });
}

const historyBridge = {
  observe(subject, topic) {
    if (!historyDelegate) {
      return;
    }

    const details = subject.QueryInterface(Ci.nsIWritablePropertyBag2);
    const url = details.getProperty("url");
    try {
      if (topic === HISTORY_VISIT_TOPIC) {
        const browserId = details.getProperty("browserId");
        const privateMode = browserPrivateModes.get(String(browserId));
        const request = Object.freeze({
          url,
          lastVisitedUrl: optionalProperty(details, "lastVisitedUrl"),
          flags: details.getProperty("flags"),
          browserId,
          private: privateMode !== false,
        });
        const decision = historyDelegate.onVisited?.(request);
        if (typeof decision === "boolean") {
          details.setPropertyAsBool("visited", decision);
        }
      } else if (topic === HISTORY_QUERY_TOPIC) {
        const urls = Object.freeze([url]);
        const result = historyDelegate.getVisited?.(urls);
        if (
          Array.isArray(result) &&
          result.length === 1 &&
          typeof result[0] === "boolean"
        ) {
          details.setPropertyAsBool("visited", result[0]);
        }
      } else if (topic === HISTORY_TITLE_TOPIC) {
        historyDelegate.onTitleChanged?.(
          Object.freeze({
            url,
            title: details.getProperty("title"),
          })
        );
      }
    } catch (error) {
      console.error("Desktop embedder history delegate failed", error);
    }
  },
};

Services.obs.addObserver(historyBridge, HISTORY_VISIT_TOPIC);
Services.obs.addObserver(historyBridge, HISTORY_QUERY_TOPIC);
Services.obs.addObserver(historyBridge, HISTORY_TITLE_TOPIC);

function isPrivateWindow(ownerWindow) {
  try {
    return ownerWindow.docShell.QueryInterface(Ci.nsILoadContext)
      .usePrivateBrowsing;
  } catch {
    return false;
  }
}

function installHistoryDelegate(runtime, delegate) {
  if (delegate === null) {
    historyDelegateOwners.delete(runtime);
    if (!historyDelegateOwners.size) {
      historyDelegate = null;
    }
    return;
  }
  if (
    historyDelegate &&
    historyDelegate !== delegate &&
    (!historyDelegateOwners.has(runtime) || historyDelegateOwners.size > 1)
  ) {
    throw new Error("A different process-wide HistoryDelegate is active");
  }
  historyDelegate = delegate;
  historyDelegateOwners.add(runtime);
}

function normalizeURI(value) {
  let candidate = value.trim();
  if (!candidate) {
    throw new TypeError("A URI is required");
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  return Services.io.newURI(candidate);
}

function resolveAddressValue(value, providerId) {
  const resolved = resolveDesktopAddressInput(value, providerId);
  return resolved.kind === "url"
    ? Object.freeze({ ...resolved, url: Services.io.newURI(resolved.url).spec })
    : resolved;
}

function readGlobalClipboardText() {
  try {
    const transferable = Cc[
      "@mozilla.org/widget/transferable;1"
    ].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor("text/plain");
    Services.clipboard.getData(
      transferable,
      Services.clipboard.kGlobalClipboard
    );
    const data = {};
    transferable.getTransferData("text/plain", data);
    return data.value.QueryInterface(Ci.nsISupportsString).data;
  } catch {
    return "";
  }
}

function normalizeWebOrigin(value, name = "Credential origin") {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  let uri;
  try {
    uri = Services.io.newURI(value);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTP(S) origin`);
  }
  if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
    throw new TypeError(`${name} must be an HTTP(S) origin`);
  }
  return uri.prePath;
}

function credentialText(value, name, maximum, { allowEmpty = true } = {}) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeCredentialRequest(request, { includeSecret = false } = {}) {
  if (!request || typeof request !== "object") {
    throw new TypeError("Credential request must be an object");
  }
  const normalized = {
    origin: normalizeWebOrigin(request.origin),
    actionOrigin: normalizeWebOrigin(
      request.actionOrigin ?? request.origin,
      "Credential action origin"
    ),
    usernameField: credentialText(
      request.usernameField ?? "",
      "Credential username field",
      256
    ),
    passwordField: credentialText(
      request.passwordField ?? "",
      "Credential password field",
      256
    ),
  };
  if (includeSecret) {
    normalized.username = credentialText(
      request.username ?? "",
      "Credential username",
      1024
    );
    normalized.password = credentialText(
      request.password,
      "Credential password",
      4096,
      { allowEmpty: false }
    );
  }
  return Object.freeze(normalized);
}

function isRootProgress(webProgress, browser) {
  try {
    // Under Fission, a remote iframe may be the top-level docshell in its own
    // content process. Only the Session browser's root BrowsingContext is a
    // tab navigation; process-local isTopLevel is not a sufficient boundary.
    const observedContext = webProgress?.browsingContext;
    const rootContext = browser?.browsingContext;
    if (observedContext && rootContext) {
      return observedContext.id === rootContext.id;
    }
    return webProgress === browser?.webProgress;
  } catch {
    return false;
  }
}

function principalOrigin(principal) {
  try {
    return principal.origin;
  } catch {
    return "";
  }
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function promptKind(args) {
  if (args.inPermitUnload) {
    return "before-unload";
  }
  switch (args.promptType) {
    case "alert":
    case "alertCheck":
      return "alert";
    case "confirm":
    case "confirmCheck":
    case "confirmEx":
      return "confirm";
    case "prompt":
      return "text";
    case "promptUserAndPass":
    case "promptPassword":
      return "auth";
    case "select":
      return "choice";
    default:
      return "unknown";
  }
}

function promptModalScope(modalType) {
  if (modalType === Services.prompt.MODAL_TYPE_CONTENT) {
    return "content";
  }
  if (modalType === Services.prompt.MODAL_TYPE_TAB) {
    return "session";
  }
  return "window";
}

function promptButtons(args, kind) {
  const buttons = [];
  for (let id = 0; id <= 3; id++) {
    const label = args[`button${id}Label`];
    if (typeof label === "string" && label) {
      let role = "extra";
      if (id === 0) {
        role = "accept";
      } else if (id === 1) {
        role = "cancel";
      }
      buttons.push(
        Object.freeze({
          id,
          role,
          // Gecko's before-unload collection supplies product-localized
          // presentation strings. Keep the reusable Core/Platform boundary
          // semantic and let the consuming Platform own those words.
          label: kind === "before-unload" ? null : label,
        })
      );
    }
  }
  if (!buttons.length) {
    buttons.push(Object.freeze({ id: 0, role: "accept", label: null }));
    if (kind !== "alert") {
      buttons.push(Object.freeze({ id: 1, role: "cancel", label: null }));
    }
  }
  return Object.freeze(buttons);
}

function promptInput(args, kind) {
  if (kind === "text") {
    return Object.freeze({
      type: "text",
      defaultValue: stringValue(args.value),
    });
  }
  if (kind === "auth") {
    return Object.freeze({
      type: "credentials",
      defaultUsername: stringValue(args.user),
      passwordOnly: args.promptType === "promptPassword",
    });
  }
  if (kind === "choice") {
    const choices = Object.freeze(
      (Array.isArray(args.list) ? args.list : []).map(choice =>
        stringValue(choice)
      )
    );
    return Object.freeze({
      type: "choice",
      choices,
      selected: Number.isInteger(args.selected) ? args.selected : -1,
    });
  }
  return null;
}

function projectPromptDescriptor(sessionId, args, browser) {
  const kind = promptKind(args);
  const buttons = promptButtons(args, kind);
  const frameOrigin = principalOrigin(
    args.promptPrincipal || browser.contentPrincipal
  );
  const origin = stringValue(args.authOrigin, frameOrigin);
  const checkbox = args.checkLabel
    ? Object.freeze({
        label: stringValue(args.checkLabel),
        checked: Boolean(args.checked),
      })
    : null;
  const defaultButton = buttons.some(
    button => button.id === args.defaultButtonNum
  )
    ? args.defaultButtonNum
    : buttons[0].id;
  const cancelButton =
    buttons.find(button => button.role === "cancel")?.id ?? buttons[0].id;

  return Object.freeze({
    id: `prompt-${nextPromptId++}`,
    sessionId,
    category: "prompt",
    kind,
    origin,
    frameOrigin,
    title: kind === "before-unload" ? "" : stringValue(args.title),
    message: kind === "before-unload" ? "" : stringValue(args.text),
    modalScope: promptModalScope(args.modalType),
    beforeUnload: Boolean(args.inPermitUnload),
    insecureAuth: Boolean(args.isInsecureAuth),
    crossOriginAuth: Boolean(args.isTopLevelCrossDomainAuth),
    buttons,
    defaultButton,
    cancelButton,
    checkbox,
    input: promptInput(args, kind),
  });
}

function defaultPromptResponse(descriptor) {
  return {
    action: "dismiss",
    button: descriptor.cancelButton,
  };
}

function normalizePromptResponse(response, descriptor) {
  if (!response || typeof response !== "object") {
    return null;
  }
  if (!GENERIC_PROMPT_ACTIONS.has(response.action)) {
    return null;
  }
  const fallbackButton =
    response.action === "accept" ? 0 : descriptor.cancelButton;
  const button = response.button ?? fallbackButton;
  if (
    !Number.isInteger(button) ||
    !descriptor.buttons.some(candidate => candidate.id === button)
  ) {
    return null;
  }

  const normalized = {
    action: response.action,
    button,
  };
  if (response.checked !== undefined) {
    if (typeof response.checked !== "boolean") {
      return null;
    }
    normalized.checked = response.checked;
  }

  if (response.action === "accept" && button === 0) {
    if (descriptor.kind === "text") {
      if (response.value !== undefined && typeof response.value !== "string") {
        return null;
      }
      normalized.value = response.value ?? descriptor.input.defaultValue;
    } else if (descriptor.kind === "auth") {
      if (
        response.password === undefined ||
        typeof response.password !== "string" ||
        (!descriptor.input.passwordOnly &&
          response.username !== undefined &&
          typeof response.username !== "string")
      ) {
        return null;
      }
      normalized.username = descriptor.input.passwordOnly
        ? ""
        : (response.username ?? descriptor.input.defaultUsername);
      normalized.password = response.password;
    } else if (descriptor.kind === "choice") {
      const selected = response.selected ?? descriptor.input.selected;
      if (
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= descriptor.input.choices.length
      ) {
        return null;
      }
      normalized.selected = selected;
    }
  }
  return normalized;
}

function promptResult(args, descriptor, response, { aborted = false } = {}) {
  const accepted = response.action === "accept" && response.button === 0;
  const result = {
    promptAborted: aborted,
    ok: accepted,
    buttonNumClicked: response.button,
    checked:
      response.checked ?? descriptor.checkbox?.checked ?? Boolean(args.checked),
    value: stringValue(args.value),
    user: stringValue(args.user),
    pass: stringValue(args.pass),
    selected: Number.isInteger(args.selected) ? args.selected : -1,
  };
  if (accepted) {
    if (descriptor.kind === "text") {
      result.value = response.value;
    } else if (descriptor.kind === "auth") {
      result.user = response.username;
      result.pass = response.password;
    } else if (descriptor.kind === "choice") {
      result.selected = response.selected;
    }
  }
  return result;
}

function sessionBaseDomain(url) {
  try {
    const uri = Services.io.newURI(url);
    if (uri.schemeIs("http") || uri.schemeIs("https")) {
      try {
        return Services.eTLD.getBaseDomain(uri);
      } catch {
        return uri.displayHost || uri.host;
      }
    }
    if (uri.schemeIs("navis") || uri.schemeIs("moz-extension")) {
      return `${uri.scheme}://${uri.displayHost || uri.host}`;
    }
    if (uri.schemeIs("file")) {
      return "file://";
    }
    if (uri.schemeIs("about")) {
      return uri.spec.split(/[?#]/u, 1)[0];
    }
    return uri.prePath === "null" ? `${uri.scheme}:` : uri.prePath;
  } catch {
    return "";
  }
}

function freezeSessionState(state) {
  return Object.freeze({
    ...state,
    baseDomain: sessionBaseDomain(state.url),
    prompt: state.prompt ? Object.freeze({ ...state.prompt }) : null,
    media: Object.freeze({ ...state.media }),
    credentials: Object.freeze({
      origin: state.credentials.origin,
      items: Object.freeze(
        state.credentials.items.map(item => Object.freeze({ ...item }))
      ),
    }),
  });
}

function targetFileName(download) {
  const path = download.target?.path || "";
  const pieces = path.split(/[\\/]/);
  return pieces.at(-1) || "download";
}

function projectDownload(id, download) {
  let downloadStatus = "pending";
  if (download.succeeded) {
    downloadStatus = "complete";
  } else if (download.canceled) {
    downloadStatus = "canceled";
  } else if (download.error) {
    downloadStatus = "failed";
  } else if (!download.stopped) {
    downloadStatus = "downloading";
  }

  return Object.freeze({
    id,
    fileName: targetFileName(download),
    sourceUrl: download.source?.url || "",
    private: Boolean(download.source?.isPrivate),
    status: downloadStatus,
    progress: download.hasProgress ? download.progress : null,
    currentBytes: download.currentBytes || 0,
    totalBytes: download.totalBytes || 0,
    canCancel: !download.stopped,
    canRetry:
      download.stopped && !download.succeeded && !download.hasBlockedData,
  });
}

function userContextIdFrom(openWindowInfo, openerOriginAttributes) {
  return (
    openWindowInfo?.originAttributes?.userContextId ??
    openerOriginAttributes?.userContextId ??
    Ci.nsIScriptSecurityManager.DEFAULT_USER_CONTEXT_ID
  );
}

function createRemoteBrowser(
  ownerDocument,
  host,
  {
    openWindowInfo = null,
    userContextId = 0,
    name: browserName = "",
    skipLoad = false,
    remoteType = "web",
    initialBrowsingContextGroupId = null,
    className = "desktop-engine-view",
  } = {}
) {
  const browser = ownerDocument.createXULElement("browser");
  browser.permanentKey = new (Cu.getGlobalForObject(Services).Object)();
  browser.classList.add(className);
  browser.setAttribute("type", "content");
  browser.setAttribute("message", "true");
  browser.setAttribute("messagemanagergroup", "browsers");
  browser.setAttribute("manualactiveness", "true");
  browser.setAttribute("remote", "true");
  browser.setAttribute("remoteType", remoteType || "web");
  browser.setAttribute("maychangeremoteness", "true");
  if (initialBrowsingContextGroupId) {
    browser.setAttribute(
      "initialBrowsingContextGroupId",
      initialBrowsingContextGroupId
    );
  }
  browser.setAttribute("flex", "1");
  if (userContextId) {
    browser.setAttribute("usercontextid", userContextId);
  }
  if (browserName) {
    browser.setAttribute("name", browserName);
  }
  if (skipLoad) {
    browser.setAttribute("nodefaultsrc", "true");
  }
  if (openWindowInfo) {
    browser.openWindowInfo = openWindowInfo;
  }
  host.append(browser);
  return browser;
}

/** Owns engine sessions and process-wide browser integration. */
export class EngineRuntime {
  #core;
  #sessions = new Set();
  #sessionContexts = new Map();
  #windows = new Map();
  #viewIds = new WeakMap();
  #closed = false;
  #sessionCreated = false;
  #navigationDelegate = null;
  #downloadDelegate = null;
  #sessionDelegateFactory = null;
  #downloadList = null;
  #downloadView = null;
  #downloadsById = new Map();
  #downloadIds = new WeakMap();
  #extensionManager = null;
  #extensionActions = null;
  #extensionOmnibox = null;
  #extensionPermissionPrompts = null;
  #extensionPopupHost = null;
  #extensionActionDelegate = null;
  #extensionOmniboxDelegate = null;
  #extensionActionChangedListener;
  #extensionActionRemovedListener;
  #extensionPopupRequestedListener;
  #extensionOmniboxChangedListener;
  #extensionsReady;
  #cleanLinksReady;
  #profileStore;
  #profileReady;
  #credentialReauthenticationPresentation = Object.freeze({
    reason: "",
    caption: "Navis",
  });

  constructor(options = undefined) {
    if (options !== undefined) {
      throw new TypeError(
        "EngineRuntime source API 2 does not accept a window or View factory"
      );
    }
    this.#cleanLinksReady = prepareDesktopCleanLinks();
    this.#core = Cc[
      "@mozilla.org/desktop-embedder/core-state;1"
    ].createInstance(Ci.nsIDesktopEmbedderCoreState);
    this.#profileStore = getDesktopProfileStore();
    this.#profileReady = this.#profileStore.ready;
    this.#extensionActionChangedListener = () => this.#notifyExtensionActions();
    this.#extensionActionRemovedListener = (_eventName, event) => {
      this.#extensionPopupHost?.closeExtension(event.extensionId);
      this.#notifyExtensionActions();
    };
    this.#extensionPopupRequestedListener = (_eventName, request) => {
      this.#openExtensionPopup(
        request.nativeTab,
        request.extensionId,
        request.popup,
        "extensions-menu-toggle",
        request.browserStyle
      ).catch(error => {
        console.error("Desktop embedder could not open extension popup", error);
      });
    };
    this.#extensionOmniboxChangedListener = (_eventName, event) => {
      if (
        event.nativeTab?.runtime !== this ||
        !this.#sessions.has(event.nativeTab.session)
      ) {
        return;
      }
      callDelegate(
        this.#extensionOmniboxDelegate,
        "ExtensionOmniboxDelegate",
        "onStateChanged",
        Object.freeze({
          ...event.state,
          sessionId: event.nativeTab.session.id,
        })
      );
    };
    // The startup observer normally freezes the locale after profile prefs
    // load. Keep nonstandard EngineRuntime harnesses on the same invariants.
    initializeDesktopLocale();
    initializeDesktopProcessIsolation();
    installHistoryDelegate(this, this.#profileStore.historyDelegate);
    this.#initializeDownloads().catch(error => {
      console.error("Desktop embedder could not initialize downloads", error);
    });
    this.#extensionsReady = this.#initializeExtensions();
  }

  get sessionCount() {
    return this.#core.sessionCount;
  }

  get windowCount() {
    return this.#core.windowCount;
  }

  get closed() {
    return this.#closed || this.#core.closed;
  }

  get capabilities() {
    return RUNTIME_CAPABILITIES;
  }

  get localeState() {
    this.#assertOpen();
    return getDesktopLocaleState();
  }

  setLocaleSetting(setting) {
    this.#assertOpen();
    return setDesktopLocaleSetting(setting);
  }

  get processIsolationState() {
    this.#assertOpen();
    return getDesktopProcessIsolationState();
  }

  setProcessIsolationMode(mode) {
    this.#assertOpen();
    return setDesktopProcessIsolationMode(mode);
  }

  relaunchForLocaleChange() {
    this.#assertOpen();
    if (!this.localeState.restartRequired) {
      return false;
    }
    return Services.startup.quit(
      Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
    );
  }

  relaunchForProcessIsolationChange() {
    this.#assertOpen();
    if (!this.processIsolationState.restartRequired) {
      return false;
    }
    return Services.startup.quit(
      Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
    );
  }

  async measureSessionMemoryUsage(session) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    try {
      return (
        (await measureLiveSessionMemory()).get(session) ||
        Object.freeze({
          available: false,
          bytes: 0,
          processCount: 0,
          estimated: true,
        })
      );
    } catch {
      return Object.freeze({
        available: false,
        bytes: 0,
        processCount: 0,
        estimated: true,
      });
    }
  }

  get bookmarkBarVisible() {
    this.#assertOpen();
    return Services.prefs.getBoolPref(BOOKMARK_BAR_VISIBLE_PREF, true);
  }

  setBookmarkBarVisible(visible) {
    this.#assertOpen();
    if (typeof visible !== "boolean") {
      throw new TypeError("Bookmark bar visibility must be boolean");
    }
    Services.prefs.setBoolPref(BOOKMARK_BAR_VISIBLE_PREF, visible);
    return visible;
  }

  get searchProviders() {
    this.#assertOpen();
    return Object.freeze(
      DESKTOP_SEARCH_PROVIDERS.map(provider =>
        Object.freeze({ id: provider.id, name: provider.name })
      )
    );
  }

  get defaultSearchProvider() {
    this.#assertOpen();
    const selected = Services.prefs.getStringPref(
      DEFAULT_SEARCH_PROVIDER_PREF,
      DESKTOP_SEARCH_PROVIDERS[0].id
    );
    return SEARCH_PROVIDER_BY_ID.has(selected)
      ? selected
      : DESKTOP_SEARCH_PROVIDERS[0].id;
  }

  setDefaultSearchProvider(providerId) {
    this.#assertOpen();
    if (!SEARCH_PROVIDER_BY_ID.has(providerId)) {
      throw new TypeError("Unknown Navis search provider");
    }
    Services.prefs.setStringPref(DEFAULT_SEARCH_PROVIDER_PREF, providerId);
    return providerId;
  }

  get cleanLinksEnabled() {
    this.#assertOpen();
    return getDesktopCleanLinksEnabled();
  }

  setCleanLinksEnabled(enabled) {
    this.#assertOpen();
    return setDesktopCleanLinksEnabled(enabled);
  }

  resolveAddressInput(value) {
    this.#assertOpen();
    return resolveAddressValue(value, this.defaultSearchProvider);
  }

  getClipboardAddressInput() {
    this.#assertOpen();
    const text = readGlobalClipboardText().trim();
    if (!text) {
      return null;
    }
    try {
      const resolved = resolveAddressValue(text, this.defaultSearchProvider);
      return Object.freeze({ text, kind: resolved.kind });
    } catch {
      return null;
    }
  }

  getWindowState(ownerWindow) {
    this.#assertOpen();
    if (!ownerWindow?.document) {
      throw new TypeError("getWindowState() requires a chrome window");
    }
    return Object.freeze({ private: isPrivateWindow(ownerWindow) });
  }

  openPlatformWindow({ ownerWindow = null, uri, privateMode = false } = {}) {
    this.#assertOpen();
    if (typeof privateMode !== "boolean") {
      throw new TypeError("Platform window private mode must be boolean");
    }
    const target = normalizeURI(uri);
    if (!target.schemeIs("chrome")) {
      throw new TypeError("Platform windows require an application chrome URI");
    }
    // `all` only expands CHROME_ALL for dialog windows in nsWindowWatcher.
    // This is an independent browser host (`dialog=no`), so Windows otherwise
    // omits WS_THICKFRAME/resize and minimize capabilities from windows opened
    // after startup. Keep the native top-level contract explicit.
    const features = `chrome,dialog=no,all,resizable=yes,minimizable=yes${
      privateMode ? ",private" : ""
    }`;
    Services.ww.openWindow(ownerWindow, target.spec, "_blank", features, null);
    return true;
  }

  get ready() {
    this.#assertOpen();
    return Promise.all([
      this.#profileReady,
      this.#extensionsReady,
      this.#cleanLinksReady,
    ]).then(() => undefined);
  }

  get downloads() {
    return Object.freeze(
      [...this.#downloadsById.values()].map(({ state }) => state)
    );
  }

  async getExtensionInventory() {
    this.#assertOpen();
    await this.#extensionsReady;
    return this.#extensionManager?.snapshot() || Object.freeze([]);
  }

  setExtensionActionDelegate(delegate) {
    this.#assertOpen();
    validateDelegate(
      delegate,
      "ExtensionActionDelegate",
      ["onActionsChanged"],
      ["onActionsChanged"]
    );
    this.#extensionActionDelegate = delegate;
  }

  setExtensionOmniboxDelegate(delegate) {
    this.#assertOpen();
    validateDelegate(
      delegate,
      "ExtensionOmniboxDelegate",
      ["onStateChanged"],
      ["onStateChanged"]
    );
    this.#extensionOmniboxDelegate = delegate;
  }

  updateExtensionOmnibox(session, value) {
    const nativeTab = this.#extensionNativeTab(session);
    if (typeof value !== "string" || value.length > 8192) {
      throw new TypeError("Extension omnibox input is invalid");
    }
    return (
      this.#extensionOmnibox?.update(nativeTab, value) ||
      EMPTY_EXTENSION_OMNIBOX_STATE
    );
  }

  cancelExtensionOmnibox(session) {
    const nativeTab = this.#extensionNativeTab(session);
    return this.#extensionOmnibox?.cancel(nativeTab) || false;
  }

  acceptExtensionOmnibox(session, content = null, disposition = "currentTab") {
    const nativeTab = this.#extensionNativeTab(session);
    if (
      content !== null &&
      (typeof content !== "string" || content.length > 8192)
    ) {
      throw new TypeError("Extension omnibox result is invalid");
    }
    if (
      !["currentTab", "newForegroundTab", "newBackgroundTab"].includes(
        disposition
      )
    ) {
      throw new TypeError("Extension omnibox disposition is invalid");
    }
    return (
      this.#extensionOmnibox?.accept(nativeTab, content, disposition) || false
    );
  }

  deleteExtensionOmniboxSuggestion(session, content) {
    const nativeTab = this.#extensionNativeTab(session);
    if (typeof content !== "string" || content.length > 8192) {
      throw new TypeError("Extension omnibox result is invalid");
    }
    return (
      this.#extensionOmnibox?.deleteSuggestion(nativeTab, content) || false
    );
  }

  getExtensionActions(session) {
    const nativeTab = this.#extensionNativeTab(session);
    return this.#extensionActions?.snapshots(nativeTab) || Object.freeze([]);
  }

  getExtensionPageActions(session) {
    const nativeTab = this.#extensionNativeTab(session);
    return (
      this.#extensionActions?.pageSnapshots(nativeTab) || Object.freeze([])
    );
  }

  async triggerExtensionAction(session, extensionId, anchorId) {
    const nativeTab = this.#extensionNativeTab(session);
    if (typeof extensionId !== "string" || extensionId.length > 256) {
      throw new TypeError("The extension action ID is invalid");
    }
    await this.#extensionsReady;
    const result = this.#extensionActions?.trigger(extensionId, nativeTab);
    if (!result) {
      throw new Error("The extension action is unavailable for this Session");
    }
    const popupOpened = result.popup
      ? await this.#openExtensionPopup(
          nativeTab,
          extensionId,
          result.popup,
          anchorId,
          result.browserStyle
        )
      : false;
    return Object.freeze({
      extensionId,
      outcome: popupOpened ? "popup-opened" : "click-dispatched",
    });
  }

  async triggerExtensionPageAction(session, extensionId, anchorId) {
    const nativeTab = this.#extensionNativeTab(session);
    if (typeof extensionId !== "string" || extensionId.length > 256) {
      throw new TypeError("The extension page-action ID is invalid");
    }
    await this.#extensionsReady;
    const result = this.#extensionActions?.triggerPageAction(
      extensionId,
      nativeTab
    );
    if (!result) {
      throw new Error(
        "The extension page action is unavailable for this Session"
      );
    }
    const popupOpened = result.popup
      ? await this.#openExtensionPopup(
          nativeTab,
          extensionId,
          result.popup,
          anchorId,
          result.browserStyle
        )
      : false;
    return Object.freeze({
      extensionId,
      outcome: popupOpened ? "popup-opened" : "click-dispatched",
    });
  }

  closeExtensionPopup(session) {
    this.#assertOpen();
    if (!this.#extensionPopupHost) {
      return false;
    }
    const nativeTab = this.#extensionNativeTab(session);
    return this.#extensionPopupHost.closeWindow(nativeTab.window);
  }

  async setExtensionActionPinned(extensionId, pinned) {
    this.#assertOpen();
    await this.#extensionsReady;
    if (!this.#extensionManager) {
      throw new Error("The extension manager is unavailable");
    }
    const extension = await this.#extensionManager.setToolbarPinned(
      extensionId,
      pinned
    );
    return Object.freeze({
      extensionId: extension.id,
      toolbarPinned: extension.toolbarPinned,
    });
  }

  createSession(options = {}) {
    this.#assertOpen();
    const { view, delegates = undefined, privateMode = undefined } = options;
    if (!(view instanceof EngineView)) {
      throw new TypeError(
        "EngineRuntime source API 2 requires an explicit EngineView per session"
      );
    }
    if (view.session) {
      throw new Error("EngineView is already bound to an EngineSession");
    }
    const ownerWindow = view[GET_VIEW_WINDOW]();
    const windowPrivate = isPrivateWindow(ownerWindow);
    if (privateMode !== undefined && typeof privateMode !== "boolean") {
      throw new TypeError("EngineSession private mode must be boolean");
    }
    const sessionPrivate = privateMode ?? windowPrivate;
    if (sessionPrivate !== windowPrivate) {
      throw new Error(
        "A desktop Session private mode must match its host window"
      );
    }
    const context = this.#ensureWindow(ownerWindow);
    const viewId = this.#coreViewId(view, context);
    const coreId = this.#core.createSessionWithMode(viewId, sessionPrivate);
    const session = new EngineSession({
      runtime: this,
      view,
      coreId,
      id: `session-${coreId}`,
      privateMode: this.#core.isSessionPrivate(coreId),
    });
    try {
      view[CLAIM_VIEW](session);
    } catch (error) {
      this.#core.closeSession(coreId);
      throw error;
    }
    this.#sessionCreated = true;
    this.#sessions.add(session);
    LIVE_ENGINE_SESSIONS.add(session);
    this.#sessionContexts.set(session, context);
    context.sessions.add(session);
    try {
      const sessionDelegates =
        delegates ?? this.#sessionDelegateFactory?.(session);
      if (sessionDelegates !== undefined) {
        session.setDelegates(sessionDelegates);
      }
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }

  activateSession(session) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    const context = this.#sessionContexts.get(session);
    const changed = this.#core.activateSession(session[GET_CORE_SESSION_ID]());
    if (changed) {
      context.activeSession?.[SET_SESSION_ACTIVE](false);
      context.activeSession = session;
      session[SET_SESSION_ACTIVE](true);
      DesktopExtensionTabs.activateSession(session);
      this.#notifyExtensionActions();
    }
    // Browser startup belongs to the chrome/runtime lifecycle, not to the
    // success or timing of an arbitrary initial document.  In particular,
    // Marionette waits for delayed startup before accepting WebDriver
    // sessions, while navis:// pages and failed network loads are both valid
    // first documents.  Freeze ScriptPreloader here, then let its cache writer
    // begin only on the subsequent main-thread idle dispatch.
    notifyBrowserStartupComplete(context.ownerWindow, this.#extensionsReady);
  }

  setNavigationDelegate(delegate) {
    this.#assertOpen();
    validateDelegate(
      delegate,
      "NavigationDelegate",
      ["onNewSession", "onSessionCreated", "onPopupBlocked"],
      ["onNewSession", "onSessionCreated"]
    );
    this.#navigationDelegate = delegate;
  }

  setDownloadDelegate(delegate) {
    this.#assertOpen();
    validateDelegate(
      delegate,
      "DownloadDelegate",
      ["onDownloadsChanged"],
      ["onDownloadsChanged"]
    );
    this.#downloadDelegate = delegate;
  }

  setSessionDelegateFactory(factory) {
    this.#assertOpen();
    if (factory !== null && typeof factory !== "function") {
      throw new TypeError("A session delegate factory must be a function");
    }
    if (this.#sessionCreated) {
      throw new Error(
        "The session delegate factory must be installed before the first session is created"
      );
    }
    this.#sessionDelegateFactory = factory;
  }

  setHistoryDelegate(delegate) {
    this.#assertOpen();
    validateDelegate(delegate, "HistoryDelegate", [
      "onVisited",
      "getVisited",
      "onTitleChanged",
      "onSessionTitleChanged",
      "onClear",
    ]);
    installHistoryDelegate(this, delegate);
  }

  setHistoryVisited(value, visited = true) {
    this.#assertOpen();
    if (typeof visited !== "boolean") {
      throw new TypeError("History visited state must be a boolean");
    }
    const uri = normalizeURI(value);
    Cc["@mozilla.org/browser/history;1"].getService(Ci.nsISupports);
    Services.obs.notifyObservers(
      uri,
      HISTORY_STATUS_TOPIC,
      visited ? "visited" : "unvisited"
    );
    return uri.spec;
  }

  async queryHistory(options = undefined) {
    this.#assertOpen();
    return this.#profileStore.queryHistory(options);
  }

  async deleteHistory(urls) {
    this.#assertOpen();
    if (!Array.isArray(urls)) {
      throw new TypeError("deleteHistory() requires an array of URLs");
    }
    const normalized = urls.map(value => normalizeURI(value).spec);
    const deleted = await this.#profileStore.deleteHistory(normalized);
    for (const url of deleted) {
      this.setHistoryVisited(url, false);
    }
    return deleted;
  }

  async clearHistory() {
    this.#assertOpen();
    let result;
    try {
      result = historyDelegate?.onClear?.();
    } catch (error) {
      console.error("Desktop embedder history delegate failed to clear", error);
    }
    Cc["@mozilla.org/browser/history;1"].getService(Ci.nsISupports);
    Services.obs.notifyObservers(null, HISTORY_STATUS_TOPIC, "clear");
    await result;
  }

  async listBookmarks(parentId = "root") {
    this.#assertOpen();
    return this.#profileStore.listBookmarks(parentId);
  }

  async createBookmark(options) {
    this.#assertOpen();
    const normalized = { ...options };
    if ((normalized.type ?? "bookmark") === "bookmark") {
      normalized.url = normalizeURI(normalized.url).spec;
    }
    return this.#profileStore.createBookmark(normalized);
  }

  async updateBookmark(id, changes) {
    this.#assertOpen();
    const normalized = { ...changes };
    if (Object.hasOwn(normalized, "url")) {
      normalized.url = normalizeURI(normalized.url).spec;
    }
    return this.#profileStore.updateBookmark(id, normalized);
  }

  async moveBookmark(id, parentId, index) {
    this.#assertOpen();
    return this.#profileStore.moveBookmark(id, parentId, index);
  }

  async removeBookmark(id) {
    this.#assertOpen();
    return this.#profileStore.removeBookmark(id);
  }

  async listCredentials(options = undefined) {
    this.#assertOpen();
    return this.#profileStore.listCredentials(options);
  }

  async saveCredential(options) {
    this.#assertOpen();
    const credential = await this.#profileStore.saveCredential(options);
    if (credential) {
      await this.#refreshCredentialStates(credential.origin);
    }
    return credential;
  }

  setCredentialReauthenticationPresentation({ reason, caption = "Navis" }) {
    this.#assertOpen();
    if (
      typeof reason !== "string" ||
      reason.length > 512 ||
      typeof caption !== "string" ||
      !caption.trim() ||
      caption.length > 128
    ) {
      throw new TypeError(
        "Credential reauthentication presentation requires bounded strings"
      );
    }
    this.#credentialReauthenticationPresentation = Object.freeze({
      reason,
      caption,
    });
  }

  async revealCredential(id, { window: ownerWindow = null } = {}) {
    this.#assertOpen();
    return this.#profileStore.getCredential(id, {
      reauthenticate: true,
      reauthenticationReason:
        this.#credentialReauthenticationPresentation.reason,
      reauthenticationCaption:
        this.#credentialReauthenticationPresentation.caption,
      window: ownerWindow,
    });
  }

  async removeCredential(id) {
    this.#assertOpen();
    const removed = await this.#profileStore.removeCredential(id);
    if (removed) {
      await this.#refreshCredentialStates();
    }
    return removed;
  }

  async clearCredentials() {
    this.#assertOpen();
    const cleared = await this.#profileStore.clearCredentials();
    await this.#refreshCredentialStates();
    return cleared;
  }

  async #refreshCredentialStates(requiredOrigin = null) {
    const snapshots = [...this.#sessions]
      .filter(session => !session.state.private)
      .map(session => ({
        session,
        origin: session.state.credentials.origin,
      }))
      .filter(
        snapshot =>
          snapshot.origin &&
          (requiredOrigin === null || snapshot.origin === requiredOrigin)
      );
    const origins = [...new Set(snapshots.map(snapshot => snapshot.origin))];
    const credentialsByOrigin = new Map(
      await Promise.all(
        origins.map(async origin => [
          origin,
          await this.#profileStore.listCredentials({ origin }),
        ])
      )
    );
    for (const { session, origin } of snapshots) {
      if (
        this.#sessions.has(session) &&
        session.state.credentials.origin === origin
      ) {
        session[SET_CREDENTIAL_STATE](
          null,
          origin,
          credentialsByOrigin.get(origin),
          { preserveActor: true }
        );
      }
    }
  }

  async loadSessionState() {
    this.#assertOpen();
    return this.#profileStore.loadSessionState();
  }

  async saveSessionState({ sessions, selectedSession }) {
    this.#assertOpen();
    if (!Array.isArray(sessions) || !sessions.length) {
      throw new TypeError("saveSessionState() requires live Sessions");
    }
    if (!sessions.includes(selectedSession)) {
      throw new TypeError("The selected Session must be in the ordered set");
    }
    const normalSessions = sessions.filter(session => {
      if (!this.#sessions.has(session)) {
        throw new TypeError("A Session does not belong to this Runtime");
      }
      return !session.state.private;
    });
    if (!normalSessions.length) {
      return false;
    }
    if (normalSessions.length !== sessions.length) {
      throw new TypeError(
        "Normal and private Sessions cannot share restore state"
      );
    }
    await this.#profileStore.saveSessionState(
      normalSessions.map(session => ({
        url: normalizeURI(session.state.url).spec,
        selected: session === selectedSession,
      }))
    );
    return true;
  }

  async clearSiteData() {
    this.#assertOpen();
    const failedFlags = await new Promise(resolve => {
      Services.clearData.deleteData(NAVIS_SITE_DATA_FLAGS, resolve);
    });
    if (failedFlags) {
      throw new Error(`Site-data clearing failed for flags ${failedFlags}`);
    }
  }

  copyText(value) {
    this.#assertOpen();
    if (typeof value !== "string") {
      throw new TypeError("Clipboard text must be a string");
    }
    if (!value) {
      return false;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(value);
    return true;
  }

  copyAddressLink(value) {
    this.#assertOpen();
    if (typeof value !== "string" || !value) {
      return false;
    }
    try {
      const uri = Services.io.newURI(value);
      if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
        return false;
      }
    } catch {
      return false;
    }
    return this.copyText(projectDesktopCopiedLink(value));
  }

  getSiteDataState(session) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The Session does not belong to this Runtime");
    }
    const state = authenticatedWebPrincipal(session[GET_BROWSER]());
    return Object.freeze({
      available: Boolean(state),
      origin: state?.origin ?? "",
      host: state?.host ?? "",
    });
  }

  async clearSiteDataForSession(session) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The Session does not belong to this Runtime");
    }
    const state = authenticatedWebPrincipal(session[GET_BROWSER]());
    if (!state) {
      throw new TypeError("The current page has no clearable Web origin");
    }
    const failedFlags = await new Promise(resolve => {
      Services.clearData.deleteDataFromPrincipal(
        state.principal,
        true,
        NAVIS_SITE_DATA_FLAGS,
        resolve
      );
    });
    if (failedFlags) {
      throw new Error(
        `Site-data clearing failed for ${state.origin} with flags ${failedFlags}`
      );
    }
    return Object.freeze({ origin: state.origin, host: state.host });
  }

  // Keeping the authenticated product-page router explicit makes its command
  // allow-list reviewable beside each state mutation.
  // eslint-disable-next-line complexity
  async [HANDLE_INTERNAL_PAGE_COMMAND](session, page, request) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The Session does not belong to this Runtime");
    }
    if (!page || request?.pageKey !== page.key) {
      throw new TypeError("The internal-page command route does not match");
    }
    const command = request.command;
    if (page.key === "settings") {
      if (command === "settings:get") {
        return freezeSettingsPageState(this);
      }
      if (command === "settings:set-search-provider") {
        this.setDefaultSearchProvider(request.value);
        return freezeSettingsPageState(this, "search-provider-updated");
      }
      if (command === "settings:set-locale") {
        this.setLocaleSetting(request.value);
        return freezeSettingsPageState(this, "locale-updated");
      }
      if (command === "settings:relaunch-locale") {
        const accepted = this.relaunchForLocaleChange();
        return freezeSettingsPageState(
          this,
          accepted ? "locale-relaunching" : "locale-relaunch-cancelled"
        );
      }
      if (command === "settings:set-process-isolation") {
        this.setProcessIsolationMode(request.value);
        return freezeSettingsPageState(this, "process-isolation-updated");
      }
      if (command === "settings:relaunch-process-isolation") {
        const accepted = this.relaunchForProcessIsolationChange();
        return freezeSettingsPageState(
          this,
          accepted
            ? "process-isolation-relaunching"
            : "process-isolation-relaunch-cancelled"
        );
      }
      if (command === "settings:set-clean-links") {
        this.setCleanLinksEnabled(request.value);
        this.#cleanLinksReady = prepareDesktopCleanLinks();
        await this.#cleanLinksReady;
        return freezeSettingsPageState(this, "clean-links-updated");
      }
      if (command === "settings:clear-site-data") {
        await this.clearSiteData();
        return freezeSettingsPageState(this, "site-data-cleared");
      }
      throw new TypeError(`Unsupported settings command: ${command}`);
    }

    if (page.key === "extensions") {
      await this.#extensionsReady;
      const manager = this.#extensionManager;
      if (!manager) {
        return Object.freeze({
          pageKey: page.key,
          outcome: "failed",
          extensions: Object.freeze([]),
          error: Object.freeze({ code: "runtime-unavailable" }),
        });
      }
      const ownerWindow = this.#sessionContexts.get(session)?.ownerWindow;
      try {
        if (command === "extensions:get") {
          return freezeExtensionsPageState(manager);
        }
        if (command === "extensions:select-package") {
          const selection = await manager.selectPackage(ownerWindow);
          return freezeExtensionsPageState(manager, selection.outcome, {
            preview: selection.preview,
            ...(selection.error ? { error: selection.error } : {}),
          });
        }
        if (command === "extensions:confirm-install") {
          const result = await manager.confirmInstall(request.value);
          return freezeExtensionsPageState(manager, result.outcome, {
            changedExtensionId: result.extension.id,
          });
        }
        if (command === "extensions:cancel-install") {
          manager.cancelInstall(request.value);
          return freezeExtensionsPageState(manager, "cancelled");
        }
        if (command === "extensions:set-enabled") {
          const extension = await manager.setEnabled(
            request.value.id,
            request.value.enabled
          );
          return freezeExtensionsPageState(manager, "state-updated", {
            changedExtensionId: extension.id,
          });
        }
        if (command === "extensions:set-private-browsing") {
          const extension = await manager.setPrivateBrowsingAllowed(
            request.value.id,
            request.value.enabled
          );
          return freezeExtensionsPageState(manager, "private-access-updated", {
            changedExtensionId: extension.id,
          });
        }
        if (command === "extensions:set-pinned") {
          const extension = await manager.setToolbarPinned(
            request.value.id,
            request.value.enabled
          );
          return freezeExtensionsPageState(manager, "toolbar-updated", {
            changedExtensionId: extension.id,
          });
        }
        if (command === "extensions:uninstall") {
          await manager.uninstall(request.value);
          return freezeExtensionsPageState(manager, "uninstalled", {
            changedExtensionId: request.value,
          });
        }
        if (command === "extensions:open-options") {
          await manager.openOptions(ownerWindow, request.value);
          return freezeExtensionsPageState(manager, "options-opened", {
            changedExtensionId: request.value,
          });
        }
        throw new TypeError(`Unsupported extensions command: ${command}`);
      } catch (error) {
        return freezeExtensionsPageState(manager, "failed", {
          error: extensionOperationFailure(error),
        });
      }
    }

    if (page.key === "newtab" && command === "newtab:navigate") {
      const resolved = this.resolveAddressInput(request.value);
      session.loadUri(resolved.url);
      return Object.freeze({
        pageKey: page.key,
        outcome: "navigation-started",
      });
    }

    if (page.key === "history") {
      if (session.state.private) {
        return Object.freeze({
          pageKey: page.key,
          outcome: "ready",
          private: true,
          items: Object.freeze([]),
        });
      }
      if (command === "history:delete") {
        await this.deleteHistory([request.value]);
      } else if (command === "history:clear") {
        await this.clearHistory();
      } else if (command !== "history:get") {
        throw new TypeError(`Unsupported history command: ${command}`);
      }
      const items = await this.queryHistory({
        search: command === "history:get" ? request.value : "",
        limit: 500,
      });
      return Object.freeze({
        pageKey: page.key,
        outcome: "ready",
        private: false,
        items,
      });
    }

    if (page.key === "bookmarks") {
      if (command === "bookmarks:create") {
        await this.createBookmark({
          parentId: request.value.parentId,
          type: request.value.type,
          title: request.value.title,
          url:
            request.value.type === "bookmark" ? request.value.url : undefined,
        });
        return Object.freeze({ pageKey: page.key, outcome: "updated" });
      }
      if (command === "bookmarks:update") {
        await this.updateBookmark(request.value.id, {
          title: request.value.title,
          ...(request.value.type === "bookmark"
            ? { url: request.value.url }
            : {}),
        });
        return Object.freeze({ pageKey: page.key, outcome: "updated" });
      }
      if (command === "bookmarks:delete") {
        await this.removeBookmark(request.value);
        return Object.freeze({ pageKey: page.key, outcome: "updated" });
      }
      if (command !== "bookmarks:get") {
        throw new TypeError(`Unsupported bookmarks command: ${command}`);
      }
      return Object.freeze({
        pageKey: page.key,
        outcome: "ready",
        parentId: request.value,
        items: await this.listBookmarks(request.value),
      });
    }

    if (page.key === "passwords") {
      if (session.state.private) {
        return Object.freeze({
          pageKey: page.key,
          outcome: "ready",
          private: true,
          items: Object.freeze([]),
        });
      }
      if (command === "passwords:reveal") {
        const ownerWindow = this.#sessionContexts.get(session)?.ownerWindow;
        if (!ownerWindow) {
          throw new Error("The password route has no Platform owner window");
        }
        const credential = await this.revealCredential(request.value, {
          window: ownerWindow,
        });
        return Object.freeze({
          pageKey: page.key,
          outcome: "revealed",
          credential,
        });
      }
      if (command === "passwords:delete") {
        await this.removeCredential(request.value);
      } else if (command === "passwords:clear") {
        await this.clearCredentials();
      } else if (command !== "passwords:get") {
        throw new TypeError(`Unsupported passwords command: ${command}`);
      }
      return Object.freeze({
        pageKey: page.key,
        outcome: "ready",
        private: false,
        items: await this.listCredentials(),
      });
    }

    if (page.key === "downloads") {
      if (command === "downloads:cancel") {
        await this.cancelDownload(request.value);
      } else if (command === "downloads:retry") {
        await this.retryDownload(request.value);
      } else if (command === "downloads:remove") {
        await this.removeDownload(request.value);
      } else if (command !== "downloads:get") {
        throw new TypeError(`Unsupported downloads command: ${command}`);
      }
      return Object.freeze({
        pageKey: page.key,
        outcome: "ready",
        private: session.state.private,
        items: Object.freeze(
          this.downloads.filter(item => item.private === session.state.private)
        ),
      });
    }

    throw new TypeError(`The ${page.key} route does not offer ${command}`);
  }

  getStartupURIs({ window: ownerWindow, fallbackURI } = {}) {
    this.#assertOpen();
    if (!ownerWindow) {
      throw new TypeError("getStartupURIs() requires a chrome window");
    }
    const uris = [];
    try {
      const commandLine = ownerWindow.arguments?.[0]?.QueryInterface(
        Ci.nsICommandLine
      );
      let argument;
      while ((argument = commandLine?.handleFlagWithParam("url", false))) {
        uris.push(commandLine.resolveURI(argument).spec);
      }
    } catch (error) {
      console.error("Desktop embedder could not read startup URLs", error);
    }
    if (uris.length) {
      return uris;
    }
    return fallbackURI == null ? [] : [normalizeURI(fallbackURI).spec];
  }

  async cancelDownload(id) {
    if (this.#closed) {
      return false;
    }
    const entry = this.#downloadsById.get(id);
    if (!entry || entry.download.stopped) {
      return false;
    }
    await entry.download.cancel();
    await entry.download.removePartialData();
    return true;
  }

  async retryDownload(id) {
    if (this.#closed) {
      return false;
    }
    const entry = this.#downloadsById.get(id);
    if (!entry || !entry.download.stopped || entry.download.succeeded) {
      return false;
    }
    await entry.download.removePartialData();
    await entry.download.start();
    return true;
  }

  async removeDownload(id) {
    if (this.#closed) {
      return false;
    }
    const entry = this.#downloadsById.get(id);
    if (!entry || !entry.download.stopped || !this.#downloadList) {
      return false;
    }
    if (!entry.download.succeeded) {
      await entry.download.removePartialData();
    }
    await this.#downloadList.remove(entry.download);
    return true;
  }

  close() {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;

    for (const session of [...this.#sessions]) {
      session.close();
    }
    for (const ownerWindow of [...this.#windows.keys()]) {
      this.#releaseWindow(ownerWindow);
    }
    if (this.#downloadList && this.#downloadView) {
      this.#downloadList.removeView(this.#downloadView);
    }
    this.#downloadList = null;
    this.#downloadView = null;
    this.#downloadsById.clear();

    if (this.#extensionActions) {
      this.#extensionActions.off(
        "action-changed",
        this.#extensionActionChangedListener
      );
      this.#extensionActions.off(
        "action-removed",
        this.#extensionActionRemovedListener
      );
      this.#extensionActions.off(
        "popup-requested",
        this.#extensionPopupRequestedListener
      );
      this.#extensionActions.off(
        "page-action-changed",
        this.#extensionActionChangedListener
      );
      this.#extensionActions.off(
        "page-action-removed",
        this.#extensionActionRemovedListener
      );
    }
    this.#extensionOmnibox?.off(
      "state-changed",
      this.#extensionOmniboxChangedListener
    );
    this.#extensionPopupHost?.close();
    this.#extensionPopupHost = null;
    this.#extensionActions = null;
    this.#extensionOmnibox = null;
    this.#extensionPermissionPrompts?.unregisterRuntime(this);
    this.#extensionPermissionPrompts = null;
    this.#extensionManager?.close();
    this.#extensionManager = null;

    installHistoryDelegate(this, null);
    this.#navigationDelegate = null;
    this.#downloadDelegate = null;
    this.#extensionActionDelegate = null;
    this.#extensionOmniboxDelegate = null;
    this.#sessionDelegateFactory = null;
    this.#core.shutdown();
    return true;
  }

  [FORGET_SESSION](session) {
    if (!this.#sessions.has(session)) {
      return;
    }
    const context = this.#sessionContexts.get(session);
    const extensionTab = DesktopExtensionTabs.getForBrowser(
      session[GET_BROWSER]()
    );
    if (extensionTab) {
      this.#extensionOmnibox?.cancel(extensionTab);
    }
    DesktopExtensionTabs.unregisterSession(
      session,
      this.#closed || Boolean(context?.releasing)
    );
    this.#notifyExtensionActions();
    this.#core.closeSession(session[GET_CORE_SESSION_ID]());
    this.#sessions.delete(session);
    LIVE_ENGINE_SESSIONS.delete(session);
    this.#sessionContexts.delete(session);
    if (!context) {
      return;
    }
    context.sessions.delete(session);
    if (context.activeSession === session) {
      context.activeSession = null;
    }
  }

  [COUNT_WINDOW_SESSIONS](ownerWindow) {
    return this.#windows.get(ownerWindow)?.sessions.size ?? 0;
  }

  [PREPARE_ATTACH_VIEW](session, view) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    const ownerWindow = view[GET_VIEW_WINDOW]();
    if (session.state.private !== isPrivateWindow(ownerWindow)) {
      throw new Error(
        "A desktop Session cannot cross the normal/private window boundary"
      );
    }
    const context = this.#ensureWindow(ownerWindow);
    const viewId = this.#coreViewId(view, context);
    if (!this.#core.canAttach(session[GET_CORE_SESSION_ID](), viewId)) {
      throw new Error("The Core lifecycle rejected this View attachment");
    }
    return Object.freeze({ context, viewId });
  }

  [COMMIT_ATTACH_VIEW](session, { context: destinationContext, viewId }) {
    const sourceContext = this.#sessionContexts.get(session);
    if (!sourceContext || !this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    this.#core.attach(session[GET_CORE_SESSION_ID](), viewId);
    if (sourceContext === destinationContext) {
      return destinationContext;
    }

    const wasActive = sourceContext.activeSession === session;
    sourceContext.sessions.delete(session);
    if (wasActive) {
      sourceContext.activeSession = null;
    }

    destinationContext.sessions.add(session);
    this.#sessionContexts.set(session, destinationContext);
    if (wasActive) {
      destinationContext.activeSession?.[SET_SESSION_ACTIVE](false);
      destinationContext.activeSession = session;
    }
    return destinationContext;
  }

  [COMMIT_DETACH_VIEW](session, view) {
    const viewId = this.#viewIds.get(view);
    if (!viewId || !this.#sessions.has(session)) {
      throw new TypeError("The View binding does not belong to this runtime");
    }
    this.#core.detach(session[GET_CORE_SESSION_ID](), viewId);
  }

  [SET_SESSION_CRASHED](session, crashed) {
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    this.#core.setCrashed(session[GET_CORE_SESSION_ID](), crashed);
  }

  [RECORD_HISTORY_TITLE](session) {
    if (!this.#sessions.has(session)) {
      return;
    }
    const state = session.state;
    callDelegate(
      historyDelegate,
      "HistoryDelegate",
      "onSessionTitleChanged",
      Object.freeze({
        sessionId: state.id,
        url: state.url,
        title: state.title,
        private: state.private,
      })
    );
  }

  async [QUERY_CREDENTIALS](session, actor, request) {
    if (!this.#sessions.has(session)) {
      return Object.freeze({ credential: null });
    }
    if (session.state.private) {
      session[SET_CREDENTIAL_STATE](actor, null, []);
      return Object.freeze({ credential: null });
    }
    try {
      const normalized = normalizeCredentialRequest(request);
      const credentials = await this.#profileStore.listCredentials({
        origin: normalized.origin,
      });
      if (!this.#sessions.has(session)) {
        return Object.freeze({ credential: null });
      }
      session[SET_CREDENTIAL_STATE](actor, normalized.origin, credentials);
      if (!request.allowAutoFill || !credentials.length) {
        return Object.freeze({ credential: null });
      }
      const credential = await this.#profileStore.getCredential(
        credentials[0].id
      );
      if (!credential || !this.#sessions.has(session)) {
        return Object.freeze({ credential: null });
      }
      return Object.freeze({
        credential: Object.freeze({
          id: credential.id,
          origin: credential.origin,
          password: credential.password,
          username: credential.username,
        }),
      });
    } catch (error) {
      console.error("Desktop credential query failed", error);
      if (this.#sessions.has(session)) {
        session[SET_CREDENTIAL_STATE](actor, null, []);
      }
      return Object.freeze({ credential: null });
    }
  }

  async [SUBMIT_CREDENTIAL](session, actor, request) {
    if (!this.#sessions.has(session) || session.state.private) {
      return false;
    }
    const capture = normalizeCredentialRequest(request, {
      includeSecret: true,
    });
    const credentials = await this.#profileStore.listCredentials({
      origin: capture.origin,
    });
    const existing = credentials.find(
      credential => credential.username === capture.username
    );
    if (existing) {
      const full = await this.#profileStore.getCredential(existing.id);
      if (full?.password === capture.password) {
        await this.#profileStore.touchCredential(existing.id);
        session[SET_CREDENTIAL_STATE](actor, capture.origin, credentials);
        return false;
      }
    }
    session[SET_CREDENTIAL_STATE](actor, capture.origin, credentials);
    session[QUEUE_CREDENTIAL_PROMPT](
      Object.freeze({ ...capture, existingId: existing?.id ?? null })
    );
    return true;
  }

  async [SAVE_CREDENTIAL_CAPTURE](session, capture) {
    const credential = await this.#profileStore.saveCredential({
      id: capture.existingId,
      origin: capture.origin,
      actionOrigin: capture.actionOrigin,
      username: capture.username,
      password: capture.password,
      usernameField: capture.usernameField,
      passwordField: capture.passwordField,
    });
    await this.#refreshCredentialStates(capture.origin);
    return credential;
  }

  async [FILL_CREDENTIAL](session, id) {
    if (!this.#sessions.has(session) || session.state.private) {
      return false;
    }
    credentialText(id, "Credential ID", 128, { allowEmpty: false });
    const state = session.state.credentials;
    if (!state.items.some(item => item.id === id)) {
      throw new Error("Credential is not available to this Session");
    }
    const credential = await this.#profileStore.getCredential(id);
    if (!credential || credential.origin !== state.origin) {
      return false;
    }
    const filled = await session[SEND_CREDENTIAL_FILL](credential);
    if (filled) {
      await this.#profileStore.touchCredential(id);
    }
    return filled;
  }

  [BEGIN_CORE_NAVIGATION](session, command, requestedUrl = null) {
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    const commandId = CORE_NAVIGATION_COMMANDS[command];
    if (commandId === undefined) {
      throw new TypeError(`Unknown Core navigation command: ${command}`);
    }
    return this.#core.beginNavigation(
      session[GET_CORE_SESSION_ID](),
      commandId,
      requestedUrl ?? "",
      requestedUrl !== null
    );
  }

  [UPDATE_CORE_NAVIGATION](session, method, ...args) {
    if (!this.#sessions.has(session)) {
      throw new TypeError("The session does not belong to this runtime");
    }
    if (!CORE_NAVIGATION_UPDATE_METHODS.has(method)) {
      throw new TypeError(`Unknown Core navigation update: ${method}`);
    }
    return this.#core[method](session[GET_CORE_SESSION_ID](), ...args);
  }

  [GET_CORE_NAVIGATION_STATE](session) {
    const state = this.#core.navigationState(session[GET_CORE_SESSION_ID]());
    return Object.freeze({
      revision: state.revision,
      navigationId: state.navigationId,
      url: state.url,
      title: state.title,
      loading: state.loading,
      loadingActivity:
        CORE_NAVIGATION_ACTIVITIES[state.loadingActivity] ?? "idle",
      security: CORE_NAVIGATION_SECURITY[state.security] ?? "unknown",
      identity: CORE_NAVIGATION_IDENTITIES[state.identity] ?? "unknown",
      identityKey: state.identityKey,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      failureCode: state.hasFailure ? state.failureCode : null,
    });
  }

  [CREATE_PARKING_BROWSER](session, options = {}) {
    this.#assertOpen();
    const context = this.#sessionContexts.get(session);
    if (!context || context.releasing) {
      throw new Error("EngineSession has no live window for detached content");
    }
    const host = this.#ensureParkingHost(context);
    const browser = createRemoteBrowser(context.ownerWindow.document, host, {
      ...options,
      skipLoad: false,
      className: "desktop-engine-parking-browser",
    });
    browser.hidden = false;
    browser.docShellIsActive = false;
    browser.removeAttribute("primary");
    return browser;
  }

  [DESTROY_PARKING_BROWSER](browser) {
    if (!browser) {
      return;
    }
    const host = browser.parentElement;
    browser.remove();
    if (!host?.classList.contains("desktop-engine-parking-host")) {
      return;
    }
    if (!host.childElementCount) {
      host.remove();
      for (const context of this.#windows.values()) {
        if (context.parkingHost === host) {
          context.parkingHost = null;
          break;
        }
      }
    }
  }

  #assertOpen() {
    if (this.#closed || this.#core.closed) {
      throw new Error("A closed EngineRuntime cannot be used");
    }
  }

  // nsIBrowserDOMWindow combines disposition, opener, security, and lifecycle
  // policy in one synchronous method that cannot be split across callbacks.
  // eslint-disable-next-line complexity
  [OPEN_FROM_GECKO]({
    ownerWindow,
    uri = null,
    where,
    flags,
    openWindowInfo = null,
    triggeringPrincipal = null,
    policyContainer = null,
    referrerInfo = null,
    openerBrowser = null,
    openerOriginAttributes = null,
    name: targetName = "",
    skipLoad = false,
    returnBrowser = false,
  }) {
    const sourceContext = this.#windows.get(ownerWindow);
    if (this.#closed || !sourceContext) {
      return null;
    }
    const isExternal = Boolean(flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL);
    if (isExternal && uri?.schemeIs("chrome")) {
      this.#dispatchPopupBlocked(uri, "external chrome URI");
      return null;
    }

    if (
      where === Ci.nsIBrowserDOMWindow.OPEN_CURRENTWINDOW ||
      (!this.#isNewSessionDisposition(where) &&
        where !== Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW)
    ) {
      if (!sourceContext.activeSession) {
        return null;
      }
      if (uri && !skipLoad) {
        sourceContext.activeSession[LOAD_GECKO_URI](uri, {
          triggeringPrincipal,
          referrerInfo,
          policyContainer,
          external: isExternal,
        });
      }
      const browser = sourceContext.activeSession[GET_BROWSER]();
      return returnBrowser ? browser : browser?.browsingContext || null;
    }

    const background = where === Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND;
    const descriptor = Object.freeze({
      uri: uri?.spec || "about:blank",
      disposition: background ? "background" : "foreground",
      external: isExternal,
      hasOpener: Boolean(openWindowInfo || openerBrowser),
    });

    const policy = this.#evaluateNewSessionPolicy(descriptor, background);
    if (!policy.allow) {
      this.#dispatchPopupBlocked(uri, "product policy");
      return null;
    }

    const activate = policy.activate;
    const previousActiveSession = sourceContext.activeSession;
    const destinationContext = this.#windows.get(
      policy.view[GET_VIEW_WINDOW]()
    );
    const userContextId = userContextIdFrom(
      openWindowInfo,
      openerOriginAttributes
    );
    const preferredRemoteType =
      openerBrowser?.remoteType ||
      (triggeringPrincipal?.addonId ? "extension" : "web");
    let remoteType = preferredRemoteType;
    try {
      remoteType =
        ChromeUtils.predictRemoteTypeForURI(uri, {
          window: destinationContext.ownerWindow,
          userContextId,
          preferredRemoteType,
        }) || preferredRemoteType;
    } catch (error) {
      console.error(
        "Desktop embedder could not predict a content process",
        error
      );
    }
    let initialBrowsingContextGroupId = null;
    if (triggeringPrincipal?.addonId && uri?.schemeIs("moz-extension")) {
      try {
        initialBrowsingContextGroupId =
          triggeringPrincipal.addonPolicy?.browsingContextGroupId || null;
      } catch {}
    }
    const restorationSessions = new Set(
      [previousActiveSession, destinationContext?.activeSession].filter(Boolean)
    );
    let session;
    try {
      session = this.createSession({ view: policy.view });
      session[CREATE_BROWSER]({
        openWindowInfo,
        userContextId,
        name: targetName,
        skipLoad,
        remoteType,
        initialBrowsingContextGroupId,
      });
    } catch (error) {
      console.error("Desktop embedder could not create a new Session", error);
      session?.close();
      this.#restoreSessions(restorationSessions);
      this.#dispatchPopupBlocked(uri, "product lifecycle failure");
      return null;
    }

    if (
      !this.#deliverNewSession(
        Object.freeze({
          session,
          reason: "popup",
          activate,
          openerSessionId: this.#sessionIdForBrowser(openerBrowser),
        }),
        restorationSessions,
        uri
      )
    ) {
      return null;
    }

    if (activate) {
      this.activateSession(session);
    }

    if (uri && !skipLoad) {
      session[LOAD_GECKO_URI](uri, {
        triggeringPrincipal,
        referrerInfo,
        policyContainer,
        external: isExternal,
      });
    }

    const browser = session[GET_BROWSER]();
    return returnBrowser ? browser : browser.browsingContext;
  }

  #isNewSessionDisposition(where) {
    return [
      Ci.nsIBrowserDOMWindow.OPEN_DEFAULTWINDOW,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_FOREGROUND,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_AFTER_CURRENT,
    ].includes(where);
  }

  #evaluateNewSessionPolicy(descriptor, background) {
    if (!this.#navigationDelegate) {
      return { allow: false, activate: false, view: null };
    }
    let decision;
    try {
      decision = this.#navigationDelegate.onNewSession(descriptor);
    } catch (error) {
      console.error("Desktop embedder navigation delegate failed", error);
      return { allow: false, activate: false, view: null };
    }
    if (
      decision === false ||
      decision === "block" ||
      typeof decision !== "object" ||
      !decision?.allow ||
      !(decision.view instanceof EngineView)
    ) {
      return { allow: false, activate: false, view: null };
    }
    return {
      allow: true,
      activate: decision.activate ?? !background,
      view: decision.view,
    };
  }

  #coreViewId(view, context) {
    let id = this.#viewIds.get(view);
    if (!id) {
      id = this.#core.registerView(context.coreId);
      this.#viewIds.set(view, id);
    }
    return id;
  }

  #ensureWindow(ownerWindow) {
    if (!ownerWindow || ownerWindow.closed) {
      throw new TypeError("EngineView must belong to an open chrome window");
    }
    const existing = this.#windows.get(ownerWindow);
    if (existing) {
      return existing;
    }
    if (ownerWindow.browserDOMWindow) {
      throw new Error(
        "The EngineView window is already owned by another browser integration"
      );
    }

    const coreId = this.#core.registerWindow();
    const browserDOMWindow = new DesktopBrowserDOMWindow(this, ownerWindow);
    const unloadListener = () => this.#releaseWindow(ownerWindow);
    const context = {
      ownerWindow,
      coreId,
      browserDOMWindow,
      unloadListener,
      sessions: new Set(),
      activeSession: null,
      parkingHost: null,
      releasing: false,
    };
    registerDesktopWindow(ownerWindow);
    try {
      ownerWindow.browserDOMWindow = browserDOMWindow;
      ownerWindow.addEventListener("unload", unloadListener, { once: true });
      this.#windows.set(ownerWindow, context);
    } catch (error) {
      if (ownerWindow.browserDOMWindow === browserDOMWindow) {
        ownerWindow.browserDOMWindow = null;
      }
      unregisterDesktopWindow(ownerWindow);
      this.#core.closeWindow(coreId);
      throw error;
    }
    return context;
  }

  #ensureParkingHost(context) {
    if (context.parkingHost?.isConnected) {
      return context.parkingHost;
    }
    const { document: ownerDocument } = context.ownerWindow;
    const host = ownerDocument.createElement("div");
    host.className = "desktop-engine-parking-host";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;" +
      "overflow:hidden;pointer-events:none;visibility:hidden;";
    (ownerDocument.body || ownerDocument.documentElement).append(host);
    context.parkingHost = host;
    return host;
  }

  #releaseWindow(ownerWindow) {
    const context = this.#windows.get(ownerWindow);
    if (!context || context.releasing) {
      return false;
    }
    context.releasing = true;
    ownerWindow.removeEventListener("unload", context.unloadListener);
    for (const session of [...context.sessions]) {
      session.close();
    }
    context.parkingHost?.remove();
    context.parkingHost = null;
    if (ownerWindow.browserDOMWindow === context.browserDOMWindow) {
      ownerWindow.browserDOMWindow = null;
    }
    unregisterDesktopWindow(ownerWindow);
    this.#core.closeWindow(context.coreId);
    this.#windows.delete(ownerWindow);
    return true;
  }

  #sessionIdForBrowser(browser) {
    if (!browser) {
      return null;
    }
    for (const session of this.#sessions) {
      if (session[GET_BROWSER]() === browser) {
        return session.id;
      }
    }
    return null;
  }

  #deliverNewSession(details, restorationSessions, uri) {
    try {
      const result = this.#navigationDelegate.onSessionCreated(details);
      if (typeof result?.then === "function") {
        throw new TypeError(
          "NavigationDelegate.onSessionCreated must complete synchronously"
        );
      }
      if (!this.#sessions.has(details.session)) {
        this.#restoreSessions(restorationSessions);
        this.#dispatchPopupBlocked(uri, "product closed new session");
        return false;
      }
      return true;
    } catch (error) {
      console.error("NavigationDelegate.onSessionCreated failed", error);
      details.session.close();
      this.#restoreSessions(restorationSessions);
      this.#dispatchPopupBlocked(uri, "product lifecycle failure");
      return false;
    }
  }

  #restoreSessions(sessions) {
    if (this.#closed) {
      return;
    }
    for (const session of sessions) {
      if (this.#sessions.has(session)) {
        this.activateSession(session);
      }
    }
  }

  #dispatchPopupBlocked(uri, reason) {
    const detail = Object.freeze({
      uri: uri?.spec || "about:blank",
      reason,
    });
    callDelegate(
      this.#navigationDelegate,
      "NavigationDelegate",
      "onPopupBlocked",
      detail
    );
  }

  async #initializeExtensions() {
    if (!AppConstants.MOZ_WEBEXTENSIONS_RUNTIME) {
      return;
    }
    try {
      const { DesktopExtensionPermissionPrompts } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopExtensionPermissionPrompts.sys.mjs"
      );
      DesktopExtensionPermissionPrompts.registerRuntime(
        this,
        (nativeTab, request) => {
          if (
            this.#closed ||
            nativeTab.runtime !== this ||
            !this.#sessions.has(nativeTab.session)
          ) {
            return false;
          }
          return nativeTab.session[QUEUE_EXTENSION_PERMISSION](request);
        }
      );
      this.#extensionPermissionPrompts = DesktopExtensionPermissionPrompts;
      const { DesktopExtensionManager } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopExtensionManager.sys.mjs"
      );
      const manager = new DesktopExtensionManager();
      await manager.initialize();
      if (this.#closed) {
        manager.close();
        return;
      }
      this.#extensionManager = manager;
      const { DesktopExtensionActions } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopExtensionActions.sys.mjs"
      );
      const { DesktopExtensionOmnibox } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopExtensionOmnibox.sys.mjs"
      );
      const { DesktopExtensionPopupHost } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopExtensionPopupHost.sys.mjs"
      );
      this.#extensionActions = DesktopExtensionActions;
      this.#extensionOmnibox = DesktopExtensionOmnibox;
      this.#extensionPopupHost = new DesktopExtensionPopupHost();
      DesktopExtensionActions.on(
        "action-changed",
        this.#extensionActionChangedListener
      );
      DesktopExtensionActions.on(
        "action-removed",
        this.#extensionActionRemovedListener
      );
      DesktopExtensionActions.on(
        "popup-requested",
        this.#extensionPopupRequestedListener
      );
      DesktopExtensionActions.on(
        "page-action-changed",
        this.#extensionActionChangedListener
      );
      DesktopExtensionActions.on(
        "page-action-removed",
        this.#extensionActionRemovedListener
      );
      DesktopExtensionOmnibox.on(
        "state-changed",
        this.#extensionOmniboxChangedListener
      );
      this.#notifyExtensionActions();
    } catch (error) {
      this.#extensionPermissionPrompts?.unregisterRuntime(this);
      this.#extensionPermissionPrompts = null;
      console.error(
        "Desktop embedder could not initialize the extension manager",
        error
      );
    }
  }

  #extensionNativeTab(session) {
    this.#assertOpen();
    if (!this.#sessions.has(session)) {
      throw new TypeError(
        "The extension action Session does not belong to this Runtime"
      );
    }
    const nativeTab = DesktopExtensionTabs.getForBrowser(
      session[GET_BROWSER]()
    );
    if (!nativeTab || nativeTab.runtime !== this) {
      throw new Error("The extension action Session has no registered tab");
    }
    return nativeTab;
  }

  async #openExtensionPopup(
    nativeTab,
    extensionId,
    popup,
    anchorId,
    browserStyle
  ) {
    if (nativeTab?.runtime !== this) {
      return false;
    }
    const extension = this.#extensionActions?.getExtension(extensionId);
    if (!extension || !this.#extensionPopupHost) {
      throw new Error("The extension popup runtime is unavailable");
    }
    return this.#extensionPopupHost.open(
      nativeTab.window,
      extension,
      popup,
      anchorId,
      browserStyle
    );
  }

  #notifyExtensionActions() {
    callDelegate(
      this.#extensionActionDelegate,
      "ExtensionActionDelegate",
      "onActionsChanged"
    );
  }

  async #initializeDownloads() {
    const downloadList = await Downloads.getList(Downloads.ALL);
    if (this.#closed) {
      return;
    }
    this.#downloadList = downloadList;
    this.#downloadView = {
      onDownloadAdded: download => this.#updateDownload(download),
      onDownloadChanged: download => this.#updateDownload(download),
      onDownloadRemoved: download => this.#removeDownload(download),
    };
    downloadList.addView(this.#downloadView);
  }

  #updateDownload(download) {
    let id = this.#downloadIds.get(download);
    if (!id) {
      id = `download-${nextDownloadId++}`;
      this.#downloadIds.set(download, id);
    }
    this.#downloadsById.set(id, {
      download,
      state: projectDownload(id, download),
    });
    this.#dispatchDownloadChange();
  }

  #removeDownload(download) {
    const id = this.#downloadIds.get(download);
    if (id) {
      this.#downloadsById.delete(id);
      this.#dispatchDownloadChange();
    }
  }

  #dispatchDownloadChange() {
    const downloads = this.downloads;
    callDelegate(
      this.#downloadDelegate,
      "DownloadDelegate",
      "onDownloadsChanged",
      downloads
    );
  }
}

/** Adapts Gecko new-window calls to EngineRuntime sessions. */
class DesktopBrowserDOMWindow {
  #runtime;
  #window;

  constructor(runtime, ownerWindow) {
    this.#runtime = runtime;
    this.#window = ownerWindow;
  }

  createContentWindow(
    uri,
    openWindowInfo,
    where,
    flags,
    triggeringPrincipal,
    policyContainer
  ) {
    return this.#runtime[OPEN_FROM_GECKO]({
      ownerWindow: this.#window,
      where,
      flags,
      openWindowInfo,
      triggeringPrincipal,
      policyContainer,
      skipLoad: true,
    });
  }

  createContentWindowInFrame(uri, params, where, flags, targetName) {
    return this.#runtime[OPEN_FROM_GECKO]({
      ownerWindow: this.#window,
      where,
      flags,
      openWindowInfo: params.openWindowInfo,
      triggeringPrincipal: params.triggeringPrincipal,
      policyContainer: params.policyContainer,
      referrerInfo: params.referrerInfo,
      openerBrowser: params.openerBrowser,
      openerOriginAttributes: params.openerOriginAttributes,
      name: targetName,
      skipLoad: true,
      returnBrowser: true,
    });
  }

  openURI(
    uri,
    openWindowInfo,
    where,
    flags,
    triggeringPrincipal,
    policyContainer
  ) {
    if (!uri) {
      throw Components.Exception("A URI is required", Cr.NS_ERROR_FAILURE);
    }
    return this.#runtime[OPEN_FROM_GECKO]({
      ownerWindow: this.#window,
      uri,
      where,
      flags,
      openWindowInfo,
      triggeringPrincipal,
      policyContainer,
    });
  }

  openURIInFrame(uri, params, where, flags, targetName) {
    if (!uri) {
      throw Components.Exception("A URI is required", Cr.NS_ERROR_FAILURE);
    }
    return this.#runtime[OPEN_FROM_GECKO]({
      ownerWindow: this.#window,
      uri,
      where,
      flags,
      openWindowInfo: params.openWindowInfo,
      triggeringPrincipal: params.triggeringPrincipal,
      policyContainer: params.policyContainer,
      referrerInfo: params.referrerInfo,
      openerBrowser: params.openerBrowser,
      openerOriginAttributes: params.openerOriginAttributes,
      name: targetName,
      returnBrowser: true,
    });
  }

  canClose() {
    return true;
  }

  get tabCount() {
    return this.#runtime[COUNT_WINDOW_SESSIONS](this.#window);
  }
}

DesktopBrowserDOMWindow.prototype.QueryInterface = ChromeUtils.generateQI([
  "nsIBrowserDOMWindow",
]);

/** Owns the native browser element that presents a session. */
export class EngineView {
  #document;
  #host;
  #browser = null;
  #session = null;
  #active = false;
  #crashed = false;

  constructor({ document: ownerDocument, host }) {
    if (!ownerDocument || !host) {
      throw new TypeError("EngineView requires a document and host element");
    }
    if (host.ownerDocument !== ownerDocument) {
      throw new TypeError("EngineView host must belong to its document");
    }
    this.#document = ownerDocument;
    this.#host = host;
  }

  get attached() {
    return Boolean(this.#browser?.isConnected);
  }

  get session() {
    return this.#session;
  }

  get visible() {
    return Boolean(
      this.#browser?.isConnected &&
      this.#active &&
      !this.#crashed &&
      !this.#browser.hidden
    );
  }

  get focused() {
    return Boolean(
      this.visible && this.#document.activeElement === this.#browser
    );
  }

  get bounds() {
    try {
      const { x, y, width, height } = this.#host.getBoundingClientRect();
      return Object.freeze({ x, y, width, height });
    } catch {
      return Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  focus() {
    if (!this.visible) {
      return false;
    }
    Services.focus.setFocus(this.#browser, Services.focus.FLAG_NOSCROLL);
    return this.focused;
  }

  blur() {
    if (!this.focused) {
      return false;
    }
    this.#browser.blur();
    return !this.focused;
  }

  attach(session) {
    if (!(session instanceof EngineSession)) {
      throw new TypeError("EngineView.attach() requires an EngineSession");
    }
    session[ATTACH_VIEW](this);
    return this;
  }

  detach() {
    if (!this.#session) {
      return null;
    }
    const session = this.#session;
    session[DETACH_VIEW](this);
    return session;
  }

  [GET_VIEW_WINDOW]() {
    return this.#document.defaultView;
  }

  [CLAIM_VIEW](session) {
    if (this.#session) {
      throw new Error("EngineView is already bound to an EngineSession");
    }
    if (this.#browser) {
      throw new Error("EngineView retained a browser without an EngineSession");
    }
    this.#active = false;
    this.#crashed = false;
    this.#session = session;
  }

  [RELEASE_VIEW](session) {
    if (this.#session === session) {
      this.#session = null;
      this.#active = false;
      this.#crashed = false;
    }
  }

  [GET_BROWSER]() {
    return this.#browser;
  }

  [CREATE_VIEW_BROWSER]({
    openWindowInfo = null,
    userContextId = 0,
    name: browserName = "",
    skipLoad = false,
    remoteType = "web",
  } = {}) {
    if (!this.#session) {
      throw new Error("An unbound EngineView cannot create a browser");
    }
    if (this.#browser) {
      return this.#browser;
    }

    this.#browser = createRemoteBrowser(this.#document, this.#host, {
      openWindowInfo,
      userContextId,
      name: browserName,
      skipLoad,
      remoteType,
    });
    this.#applyState();
    return this.#browser;
  }

  [SET_VIEW_STATE]({ active = this.#active, crashed = this.#crashed }) {
    this.#active = active;
    this.#crashed = crashed;
    this.#applyState();
  }

  [DESTROY_VIEW_BROWSER]() {
    this.#browser?.remove();
    this.#browser = null;
  }

  #applyState() {
    if (!this.#browser) {
      return;
    }
    if (
      (!this.#active || this.#crashed) &&
      this.#document.activeElement === this.#browser
    ) {
      this.#browser.blur();
    }
    this.#browser.hidden = !this.#active || this.#crashed;
    this.#browser.docShellIsActive = this.#active && !this.#crashed;
    this.#browser.toggleAttribute("primary", this.#active);
  }
}

/** Owns one remote browser and projects its state to the product UI. */
export class EngineSession {
  #runtime;
  #coreId;
  #view;
  #browser = null;
  #progressListener = null;
  #titleListener = null;
  #crashListener = null;
  #active = false;
  #closed = false;
  #prompts = [];
  #contentDelegate = null;
  #contextMenuDelegate = null;
  #contextMenuRequest = null;
  #permissionDelegate = null;
  #promptDelegate = null;
  #webAuthnDelegate = null;
  #mediaDelegate = null;
  #crashDelegate = null;
  #credentialActor = null;
  #requestNavigations = new WeakMap();
  #state;

  constructor({ runtime, view, coreId, id, privateMode }) {
    this.#runtime = runtime;
    this.#coreId = coreId;
    this.#view = view;
    const navigation = runtime[GET_CORE_NAVIGATION_STATE](this);
    this.#state = {
      id,
      private: privateMode,
      navigationRevision: navigation.revision,
      navigationId: navigation.navigationId,
      url: navigation.url,
      title: navigation.title || DEFAULT_TITLE,
      loading: navigation.loading,
      loadingActivity: navigation.loadingActivity,
      security: navigation.security,
      identity: navigation.identity,
      identityKey: navigation.identityKey,
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward,
      failureCode: navigation.failureCode,
      favicon: "",
      crashed: false,
      closed: false,
      fullscreen: false,
      prompt: null,
      credentials: {
        origin: null,
        items: [],
      },
      media: {
        camera: false,
        microphone: false,
        screen: false,
      },
    };
  }

  get id() {
    return this.#state.id;
  }

  get state() {
    return freezeSessionState(this.#state);
  }

  get view() {
    return this.#view;
  }

  fillCredential(id) {
    this.#assertOpen();
    return this.#runtime[FILL_CREDENTIAL](this, id);
  }

  getSecurityDetails() {
    this.#assertOpen();
    return projectSecurityDetails(this.#browser, this.#state);
  }

  executeContextMenuCommand(requestId, command) {
    this.#assertOpen();
    if (typeof requestId !== "string" || typeof command !== "string") {
      throw new TypeError(
        "Context-menu request and command IDs must be strings"
      );
    }
    const request = this.#contextMenuRequest;
    const item = request?.items.get(command);
    if (
      !request ||
      request.descriptor.id !== requestId ||
      request.navigationId !== this.#state.navigationId ||
      !item?.enabled
    ) {
      return false;
    }

    this.#contextMenuRequest = null;
    let handled = false;
    try {
      if (item.group.startsWith("extension:")) {
        request.actor.dismiss(request.token);
        handled = DesktopExtensionMenus.execute(
          request.extensionMenuRequestId,
          command
        );
      } else if (command === "back") {
        DesktopExtensionMenus.dismiss(request.extensionMenuRequestId);
        request.actor.dismiss(request.token);
        handled = this.goBack();
      } else if (command === "forward") {
        DesktopExtensionMenus.dismiss(request.extensionMenuRequestId);
        request.actor.dismiss(request.token);
        handled = this.goForward();
      } else if (command === "reload") {
        DesktopExtensionMenus.dismiss(request.extensionMenuRequestId);
        request.actor.dismiss(request.token);
        handled = this.reload();
      } else {
        DesktopExtensionMenus.dismiss(request.extensionMenuRequestId);
        handled = request.actor.execute(request.token, command);
      }
    } catch (error) {
      console.error("Desktop embedder context-menu command failed", error);
    }
    this.#notifyContextMenuDismissed(request.descriptor, "command");
    return Boolean(handled);
  }

  dismissContextMenu(requestId) {
    this.#assertOpen();
    if (typeof requestId !== "string") {
      throw new TypeError("Context-menu request ID must be a string");
    }
    if (this.#contextMenuRequest?.descriptor.id !== requestId) {
      return false;
    }
    return this.#dismissContextMenu("dismissed");
  }

  setDelegates(delegates) {
    if (!delegates || typeof delegates !== "object") {
      throw new TypeError("Session delegates must be an object");
    }
    for (const name of Object.keys(delegates)) {
      if (!SESSION_DELEGATE_NAMES.has(name)) {
        throw new TypeError(`Unknown session delegate: ${name}`);
      }
    }
    if (Object.hasOwn(delegates, "content")) {
      this.setContentDelegate(delegates.content);
    }
    if (Object.hasOwn(delegates, "contextMenu")) {
      this.setContextMenuDelegate(delegates.contextMenu);
    }
    if (Object.hasOwn(delegates, "permission")) {
      this.setPermissionDelegate(delegates.permission);
    }
    if (Object.hasOwn(delegates, "prompt")) {
      this.setPromptDelegate(delegates.prompt);
    }
    if (Object.hasOwn(delegates, "webAuthn")) {
      this.setWebAuthnDelegate(delegates.webAuthn);
    }
    if (Object.hasOwn(delegates, "media")) {
      this.setMediaDelegate(delegates.media);
    }
    if (Object.hasOwn(delegates, "crash")) {
      this.setCrashDelegate(delegates.crash);
    }
    return this;
  }

  setContentDelegate(delegate) {
    validateDelegate(
      delegate,
      "ContentDelegate",
      ["onStateChanged", "onInteraction"],
      ["onStateChanged"]
    );
    this.#contentDelegate = delegate;
    return this;
  }

  setContextMenuDelegate(delegate) {
    validateDelegate(
      delegate,
      "ContextMenuDelegate",
      ["onShow", "onDismissed"],
      ["onShow"]
    );
    this.#dismissContextMenu("delegate-changed");
    this.#contextMenuDelegate = delegate;
    return this;
  }

  setPermissionDelegate(delegate) {
    validateDelegate(
      delegate,
      "PermissionDelegate",
      ["onRequest", "onCanceled"],
      ["onRequest"]
    );
    this.#permissionDelegate = delegate;
    return this;
  }

  setPromptDelegate(delegate) {
    validateDelegate(
      delegate,
      "PromptDelegate",
      ["onPrompt", "onCanceled"],
      ["onPrompt"]
    );
    this.#promptDelegate = delegate;
    return this;
  }

  setWebAuthnDelegate(delegate) {
    validateDelegate(
      delegate,
      "WebAuthnDelegate",
      ["onRequest", "onCanceled"],
      ["onRequest"]
    );
    if (delegate !== this.#webAuthnDelegate) {
      this.#cancelWebAuthnPrompts("delegate-changed");
    }
    this.#webAuthnDelegate = delegate;
    return this;
  }

  setMediaDelegate(delegate) {
    validateDelegate(
      delegate,
      "MediaDelegate",
      ["onStateChanged"],
      ["onStateChanged"]
    );
    this.#mediaDelegate = delegate;
    return this;
  }

  setCrashDelegate(delegate) {
    validateDelegate(delegate, "CrashDelegate", ["onCrash"], ["onCrash"]);
    this.#crashDelegate = delegate;
    return this;
  }

  open(uri) {
    if (this.#closed) {
      throw new Error("A closed EngineSession cannot be reopened");
    }
    if (!this.#browser) {
      // The explicit load below owns the first Core navigation identity.
      // Suppress Gecko's implicit about:blank so it cannot consume that
      // identity before the requested document starts.
      this[CREATE_BROWSER]({ skipLoad: true });
    }
    return this.loadUri(uri);
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#dismissContextMenu("session-closed");
      this.#cancelAllPrompts("session-closed");
      if (this.#state.loading) {
        this.#runtime[UPDATE_CORE_NAVIGATION](
          this,
          "stopNavigation",
          this.#state.navigationId
        );
      }
      // Publish one terminal state while the browser is still available to
      // Delegate consumers. Synchronizing Core before releasing the browser
      // prevents a second `closed` callback from observing a half-destroyed
      // Session after an in-flight navigation is stopped.
      this.#syncNavigationState({
        closed: true,
        fullscreen: false,
        credentials: { origin: null, items: [] },
        media: { camera: false, microphone: false, screen: false },
      });
      this.#destroyBrowser();
    } finally {
      this.#view?.[RELEASE_VIEW](this);
      this.#view = null;
      this.#runtime[FORGET_SESSION](this);
    }
  }

  loadUri(value) {
    this.#assertOpen();
    const uri = normalizeURI(value);
    this[LOAD_GECKO_URI](uri, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      // Product navigation has authority to enter exact internal routes, but
      // the destination must never inherit the principal of the page it
      // replaces. This mirrors Firefox's URL-bar load contract and lets an
      // ordinary HTTP(S) request remain visible to WebExtensions.
      allowInheritPrincipal: false,
    });
    return uri.spec;
  }

  goBack() {
    this.#assertOpen();
    if (this.#state.crashed || !this.#state.canGoBack) {
      return false;
    }
    return this.#performCoreNavigation("back", null, () => {
      this.#browser.goBack();
    });
  }

  goForward() {
    this.#assertOpen();
    if (this.#state.crashed || !this.#state.canGoForward) {
      return false;
    }
    return this.#performCoreNavigation("forward", null, () => {
      this.#browser.goForward();
    });
  }

  reload() {
    this.#assertOpen();
    if (this.#state.crashed) {
      return this.restore();
    }
    return this.#performCoreNavigation("reload", null, () => {
      this.#browser.reload();
    });
  }

  stop() {
    this.#assertOpen();
    if (this.#state.crashed || !this.#state.loading) {
      return false;
    }
    this.#browser.stop();
    const changed = this.#runtime[UPDATE_CORE_NAVIGATION](
      this,
      "stopNavigation",
      this.#state.navigationId
    );
    if (changed) {
      this.#syncNavigationState();
    }
    return changed;
  }

  restore() {
    this.#assertOpen();
    if (!this.#state.crashed) {
      return false;
    }
    const uri = normalizeURI(this.#state.url);
    this[LOAD_GECKO_URI](uri, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      allowInheritPrincipal: false,
      navigationCommand: "restore",
    });
    return true;
  }

  [SET_CREDENTIAL_STATE](actor, origin, items, { preserveActor = false } = {}) {
    if (this.#closed) {
      return;
    }
    if (!Array.isArray(items)) {
      throw new TypeError("Credential state items must be an array");
    }
    if (!preserveActor) {
      this.#credentialActor = actor;
    }
    this.#patchState({
      credentials: {
        origin,
        items: items.map(item => ({ ...item })),
      },
    });
  }

  [CREDENTIAL_ACTOR_DESTROYED](actor) {
    if (actor === this.#credentialActor) {
      this.#clearCredentialState();
    }
  }

  async [SEND_CREDENTIAL_FILL](credential) {
    if (!this.#credentialActor || this.#closed || this.#state.crashed) {
      return false;
    }
    try {
      const result = await this.#credentialActor.sendQuery(
        "DesktopCredential:Fill",
        {
          id: credential.id,
          origin: credential.origin,
          password: credential.password,
          username: credential.username,
        }
      );
      return Boolean(result?.filled);
    } catch (error) {
      console.error("Desktop credential fill failed", error);
      return false;
    }
  }

  [QUEUE_CREDENTIAL_PROMPT](capture) {
    const updating = Boolean(capture.existingId);
    const descriptor = Object.freeze({
      id: `prompt-${nextPromptId++}`,
      sessionId: this.id,
      category: "credential",
      kind: updating ? "password-update" : "password-save",
      origin: capture.origin,
      frameOrigin: capture.origin,
      title: "",
      message: "",
      username: capture.username,
      modalScope: "session",
      beforeUnload: false,
      buttons: Object.freeze([
        Object.freeze({
          id: 0,
          role: "accept",
          label: null,
        }),
        Object.freeze({ id: 1, role: "cancel", label: null }),
      ]),
      defaultButton: 0,
      cancelButton: 1,
      checkbox: null,
      input: null,
    });
    this.#enqueuePrompt({
      descriptor,
      delegateType: "prompt",
      notifyShown: null,
      respond: response => {
        if (response.action === "accept" && response.button === 0) {
          this.#runtime[SAVE_CREDENTIAL_CAPTURE](this, capture).catch(error => {
            console.error("Desktop credential save failed", error);
          });
        }
      },
      cancel: () => undefined,
    });
  }

  [QUEUE_EXTENSION_PERMISSION](request) {
    return new Promise(resolve => {
      let settled = false;
      let timeout = null;
      const finish = allowed => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(allowed === true);
      };
      const descriptor = Object.freeze({
        id: `prompt-${nextPromptId++}`,
        sessionId: this.id,
        category: "extension-permission",
        kind: "extension-optional-permission",
        origin: "",
        frameOrigin: "",
        title: "",
        message: "",
        extensionId: request.extensionId,
        extensionName: request.extensionName,
        permissions: request.permissions,
        origins: request.origins,
        modalScope: "session",
        beforeUnload: false,
        buttons: Object.freeze([
          Object.freeze({ id: 0, role: "accept", label: null }),
          Object.freeze({ id: 1, role: "cancel", label: null }),
        ]),
        defaultButton: 0,
        cancelButton: 1,
        checkbox: null,
        input: null,
      });
      const promptEntry = {
        descriptor,
        delegateType: "permission",
        notifyShown: null,
        respond: decision => {
          finish(decision === "allow-always" || decision === "allow-session");
        },
        cancel: () => finish(false),
      };
      timeout = setTimeout(
        () => this.#cancelQueuedPrompt(promptEntry, "timed-out"),
        EXTENSION_PERMISSION_TIMEOUT_MS
      );
      this.#enqueuePrompt(promptEntry);
    });
  }

  #resolvePrompt(promptId, response) {
    const pendingPrompt = this.#prompts[0];
    if (!pendingPrompt || pendingPrompt.descriptor.id !== promptId) {
      return false;
    }

    let normalizedResponse = response;
    if (pendingPrompt.delegateType === "permission") {
      if (!PROMPT_DECISIONS.has(response)) {
        throw new TypeError(`Unsupported permission decision: ${response}`);
      }
    } else if (pendingPrompt.delegateType === "webAuthn") {
      normalizedResponse = normalizeWebAuthnResponse(
        response,
        pendingPrompt.descriptor
      );
      if (!normalizedResponse) {
        throw new TypeError("Unsupported WebAuthnDelegate response");
      }
    } else {
      normalizedResponse = normalizePromptResponse(
        response,
        pendingPrompt.descriptor
      );
      if (!normalizedResponse) {
        throw new TypeError("Unsupported PromptDelegate response");
      }
    }

    this.#prompts.shift();
    try {
      pendingPrompt.respond(normalizedResponse);
    } catch (error) {
      console.error("Desktop embedder could not answer a prompt", error);
      pendingPrompt.cancel();
    }
    this.#showNextPrompt();
    return true;
  }

  #clearCredentialState() {
    this.#credentialActor = null;
    if (
      this.#state.credentials.origin !== null ||
      this.#state.credentials.items.length
    ) {
      this.#patchState({ credentials: { origin: null, items: [] } });
    }
  }

  [ATTACH_VIEW](view) {
    if (this.#closed) {
      throw new Error("A closed EngineSession cannot be attached");
    }
    if (this.#view === view) {
      return;
    }
    if (this.#view) {
      throw new Error(
        "EngineSession is already attached; detach its current View first"
      );
    }

    const transition = this.#runtime[PREPARE_ATTACH_VIEW](this, view);
    view[CLAIM_VIEW](this);
    if (!this.#browser) {
      try {
        this.#runtime[COMMIT_ATTACH_VIEW](this, transition);
        this.#view = view;
        view[SET_VIEW_STATE]({
          active: this.#active,
          crashed: this.#state.crashed,
        });
      } catch (error) {
        this.#view = null;
        view[RELEASE_VIEW](this);
        throw error;
      }
      return;
    }

    let destinationBrowser;
    try {
      destinationBrowser = view[CREATE_VIEW_BROWSER](
        this.#browserTransferOptions()
      );
      const parkingBrowser = this.#swapBrowser(destinationBrowser);
      this.#view = view;
      this.#runtime[COMMIT_ATTACH_VIEW](this, transition);
      view[SET_VIEW_STATE]({
        active: this.#active,
        crashed: this.#state.crashed,
      });
      this.#runtime[DESTROY_PARKING_BROWSER](parkingBrowser);
    } catch (error) {
      if (this.#view !== view) {
        view[DESTROY_VIEW_BROWSER]();
        view[RELEASE_VIEW](this);
      }
      throw error;
    }
  }

  [DETACH_VIEW](view) {
    if (this.#closed) {
      throw new Error("A closed EngineSession cannot be detached");
    }
    if (this.#view !== view) {
      throw new Error("EngineView is not attached to this EngineSession");
    }
    if (!this.#browser) {
      this.#runtime[COMMIT_DETACH_VIEW](this, view);
      this.#view = null;
      view[RELEASE_VIEW](this);
      return;
    }

    let parkingBrowser;
    try {
      parkingBrowser = this.#runtime[CREATE_PARKING_BROWSER](
        this,
        this.#browserTransferOptions()
      );
      this.#swapBrowser(parkingBrowser);
    } catch (error) {
      this.#runtime[DESTROY_PARKING_BROWSER](parkingBrowser);
      view[SET_VIEW_STATE]({
        active: this.#active,
        crashed: this.#state.crashed,
      });
      throw error;
    }

    parkingBrowser.hidden = false;
    parkingBrowser.docShellIsActive = false;
    parkingBrowser.removeAttribute("primary");
    this.#runtime[COMMIT_DETACH_VIEW](this, view);
    view[DESTROY_VIEW_BROWSER]();
    this.#view = null;
    view[RELEASE_VIEW](this);
  }

  [SET_SESSION_ACTIVE](active) {
    this.#active = active;
    this.#view?.[SET_VIEW_STATE]({ active, crashed: this.#state.crashed });
  }

  [GET_CORE_SESSION_ID]() {
    return this.#coreId;
  }

  [GET_BROWSER]() {
    return this.#browser;
  }

  [CREATE_BROWSER]({
    openWindowInfo = null,
    userContextId = 0,
    name: browserName = "",
    skipLoad = false,
    remoteType = "web",
    initialBrowsingContextGroupId = null,
  } = {}) {
    if (this.#browser) {
      return this.#browser;
    }

    const browserOptions = {
      openWindowInfo,
      userContextId,
      name: browserName,
      skipLoad,
      remoteType,
      initialBrowsingContextGroupId,
    };
    const browser = this.#view
      ? this.#view[CREATE_VIEW_BROWSER](browserOptions)
      : this.#runtime[CREATE_PARKING_BROWSER](this, browserOptions);
    if (
      Boolean(browser.browsingContext?.usePrivateBrowsing) !==
      this.#state.private
    ) {
      if (this.#view) {
        this.#view[DESTROY_VIEW_BROWSER]();
      } else {
        this.#runtime[DESTROY_PARKING_BROWSER](browser);
      }
      throw new Error("Gecko created a browser with the wrong private mode");
    }

    this.#progressListener = {
      onLocationChange: (webProgress, request, newLocation, flags) => {
        const rootProgress = isRootProgress(webProgress, this.#browser);
        if (newLocation && rootProgress) {
          DesktopExtensionTabs.notifyLocation(
            this.#browser,
            webProgress,
            request,
            newLocation,
            flags
          );
        }
        if (!rootProgress || !newLocation) {
          return;
        }
        const navigationId = this.#navigationForRequest(request);
        if (navigationId !== this.#state.navigationId) {
          this.#runtime[UPDATE_CORE_NAVIGATION](
            this,
            "setNavigationLocation",
            navigationId,
            newLocation.spec
          );
          return;
        }
        this.#cancelAllPrompts("navigation");
        let changed = this.#runtime[UPDATE_CORE_NAVIGATION](
          this,
          "setNavigationLocation",
          navigationId,
          newLocation.spec
        );
        changed = this.#writeNavigationTitle(navigationId) || changed;
        changed = this.#writeNavigationHistory(navigationId) || changed;
        changed = this.#writeNavigationIdentity(navigationId) || changed;
        if (changed) {
          this.#syncNavigationState();
        }
      },

      onSecurityChange: (webProgress, request, state) => {
        if (!isRootProgress(webProgress, this.#browser)) {
          return;
        }
        const navigationId = this.#navigationForRequest(request);
        let security = 1;
        if (state & Ci.nsIWebProgressListener.STATE_IS_SECURE) {
          security = 3;
        } else if (state & Ci.nsIWebProgressListener.STATE_IS_BROKEN) {
          security = 2;
        }
        let changed = this.#runtime[UPDATE_CORE_NAVIGATION](
          this,
          "setNavigationSecurity",
          navigationId,
          security
        );
        changed = this.#writeNavigationIdentity(navigationId) || changed;
        if (changed) {
          this.#syncNavigationState();
        }
      },

      onStateChange: (webProgress, request, state, status) => {
        const rootProgress = isRootProgress(webProgress, this.#browser);
        if (rootProgress) {
          DesktopExtensionTabs.notifyState(
            this.#browser,
            webProgress,
            request,
            state,
            status
          );
        }
        if (
          !rootProgress ||
          !(state & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
        ) {
          return;
        }
        if (state & Ci.nsIWebProgressListener.STATE_START) {
          let navigationId =
            request && typeof request === "object"
              ? this.#requestNavigations.get(request)
              : undefined;
          if (navigationId === undefined) {
            let requestedUrl = null;
            let startKind = CORE_NAVIGATION_START_KINDS.standard;
            try {
              const requestedURI = request.QueryInterface(Ci.nsIChannel).URI;
              requestedUrl = requestedURI.spec;
              // Classify only an exact route from the registered Navis
              // protocol. Trust identity is authenticated later from the
              // committed document and principal.
              if (resolveNavisInternalPageURI(requestedURI)) {
                startKind = CORE_NAVIGATION_START_KINDS.internalPage;
              }
            } catch {}
            navigationId = this.#runtime[UPDATE_CORE_NAVIGATION](
              this,
              "observeNavigationStart",
              requestedUrl ?? "",
              requestedUrl !== null,
              startKind
            );
            if (request && typeof request === "object") {
              this.#requestNavigations.set(request, navigationId);
            }
            this.#syncNavigationState(
              navigationId !== this.#state.navigationId ? { favicon: "" } : null
            );
          }
        }
        if (state & Ci.nsIWebProgressListener.STATE_STOP) {
          const navigationId = this.#navigationForRequest(request);
          let changed = this.#writeNavigationTitle(navigationId);
          changed = this.#writeNavigationHistory(navigationId) || changed;
          changed = this.#writeNavigationIdentity(navigationId) || changed;
          const failureCode =
            status && !Components.isSuccessCode(status) ? status >>> 0 : 0;
          changed =
            this.#runtime[UPDATE_CORE_NAVIGATION](
              this,
              "finishNavigation",
              navigationId,
              Boolean(failureCode),
              failureCode
            ) || changed;
          if (changed) {
            this.#syncNavigationState();
          }
        }
      },

      onProgressChange() {},
      onStatusChange() {},
      onContentBlockingEvent() {},

      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };

    this.#titleListener = () => {
      this.#updateTitle();
      this.#runtime[RECORD_HISTORY_TITLE](this);
      DesktopExtensionTabs.notifyTitle(this.#browser);
    };
    this.#crashListener = event => {
      if (!event.isTopFrame) {
        return;
      }
      this.#dismissContextMenu("crash");
      this.#cancelAllPrompts("crash");
      this.#clearCredentialState();
      this.#runtime[SET_SESSION_CRASHED](this, true);
      this.#view?.[SET_VIEW_STATE]({ active: this.#active, crashed: true });
      this.#syncNavigationState({
        crashed: true,
        fullscreen: false,
        media: { camera: false, microphone: false, screen: false },
      });
      const detail = Object.freeze({
        sessionId: this.id,
        browsingContextId: event.browsingContextId,
        childId: event.childID,
      });
      callDelegate(this.#crashDelegate, "CrashDelegate", "onCrash", detail);
    };

    this.#browser = browser;
    this.#bindBrowser(browser);
    DesktopExtensionTabs.registerSession(this, this.#runtime, browser);
    return browser;
  }

  [LOAD_GECKO_URI](
    uri,
    {
      triggeringPrincipal = null,
      referrerInfo = null,
      policyContainer = null,
      external: isExternal = false,
      allowInheritPrincipal = true,
      navigationCommand = "load",
    } = {}
  ) {
    this.#assertOpen();
    if (this.#state.crashed) {
      this.#replaceBrowser();
    }
    this.#cancelAllPrompts("navigation");
    this.#clearCredentialState();
    let loadFlags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
    if (isExternal) {
      loadFlags |= Ci.nsIWebNavigation.LOAD_FLAGS_FROM_EXTERNAL;
    } else if (triggeringPrincipal && !triggeringPrincipal.isSystemPrincipal) {
      loadFlags |= Ci.nsIWebNavigation.LOAD_FLAGS_FIRST_LOAD;
    }
    if (!allowInheritPrincipal) {
      loadFlags |= Ci.nsIWebNavigation.LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL;
    }
    this.#performCoreNavigation(
      navigationCommand,
      navigationCommand === "load" ? uri.spec : null,
      () => {
        this.#browser.loadURI(uri, {
          triggeringPrincipal:
            triggeringPrincipal ||
            Services.scriptSecurityManager.getSystemPrincipal(),
          referrerInfo,
          policyContainer,
          loadFlags,
        });
      }
    );
  }

  #performCoreNavigation(command, requestedUrl, operation) {
    const navigationId = this.#runtime[BEGIN_CORE_NAVIGATION](
      this,
      command,
      requestedUrl
    );
    this.#syncNavigationState({ crashed: false, favicon: "" });
    try {
      operation();
    } catch (error) {
      const failureCode =
        typeof error?.result === "number"
          ? error.result >>> 0
          : Cr.NS_ERROR_FAILURE >>> 0;
      this.#runtime[UPDATE_CORE_NAVIGATION](
        this,
        "finishNavigation",
        navigationId,
        true,
        failureCode
      );
      this.#syncNavigationState();
      throw error;
    }
    return true;
  }

  #syncNavigationState(extraPatch = null) {
    const navigation = this.#runtime[GET_CORE_NAVIGATION_STATE](this);
    if (
      this.#contextMenuRequest &&
      this.#contextMenuRequest.navigationId !== navigation.navigationId
    ) {
      this.#dismissContextMenu("navigation");
    }
    this.#patchState({
      navigationRevision: navigation.revision,
      navigationId: navigation.navigationId,
      url: navigation.url,
      title: navigation.title || DEFAULT_TITLE,
      loading: navigation.loading,
      loadingActivity: navigation.loadingActivity,
      security: navigation.security,
      identity: navigation.identity,
      identityKey: navigation.identityKey,
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward,
      failureCode: navigation.failureCode,
      ...(extraPatch || {}),
    });
  }

  #assertOpen() {
    if (this.#closed || !this.#browser) {
      throw new Error("EngineSession is not open");
    }
  }

  #browserTransferOptions() {
    let remoteType = "web";
    try {
      remoteType =
        this.#browser.remoteType ||
        this.#browser.getAttribute("remoteType") ||
        remoteType;
    } catch {}
    return {
      userContextId:
        Number.parseInt(
          this.#browser.getAttribute("usercontextid") || "0",
          10
        ) || 0,
      name: this.#browser.getAttribute("name") || "",
      skipLoad: false,
      remoteType,
    };
  }

  #handleInternalPageCommand(actor, data) {
    this.#assertOpen();
    const actorContextId = actor?.manager?.browsingContext?.id;
    if (
      !Number.isSafeInteger(actorContextId) ||
      actorContextId !== this.#browser.browsingContext?.id
    ) {
      throw new Error("The internal-page actor does not own this Session");
    }
    const page = authenticatedInternalPage(this.#browser);
    if (!page || data?.pageKey !== page.key) {
      throw new Error("The current document is not the requested Navis route");
    }
    const request = Object.freeze({
      pageKey: typeof data.pageKey === "string" ? data.pageKey : "",
      command: typeof data.command === "string" ? data.command : "",
      value: data.value,
    });
    if (
      request.command === "diagnostics:get" &&
      (page.key === "support" || page.key === "settings/help")
    ) {
      return freezeSupportDiagnosticsState(
        page.key,
        this.#browser,
        this.#runtime
      );
    }
    return this.#runtime[HANDLE_INTERNAL_PAGE_COMMAND](this, page, request);
  }

  #handleContentInteraction(actor, data) {
    if (
      this.#closed ||
      !this.#active ||
      actor?.manager?.rootFrameLoader?.ownerElement !== this.#browser
    ) {
      return false;
    }
    const kind = data?.kind === "pointer" ? "pointer" : "unknown";
    callDelegate(
      this.#contentDelegate,
      "ContentDelegate",
      "onInteraction",
      Object.freeze({ sessionId: this.id, kind })
    );
    return true;
  }

  #handleFaviconChanged(actor, data) {
    if (
      this.#closed ||
      !actor?.manager?.isCurrentGlobal ||
      actor.manager.rootFrameLoader?.ownerElement !== this.#browser ||
      typeof data?.pageURL !== "string" ||
      typeof data?.iconURL !== "string" ||
      data.pageURL !== this.#browser.currentURI?.spec ||
      data.iconURL.length > 786432 ||
      !/^data:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|vnd\.microsoft\.icon|webp|x-icon)[;,]/iu.test(
        data.iconURL
      )
    ) {
      return false;
    }
    this.#patchState({ favicon: data.iconURL });
    DesktopExtensionTabs.notifyFavicon(this.#browser);
    return true;
  }

  #handleContextMenu(actor, data) {
    const token = Number(data?.token);
    if (
      this.#closed ||
      this.#state.crashed ||
      !this.#active ||
      !Number.isSafeInteger(token) ||
      token <= 0 ||
      !actor ||
      typeof actor.execute !== "function" ||
      typeof actor.dismiss !== "function"
    ) {
      actor?.dismiss?.(token);
      return;
    }
    this.#dismissContextMenu("replaced");
    if (!this.#contextMenuDelegate) {
      actor.dismiss(token);
      return;
    }

    const browserRect = this.#browser.getBoundingClientRect();
    const menuContext = Object.freeze({
      editable: Boolean(data.context?.editable),
      password: Boolean(data.context?.password),
      hasSelection: Boolean(data.context?.hasSelection),
      link: Boolean(data.context?.link),
      image: Boolean(data.context?.image),
      media: ["audio", "video"].includes(data.context?.media)
        ? data.context.media
        : null,
      pageUrl: boundedContextMenuText(this.#browser.currentURI?.spec),
      linkUrl: boundedContextMenuText(data.linkUrl),
      linkText: boundedContextMenuText(data.linkText, 512),
      imageUrl: boundedContextMenuText(data.imageUrl),
      mediaUrl: boundedContextMenuText(data.mediaUrl),
      selectedText: boundedContextMenuText(data.selectedText, 512),
    });
    const nativeTab = DesktopExtensionTabs.getForBrowser(this.#browser);
    const extensionMenu =
      nativeTab && /^https?:/iu.test(menuContext.pageUrl)
        ? DesktopExtensionMenus.open(nativeTab, menuContext)
        : Object.freeze({ requestId: null, items: Object.freeze([]) });
    const items = Object.freeze([
      ...projectContextMenuItems(data, this.#state),
      ...extensionMenu.items,
    ]);
    const descriptor = Object.freeze({
      id: `context-menu-${this.id}-${nextContextMenuRequestId++}`,
      sessionId: this.id,
      position: Object.freeze({
        x: contextMenuCoordinate(data.x, browserRect.left + 16),
        y: contextMenuCoordinate(data.y, browserRect.top + 16),
      }),
      context: Object.freeze({
        editable: menuContext.editable,
        password: menuContext.password,
        hasSelection: menuContext.hasSelection,
        misspelled: Boolean(data.context?.misspelled),
        link: menuContext.link,
        image: menuContext.image,
        media: menuContext.media,
      }),
      linkUrl: menuContext.linkUrl,
      linkText: menuContext.linkText,
      imageUrl: menuContext.imageUrl,
      mediaUrl: menuContext.mediaUrl,
      selectedText: menuContext.selectedText,
      items,
    });
    this.#contextMenuRequest = {
      actor,
      token,
      navigationId: this.#state.navigationId,
      extensionMenuRequestId: extensionMenu.requestId,
      descriptor,
      items: indexContextMenuItems(items),
    };
    const result = callDelegate(
      this.#contextMenuDelegate,
      "ContextMenuDelegate",
      "onShow",
      descriptor
    );
    if (result === false) {
      this.#dismissContextMenu("rejected");
    }
  }

  #dismissContextMenu(reason) {
    const request = this.#contextMenuRequest;
    if (!request) {
      return false;
    }
    this.#contextMenuRequest = null;
    try {
      request.actor.dismiss(request.token);
    } catch {}
    DesktopExtensionMenus.dismiss(request.extensionMenuRequestId);
    this.#notifyContextMenuDismissed(request.descriptor, reason);
    return true;
  }

  #notifyContextMenuDismissed(descriptor, reason) {
    callDelegate(
      this.#contextMenuDelegate,
      "ContextMenuDelegate",
      "onDismissed",
      Object.freeze({ id: descriptor.id, sessionId: this.id, reason })
    );
  }

  #bindBrowser(browser) {
    browserPrivateModes.set(String(browser.browserId), this.#state.private);
    browser.desktopEmbedderContentPermissionPrompt = request => {
      this.#handleContentPermission(request);
    };
    browser.desktopEmbedderWebRTCPermissionPrompt = (
      request,
      respond,
      principal
    ) => {
      this.#handleMediaPermission(request, respond, principal);
    };
    browser.desktopEmbedderCancelWebRTCPermissionPrompt = callID => {
      this.#cancelMediaPrompt(callID);
    };
    browser.desktopEmbedderPrompt = (args, abortSignal) =>
      this.#handlePrompt(args, abortSignal);
    browser.desktopEmbedderWebAuthnPrompt = event =>
      this.#handleWebAuthnPrompt(event);
    browser.desktopEmbedderWebAuthnPromptActive = () =>
      this.#prompts.some(entry => entry.delegateType === "webAuthn");
    browser.desktopEmbedderWebAuthnRelatedOriginPrompt = event =>
      this.#handleRelatedOriginWebAuthnPrompt(event);
    browser.desktopEmbedderWebAuthnRelatedOriginPromptCanceled = event =>
      this.#cancelNativeRelatedOriginWebAuthnPrompt(event);
    browser.desktopEmbedderWebAuthnConditionalPrompt = event =>
      this.#handleConditionalWebAuthnPrompt(event);
    browser.desktopEmbedderWebAuthnConditionalPromptCanceled = event =>
      this.#cancelNativeConditionalWebAuthnPrompt(event);
    browser.desktopEmbedderCredentialQuery = (actor, request) =>
      this.#runtime[QUERY_CREDENTIALS](this, actor, request);
    browser.desktopEmbedderCredentialSubmit = (actor, request) =>
      this.#runtime[SUBMIT_CREDENTIAL](this, actor, request);
    browser.desktopEmbedderCredentialActorDestroyed = actor =>
      this[CREDENTIAL_ACTOR_DESTROYED](actor);
    browser.desktopEmbedderMediaStateChanged = media => {
      this.#patchState({
        media: {
          camera: Boolean(media.camera),
          microphone: Boolean(media.microphone),
          screen: Boolean(media.screen),
        },
      });
    };
    browser.desktopEmbedderFullscreenStateChanged = fullscreen => {
      this.#patchState({ fullscreen: Boolean(fullscreen) });
    };
    browser.desktopEmbedderFaviconChanged = (actor, data) => {
      this.#handleFaviconChanged(actor, data);
    };
    browser.desktopEmbedderContextMenu = (actor, data) => {
      this.#handleContextMenu(actor, data);
    };
    browser.desktopEmbedderContentInteraction = (actor, data) => {
      this.#handleContentInteraction(actor, data);
    };
    browser.desktopEmbedderInternalPageCommand = (actor, data) =>
      this.#handleInternalPageCommand(actor, data);
    browser.addProgressListener(this.#progressListener, PROGRESS_FLAGS);
    browser.addEventListener("pagetitlechanged", this.#titleListener);
    browser.addEventListener("oop-browser-crashed", this.#crashListener);
  }

  #unbindBrowser(browser) {
    browserPrivateModes.delete(String(browser.browserId));
    try {
      browser.removeProgressListener(this.#progressListener);
    } catch {}
    browser.removeEventListener("pagetitlechanged", this.#titleListener);
    browser.removeEventListener("oop-browser-crashed", this.#crashListener);
    browser.desktopEmbedderContentPermissionPrompt = null;
    browser.desktopEmbedderWebRTCPermissionPrompt = null;
    browser.desktopEmbedderCancelWebRTCPermissionPrompt = null;
    browser.desktopEmbedderPrompt = null;
    browser.desktopEmbedderWebAuthnPrompt = null;
    browser.desktopEmbedderWebAuthnPromptActive = null;
    browser.desktopEmbedderWebAuthnRelatedOriginPrompt = null;
    browser.desktopEmbedderWebAuthnRelatedOriginPromptCanceled = null;
    browser.desktopEmbedderWebAuthnConditionalPrompt = null;
    browser.desktopEmbedderWebAuthnConditionalPromptCanceled = null;
    browser.desktopEmbedderCredentialQuery = null;
    browser.desktopEmbedderCredentialSubmit = null;
    browser.desktopEmbedderCredentialActorDestroyed = null;
    browser.desktopEmbedderMediaStateChanged = null;
    browser.desktopEmbedderFullscreenStateChanged = null;
    browser.desktopEmbedderFaviconChanged = null;
    browser.desktopEmbedderContextMenu = null;
    browser.desktopEmbedderContentInteraction = null;
    browser.desktopEmbedderInternalPageCommand = null;
  }

  #swapBrowser(destinationBrowser) {
    const sourceBrowser = this.#browser;
    if (
      !sourceBrowser ||
      sourceBrowser === destinationBrowser ||
      !sourceBrowser.isConnected ||
      !destinationBrowser?.isConnected
    ) {
      throw new Error("Both browser hosts must be connected before attachment");
    }

    const sourceContextId = sourceBrowser.browsingContext?.id;
    const destinationContextId = destinationBrowser.browsingContext?.id;
    if (!sourceContextId || !destinationContextId) {
      throw new Error("Both browser hosts must have live browsing contexts");
    }

    const sourceWasHidden = sourceBrowser.hidden;
    const destinationWasHidden = destinationBrowser.hidden;
    const sourcePermanentKey = sourceBrowser.permanentKey;
    const destinationPermanentKey = destinationBrowser.permanentKey;
    this.#dismissContextMenu("view-changed");
    this.#unbindBrowser(sourceBrowser);
    sourceBrowser.hidden = false;
    destinationBrowser.hidden = false;

    try {
      sourceBrowser.ownerDocument.documentElement.getBoundingClientRect();
      destinationBrowser.ownerDocument.documentElement.getBoundingClientRect();
      destinationBrowser.swapDocShells(sourceBrowser);
      if (
        destinationBrowser.browsingContext?.id !== sourceContextId ||
        sourceBrowser.browsingContext?.id !== destinationContextId
      ) {
        // browser.swapDocShells() hides native swap errors. A second call
        // restores its JavaScript-side fields when the native swap failed.
        destinationBrowser.swapDocShells(sourceBrowser);
        throw new Error(
          "Gecko rejected the browser transfer; check host principal and origin attributes"
        );
      }
    } catch (error) {
      sourceBrowser.hidden = sourceWasHidden;
      destinationBrowser.hidden = destinationWasHidden;
      this.#browser = sourceBrowser;
      this.#bindBrowser(sourceBrowser);
      throw error;
    }

    destinationBrowser.permanentKey = sourcePermanentKey;
    sourceBrowser.permanentKey = destinationPermanentKey;
    this.#browser = destinationBrowser;
    this.#bindBrowser(destinationBrowser);
    DesktopExtensionTabs.registerSession(
      this,
      this.#runtime,
      destinationBrowser
    );
    return sourceBrowser;
  }

  #destroyBrowser() {
    if (!this.#browser) {
      return;
    }
    const browser = this.#browser;
    this.#dismissContextMenu("browser-destroyed");
    this.#unbindBrowser(browser);
    if (this.#view?.[GET_BROWSER]() === browser) {
      this.#view[DESTROY_VIEW_BROWSER]();
    } else {
      this.#runtime[DESTROY_PARKING_BROWSER](browser);
    }
    this.#browser = null;
    this.#progressListener = null;
    this.#titleListener = null;
    this.#crashListener = null;
  }

  #replaceBrowser() {
    const browserOptions = this.#browserTransferOptions();
    this.#destroyBrowser();
    this.#view?.[SET_VIEW_STATE]({ active: this.#active, crashed: false });
    // restore() immediately submits the crashed Session's explicit load.
    // Keep the replacement browser from inserting an unrelated about:blank
    // navigation between the Core restore command and that load.
    this[CREATE_BROWSER]({ ...browserOptions, skipLoad: true });
  }

  #handleContentPermission(request) {
    let type;
    try {
      const types = request.types.QueryInterface(Ci.nsIArray);
      if (types.length !== 1) {
        request.cancel();
        return;
      }
      type = types.queryElementAt(0, Ci.nsIContentPermissionType).type;
    } catch (error) {
      console.error(
        "Desktop embedder rejected an invalid permission request",
        error
      );
      request.cancel();
      return;
    }

    const permission = CONTENT_PERMISSIONS.get(type);
    if (!permission) {
      console.warn(`Desktop embedder denied unsupported permission: ${type}`);
      request.cancel();
      return;
    }

    let principal;
    try {
      principal = request.getDelegatePrincipal(permission.key);
    } catch {
      principal = request.principal;
    }
    if (!principal) {
      request.cancel();
      return;
    }

    const existing = Services.perms.testPermissionFromPrincipal(
      principal,
      permission.key
    );
    if (existing === Services.perms.DENY_ACTION) {
      request.cancel();
      return;
    }
    if (
      existing === Services.perms.ALLOW_ACTION &&
      !request.isRequestDelegatedToUnsafeThirdParty &&
      !request.ignoreAllowSitePermission
    ) {
      request.allow();
      return;
    }

    const descriptor = Object.freeze({
      id: `prompt-${nextPromptId++}`,
      category: "permission",
      kind: type,
      permissions: Object.freeze([permission.label]),
      origin: principalOrigin(principal),
      frameOrigin: principalOrigin(request.principal),
      userGesture: request.hasValidTransientUserGestureActivation,
    });

    this.#enqueuePrompt({
      descriptor,
      delegateType: "permission",
      notifyShown:
        typeof request.notifyShown === "function"
          ? () => request.notifyShown()
          : null,
      respond: decision => {
        if (decision === "allow-session" || decision === "allow-always") {
          Services.perms.addFromPrincipal(
            principal,
            permission.key,
            Services.perms.ALLOW_ACTION,
            decision === "allow-always"
              ? Services.perms.EXPIRE_NEVER
              : Services.perms.EXPIRE_SESSION
          );
          request.allow();
        } else {
          if (decision === "block") {
            Services.perms.addFromPrincipal(
              principal,
              permission.key,
              Services.perms.DENY_ACTION,
              Services.perms.EXPIRE_NEVER
            );
          }
          request.cancel();
        }
      },
      cancel: () => request.cancel(),
    });
  }

  #handleWebAuthnPrompt(event) {
    if (event.type === "cancel") {
      this.#cancelNativeWebAuthnPrompt(event.tid);
      return;
    }
    if (
      this.#closed ||
      this.#state.crashed ||
      event.browsingContextId !== this.#browser?.browsingContext?.id
    ) {
      this.#cancelWebAuthnTransaction(event.tid);
      return;
    }

    const descriptor = projectWebAuthnDescriptor(this.id, event, this.#browser);
    if (!descriptor) {
      this.#cancelWebAuthnTransaction(event.tid);
      return;
    }

    this.#exitContentFullscreenForWebAuthn();
    const promptEntry = {
      descriptor,
      delegateType: "webAuthn",
      nativeId: event.tid,
      notifyShown: null,
      respond: response => {
        this.#respondToWebAuthn(event.tid, response);
      },
      cancel: () => this.#cancelWebAuthnTransaction(event.tid),
    };
    const existingIndex = this.#prompts.findIndex(
      entry => entry.delegateType === "webAuthn"
    );
    if (existingIndex === -1) {
      this.#enqueuePrompt(promptEntry);
      return;
    }

    const previous = this.#prompts[existingIndex];
    this.#prompts[existingIndex] = promptEntry;
    if (previous.nativeId !== event.tid) {
      previous.cancel();
    }
    if (previous.delegateRequested) {
      this.#notifyPromptCanceled(previous, "updated");
    }
    if (existingIndex === 0) {
      this.#showNextPrompt();
    }
  }

  #handleRelatedOriginWebAuthnPrompt(event) {
    const descriptor = projectRelatedOriginWebAuthnDescriptor(
      this.id,
      event,
      this.#browser
    );
    if (this.#closed || this.#state.crashed || !descriptor) {
      return Promise.resolve(false);
    }

    this.#exitContentFullscreenForWebAuthn();
    return new Promise(resolve => {
      let settled = false;
      const finish = allow => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(allow);
      };
      this.#enqueuePrompt({
        descriptor,
        delegateType: "webAuthn",
        nativeId: event,
        notifyShown: null,
        respond: response => finish(response.action === "continue"),
        cancel: () => finish(false),
      });
    });
  }

  #handleConditionalWebAuthnPrompt(event) {
    const descriptor = projectConditionalWebAuthnDescriptor(
      this.id,
      event,
      this.#browser
    );
    if (this.#closed || this.#state.crashed || !descriptor) {
      return Promise.resolve(Object.freeze({ action: "cancel" }));
    }
    if (this.#prompts.some(entry => entry.delegateType === "webAuthn")) {
      // A modal WebAuthn transaction has priority. Keep the conditional get
      // pending so a later field focus can offer it without disturbing either
      // transaction.
      return Promise.resolve(null);
    }

    this.#exitContentFullscreenForWebAuthn();
    return new Promise(resolve => {
      let settled = false;
      const finish = response => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(response);
      };
      this.#enqueuePrompt({
        descriptor,
        delegateType: "webAuthn",
        nativeId: event,
        notifyShown: null,
        respond: response => finish(response),
        cancel: () => finish(Object.freeze({ action: "cancel" })),
        nativeCancel: () => finish(null),
      });
    });
  }

  #respondToWebAuthn(tid, response) {
    forgetDesktopWebAuthnPrompt(tid);
    let service;
    try {
      service = Cc["@mozilla.org/webauthn/service;1"].getService(
        Ci.nsIWebAuthnService
      );
      switch (response.action) {
        case "allow-identifying-attestation":
          service.setHasAttestationConsent(tid, true);
          return;
        case "continue-anonymized":
          service.setHasAttestationConsent(tid, false);
          return;
        case "submit":
          service.pinCallback(tid, response.pin);
          return;
        case "select":
          service.selectionCallback(tid, response.selected);
          return;
        case "cancel":
          service.cancel(tid);
          return;
      }
      service.cancel(tid);
    } catch (error) {
      console.error("Desktop WebAuthn response failed", error);
      try {
        service?.cancel(tid);
      } catch {}
    }
  }

  #cancelWebAuthnTransaction(tid) {
    forgetDesktopWebAuthnPrompt(tid);
    try {
      Cc["@mozilla.org/webauthn/service;1"]
        .getService(Ci.nsIWebAuthnService)
        .cancel(tid);
    } catch (error) {
      console.error("Desktop WebAuthn cancellation failed", error);
    }
  }

  #cancelNativeWebAuthnPrompt(tid) {
    const index = this.#prompts.findIndex(
      entry => entry.delegateType === "webAuthn" && entry.nativeId === tid
    );
    if (index === -1) {
      return;
    }
    const [promptEntry] = this.#prompts.splice(index, 1);
    forgetDesktopWebAuthnPrompt(tid);
    if (promptEntry.delegateRequested) {
      this.#notifyPromptCanceled(promptEntry, "native-canceled");
    }
    if (index === 0) {
      this.#showNextPrompt();
    }
  }

  #cancelNativeRelatedOriginWebAuthnPrompt(event) {
    const index = this.#prompts.findIndex(
      entry => entry.delegateType === "webAuthn" && entry.nativeId === event
    );
    if (index === -1) {
      return;
    }
    const [promptEntry] = this.#prompts.splice(index, 1);
    try {
      promptEntry.cancel();
    } catch {}
    if (promptEntry.delegateRequested) {
      this.#notifyPromptCanceled(promptEntry, "native-canceled");
    }
    if (index === 0) {
      this.#showNextPrompt();
    }
  }

  #cancelNativeConditionalWebAuthnPrompt(event) {
    const index = this.#prompts.findIndex(
      entry => entry.delegateType === "webAuthn" && entry.nativeId === event
    );
    if (index === -1) {
      return;
    }
    const [promptEntry] = this.#prompts.splice(index, 1);
    try {
      promptEntry.nativeCancel();
    } catch {}
    if (promptEntry.delegateRequested) {
      this.#notifyPromptCanceled(promptEntry, "native-canceled");
    }
    if (index === 0) {
      this.#showNextPrompt();
    }
  }

  #cancelWebAuthnPrompts(reason) {
    const head = this.#prompts[0];
    const retained = [];
    for (const promptEntry of this.#prompts) {
      if (promptEntry.delegateType !== "webAuthn") {
        retained.push(promptEntry);
        continue;
      }
      try {
        promptEntry.cancel();
      } catch {}
      if (promptEntry.delegateRequested) {
        this.#notifyPromptCanceled(promptEntry, reason);
      }
    }
    this.#prompts = retained;
    if (head?.delegateType === "webAuthn") {
      this.#showNextPrompt();
    }
  }

  #exitContentFullscreenForWebAuthn() {
    try {
      this.#browser?.documentGlobal?.browsingContext?.fullscreenRequestOrigin
        ?.get()
        ?.exitFullscreen();
    } catch {}
  }

  #handleMediaPermission(request, respond, principal) {
    const permissionKeys = request.requestTypes.map(type =>
      MEDIA_PERMISSION_KEYS.get(type)
    );
    if (
      !request.secure ||
      !permissionKeys.length ||
      permissionKeys.some(key => !key)
    ) {
      respond({ allow: false });
      return;
    }

    const existing = permissionKeys.map(key =>
      Services.perms.testPermissionFromPrincipal(principal, key)
    );
    if (existing.includes(Services.perms.DENY_ACTION)) {
      respond({ allow: false });
      return;
    }

    const devices = this.#selectMediaDevices(request);
    if (!devices.length) {
      respond({ allow: false });
      return;
    }
    if (existing.every(action => action === Services.perms.ALLOW_ACTION)) {
      this.#addMediaManagerVideoPermission(request, principal);
      respond({ allow: true, devices });
      return;
    }

    const descriptor = Object.freeze({
      id: `prompt-${nextPromptId++}`,
      category: "media",
      kind: "camera-microphone",
      permissions: Object.freeze(permissionKeys),
      origin: request.origin,
      frameOrigin: request.frameOrigin,
      userGesture: request.isHandlingUserInput,
      devices: Object.freeze({
        camera: Object.freeze(
          request.videoInputDevices.map(device => device.name)
        ),
        microphone: Object.freeze(
          request.audioInputDevices.map(device => device.name)
        ),
      }),
    });

    this.#enqueuePrompt({
      descriptor,
      delegateType: "permission",
      nativeId: request.callID,
      notifyShown: null,
      respond: decision => {
        if (decision === "allow-session" || decision === "allow-always") {
          for (const key of permissionKeys) {
            Services.perms.addFromPrincipal(
              principal,
              key,
              Services.perms.ALLOW_ACTION,
              decision === "allow-always"
                ? Services.perms.EXPIRE_NEVER
                : Services.perms.EXPIRE_SESSION
            );
          }
          this.#addMediaManagerVideoPermission(request, principal);
          respond({ allow: true, devices });
        } else {
          if (decision === "block") {
            for (const key of permissionKeys) {
              Services.perms.addFromPrincipal(
                principal,
                key,
                Services.perms.DENY_ACTION,
                Services.perms.EXPIRE_NEVER
              );
            }
          }
          respond({ allow: false });
        }
      },
      cancel: () => respond({ allow: false }),
    });
  }

  #handlePrompt(args, abortSignal) {
    const descriptor = projectPromptDescriptor(this.id, args, this.#browser);
    return new Promise(resolve => {
      let settled = false;
      let promptEntry;
      const complete = result => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        this.#cancelQueuedPrompt(promptEntry, "actor-destroyed");
      };
      promptEntry = {
        descriptor,
        delegateType: "prompt",
        notifyShown: null,
        respond: response => {
          complete(promptResult(args, descriptor, response));
        },
        cancel: () => {
          complete(
            promptResult(args, descriptor, defaultPromptResponse(descriptor), {
              aborted: true,
            })
          );
        },
      };

      if (abortSignal?.aborted) {
        promptEntry.cancel();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.#enqueuePrompt(promptEntry);
    });
  }

  #selectMediaDevices(request) {
    const devices = [];
    if (request.requestTypes.includes("Camera")) {
      const camera = request.videoInputDevices[0];
      if (!camera) {
        return [];
      }
      devices.push(camera.deviceIndex);
    }
    if (request.requestTypes.includes("Microphone")) {
      const microphone = request.audioInputDevices[0];
      if (!microphone) {
        return [];
      }
      devices.push(microphone.deviceIndex);
    }
    return devices;
  }

  #addMediaManagerVideoPermission(request, principal) {
    if (!request.requestTypes.includes("Camera")) {
      return;
    }
    Services.perms.addFromPrincipal(
      principal,
      "MediaManagerVideo",
      Services.perms.ALLOW_ACTION,
      Services.perms.EXPIRE_SESSION
    );
  }

  #enqueuePrompt(promptEntry) {
    if (this.#closed || this.#state.crashed) {
      promptEntry.cancel();
      return;
    }
    this.#prompts.push(promptEntry);
    if (this.#prompts.length === 1) {
      this.#showNextPrompt();
    }
  }

  #showNextPrompt() {
    const promptEntry = this.#prompts[0];
    this.#patchState({ prompt: promptEntry?.descriptor || null });
    if (promptEntry?.notifyShown) {
      try {
        promptEntry.notifyShown();
      } catch (error) {
        console.error(
          "Desktop embedder could not mark a permission prompt shown",
          error
        );
      }
    }
    if (promptEntry && !promptEntry.delegateRequested) {
      promptEntry.delegateRequested = true;
      if (promptEntry.delegateType === "permission") {
        this.#requestPermissionDecision(promptEntry);
      } else if (promptEntry.delegateType === "webAuthn") {
        this.#requestWebAuthnDecision(promptEntry);
      } else {
        this.#requestPromptDecision(promptEntry);
      }
    }
  }

  #requestPermissionDecision(promptEntry) {
    if (!this.#permissionDelegate) {
      this.#resolvePrompt(promptEntry.descriptor.id, "dismiss");
      return;
    }

    let decision;
    try {
      decision = this.#permissionDelegate.onRequest(promptEntry.descriptor);
    } catch (error) {
      console.error("PermissionDelegate.onRequest failed", error);
      decision = "dismiss";
    }
    if (decision === undefined) {
      console.error("PermissionDelegate returned no decision");
      decision = "dismiss";
    }

    Promise.resolve(decision).then(
      resolvedDecision => {
        if (!PROMPT_DECISIONS.has(resolvedDecision)) {
          console.error(
            `PermissionDelegate returned an invalid decision: ${resolvedDecision}`
          );
          resolvedDecision = "dismiss";
        }
        this.#resolvePrompt(promptEntry.descriptor.id, resolvedDecision);
      },
      error => {
        console.error("PermissionDelegate decision rejected", error);
        this.#resolvePrompt(promptEntry.descriptor.id, "dismiss");
      }
    );
  }

  #requestPromptDecision(promptEntry) {
    if (!this.#promptDelegate) {
      this.#resolvePrompt(
        promptEntry.descriptor.id,
        defaultPromptResponse(promptEntry.descriptor)
      );
      return;
    }

    let response;
    try {
      response = this.#promptDelegate.onPrompt(promptEntry.descriptor);
    } catch (error) {
      console.error("PromptDelegate.onPrompt failed", error);
      response = defaultPromptResponse(promptEntry.descriptor);
    }
    if (response === undefined) {
      console.error("PromptDelegate returned no response");
      response = defaultPromptResponse(promptEntry.descriptor);
    }

    Promise.resolve(response).then(
      resolvedResponse => {
        if (
          !normalizePromptResponse(resolvedResponse, promptEntry.descriptor)
        ) {
          console.error("PromptDelegate returned an invalid response");
          resolvedResponse = defaultPromptResponse(promptEntry.descriptor);
        }
        this.#resolvePrompt(promptEntry.descriptor.id, resolvedResponse);
      },
      error => {
        console.error("PromptDelegate response rejected", error);
        this.#resolvePrompt(
          promptEntry.descriptor.id,
          defaultPromptResponse(promptEntry.descriptor)
        );
      }
    );
  }

  #requestWebAuthnDecision(promptEntry) {
    const fallback = Object.freeze({ action: "cancel" });
    if (!this.#webAuthnDelegate) {
      this.#resolvePrompt(promptEntry.descriptor.id, fallback);
      return;
    }

    let response;
    try {
      response = this.#webAuthnDelegate.onRequest(promptEntry.descriptor);
    } catch (error) {
      console.error("WebAuthnDelegate.onRequest failed", error);
      response = fallback;
    }
    if (response === undefined) {
      console.error("WebAuthnDelegate returned no response");
      response = fallback;
    }

    Promise.resolve(response).then(
      resolvedResponse => {
        if (
          !normalizeWebAuthnResponse(resolvedResponse, promptEntry.descriptor)
        ) {
          console.error("WebAuthnDelegate returned an invalid response");
          resolvedResponse = fallback;
        }
        this.#resolvePrompt(promptEntry.descriptor.id, resolvedResponse);
      },
      error => {
        console.error("WebAuthnDelegate response rejected", error);
        this.#resolvePrompt(promptEntry.descriptor.id, fallback);
      }
    );
  }

  #notifyPromptCanceled(promptEntry, reason) {
    const detail = Object.freeze({
      ...promptEntry.descriptor,
      reason,
    });
    if (promptEntry.delegateType === "permission") {
      callDelegate(
        this.#permissionDelegate,
        "PermissionDelegate",
        "onCanceled",
        detail
      );
    } else if (promptEntry.delegateType === "webAuthn") {
      callDelegate(
        this.#webAuthnDelegate,
        "WebAuthnDelegate",
        "onCanceled",
        detail
      );
    } else {
      callDelegate(
        this.#promptDelegate,
        "PromptDelegate",
        "onCanceled",
        detail
      );
    }
  }

  #cancelMediaPrompt(nativeId) {
    const index = this.#prompts.findIndex(
      promptEntry => promptEntry.nativeId === nativeId
    );
    if (index === -1) {
      return;
    }
    const [promptEntry] = this.#prompts.splice(index, 1);
    this.#notifyPromptCanceled(promptEntry, "native-canceled");
    if (index === 0) {
      this.#showNextPrompt();
    }
  }

  #cancelQueuedPrompt(promptEntry, reason) {
    const index = this.#prompts.indexOf(promptEntry);
    if (index === -1) {
      return;
    }
    this.#prompts.splice(index, 1);
    try {
      promptEntry.cancel();
    } catch {}
    this.#notifyPromptCanceled(promptEntry, reason);
    if (index === 0) {
      this.#showNextPrompt();
    }
  }

  #cancelAllPrompts(reason) {
    const prompts = this.#prompts.splice(0);
    this.#patchState({ prompt: null });
    for (const promptEntry of prompts) {
      try {
        promptEntry.cancel();
      } catch {}
      this.#notifyPromptCanceled(promptEntry, reason);
    }
  }

  #navigationForRequest(request) {
    if (request && typeof request === "object") {
      return this.#requestNavigations.get(request) ?? this.#state.navigationId;
    }
    return this.#state.navigationId;
  }

  #writeNavigationHistory(navigationId = this.#state.navigationId) {
    if (!this.#browser || this.#state.crashed) {
      return false;
    }
    try {
      return this.#runtime[UPDATE_CORE_NAVIGATION](
        this,
        "setNavigationHistory",
        navigationId,
        this.#browser.canGoBack,
        this.#browser.canGoForward
      );
    } catch {
      return false;
    }
  }

  #writeNavigationIdentity(navigationId = this.#state.navigationId) {
    if (!this.#browser || this.#state.crashed) {
      return false;
    }
    const identity = authenticatedNavigationIdentity(this.#browser);
    return this.#runtime[UPDATE_CORE_NAVIGATION](
      this,
      "setNavigationIdentity",
      navigationId,
      identity.id,
      identity.key
    );
  }

  #writeNavigationTitle(navigationId = this.#state.navigationId) {
    if (!this.#browser || this.#state.crashed) {
      return false;
    }
    return this.#runtime[UPDATE_CORE_NAVIGATION](
      this,
      "setNavigationTitle",
      navigationId,
      this.#browser.contentTitle || ""
    );
  }

  #updateTitle() {
    if (this.#writeNavigationTitle()) {
      this.#syncNavigationState();
    }
  }

  #patchState(patch) {
    const changed = Object.entries(patch).some(
      ([key, value]) => this.#state[key] !== value
    );
    if (!changed) {
      return;
    }
    this.#state = { ...this.#state, ...patch };
    const state = this.state;
    callDelegate(
      this.#contentDelegate,
      "ContentDelegate",
      "onStateChanged",
      state
    );
    if (Object.hasOwn(patch, "media")) {
      callDelegate(
        this.#mediaDelegate,
        "MediaDelegate",
        "onStateChanged",
        freezeMediaState(this.id, this.#state.media)
      );
    }
  }
}
