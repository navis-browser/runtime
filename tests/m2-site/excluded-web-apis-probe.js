// SPDX-License-Identifier: MPL-2.0
globalThis.navisApiProbe = function () {
  const navigatorMembers = ["usb", "bluetooth", "hid", "serial", "requestMIDIAccess", "xr", "getVRDisplays", "activeVRDisplays", "login"];
  const interfaces = ["USB", "USBDevice", "HID", "HIDDevice", "Bluetooth", "BluetoothUUID", "MIDIAccess", "MIDIPort", "Serial", "SerialPort", "VRDisplay", "XRSystem", "XRSession", "PaymentRequest", "PaymentResponse", "IdentityCredential", "DigitalCredential", "NavigatorLogin"];
  return {
    secure: isSecureContext,
    exposed: [...navigatorMembers.filter(name => name in navigator).map(name => `navigator.${name}`),
      ...interfaces.filter(name => name in globalThis)],
    retained: { fetch: typeof fetch === "function", webAssembly: typeof WebAssembly === "object",
      caches: typeof caches === "object", crypto: typeof crypto === "object" },
  };
}
