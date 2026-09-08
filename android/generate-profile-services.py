#!/usr/bin/env python3
"""Give concurrently running Navis profiles independent Gecko child services."""

import argparse
from copy import deepcopy
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ANDROID = "http://schemas.android.com/apk/res/android"
TOOLS = "http://schemas.android.com/tools"
BASE = "org.mozilla.gecko.process.GeckoChildProcessServices$"
OWNER = "org.mozilla.gecko.process.NavisProfileChildProcessServices"
ET.register_namespace("android", ANDROID)
ET.register_namespace("tools", TOOLS)


def generate(source: str, slots: int) -> tuple[str, str]:
    if not 1 <= slots <= 8:
        raise ValueError("Navis supports 1 to 8 profile service slots")
    root = ET.fromstring(source)
    app = root.find("application")
    if app is None:
        raise ValueError("The Gecko service manifest has no application")
    services = [service for service in app.findall("service")
                if service.get(f"{{{ANDROID}}}name", "").startswith(BASE)]
    names = [service.get(f"{{{ANDROID}}}name")[len(BASE):] for service in services]
    expected = {"gmplugin", "socket", "gpu", "rdd", "utility", "ipdlunittest", "zygoteTab"}
    if not expected <= set(names) or len(set(names)) != len(names):
        raise ValueError("Unexpected or missing Gecko child service definitions")
    tab_ids = sorted(int(name[3:]) for name in names if re.fullmatch(r"tab\d+", name))
    if not tab_ids or tab_ids != list(range(len(tab_ids))):
        raise ValueError("Gecko content service IDs must be contiguous")
    if {f"isolatedTab{index}" for index in tab_ids} != {
            name for name in names if name.startswith("isolatedTab")}:
        raise ValueError("Gecko isolated and ordinary content service counts differ")
    for name in names:
        if name not in expected and not re.fullmatch(r"(?:tab|isolatedTab)\d+", name):
            raise ValueError(f"Review the new Gecko service before allocating profile slots: {name}")

    java = [
        "package org.mozilla.gecko.process;",
        "",
        "@androidx.annotation.Keep",
        "public final class NavisProfileChildProcessServices {",
    ]
    for slot in range(slots):
        java.append(f"  public static final class profile{slot} {{")
        for service, name in zip(services, names):
            clone = deepcopy(service)
            clone.set(f"{{{ANDROID}}}name", f"{OWNER}$profile{slot}${name}")
            process = clone.get(f"{{{ANDROID}}}process", "")
            if not process.startswith(":"):
                raise ValueError("Gecko child services must use private Android processes")
            clone.set(f"{{{ANDROID}}}process", f":profile{slot}_{process[1:]}")
            app.append(clone)
            superclass = "GeckoServiceGpuProcess" if name == "gpu" else "GeckoServiceChildProcess"
            java.append(f"    public static final class {name} extends {superclass} {{}}")
        ET.SubElement(app, "receiver", {
            f"{{{ANDROID}}}name": f"{OWNER}$profile{slot}$NotificationReceiver",
            f"{{{ANDROID}}}process": f":profile{slot}",
            f"{{{ANDROID}}}exported": "false",
        })
        java.append("    public static final class NotificationReceiver extends "
                    "org.mozilla.gecko.navis.NavisAndroidNotifications.NotificationReceiver {}")
        java.append("  }")
    java.append("}")
    ET.indent(root, space="    ")
    return ET.tostring(root, encoding="unicode") + "\n", "\n".join(java) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--slots", type=int, default=8)
    args = parser.parse_args()
    manifest, java = generate(args.source_manifest.read_text(encoding="utf-8"), args.slots)
    for path, content in ((args.manifest, manifest), (args.java, java)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
