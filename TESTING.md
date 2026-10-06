# Verification

The original baseline was verified on Linux and macOS (Darwin arm64) with Bun 1.4.2.
The stage examples, scope option, and commit-prompt changes were verified on Linux with Bun 1.4.2;
the updated suite has not been rerun on macOS. The macOS test fixture
canonicalizes temporary directories with `realpathSync` so `/var` and
`/private/var` aliases compare correctly.

Bun 1.4.2 or newer is required to install the included lockfile. All tests use
a fake Codex executable and temporary repositories; they make no model calls.

To repeat installation and verification from the project directory:

```sh
bun install --frozen-lockfile
bun run check
bun src/cli.ts validate stages
bun dist/passes.js validate stages
```

## Automated checks

- 109 tests passing, 414 assertions, zero failures
- Strict TypeScript typecheck passing
- Oxlint lint and Oxfmt formatting checks passing
- Bundled Bun build passing
- Repository stage validation passing through the source and bundled CLI (5 stages, 5 layers)

The 80 parser/unit tests cover required fields, unknown fields, malformed and
ambiguous YAML, duplicate YAML keys, invalid numeric values, quoted numbers,
control characters, BOM/CRLF, literal prompt preservation, empty prompts,
recursive deterministic discovery, symlink cycles, name/slug collisions, numeric
layer ordering, graph barriers, safe argv, split UTF-8 output, optional scope,
literal scope preservation, invalid scope values, and invocation scope precedence.

The 29 black-box CLI tests cover invalid plans never launching Codex, real
concurrency verified by file barriers, later-step barriers, model/effort/argv and
stdin preservation, nested cwd, dirty file preservation, stdout/stderr labels,
nonzero failure stopping advancement, sibling and descendant cancellation,
TERM-ignoring subprocesses, exact SIGINT/SIGTERM exit codes, unsupported models
and efforts (including a later layer), old CLI versions, malformed catalogs,
pagination, omitted/repeated cursors, and interrupted preflight cleanup. Prompt
checks verify the optional `Scope: <value>` first line, CLI override behavior,
literal Markdown preservation, and standard commit instructions appended exactly
once to every stage invocation. Tests do
not rely on a real model to interpret those instructions or create a commit.

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
