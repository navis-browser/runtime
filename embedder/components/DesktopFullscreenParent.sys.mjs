/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ACTOR_NAME = "DesktopFullscreen";

function browserForActor(actor) {
  return actor.browsingContext?.top?.embedderElement ?? null;
}

function chromeWindowForBrowser(browser) {
  return browser?.documentGlobal ?? null;
}

function requestOriginForActor(actor) {
  const browser = browserForActor(actor);
  const chromeWindow = chromeWindowForBrowser(browser);
  return chromeWindow?.browsingContext?.fullscreenRequestOrigin?.get() ?? null;
}

function actorIsLive(actor) {
  try {
    return Boolean(actor?.browsingContext?.currentWindowGlobal);
  } catch {
    return false;
  }
}

/** Commits remote content fullscreen requests in the native chrome window. */
export class DesktopFullscreenParent extends JSWindowActorParent {
  #browser = null;
  #chromeWindow = null;
  #routedActors = [];
  #ownsRequest = false;
  #platformFullscreen = false;

  receiveMessage(message) {
    switch (message.name) {
      case "DesktopFullscreen:Request":
        this.#beginRequest(message.data.fullscreenKeyboardLock);
        break;
      case "DesktopFullscreen:Exit":
        requestOriginForActor(this)?.exitFullscreen();
        break;
    }
    return null;
  }

  didDestroy() {
    if (!this.#ownsRequest) {
      return;
    }
    try {
      this.#chromeWindow?.windowUtils.remoteFrameFullscreenReverted();
    } catch {}
    this.#finishRequest();
  }

  exitFullscreen() {
    if (!this.#ownsRequest) {
      return;
    }
    try {
      this.#chromeWindow?.windowUtils.remoteFrameFullscreenReverted();
    } catch {
      this.#finishRequest();
    }
  }

  handleEvent(event) {
    if (!this.#ownsRequest) {
      return;
    }
    switch (event.type) {
      case "MozDOMFullscreen:Entered":
        if (event.target !== this.#browser) {
          return;
        }
        this.#routeEntered();
        this.#setPlatformFullscreen(true);
        break;
      case "MozDOMFullscreen:Exited":
        this.#routeExited();
        this.#finishRequest();
        break;
    }
  }

  #beginRequest(fullscreenKeyboardLock) {
    const browser = browserForActor(this);
    const chromeWindow = chromeWindowForBrowser(browser);
    const chromeBrowsingContext = chromeWindow?.browsingContext;
    if (!browser || !chromeWindow?.windowUtils || !chromeBrowsingContext) {
      return;
    }
    if (browser.desktopEmbedderWebAuthnPromptActive?.()) {
      return;
    }

    const existingOrigin =
      chromeBrowsingContext.fullscreenRequestOrigin?.get() ?? null;
    if (existingOrigin && existingOrigin !== this) {
      existingOrigin.exitFullscreen();
      return;
    }

    this.#browser = browser;
    this.#chromeWindow = chromeWindow;
    this.#ownsRequest = true;
    chromeBrowsingContext.fullscreenRequestOrigin = Cu.getWeakReference(this);
    chromeWindow.addEventListener("MozDOMFullscreen:Entered", this, true);
    chromeWindow.addEventListener("MozDOMFullscreen:Exited", this, true);

    const keyboardLockEnabled =
      Services.prefs.getBoolPref(
        "dom.fullscreen.keyboard_lock.enabled",
        false
      ) && fullscreenKeyboardLock === "browser";
    try {
      chromeWindow.windowUtils.remoteFrameFullscreenChanged(
        browser,
        keyboardLockEnabled
      );
    } catch (error) {
      console.error("Desktop fullscreen request failed", error);
      this.#finishRequest();
    }
  }

  #routeEntered() {
    const routedActors = [];
    let currentBC = this.browsingContext;
    let currentPid = currentBC.currentWindowGlobal?.osPid;
    let parentBC = currentBC.parent;

    while (parentBC?.currentWindowGlobal) {
      const parentPid = parentBC.currentWindowGlobal.osPid;
      if (currentPid !== parentPid) {
        const actor = parentBC.currentWindowGlobal.getActor(ACTOR_NAME);
        actor.sendAsyncMessage("DesktopFullscreen:Entered", {
          remoteFrameBC: currentBC,
        });
        routedActors.push(actor);
        currentPid = parentPid;
      }
      currentBC = parentBC;
      parentBC = parentBC.parent;
    }

    const sourceActor =
      this.browsingContext.currentWindowGlobal?.getActor(ACTOR_NAME);
    if (!sourceActor) {
      this.exitFullscreen();
      return;
    }
    sourceActor.sendAsyncMessage("DesktopFullscreen:Entered", {});
    routedActors.push(sourceActor);
    this.#routedActors = routedActors;
  }

  #routeExited() {
    for (const actor of this.#routedActors) {
      if (actorIsLive(actor)) {
        try {
          actor.sendAsyncMessage("DesktopFullscreen:Exited", {});
        } catch {}
      }
    }
    this.#routedActors = [];
  }

  #setPlatformFullscreen(active) {
    if (this.#platformFullscreen === active) {
      return;
    }
    this.#platformFullscreen = active;
    try {
      this.#browser?.desktopEmbedderFullscreenStateChanged?.(active);
    } catch (error) {
      console.error("Desktop fullscreen state callback failed", error);
    }
  }

  #finishRequest() {
    this.#routeExited();
    this.#setPlatformFullscreen(false);
    if (this.#chromeWindow) {
      this.#chromeWindow.removeEventListener(
        "MozDOMFullscreen:Entered",
        this,
        true
      );
      this.#chromeWindow.removeEventListener(
        "MozDOMFullscreen:Exited",
        this,
        true
      );
      const chromeBrowsingContext = this.#chromeWindow.browsingContext;
      if (chromeBrowsingContext?.fullscreenRequestOrigin?.get() === this) {
        delete chromeBrowsingContext.fullscreenRequestOrigin;
      }
    }
    this.#browser = null;
    this.#chromeWindow = null;
    this.#ownsRequest = false;
  }
}
