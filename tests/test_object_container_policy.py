# SPDX-License-Identifier: MPL-2.0
"""Check actual object/embed document load ordering with recorded collaborators.

Extract the document arm of LoadObject and its policy publication methods.
Channel loading, policy parsing, IPC and frame-loader peers are recorded, not
native browser implementations. Compile the full changed unit and replay current
packaged object/embed loads separately.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def method(text, signature):
    start = text.index(signature)
    opening = text.index('{', start)
    cursor, depth = opening + 1, 1
    while depth:
        depth += (text[cursor] == '{') - (text[cursor] == '}')
        cursor += 1
    return text[start:cursor]

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT / 'gecko')
parser.add_argument('--fixture', type=Path, default=ROOT / 'tests/object-container-policy.cpp')
parser.add_argument('--output', type=Path)
parser.add_argument('--cxx', default='c++')
args = parser.parse_args()
temporary = None
if args.output:
    args.output.mkdir(parents=True, exist_ok=False)
else:
    temporary = tempfile.TemporaryDirectory(prefix='navis-object-policy-')
    args.output = Path(temporary.name)
path = args.source / 'dom/base/nsObjectLoadingContent.cpp'
source = path.read_text()
load = method(source, 'nsresult nsObjectLoadingContent::LoadObject(bool aNotify, bool aForceLoad,')
arm = method(load, '    case ObjectType::Document:') + ' break;'
pieces = ['nsresult nsObjectLoadingContent::DocumentArm() {\n'
          'nsresult rv = NS_OK; nsCOMPtr<nsIStreamListener> finalListener;\n'
          'switch (mType) {\n' + arm + '\ndefault: break; }\n'
          'if (finalListener) finalListener->OnStartRequest(mChannel);\nreturn rv;\n}']
pieces += [method(source, name) for name in [
    'void nsObjectLoadingContent::RefreshFeaturePolicy()',
    'void nsObjectLoadingContent::MaybeStoreCrossOriginFeaturePolicy()']]
generated = args.output / 'object-policy.cpp'
generated.write_text(args.fixture.read_text().replace('// PRODUCTION_METHODS', '\n\n'.join(pieces)))
binary = args.output / 'object-policy'
command = [*shlex.split(args.cxx), '-std=c++20', '-Wall', '-Wextra', '-Werror',
           '-Wno-unused-parameter', '-O1', '-g', '-fsanitize=address,undefined',
           '-fno-omit-frame-pointer', str(generated.resolve()), '-o', str(binary.resolve())]
receipt = {'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
           'fixture_sha256': hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
           'generated_sha256': hashlib.sha256(generated.read_bytes()).hexdigest(),
           'native_browser': False, 'checks': []}
for name, argv in [('compile', command), ('run', [str(binary.resolve())])]:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=90)
    (args.output / (name + '.log')).write_text(result.stdout + result.stderr)
    receipt['checks'].append({'step': name, 'command': argv, 'returncode': result.returncode})
    (args.output / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(name, result.returncode, result.stdout, flush=True)
    if result.returncode:
        print(result.stderr, flush=True)
        raise SystemExit(result.returncode if result.returncode > 0 else 1)
