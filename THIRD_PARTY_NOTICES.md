# Third-party source and notices

Navis-owned source is MPL-2.0 unless a file says otherwise; see LICENSE. Per-file upstream copyright and license headers remain authoritative.

- **Mozilla Gecko / Firefox**: `vendor/gecko.json` selects the upstream Git commit; `config/gecko-semantic-ports.json` and `patches/gecko/` describe Navis modifications. Generated `gecko/` is not distributed in this Git repository. Gecko is multi-licensed, not uniformly MPL: its upstream `toolkit/content/license.html` and component notices describe included code. Preserve them when distributing a built runtime, and provide matching source including the semantic ports. Source: https://github.com/mozilla-firefox/firefox
- **colorpicker-compose 1.1.4**: Apache-2.0, copyright Skydoves. The preserved notice is `embedder/modules/licenses/colorpicker-compose-1.1.4.txt`; port 0106 packages it for Android. Gradle resolves the upstream library rather than vendoring its compiled AAR here. Source and build instructions: https://github.com/skydoves/colorpicker-compose
- Other Gecko-derived binding files retain their own upstream headers. Rust, NDK and other toolchain dependencies are not copied into this source repo.

This inventory describes source publication. A binary distribution must also carry the licenses/corresponding source of its full resolved dependency closure.
