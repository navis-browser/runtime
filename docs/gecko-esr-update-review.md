# Gecko ESR semantic-update review

## Purpose

The independent Desktop Gecko Embedder repository does not merge Mozilla commits. Moving to another ESR instead requires two distinct reviews:

1. inventory every upstream commit on both sides of the relevant history boundary and every path whose final tree differs;
2. understand the required behavior and rewrite the bounded semantic adapter for the candidate ESR.

`scripts/review-gecko-esr-update.py` makes the first step deterministic and fail-closed. It creates a review dossier; it does not decide that a Gecko change is irrelevant and it does not perform the logical port on the reviewer's behalf.

## Inputs and output

The tool consumes:

- the current exact pin in `vendor/gecko.json`;
- a candidate pin or Git reference;
- `config/gecko-semantic-ports.json`, including every adapter patch hash and exact touched path;
- `config/gecko-esr-review-routes.json`, containing cross-cutting build, startup/process/sandbox, platform-host, Toolkit, Fission/navigation, Web platform, optional-capability, and supply-chain routes;
- a local Git object database containing both endpoint trees and, for an approvable migration, their complete relevant ancestry.

The deterministic JSON dossier records:

- endpoint commits, trees, dates, subjects, raw parents, and missing parent objects;
- topology and merge base;
- every base-only and target-only commit, in reverse topological order;
- a hash and count for each commit inventory;
- per-commit route/port summaries, with complete per-commit paths when `--include-commit-paths` is requested;
- every final-tree A/M/D path using `--no-renames`, so rename heuristics cannot change the inventory;
- all matching review routes and semantic ports for each tree path;
- changed and unchanged watched paths for each registered port;
- content hashes for the route configuration and semantic-port ledger.

Paths not matching a focused route remain in `general-upstream`. They are not discarded or labeled irrelevant. A path may match more than one cross-cutting route, so route counts intentionally need not sum to the tree-path count.

## Patch responsibility and organization

Each semantic port describes one final responsibility, including its required build registration and correctness fixes. Fold follow-up fixes into that responsibility when dependencies permit. Shared declarations belong to their foundational adapter; platform startup hooks stay with the platform adapter that owns the files. Keep related cross-adapter invariants explicit rather than moving a hunk before its input exists.

When regrouping or renumbering an unchanged series, update its contiguous order, hashes and all validator/test references. Independently replay both complete series against the same pin and compare the full resulting tree, including path presence, file contents and executable/symlink modes. Successful application alone does not prove equivalence. Keep the old-to-new mapping and replay results as review evidence outside the source distribution. Existing binaries retain their original provenance; source-equivalence evidence does not establish a behavioral change or replace its required native validation.

## Complete-history gate

By default, the tool refuses to write a dossier unless Git can establish the history topology and cover every commit from the merge base to both endpoints. This matters for ESR release branches: neither release endpoint is necessarily an ancestor of the other. A correct comparison may contain both a base-only side and a target-only side.

An endpoint tree alone is insufficient. A depth-one checkout can produce an exact `git diff` but cannot prove which commits produced it. Missing merge-base or parent objects therefore fail the command before an output file is created.

`--allow-incomplete-history` exists only for explicitly labeled reconstruction evidence. Such a report can truthfully claim complete endpoint-tree coverage, but its `coverage.commit_history` and `history.status` remain `incomplete` and the reasons are embedded in the report. It is not acceptable evidence for approving a new ESR migration.

## Candidate workflow

Prepare a candidate pin without changing the accepted pin, and make its full relevant history available in a local Gecko mirror. Then run without the incomplete-history escape hatch:

```bash
python3 scripts/review-gecko-esr-update.py \
  --repo /absolute/path/to/complete-gecko-mirror \
  --from-pin vendor/gecko.json \
  --to-pin /absolute/path/to/candidate-gecko.json \
  --include-commit-paths \
  --output /absolute/path/to/esr-review.json.xz
```

The reviewer then:

1. inspects every base-side and target-side commit queue and every focused route, without skipping the `general-upstream` remainder;
2. reviews each semantic port's changed and unchanged watched paths against its intent, invariants, and `port_review` instruction;
3. determines whether the port is still needed, has become upstream behavior, or must be rewritten for the candidate source graph;
4. writes the candidate adapter logic rather than cherry-picking or merging upstream history into `embedder/`;
5. updates the exact pin, port ledger, hashes, applicability evidence, and source-package version;
6. performs empty-object-directory builds and both-consumer Runtime/Session/ View/Delegate, capability, source-domain, Fission, sandbox, crash, package, and platform replays.

Commit inventory is a review queue, not a security advisory feed. Security release notes, advisories, and upstream bug context still require their own authoritative review.
