# Verification

The revised suite was verified on macOS (Darwin arm64) with Bun 1.4.2.
The original baseline was also verified on Linux. Earlier stage examples, scope,
and commit-prompt changes were verified on Linux with Bun 1.4.2; the revised suite
has not been rerun on Linux. The macOS fixture canonicalizes temporary directories
with `realpathSync` so `/var` and `/private/var` aliases compare correctly.

Bun 1.4.2 or newer is required to install the included lockfile. Tests use
temporary workspaces and, for execution, real Git repositories and a fake Codex
executable. They make no model calls.

To repeat installation and verification from the project directory:

```sh
bun install --frozen-lockfile
bun run check
bun src/cli.ts validate stages
bun dist/passes.js validate stages
```

## Automated checks

- 136 CLI behavior tests passing, zero failures
- Strict TypeScript typecheck passing
- Oxlint lint and Oxfmt formatting checks passing
- Bundled Bun build passing
- Repository stage validation passing through the source and bundled CLI (8 stages, 8 layers)

Tests invoke the documented CLI without importing implementation modules. They
check exit codes, diagnostics, layer graphs, filesystem effects, and the argv and
stdin received by a fake Codex executable at the external process boundary.
Expected prompt text comes from the documented contract, independently of the
implementation. Git is real; repositories and fixture settings are temporary.
The subprocess environment excludes inherited Git configuration and Codex fixture
settings. Validation, help, and version are also exercised with neither Git nor
Codex on PATH. A focused run with deliberately conflicting ambient Git and fixture
variables passed all four selected tests.

Configuration cases cover required fields, a generic unknown field, malformed and
ambiguous YAML, duplicate keys, invalid numeric values, control characters,
BOM/CRLF, literal bodies and scope, empty prompts, recursive deterministic
discovery, internal/external symlinks and cycles, name collisions, and numeric
layer ordering. Scope delivery checks cover frontmatter, invocation precedence,
unscoped stages, and exact preservation of literal shell text and whitespace.
Commit instructions are checked in the stdin actually delivered to Codex.
The invocation checks require the current `--approve-for-me` contract.

Push tests use temporary local bare remotes and real commits created by the fake
Codex fixture. They check that all pending commits reach the remote once after
the final stage, new branches receive an upstream, configured destinations are
honored, and no remote means no push. Failed or interrupted stages and validation
leave remote refs unchanged. A rejecting remote fails the run while preserving
local commits. These tests never push to an external repository.

Logging cases verify default concise output, complete labeled logs, live file
writes, cancellation with partial-line flushing, bounded failure excerpts, and
`--verbose` streaming to separate terminal channels. They also check unique log
files with owner-only permissions, XDG state-directory selection, rejection of
checkout destinations (including symlinks), setup failures before Codex starts,
Codex compatibility diagnostics, and no logs for validation/help/version. Test
logs stay in the temporary workspace outside its Git checkout.

Execution cases cover Codex compatibility rejection before any stage starts,
paginated and malformed catalogs, missing/repeated cursors, unsupported models and efforts,
concurrent stages and layer barriers, nested invocation directories, dirty file
preservation, argument escaping, failure diagnostics, cancellation, and cleanup
of TERM-ignoring siblings and descendants. Streaming checks exercise bytewise
Unicode output, stdout/stderr labels, long output arriving before process exit,
and partial lines preserved on interruption. They do not depend on internal
chunk sizes, helper names, or exact RPC call counts.

Five mutation probes in temporary source copies confirmed that the relevant tests
fail when scope overrides are ignored, bodies are trimmed, split UTF-8 is decoded
independently, long output is buffered until exit, or a concurrent layer is
serialized. The original sources were restored between probes; production code
was not changed by this review.

These tests verify delivery of model instructions. They do not use a real model
to interpret the instructions or create a commit.

The PR test review replaced fixed stage delays with explicit fixture readiness
and release files. The concurrency limit check verifies slot reuse and completion
of every stage without requiring a particular scheduling order. The push check
holds the final stage open and verifies that the bare remote has no branch yet,
then checks the pushed file contents. Logging checks wait for partial output
before cancellation and use distinct output to verify run isolation. Argument
errors require relevant diagnostics; aggregate configuration errors do not depend
on presentation order. Assertions about retired invocation flags were removed.

Three additional mutation probes in temporary source copies failed as expected
when concurrency was raised above four, a layer was serialized, or commits were
pushed before stage execution. The concurrency check also passed with reversed
stage scheduling order. Production sources were untouched by these probes.

The latest PR test review checked all five test files and their fixtures. Fast-mode
expectations now match each requested stage to its model and literal expected
selection, including current tier metadata taking precedence over legacy metadata.
The failed-stage test also checks that its file edit occurs only once. Logging
tests enforce the documented 20-line excerpt limit, preserve every diagnostic in
the full log, and observe both verbose channels before releasing the stage.

Four mutation probes in temporary source copies passed the previous tests and
failed the revised tests: substituting another fast-capable model, letting legacy
tiers override current metadata, expanding excerpts to 50 lines, and buffering
verbose output until exit. The unmodified implementation passed `bun run check`
(typecheck, lint, formatting, all 129 tests, and build). `git diff --check` also
passed. No production source was changed by this review.

## Effect filesystem adoption

The PR package review searched the complete vendored package tree, including
manifests, source, tests, documentation, and examples. Candidates included CLI,
YAML/NDJSON encoding, RPC serialization, runtime/process services, filesystem
services, and test/tooling packages. The shared filesystem implementation used
by Bun replaces the custom promise wrappers for directory metadata and stage
reads. Its read API propagates Effect cancellation to Node's abort signal.
Node decoding preserves the existing BOM behavior and native error causes keep
the existing diagnostics. Directory-entry traversal, YAML parsing, and subprocess
cleanup remain because the candidate replacements would change those contracts.

Both lockfiles pin `@effect/platform-node-shared` 4.0.0 with Effect 4.0.0;
the shared package's peer range is `^4.0.0`. Repository sync verifies both
manifests in the same release tree. The added CLI tests reject repeated leading
BOMs and accept a symlink as the supplied directory while ignoring broken links
inside it. The missing-directory test also checks the native errno and path.

Verified on macOS with Bun 1.4.2: frozen Bun installation, `bun run repos:sync`,
`bun run check` (131 tests, typecheck, lint, formatting, and build), source and
bundled stage validation, and `git diff --check`. No live Codex calls were made.

## Process cleanup regression

The process-cleanup regression test starts a stage with its own TERM-ignoring
descendant, waits for descendant readiness, then exits the stage with code 17.
It verifies the failure diagnostic, that later stages do not start, and that no
fixture processes survive. It failed before explicit scoped process-group cleanup
was added and passes afterward. Cleanup uses the platform handle's `kill` with
the existing 500 ms escalation timeout, including after the leader has exited.

## Redundant I/O verification

The PR review found a duplicate checkout probe: the CLI already runs
`git rev-parse --show-toplevel` to locate the checkout before creating a log,
then the Codex compatibility check ran `git rev-parse --is-inside-work-tree`
again. The first
command rejects bare repositories and Git metadata directories as well as paths
outside a repository. It remains the single checkout check on every invocation;
no repository state is cached across runs.

Git's `GIT_TRACE` and the Codex fixture events measured two-layer runs without a
remote, both at the checkout root and in a nested directory:

| External operation                                | Before | After |
| ------------------------------------------------- | -----: | ----: |
| Checkout probes                                   |      2 |     1 |
| Total Git subprocesses                            |      4 |     3 |
| Codex subprocesses (version, catalog, two stages) |      4 |     4 |
| `model/list` requests for a one-page catalog      |      1 |     1 |

Regression tests enforce these counts and verify that both stages still execute
in layer order. Rejection tests cover non-repository paths, bare repositories,
and metadata directories before Codex or logging starts. The original suite
passed all 131 tests; the focused operation-count and rejection run passed five
tests after the change.

The first full check hit an existing cancellation race in the streaming test:
the fixture's exit event could arrive before the runner finished draining its
Unicode output. An unchanged-source probe reproduced the failure once in ten
runs. The test now waits for the runner's completion message before cancelling
the still-active long-output stage, using captured stdout instead of rereading
the fixture event file on each poll. Output assertions remain unchanged, and
ten repeated runs of the corrected test passed.

The scoped runner has no database queries. Stage files are already read once,
the catalog is shared across all stages, and pagination requests depend on the
previous cursor. The vendored Effect `RequestResolver` and filesystem APIs were
reviewed; these paths have no compatible independent requests backed by a bulk
API. Logging remains immediate, and commit reporting and remote discovery remain
after execution to observe changes made by stages.

Final verification passed on macOS with Bun 1.4.2 and Git 2.47.1:
`bun run check` (135 tests, typecheck, lint, formatting, and build), source and
bundled stage validation (seven stages and layers), and `git diff --check`.
All execution checks used the fake Codex fixture; no live model calls were made.

## Stage guidance verification

The ecosystem-package stage runs before boundary isolation and uses `gpt-6.1-sol`
with high reasoning. It starts with the full vendored ecosystem package tree,
including manifests, source, documentation, and examples. It searches beyond platform packages for integrations that
simplify implementation or reduce maintained code, verifies compatibility, and
preserves behavior. The boundary and composition stages retain suitable adopted
integrations. Source and bundled validation confirm eight sequential layers;
this prompt change was not evaluated with a live model run. Fast mode is unset
because the runner has no per-stage setting for it.

The dead-code stage runs immediately before domain renaming with `gpt-6.1-sol`
and high reasoning. It requires evidence before deletion, checks dynamic and public
usage, preserves supported behavior, and leaves uncertain candidates unchanged.
Source and bundled CLI validation verify its position; no live model run was made
for this addition.

The boundary stage prefers existing Effect integrations and otherwise the smallest
external adapter. It distinguishes Effect interruption from actual SDK abort support
and retains genuine entrypoint/Promise integration. No external SDK integration was
rewritten or live-tested by this instruction-only change.

The combined Effect stage distills the relevant direct-API and abstraction guidance from
an installed user-provided Effect rewrite skill. It deliberately omits broader bug-fix
and formatting advice, while retaining essential composition and observable-behavior
constraints. It does not include the earlier rewrite examples.

The frozen dependency remains `effect@4.0.0`. The redundant-I/O stage directs
agents to establish a baseline, remove unnecessary external operations, and verify
improvements while preserving behavior and intentional concurrency. It covers
database queries, API requests, file reads, and subprocess calls, and permits
batching only for independent operations backed by genuine bulk APIs. This prompt
change was validated without a live optimization run or benchmark. The stage
directs agents to the target repository's vendored `repos/effect` and actual API
contracts when relevant.
The naming stage applies established domain vocabulary within bounded contexts and
preserves external naming contracts; no application code was renamed in this PR.

The final constructor stage was checked against the public and internal source at
`effect@4.0.1`: unnamed `fn` adds diagnostic frame boundaries without an automatic
span; named `fn` adds a span; `fnUntraced` adds neither wrapper boundary but does not
disable body tracing; `gen` produces an Effect. This is source verification, not a
live telemetry or performance test. It does not upgrade this branch's dependency.

## Codex checks

Fast-mode support was checked against the installed CLI's generated model-list
schema and cached catalog: `serviceTiers` advertises tier IDs, with
`additionalSpeedTiers` retained for older metadata. Fixture tests exercise mixed
model support across layers, unchanged reasoning/scope, omitted flags, pagination,
malformed metadata, invalid flag usage, and no retries after a failed fast stage.
Fast-mode selection appears in terminal output and run logs. No live model call
was made to test fast mode or account entitlement.

Installed Codex CLI 0.159.2 help and generated protocol schema were inspected.
A catalog-only app-server probe used a fresh temporary Codex home and sent only
initialize, initialized, and model/list. No thread/turn or login was started.
It confirmed that `gpt-6-luna` supports catalog efforts low, medium, high, xhigh,
and max in that installation. The probe also confirmed that catalog success does
not imply live model access, because a bundled catalog is available without login.

The original catalog verification performed no real model call or repository
rewrite. A subsequent manual six-stage run on macOS completed using Codex 0.160.1;
several stage commit attempts were denied under the old `never` approval policy.
The updated `--approve-for-me` invocation was checked against installed CLI help
and the fake fixture; its live approval flow has not been rerun. The automated
suite makes no model calls, including its concurrency, cancellation, and push tests.
