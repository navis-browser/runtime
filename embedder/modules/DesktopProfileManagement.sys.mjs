/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PROFILE_FILE = "navis-profile.json";
const PROFILE_SOURCE = "navis";
const ACCENT_PREF = "navis.appearance.accent";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROFILES = 128;

export function validateProfileUser(value) {
  if (!value || typeof value.userName !== "string" ||
      !value.userName.trim() || value.userName.length > 80 ||
      /[\u0000-\u001f\u007f]/u.test(value.userName) ||
      typeof value.accentColor !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(value.accentColor)) {
    throw new TypeError("Invalid profile user information");
  }
  return Object.freeze({
    userName: value.userName.trim(),
    accentColor: value.accentColor.toLowerCase(),
  });
}

function platformDependencies() {
  return {
    service: Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService),
    currentRoot: Services.dirsvc.get("ProfD", Ci.nsIFile),
    io: IOUtils,
    join: (...parts) => PathUtils.join(...parts),
    uuid: () => Services.uuid.generateUUID().toString().slice(1, -1).toLowerCase(),
    prefs: Services.prefs,
    startup: Services.startup,
    restartFlags: Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart,
    canRestart() {
      const cancelled = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
      Services.obs.notifyObservers(cancelled, "quit-application-requested", "restart");
      return !cancelled.data;
    },
    safeModeAllowed: () => !Services.policies || Services.policies.isAllowed("safeMode"),
    notifyChanged: () => Services.obs.notifyObservers(null, "navis-profile-identity-changed"),
  };
}

export class DesktopProfileManagement {
  #deps;
  #tail = Promise.resolve();

  constructor(dependencies = platformDependencies()) {
    this.#deps = dependencies;
  }

  #serialize(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #assertWritable() {
    if (this.#deps.service.isListOutdated) {
      throw new Error("profile-list-outdated");
    }
  }

  #profiles() {
    const result = [];
    for (const profile of this.#deps.service.profiles) {
      if (result.length >= MAX_PROFILES) {
        throw new RangeError("Profile limit reached");
      }
      result.push(profile);
    }
    return result;
  }

  #isCurrent(profile) {
    return profile.rootDir.equals(this.#deps.currentRoot);
  }

  #currentNative() {
    return this.#profiles().find(profile => this.#isCurrent(profile)) || null;
  }

  #path(root) {
    return this.#deps.join(root.path, PROFILE_FILE);
  }

  async #readUser(root, fallbackName) {
    let record;
    try {
      record = await this.#deps.io.readJSON(this.#path(root));
    } catch (error) {
      if (error.name !== "NotFoundError") {
        throw error;
      }
    }
    if (record) {
      if (record.schemaVersion !== 1 || !UUID.test(record.id)) {
        throw new Error("Invalid Navis profile metadata");
      }
      return Object.freeze({ id: record.id, ...validateProfileUser(record) });
    }
    return Object.freeze({ id: null, userName: fallbackName || "Navis", accentColor: "#0b57d0" });
  }

  async #writeUser(root, user) {
    await this.#deps.io.writeJSON(this.#path(root), { schemaVersion: 1, ...user }, {
      tmpPath: `${this.#path(root)}.tmp`,
    });
  }

  #newId() {
    const id = this.#deps.uuid();
    if (!UUID.test(id)) {
      throw new Error("Profile identifiers must be UUIDv4");
    }
    return id;
  }

  #inUse(profile) {
    if (this.#isCurrent(profile)) {
      return true;
    }
    try {
      const lock = profile.lock({});
      lock.unlock();
      return false;
    } catch {
      return true;
    }
  }

  async #record(profile) {
    const user = await this.#readUser(profile.rootDir, profile.name);
    const current = this.#isCurrent(profile);
    const inUse = this.#inUse(profile);
    const accent = current ? this.#deps.prefs.getStringPref(ACCENT_PREF, user.accentColor) : user.accentColor;
    return Object.freeze({
      id: user.id || `legacy:${encodeURIComponent(profile.name)}`,
      userName: user.userName,
      accentColor: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : user.accentColor,
      current,
      default: profile === this.#deps.service.defaultProfile,
      inUse,
      canRemove: !current && !inUse,
      canLaunch: !inUse,
    });
  }

  async #find(id) {
    if (typeof id !== "string" || !id || id.length > 512) {
      throw new TypeError("Invalid profile identifier");
    }
    for (const profile of this.#profiles()) {
      if ((await this.#record(profile)).id === id) {
        return profile;
      }
    }
    throw new TypeError("Unknown profile identifier");
  }

  async current() {
    return this.#serialize(async () => {
      const native = this.#currentNative();
      let user = await this.#readUser(this.#deps.currentRoot, native?.name);
      if (!user.id) {
        user = Object.freeze({ ...user, id: this.#newId() });
        await this.#writeUser(this.#deps.currentRoot, user);
      }
      if (!this.#deps.prefs.prefHasUserValue(ACCENT_PREF)) {
        this.#deps.prefs.setStringPref(ACCENT_PREF, user.accentColor);
      }
      const accent = this.#deps.prefs.getStringPref(ACCENT_PREF, user.accentColor);
      if (/^#[0-9a-f]{6}$/i.test(accent) && user.accentColor !== accent.toLowerCase()) {
        user = Object.freeze({ ...user, accentColor: accent.toLowerCase() });
        await this.#writeUser(this.#deps.currentRoot, user);
      }
      return user;
    });
  }

  async snapshot() {
    const user = await this.current();
    const profiles = await Promise.all(this.#profiles().map(profile => this.#record(profile)));
    if (!profiles.some(profile => profile.current)) {
      profiles.unshift(Object.freeze({ ...user, current: true, default: false, inUse: true, canRemove: false, canLaunch: false }));
    }
    return Object.freeze({
      currentId: user.id,
      defaultId: profiles.find(profile => profile.default)?.id || null,
      profiles: Object.freeze(profiles),
      isListOutdated: Boolean(this.#deps.service.isListOutdated),
    });
  }

  async update(value) {
    const valid = validateProfileUser(value);
    return this.#serialize(async () => {
      const current = await this.#readUser(this.#deps.currentRoot, this.#currentNative()?.name);
      const user = Object.freeze({ id: current.id || this.#newId(), ...valid });
      await this.#writeUser(this.#deps.currentRoot, user);
      this.#deps.prefs.setStringPref(ACCENT_PREF, user.accentColor);
      this.#deps.notifyChanged?.();
      return user;
    });
  }

  async create(value) {
    const valid = validateProfileUser(value);
    return this.#serialize(async () => {
      this.#assertWritable();
      if (this.#profiles().length >= MAX_PROFILES) {
        throw new RangeError("Profile limit reached");
      }
      const id = this.#newId();
      if (this.#profiles().some(profile => profile.name === id)) {
        throw new Error("Profile identifier collision");
      }
      const native = this.#deps.service.createProfile(null, id, PROFILE_SOURCE);
      const user = Object.freeze({ id, ...valid });
      try {
        await this.#writeUser(native.rootDir, user);
        await this.#deps.service.asyncFlush();
      } catch (error) {
        native.remove(false);
        throw error;
      }
      try {
        this.#deps.startup.createInstanceWithProfile(native);
      } catch {
        // Creation is already durable. Keep its ID so recovery only retries
        // opening this profile instead of registering another one.
        return Object.freeze({ ...user, launched: false });
      }
      return user;
    });
  }

  async launch(id) {
    return this.#serialize(async () => {
      this.#assertWritable();
      const native = await this.#find(id);
      if (this.#inUse(native)) {
        throw new Error("profile-in-use");
      }
      this.#deps.startup.createInstanceWithProfile(native);
      return Object.freeze({ id, launched: true });
    });
  }

  async setDefault(id) {
    return this.#serialize(async () => {
      this.#assertWritable();
      const profile = await this.#find(id);
      const previous = this.#deps.service.defaultProfile;
      this.#deps.service.defaultProfile = profile;
      try {
        await this.#deps.service.asyncFlush();
      } catch (error) {
        this.#deps.service.defaultProfile = previous;
        throw error;
      }
      return Object.freeze({ id, default: true });
    });
  }

  async remove(value) {
    if (!value || typeof value.deleteFiles !== "boolean") {
      throw new TypeError("Profile removal requires an explicit file choice");
    }
    return this.#serialize(async () => {
      this.#assertWritable();
      const profile = await this.#find(value.id);
      if (this.#inUse(profile)) {
        throw new Error("profile-in-use");
      }
      const previous = this.#deps.service.defaultProfile;
      const root = profile.rootDir;
      const local = profile.localDir;
      const name = profile.name;
      if (profile === previous) {
        this.#deps.service.defaultProfile = this.#currentNative() || this.#profiles().find(candidate => candidate !== profile) || null;
      }
      try {
        profile.remove(false);
        await this.#deps.service.asyncFlush();
      } catch (error) {
        const restored = this.#profiles().includes(profile)
          ? profile
          : this.#deps.service.createProfile(root, name, PROFILE_SOURCE);
        this.#deps.service.defaultProfile = previous === profile ? restored : previous;
        throw error;
      }
      let filesRemoved = false;
      if (value.deleteFiles) {
        await this.#deps.service.removeProfileFilesByPath(root, local, 0);
        filesRemoved = true;
      }
      return Object.freeze({ id: value.id, removed: true, filesRemoved });
    });
  }

  async restart(value = { safeMode: false }) {
    if (typeof value.safeMode !== "boolean") {
      throw new TypeError("Invalid restart mode");
    }
    if (value.safeMode && !this.#deps.safeModeAllowed()) {
      throw new Error("safe-mode-not-allowed");
    }
    if (!this.#deps.canRestart()) {
      return false;
    }
    this.#deps.prefs.savePrefFile(null);
    if (value.safeMode) {
      this.#deps.startup.restartInSafeMode(this.#deps.restartFlags);
    } else {
      this.#deps.startup.quit(this.#deps.restartFlags);
    }
    return true;
  }
}

let manager;
export function getDesktopProfileManagement() {
  return manager ||= new DesktopProfileManagement();
}
