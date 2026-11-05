/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Importing Toolkit's registry installs the product-neutral actors used by
// services such as ContentPrefs and native file/download dialogs.
// eslint-disable-next-line import/no-unassigned-import
import "resource://gre/modules/ActorManagerParent.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

let registered = false;

export function ensureDesktopEmbedderActorsRegistered() {
  if (registered) {
    return;
  }

  // Gecko's Prompter transport asks for an actor with this exact name.
  // Firefox normally supplies it from browser/, so the Desktop Embedder owns
  // the product-neutral implementation when browser/ is not in the graph.
  ChromeUtils.registerWindowActor("Prompt", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopEmbedderPromptParent.sys.mjs",
    },
    includeChrome: true,
    allFrames: true,
  });

  ChromeUtils.registerWindowActor("DesktopCredential", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopCredentialParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/DesktopCredentialChild.sys.mjs",
      events: {
        DOMContentLoaded: {},
        DOMFormHasPassword: {},
        DOMInputPasswordAdded: {},
        DOMPossibleUsernameInputAdded: {},
        "before-form-submission": { createActor: false },
        "form-submission-detected": { createActor: false },
        focusin: { capture: true },
        submit: { capture: true },
      },
    },
    allFrames: true,
    matches: ["http://*/*", "https://*/*"],
    messageManagerGroups: ["browsers"],
  });

  ChromeUtils.registerWindowActor("DesktopFullscreen", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopFullscreenParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/DesktopFullscreenChild.sys.mjs",
      events: {
        "MozDOMFullscreen:Request": {},
        "MozDOMFullscreen:Entered": {},
        "MozDOMFullscreen:Exit": {},
        "MozDOMFullscreen:Exited": {},
      },
    },
    allFrames: true,
    messageManagerGroups: ["browsers"],
  });

  ChromeUtils.registerWindowActor("DesktopContextMenu", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopContextMenuParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/DesktopContextMenuChild.sys.mjs",
      events: {
        contextmenu: {},
        pointerdown: { capture: true },
      },
    },
    allFrames: true,
    // MatchPattern does not understand the navis: authority scheme. The child
    // enforces the exact allowed scheme set so one contract covers Web,
    // built-in extensions and authenticated Navis pages.
    messageManagerGroups: ["browsers"],
  });

  ChromeUtils.registerWindowActor("DesktopFavicon", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopFaviconParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/DesktopFaviconChild.sys.mjs",
      events: {
        DOMHeadElementParsed: {},
        DOMLinkAdded: {},
        DOMLinkChanged: {},
        pageshow: {},
        pagehide: { createActor: false },
      },
    },
    matches: ["http://*/*", "https://*/*"],
    messageManagerGroups: ["browsers"],
  });

  ChromeUtils.registerWindowActor("DesktopInternalPage", {
    parent: {
      esModuleURI: "resource://gre/modules/DesktopInternalPageParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/DesktopInternalPageChild.sys.mjs",
      events: {
        // Content handlers (including the settings SPA) run first. System-group
        // capture still precedes the link's native PostHandleEvent; bubbling
        // here would be too late to cancel its dangerous-protocol load.
        click: { capture: true, mozSystemGroup: true, wantUntrusted: true },
        auxclick: { capture: true, mozSystemGroup: true, wantUntrusted: true },
        NavisAppearanceCommand: { wantUntrusted: true },
        NavisSettingsCommand: { wantUntrusted: true },
        NavisDiagnosticsCommand: { wantUntrusted: true },
        NavisManagementCommand: { wantUntrusted: true },
      },
    },
    // Gecko's extension MatchPattern parser does not treat custom schemes as
    // authority URLs. Link activations and dedicated page events create the
    // actor; the child, parent and Session authenticate the exact registered
    // Navis page before any command crosses the process boundary.
    messageManagerGroups: ["browsers"],
  });


  if (AppConstants.MOZ_WEBRTC) {
    ChromeUtils.registerProcessActor("DesktopEmbedderBrowserProcess", {
      child: {
        esModuleURI:
          "resource://gre/modules/DesktopEmbedderBrowserProcessChild.sys.mjs",
        observers: [
          "getUserMedia:request",
          "recording-device-stopped",
          "PeerConnection:request",
          "recording-device-events",
          "recording-window-ended",
        ],
      },
    });

    ChromeUtils.registerWindowActor("DesktopEmbedderWebRTC", {
      parent: {
        esModuleURI:
          "resource://gre/modules/DesktopEmbedderWebRTCParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "resource://gre/modules/DesktopEmbedderWebRTCChild.sys.mjs",
      },
      allFrames: true,
    });
  }

  registered = true;
}
