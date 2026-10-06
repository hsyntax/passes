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

- 102 CLI behavior tests passing, zero failures
- Strict TypeScript typecheck passing
- Oxlint lint and Oxfmt formatting checks passing
- Bundled Bun build passing
- Repository stage validation passing through the source and bundled CLI (6 stages, 6 layers)

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

Execution cases cover preflight rejection before any stage starts, paginated and
malformed catalogs, missing/repeated cursors, unsupported models and efforts,
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

## Stage guidance verification

The boundary stage prefers existing Effect integrations and otherwise the smallest
external adapter. It distinguishes Effect interruption from actual SDK abort support
and retains genuine entrypoint/Promise integration. No external SDK integration was
rewritten or live-tested by this instruction-only change.

The combined Effect stage distills the relevant direct-API and abstraction guidance from
an installed user-provided Effect rewrite skill. It deliberately omits broader bug-fix
and formatting advice, while retaining essential composition and observable-behavior
constraints. It does not include the earlier rewrite examples.

The frozen dependency remains `effect@4.0.0`. Data-access concepts were checked
against that version's source and the PostgreSQL parameter/IN/ANY documentation.
Its concise batching sketches are illustrative, not database benchmarks or verified
resolver rewrites. Each Effect stage directs agents to the target repository's
vendored `repos/effect` and actual database/driver documentation when relevant.
The naming stage applies established domain vocabulary within bounded contexts and
preserves external naming contracts; no application code was renamed in this PR.

The final constructor stage was checked against the public and internal source at
`effect@4.0.1`: unnamed `fn` adds diagnostic frame boundaries without an automatic
span; named `fn` adds a span; `fnUntraced` adds neither wrapper boundary but does not
disable body tracing; `gen` produces an Effect. This is source verification, not a
live telemetry or performance test. It does not upgrade this branch's dependency.

## Codex checks

Installed Codex CLI 0.159.2 help and generated protocol schema were inspected.
A catalog-only app-server probe used a fresh temporary Codex home and sent only
initialize, initialized, and model/list. No thread/turn or login was started.
It confirmed that `gpt-6-luna` supports catalog efforts low, medium, high, xhigh,
and max in that installation. The probe also confirmed that catalog success does
not imply live model access, because a bundled catalog is available without login.

No real model call or repository rewrite was performed. Live account access,
quota, and provider behavior have not been end-to-end tested. Mac execution was
verified with the fake Codex fixture, including concurrency and cancellation.
