# SPDX-License-Identifier: MPL-2.0
"""Run extracted document/container inheritance; parser and principals are recorded."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'gecko')
parser.add_argument('--fixture', type=Path, default=Path(__file__).with_name('policy-info-inheritance.cpp'))
parser.add_argument('--output', type=Path)
parser.add_argument('--cxx', default='c++')
args = parser.parse_args()
temporary = None
if args.output is None:
    temporary = tempfile.TemporaryDirectory(prefix='navis-policy-inheritance-')
    args.output = Path(temporary.name) / 'result'
args.output.mkdir(exist_ok=False)
source = args.source / 'dom/security/featurepolicy/FeaturePolicy.cpp'
text = source.read_text()


def method(signature):
    start = text.index(signature)
    cursor = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[cursor] == '{') - (text[cursor] == '}')
        cursor += 1
    return text[start:cursor]


signatures = ['void FeaturePolicy::InheritPolicy(FeaturePolicy*',
              'void FeaturePolicy::InheritPolicy(\n',
              'void FeaturePolicy::SetInheritedDeniedFeature(',
              'bool FeaturePolicy::HasInheritedDeniedFeature(',
              'bool FeaturePolicy::HasDeclaredFeature(',
              'bool FeaturePolicy::HasFeatureUnsafeAllowsAll(',
              'bool FeaturePolicy::AllowsFeatureInternal(',
              'FeaturePolicyInfo FeaturePolicy::ToFeaturePolicyInfo()']
generated = args.output / 'policy-info.cpp'
generated.write_text(args.fixture.read_text().replace('// PRODUCTION_METHODS', '\n\n'.join(method(s) for s in signatures)))
binary = args.output / 'policy-info'
commands = [('compile', [*shlex.split(args.cxx), '-std=c++20', '-Wall', '-Wextra', '-Werror',
    '-Wno-unused-parameter', '-Wno-unused-function', '-Wno-missing-field-initializers',
    '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    str(generated.resolve()), '-o', str(binary.resolve())]), ('run', [str(binary.resolve())])]
result = {'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'fixture_sha256': hashlib.sha256(args.fixture.read_bytes()).hexdigest(),
          'generated_sha256': hashlib.sha256(generated.read_bytes()).hexdigest(),
          'recorded_parser_and_principals': True, 'native_browser': False, 'checks': []}
for name, command in commands:
    run = subprocess.run(command, capture_output=True, text=True, timeout=90)
    (args.output / (name + '.log')).write_text(run.stdout + run.stderr)
    result['checks'].append({'name': name, 'argv': command, 'returncode': run.returncode})
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(name, run.returncode, run.stdout, run.stderr[-2000:], flush=True)
    if run.returncode:
        raise SystemExit(1)
