/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CONTENT_PROCESS_TYPES = new Set(["web", "webIsolated", "file", "withCoopCoep", "webServiceWorker"]);
const bounded = (value, length = 8192) => String(value ?? "").slice(0, length);
const safe = read => { try { return bounded(read()); } catch { return ""; } };
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export class NavisProcessManager {
  #sample = null;
  #tokens = new Map();
  #ids = new Map();

  async snapshot(protectedProcessIds = []) {
    const info = await ChromeUtils.requestProcInfo();
    const at = ChromeUtils.now();
    const entries = [info, ...(info.children || []).slice(0, 256)];
    const next = new Map();
    const tokens = new Map();
    const protectedIds = new Set(protectedProcessIds);
    const processes = entries.map((entry, index) => {
      const key = index === 0 ? "parent" : `${entry.childID}:${entry.pid}`;
      const old = this.#sample?.entries.get(key);
      let id = this.#ids.get(key);
      if (!id) {
        id = Services.uuid.generateUUID().toString().slice(1, -1);
        this.#ids.set(key, id);
      }
      const canEnd = index !== 0 && CONTENT_PROCESS_TYPES.has(entry.type) &&
        Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
        Number.isSafeInteger(entry.childID) && entry.childID > 0 && !protectedIds.has(entry.pid);
      const token = canEnd ? Services.uuid.generateUUID().toString().slice(1, -1) : "";
      if (token) {
        tokens.set(token, { pid: entry.pid, childID: entry.childID, type: entry.type, at });
      }
      const elapsed = this.#sample ? at - this.#sample.at : 0;
      const cpuTime = number(entry.cpuTime);
      const cpuPercent = old && elapsed > 0 && cpuTime >= old.cpuTime
        ? Math.round((cpuTime - old.cpuTime) / (elapsed * 1e6) * 1000) / 10 : null;
      next.set(key, { cpuTime });
      return Object.freeze({
        id,
        type: bounded(index === 0 ? "browser" : entry.type, 48),
        origin: bounded(entry.origin, 2048),
        title: bounded((entry.windows || []).find(window => window.isProcessRoot && window.documentTitle)?.documentTitle, 512),
        memoryBytes: number(entry.memory),
        cpuPercent,
        threadCount: Math.min(entry.threads?.length || 0, 4096),
        canEnd,
        token,
      });
    });
    this.#sample = { at, entries: next };
    this.#tokens = tokens;
    for (const key of this.#ids.keys()) {
      if (!next.has(key)) {
        this.#ids.delete(key);
      }
    }
    return Object.freeze(processes);
  }

  async end(token, protectedProcessIds = []) {
    const record = this.#tokens.get(token);
    this.#tokens.delete(token);
    if (!record || ChromeUtils.now() - record.at > 30000) {
      throw new TypeError("The process action expired");
    }
    const info = await ChromeUtils.requestProcInfo();
    const process = info.children?.find(child => child.pid === record.pid && child.childID === record.childID && child.type === record.type);
    if (!process || !CONTENT_PROCESS_TYPES.has(process.type) || process.pid === info.pid || protectedProcessIds.includes(process.pid)) {
      throw new TypeError("The process can no longer be ended");
    }
    Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).kill(process.pid);
    return true;
  }
}

const SUPPORT_PREFS = Object.freeze([
  "fission.autostart", "fission.webContentIsolationStrategy", "dom.ipc.processCount",
  "security.sandbox.content.level", "security.sandbox.gpu.level", "gfx.webrender.all",
  "gfx.webrender.software", "layers.acceleration.disabled", "dom.webgpu.enabled",
  "network.trr.mode", "network.proxy.type", "browser.download.useDownloadDir",
  "navis.appearance.theme", "navis.appearance.accent", "navis.processIsolation.mode",
]);

export async function getAdditionalSupportDiagnostics(runtime = null) {
  let gfx = null;
  try { gfx = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo); } catch {}
  let cpuDetails = "";
  try {
    // Current Gecko exposes CPU data asynchronously, not through the legacy
    // cpuvendor/cpufamily/... property-bag names. The native promise is cached.
    const cpu = await Services.sysinfo.processInfo;
    cpuDetails = ["name", "vendor", "count", "cores", "family", "model", "stepping", "speedMHz"]
      .filter(key => typeof cpu?.[key] === "string" ? cpu[key].trim().length > 0
        : typeof cpu?.[key] === "number" && Number.isFinite(cpu[key]))
      .map(key => `${key}: ${bounded(cpu[key], 256)}`).join("\n");
  } catch {
    // One unavailable OS probe must not discard graphics, sandbox or other
    // diagnostics. The page renders its explicit localized unavailable value.
  }
  const preferences = SUPPORT_PREFS.filter(key => Services.prefs.prefHasUserValue(key)).map(key => {
    const type = Services.prefs.getPrefType(key);
    const value = type === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(key)
      : type === Services.prefs.PREF_INT ? Services.prefs.getIntPref(key) : Services.prefs.getStringPref(key);
    return `${key} = ${bounded(value, 256)}`;
  }).join("\n");
  let extensions = "";
  if (runtime?.getExtensionInventory) {
    try {
      extensions = (await runtime.getExtensionInventory()).slice(0, 128).map(item => `${bounded(item.name, 160)} ${bounded(item.version, 40)} | ${bounded(item.id, 256)} | ${item.enabled ? "enabled" : "disabled"}`).join("\n");
    } catch {}
  }
  const json = read => safe(() => JSON.stringify(read(), null, 2));
  const sandbox = ["hasSeccompBPF", "hasSeccompTSync", "hasPrivilegedUserNamespaces", "hasUserNamespaces", "canSandboxContent", "canSandboxMedia"]
    .map(key => safe(() => Services.sysinfo.hasKey(key) ? `${key}: ${Services.sysinfo.getProperty(key)}` : ""))
    .filter(Boolean).join("\n");
  return Object.freeze([
    ["diagnostics.cpuDetails", cpuDetails],
    ["diagnostics.adapterDescription2", safe(() => gfx.adapterDescription2)],
    ["diagnostics.adapterRAM", safe(() => gfx.adapterRAM)],
    ["diagnostics.graphicsFeatures", json(() => gfx.getFeatureLog())],
    ["diagnostics.graphicsFailureDetails", safe(() => gfx.getFailures({}).slice(0, 64).join("\n"))],
    ["diagnostics.graphicsCrashGuards", json(() => gfx.getActiveCrashGuards())],
    ["diagnostics.sandboxFeatures", sandbox],
    ["diagnostics.win32kLockdown", safe(() => Cc["@mozilla.org/sandbox/sandbox-settings;1"].getService(Ci.mozISandboxSettings).contentWin32kLockdownStateString)],
    ["diagnostics.modifiedPreferences", preferences || "default"],
    ["diagnostics.allExtensions", extensions],
  ].map(entry => Object.freeze(entry)));
}

// Fixed packaged resources only; Android UI additions use the same offline reader.
const ANDROID_LICENSE_NOTICES = Object.freeze([
  "resource://gre/modules/navis-licenses/colorpicker-compose-1.1.4.txt",
  "resource://android/assets/navis-licenses/android-dependencies.txt",
]);

async function readPackagedLicense(uri) {
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true });
  return new Promise((resolve, reject) => NetUtil.asyncFetch(channel, (stream, status) => {
    if (!Components.isSuccessCode(status)) {
      reject(new Error("Packaged license notices could not be read"));
      return;
    }
    const available = stream.available();
    if (available > 4 * 1024 * 1024) {
      reject(new RangeError("Packaged license notice exceeds the bound"));
      return;
    }
    resolve(NetUtil.readInputStreamToString(stream, available, { charset: "UTF-8" }));
  }));
}

let licenses = null;
export async function getNavisLicenseText() {
  if (!licenses) {
    licenses = (async () => {
      const html = await readPackagedLicense("chrome://global/content/license.html");
      const gecko = Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils).convertToPlainText(html, 0, 0);
      const source = await readPackagedLicense("resource://gre/modules/navis-licenses/source-code.txt");
      const additional = Services.appinfo.OS === "Android"
        ? await Promise.all(ANDROID_LICENSE_NOTICES.map(readPackagedLicense)) : [];
      return [source, gecko, ...additional].join("\n\n");
    })().catch(error => { licenses = null; throw error; });
  }
  return licenses;
}
