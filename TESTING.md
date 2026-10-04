# Verification

The platform migration is verified on macOS (Darwin arm64) with Bun 1.4.2 and
Node.js 24.21.0. The previous Bun-test suite was also verified on Linux; this
migration has not been rerun on Linux. Temporary directories are canonicalized
with `realpathSync` so macOS `/var` and `/private/var` aliases compare correctly.

Bun 1.4.2 or newer is required to install the included lockfile. Vitest 5 runs in
Node.js (24 LTS recommended); the CLI and fake Codex run in Bun. All tests use a
fake Codex executable and temporary repositories; they make no model calls.

To repeat installation and verification from the project directory:

```sh
bun install --frozen-lockfile
bun run check
bun src/cli.ts validate stages
bun dist/passes.js validate stages
```

## Automated checks

- 73 tests passing, zero failures
- Strict TypeScript typecheck passing
- Oxlint lint and Oxfmt formatting checks passing
- Bundled Bun build passing
- Example stage validation passing through the source and bundled CLI

The 43 parser/unit tests cover required fields, unknown fields, malformed and
ambiguous YAML, duplicate YAML keys, invalid numeric values, quoted numbers,
control characters, BOM/CRLF, literal prompt preservation, empty prompts,
recursive deterministic discovery, symlink cycles, name/slug collisions, numeric
layer ordering, graph barriers, safe argv, and split UTF-8 output.

The 28 black-box CLI tests cover invalid plans never launching Codex, real
concurrency verified by file barriers, later-step barriers, model/effort/argv and
stdin preservation, nested cwd, dirty file preservation, stdout/stderr labels,
nonzero failure stopping advancement, sibling and descendant cancellation,
TERM-ignoring subprocesses, exact SIGINT/SIGTERM exit codes, unsupported models
and efforts (including a later layer), old CLI versions, malformed catalogs,
pagination, omitted/repeated cursors, and interrupted preflight cleanup. They also
cover stubborn descendants after successful, failed, or signalled leaders,
inherited output pipes, EPIPE cancellation, oversized catalog frames, and partial
output flushing during cancellation.

Tests import from `@effect/vitest`. Filesystem tests use `it.effect`, shared Bun
filesystem/path layers, typed failure assertions, and scoped temporary directories.
Two subprocess tests use `it.live` with `BunServices.layer` to verify bounded output
collection, nonzero exits, and missing executables. Pure parser tests and black-box
CLI tests use ordinary Vitest tests; real subprocess timing is not simulated.

Run the suite with `bun run test`, or a targeted file with
`bun run test test/process.test.ts`. The old `bun test` runner is no longer used.

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
