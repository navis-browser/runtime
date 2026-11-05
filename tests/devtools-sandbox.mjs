// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../gecko/devtools/shared/loader/base-loader.sys.mjs", import.meta.url), "utf8");
const start = source.indexOf("function Sandbox(options) {");
const end = source.indexOf("// This allows defining", start);
assert.ok(start >= 0 && end > start);
const sandboxSource = source.slice(start, end);
function create(code, deviceAPIs) {
  const context = vm.createContext({
    systemPrincipal: {}, AppConstants: { MOZ_WEB_DEVICE_APIS: deviceAPIs },
    Cu: { Sandbox(_principal, options) {
      // XPConnect rejects names whose WebIDL implementation was compiled out.
      if (!deviceAPIs) {
        const unsupported = options.wantGlobalProperties.find(name => /^MIDI(?:Input|Output)Map$/.test(name));
        if (unsupported) throw new Error("Unknown property name: " + unsupported);
      }
      return options;
    } },
  });
  vm.runInContext(code + "\nglobalThis.createSandbox = Sandbox;", context);
  return context.createSandbox({ name: "Navis retained DevTools" });
}
const retained = create(sandboxSource, false);
const complete = create(sandboxSource, true);
assert.deepEqual(Array.from(complete.wantGlobalProperties).filter(name => !/^MIDI/.test(name)),
  Array.from(retained.wantGlobalProperties));
assert.ok(complete.wantGlobalProperties.includes("MIDIInputMap"));
assert.ok(complete.wantGlobalProperties.includes("MIDIOutputMap"));
for (const name of ["AbortController", "InspectorUtils", "Node", "Window", "XMLHttpRequest"]) {
  assert.ok(retained.wantGlobalProperties.includes(name), name);
}
const mutant = sandboxSource.replace(/\.\.\.\(AppConstants\.MOZ_WEB_DEVICE_APIS \? \["MIDIInputMap", "MIDIOutputMap"\] : \[\]\),/,
  '"MIDIInputMap", "MIDIOutputMap",');
assert.notEqual(mutant, sandboxSource);
assert.throws(() => create(mutant, false), /Unknown property name: MIDIInputMap/);
console.log("DevTools sandbox accepts the API-cut configuration, retains other globals and supports the full engine configuration; native toolbox execution is separate");
