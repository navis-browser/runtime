/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { readDownloadSettings, setDownloadSetting } from "resource://gre/modules/NavisSettingsPolicy.sys.mjs";

let downloadLifecycle = null;
let downloadAttention = null;

// Normal download attention survives restarts. Only hashed identities are
// persisted; private-download attention remains exclusively in the WeakMap.
export function getDesktopDownloadAttention() {
  return downloadAttention ??= new DesktopDownloadAttention({
    read: () => {
      try { return JSON.parse(Services.prefs.getStringPref("navis.downloads.unseen", "[]")); }
      catch { return []; }
    },
    write: entries => Services.prefs.setStringPref("navis.downloads.unseen", JSON.stringify(entries)),
    keyFor: download => {
      const bytes = new TextEncoder().encode(JSON.stringify([
        download.source?.url, download.target?.path, download.startTime?.getTime(),
      ]));
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.update(bytes, bytes.length);
      return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    },
    token: () => Services.uuid.generateUUID().toString(),
  });
}

export class DesktopDownloadAttention {
  #records = new WeakMap();
  #saved;
  #deps;

  constructor(dependencies) {
    this.#deps = dependencies;
    const stored = dependencies.read();
    this.#saved = new Map((Array.isArray(stored) ? stored : []).filter(entry =>
      Array.isArray(entry) && entry.length === 2 && /^[0-9a-f]{64}$/.test(entry[0]) &&
      typeof entry[1] === "string" && entry[1].length > 0 && entry[1].length <= 64));
  }

  observe(download, { existing = false } = {}) {
    let record = this.#records.get(download);
    if (!record) {
      const key = download.source?.isPrivate ? null : this.#deps.keyFor(download);
      record = { key, succeeded: !!download.succeeded, token: download.succeeded ? this.#saved.get(key) || null : null };
      this.#records.set(download, record);
      if (existing) return;
      record.succeeded = false;
    }
    if (download.succeeded && !record.succeeded) {
      record.token = this.#deps.token();
      if (record.key) {
        this.#saved.delete(record.key);
        record.key = this.#deps.keyFor(download);
        this.#saved.set(record.key, record.token);
        this.#deps.write([...this.#saved]);
      }
    } else if (!download.succeeded && record.succeeded) {
      record.token = null;
      if (record.key && this.#saved.delete(record.key)) this.#deps.write([...this.#saved]);
    }
    record.succeeded = !!download.succeeded;
  }

  tokenFor(download) {
    return download.succeeded ? this.#records.get(download)?.token || null : null;
  }

  acknowledge(download, token) {
    const record = this.#records.get(download);
    if (!record?.token || !download.succeeded || record.token !== token) return false;
    record.token = null;
    if (record.key && this.#saved.delete(record.key)) this.#deps.write([...this.#saved]);
    return true;
  }

  forget(download) {
    const record = this.#records.get(download);
    this.#records.delete(download);
    if (record?.key && this.#saved.delete(record.key)) this.#deps.write([...this.#saved]);
  }
}

export function getDesktopDownloadLifecycle() {
  return downloadLifecycle ??= new DesktopDownloadLifecycle();
}

export async function getDesktopDownloadSettings() {
  return Object.freeze({ ...readDownloadSettings(Services.prefs), directory: await Downloads.getPreferredDownloadsDirectory() });
}

export async function chooseDesktopDownloadDirectory(ownerWindow) {
  if (!ownerWindow || ownerWindow.closed) {
    throw new TypeError("A live owner window is required");
  }
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  picker.init(ownerWindow.browsingContext, "Navis", Ci.nsIFilePicker.modeGetFolder);
  const folder = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  folder.initWithPath(await Downloads.getPreferredDownloadsDirectory());
  picker.displayDirectory = folder;
  const result = await new Promise(resolve => picker.open(resolve));
  if (result !== Ci.nsIFilePicker.returnOK || !picker.file?.isDirectory()) {
    return false;
  }
  Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, picker.file);
  Services.prefs.setIntPref("browser.download.folderList", 2);
  return true;
}

export function updateDesktopDownloadSetting(key, value) {
  return setDownloadSetting(Services.prefs, key, value);
}

export class DesktopDownloadLifecycle {
  #records = new Map();
  #privateExit = Promise.resolve();
  #observer;

  constructor() {
    this.#observer = () => {
      this.#privateExit = this.#privateExit.then(() => this.#cleanPrivateDownloads()).catch(error => {
        console.error("Navis private download cleanup failed", error);
      });
    };
    Services.obs.addObserver(this.#observer, "last-pb-context-exited");
    AsyncShutdown.profileBeforeChange.addBlocker("Navis: private download cleanup", () => {
      this.#observer();
      return this.#privateExit;
    });
  }

  observe(download, { existing = false } = {}) {
    let record = this.#records.get(download);
    if (!record) {
      record = { existing, wasSucceeded: Boolean(download.succeeded), completedFile: null, snapshot: Promise.resolve() };
      this.#records.set(download, record);
      if (existing) {
        return;
      }
      record.wasSucceeded = false;
    }
    if (download.succeeded && !record.wasSucceeded) {
      record.wasSucceeded = true;
      if (download.source?.isPrivate && !record.existing) {
        const path = download.target?.path;
        record.snapshot = IOUtils.stat(path).then(stat => {
          if (stat.type === "regular") {
            record.completedFile = { path, size: stat.size, lastModified: stat.lastModified };
          }
        }).catch(() => undefined);
      }
      if (!record.existing && !download.launchWhenSucceeded &&
          readDownloadSettings(Services.prefs).openWhenComplete) {
        // A per-download Open choice already belongs to Gecko's _succeed path.
        // Like manual Open, this setting promises the system app, not Firefox's
        // browser-window fallback. Gecko retains executable checks and consent.
        Promise.resolve(download.launch({ useSystemDefault: true })).catch(error => console.error("Navis could not open completed download", error));
      }
    }
  }

  forget(download) {
    if (!download.source?.isPrivate) {
      this.#records.delete(download);
    }
  }

  async #cleanPrivateDownloads() {
    if (!readDownloadSettings(Services.prefs).deletePrivateOnExit) {
      for (const [download] of this.#records) {
        if (download.source?.isPrivate) {
          this.#records.delete(download);
        }
      }
      return;
    }
    const targets = [...this.#records].filter(([download, record]) => download.source?.isPrivate && !record.existing);
    for (const [download, record] of targets) {
      try {
        if (!download.stopped) {
          await download.cancel();
        }
        await download.removePartialData();
        await record.snapshot;
        const file = record.completedFile;
        if (!file || !PathUtils.isAbsolute(file.path)) {
          continue;
        }
        const sharedWithNormal = [...this.#records.keys()].some(other => !other.source?.isPrivate && other.target?.path === file.path);
        if (sharedWithNormal) {
          continue;
        }
        const stat = await IOUtils.stat(file.path, { followSymlinks: false });
        if (stat.type === "regular" && stat.size === file.size && stat.lastModified === file.lastModified) {
          await IOUtils.remove(file.path, { ignoreAbsent: true });
        }
      } catch (error) {
        console.error("Navis could not clean a private download", error);
      } finally {
        this.#records.delete(download);
      }
    }
  }
}
