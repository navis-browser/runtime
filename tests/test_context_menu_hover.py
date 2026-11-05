# SPDX-License-Identifier: MPL-2.0
"""Exercise the prepared native hover methods with explicit popup/IPC peers."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def function(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gecko", type=Path, default=ROOT / "gecko")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    source = (args.gecko / "dom/ipc/BrowserParent.cpp").read_text()
    methods = [function(source, "static bool HasContextMenuForBrowser("),
               function(source, "void BrowserParent::FlushContextMenuMouseExits(")]
    send = function(source, "void BrowserParent::SendRealMouseEvent(")
    # The existing IPC/coordinate transport is an explicit peer here; the real
    # target build and packaged replay must verify it independently.
    prefix = send[:send.index("  // XXXedgar,")]
    methods.append(prefix + "  delivered.push_back(aMouseOrPointerEvent);\n}")
    fixture = (ROOT / "tests/context-menu-hover.cpp").read_text()
    generated = args.output / "context-menu-hover.cpp"
    generated.write_text(fixture.replace("// EXTRACTED_NATIVE_METHODS", "\n\n".join(methods)))
    binary = args.output / "context-menu-hover"
    command = ["c++", "-std=c++20", "-DMOZ_DESKTOP_EMBEDDER", "-Wall", "-Wextra", "-Werror",
               "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g",
               str(generated), "-o", str(binary)]
    with (args.output / "compile.log").open("x") as log:
        subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    with (args.output / "run.log").open("x") as log:
        subprocess.run([str(binary.resolve())], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=10)
    result = {"passed": True, "native_gui_replay": False,
              "scope": "Actual BrowserParent hover methods with popup and IPC peers under ASan/UBSan",
              "methods_sha256": [hashlib.sha256(method.encode()).hexdigest() for method in methods]}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
