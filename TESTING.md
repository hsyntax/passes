# Verification

The original baseline was verified on Linux and macOS (Darwin arm64) with Bun 1.4.2.
The stage additions and commit-prompt changes were verified on Linux with Bun 1.4.2;
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

- 70 tests passing, 227 assertions, zero failures
- Strict TypeScript typecheck passing
- Oxlint lint and Oxfmt formatting checks passing
- Bundled Bun build passing
- Repository stage validation passing through the source and bundled CLI (4 stages, 4 layers)

The 48 parser/unit tests cover required fields, unknown fields, malformed and
ambiguous YAML, duplicate YAML keys, invalid numeric values, quoted numbers,
control characters, BOM/CRLF, literal prompt preservation, empty prompts,
recursive deterministic discovery, symlink cycles, name/slug collisions, numeric
layer ordering, graph barriers, safe argv, and split UTF-8 output.

The 22 black-box CLI tests cover invalid plans never launching Codex, real
concurrency verified by file barriers, later-step barriers, model/effort/argv and
stdin preservation, nested cwd, dirty file preservation, stdout/stderr labels,
nonzero failure stopping advancement, sibling and descendant cancellation,
TERM-ignoring subprocesses, exact SIGINT/SIGTERM exit codes, unsupported models
and efforts (including a later layer), old CLI versions, malformed catalogs,
pagination, omitted/repeated cursors, and interrupted preflight cleanup. Prompt
checks verify that the original Markdown is preserved as a prefix and the standard
commit instructions are appended exactly once to every stage invocation. Tests do
not rely on a real model to interpret those instructions or create a commit.

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
